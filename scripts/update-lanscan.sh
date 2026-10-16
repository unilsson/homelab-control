#!/usr/bin/env bash
# Run on the LAN-connected Linux HOST, not inside Docker.
# Generates a validated, atomic, read-only snapshot for Homelab Control.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NETWORK="${LANSCAN_NETWORK:-192.168.1.0/24}"
OUTPUT_DIR="${LANSCAN_OUTPUT_DIR:-$PROJECT_DIR/data}"
OUTPUT_FILE="$OUTPUT_DIR/lanscan.json"
WITH_OPNSENSE="${LANSCAN_WITH_OPNSENSE:-1}"
LANSCAN_BIN="${LANSCAN_BIN:-$HOME/.local/bin/lanscan}"

if [[ ! -x "$LANSCAN_BIN" ]]; then
  LANSCAN_BIN="$(command -v lanscan || true)"
fi
if [[ -z "$LANSCAN_BIN" || ! -x "$LANSCAN_BIN" ]]; then
  echo "lanscan not found: install it via pipx on this Linux host." >&2
  exit 1
fi
if [[ "$WITH_OPNSENSE" != 0 && "$WITH_OPNSENSE" != 1 ]]; then
  echo "LANSCAN_WITH_OPNSENSE must be 0 or 1" >&2
  exit 1
fi

mkdir -p "$OUTPUT_DIR"
umask 077
temp_file="$(mktemp "$OUTPUT_DIR/.lanscan.XXXXXXXX")"
trap 'rm -f "$temp_file"' EXIT

args=("$NETWORK" --all --json)
if [[ "$WITH_OPNSENSE" == 1 ]]; then args+=(--opnsense); fi
"$LANSCAN_BIN" "${args[@]}" > "$temp_file"

# Reject incomplete output before atomically replacing the last good snapshot.
python3 - "$temp_file" "$NETWORK" <<'PY'
import ipaddress
import json
import sys

path, cidr = sys.argv[1:]
net = ipaddress.ip_network(cidr, strict=True)
if net.version != 4 or not 20 <= net.prefixlen <= 30:
    raise SystemExit("Only IPv4 networks /20 to /30 are supported")

with open(path, encoding="utf-8") as handle:
    document = json.load(handle)
if not isinstance(document, dict) or document.get("schema_version") != 1:
    raise SystemExit("Unsupported lanscan JSON schema")
rows = document.get("results")
if not isinstance(rows, list) or len(rows) != net.num_addresses - 2:
    raise SystemExit("Incomplete lanscan scan; preserving the previous snapshot")

expected = {str(ip) for ip in net.hosts()}
observed = set()
for row in rows:
    if not isinstance(row, dict) or row.get("ip") not in expected:
        raise SystemExit("Invalid or out-of-range LAN address")
    if row["ip"] in observed:
        raise SystemExit("Duplicate LAN address")
    if row.get("status") not in {"used", "free", "leased", "reserved", "conflict"}:
        raise SystemExit("Unexpected LAN address status")
    observed.add(row["ip"])
if observed != expected:
    raise SystemExit("Missing LAN addresses")
PY

# No passwords or API tokens are stored in this snapshot. Allow the non-root
# Docker backend to read it even when host/container numeric UIDs differ.
chmod 0644 "$temp_file"
mv -f "$temp_file" "$OUTPUT_FILE"
echo "LAN snapshot updated: $OUTPUT_FILE ($NETWORK)"
