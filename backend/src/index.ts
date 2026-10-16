import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import { db } from './database.js';

const app = express();
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'homelab-control-api', timestamp: new Date().toISOString() });
});

app.get('/api/systems', (_req, res) => {
  const systems = db.prepare('SELECT id, name, type, status, host, created_at FROM systems ORDER BY name').all();
  res.json(systems);
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
