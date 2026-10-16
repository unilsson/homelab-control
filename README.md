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

## Sprint 2 — Read-only Proxmox discovery (development)

Sprint 2 adds discovery of **Proxmox nodes, QEMU VMs and LXC containers** and displays
their status, CPU and memory in Dashboard / Systems / Integrations. Discovered entries
are upserted into the existing SQLite `systems` table. Status changes are added to
the `events` table. Proxmox integration is optional: if not configured, existing
functionality remains unchanged.

Only **GET** requests are made to Proxmox. No VM, LXC or node actions are available.

### Create a dedicated read-only Proxmox API token

In Proxmox: Datacenter → Permissions → Users / API Tokens. Prefer a dedicated service
user (e.g. `homelab@pve`) and a privilege-separated token named `discovery`.

Give that user and token appropriate **audit-only** permissions to read the relevant
nodes and guests (the built-in `PVEAuditor` role is a convenient starting point).
For privilege-separated tokens, both the underlying user and the token need
permissions. Do not assign administrative or power-management privileges.

The API-token ID has the format `homelab@pve!discovery`, and the token secret is
the one-time value returned by Proxmox. Do not paste either secret into GitHub.

### Configure the local development laptop

Switch to the `sprint-2-proxmox-discovery` branch and update your **local** `.env`
(do not replace a working `.env` with `.env.example`):

```dotenv
FRONTEND_PORT=8080
BACKEND_PORT=3001
PROXMOX_URL=https://YOUR-PROXMOX-HOSTNAME:8006
PROXMOX_TOKEN_ID=homelab@pve!discovery
PROXMOX_TOKEN_SECRET=YOUR-SECRET
PROXMOX_CA_PATH=/app/certs/proxmox-ca.pem
```

Use the Proxmox hostname appearing in its HTTPS certificate. The backend validates
TLS certificates by default, including hostnames. For the default Proxmox internal
certificate, **copy only the public CA certificate** from
`/etc/pve/pve-root-ca.pem` on a Proxmox node into
`certs/proxmox-ca.pem` in the project directory. Never copy the CA private key.
For example, with a Proxmox SSH account that can read that public file:

```bash
ssh YOUR-PROXMOX-SSH-USER@YOUR-PROXMOX-HOST 'cat /etc/pve/pve-root-ca.pem' > certs/proxmox-ca.pem
```

If you already use a publicly trusted certificate on Proxmox, leave
`PROXMOX_CA_PATH` empty. The certificate files in `certs/` are excluded
from Git. The URL, credentials and CA path are passed only to the Docker
backend; no token secret is returned by the frontend API.

```bash
docker compose up -d --build
curl -s http://localhost:3001/api/integrations/proxmox
curl -s http://localhost:3001/api/systems
```

The API returns `state: disabled` when unconfigured, `online` on success,
`partial` if guest lists cannot all be read, or `error` if Proxmox is unreachable,
TLS validation fails or permissions are wrong. An upstream error does not break
`/api/health` or `/api/systems` and does not delete previous inventory.
The backend polls about once a minute and caches responses for 30 seconds.

### Production deployment

**Do not configure Proxmox access on ThinkPad yet** until the sprint branch has been
tested and merged. ThinkPad keeps its own `.env` (with `BACKEND_PORT=3002`)
and its existing `data/` database. After approval, deploy `main` with the
Ansible playbook.

**Security:** The application still has no login. Limit access to a trusted LAN
and do not expose its ports on the internet.
