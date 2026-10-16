import https from 'node:https';
import { readFileSync } from 'node:fs';
import { db } from '../database.js';

export type ProxmoxNode = {
  name: string;
  status: string;
  cpu: number | null;
  maxcpu: number | null;
  mem: number | null;
  maxmem: number | null;
  uptime: number | null;
};
export type ProxmoxGuest = {
  vmid: number;
  name: string;
  node: string;
  kind: 'qemu' | 'lxc';
  status: string;
  cpu: number | null;
  mem: number | null;
  maxmem: number | null;
  template: boolean;
};
export type ProxmoxInventory = {
  configured: boolean;
  state: 'disabled' | 'online' | 'partial' | 'error';
  checkedAt: string | null;
  nodes: ProxmoxNode[];
  guests: ProxmoxGuest[];
  error?: string;
};

type PveNode = { node: string; status?: string; cpu?: number; maxcpu?: number; mem?: number; maxmem?: number; uptime?: number };
type PveGuest = { vmid: number; name?: string; status?: string; cpu?: number; mem?: number; maxmem?: number; template?: number };

const cacheMs = 30_000;
let cached: ProxmoxInventory | null = null;
let cacheTime = 0;
let pending: Promise<ProxmoxInventory> | null = null;

function configured(): boolean {
  return Boolean(process.env.PROXMOX_URL?.trim() && process.env.PROXMOX_TOKEN_ID?.trim() && process.env.PROXMOX_TOKEN_SECRET?.trim());
}

