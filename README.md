# Homelab Control

A unified control and investigation dashboard for a self-hosted homelab, combining **Homelab Commander** and **Homelab Detective**.

## Sprint 1 foundation

- Responsive dark-mode React / TypeScript dashboard
- Express / TypeScript API with SQLite storage
- Docker Compose deployment
- `GET /api/health`, `GET /api/systems`, `GET /api/events`
- Initial database tables `systems` and `events`
- Initial foundation, no external connections or write actions

## Start

Requires Docker Engine and Docker Compose plugin.

```bash
git clone git@github.com:unilsson/homelab-control.git
cd homelab-control
cp .env.example .env
docker compose up -d --build
docker compose ps
```

Open http://localhost:8080 or http://YOUR-SERVER-IP:8080.

Check API:

```bash
curl http://localhost:3001/api/health
curl http://localhost:3001/api/systems
curl http://localhost:3001/api/events
```

Without a configured integration the system and event lists are empty.

## Configuration

`.env` (not committed):

```dotenv
FRONTEND_PORT=8080
BACKEND_PORT=3001
```

SQLite is stored in `data/homelab.sqlite`, backed by a bind mount. Back up the `data/` folder as needed. Do not commit credentials.

## Development

Start the backend with `cd backend && npm install && npm run dev` and the frontend with `cd frontend && npm install && npm run dev` in separate terminals. Vite serves localhost:5173 and proxies `/api` to localhost:3001.

## Security

**LAN-only during Sprint 1**: No authentication has been implemented yet. Do not expose ports 8080 or 3001 to the public internet. Implement authentication and authorization before privileged write operations.

## Workflow

Production on ThinkPad tracks `main`; test feature and sprint branches on the development laptop before merging.

## Deploy remotely to ThinkPad with Ansible

Run the playbook **on your development laptop**, using SSH to reach the Ubuntu Server on ThinkPad.

Requirements:
- Ansible installed on your development laptop.
- SSH connectivity as `unilsson@thinkpad` (SSH alias or working hostname).
- On ThinkPad, `unilsson` must have GitHub SSH access and permission to use Docker without sudo.
- An existing ThinkPad installation at `/home/unilsson/Development/homelab-control` with a local `.env` file.

```bash
sudo apt install ansible
ansible -i ansible/inventory.ini thinkpad -m ping
ansible-playbook -i ansible/inventory.ini ansible/deploy-thinkpad.yml
```

The playbook checks the local `.env`, updates the remote working tree to `main`, runs `docker compose up -d --build`, and verifies the API on port **3002** and dashboard on port **8080**. It does **not** copy or overwrite `.env` or `data/`. The ports can be overridden with extra vars, for example `-e homelab_api_port=3003`.

If `thinkpad` is not resolvable from the laptop, edit `ansible/inventory.ini` and set `ansible_host` to ThinkPad's reachable IP address.

## Sprint 2 — Read-only Proxmox discovery (multi-server)

Sprint 2 discovers **multiple Proxmox installations independently**. Each configured
connection has its own stable ID, display name, HTTPS origin, read-only API-token ID
and optional CA certificate. Token **secrets** are referenced by Infisical key name. The dashboard groups nodes, QEMU VMs and LXC containers under
their respective Proxmox installation and shows independent connection health.

The API endpoint `GET /api/integrations/proxmox` returns both aggregated arrays
(`nodes`, `guests`) and an `instances` array containing per-server status and data.
If one server is unreachable, the other still appears normally. Existing SQLite
records for the unreachable instance are preserved and marked `unknown` rather
than falsely `offline`.

**Clusters:** One Proxmox cluster is normally monitored through a single API
endpoint; the API exposes all nodes in that cluster. Configure **one entry per
independent cluster or standalone installation**, not two entries pointing at
different nodes of the same cluster (that would duplicate inventory). Redundant
cluster endpoints/failover are a later feature.

### Create read-only credentials

