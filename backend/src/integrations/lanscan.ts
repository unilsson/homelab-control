import { readFile, stat } from 'node:fs/promises';
import type { DhcpLease } from './opnsense.js';

export type LanStatus = 'used' | 'free' | 'leased' | 'reserved' | 'conflict';
export type LanDevice = { mac: string; vendor: string };
export type LanLease = {
  mac: string | null; hostname: string | null; description: string | null;
  manufacturer: string | null; type: string | null;
};
export type LanAddress = {
  ip: string; status: LanStatus; hostname: string | null;
  devices: LanDevice[]; lease: LanLease | null;
};
export type LanSummary = {
  total: number; occupied: number; used: number; free: number;
  leased: number; reserved: number; conflicts: number;
};
export type LanInventory = {
  network: string; state: 'online' | 'stale' | 'missing' | 'error';
  scannedAt: string | null; summary: LanSummary | null;
  results: LanAddress[]; message?: string;
};

const validStatuses = new Set<LanStatus>(['used', 'free', 'leased', 'reserved', 'conflict']);
const maxSnapshotBytes = 4_000_000;
const defaultNetwork = '192.168.1.0/24';
const staleAfterMs = 30 * 60 * 1000;

function ipv4Number(value: unknown): number | null {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,2})(\.(0|[1-9][0-9]{0,2})){3}$/.test(value)) return null;
  const parts = value.split('.').map(Number);
  if (parts.some(part => part > 255)) return null;
  return (((parts[0] * 0x1000000) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0);
}

export function networkSpec(value: string): { network: string; first: number; last: number; total: number } {
  const match = /^(.*)\/(\d{1,2})$/.exec(value);
  const address = match ? ipv4Number(match[1]) : null;
  const prefix = match ? Number(match[2]) : NaN;
  // A LAN inventory is deliberately bounded to 4,094 host addresses.
  if (address === null || !Number.isInteger(prefix) || prefix < 20 || prefix > 30) {
    throw new Error('Invalid LANSCAN_NETWORK: only IPv4 subnets /20 to /30 are supported.');
  }
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  const base = (address & mask) >>> 0;
  if (base !== address) throw new Error('LANSCAN_NETWORK must be a network address.');
  const first = base + 1;
  const last = base + (2 ** (32 - prefix)) - 2;
  return { network: value, first, last, total: last - first + 1 };
}

function optionalText(value: unknown, maxLength = 160): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > maxLength) throw new Error('Invalid lanscan text value');
  return value;
}

/** Validate the exact versioned lanscan --all --json contract before exposing it. */
export function parseLanSnapshot(payload: unknown, network: string): Pick<LanInventory, 'network' | 'summary' | 'results'> {
  const subnet = networkSpec(network);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid lanscan JSON document');
  const doc = payload as Record<string, unknown>;
  if (doc.schema_version !== 1 || !Array.isArray(doc.results) || doc.results.length !== subnet.total) {
    throw new Error('Unsupported or incomplete lanscan snapshot (use --all --json)');
  }

  const seen = new Set<number>();
  const results: LanAddress[] = doc.results.map((raw: unknown) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid lanscan address row');
    const row = raw as Record<string, unknown>;
    const ip = ipv4Number(row.ip);
    if (ip === null || ip < subnet.first || ip > subnet.last || seen.has(ip)) {
      throw new Error('Duplicate or out-of-network address in lanscan snapshot');
    }
    seen.add(ip);
    if (typeof row.status !== 'string' || !validStatuses.has(row.status as LanStatus) ||
        !Array.isArray(row.devices) || row.devices.length > 16) {
      throw new Error('Invalid lanscan address state');
    }
    const devices = row.devices.map((rawDevice: unknown): LanDevice => {
      if (!rawDevice || typeof rawDevice !== 'object' || Array.isArray(rawDevice)) throw new Error('Invalid LAN device');
      const device = rawDevice as Record<string, unknown>;
      if (typeof device.mac !== 'string' || device.mac.length > 32 || !device.mac.length) throw new Error('Invalid MAC');
      return { mac: device.mac, vendor: optionalText(device.vendor) ?? '' };
    });
    const status = row.status as LanStatus;
    if ((status === 'free' || status === 'leased' || status === 'reserved') && devices.length !== 0) {
      throw new Error('Unexpected ARP devices for non-ARP address state');
    }
    if ((status === 'used' && devices.length !== 1) ||
        (status === 'conflict' && devices.length < 2)) {
      throw new Error('Unexpected ARP devices for address state');
    }
    let lease: LanLease | null = null;
    if (row.lease != null) {
      if (typeof row.lease !== 'object' || Array.isArray(row.lease)) throw new Error('Invalid DHCP lease');
      const l = row.lease as Record<string, unknown>;
      lease = {
        mac: optionalText(l.mac, 32), hostname: optionalText(l.hostname),
        description: optionalText(l.description, 300),
        manufacturer: optionalText(l.manufacturer), type: optionalText(l.type, 30)
      };
    }
    return {
      ip: row.ip as string, status, hostname: optionalText(row.hostname),
      devices, lease
    };
  });

  results.sort((a, b) => (ipv4Number(a.ip) ?? 0) - (ipv4Number(b.ip) ?? 0));
  const counts = { used: 0, free: 0, leased: 0, reserved: 0, conflict: 0 };
  for (const row of results) counts[row.status] += 1;
  return {
    network: subnet.network,
    summary: {
      total: subnet.total, occupied: subnet.total - counts.free,
      used: counts.used, free: counts.free, leased: counts.leased,
      reserved: counts.reserved, conflicts: counts.conflict
    },
    results
  };
}


