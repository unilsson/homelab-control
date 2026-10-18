import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import { db } from './database.js';
import { getProxmoxInventory } from './integrations/proxmox.js';
import { getInfisicalStatus } from './integrations/infisical.js';
import { getOpnsenseStatus } from './integrations/opnsense.js';
import { readLanInventory } from './integrations/lanscan.js';
import { getLanScanInfo, requestLanScan, startLanScanner, lanScanner } from './integrations/lanscan-scan.js';
import { NetworkDetective, normalizeMac } from './network-detective.js';
import { NetworkNotifications, loadNotificationOptions, loadDiscordNotificationOptions } from './network-notifications.js';

const detective = new NetworkDetective(db);
const notifications = new NetworkNotifications(db, loadNotificationOptions());
const discordNotifications = new NetworkNotifications(db, loadDiscordNotificationOptions());

// Recording history and queuing its matching notifications must be ONE
// SQLite transaction; never queue notifications for failed scans.
const persistScan = db.transaction((
  inventory: Parameters<typeof detective.recordScan>[0], scannedAt: string, scanId: string
) => {
  const newEvents = detective.recordScan(inventory, scannedAt, scanId);
  notifications.enqueueEvents(newEvents);
  discordNotifications.enqueueEvents(newEvents);
});
lanScanner.setSnapshotObserver((inventory, scannedAt, scanId) => {
  persistScan(inventory, scannedAt, scanId);
  // No network request is made while the SQLite transaction is open.
  void notifications.flush().catch(() =>
    console.warn('[notifications] Could not process the Pushover queue.')
  );
  void discordNotifications.flush().catch(() =>
    console.warn('[notifications] Could not process the Discord queue.')
  );
});
const configuredLan = process.env.LANSCAN_NETWORK?.trim() || '192.168.1.0/24';

function queryLimit(value: unknown, fallback: number, maximum: number): number | null {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,2}$/.test(value)) return null;
  const limit = Number(value);
  return limit <= maximum ? limit : null;
}

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

app.get('/api/integrations/opnsense', (_req, res) => {
  // Only metadata; neither Infisical values nor OPNsense credentials exposed.
  res.json(getOpnsenseStatus());
});

app.get('/api/integrations/proxmox', async (_req, res, next) => {
  try { res.json(await getProxmoxInventory()); }
  catch (error) { next(error); }
});

app.get('/api/network/lan', async (_req, res, next) => {
  try { res.json({ ...await readLanInventory(), scan: getLanScanInfo() }); }
  catch (error) { next(error); }
});

// Sprint 3B: read-only Network Detective API. Editing and notifications are
// intentionally reserved for later sprints (no authentication exists yet).
app.get('/api/network/detective/summary', (_req, res) => {
  res.json(detective.summary(configuredLan));
});

app.get('/api/network/devices', (req, res) => {
  const limit = queryLimit(req.query.limit, 100, 500);
  if (limit === null) { res.status(400).json({ error: 'Invalid limit (1–500).' }); return; }
  res.json(detective.listDevices(configuredLan, limit));
});

app.get('/api/network/events', (req, res) => {
  const limit = queryLimit(req.query.limit, 50, 100);
  if (limit === null) { res.status(400).json({ error: 'Invalid limit (1–100).' }); return; }
  const value = req.query.mac;
  const mac = typeof value === 'string' ? normalizeMac(value) : null;
  if (value !== undefined && !mac) {
    res.status(400).json({ error: 'Invalid MAC filter.' }); return;
  }
  res.json(detective.listEvents(configuredLan, limit, mac ?? undefined));
});

app.get('/api/network/devices/:mac/events', (req, res) => {
  const limit = queryLimit(req.query.limit, 50, 100);
  if (limit === null) { res.status(400).json({ error: 'Invalid limit (1–100).' }); return; }
  const mac = normalizeMac(req.params.mac);
  if (!mac) { res.status(400).json({ error: 'Invalid MAC address.' }); return; }
  res.json(detective.listEvents(configuredLan, limit, mac));
});

// Sprint 3D: read-only notification status and delivery-attempt history.
// There are deliberately no browser-triggered send or rule-change endpoints.
app.get('/api/notifications/status', (_req, res) => {
  res.json(notifications.status());
});

app.get('/api/notifications/history', (req, res) => {
  const limit = queryLimit(req.query.limit, 50, 100);
  if (limit === null) {
    res.status(400).json({ error: 'Invalid limit (1–100).' });
    return;
  }
  res.json(notifications.history(limit));
});

// Sprint 3E: independent Discord channel using the LAN-only Discord Proxy.
// Read-only: delivery is never triggered by a browser request.
app.get('/api/notifications/discord/status', (_req, res) => {
  res.json(discordNotifications.status());
});

app.get('/api/notifications/discord/history', (req, res) => {
  const limit = queryLimit(req.query.limit, 50, 100);
  if (limit === null) {
    res.status(400).json({ error: 'Invalid limit (1–100).' });
    return;
  }
  res.json(discordNotifications.history(limit));
});

// Execute a fixed, configured lanscan command with concurrency and cooldown limits.
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
    const result = requestLanScan();
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

// LAN scanning is managed by the backend process, not a separate systemd timer.
startLanScanner();
notifications.start();
discordNotifications.start();
