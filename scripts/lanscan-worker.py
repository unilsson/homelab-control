#!/usr/bin/env python3
"""Unprivileged, host-side worker for Homelab Control LAN scans.

Checks a fixed queue file once per minute and refreshes the snapshot every
15 minutes. Never accepts executable commands, subnets or flags from the API.
"""
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

PROJECT_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("LANSCAN_OUTPUT_DIR", str(PROJECT_DIR / "data")))
SCAN_SCRIPT = PROJECT_DIR / "scripts" / "update-lanscan.sh"
SNAPSHOT = DATA_DIR / "lanscan.json"
REQUEST = DATA_DIR / "lanscan-request.json"
STATUS = DATA_DIR / "lanscan-status.json"
HEARTBEAT = DATA_DIR / "lanscan-worker-heartbeat"
LOCK = DATA_DIR / ".lanscan-worker.lock"
AUTO_REFRESH_SECONDS = 15 * 60
SCAN_TIMEOUT_SECONDS = 150
UUID = re.compile(r"^[a-fA-F0-9-]{36}$")


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def read_json(path: Path) -> dict | None:
    try:
        if path.stat().st_size > 4096:
            return None
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else None
    except (FileNotFoundError, OSError, json.JSONDecodeError, UnicodeDecodeError):
        return None


def atomic_json(path: Path, value: dict) -> None:
    # Atomic rename prevents the API from seeing partly written JSON.
    fd, temp_name = tempfile.mkstemp(prefix=".lanscan-worker-", dir=DATA_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as output:
            json.dump(value, output)
            output.write("\n")
        os.chmod(temp_name, 0o644)
        os.replace(temp_name, path)
    finally:
        if os.path.exists(temp_name):
            os.unlink(temp_name)


def valid_request(value: dict | None) -> bool:
    if not isinstance(value, dict):
        return False
    if not isinstance(value.get("id"), str) or not UUID.fullmatch(value["id"]):
        return False
    if not isinstance(value.get("requestedAt"), str):
        return False
    try:
        datetime.fromisoformat(value["requestedAt"].replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def changed_since(seconds: float, timestamp: str | None) -> bool:
    if not timestamp:
        return False
    try:
        when = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - when).total_seconds() < seconds
    except (ValueError, TypeError):
        return False


def clean_processed_request(request_id: str) -> None:
    current = read_json(REQUEST)
    if current and current.get("id") == request_id:
        REQUEST.unlink(missing_ok=True)


def main() -> int:
    os.umask(0o022)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with LOCK.open("a+") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0  # The previous scan is still running.

        HEARTBEAT.touch()
        request = read_json(REQUEST)
        status = read_json(STATUS)

        if request is not None and not valid_request(request):
            print("Invalid scan request marker; ignoring", file=sys.stderr)
            return 1

        if request and status and request["id"] == status.get("requestId"):
            # Crash recovery: never rerun an already processed manual request.
            if status.get("state") in ("running", "completed", "failed"):
                if status.get("state") != "running" or not changed_since(240, status.get("startedAt")):
                    clean_processed_request(request["id"])
                return 0

        manual = request is not None
        if not manual:
            # If a previous automatic scan failed, wait 15 minutes before
            # retrying instead of probing the LAN every minute.
            last_attempt = status.get("startedAt") if status else None
            if changed_since(AUTO_REFRESH_SECONDS, last_attempt):
                return 0
            if SNAPSHOT.is_file() and (datetime.now(timezone.utc).timestamp() - SNAPSHOT.stat().st_mtime) < AUTO_REFRESH_SECONDS:
                return 0

        record = {
            "requestId": request["id"] if manual else None,
            "requestedAt": request["requestedAt"] if manual else None,
            "state": "running",
            "startedAt": now(),
            "finishedAt": None,
        }
        atomic_json(STATUS, record)
        try:
            subprocess.run(
                ["/bin/bash", str(SCAN_SCRIPT)],
                cwd=PROJECT_DIR,
                timeout=SCAN_TIMEOUT_SECONDS,
                check=True
            )
            record["state"] = "completed"
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as error:
            print(f"LAN scan failed: {error}", file=sys.stderr)
            record["state"] = "failed"
        finally:
            record["finishedAt"] = now()
            atomic_json(STATUS, record)
            if manual:
                clean_processed_request(request["id"])

        return 0 if record["state"] == "completed" else 1


if __name__ == "__main__":
    sys.exit(main())
