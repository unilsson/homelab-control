import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type ScanState = 'unavailable' | 'idle' | 'queued' | 'running' | 'completed' | 'failed';
export type LanScanInfo = {
  state: ScanState;
  available: boolean;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  message?: string;
};

type ScanRequest = { id: string; requestedAt: string };
type WorkerStatus = {
  requestId: string | null;
  state: 'running' | 'completed' | 'failed';
  startedAt: string;
  requestedAt: string | null;
  finishedAt: string | null;
};

const heartbeatMaxAge = 180_000; // Worker runs once per minute.
const inProgressMaxAge = 240_000; // Worker scan timeout is 150 seconds.
const manualCooldown = 90_000;

export function scanDataDir(): string {
  return dirname(process.env.LANSCAN_SNAPSHOT_FILE?.trim() || '/app/data/lanscan.json');
}

function paths(dir: string) {
  return {
    heartbeat: join(dir, 'lanscan-worker-heartbeat'),
    request: join(dir, 'lanscan-request.json'),
    status: join(dir, 'lanscan-status.json')
  };
}

async function jsonFile(path: string): Promise<unknown | null> {
  try {
    const value = await readFile(path, 'utf8');
    if (value.length > 4096) return null;
    return JSON.parse(value) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

function validTime(time: unknown): time is string {
  return typeof time === 'string' && Number.isFinite(Date.parse(time));
}

function parseRequest(value: unknown): ScanRequest | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(v.id) || !validTime(v.requestedAt)) return null;
  return { id: v.id, requestedAt: v.requestedAt };
}

function parseStatus(value: unknown): WorkerStatus | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (v.requestId !== null && (typeof v.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(v.requestId))) return null;
  if (v.state !== 'running' && v.state !== 'completed' && v.state !== 'failed') return null;
  if (!validTime(v.startedAt) || (v.requestedAt !== null && !validTime(v.requestedAt)) ||
      (v.finishedAt !== null && !validTime(v.finishedAt))) return null;
  return {
    requestId: v.requestId as string | null,
    state: v.state,
    startedAt: v.startedAt,
    requestedAt: v.requestedAt as string | null,
    finishedAt: v.finishedAt as string | null
  };
}

export async function getLanScanInfo(dir = scanDataDir()): Promise<LanScanInfo> {
  const file = paths(dir);
  const [heartbeat, rawRequest, rawStatus] = await Promise.all([
    stat(file.heartbeat).catch(() => null),
    jsonFile(file.request),
    jsonFile(file.status)
  ]);
  const available = Boolean(heartbeat?.isFile() && (Date.now() - heartbeat.mtimeMs < heartbeatMaxAge));
  const request = parseRequest(rawRequest);
  const status = parseStatus(rawStatus);
  const base = {
    available,
    requestedAt: request?.requestedAt ?? status?.requestedAt ?? null,
    startedAt: status?.startedAt ?? null,
    finishedAt: status?.finishedAt ?? null
  };
  if (status?.state === 'running' && Date.now() - Date.parse(status.startedAt) < inProgressMaxAge) {
    return { ...base, state: 'running', requestedAt: status.requestId === request?.id ? request.requestedAt : base.requestedAt };
  }
  if (request && (!status || status.requestId !== request.id) &&
      Date.now() - Date.parse(request.requestedAt) < inProgressMaxAge) {
    return { ...base, state: 'queued', requestedAt: request.requestedAt };
  }
  if (request && (!status || status.requestId !== request.id)) {
    return { ...base, state: 'failed', message: 'Scan request was not processed. Check the host scanner timer.' };
  }
  if (status?.state === 'running') {
    return { ...base, state: 'failed', message: 'Scan took too long. Check the host scanner log.' };
  }
  if (status?.state === 'failed') {
    return { ...base, state: 'failed', message: 'Host-side scan failed. Check the host scanner log.' };
  }
  if (status?.state === 'completed') return { ...base, state: 'completed' };
  return available
    ? { ...base, state: 'idle' }
    : { ...base, state: 'unavailable', message: 'Host scanner not active. Enable the homelab-lanscan user timer.' };
}

export type ScanRequestResponse = { httpStatus: 202 | 409 | 429 | 503; scan: LanScanInfo };

// Requests only write a fixed-size marker. The backend never executes a command.
let requestChain: Promise<void> = Promise.resolve();
export function enqueueLanScan(dir = scanDataDir()): Promise<ScanRequestResponse> {
  const work = requestChain.then(async (): Promise<ScanRequestResponse> => {
    const info = await getLanScanInfo(dir);
    if (!info.available) return { httpStatus: 503, scan: info };
    if (info.state === 'running' || info.state === 'queued') {
      return { httpStatus: 409, scan: info };
    }
    // Keep a cooldown even if a scan fails, to prevent repeated probing of the LAN.
    const existing = parseRequest(await jsonFile(paths(dir).request));
    const lastRequest = existing?.requestedAt ?? info.requestedAt;
    if (lastRequest && Date.now() - Date.parse(lastRequest) < manualCooldown) {
      return { httpStatus: 429, scan: { ...info, message: 'Wait at least 90 seconds between manual scans.' } };
    }

    const request: ScanRequest = { id: randomUUID(), requestedAt: new Date().toISOString() };
    const target = paths(dir).request;
    const temp = join(dir, '.lanscan-request-' + randomUUID() + '.tmp');
    try {
      await writeFile(temp, JSON.stringify(request) + '\n', { flag: 'wx', mode: 0o644 });
      await rename(temp, target);
    } finally {
      await unlink(temp).catch(() => {});
    }
    return {
      httpStatus: 202,
      scan: {
        state: 'queued', available: true, requestedAt: request.requestedAt,
        startedAt: null, finishedAt: null,
        message: 'Scan requested. The host worker starts within about one minute.'
      }
    };
  });
  requestChain = work.then(() => {}, () => {});
  return work;
}
