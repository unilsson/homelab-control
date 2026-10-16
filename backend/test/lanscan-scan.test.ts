import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { enqueueLanScan, getLanScanInfo } from '../src/integrations/lanscan-scan.js';

test('Scan now is disabled until a live host-side worker is present', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'homelab-lan-scan-unavailable-'));
  try {
    const initial = await getLanScanInfo(dir);
    assert.equal(initial.state, 'unavailable');
    assert.equal(initial.available, false);
    const request = await enqueueLanScan(dir);
    assert.equal(request.httpStatus, 503);

    const heartbeat = join(dir, 'lanscan-worker-heartbeat');
    writeFileSync(heartbeat, '');
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(heartbeat, old, old);
    assert.equal((await getLanScanInfo(dir)).available, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Scan now queues one bounded host request, reports progress and rate-limits retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'homelab-lan-scan-request-'));
  try {
    writeFileSync(join(dir, 'lanscan-worker-heartbeat'), '');
    const [first, parallel] = await Promise.all([enqueueLanScan(dir), enqueueLanScan(dir)]);
    assert.equal(first.httpStatus, 202);
    assert.equal(first.scan.state, 'queued');
    assert.equal(parallel.httpStatus, 409);
    assert.equal(parallel.scan.state, 'queued');
    const requestPath = join(dir, 'lanscan-request.json');
    const req = JSON.parse(readFileSync(requestPath, 'utf8')) as { id: string; requestedAt: string };
    assert.match(req.id, /^[0-9a-f-]{36}$/i);
    assert.ok(Date.parse(req.requestedAt));
    const queued = await getLanScanInfo(dir);
    assert.equal(queued.state, 'queued');

    const statusPath = join(dir, 'lanscan-status.json');
    const status = {
      requestId: req.id, requestedAt: req.requestedAt,
      state: 'running', startedAt: new Date().toISOString(), finishedAt: null as string | null
    };
    writeFileSync(statusPath, JSON.stringify(status));
    const running = await getLanScanInfo(dir);
    assert.equal(running.state, 'running');
    assert.equal((await enqueueLanScan(dir)).httpStatus, 409);

    status.state = 'completed';
    status.finishedAt = new Date().toISOString();
    writeFileSync(statusPath, JSON.stringify(status));
    unlinkSync(requestPath); // The host worker removes the processed request marker.
    const completed = await getLanScanInfo(dir);
    assert.equal(completed.state, 'completed');
    assert.equal(completed.requestedAt, req.requestedAt);
    const tooSoon = await enqueueLanScan(dir);
    assert.equal(tooSoon.httpStatus, 429);
    assert.match(tooSoon.scan.message ?? '', /90 seconds/);

    status.requestedAt = new Date(Date.now() - 95_000).toISOString();
    writeFileSync(statusPath, JSON.stringify(status));
    const next = await enqueueLanScan(dir);
    assert.equal(next.httpStatus, 202);
    assert.equal((await getLanScanInfo(dir)).state, 'queued');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('A stalled worker or unprocessed queue is reported as failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'homelab-lan-scan-stall-'));
  try {
    writeFileSync(join(dir, 'lanscan-worker-heartbeat'), '');
    const response = await enqueueLanScan(dir);
    assert.equal(response.httpStatus, 202);
    const requestPath = join(dir, 'lanscan-request.json');
    const request = JSON.parse(readFileSync(requestPath, 'utf8')) as { id: string; requestedAt: string };
    request.requestedAt = new Date(Date.now() - 5 * 60_000).toISOString();
    writeFileSync(requestPath, JSON.stringify(request));
    const queuedExpired = await getLanScanInfo(dir);
    assert.equal(queuedExpired.state, 'failed');
    assert.match(queuedExpired.message ?? '', /not processed/);

    const status = {
      requestId: request.id, requestedAt: request.requestedAt,
      state: 'running', startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      finishedAt: null
    };
    writeFileSync(join(dir, 'lanscan-status.json'), JSON.stringify(status));
    const stalled = await getLanScanInfo(dir);
    assert.equal(stalled.state, 'failed');
    assert.match(stalled.message ?? '', /took too long/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
