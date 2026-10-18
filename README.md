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

### OPNsense DHCP integration through Infisical

For complete inventory coverage, Homelab Control combines two read-only
sources:

- **lanscan** runs ARP and reverse-DNS discovery in Docker; this requires
  no OPNsense credentials.
- **Homelab Control backend** uses the existing Infisical Machine Identity
  to retrieve **two secrets in memory**. It then calls the **read-only
  OPNsense ISC DHCPv4 lease API** over verified HTTPS, and correlates
  dynamic leases and static DHCP reservations with the ARP results.

**The OPNsense API key and secret never appear in `.env`, Docker process
arguments, the Python CLI, local config files, SQLite, or the browser.**
Existing Infisical settings used for the Proxmox integration are reused;
you do not need a second Infisical client.

#### 1. Create secrets in Infisical

In the same Infisical project, environment (`INFISICAL_ENV`) and path
(`INFISICAL_SECRET_PATH`) that Homelab Control already uses, add:

| Infisical secret name | Value |
| --- | --- |
| `OPNSENSE_API_KEY` | Your read-only OPNsense API key |
| `OPNSENSE_API_SECRET` | The corresponding OPNsense API secret |

The existing Machine Identity must have **read permission** for both
secrets. OPNsense's API user needs only the ISC DHCPv4 lease read
permission. **Do not paste these secret values into a GitHub file, a chat
message or Docker environment variables.**

#### 2. Configure connection metadata only

In each machine's **local** `.env`:

```dotenv
LANSCAN_NETWORK=192.168.1.0/24
LANSCAN_WITH_OPNSENSE=true
LANSCAN_OPNSENSE_URL=https://opnsense.ulnihnw.net
LANSCAN_OPNSENSE_API_KEY_REF=OPNSENSE_API_KEY
LANSCAN_OPNSENSE_API_SECRET_REF=OPNSENSE_API_SECRET
# Optional: public CA if OPNsense's HTTPS certificate uses a private CA
# LANSCAN_OPNSENSE_CA_PATH=/app/certs/opnsense-ca.pem
```

Use the real HTTPS hostname for your OPNsense firewall. The certificate
**must match that hostname**. Normal CA validation stays enabled.
If OPNsense uses its own CA, install **only its public CA certificate**
as `./certs/opnsense-ca.pem` and set `LANSCAN_OPNSENSE_CA_PATH`
as shown. This public certificate is mounted via the existing read-only
`./certs:/app/certs` volume. We do **not** allow `verify_tls=false` or
`NODE_TLS_REJECT_UNAUTHORIZED=0`.

Then restart the backend to load the updated environment:

```bash
docker compose up -d --force-recreate backend
```

#### 3. Test safely

Open **NETWORK → LAN → Scan now**, then check:

```bash
curl -fsS http://localhost:3001/api/integrations/opnsense | jq
curl -fsS http://localhost:3001/api/network/lan |
  jq '{state, scannedAt, summary, scan}'
```

Use port **3002** on ThinkPad. The OPNsense connection also appears under
**SETTINGS → Integrations**. Only connection status and last-check time
are exposed.

Addresses with an active OPNsense dynamic lease but no ARP response are
`LEASED`; offline static DHCP mappings are `RESERVED`. A device
answering ARP is `USED` or `CONFLICT` regardless of lease type.

**Fail-closed behavior:** When OPNsense mode is enabled and either
Infisical secret retrieval, HTTPS/TLS validation or the DHCP API fails,
the scan reports **Failed** and preserves the previous good inventory.
We deliberately do not replace it with an ARP-only snapshot that could
incorrectly mark reserved addresses `FREE`.

During troubleshooting, `LANSCAN_WITH_OPNSENSE=false` is an optional
temporary ARP-only mode, but free-address classification is less reliable
without OPNsense reservations. The Infisical client already caches
successfully retrieved secrets for 5 minutes and has a bounded 1-hour
in-memory stale fallback during brief Infisical outages.

### Troubleshooting

```bash
docker compose ps
docker compose logs --tail=80 backend
curl -s http://localhost:3001/api/network/lan | jq '.scan'
```

If scans fail, check that the host has access to the intended LAN and
supports Docker host networking. If enabling OPNsense makes scans fail,
check the Infisical secret references and Machine Identity read permissions,
OPNsense API user privileges, TLS CA/hostname and HTTPS reachability.
You can temporarily set `LANSCAN_WITH_OPNSENSE=false` for an ARP-only test.

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

