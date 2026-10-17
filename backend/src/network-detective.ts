import type Database from 'better-sqlite3';
import type { LanAddress, LanInventory } from './integrations/lanscan.js';

/**
 * Network Detective stores changes, not full scan copies.
 * Device identity is the normalized MAC scoped to the configured subnet.
 * DHCP-only observations are "known", not proof that a host is reachable.
 */
export type DeviceState = 'online' | 'offline' | 'known';
export type NetworkEventType =
  | 'NEW_DEVICE' | 'DEVICE_ONLINE' | 'DEVICE_OFFLINE' | 'IP_CHANGED'
  | 'MAC_CHANGED' | 'IP_CONFLICT' | 'CONFLICT_RESOLVED' | 'DHCP_CHANGED';

export type NetworkDevice = {
  network: string; mac: string; displayName: string | null; category: string | null;
  firstSeen: string; lastSeen: string; lastArpSeen: string | null;
  lastIp: string; hostname: string | null; vendor: string | null;
  description: string | null; state: DeviceState; missedScans: number;
};

export type NetworkEvent = {
  id: number; network: string; mac: string | null; ip: string | null;
  type: NetworkEventType; severity: 'info' | 'warning' | 'critical';
  previousValue: string | null; currentValue: string | null; createdAt: string;
};

type DeviceRow = {
  network: string; mac: string; first_seen: string; last_seen: string;
  last_arp_seen: string | null; last_ip: string; hostname: string | null;
  vendor: string | null; description: string | null;
  state: DeviceState; missed_scans: number;
};
type AddressRow = {
  ip: string; mac: string | null; conflict: number; lease_identity: string | null;
};
type Observation = {
  mac: string; ip: string; arp: boolean;
  hostname: string | null; vendor: string | null; description: string | null;
};

export function normalizeMac(value: string): string | null {
  const mac = value.trim().toLowerCase().replace(/-/g, ':');
  return /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) ? mac : null;
}

function addressIdentity(row: LanAddress): AddressRow | null {
  const arpMacs = row.devices.map(d => normalizeMac(d.mac)).filter((m): m is string => m !== null);
  const leaseMac = row.lease?.mac ? normalizeMac(row.lease.mac) : null;
  const leaseIdentity = row.lease
    ? [leaseMac ?? '', (row.lease.type ?? '').toLowerCase()].join('|')
    : null;
  if (arpMacs.length === 0 && leaseIdentity === null) return null;
  return {
    ip: row.ip,
    mac: arpMacs.length === 1 ? arpMacs[0] : null,
    conflict: row.status === 'conflict' ? 1 : 0,
    lease_identity: leaseIdentity
  };
}

function observations(rows: LanAddress[]): Map<string, Observation> {
  const devices = new Map<string, Observation>();
  for (const row of rows) {
    // ARP takes precedence; a DHCP reservation alone does not mean ONLINE.
    for (const device of row.devices) {
      const mac = normalizeMac(device.mac);
      if (!mac) continue;
      const previous = devices.get(mac);
      if (!previous || !previous.arp) {
        devices.set(mac, {
          mac, ip: row.ip, arp: true, hostname: row.hostname,
          vendor: device.vendor || null, description: row.lease?.description ?? null
        });
      }
    }
    const mac = row.lease?.mac ? normalizeMac(row.lease.mac) : null;
    if (mac && !devices.has(mac)) {
      devices.set(mac, {
        mac, ip: row.ip, arp: false,
        hostname: row.lease?.hostname || row.hostname,
        vendor: row.lease?.manufacturer ?? null,
        description: row.lease?.description ?? null
      });
    }
  }
  return devices;
}

const schema = `
CREATE TABLE IF NOT EXISTS network_scan_state (
  network TEXT PRIMARY KEY,
  scan_count INTEGER NOT NULL DEFAULT 0,
  last_scan_id TEXT NOT NULL,
  last_scanned_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS network_devices (
  network TEXT NOT NULL,
  mac TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  last_arp_seen TEXT,
  last_ip TEXT NOT NULL,
  hostname TEXT,
  vendor TEXT,
  description TEXT,
  state TEXT NOT NULL CHECK (state IN ('online','offline','known')),
  missed_scans INTEGER NOT NULL DEFAULT 0,
  display_name TEXT,
  category TEXT,
  PRIMARY KEY (network, mac)
);
CREATE INDEX IF NOT EXISTS network_devices_by_state ON network_devices(network, state);
CREATE TABLE IF NOT EXISTS network_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  network TEXT NOT NULL,
  mac TEXT,
  ip TEXT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL,
  previous_value TEXT,
  current_value TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS network_events_by_time ON network_events(network, id DESC);
CREATE INDEX IF NOT EXISTS network_events_by_device ON network_events(network, mac, id DESC);
CREATE TABLE IF NOT EXISTS network_ip_observations (
  network TEXT NOT NULL,
  ip TEXT NOT NULL,
  mac TEXT,
  conflict INTEGER NOT NULL DEFAULT 0,
  lease_identity TEXT,
  PRIMARY KEY (network, ip)
);
`;

