import type Database from 'better-sqlite3';
import type { NetworkEventType } from './network-detective.js';

/**
 * Server-only integration with the user's internal Pushover Proxy:
 * POST /api/pushover/send {title:string, text:string}.
 * No direct Pushover credentials or unauthenticated write endpoints.
 */
export const supportedNotificationTypes = [
  'NEW_DEVICE', 'DEVICE_ONLINE', 'DEVICE_OFFLINE', 'IP_CHANGED',
  'MAC_CHANGED', 'IP_CONFLICT', 'CONFLICT_RESOLVED', 'DHCP_CHANGED'
] as const satisfies readonly NetworkEventType[];

export type NotificationChannel = 'pushover' | 'discord';
export type NotificationState =
  | 'pending' | 'sending' | 'retry' | 'accepted' | 'failed' | 'suppressed';
export type NotificationTransport = (
  url: string, message: { title: string; text: string }
) => Promise<number>;
export type NotificationOptions = {
  channel?: NotificationChannel;
  enabled: boolean;
  proxyUrl: string;
  eventTypes: readonly NetworkEventType[];
  cooldownMs: number;
  now?: () => number;
  send?: NotificationTransport;
};
export type NotificationHistory = {
  id: number; eventId: number; network: string; type: NetworkEventType;
  severity: string; mac: string | null; ip: string | null;
  state: NotificationState; attempts: number; reason: string | null;
  createdAt: string; lastAttemptAt: string | null;
  nextAttemptAt: string | null; acceptedAt: string | null;
};
type QueuedEvent = {
  id: number; network: string; type: NetworkEventType;
  severity: string; mac: string | null; ip: string | null;
  current_value: string | null; previous_value: string | null;
};
type PendingRow = {
  id: number; attempts: number; type: NetworkEventType; network: string;
  mac: string | null; ip: string | null;
  current_value: string | null; previous_value: string | null;
  hostname: string | null; display_name: string | null;
};
type StateCounts = {
  pending: number | null; retry: number | null;
  accepted: number | null; failed: number | null; suppressed: number | null;
};

function schemaFor(tableName: string): string {
  const indexPrefix = tableName === 'network_discord_notification_outbox'
    ? 'network_discord_notification' : 'network_notification';
  return [
  'CREATE TABLE IF NOT EXISTS ' + tableName + ' (',
  'id INTEGER PRIMARY KEY AUTOINCREMENT,',
  'event_id INTEGER NOT NULL UNIQUE REFERENCES network_events(id),',
  'dedupe_key TEXT NOT NULL,',
  "state TEXT NOT NULL CHECK (state IN ('pending','sending','retry','accepted','failed','suppressed')),",
  'attempts INTEGER NOT NULL DEFAULT 0, reason TEXT,',
  'created_at TEXT NOT NULL, last_attempt_at TEXT,',
  'next_attempt_at TEXT, accepted_at TEXT);',
  'CREATE INDEX IF NOT EXISTS ' + indexPrefix + '_due',
  'ON ' + tableName + '(state, next_attempt_at, id);',
  'CREATE INDEX IF NOT EXISTS ' + indexPrefix + '_dedupe',
  'ON ' + tableName + '(dedupe_key, created_at);'
  ].join(' ');
}

const retryDelays = [60_000, 2 * 60_000, 5 * 60_000];
const maxAttempts = retryDelays.length + 1;
const maxPerScan = 10; // burst protection; suppressed entries are auditable
const maxPerTenMinutes = 3;

export function validateProxyUrl(value: string, channel: NotificationChannel = 'pushover'): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      Boolean(url.hostname) && !url.username && !url.password &&
      url.pathname === (channel === 'discord' ? '/api/discord/send' : '/api/pushover/send') &&
      !url.search && !url.hash;
  } catch { return false; }
}

/** HTTP 200 means accepted by the proxy, not necessarily delivered to a phone. */
export const sendToInternalProxy: NotificationTransport = async (url, message) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(url, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ title: message.title, text: message.text }),
      signal: controller.signal
    });
    // Never log or store response bodies from the internal service.
    return response.status;
  } finally {
    clearTimeout(timer);
  }
};