For **each independent Proxmox installation**, create a dedicated service user
and a privilege-separated API token in the Proxmox UI (Datacenter → Permissions).
Give the user and its token the `PVEAuditor` role with appropriate audit-only
permissions to view nodes and VMs (e.g., with inheritance at `/` for full
inventory). For separated tokens **both the user and the token** must have
permissions. Never use a root/admin token for this integration.

Tokens look like `monitor@pve!discovery`; the secret is the one-time generated
value. Token secrets are not stored in the repository or sent to the browser.

### Configure both servers on your Lenovo (NOT GitHub)

```bash
cd ~/Development/homelab-control
git switch sprint-2-proxmox-discovery
cp config/proxmox-instances.example.json config/proxmox-instances.json
nano config/proxmox-instances.json
```

Each entry has its own name, address, token ID and **Infisical secret reference**; use the example as a template:

```json
[
  {
    "id": "pve-a",
    "name": "Proxmox A",
    "url": "https://proxmox-a.example:8006",
    "tokenId": "monitor@pve!discovery",
    "tokenSecretRef": "PROXMOX_A_TOKEN",
    "caPath": "/app/certs/proxmox-a-ca.pem"
  },
  {
    "id": "pve-b",
    "name": "Proxmox B",
    "url": "https://proxmox-b.example:8006",
    "tokenId": "monitor@pve!discovery",
    "tokenSecretRef": "PROXMOX_B_TOKEN",
    "caPath": "/app/certs/proxmox-b-ca.pem"
  }
]
```

Use stable **unique IDs** and do not change them after data has been discovered;
otherwise resources would be inserted as new identities. VM 100 on server A is
not the same resource as VM 100 on server B.

In the Lenovo's existing local `.env`, add:

```dotenv
PROXMOX_INSTANCES_FILE=/app/config/proxmox-instances.json
```

Keep existing `FRONTEND_PORT` and `BACKEND_PORT` values. This local JSON
contains endpoint metadata and **references only** (no Proxmox secret values).
The file is ignored by `.gitignore` and mounted read-only into the backend
container. Never use `git add -f` to add it. A legacy `tokenSecret` field
is supported for migration but `tokenSecretRef` is recommended.

### Infisical: central Proxmox secret management

Configure the URL of your self-hosted Infisical installation in a local `.env` file.
The example below uses a placeholder hostname; use your real URL locally.
The existing **`dev` environment** can be used for development. We use the official Node.js SDK and
Machine Identity (Universal Auth), so Proxmox secret values never need to be
copied into `config/proxmox-instances.json`.

1. Create (or select) an Infisical project for `homelab-control`. Locate its
   **Project ID** in Project Settings. Keep using the existing environment slug
   `dev` on the Lenovo. Use `prod` on ThinkPad only after that environment
   actually exists and contains its own secrets.
2. Under the `dev` environment, create two secrets named
   `PROXMOX_A_TOKEN` and `PROXMOX_B_TOKEN`. Their values are the **token
   secrets**, not the token IDs. Use folder `/` unless you deliberately choose
   a different folder.
3. Create a dedicated **Machine Identity** for Homelab Control using
   **Universal Auth**. Grant it only permission to read the necessary secrets
   in this project/environment/path. Store its Client ID and Client Secret
   locally on the Lenovo; never commit them.
4. Add these settings to the Lenovo's **existing local** `.env` file:

```dotenv
PROXMOX_INSTANCES_FILE=/app/config/proxmox-instances.json
INFISICAL_SITE_URL=https://secrets.example.invalid
INFISICAL_PROJECT_ID=YOUR_PROJECT_ID
INFISICAL_ENV=dev
INFISICAL_SECRET_PATH=/
INFISICAL_CLIENT_ID=YOUR_MACHINE_IDENTITY_CLIENT_ID
INFISICAL_CLIENT_SECRET_FILE=/app/secrets/infisical-client-secret
```

