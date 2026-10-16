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
git clone https://github.com/unilsson/homelab-control.git
cd homelab-control
git switch sprint-1-foundation
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

Sprint branch: `sprint-1-foundation`. Test the application before merging into `main`.