/**
 * Merge OPNsense ISC DHCP observations with ARP results. ARP observations
 * take precedence for reachability/conflicts; DHCP static mappings protect
 * sleeping devices from being incorrectly labeled FREE.
 *
 * On OPNsense failure callers MUST reject the entire scan. Writing an
 * ARP-only fallback would incorrectly replace RESERVED/LEASED with FREE.
 */
export function mergeOpnsenseLeases(
  arpDocument: unknown, network: string, leases: DhcpLease[]
): { schema_version: 1; results: LanAddress[] } {
  const raw = parseLanSnapshot(arpDocument, network);
  const subnet = networkSpec(network);
  const filtered = new Map<string, DhcpLease>();
  for (const lease of leases) {
    const address = ipv4Number(lease.ip);
    if (address === null || address < subnet.first || address > subnet.last) continue;
    const previous = filtered.get(lease.ip);
    if (!previous || lease.isStatic || !previous.isStatic) filtered.set(lease.ip, lease);
  }

  const results = raw.results.map(row => {
    const lease = filtered.get(row.ip);
    if (!lease) return row;
    const status: LanStatus = row.status === 'free'
      ? (lease.isStatic ? 'reserved' : 'leased')
      : row.status;
    return {
      ...row,
      status,
      hostname: row.hostname || lease.hostname,
      lease: {
        mac: lease.mac,
        hostname: lease.hostname,
        description: lease.description,
        manufacturer: lease.manufacturer,
        type: lease.type
      }
    };
  });
  const combined = { schema_version: 1 as const, results };
  // Recheck the complete address-space and status invariants before saving.
  parseLanSnapshot(combined, network);
  return combined;
}

export async function readLanInventory(
  filePath = process.env.LANSCAN_SNAPSHOT_FILE?.trim() || '/app/data/lanscan.json',
  network = process.env.LANSCAN_NETWORK?.trim() || defaultNetwork
): Promise<LanInventory> {
  const empty = (state: 'missing' | 'error', message: string): LanInventory =>
    ({ network, state, scannedAt: null, summary: null, results: [], message });
  try {
    const file = await stat(filePath);
    if (!file.isFile() || file.size > maxSnapshotBytes || file.size === 0) {
      return empty('error', 'LAN scan snapshot is empty or too large.');
    }
    const source = await readFile(filePath, 'utf8');
    const parsed = parseLanSnapshot(JSON.parse(source) as unknown, network);
    const stale = Date.now() - file.mtimeMs > staleAfterMs;
    return {
      ...parsed, state: stale ? 'stale' : 'online', scannedAt: file.mtime.toISOString(),
      ...(stale ? { message: 'LAN scan is older than 30 minutes; addresses may have changed.' } : {})
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return empty('missing', 'No LAN scan available yet. Click Scan now to scan the LAN.');
    }
    return empty('error', 'Cannot read or validate LAN scan snapshot. Click Scan now or check backend logs.');
  }
}
