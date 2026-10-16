# Homelab Control

A unified control and investigation dashboard for a self-hosted homelab, combining **Homelab Commander** and **Homelab Detective**.

## Sprint 1

- Responsive dark-mode React / TypeScript dashboard
- Express / TypeScript API with SQLite storage
- Docker Compose deployment
- `GET /api/health`, `GET /api/systems`, `GET /api/events`
- Initial database tables `systems` and `events`
- No external infrastructure connections or write actions yet

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

For new installs the system and event lists are empty until integrations are built.

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