Create the bootstrap secret file on Lenovo:

```bash
mkdir -p secrets
umask 077
${EDITOR:-nano} secrets/infisical-client-secret
chmod 600 secrets/infisical-client-secret
```

Paste only the **machine identity Client Secret** into that local file. Make
sure no trailing whitespace is included; the backend trims surrounding
whitespace. Do not put it into Git, the example JSON, or chat messages.
The Docker backend reads the file from its read-only `/app/secrets` mount.
If UID permissions differ, ensure its non-root `node` user can read the file.
There is also a backwards-compatible `INFISICAL_CLIENT_SECRET` environment
option, but it exposes the bootstrap credential through Docker environment
metadata, so prefer the mounted file.

**Authentication flow:**

```text
Homelab Control backend
    │ Machine Identity (Client ID + Client Secret)
    ▼
Infisical https://secrets.example.invalid
    │ Resolve PROXMOX_A_TOKEN / PROXMOX_B_TOKEN
    ▼
Backend memory (never SQLite or the browser)
    │ HTTPS, read-only Proxmox API
    ├── Proxmox A
    └── Proxmox B
```

The backend caches secrets in memory for **5 minutes** to limit Infisical API
requests and automatically re-reads them for token rotation. If Infisical is
temporarily unreachable, a previously retrieved value can be used for at most
**1 hour**. After that, the affected Proxmox connection becomes an error
until the secret is available again. No disk cache is written.

The Integrations page shows **Infisical status only**, not credential values.
The read-only endpoint `/api/integrations/infisical` also exposes only
`configured`, `state`, `lastCheckedAt`, and an optional generic message.
Proxmox connection errors remain independent.

**TLS:** Both Infisical and Proxmox must have trusted HTTPS certificates.
Do not disable TLS verification. If your self-hosted Infisical uses an internal
CA instead of a publicly trusted certificate, mount only the **public CA**
and set `INFISICAL_CA_PATH=/app/certs/infisical-ca.pem` in the local `.env`
(the Compose file sets `NODE_EXTRA_CA_CERTS` for the backend). Never store
private keys in the repository.

**Backwards compatibility:** Existing `tokenSecret` entries continue working.
For new installations use `tokenSecretRef` exclusively. Do not specify both
fields on the same server. The old single-server environment variables are
also supported but cannot use Infisical references.

### TLS certificate trust

The HTTPS certificate hostname must match the hostname in `url`. For
Proxmox's internal CA, transfer **only the public certificate** from
`/etc/pve/pve-root-ca.pem` on the corresponding host to
`certs/proxmox-a-ca.pem` and `certs/proxmox-b-ca.pem` on your Lenovo.
Both are ignored by Git. For public CA-signed certificates, **omit `caPath`**
for that instance.

Example (requires Proxmox SSH access to read its public CA certificate):

```bash
ssh PROXMOX_A_SSH 'cat /etc/pve/pve-root-ca.pem' > certs/proxmox-a-ca.pem
ssh PROXMOX_B_SSH 'cat /etc/pve/pve-root-ca.pem' > certs/proxmox-b-ca.pem
```

The application never disables certificate validation and never uses
insecure TLS. **Never copy the private CA key** to this repository.

### Build and test

```bash
docker compose up -d --build
curl -s http://localhost:3001/api/integrations/proxmox
curl -s http://localhost:3001/api/integrations/infisical
curl -s http://localhost:3001/api/systems
```

Adjust port 3001 if you have a different local `BACKEND_PORT`. Open
`http://localhost:8080` (or your selected `FRONTEND_PORT`).

The combined status is `online` if all configured instances can be read,
`partial` if some fail, `error` if all fail, and `disabled` when none are
configured. Each instance reports its own state and errors. Guest-list permission
failures show `partial` for that instance while keeping other data visible.

