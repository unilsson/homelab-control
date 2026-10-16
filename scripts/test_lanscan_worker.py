"""Host-worker regression tests (standard library only, no network access)."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import uuid

WORKER_PATH = Path(__file__).resolve().parent / "lanscan-worker.py"
SPEC = importlib.util.spec_from_file_location("lanscan_worker", WORKER_PATH)
worker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(worker)


class HostWorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="homelab-lanscan-worker-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data = self.root / "data"
        self.data.mkdir()
        self.scan_script = self.root / "scripts" / "update-lanscan.sh"
        self.scan_script.parent.mkdir()
        self.scan_script.write_text("#!/bin/bash\nexit 0\n", encoding="utf-8")
        for key, value in {
            "PROJECT_DIR": self.root,
            "DATA_DIR": self.data,
            "SCAN_SCRIPT": self.scan_script,
            "SNAPSHOT": self.data / "lanscan.json",
            "REQUEST": self.data / "lanscan-request.json",
            "STATUS": self.data / "lanscan-status.json",
            "HEARTBEAT": self.data / "lanscan-worker-heartbeat",
            "LOCK": self.data / ".lanscan-worker.lock"
        }.items():
            original = getattr(worker, key)
            setattr(worker, key, value)
            self.addCleanup(setattr, worker, key, original)

    def test_manual_request_runs_once_and_never_executes_request_arguments(self):
        request = {"id": str(uuid.uuid4()), "requestedAt": worker.now(),
                   "command": "rm -rf /", "network": "1.2.3.0/24"}
        worker.REQUEST.write_text(json.dumps(request), encoding="utf-8")
        with patch.object(worker.subprocess, "run") as run:
            self.assertEqual(worker.main(), 0)
            run.assert_called_once()
            args = run.call_args.args[0]
            self.assertEqual(args, ["/bin/bash", str(self.scan_script)])
            self.assertEqual(run.call_args.kwargs["timeout"], 150)
            self.assertTrue(worker.HEARTBEAT.exists())
            self.assertFalse(worker.REQUEST.exists())
            status = json.loads(worker.STATUS.read_text())
            self.assertEqual(status["state"], "completed")
            self.assertEqual(status["requestId"], request["id"])
            self.assertEqual(status["requestedAt"], request["requestedAt"])
            self.assertEqual(worker.main(), 0)
            self.assertEqual(run.call_count, 1)

    def test_periodic_scan_runs_only_if_snapshot_is_old(self):
        with patch.object(worker.subprocess, "run") as run:
            self.assertEqual(worker.main(), 0)
            self.assertEqual(run.call_count, 1)
            status = json.loads(worker.STATUS.read_text())
            self.assertIsNone(status["requestId"])
            self.assertEqual(status["state"], "completed")
            self.assertEqual(worker.main(), 0)
            self.assertEqual(run.call_count, 1)

    def test_failed_scan_reports_error_without_retry_storm(self):
        with patch.object(worker.subprocess, "run",
                          side_effect=subprocess.CalledProcessError(1, "test-scan")) as run:
            self.assertEqual(worker.main(), 1)
            self.assertEqual(json.loads(worker.STATUS.read_text())["state"], "failed")
            self.assertEqual(worker.main(), 0)
            self.assertEqual(run.call_count, 1)

    def test_invalid_marker_is_ignored_without_running_script(self):
        worker.REQUEST.write_text('{"id":"bad", "requestedAt":"invalid"}')
        with patch.object(worker.subprocess, "run") as run:
            self.assertEqual(worker.main(), 1)
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