## Sprint 3B — Network Detective engine (backend only)

Sprint 3B adds **change detection and durable SQLite history** to the existing
15-minute LAN scanner. It does not add a new browser page yet; that belongs to
Sprint 3C. No change is made to OPNsense/Infisical credentials.

- Devices have stable, lowercase MAC identifiers scoped by LAN subnet.
- Each **successful complete scan** updates `network_devices` and creates
  change records in `network_events` (stored in the existing
  `./data/homelab.sqlite` bind mount). Full scans are not duplicated in SQLite.
- The initial scan establishes a **silent baseline**. Later scans detect:
  `NEW_DEVICE`, `DEVICE_ONLINE`, `DEVICE_OFFLINE`, `IP_CHANGED`,
  `MAC_CHANGED`, `IP_CONFLICT`, `CONFLICT_RESOLVED`, `DHCP_CHANGED`.
- **Offline requires two consecutive successful scans without ARP**, even if a
  static DHCP reservation remains. A DHCP-only device is `known`, **not**
  `online`. Failed, incomplete or rejected scans do not update history.
- Network Detective persists its changes in one SQLite transaction.
  Reprocessing the same scan ID is idempotent. If SQLite history fails, the
  previously validated LAN snapshot is kept and the scanner reports a generic
  history warning; no secrets appear in HTTP responses.
- Reserved `display_name` and `category` columns will support user-edited
  device labels in a future authenticated sprint. No unauthenticated edit routes
  or notifications are introduced in Sprint 3B.

### Test on Lenovo after updating the Sprint 3B branch

```bash
cd ~/Development/homelab-control
docker compose up -d --build
curl -fsS http://localhost:3001/api/network/detective/summary | jq
curl -fsS 'http://localhost:3001/api/network/devices?limit=10' | jq
curl -fsS 'http://localhost:3001/api/network/events?limit=20' | jq
```

The summary includes `scans`, `lastScannedAt`, `totalDevices`, `online`,
`offline`, `known` and `events`. On the first successful scan all events
are suppressed so the initial inventory doesn't flood the history. New events
appear only when subsequent successful scans detect changes.

Filter events by a device:

```bash
curl -fsS 'http://localhost:3001/api/network/events?mac=aa:bb:cc:dd:ee:ff&limit=20' | jq
curl -fsS 'http://localhost:3001/api/network/devices/aa:bb:cc:dd:ee:ff/events' | jq
```

