import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { NetworkDetective } from '../src/network-detective.js';
import type { LanAddress, LanInventory } from '../src/integrations/lanscan.js';
import {
  NetworkNotifications, loadNotificationOptions, validateProxyUrl,
  type NotificationOptions
} from '../src/network-notifications.js';

const url = 'http://api.ulnihnw.net/api/pushover/send';
const network = '192.168.1.0/24';
type Inventory = Pick<LanInventory, 'network' | 'results'>;
function snapshot(): Inventory {
  return { network, results: Array.from({ length: 254 }, (_, i): LanAddress => ({
    ip: '192.168.1.' + (i + 1), status: 'free', hostname: null,
    devices: [], lease: null
  })) };
}
function arp(s: Inventory, host: number, mac: string): void {
  const row = s.results[host - 1];
  row.status = 'used';
  row.hostname = 'host-' + host;
  row.devices = [{ mac, vendor: '' }];
}
function conflict(s: Inventory, host: number): void {
  const row = s.results[host - 1];
  row.status = 'conflict';
  row.devices = [
    { mac: 'aa:bb:cc:dd:ee:01', vendor: '' },
    { mac: 'aa:bb:cc:dd:ee:02', vendor: '' }
  ];
}
function reserved(s: Inventory, host: number, mac: string): void {
  const row = s.results[host - 1];
  row.status = 'reserved';
  row.lease = {
    mac, hostname: 'reserved', type: 'static',
    description: 'DHCP-only', manufacturer: null
  };
}
function setup(send: NonNullable<NotificationOptions['send']>, options: Partial<NotificationOptions> = {}) {
  const db = new Database(':memory:');
  let timestamp = Date.UTC(2026, 9, 17, 10);
  const clock = () => timestamp;
  const detective = new NetworkDetective(db);
  const notifications = new NetworkNotifications(db, {
    enabled: true, proxyUrl: url, eventTypes: ['NEW_DEVICE', 'IP_CONFLICT'],
    cooldownMs: 60 * 60_000, now: clock, send, ...options
  });
  let scanIndex = 0;
  function scan(data: Inventory): number[] {
    const id = 'scan-' + scanIndex++;
    const date = new Date(timestamp).toISOString();
    return db.transaction(() => {
      const eventIds = detective.recordScan(data, date, id);
      notifications.enqueueEvents(eventIds);
      return eventIds;
    })();
  }
  return {
    db, detective, notifications, scan,
    advance(ms: number) { timestamp += ms; },
    cleanup() { db.close(); }
  };
}

test('loads exact internal OpenAPI contract with notifications disabled by default', () => {
  assert.deepEqual(loadNotificationOptions({}), {
    enabled: false, proxyUrl: url, eventTypes: ['NEW_DEVICE', 'IP_CONFLICT'],
    cooldownMs: 60 * 60_000
  });
  assert.equal(validateProxyUrl(url), true);
  for (const bad of [
    'https://example.invalid/send', 'http://api.ulnihnw.net/api/pushover/docs',
    'ftp://api.ulnihnw.net/api/pushover/send',
    'http://user:password@api.ulnihnw.net/api/pushover/send',
    'http://api.ulnihnw.net/api/pushover/send?token=secret'
  ]) assert.equal(validateProxyUrl(bad), false);
  const config = loadNotificationOptions({
    NETWORK_NOTIFICATIONS_ENABLED: 'true',
    NETWORK_NOTIFICATIONS_EVENT_TYPES: 'IP_CONFLICT,DEVICE_OFFLINE,BOGUS,IP_CONFLICT',
    NETWORK_NOTIFICATIONS_COOLDOWN_MINUTES: '30'
  });
  assert.deepEqual(config.eventTypes, ['IP_CONFLICT', 'DEVICE_OFFLINE']);
  assert.equal(config.cooldownMs, 1_800_000);
});

test('no baseline notification; sends exactly title and text to internal proxy for new ARP device', async () => {
  const calls: Array<{ url: string; title: string; text: string }> = [];
  const t = setup(async (endpoint, message) => {
    calls.push({ url: endpoint, ...message }); return 200;
  });
  try {
    t.scan(snapshot()); // silent baseline
    assert.equal(t.notifications.status().counts.pending, 0);
    const active = snapshot();
    arp(active, 20, 'AA:BB:CC:DD:EE:20');
    t.scan(active);
    assert.equal(t.notifications.status().counts.pending, 1);
    await t.notifications.flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, url);
    assert.equal(calls[0].title, 'Homelab Control – Ny enhet');
    assert.match(calls[0].text, /192\.168\.1\.20/);
    assert.match(calls[0].text, /aa:bb:cc:dd:ee:20/);
    assert.equal(t.notifications.history()[0].state, 'accepted');
    assert.equal(t.notifications.status().counts.accepted, 1);
    assert.equal(t.notifications.status().counts.pending, 0);
    t.scan(active);
    assert.equal(t.notifications.history().length, 1);
  } finally { t.cleanup(); }
});

