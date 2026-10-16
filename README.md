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
connection has its own stable ID, display name, HTTPS origin, read-only API token and
optional CA certificate. The dashboard groups nodes, QEMU VMs and LXC containers under
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

Each entry has its own name, address and token; use the example as a template:

```json
[
  {
    "id": "pve-a",
    "name": "Proxmox A",
    "url": "https://proxmox-a.example:8006",
    "tokenId": "monitor@pve!discovery",
    "tokenSecret": "SECRET_FROM_SERVER_A",
    "caPath": "/app/certs/proxmox-a-ca.pem"
  },
  {
    "id": "pve-b",
    "name": "Proxmox B",
    "url": "https://proxmox-b.example:8006",
    "tokenId": "monitor@pve!discovery",
    "tokenSecret": "SECRET_FROM_SERVER_B",
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

Keep the existing `FRONTEND_PORT` and `BACKEND_PORT` values. The secret JSON
file is ignored by `.gitignore` and mounted read-only into the backend
container. Never use `git add -f` to add it, and do not paste secrets into
issues, screenshots or logs.

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
