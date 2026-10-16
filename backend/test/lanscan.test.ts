import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseLanSnapshot, readLanInventory } from '../src/integrations/lanscan.js';

function sample(): { schema_version: number; results: Array<Record<string, unknown>> } {
  const results: Array<Record<string, unknown>> = [];
  for (let host = 254; host >= 1; host--) {
    const row: Record<string, unknown> = {
      ip: '192.168.1.' + host, status: 'free', hostname: null, devices: [], lease: null
    };
    if (host === 1) {
      row.status = 'used';
      row.hostname = 'opnsense.ulnihnw.net';
      row.devices = [{ mac: '20:7c:14:00:00:01', vendor: 'Firewall' }];
    } else if (host === 2) {
      row.status = 'conflict';
      row.devices = [
        { mac: 'aa:bb:cc:dd:ee:01', vendor: 'Test 1' },
        { mac: 'aa:bb:cc:dd:ee:02', vendor: 'Test 2' }
      ];
    } else if (host === 3) {
      row.status = 'leased';
      row.lease = { mac: 'aa:bb:cc:dd:ee:03', hostname: 'laptop', type: 'dynamic', description: null, manufacturer: null };
    } else if (host === 4) {
      row.status = 'reserved';
      row.lease = { mac: 'aa:bb:cc:dd:ee:04', hostname: 'printer', type: 'static', description: 'Office printer', manufacturer: 'Printer' };
    }
    results.push(row);
  }
  return { schema_version: 1, results };
}

test('lanscan --all JSON contains all 254 host IPs and counts each status', () => {
  const inventory = parseLanSnapshot(sample(), '192.168.1.0/24');
  assert.equal(inventory.results.length, 254);
  assert.equal(inventory.results[0].ip, '192.168.1.1');
  assert.equal(inventory.results[253].ip, '192.168.1.254');
  assert.deepEqual(inventory.summary, {
    total: 254, occupied: 4, used: 1, free: 250,
    leased: 1, reserved: 1, conflicts: 1
  });
  assert.equal(inventory.results[3].lease?.description, 'Office printer');
  assert.equal(inventory.results[1].devices.length, 2);
});

test('rejects partial, duplicate, out-of-subnet, unknown status and wrong schema snapshots', () => {
  const partial = sample();
  partial.results.pop();
  assert.throws(() => parseLanSnapshot(partial, '192.168.1.0/24'), /incomplete/);
  const duplicate = sample();
  duplicate.results[1].ip = duplicate.results[0].ip;
  assert.throws(() => parseLanSnapshot(duplicate, '192.168.1.0/24'), /Duplicate/);
  const outside = sample();
  outside.results[1].ip = '10.0.0.50';
  assert.throws(() => parseLanSnapshot(outside, '192.168.1.0/24'), /out-of-network/);
  const badState = sample();
  badState.results[1].status = 'not-a-real-status';
  assert.throws(() => parseLanSnapshot(badState, '192.168.1.0/24'), /Invalid/);
  const oldSchema = sample();
  oldSchema.schema_version = 2;
  assert.throws(() => parseLanSnapshot(oldSchema, '192.168.1.0/24'), /Unsupported/);
  assert.throws(() => parseLanSnapshot(sample(), '192.168.1.3/24'), /network address/);
});

test('missing, stale and corrupt LAN snapshots are reported without breaking the API', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'homelab-lanscan-'));
  const path = join(tempDir, 'lanscan.json');
  try {
    const missing = await readLanInventory(path, '192.168.1.0/24');
    assert.equal(missing.state, 'missing');
    assert.deepEqual(missing.results, []);

    writeFileSync(path, JSON.stringify(sample()));
    const fresh = await readLanInventory(path, '192.168.1.0/24');
    assert.equal(fresh.state, 'online');
    assert.equal(fresh.summary?.total, 254);
    assert.ok(fresh.scannedAt);

    const old = new Date(Date.now() - 60 * 60 * 1000);
    utimesSync(path, old, old);
    const stale = await readLanInventory(path, '192.168.1.0/24');
    assert.equal(stale.state, 'stale');
    assert.equal(stale.results.length, 254);

    writeFileSync(path, '{ invalid JSON');
    const invalid = await readLanInventory(path, '192.168.1.0/24');
    assert.equal(invalid.state, 'error');
    assert.deepEqual(invalid.results, []);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