test('DHCP-only new devices do not send; IP conflicts are prioritized', async () => {
  const calls: string[] = [];
  const t = setup(async (_endpoint, message) => {
    calls.push(message.title); return 200;
  });
  try {
    t.scan(snapshot());
    const next = snapshot();
    reserved(next, 8, 'aa:bb:cc:dd:ee:08');
    arp(next, 40, 'aa:bb:cc:dd:ee:40');
    conflict(next, 100);
    t.scan(next);
    assert.equal(t.notifications.status().counts.pending, 2); // conflict, ARP new device
    await t.notifications.flush();
    assert.equal(calls[0], 'Homelab Control – IP-konflikt');
    await t.notifications.flush();
    assert.equal(calls[1], 'Homelab Control – Ny enhet');
    assert.equal(t.notifications.history().length, 2);
  } finally { t.cleanup(); }
});

test('repeat conflicts within cooldown are suppressed, without a second POST', async () => {
  const calls: string[] = [];
  const t = setup(async (_, message) => { calls.push(message.title); return 200; });
  try {
    t.scan(snapshot());
    const c = snapshot();
    conflict(c, 25);
    t.scan(c);
    await t.notifications.flush();
    assert.equal(calls.length, 1);
    t.advance(15 * 60_000);
    t.scan(snapshot()); // conflict resolved
    t.advance(15 * 60_000);
    t.scan(c); // same IP conflict recurs during cooldown
    assert.deepEqual(t.notifications.history().map(x => x.state),
      ['suppressed', 'accepted']);
    assert.equal(t.notifications.history()[0].reason, 'cooldown');
    await t.notifications.flush();
    assert.equal(calls.length, 1);
    t.advance(61 * 60_000);
    t.scan(snapshot());
    t.scan(c);
    await t.notifications.flush();
    assert.equal(calls.length, 2);
  } finally { t.cleanup(); }
});

test('503 or network failure is retried; HTTP 422 fails permanently with no raw body', async () => {
  const calls: number[] = [];
  const t = setup(async () => { calls.push(1); return calls.length === 1 ? 503 : 200; });
  try {
    t.scan(snapshot());
    const s = snapshot();
    arp(s, 12, 'aa:bb:cc:dd:ee:12');
    t.scan(s);
    await t.notifications.flush();
    assert.equal(t.notifications.history()[0].state, 'retry');
    assert.equal(t.notifications.history()[0].reason, 'temporarily_unavailable');
    await t.notifications.flush(); // not due yet
    assert.equal(calls.length, 1);
    t.advance(61_000);
    await t.notifications.flush();
    assert.equal(calls.length, 2);
    assert.equal(t.notifications.history()[0].state, 'accepted');
    assert.equal(t.notifications.history()[0].attempts, 2);
  } finally { t.cleanup(); }

  const bad = setup(async () => 422);
  try {
    bad.scan(snapshot());
    const s = snapshot();
    arp(s, 15, 'aa:bb:cc:dd:ee:15');
    bad.scan(s);
    await bad.notifications.flush();
    assert.equal(bad.notifications.history()[0].state, 'failed');
    assert.equal(bad.notifications.history()[0].reason, 'invalid_message');
    assert.equal(bad.notifications.history()[0].nextAttemptAt, null);
  } finally { bad.cleanup(); }
});

test('rate limit sends at most three per ten minutes; additional eligible events remain queued', async () => {
  let requests = 0;
  const t = setup(async () => { requests++; return 200; });
  try {
    t.scan(snapshot());
    const s = snapshot();
    for (let n = 1; n <= 5; n++) arp(s, n, 'aa:bb:cc:dd:ee:0' + n);
    t.scan(s);
    for (let i = 0; i < 10; i++) await t.notifications.flush();
    assert.equal(requests, 3);
    assert.equal(t.notifications.status().counts.pending, 2);
    t.advance(11 * 60_000);
    await t.notifications.flush();
    assert.equal(requests, 4);
  } finally { t.cleanup(); }
});

test('outbox is atomic with scan and recovers outstanding attempts after restart', async () => {
  let requests = 0;
  const t = setup(async () => { requests++; return 200; });
  try {
    t.scan(snapshot());
    const s = snapshot();
    arp(s, 13, 'aa:bb:cc:dd:ee:13');
    t.scan(s);
    const before = t.notifications.history()[0];
    assert.equal(before.state, 'pending');
    assert.equal(before.attempts, 0);

    t.db.prepare("UPDATE network_notification_outbox SET state = 'sending' WHERE id = ?")
      .run(before.id);
    const restarted = new NetworkNotifications(t.db, {
      enabled: true, proxyUrl: url, cooldownMs: 3_600_000,
      eventTypes: ['NEW_DEVICE'], send: async () => { requests++; return 200; },
      now: () => Date.UTC(2026, 9, 17, 10)
    });
    assert.equal(restarted.history()[0].state, 'retry');
    await restarted.flush();
    assert.equal(requests, 1);
    assert.equal(restarted.history()[0].state, 'accepted');

    const existing = restarted.history().length;
    const ids = t.detective.listEvents(network).map(e => e.id);
    restarted.enqueueEvents(ids);
    assert.equal(restarted.history().length, existing);
  } finally { t.cleanup(); }
});

test('disabled notifications do not enqueue or make HTTP requests', async () => {
  let count = 0;
  const t = setup(async () => { count++; return 200; }, { enabled: false });
  try {
    t.scan(snapshot());
    const s = snapshot();
    arp(s, 25, 'aa:bb:cc:dd:ee:25');
    t.scan(s);
    assert.equal(t.notifications.status().state, 'disabled');
    assert.equal(t.notifications.history().length, 0);
    await t.notifications.flush();
    assert.equal(count, 0);
  } finally { t.cleanup(); }
});