/** Internal Discord Proxy accepts text only. Neutralize @mentions in untrusted LAN hostnames. */
export const sendToInternalDiscordProxy: NotificationTransport = async (url, message) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(url, {
      method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ text: (message.title + '\n' + message.text).replace(/@/g, '@\\u200b') }),
      signal: controller.signal
    });
    return response.status;
  } finally {
    clearTimeout(timer);
  }
};

function safe(value: string | null | undefined, length = 120): string {
  return (value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, length);
}

const labels: Record<NetworkEventType, string> = {
  NEW_DEVICE: 'Ny enhet',
  DEVICE_ONLINE: 'Enhet online',
  DEVICE_OFFLINE: 'Enhet offline',
  IP_CHANGED: 'IP-adress ändrad',
  MAC_CHANGED: 'MAC-adress ändrad',
  IP_CONFLICT: 'IP-konflikt',
  CONFLICT_RESOLVED: 'IP-konflikt löst',
  DHCP_CHANGED: 'DHCP-förändring'
};

function buildMessage(event: PendingRow): { title: string; text: string } {
  const name = safe(event.display_name || event.hostname || event.mac || event.ip || 'Okänd enhet');
  const change = (event.type === 'IP_CHANGED' || event.type === 'MAC_CHANGED')
    ? 'Från: ' + safe(event.previous_value, 60) + ' → ' + safe(event.current_value, 60) : '';
  const parts = [
    'Händelse: ' + labels[event.type],
    'Enhet: ' + name,
    event.ip ? 'IP: ' + safe(event.ip, 50) : '',
    event.mac ? 'MAC: ' + safe(event.mac, 60) : '',
    change
  ];
  return {
    title: 'Homelab Control – ' + labels[event.type],
    text: parts.filter(Boolean).join('\n').slice(0, 500)
  };
}

export function loadNotificationOptions(env: NodeJS.ProcessEnv = process.env): NotificationOptions {
  const supplied = (env.NETWORK_NOTIFICATIONS_EVENT_TYPES ?? 'NEW_DEVICE,IP_CONFLICT')
    .split(',').map(type => type.trim()).filter(Boolean);
  const eventTypes = supplied.filter(
    (type): type is NetworkEventType => supportedNotificationTypes.includes(type as NetworkEventType)
  );
  const rawCooldown = Number(env.NETWORK_NOTIFICATIONS_COOLDOWN_MINUTES ?? '60');
  const cooldown = Number.isFinite(rawCooldown) && rawCooldown >= 1 && rawCooldown <= 1440
    ? rawCooldown : 60;
  return {
    enabled: env.NETWORK_NOTIFICATIONS_ENABLED === 'true',
    proxyUrl: env.NETWORK_NOTIFICATIONS_PROXY_URL?.trim() ||
      'http://api.ulnihnw.net/api/pushover/send',
    eventTypes: [...new Set(eventTypes)],
    cooldownMs: cooldown * 60_000
  };
}

export function loadDiscordNotificationOptions(env: NodeJS.ProcessEnv = process.env): NotificationOptions {
  const options = loadNotificationOptions({
    NETWORK_NOTIFICATIONS_ENABLED: env.NETWORK_DISCORD_NOTIFICATIONS_ENABLED,
    NETWORK_NOTIFICATIONS_PROXY_URL: env.NETWORK_DISCORD_NOTIFICATIONS_PROXY_URL ||
      'http://api.ulnihnw.net/api/discord/send',
    NETWORK_NOTIFICATIONS_EVENT_TYPES: env.NETWORK_DISCORD_NOTIFICATIONS_EVENT_TYPES ??
      'NEW_DEVICE,IP_CONFLICT',
    NETWORK_NOTIFICATIONS_COOLDOWN_MINUTES: env.NETWORK_DISCORD_NOTIFICATIONS_COOLDOWN_MINUTES ??
      '60'
  });
  return { ...options, channel: 'discord' };
}

export class NetworkNotifications {
  private readonly now: () => number;
  private readonly send: NotificationTransport;
  private readonly validUrl: boolean;
  private readonly channel: NotificationChannel;
  private readonly tableName: string;
  private busy = false;

