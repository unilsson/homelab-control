import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { NetworkDetective } from '../src/network-detective.js';
import type { LanInventory } from '../src/integrations/lanscan.js';
import {
  NetworkNotifications, loadNotificationOptions, loadDiscordNotificationOptions,
  sendToInternalDiscordProxy, validateProxyUrl
} from '../src/network-notifications.js';

const network = '192.168.1.0/24';
const pushoverUrl = 'http://api.ulnihnw.net/api/pushover/send';
const discordUrl = 'http://api.ulnihnw.net/api/discord/send';

function snapshot(host = 0): Pick<LanInventory, 'network' | 'results'> {
  if (host === 0) return { network, results: [] };
  const part = String(host).padStart(2, '0');
  return {
    network,
    results: [{
      ip: '192.168.1.' + host, status: 'used', hostname: 'device-' + host,
      lease: null, devices: [{ mac: 'aa:bb:cc:dd:ee:' + part, vendor: 'Demo' }]
    }]
  };
}

test('Discord is opt-in and its URL is validated independently from Pushover', () => {
  assert.deepEqual(loadDiscordNotificationOptions({}), {
    channel: 'discord', enabled: false,
    proxyUrl: discordUrl, eventTypes: ['NEW_DEVICE', 'IP_CONFLICT'],
    cooldownMs: 3_600_000
  });
  assert.equal(validateProxyUrl(pushoverUrl), true);
  assert.equal(validateProxyUrl(discordUrl), false);
  assert.equal(validateProxyUrl(discordUrl, 'discord'), true);
  assert.equal(validateProxyUrl('https://discord.com/api/webhooks/1/SECRET', 'discord'), false);
  const configured = loadDiscordNotificationOptions({
    NETWORK_DISCORD_NOTIFICATIONS_ENABLED: 'true',
    NETWORK_DISCORD_NOTIFICATIONS_EVENT_TYPES: 'IP_CONFLICT,DEVICE_OFFLINE,BOGUS',
    NETWORK_DISCORD_NOTIFICATIONS_COOLDOWN_MINUTES: '15'
  });
  assert.equal(configured.enabled, true);
  assert.deepEqual(configured.eventTypes, ['IP_CONFLICT', 'DEVICE_OFFLINE']);
  assert.equal(configured.cooldownMs, 900_000);
});

