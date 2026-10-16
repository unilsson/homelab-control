import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const databasePath = process.env.DATABASE_PATH ?? './data/homelab.sqlite';
mkdirSync(dirname(databasePath), { recursive: true });
export const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  host TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER REFERENCES systems(id),
  severity TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

/**
 * Forward-only migration from the Sprint 1 schema.
 * Existing rows, event history and SQLite data remain intact.
 */
const columns = db.pragma('table_info(systems)') as Array<{ name: string }>;
for (const [name, definition] of [
  ['source', 'TEXT'],
  ['external_id', 'TEXT'],
  ['last_seen', 'TEXT']
] as const) {
  if (!columns.some(column => column.name === name)) {
    db.exec('ALTER TABLE systems ADD COLUMN ' + name + ' ' + definition);
  }
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS systems_external_identity ON systems(source, external_id) WHERE source IS NOT NULL AND external_id IS NOT NULL');