  constructor(private readonly db: Database.Database, private readonly options: NotificationOptions) {
    this.channel = options.channel || 'pushover';
    this.tableName = this.channel === 'discord'
      ? 'network_discord_notification_outbox' : 'network_notification_outbox';
    this.now = options.now || Date.now;
    this.send = options.send || (this.channel === 'discord'
      ? sendToInternalDiscordProxy : sendToInternalProxy);
    this.validUrl = validateProxyUrl(options.proxyUrl, this.channel);
    db.exec(schemaFor(this.tableName));
    // Recover interrupted sends after process restart. They can be retried;
    // end-to-end exactly-once delivery cannot be guaranteed by this API.
    db.prepare("UPDATE " + this.tableName + " SET state = 'retry', " +
      "next_attempt_at = ?, reason = 'interrupted' WHERE state = 'sending'")
      .run(new Date(this.now()).toISOString());
  }

  /** Called inside the scan's SQLite transaction to persist notifications atomically. */
  enqueueEvents(eventIds: readonly number[]): void {
    if (!this.options.enabled || eventIds.length === 0) return;
    const select = this.db.prepare(
      'SELECT id, network, type, severity, mac, ip, current_value, previous_value ' +
      'FROM network_events WHERE id = ?'
    );
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO ' + this.tableName + ' ' +
      '(event_id, dedupe_key, state, reason, created_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const nowIso = new Date(this.now()).toISOString();
    const earliest = new Date(this.now() - Math.max(60_000, this.options.cooldownMs)).toISOString();
    const eligible: QueuedEvent[] = [];
    for (const id of eventIds) {
      const event = select.get(id) as QueuedEvent | undefined;
      if (!event || !this.options.eventTypes.includes(event.type)) continue;
      // A DHCP reservation alone is not proof that a new device joined the LAN.
      if (event.type === 'NEW_DEVICE' && event.current_value !== 'arp') continue;
      eligible.push(event);
    }
    // Critical IP conflicts take precedence during a large scan.
    eligible.sort((a, b) =>
      (a.type === 'IP_CONFLICT' ? -1 : 0) - (b.type === 'IP_CONFLICT' ? -1 : 0)
    );
    let queued = 0;
    for (const event of eligible) {
      const dedupeKey = [event.network, event.type, event.mac || event.ip || 'unknown'].join('|');
      const existing = this.db.prepare(
        'SELECT 1 FROM ' + this.tableName + ' WHERE dedupe_key = ? ' +
        "AND created_at >= ? AND state IN ('pending','sending','retry','accepted') LIMIT 1"
      ).get(dedupeKey, earliest);
      const suppressed = Boolean(existing) || queued >= maxPerScan;
      const reason = existing ? 'cooldown' : queued >= maxPerScan ? 'burst_limit' : null;
      insert.run(
        event.id, dedupeKey, suppressed ? 'suppressed' : 'pending',
        reason, nowIso, suppressed ? null : nowIso
      );
      if (!suppressed) queued++;
    }
  }

  /** At most one request per pass, maximum three attempts per ten minutes. */
  async flush(): Promise<void> {
    if (!this.options.enabled || !this.validUrl || this.busy) return;
    this.busy = true;
    try {
      const now = this.now();
      const currentIso = new Date(now).toISOString();
      const recent = this.db.prepare(
        'SELECT COUNT(*) AS n FROM ' + this.tableName + ' WHERE last_attempt_at >= ?'
      ).get(new Date(now - 10 * 60_000).toISOString()) as { n: number };
      if (recent.n >= maxPerTenMinutes) return;

      const pending = this.db.prepare(
        'SELECT q.id, q.attempts, e.type, e.network, e.mac, e.ip, ' +
        'e.current_value, e.previous_value, d.hostname, d.display_name ' +
        'FROM ' + this.tableName + ' q ' +
        'JOIN network_events e ON e.id = q.event_id ' +
        'LEFT JOIN network_devices d ON d.network = e.network AND d.mac = e.mac ' +
        "WHERE q.state IN ('pending','retry') AND q.next_attempt_at <= ? " +
        'ORDER BY q.id LIMIT 1'
      ).get(currentIso) as PendingRow | undefined;
      if (!pending) return;

      const attempts = pending.attempts + 1;
      this.db.prepare(
        "UPDATE " + this.tableName + " SET state = 'sending', attempts = ?, " +
        'last_attempt_at = ?, reason = NULL WHERE id = ?'
      ).run(attempts, currentIso, pending.id);

      let code: number | null = null;
      try {
        code = await this.send(this.options.proxyUrl, buildMessage(pending));
      } catch {
        // Network error, timeout, DNS failure. Never expose raw errors.
      }

      if (code === 200) {
        this.db.prepare(
          "UPDATE " + this.tableName + " SET state = 'accepted', " +
          'accepted_at = ?, next_attempt_at = NULL WHERE id = ?'
        ).run(new Date(this.now()).toISOString(), pending.id);
      } else {
        const retryable = code === null || code === 429 || (code >= 500 && code <= 599);
        const retry = retryable && attempts < maxAttempts;
        const reason = code === 422 ? 'invalid_message' : !retryable
          ? 'proxy_rejected' : attempts >= maxAttempts
          ? 'retry_exhausted' : 'temporarily_unavailable';
        const next = retry ? new Date(this.now() + retryDelays[attempts - 1]).toISOString() : null;
        this.db.prepare(
          'UPDATE ' + this.tableName + ' SET state = ?, reason = ?, ' +
          'next_attempt_at = ? WHERE id = ?'
        ).run(retry ? 'retry' : 'failed', reason, next, pending.id);
      }
    } finally {
      this.busy = false;
    }
  }

