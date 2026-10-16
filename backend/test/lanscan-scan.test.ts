import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LanScanner } from '../src/integrations/lanscan-scan.js';
import type { DhcpLease } from '../src/integrations/opnsense.js';

function validDocument(): { schema_version: number; results: Array<Record<string, unknown>> } {
  return {
    schema_version: 1,
    results: Array.from({ length: 254 }, (_, index) => ({
      ip: `192.168.1.${index + 1}`,
      status: 'free',
      hostname: null,
      devices: []
    }))
  };
}

function setup(execute: (binary: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>, enabled = true,
  getOpnsenseLeases: () => Promise<DhcpLease[]> = async () => []) {
  const dir = mkdtempSync(join(tmpdir(), 'homelab-lan-direct-scan-'));
  const snapshot = join(dir, 'lanscan.json');
  let tick = Date.now();
  const scanner = new LanScanner({
    enabled,
    network: '192.168.1.0/24',
    snapshotPath: snapshot,
    command: '/opt/lanscan/bin/lanscan',
    withOpnsense: true,
    getOpnsenseLeases,
    execute,
    now: () => tick
  });
  return {
    scanner, snapshot,
    clock: (delta: number) => { tick += delta; },
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

async function waitForState(scanner: LanScanner, expected: 'completed' | 'failed'): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (scanner.info().state === expected) return;
    await new Promise<void>(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Scan did not reach ' + expected + '. Current state: ' + scanner.info().state);
}

test('direct Scan now runs fixed lanscan command and writes validated snapshot', async () => {
  const calls: Array<{ binary: string; args: string[]; options: { timeout: number; maxBuffer: number } }> = [];
  const t = setup(async (binary, args, options) => {
    calls.push({ binary, args, options });
    return { stdout: JSON.stringify(validDocument()) };
  });
  try {
    const first = t.scanner.requestScan();
    assert.equal(first.httpStatus, 202);
    assert.equal(first.scan.state, 'running');
    await waitForState(t.scanner, 'completed');
    assert.equal(t.scanner.info().state, 'completed');
    const snapshot = JSON.parse(readFileSync(t.snapshot, 'utf8')) as { results: unknown[] };
    assert.equal(snapshot.results.length, 254);
    assert.deepEqual(calls, [{
      binary: '/opt/lanscan/bin/lanscan',
      args: ['192.168.1.0/24', '--all', '--json'],
      options: { timeout: 150_000, maxBuffer: 4_000_000 }
    }]);
    const limited = t.scanner.requestScan();
    assert.equal(limited.httpStatus, 429);
    assert.match(limited.scan.message ?? '', /90 seconds/);
    t.clock(91_000);
    assert.equal(t.scanner.requestScan().httpStatus, 202);
    await waitForState(t.scanner, 'completed');
  } finally {
    t.cleanup();
  }
});

test('concurrent requests are rejected, without starting duplicate scans', async () => {
  let release: ((value: { stdout: string }) => void) | null = null;
  let calls = 0;
  const t = setup(() => {
    calls += 1;
    return new Promise(resolve => { release = resolve; });
  });
  try {
    assert.equal(t.scanner.requestScan().httpStatus, 202);
    assert.equal(t.scanner.requestScan().httpStatus, 409);
    assert.equal(calls, 1);
    assert.ok(release);
    (release as unknown as (value: { stdout: string }) => void)({ stdout: JSON.stringify(validDocument()) });
    await waitForState(t.scanner, 'completed');
    assert.equal(calls, 1);
  } finally {
    t.cleanup();
  }
});

test('Infisical-backed OPNsense failure prevents overwriting known reservations as FREE', async () => {
  let failDhcp = false;
  let calls = 0;
  const t = setup(async () => ({ stdout: JSON.stringify(validDocument()) }), true, async () => {
    calls++;
    if (failDhcp) throw new Error('OPNsense token unavailable - sensitive details');
    return [{
      ip: '192.168.1.254', mac: 'aa:bb:cc:dd:ee:ff', hostname: 'reserved-printer',
      interface: 'LAN', state: 'active', starts: null, ends: null, type: 'static',
      status: null, description: 'Printer', manufacturer: null, isStatic: true
    }];
  });
  try {
    assert.equal(t.scanner.requestScan().httpStatus, 202);
    await waitForState(t.scanner, 'completed');
    let document = JSON.parse(readFileSync(t.snapshot, 'utf8')) as {
      results: Array<{ ip: string; status: string }>
    };
    assert.equal(document.results.find(r => r.ip === '192.168.1.254')?.status, 'reserved');
    const preserved = readFileSync(t.snapshot, 'utf8');
    failDhcp = true;
    t.clock(91_000);
    assert.equal(t.scanner.requestScan().httpStatus, 202);
    await waitForState(t.scanner, 'failed');
    assert.equal(readFileSync(t.snapshot, 'utf8'), preserved);
    assert.equal(calls, 2);
    assert.ok(!JSON.stringify(t.scanner.info()).includes('sensitive details'));
    document = JSON.parse(readFileSync(t.snapshot, 'utf8')) as {
      results: Array<{ ip: string; status: string }>
    };
    assert.equal(document.results.find(r => r.ip === '192.168.1.254')?.status, 'reserved');
  } finally {
    t.cleanup();
  }
});

test('invalid JSON, incomplete scans and CLI failures preserve last successful snapshot', async () => {
  let result: string | null = JSON.stringify(validDocument());
  const t = setup(async () => {
    if (result === null) throw new Error('ARP scan failed');
    return { stdout: result };
  });
  try {
    t.scanner.requestScan();
    await waitForState(t.scanner, 'completed');
    const before = readFileSync(t.snapshot, 'utf8');

    result = '{not-json';
    t.clock(91_000);
    t.scanner.requestScan();
    await waitForState(t.scanner, 'failed');
    assert.equal(readFileSync(t.snapshot, 'utf8'), before);
    assert.match(t.scanner.info().message ?? '', /Previous results are preserved/);

    result = JSON.stringify({ schema_version: 1, results: [{ ip: '192.168.1.1', status: 'free', devices: [] }] });
    t.clock(91_000);
    t.scanner.requestScan();
    await waitForState(t.scanner, 'failed');
    assert.equal(readFileSync(t.snapshot, 'utf8'), before);

    result = null;
    t.clock(91_000);
    t.scanner.requestScan();
    await waitForState(t.scanner, 'failed');
    assert.equal(readFileSync(t.snapshot, 'utf8'), before);
  } finally {
    t.cleanup();
  }
});

test('scanner can be disabled without executing CLI', () => {
  const t = setup(async () => { throw new Error('Must not be called'); }, false);
  try {
    assert.equal(t.scanner.info().state, 'unavailable');
    assert.equal(t.scanner.info().available, false);
    assert.equal(t.scanner.requestScan().httpStatus, 503);
  } finally {
    t.cleanup();
  }
});

test('scanner rejects invalid network configuration before executing a command', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'homelab-lan-bad-network-'));
  let calls = 0;
  const scanner = new LanScanner({
    enabled: true, network: '8.8.8.8/24',
    snapshotPath: join(dir, 'lanscan.json'),
    command: '/opt/lanscan/bin/lanscan', withOpnsense: false,
    getOpnsenseLeases: async () => [],
    execute: async () => { calls++; return { stdout: '{}' }; },
    now: Date.now
  });
  try {
    assert.equal(scanner.requestScan().httpStatus, 202);
    await waitForState(scanner, 'failed');
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