Read-only endpoints use strict MAC validation and bounded pagination limits.
On ThinkPad use port **3002** after user acceptance, merge to `main`, and
the existing Ansible deploy. Back up `./data/homelab.sqlite` safely before
initial production deployment (for example with SQLite's online backup API).
The new tables are additive and existing Proxmox, systems and events data
remain intact. `./data` is never committed to Git.

## Sprint 3C — Network Detective UI

The **DETECTIVE** navigation now has real **Detective**, **Events** and
**Devices** pages, powered exclusively by the read-only Sprint 3B APIs:

- **Detective → Overview:** current known/online/offline/DHCP-only counts,
  total recorded changes, recent events, recently seen devices, and links
  to the LAN inventory. DHCP-only devices are not presented as online.
- **Detective → Events:** searchable event timeline, with severity and event
  type filters. Displays the **latest 100 events** (not the entire history);
  the total number of retained events is shown separately. A device name
  opens its history directly.
- **Detective → Devices:** searchable MAC-based device registry, filters
  for ONLINE / OFFLINE / DHCP only, and a detail panel with IP, hostname,
  vendor, first/last seen times and **per-device change history**.
  Device history requests use the dedicated read-only endpoint and show
  the latest 100 matching events.
- Pages refresh every 30 seconds while open; a refresh button forces an
  immediate request. API errors preserve the last successfully loaded data
  with a visible warning. Empty/baseline states explain why no events exist.
- Responsive dark UI; keyboard-accessible buttons and inputs, readable
  timestamps and explicit status labels. No new write operations, logins,
  integrations or configuration files.

### Test on Lenovo (before merge)

\`\`\`bash
cd ~/Development/homelab-control
git fetch origin
git switch --track origin/sprint-3c-network-detective-ui
docker compose up -d --build
\`\`\`

Open **http://localhost:8080** and test these acceptance criteria:

1. **DETECTIVE → Detective** loads real counters from
   \`GET /api/network/detective/summary\` and recent events/devices.
2. **DETECTIVE → Events** searches and filters the latest 100 recorded
   network events; clicking a known device opens its history.
3. **DETECTIVE → Devices** searches by hostname, IP, vendor or MAC; the
   ONLINE/OFFLINE/DHCP-only filters work; clicking **Details** loads that
   device's events.
4. **NETWORK → LAN**, Proxmox, Settings → Integrations and the Dashboard
   still work. A new complete LAN scan eventually refreshes Detective.
5. If there is no event history, the UI shows a calm empty state: the
   first successful scan is always a silent baseline, by design.

No database migration is necessary specifically for Sprint 3C. Keep
ThinkPad on \`main\` until user acceptance and merge. The existing Ansible
deployment can then update ThinkPad normally.

## Sprint 3D — Internal Pushover Proxy notifications

Homelab Control uses the existing **LAN-only Pushover Proxy** and never stores
Pushover user tokens or API tokens. Contract: `POST /api/pushover/send` with
`Content-Type: application/json`, body `{"title":"...","text":"..."}`.
Only `text` is mandatory. HTTP **200** means the proxy accepted the request,
not that a phone definitely received the push; HTTP **422** rejects bad input.

### Configure on Lenovo

Edit the machine's existing **local** `.env` and add:

```dotenv
NETWORK_NOTIFICATIONS_ENABLED=false
NETWORK_NOTIFICATIONS_PROXY_URL=http://api.ulnihnw.net/api/pushover/send
NETWORK_NOTIFICATIONS_EVENT_TYPES=NEW_DEVICE,IP_CONFLICT
NETWORK_NOTIFICATIONS_COOLDOWN_MINUTES=60
```

Restart: `docker compose up -d --build`.
Open **DETECTIVE → Notifications** or inspect:

```bash
curl -fsS http://localhost:3001/api/notifications/status | jq
curl -fsS 'http://localhost:3001/api/notifications/history?limit=20' | jq
```

**Disabled by default.** To allow actual phone notifications, explicitly set
`NETWORK_NOTIFICATIONS_ENABLED=true` and restart the backend with
`docker compose up -d --force-recreate backend`. The proxy must be reachable
from the backend host on the trusted LAN. There are no browser send endpoints.

Defaults: `NEW_DEVICE` (only newly discovered via ARP, not DHCP-only) and
`IP_CONFLICT`. Other supported opt-ins: `DEVICE_ONLINE`, `DEVICE_OFFLINE`,
`IP_CHANGED`, `MAC_CHANGED`, `CONFLICT_RESOLVED`, `DHCP_CHANGED`.

### Protection against notification spam

- Notification outbox is written to SQLite in the same transaction as
  Network Detective events. Failed scans cannot enqueue pushes, and the
  first successful scan remains a silent baseline.
- A 60-minute cooldown per event type and MAC/IP suppresses duplicates;
  a burst limit queues at most 10 per scan, prioritizing conflicts.
- At most 3 HTTP attempts per 10 minutes, with no more than 4 attempts
  per notification. Temporary network errors, HTTP 429 and HTTP 5xx are
  retried after 1, 2, then 5 minutes. HTTP 422 is a permanent failure.
- Queue state, retry outcomes and suppressed entries survive restarts.
  Raw errors, response bodies and credentials are not persisted.
- HTTP 200 is reported as **Accepted by proxy**, not **Delivered**.
  In the rare event of a crash after the proxy accepts the request, a
  retry can cause a duplicate push; exactly-once delivery is not possible
  without an idempotency feature on the proxy.

### Sprint 3D acceptance

1. Verify green GitHub Actions CI and a successful Docker build.
2. With notifications disabled, verify the UI shows disabled and sends nothing.
3. Enable on Lenovo only, and verify Ready status via the API and UI.
4. Trigger a safe, real new-device observation after the baseline and verify
   one Accepted by proxy record and a corresponding phone notification.
5. Verify older LAN/Proxmox/Detective features remain intact.
6. Merge only after explicit approval. Later, turn off the Lenovo notifier
   when enabling on ThinkPad to avoid duplicated pushes from two scanners.

Because this proxy uses HTTP, ensure it stays on the trusted LAN only.

## Sprint 3E — Discord as a second Network Detective notification channel

Homelab Control now supports **two independent LAN-only notification proxies**:

- Pushover: `POST http://api.ulnihnw.net/api/pushover/send`, JSON `{title,text}`.
- Discord: `POST http://api.ulnihnw.net/api/discord/send`, JSON `{text,kanal}`.

The Discord Proxy is already part of the homelab. It holds Discord's actual
webhook credentials; **do not put a Discord webhook URL, token or bot key into
Homelab Control**. The backend sends plain notification text with the explicit
channel alias `kanal: "homelab-control"` so it never relies on the proxy's
fallback/default channel. The alias must exist in the Discord Proxy's
`DISCORD_WEBHOOKS` mapping; aliases are case-sensitive. Unknown aliases return
HTTP 400, which the notifier records as a permanent failure (not retried).
No new public routes, send buttons or unauthenticated write endpoints are added.

### Architecture

The existing Sprint 3D `NetworkNotifications` engine is now parameterized by
channel. The original `network_notification_outbox` table and Pushover
read endpoints remain unchanged. Discord gets its own
`network_discord_notification_outbox` SQLite table, configured event rules,
cooldown, burst protection, attempt rate limits and retries. Successful
network-scan events enqueue for both channels in the *same SQLite transaction*,
so a scan history update cannot partially enqueue one channel without the
other. Network calls happen after the transaction commits. Failure of a Discord
HTTP call does not block Pushover attempts.

Discord is **disabled by default** and must be explicitly enabled separately
from Pushover. Add these variables to Lenovo's existing local `.env`:

```dotenv
NETWORK_DISCORD_NOTIFICATIONS_ENABLED=false
NETWORK_DISCORD_NOTIFICATIONS_PROXY_URL=http://api.ulnihnw.net/api/discord/send
NETWORK_DISCORD_NOTIFICATIONS_CHANNEL=homelab-control
NETWORK_DISCORD_NOTIFICATIONS_EVENT_TYPES=NEW_DEVICE,IP_CONFLICT
NETWORK_DISCORD_NOTIFICATIONS_COOLDOWN_MINUTES=60
```

Restart the backend after changing the config:

```bash
docker compose up -d --build
```

Read the new Discord-specific endpoints:

```bash
curl -fsS http://localhost:3001/api/notifications/discord/status | jq
curl -fsS 'http://localhost:3001/api/notifications/discord/history?limit=20' | jq
```

The old Pushover endpoints (`/api/notifications/status` and
`/api/notifications/history`) remain available unchanged. Visit
**DETECTIVE → Notifications** and switch between **Pushover** and **Discord**.
Each tab shows only its own queue, rules, status and attempt history.

### Acceptance test on Lenovo

1. Switch to `sprint-3e-discord-notifications` and rebuild containers.
2. Confirm Discord status is `disabled` while Pushover retains its previous
   state/history. Both APIs should work.
3. Confirm the internal service is reachable. If you wish to send a direct
   test message to the configured Discord channel, run:

   ```bash
   curl -i -X POST http://api.ulnihnw.net/api/discord/send \
     -H 'Content-Type: application/json' \
     -d '{"text":"Homelab Control – test av interna Discord Proxy","kanal":"homelab-control"}'
   ```

4. Set `NETWORK_DISCORD_NOTIFICATIONS_ENABLED=true` **only on Lenovo**,
   recreate the backend, and confirm `state=ready` and the intended destination
   `homelab-control` under the Discord tab. A `ready` status only verifies
   configuration syntax; it does not prove the channel alias exists in the proxy.
5. Ensure the proxy has a webhook alias named `homelab-control`, and restart
   it after updating its own `.env`. The proxy also supports its own default
   channel, but this application always selects `homelab-control` explicitly.
6. When a genuine new ARP device or IP conflict occurs after the baseline,
   verify the Discord notification appears and the corresponding history
   entry becomes `accepted`. Pushover should operate independently.
7. Approve the PR before merging; on ThinkPad, enable only the channels
   that should actually notify. Avoid enabling identical alerts on both
   Lenovo and ThinkPad to prevent duplicates.

Both proxies are internal HTTP endpoints and must remain LAN-only. HTTP 200
means accepted by the *proxy*, not confirmed delivered or displayed by Discord.
The queue uses at-least-once semantics and may resend after a rare crash.