  start(): void {
    if (!this.options.enabled || !this.validUrl) return;
    const processDue = () => {
      void this.flush().catch(() => console.warn('[notifications] Queue processing error.'));
    };
    setTimeout(processDue, 5_000).unref();
    setInterval(processDue, 20_000).unref();
  }

  status(): {
    enabled: boolean; configured: boolean; state: 'disabled' | 'ready' | 'error';
    provider: 'internal_pushover_proxy' | 'internal_discord_proxy';
    channel: NotificationChannel;
    eventTypes: readonly NetworkEventType[];
    cooldownMinutes: number;
    counts: { pending: number; retry: number; accepted: number; failed: number; suppressed: number };
    lastAttemptAt: string | null; message?: string;
  } {
    const counts = this.db.prepare(
      'SELECT ' +
      "SUM(CASE WHEN state IN ('pending','sending') THEN 1 ELSE 0 END) AS pending, " +
      "SUM(CASE WHEN state = 'retry' THEN 1 ELSE 0 END) AS retry, " +
      "SUM(CASE WHEN state = 'accepted' THEN 1 ELSE 0 END) AS accepted, " +
      "SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed, " +
      "SUM(CASE WHEN state = 'suppressed' THEN 1 ELSE 0 END) AS suppressed " +
      'FROM ' + this.tableName + ''
    ).get() as StateCounts;
    const latest = this.db.prepare(
      'SELECT MAX(last_attempt_at) AS latest FROM ' + this.tableName + ''
    ).get() as { latest: string | null };
    return {
      enabled: this.options.enabled, configured: this.validUrl,
      state: !this.options.enabled ? 'disabled' : this.validUrl ? 'ready' : 'error',
      provider: this.channel === 'discord' ? 'internal_discord_proxy' : 'internal_pushover_proxy',
      channel: this.channel, eventTypes: this.options.eventTypes,
      cooldownMinutes: Math.round(this.options.cooldownMs / 60_000),
      counts: {
        pending: counts.pending ?? 0, retry: counts.retry ?? 0,
        accepted: counts.accepted ?? 0, failed: counts.failed ?? 0,
        suppressed: counts.suppressed ?? 0
      },
      lastAttemptAt: latest.latest,
      ...(!this.validUrl && this.options.enabled
        ? { message: 'Invalid internal notification proxy URL.' } : {})
    };
  }

  history(limit = 50): NotificationHistory[] {
    return this.db.prepare(
      'SELECT q.id, q.event_id AS eventId, e.network, e.type, e.severity, e.mac, e.ip, ' +
      'q.state, q.attempts, q.reason, q.created_at AS createdAt, ' +
      'q.last_attempt_at AS lastAttemptAt, q.next_attempt_at AS nextAttemptAt, ' +
      'q.accepted_at AS acceptedAt ' +
      'FROM ' + this.tableName + ' q JOIN network_events e ON e.id = q.event_id ' +
      'ORDER BY q.id DESC LIMIT ?'
    ).all(Math.max(1, Math.min(100, limit))) as NotificationHistory[];
  }
}
