import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { NetworkDetective, normalizeMac } from '../src/network-detective.js';
import type { LanAddress, LanInventory } from '../src/integrations/lanscan.js';

const network = '192.168.1.0/24';
type Inventory = Pick<LanInventory, 'network' | 'results'>;

function inventory(): Inventory {
  return {
    network,
    results: Array.from({ length: 254 }, (_, i): LanAddress => ({
      ip: '192.168.1.' + (i + 1), status: 'free', hostname: null,
      devices: [], lease: null
    }))
  };
}

function host(data: Inventory, ip: number, mac: string, hostname = 'host'): void {
  const row = data.results[ip - 1];
  row.status = 'used';
  row.hostname = hostname;
  row.devices = [{ mac, vendor: 'test-vendor' }];
}

function conflict(data: Inventory, ip: number, ...macs: string[]): void {
  const row = data.results[ip - 1];
  row.status = 'conflict';
  row.devices = macs.map(mac => ({ mac, vendor: '' }));
}

function reserve(data: Inventory, ip: number, mac: string, type = 'static'): void {
  const row = data.results[ip - 1];
  row.status = 'reserved';
  row.lease = {
    mac, hostname: 'reserved-host', description: 'Static host',
    manufacturer: null, type
  };
}

function scan(engine: NetworkDetective, data: Inventory, n: number): void {
  engine.recordScan(data, new Date(Date.UTC(2026, 9, 17, 10, n)).toISOString(), 'scan-' + n);
}

test('initial complete scan creates persistent baseline without alert storm; repeat scan is idempotent', () => {
  const store = new Database(':memory:');
  try {
    const detective = new NetworkDetective(store);
    const first = inventory();
    host(first, 10, 'AA-BB-CC-DD-EE-01');
    reserve(first, 20, 'aa:bb:cc:dd:ee:20');
    scan(detective, first, 0);
    assert.deepEqual(detective.summary(network), {
      network, scans: 1, lastScannedAt: '2026-10-17T10:00:00.000Z',
      totalDevices: 2, online: 1, offline: 0, known: 1, events: 0
    });
    assert.equal(detective.listDevices(network).find(d => d.mac.endsWith('20'))?.state, 'known');
    assert.equal(detective.listDevices(network).find(d => d.mac.endsWith('01'))?.state, 'online');
    scan(detective, first, 0);
    assert.equal(detective.summary(network).scans, 1);
    assert.equal(detective.listEvents(network).length, 0);

    // Reinitialize with the same store: existing rows and history remain.
    const restarted = new NetworkDetective(store);
    scan(restarted, first, 1);
    assert.equal(restarted.summary(network).scans, 2);
    assert.equal(restarted.listDevices(network).length, 2);
    assert.equal(restarted.listEvents(network).length, 0);
  } finally { store.close(); }
});

test('new hosts, IP changes and MAC replacements are recorded once', () => {
  const store = new Database(':memory:');
  try {
    const detective = new NetworkDetective(store);
    const one = inventory();
    host(one, 10, 'aa:bb:cc:dd:ee:01');
    scan(detective, one, 0);

    const two = inventory();
    host(two, 11, 'aa:bb:cc:dd:ee:01'); // moved IP
    host(two, 15, 'aa:bb:cc:dd:ee:02'); // new device
    scan(detective, two, 1);
    assert.deepEqual(detective.listEvents(network).map(e => e.type).sort(),
      ['IP_CHANGED', 'NEW_DEVICE']);

    const three = inventory();
    host(three, 11, 'aa:bb:cc:dd:ee:03'); // different MAC at former IP
    host(three, 15, 'aa:bb:cc:dd:ee:02');
    scan(detective, three, 2);
    assert.equal(detective.listEvents(network).filter(e => e.type === 'MAC_CHANGED').length, 1);
    assert.equal(detective.listEvents(network).filter(e => e.type === 'NEW_DEVICE').length, 2);
    assert.equal(detective.listDevices(network).length, 3);
    assert.equal(detective.listEvents(network, 1).length, 1);
    assert.deepEqual(detective.listEvents(network, 100, 'aa:bb:cc:dd:ee:02')
      .map(e => e.type), ['NEW_DEVICE']);
    assert.equal(normalizeMac('AA-BB-CC-DD-EE-01'), 'aa:bb:cc:dd:ee:01');
    assert.equal(normalizeMac('oops'), null);
  } finally { store.close(); }
});

