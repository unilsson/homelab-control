import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import { db } from './database.js';
import { getProxmoxInventory } from './integrations/proxmox.js';
import { getInfisicalStatus } from './integrations/infisical.js';
import { readLanInventory } from './integrations/lanscan.js';
import { enqueueLanScan } from './integrations/lanscan-scan.js';

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

app.get('/api/integrations/infisical', (_req, res) => {
  res.json(getInfisicalStatus());
});

app.get('/api/integrations/proxmox', async (_req, res, next) => {
  try { res.json(await getProxmoxInventory()); }
  catch (error) { next(error); }
});

app.get('/api/network/lan', async (_req, res, next) => {
  try { res.json(await readLanInventory()); }
  catch (error) { next(error); }
});

// Queue only a fixed host-side scan; never execute OS commands in Docker.
// No authentication exists yet: reject cross-site browser requests and rate-limit
// all manual requests. Keep both web and backend ports restricted to trusted LAN.
app.post('/api/network/lan/scan', async (req, res, next) => {
  const fetchSite = req.get('sec-fetch-site');
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
    res.status(403).json({ error: 'Cross-site scan requests are not allowed.' });
    return;
  }
  const origin = req.get('origin');
  if (origin) {
    try {
      const url = new URL(origin);
      if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
          url.hostname.toLowerCase() !== req.hostname.toLowerCase()) {
        res.status(403).json({ error: 'Cross-origin scan requests are not allowed.' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Invalid request origin.' });
      return;
    }
  }
  try {
    const result = await enqueueLanScan();
    res.status(result.httpStatus).json(result.scan);
  } catch (error) { next(error); }
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
