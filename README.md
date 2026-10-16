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

## Sprint 3A — NETWORK → LAN (direct container scanning)

The **NETWORK → LAN** page shows the entire `192.168.1.0/24` address
allocation (**254** usable IPv4 addresses) with used/free/leased/reserved/
conflict status, search and status filters, hostname, MAC and vendor/description.

**Scan now runs lanscan directly in Homelab Control's backend container.**
No host-side installation, queue, Python worker or systemd timer is needed.
The backend also scans automatically on startup and about every **15 minutes**.

### How Scan now works

1. The browser sends `POST /api/network/lan/scan` to the backend.
2. The Node backend starts a *fixed* `lanscan 192.168.1.0/24 --all --json`
   command (plus `--opnsense` if configured). It does **not** accept a
   command or subnet from the browser.
3. While the scan runs, the UI displays **Scanning…**, polls every three
   seconds and keeps the previous snapshot visible.
4. The versioned JSON result is strictly validated for **all 254 addresses**
   and atomically stored in `./data/lanscan.json`. A failed or partial scan
   cannot overwrite the previous complete snapshot.
5. The backend returns a completed/failed state and the latest address table.

The API does not block while the scan is in progress. Repeated requests are
limited to once per 90 seconds; simultaneous scans are rejected with HTTP 409.

### Docker setup (Lenovo and ThinkPad)

```bash
cd ~/Development/homelab-control
git switch sprint-3a-lanscan-lan-inventory
git pull --ff-only
docker compose up -d --build
```

Open **http://localhost:8080 → NETWORK → LAN** and click **Scan now**.

The Docker image automatically installs a pinned release of the existing
[`unilsson/lanscan`](https://github.com/unilsson/lanscan) Python CLI and
`arp-scan`. You do **not** need to install them on the Linux host.

**Important Docker networking change:** The backend uses
`network_mode: host` on Linux, because ARP broadcasts are not delivered to
your physical LAN from an ordinary Docker bridge. The backend still runs as
the non-root `node` user. Only `CAP_NET_RAW` is granted, and only the
`arp-scan` binary receives that file capability. The tiny in-container
`sudo` compatibility shim executes *only* the configured `arp-scan` subnet;
it does not raise privileges or provide a root shell.

The frontend remains on its usual bridged Docker network. Its Nginx template
proxies API requests through `host.docker.internal` to the configured
`BACKEND_PORT` on the host. This requires **Linux Docker Engine** with
`host-gateway` support.

**Ports are unchanged:**
- Lenovo: `BACKEND_PORT=3001`, frontend normally `8080`.
- ThinkPad: `BACKEND_PORT=3002`, frontend normally `8080`.

Unlike Docker port publishing, host networking makes the backend bind to
the actual `BACKEND_PORT`. A different local process must not already be
listening there. Keep the backend and frontend reachable **only on your
trusted LAN**; Homelab Control does not yet have a user login. The scanner
does not permit clients to choose additional target networks.

For a quick check on Lenovo:

```bash
curl -fsS http://localhost:3001/api/network/lan |
  jq '{network, state, scannedAt, summary, scan}'
```

On ThinkPad, use port `3002`.

### Optional OPNsense DHCP correlation

By default `LANSCAN_WITH_OPNSENSE=false`; ARP and DNS are available out
of the box, but offline static reservations cannot be identified.
If you want accurate `LEASED` and `RESERVED` states, give the scanner
the read-only OPNsense DHCP configuration you already use with `lanscan`:

```bash
cd ~/Development/homelab-control
cp ~/.config/lanscan/config.toml secrets/lanscan-config.toml
chmod 600 secrets/lanscan-config.toml
```

In the machine's **local** `.env`, set:

```text
LANSCAN_NETWORK=192.168.1.0/24
LANSCAN_WITH_OPNSENSE=true
```

The file is Git-ignored and mounted through the existing **read-only**
`./secrets:/app/secrets` volume. The image links the CLI's default
`~/.config/lanscan/config.toml` path to
`/app/secrets/lanscan-config.toml`. The file must be readable by the
container's `node` user (UID 1000 on the standard Node image).
Do **not** put API keys in `.env`, GitHub, logs or browser responses.
Restart the backend after changing `.env`:

```bash
docker compose up -d --force-recreate backend
```

The same file/configuration is needed separately on ThinkPad after approval;
Ansible does **not** copy local secrets.

### Troubleshooting

```bash
docker compose ps
docker compose logs --tail=80 backend
curl -s http://localhost:3001/api/network/lan | jq '.scan'
```

If scans fail, check that the host has access to the intended LAN and
supports Docker host networking. If enabling OPNsense makes scans fail,
check the mounted credentials, TLS settings and OPNsense API reachability.
You can revert to `LANSCAN_WITH_OPNSENSE=false` for an ARP-only test.

If you previously configured the *unmerged, older* systemd worker approach
on Lenovo, it is no longer needed. You may disable and remove its user
timer/service:

```bash
systemctl --user disable --now homelab-lanscan.timer 2>/dev/null || true
rm -f ~/.config/systemd/user/homelab-lanscan.service \
      ~/.config/systemd/user/homelab-lanscan.timer
systemctl --user daemon-reload
```

A previously added `/etc/sudoers.d/homelab-lanscan` rule is also unnecessary
and should be reviewed/removed with administrator privileges.

**Interpretation:** `FREE` means no ARP response and, when OPNsense is
enabled, no active DHCP lease or static reservation. Sleeping/static hosts
can still escape discovery. Never automatically allocate IP addresses based
only on this scan.
