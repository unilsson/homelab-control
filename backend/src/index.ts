import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import { db } from './database.js';
import { getProxmoxInventory } from './integrations/proxmox.js';

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'homelab-control-api', timestamp: new Date().toISOString() });
});

app.get('/api/systems', async (_req, res, next) => {
  try {
    // Discovery is read-only against Proxmox; persistence is limited to local SQLite.
    await getProxmoxInventory();
    const systems = db.prepare('SELECT id, name, type, status, host, source, external_id, last_seen, created_at FROM systems ORDER BY type, name').all();
    res.json(systems);
  } catch (error) { next(error); }
});

app.get('/api/integrations/proxmox', async (_req, res, next) => {
  try { res.json(await getProxmoxInventory()); }
  catch (error) { next(error); }
});

app.get('/api/events', (_req, res) => {
  const events = db.prepare('SELECT id, system_id, severity, message, created_at FROM events ORDER BY id DESC LIMIT 20').all();
  res.json(events);
});

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  console.error('Request failed:', error);
  res.status(500).json({ error: 'Internal server error' });
};
app.use(errorHandler);

const port = Number(process.env.PORT ?? 3001);
app.listen(port, '0.0.0.0', () => console.log(`Homelab Control API listening on ${port}`));

// Refresh discovery once per minute, without preventing a clean process exit.
void getProxmoxInventory();
setInterval(() => { void getProxmoxInventory(); }, 60_000).unref();