test('Discord proxy transport sends JSON text only, never Discord webhook credentials', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.equal(url, discordUrl);
    assert.equal(init?.method, 'POST');
    assert.equal(init?.redirect, 'error');
    assert.deepEqual(JSON.parse(String(init?.body)), {
      text: 'Homelab Control – Ny enhet\nHändelse: Ny enhet'
    });
    return new Response('{}', { status: 200 });
  };
  try {
    const code = await sendToInternalDiscordProxy(discordUrl, {
      title: 'Homelab Control – Ny enhet', text: 'Händelse: Ny enhet'
    });
    assert.equal(code, 200);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('both channels independently enqueue, send, retry and persist their own histories', async () => {
  const db = new Database(':memory:');
  let now = Date.UTC(2026, 9, 18, 10);
  let pushoverCalls = 0;
  let discordCalls = 0;
  const detective = new NetworkDetective(db);
  const pushover = new NetworkNotifications(db, {
    ...loadNotificationOptions({ NETWORK_NOTIFICATIONS_ENABLED: 'true' }),
    now: () => now,
    send: async (url, message) => {
      pushoverCalls++;
      assert.equal(url, pushoverUrl);
      assert.match(message.text, /192\.168\.1\.21/);
      return 200;
    }
  });
  const discord = new NetworkNotifications(db, {
    ...loadDiscordNotificationOptions({ NETWORK_DISCORD_NOTIFICATIONS_ENABLED: 'true' }),
    now: () => now,
    send: async (url, message) => {
      discordCalls++;
      assert.equal(url, discordUrl);
      assert.match(message.title, /Ny enhet/);
      return discordCalls === 1 ? 503 : 200;
    }
  });
  let scanId = 0;
  function scan(host: number): void {
    db.transaction(() => {
      const newEvents = detective.recordScan(snapshot(host), new Date(now).toISOString(), String(scanId++));
      pushover.enqueueEvents(newEvents);
      discord.enqueueEvents(newEvents);
    })();
  }
  try {
    scan(0); // initial baseline creates no events or messages
    assert.equal(pushover.history().length, 0);
    assert.equal(discord.history().length, 0);

    scan(21);
    assert.equal(pushover.status().counts.pending, 1);
    assert.equal(discord.status().counts.pending, 1);
    assert.equal(pushover.status().provider, 'internal_pushover_proxy');
    assert.equal(discord.status().provider, 'internal_discord_proxy');

    await Promise.all([pushover.flush(), discord.flush()]);
    assert.equal(pushoverCalls, 1);
    assert.equal(discordCalls, 1);
    assert.equal(pushover.history()[0].state, 'accepted');
    assert.equal(discord.history()[0].state, 'retry');
    assert.equal(discord.history()[0].reason, 'temporarily_unavailable');

    now += 61_000;
    await discord.flush();
    assert.equal(discordCalls, 2);
    assert.equal(discord.history()[0].state, 'accepted');
    assert.equal(pushover.history()[0].attempts, 1);

    // Same scan identity is idempotent, including both outboxes.
    db.transaction(() => {
      const unchanged = detective.recordScan(snapshot(21), new Date(now).toISOString(), String(scanId - 1));
      pushover.enqueueEvents(unchanged);
      discord.enqueueEvents(unchanged);
    })();
    assert.equal(pushover.history().length, 1);
    assert.equal(discord.history().length, 1);
  } finally {
    db.close();
  }
});

test('Discord-only configuration does not enable Pushover', async () => {
  const db = new Database(':memory:');
  const detective = new NetworkDetective(db);
  let delivered = 0;
  const pushover = new NetworkNotifications(db, loadNotificationOptions({}));
  const discord = new NetworkNotifications(db, {
    ...loadDiscordNotificationOptions({ NETWORK_DISCORD_NOTIFICATIONS_ENABLED: 'true' }),
    send: async () => { delivered++; return 200; }
  });
  try {
    detective.recordScan(snapshot(0), '2026-10-18T10:00:00Z', 'baseline');
    const ids = detective.recordScan(snapshot(11), '2026-10-18T10:15:00Z', 'second');
    pushover.enqueueEvents(ids);
    discord.enqueueEvents(ids);
    await Promise.all([pushover.flush(), discord.flush()]);
    assert.equal(pushover.status().state, 'disabled');
    assert.equal(pushover.history().length, 0);
    assert.equal(discord.history().length, 1);
    assert.equal(discord.history()[0].state, 'accepted');
    assert.equal(delivered, 1);
  } finally {
    db.close();
  }
});

test('transaction rolls back scan, Pushover and Discord if Discord enqueue fails', () => {
  const db = new Database(':memory:');
  const detective = new NetworkDetective(db);
  const push = new NetworkNotifications(db, {
    ...loadNotificationOptions({ NETWORK_NOTIFICATIONS_ENABLED: 'true' })
  });
  const discord = new NetworkNotifications(db, {
    ...loadDiscordNotificationOptions({ NETWORK_DISCORD_NOTIFICATIONS_ENABLED: 'true' })
  });
  try {
    db.transaction(() => {
      const ids = detective.recordScan(snapshot(0), '2026-10-18T10:00:00Z', 'baseline');
      push.enqueueEvents(ids);
      discord.enqueueEvents(ids);
    })();
    db.exec(`CREATE TRIGGER reject_discord BEFORE INSERT ON network_discord_notification_outbox
      BEGIN SELECT RAISE(FAIL, 'reject'); END;`);
    assert.throws(() => db.transaction(() => {
      const ids = detective.recordScan(snapshot(31), '2026-10-18T10:15:00Z', 'second');
      push.enqueueEvents(ids);
      discord.enqueueEvents(ids);
    })(), /reject/);
    assert.equal(detective.summary(network).events, 0);
    assert.equal(detective.summary(network).totalDevices, 0);
    assert.equal(push.history().length, 0);
    assert.equal(discord.history().length, 0);
  } finally { db.close(); }
});

test('existing Pushover records survive initialization of the Discord channel', async () => {
  const db = new Database(':memory:');
  const detective = new NetworkDetective(db);
  try {
    const push = new NetworkNotifications(db, {
      ...loadNotificationOptions({ NETWORK_NOTIFICATIONS_ENABLED: 'true' }),
      send: async () => 200
    });
    detective.recordScan(snapshot(0), '2026-10-18T10:00:00Z', 'one');
    push.enqueueEvents(detective.recordScan(snapshot(41), '2026-10-18T10:15:00Z', 'two'));
    await push.flush();
    assert.equal(push.status().counts.accepted, 1);
    const discord = new NetworkNotifications(db, loadDiscordNotificationOptions({}));
    assert.equal(discord.history().length, 0);
    assert.equal(push.history().length, 1);
    assert.equal(push.status().counts.accepted, 1);
  } finally { db.close(); }
});