function nullable(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// HTTPS only, no automatic redirects: API tokens must never be forwarded to a redirect target.
function requestData<T>(path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(process.env.PROXMOX_URL!.trim());
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
      reject(new Error('PROXMOX_URL must be an HTTPS origin such as https://pve.example:8006'));
      return;
    }
    const url = new URL('/api2/json' + path, endpoint);
    const caPath = process.env.PROXMOX_CA_PATH?.trim();
    let ca: Buffer | undefined;
    try {
      if (caPath) ca = readFileSync(caPath);
    } catch {
      reject(new Error('Cannot read the configured Proxmox CA certificate'));
      return;
    }
    const req = https.request(url, {
      method: 'GET',
      headers: {
        Authorization: 'PVEAPIToken=' + process.env.PROXMOX_TOKEN_ID!.trim() + '=' + process.env.PROXMOX_TOKEN_SECRET!.trim(),
        Accept: 'application/json'
      },
      ...(ca ? { ca } : {}),
      timeout: 8_000
    }, res => {
      const status = res.statusCode ?? 0;
      if (status === 401 || status === 403) {
        res.resume();
        reject(new Error('Proxmox rejected the API token or its read permissions (' + status + ')'));
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(new Error('Proxmox returned HTTP ' + status));
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      res.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > 4_000_000) {
          res.destroy(new Error('Proxmox response exceeded size limit'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!payload || typeof payload !== 'object' || !('data' in payload)) {
            reject(new Error('Proxmox API returned unexpected JSON'));
            return;
          }
          resolve((payload as { data: T }).data);
        } catch {
          reject(new Error('Proxmox API returned invalid JSON'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Proxmox API timed out')));
    req.on('error', error => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code?.startsWith('CERT_') || code?.includes('CERT') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
        reject(new Error('Proxmox TLS validation failed. Configure a trusted hostname and PROXMOX_CA_PATH.'));
      } else if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH') {
        reject(new Error('Cannot reach Proxmox (' + code + ')'));
      } else {
        reject(error.message === 'Proxmox API timed out' ? error : new Error('Proxmox HTTPS request failed'));
      }
    });
    req.end();
  });
}

function synchronizeInventory(inventory: ProxmoxInventory): void {
  if (inventory.state !== 'online' && inventory.state !== 'partial') return;

  const get = db.prepare('SELECT id, status FROM systems WHERE source = ? AND external_id = ?');
  const insert = db.prepare('INSERT INTO systems (name, type, status, host, source, external_id, last_seen) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)');
  const update = db.prepare('UPDATE systems SET name = ?, type = ?, status = ?, host = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?');
  const addEvent = db.prepare('INSERT INTO events (system_id, severity, message) VALUES (?, ?, ?)');

  const upsert = (id: string, name: string, type: string, status: string, host: string) => {
    const current = get.get('proxmox', id) as { id: number; status: string } | undefined;
    if (!current) {
      insert.run(name, type, status, host, 'proxmox', id);
      return;
    }
    update.run(name, type, status, host, current.id);
    if (current.status !== status) {
      const severity = status === 'offline' ? 'warning' : 'info';
      addEvent.run(current.id, severity, type + ' ' + name + ' changed status: ' + current.status + ' → ' + status);
    }
  };

  db.transaction(() => {
    for (const node of inventory.nodes) {
      upsert('node:' + node.name, node.name, 'Proxmox node', node.status === 'online' ? 'online' : 'offline', node.name);
    }
    for (const guest of inventory.guests) {
      // A stopped guest is not necessarily an alert.
      const status = guest.status === 'running' ? 'online' : guest.status === 'stopped' ? 'stopped' : 'unknown';
      upsert(guest.kind + ':' + guest.vmid, guest.name, guest.kind === 'qemu' ? 'Virtual machine' : 'LXC container', status, guest.node);
    }
  })();
}

async function discover(): Promise<ProxmoxInventory> {
  if (!configured()) return { configured: false, state: 'disabled', checkedAt: null, nodes: [], guests: [] };

  try {
    const rawNodes = await requestData<PveNode[]>('/nodes');
    if (!Array.isArray(rawNodes)) throw new Error('Unexpected Proxmox node response');

    const nodes: ProxmoxNode[] = rawNodes.filter(n => typeof n.node === 'string').map(n => ({
      name: n.node,
      status: n.status ?? 'unknown',
      cpu: nullable(n.cpu),
      maxcpu: nullable(n.maxcpu),
      mem: nullable(n.mem),
      maxmem: nullable(n.maxmem),
      uptime: nullable(n.uptime)
    }));
    const activeNodes = nodes.filter(n => n.status === 'online');

    const tasks = activeNodes.flatMap(node => (['qemu', 'lxc'] as const).map(async kind => {
      const data = await requestData<PveGuest[]>('/nodes/' + encodeURIComponent(node.name) + '/' + kind);
      if (!Array.isArray(data)) throw new Error('Unexpected Proxmox guest response');
      return data.filter(g => typeof g.vmid === 'number').map(g => ({
        vmid: g.vmid,
        name: g.name || kind.toUpperCase() + ' ' + g.vmid,
        node: node.name,
        kind,
        status: g.status || 'unknown',
        cpu: nullable(g.cpu),
        mem: nullable(g.mem),
        maxmem: nullable(g.maxmem),
        template: Boolean(g.template)
      }));
    }));
    const outcomes = await Promise.allSettled(tasks);
    const guests = outcomes.filter((r): r is PromiseFulfilledResult<ProxmoxGuest[]> => r.status === 'fulfilled').flatMap(r => r.value);
    const failures = outcomes.filter(r => r.status === 'rejected').length;
    const inventory: ProxmoxInventory = {
      configured: true,
      state: failures ? 'partial' : 'online',
      checkedAt: new Date().toISOString(),
      nodes,
      guests: guests.sort((a, b) => a.vmid - b.vmid),
      ...(failures ? { error: failures + ' guest lists could not be read (check Proxmox permissions).' } : {})
    };
    synchronizeInventory(inventory);
    return inventory;
  } catch (error) {
    return {
      configured: true,
      state: 'error',
      checkedAt: new Date().toISOString(),
      nodes: [],
      guests: [],
      error: error instanceof Error ? error.message : 'Proxmox discovery failed'
    };
  }
}

export function getProxmoxInventory(): Promise<ProxmoxInventory> {
  if (cached && Date.now() - cacheTime < cacheMs) return Promise.resolve(cached);
  if (pending) return pending;
  pending = discover()
    .then(result => {
      cached = result;
      cacheTime = Date.now();
      return result;
    })
    .finally(() => { pending = null; });
  return pending;
}