/** All scan updates and emitted events commit atomically to SQLite. */
export class NetworkDetective {
  constructor(private readonly database: Database.Database) {
    database.exec(schema);
  }

  recordScan(
    inventory: Pick<LanInventory, 'network' | 'results'>,
    scannedAt: string,
    scanId: string
  ): void {
    const { network, results } = inventory;
    if (!Number.isFinite(Date.parse(scannedAt)) || !scanId) {
      throw new Error('Invalid Network Detective scan metadata');
    }
    const apply = this.database.transaction(() => {
      const previousScan = this.database.prepare(
        'SELECT scan_count, last_scan_id FROM network_scan_state WHERE network = ?'
      ).get(network) as { scan_count: number; last_scan_id: string } | undefined;
      if (previousScan?.last_scan_id === scanId) return;
      const baseline = !previousScan;
      const known = new Map<string, DeviceRow>(
        (this.database.prepare('SELECT * FROM network_devices WHERE network = ?')
          .all(network) as DeviceRow[]).map(row => [row.mac, row])
      );
      const previousIps = new Map<string, AddressRow>(
        (this.database.prepare('SELECT ip, mac, conflict, lease_identity FROM network_ip_observations WHERE network = ?')
          .all(network) as AddressRow[]).map(row => [row.ip, row])
      );
      const seen = observations(results);
      const events = this.database.prepare(`
        INSERT INTO network_events
          (network, mac, ip, type, severity, previous_value, current_value, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const emit = (
        type: NetworkEventType, severity: NetworkEvent['severity'],
        mac: string | null, ip: string | null,
        before: string | null = null, after: string | null = null
      ): void => {
        if (!baseline) events.run(network, mac, ip, type, severity, before, after, scannedAt);
      };

      const insertDevice = this.database.prepare(`
        INSERT INTO network_devices
          (network, mac, first_seen, last_seen, last_arp_seen, last_ip,
           hostname, vendor, description, state, missed_scans)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `);
      const updateDevice = this.database.prepare(`
        UPDATE network_devices
        SET last_seen = ?, last_arp_seen = ?, last_ip = ?,
            hostname = ?, vendor = ?, description = ?, state = ?, missed_scans = ?
        WHERE network = ? AND mac = ?
      `);
      for (const [mac, observation] of seen) {
        const previous = known.get(mac);
        const state: DeviceState = observation.arp ? 'online' :
          previous?.state === 'offline' ? 'offline' :
          previous?.state === 'online' ? 'online' : 'known';
        if (!previous) {
          insertDevice.run(
            network, mac, scannedAt, scannedAt,
            observation.arp ? scannedAt : null, observation.ip,
            observation.hostname, observation.vendor, observation.description, state
          );
          emit('NEW_DEVICE', 'info', mac, observation.ip, null, observation.arp ? 'arp' : 'dhcp');
          continue;
        }
        if (observation.arp && previous.last_ip !== observation.ip && previous.last_arp_seen) {
          emit('IP_CHANGED', 'warning', mac, observation.ip, previous.last_ip, observation.ip);
        }
        if (observation.arp && previous.state === 'offline') {
          emit('DEVICE_ONLINE', 'info', mac, observation.ip);
        } else if (observation.arp && previous.state === 'known' && !previous.last_arp_seen) {
          emit('DEVICE_ONLINE', 'info', mac, observation.ip);
        }
        // An offline state requires two consecutive successful scans without ARP.
        const misses = observation.arp ? 0 : previous.last_arp_seen
          ? Math.min(2, previous.missed_scans + 1) : 0;
        const nextState: DeviceState = !observation.arp && previous.last_arp_seen && misses >= 2
          ? 'offline' : state;
        if (nextState === 'offline' && previous.state === 'online') {
          emit('DEVICE_OFFLINE', 'warning', mac, previous.last_ip);
        }
        updateDevice.run(
          scannedAt, observation.arp ? scannedAt : previous.last_arp_seen,
          observation.ip, observation.hostname || previous.hostname,
          observation.vendor || previous.vendor, observation.description || previous.description,
          nextState, misses, network, mac
        );
        known.delete(mac);
      }

      // Devices with no ARP OR DHCP observation are still remembered.
      for (const previous of known.values()) {
        if (!previous.last_arp_seen) continue; // A DHCP-only device was never online.
        const misses = Math.min(2, previous.missed_scans + 1);
        if (misses >= 2 && previous.state === 'online') {
          emit('DEVICE_OFFLINE', 'warning', previous.mac, previous.last_ip);
        }
        this.database.prepare(`
          UPDATE network_devices SET missed_scans = ?, state = ?
          WHERE network = ? AND mac = ?
        `).run(misses, misses >= 2 ? 'offline' : previous.state, network, previous.mac);
      }

      const activeIps = new Map<string, AddressRow>();
      for (const row of results) {
        const current = addressIdentity(row);
        const previous = previousIps.get(row.ip);
        if (current) {
          activeIps.set(row.ip, current);
          if (previous) {
            if (!previous.conflict && current.conflict) {
              emit('IP_CONFLICT', 'critical', null, row.ip);
            } else if (previous.conflict && !current.conflict) {
              emit('CONFLICT_RESOLVED', 'info', null, row.ip);
            }
            if (!previous.conflict && !current.conflict && previous.mac && current.mac &&
                previous.mac !== current.mac) {
              emit('MAC_CHANGED', 'warning', current.mac, row.ip, previous.mac, current.mac);
            }
          } else if (current.conflict) {
            emit('IP_CONFLICT', 'critical', null, row.ip);
          }
        } else if (previous?.conflict) {
          emit('CONFLICT_RESOLVED', 'info', null, row.ip);
        }
        if (previous && previous.lease_identity !== (current?.lease_identity ?? null)) {
          emit('DHCP_CHANGED', 'info', current?.mac ?? null, row.ip,
            previous.lease_identity, current?.lease_identity ?? null);
        } else if (!previous && current?.lease_identity) {
          emit('DHCP_CHANGED', 'info', current.mac, row.ip, null, current.lease_identity);
        }
      }
      this.database.prepare('DELETE FROM network_ip_observations WHERE network = ?').run(network);
      const insertIp = this.database.prepare(`
        INSERT INTO network_ip_observations (network, ip, mac, conflict, lease_identity)
        VALUES (?, ?, ?, ?, ?)
      `);
      for (const row of activeIps.values()) {
        insertIp.run(network, row.ip, row.mac, row.conflict, row.lease_identity);
      }
      this.database.prepare(`
        INSERT INTO network_scan_state(network, scan_count, last_scan_id, last_scanned_at)
        VALUES (?, 1, ?, ?)
        ON CONFLICT(network) DO UPDATE SET
          scan_count = scan_count + 1,
          last_scan_id = excluded.last_scan_id,
          last_scanned_at = excluded.last_scanned_at
      `).run(network, scanId, scannedAt);
    });
    apply();
  }

  summary(network: string): {
    network: string; scans: number; lastScannedAt: string | null;
    totalDevices: number; online: number; offline: number; known: number; events: number;
  } {
    const run = this.database.prepare(
      'SELECT scan_count AS scans, last_scanned_at AS lastScannedAt FROM network_scan_state WHERE network = ?'
    ).get(network) as { scans: number; lastScannedAt: string } | undefined;
    const counts = this.database.prepare(`
      SELECT COUNT(*) AS totalDevices,
        SUM(CASE WHEN state = 'online' THEN 1 ELSE 0 END) AS online,
        SUM(CASE WHEN state = 'offline' THEN 1 ELSE 0 END) AS offline,
        SUM(CASE WHEN state = 'known' THEN 1 ELSE 0 END) AS known
      FROM network_devices WHERE network = ?
    `).get(network) as { totalDevices: number; online: number | null; offline: number | null; known: number | null };
    const countEvents = this.database.prepare(
      'SELECT COUNT(*) AS count FROM network_events WHERE network = ?'
    ).get(network) as { count: number };
    return {
      network, scans: run?.scans ?? 0, lastScannedAt: run?.lastScannedAt ?? null,
      totalDevices: counts.totalDevices, online: counts.online ?? 0,
      offline: counts.offline ?? 0, known: counts.known ?? 0, events: countEvents.count
    };
  }

  listDevices(network: string, limit = 500): NetworkDevice[] {
    return this.database.prepare(`
      SELECT network, mac, display_name AS displayName, category,
        first_seen AS firstSeen, last_seen AS lastSeen, last_arp_seen AS lastArpSeen,
        last_ip AS lastIp, hostname, vendor, description, state, missed_scans AS missedScans
      FROM network_devices WHERE network = ?
      ORDER BY state = 'online' DESC, last_seen DESC, mac ASC LIMIT ?
    `).all(network, Math.min(500, Math.max(1, limit))) as NetworkDevice[];
  }

  listEvents(network: string, limit = 50, mac?: string): NetworkEvent[] {
    return this.database.prepare(`
      SELECT id, network, mac, ip, type, severity, previous_value AS previousValue,
        current_value AS currentValue, created_at AS createdAt
      FROM network_events
      WHERE network = ? AND (? IS NULL OR mac = ?)
      ORDER BY id DESC LIMIT ?
    `).all(network, mac ?? null, mac ?? null, Math.min(100, Math.max(1, limit))) as NetworkEvent[];
  }
}