test('offline requires two successful misses; repeated misses do not alert; return emits online', () => {
  const store = new Database(':memory:');
  try {
    const detective = new NetworkDetective(store);
    const live = inventory();
    host(live, 10, 'aa:bb:cc:dd:ee:01');
    scan(detective, live, 0);
    const empty = inventory();
    scan(detective, empty, 1);
    assert.equal(detective.summary(network).online, 1);
    assert.equal(detective.listEvents(network).length, 0);
    scan(detective, empty, 2);
    assert.equal(detective.summary(network).offline, 1);
    assert.deepEqual(detective.listEvents(network).map(e => e.type), ['DEVICE_OFFLINE']);
    scan(detective, empty, 3);
    assert.equal(detective.listEvents(network).length, 1);
    scan(detective, live, 4);
    assert.equal(detective.summary(network).online, 1);
    assert.deepEqual(detective.listEvents(network).map(e => e.type),
      ['DEVICE_ONLINE', 'DEVICE_OFFLINE']);
  } finally { store.close(); }
});

test('a DHCP reservation is not counted online and never generates false offline events', () => {
  const store = new Database(':memory:');
  try {
    const detective = new NetworkDetective(store);
    const reserved = inventory();
    reserve(reserved, 40, 'aa:bb:cc:dd:ee:40');
    scan(detective, reserved, 0);
    scan(detective, inventory(), 1);
    scan(detective, inventory(), 2);
    assert.equal(detective.summary(network).known, 1);
    assert.equal(detective.summary(network).offline, 0);
    assert.ok(!detective.listEvents(network).some(e => e.type === 'DEVICE_OFFLINE'));
  } finally { store.close(); }
});

test('one conflict event on onset, one resolution event, and DHCP changes without duplicate scans', () => {
  const store = new Database(':memory:');
  try {
    const detective = new NetworkDetective(store);
    const one = inventory();
    host(one, 10, 'aa:bb:cc:dd:ee:01');
    reserve(one, 20, 'aa:bb:cc:dd:ee:20');
    scan(detective, one, 0);

    const two = inventory();
    conflict(two, 10, 'aa:bb:cc:dd:ee:01', 'aa:bb:cc:dd:ee:02');
    reserve(two, 20, 'aa:bb:cc:dd:ee:21');
    scan(detective, two, 1);
    assert.equal(detective.listEvents(network).filter(e => e.type === 'IP_CONFLICT').length, 1);
    assert.equal(detective.listEvents(network).filter(e => e.type === 'DHCP_CHANGED').length, 1);
    scan(detective, two, 2);
    assert.equal(detective.listEvents(network).filter(e => e.type === 'IP_CONFLICT').length, 1);

    const three = inventory();
    host(three, 10, 'aa:bb:cc:dd:ee:01');
    reserve(three, 20, 'aa:bb:cc:dd:ee:21');
    scan(detective, three, 3);
    assert.equal(detective.listEvents(network).filter(e => e.type === 'CONFLICT_RESOLVED').length, 1);
  } finally { store.close(); }
});

test('all changes roll back on SQLite failure, including the scanned-state counter', () => {
  const store = new Database(':memory:');
  try {
    const detective = new NetworkDetective(store);
    const one = inventory();
    host(one, 10, 'aa:bb:cc:dd:ee:01');
    scan(detective, one, 0);
    store.exec(`CREATE TRIGGER force_event_failure BEFORE INSERT ON network_events
      BEGIN SELECT RAISE(FAIL, 'test-trigger'); END`);
    const two = inventory();
    host(two, 10, 'aa:bb:cc:dd:ee:01');
    host(two, 11, 'aa:bb:cc:dd:ee:02');
    assert.throws(() => scan(detective, two, 1), /test-trigger/);
    assert.equal(detective.summary(network).scans, 1);
    assert.equal(detective.listDevices(network).length, 1);
    assert.equal(detective.listEvents(network).length, 0);
  } finally { store.close(); }
});
