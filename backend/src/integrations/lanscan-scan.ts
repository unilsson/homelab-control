import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { parseLanSnapshot } from './lanscan.js';

const execFileAsync = promisify(execFile);

export type ScanState = 'unavailable' | 'idle' | 'running' | 'completed' | 'failed';
export type LanScanInfo = {
  state: ScanState;
  available: boolean;
  requestedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  message?: string;
};
export type ScanResponse = { httpStatus: 202 | 409 | 429 | 503; scan: LanScanInfo };

type CommandOutput = { stdout: string };
type Execute = (binary: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<CommandOutput>;

type ScannerOptions = {
  enabled: boolean;
  network: string;
  snapshotPath: string;
  command: string;
  withOpnsense: boolean;
  execute: Execute;
  now: () => number;
};

const limits = {
  timeoutMs: 150_000,
  maxBufferBytes: 4_000_000,
  cooldownMs: 90_000,
  automaticIntervalMs: 15 * 60_000
};

const defaultOptions: ScannerOptions = {
  enabled: process.env.LANSCAN_ENABLED === 'true',
  network: process.env.LANSCAN_NETWORK?.trim() || '192.168.1.0/24',
  snapshotPath: process.env.LANSCAN_SNAPSHOT_FILE?.trim() || '/app/data/lanscan.json',
  command: '/opt/lanscan/bin/lanscan',
  withOpnsense: process.env.LANSCAN_WITH_OPNSENSE === 'true',
  execute: (binary, args, options) => execFileAsync(binary, args, options),
  now: Date.now
};

export class LanScanner {
  private readonly options: ScannerOptions;
  private requestedAtMs: number | null = null;
  private current: LanScanInfo;

  constructor(options: ScannerOptions) {
    this.options = options;
    this.current = {
      state: options.enabled ? 'idle' : 'unavailable',
      available: options.enabled,
      requestedAt: null,
      startedAt: null,
      finishedAt: null,
      ...(!options.enabled ? { message: 'LAN scanning is disabled. Set LANSCAN_ENABLED=true in Docker Compose.' } : {})
    };
  }

  info(): LanScanInfo { return { ...this.current }; }

  /**
   * Only the fixed, configured subnet can be scanned. Caller-supplied
   * commands, flags, targets and payloads are not accepted.
   */
  requestScan(manual = true): ScanResponse {
    if (!this.options.enabled) return { httpStatus: 503, scan: this.info() };
    if (this.current.state === 'running') return { httpStatus: 409, scan: this.info() };

    const now = this.options.now();
    if (manual && this.requestedAtMs !== null && now - this.requestedAtMs < limits.cooldownMs) {
      return {
        httpStatus: 429,
        scan: { ...this.info(), message: 'Wait at least 90 seconds between manual scans.' }
      };
    }
    if (manual) this.requestedAtMs = now;
    const requested = new Date(now).toISOString();
    this.current = {
      state: 'running', available: true, requestedAt: requested,
      startedAt: requested, finishedAt: null
    };
    void this.run();
    return { httpStatus: 202, scan: this.info() };
  }

  private async run(): Promise<void> {
    const { command, network, withOpnsense, snapshotPath, execute, now } = this.options;
    try {
      // Verify the exact configured subnet BEFORE invoking the scanner.
      // Validation of a complete JSON result repeats this check afterward.
      // The parser checks network syntax using the supplied CIDR.
      const args = [network, '--all', '--json', ...(withOpnsense ? ['--opnsense'] : [])];
      const { stdout } = await execute(command, args, {
        timeout: limits.timeoutMs, maxBuffer: limits.maxBufferBytes
      });
      if (Buffer.byteLength(stdout, 'utf8') > limits.maxBufferBytes) {
        throw new Error('Scan result exceeds size limit');
      }
      const document: unknown = JSON.parse(stdout);
      parseLanSnapshot(document, network);
      const dir = dirname(snapshotPath);
      await mkdir(dir, { recursive: true });
      const tempPath = snapshotPath + '.tmp-' + randomUUID();
      try {
        await writeFile(tempPath, JSON.stringify(document) + '\n', {
          encoding: 'utf8', flag: 'wx', mode: 0o600
        });
        await rename(tempPath, snapshotPath);
      } finally {
        await unlink(tempPath).catch(() => {});
      }
      this.current = {
        ...this.current, state: 'completed', finishedAt: new Date(now()).toISOString()
      };
    } catch (error) {
      // Never return stderr or API credentials to clients.
      console.warn('[lanscan] Scan failed:', error instanceof Error ? error.name : 'unknown');
      this.current = {
        ...this.current, state: 'failed', finishedAt: new Date(now()).toISOString(),
        message: 'LAN scan failed. Check Docker backend logs. Previous results are preserved.'
      };
    }
  }

  /** Automatic scans run inside the backend process; no cron or systemd. */
  startAutomaticScans(): void {
    if (!this.options.enabled) return;
    setTimeout(() => { this.requestScan(false); }, 10_000).unref();
    setInterval(() => { this.requestScan(false); }, limits.automaticIntervalMs).unref();
  }
}

export const lanScanner = new LanScanner(defaultOptions);
export const getLanScanInfo = (): LanScanInfo => lanScanner.info();
export const requestLanScan = (): ScanResponse => lanScanner.requestScan();
export const startLanScanner = (): void => lanScanner.startAutomaticScans();