The legacy single-server `PROXMOX_URL` / `PROXMOX_TOKEN_ID` /
`PROXMOX_TOKEN_SECRET` environment variables continue to work as a fallback,
but `PROXMOX_INSTANCES_FILE` takes precedence. Empty configuration means the
integration is disabled and Sprint 1 functionality continues to work.

### Deployment and safety

No Proxmox API tokens are committed to Git. ThinkPad runs `main` and remains
unchanged until this sprint is approved. The ThinkPad Ansible playbook deploys
application code but does not copy your private instance configuration. When
ready for production, configure it separately on the ThinkPad.

The application itself still has no login and must remain on a trusted LAN.

## Sprint 3A — NETWORK → LAN (lanscan)

The **NETWORK → LAN** page shows the entire local IPv4 allocation (normally all
**254** host addresses of `192.168.1.0/24`) in numeric IP order. It includes a
searchable table and status filters for `USED`, `FREE`, `LEASED`, `RESERVED`
and `CONFLICT`. Each row shows its IP, hostname, MAC, vendor or DHCP
description when available. Summary counters show total/occupied/free addresses.

**Data source:** the separate open-source
[`unilsson/lanscan`](https://github.com/unilsson/lanscan) CLI, not an
additional scanner built into Homelab Control. Its versioned
`lanscan 192.168.1.0/24 --all --opnsense --json` output is saved to the host's
`data/lanscan.json`. Docker already bind-mounts `./data:/app/data`; the
backend only **reads** this JSON at `GET /api/network/lan`.
The JSON contains no OPNsense API credentials. The **Scan now** button uses
`POST /api/network/lan/scan` to write a fixed, rate-limited request marker;
the unprivileged **host-side worker** does the actual network scanning.
Requests are collected within about 1 minute; automatic scans continue every
15 minutes. The page polls status every 3 seconds while a scan is queued or
running, and retains the previous snapshot until a new scan succeeds.
The host worker must be active or **Scan now** is disabled.

**No Docker host networking,
NET_RAW, sudo, or OPNsense secrets are needed inside the container.**

`LANSCAN_NETWORK=192.168.1.0/24` in the host's `.env` sets the subnet used by
the backend validator and Docker. The same subnet must be used by the host
exporter. The default snapshot path inside Docker is
`/app/data/lanscan.json`.

### Initial local test (Lenovo)

Install `lanscan` and `arp-scan` on the host if needed:

```bash
sudo apt install python3 pipx arp-scan
pipx install git+https://github.com/unilsson/lanscan.git
```

If `lanscan` is already installed, use the existing installation.
The host must actually be connected to `192.168.1.0/24` and must be able
to send ARP requests on that network.

For the complete `LEASED`/`RESERVED` information, configure the host user's
`~/.config/lanscan/config.toml` with **read-only OPNsense API credentials**,
as documented in the lanscan repository. This file is not copied into Docker,
is not committed, and should have mode `600`.

```bash
cd ~/Development/homelab-control
git switch sprint-3a-lanscan-lan-inventory
# Interactive sudo may prompt for a password; run as your normal user.
bash scripts/update-lanscan.sh
docker compose up -d --build
curl -fsS http://localhost:3001/api/network/lan |
  jq '{network, state, scannedAt, summary}'
```

Open **http://localhost:8080**, then navigate to **NETWORK → LAN**. A
successful `/24` snapshot has `summary.total == 254`; for a fresh scan,
`state == "online"`. Page data reloads every 30 seconds. The host scan
itself is separate and only updates when you run the script (or enable the
timer below). A snapshot older than 30 minutes appears as `stale`, but its
last-known address table is retained.

**No OPNsense credentials configured yet?** Run
`LANSCAN_WITH_OPNSENSE=0 bash scripts/update-lanscan.sh` for an ARP-only
snapshot. This is less reliable for judging which addresses are free,
because offline DHCP reservations will not be included.

### Automatic and manual scans on Lenovo or ThinkPad (after setup)

Install and configure `lanscan` **on the Linux host**, not inside
Homelab Control's Docker container. This works on Lenovo while testing and
on ThinkPad after approval and merge. If using OPNsense correlation,
securely create the host user's `~/.config/lanscan/config.toml` on each
host as above.

`lanscan` internally runs `sudo arp-scan 192.168.1.0/24`. A
noninteractive **user** timer therefore needs narrowly scoped sudo permission
for that exact command. Do **not** enable blanket passwordless sudo or run
the full web application as root. Check the installed path first with
`command -v arp-scan` (often `/usr/bin/arp-scan`). Then on the Linux host:

```bash
sudo visudo -f /etc/sudoers.d/homelab-lanscan
```

Add one line, adapting the binary path if needed:

```text
unilsson ALL=(root) NOPASSWD: /usr/bin/arp-scan 192.168.1.0/24
```

This permits only that one ARP scan command. Test it with
`sudo -n /usr/bin/arp-scan 192.168.1.0/24 >/dev/null`.
If the installation uses a different sudo rule or scanner binary, adjust
accordingly; the exporter always invokes the existing `lanscan` CLI.

Manually verify the first scan **on the Linux host**:

```bash
cd ~/Development/homelab-control
bash scripts/update-lanscan.sh
# ThinkPad backend uses port 3002; use port 3001 on Lenovo instead.
curl -fsS http://127.0.0.1:3002/api/network/lan |
  jq '{state, network, scannedAt, summary, scan}'
```

When the manual test works, enable the included **user** timer:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/homelab-lanscan.service systemd/homelab-lanscan.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now homelab-lanscan.timer
systemctl --user list-timers homelab-lanscan.timer
journalctl --user -u homelab-lanscan.service -n 40 --no-pager
```

The timer checks for a **Scan now** request every minute. If there is no
manual request, it refreshes the snapshot approximately every 15 minutes.
The host service runs as your normal user; sudo is restricted to the exact
ARP scan binary and subnet. **Do not copy any root credentials into Docker.**

Verify that the worker is active and the scan button is available:

```bash
curl -fsS http://127.0.0.1:3002/api/network/lan | jq '.scan'
# On Lenovo use http://127.0.0.1:3001 instead.
# Click NETWORK → LAN → Scan now and watch state queued → running → completed.
journalctl --user -u homelab-lanscan.service -n 40 --no-pager
```

If you already installed an older version of these systemd units, copy
both units again and run `systemctl --user daemon-reload` and
`systemctl --user restart homelab-lanscan.timer`.

**API responses:** `POST /api/network/lan/scan` returns HTTP 202 when queued,
409 for an active scan, 429 if a manual scan was requested less than 90
seconds ago, or 503 if the host worker is unavailable. Cross-site browser
POSTs are rejected; the application still has **no user authentication**, so
LAN and API access must remain restricted to trusted devices.

If you want it to
continue when `unilsson` is logged out, enable systemd lingering for that
user (`sudo loginctl enable-linger unilsson`). The included service
assumes the repo is at `~/Development/homelab-control`. If you intentionally
do not use the OPNsense API, change `LANSCAN_WITH_OPNSENSE=1` to `0` in
your **local installed copy** of the service before enabling the timer.

**Important safety note:** `FREE` means only that no device answered ARP
and (with `--opnsense`) OPNsense knows of no active lease or static mapping.
It does *not* guarantee an address is unused by a sleeping, static-IP or
otherwise invisible device. Never automatically allocate IPs based solely
on these scans. Keep the LAN dashboard on your trusted network: the
web app does not yet have authentication.

The script only replaces the snapshot **after validating** that all expected
IP addresses are present. On scan failure, the previous snapshot is preserved
and subsequently flagged stale. The snapshot is Git-ignored. Ansible
deploys application code only; it does **not** provision `lanscan`,
the OPNsense credentials, the sudoers entry or the user timer.
