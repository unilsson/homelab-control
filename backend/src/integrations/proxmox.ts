import https from 'node:https';
import { readFileSync } from 'node:fs';
import { db } from '../database.js';
import { getInfisicalSecret } from './infisical.js';

export type ProxmoxInstanceConfig = {
  id: string;
  name: string;
  url: string;
  tokenId: string;
  tokenSecret?: string;
  tokenSecretRef?: string;
  caPath?: string;
};

type ResolvedInstanceConfig = ProxmoxInstanceConfig & { tokenSecret: string };

export type ProxmoxNode = {
  instanceId: string;
  instanceName: string;
  name: string;
  status: string;
  cpu: number | null;
  maxcpu: number | null;
  mem: number | null;
  maxmem: number | null;
  uptime: number | null;
};
export type ProxmoxGuest = {
  instanceId: string;
  instanceName: string;
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
export type ProxmoxInstance = {
  id: string;
  name: string;
  state: 'online' | 'partial' | 'error';
  checkedAt: string;
  nodes: ProxmoxNode[];
  guests: ProxmoxGuest[];
  error?: string;
};
export type ProxmoxInventory = {
  configured: boolean;
  state: 'disabled' | 'online' | 'partial' | 'error';
  checkedAt: string | null;
  instances: ProxmoxInstance[];
  nodes: ProxmoxNode[];
  guests: ProxmoxGuest[];
  error?: string;
};

type PveNode = { node: string; status?: string; cpu?: number; maxcpu?: number; mem?: number; maxmem?: number; uptime?: number };
type PveGuest = { vmid: number | string; name?: string; status?: string; cpu?: number; mem?: number; maxmem?: number; template?: number };

const cacheMs = 30_000;
let cached: ProxmoxInventory | null = null;
let cacheTime = 0;
let pending: Promise<ProxmoxInventory> | null = null;

function requiredString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      !url.username && !url.password && url.pathname === '/' &&
      !url.search && !url.hash && !url.hostname.includes('%');
  } catch {
    return false;
  }
}

/**
 * Credentials are read server-side only and NEVER included in API responses.
 * Configuration is stored outside Git in a bind-mounted local JSON file.
 * The old single-host environment variables remain supported for migration.
 */
export function loadProxmoxConfigs(): ProxmoxInstanceConfig[] {
  const path = process.env.PROXMOX_INSTANCES_FILE?.trim();
  let configs: unknown;
  if (path) {
    try {
      configs = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
      throw new Error('Cannot read Proxmox instance configuration (check local JSON file).');
    }
  } else if (
    requiredString(process.env.PROXMOX_URL) ||
    requiredString(process.env.PROXMOX_TOKEN_ID) ||
    requiredString(process.env.PROXMOX_TOKEN_SECRET)
  ) {
    configs = [{
      id: 'primary',
      name: 'Proxmox',
      url: process.env.PROXMOX_URL,
      tokenId: process.env.PROXMOX_TOKEN_ID,
      tokenSecret: process.env.PROXMOX_TOKEN_SECRET,
      caPath: process.env.PROXMOX_CA_PATH || undefined
    }];
  } else {
    return [];
  }

  if (!Array.isArray(configs) || configs.length === 0 || configs.length > 20) {
    throw new Error('Proxmox configuration must contain between 1 and 20 instances.');
  }

  const ids = new Set<string>();
  return configs.map((entry: unknown, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Invalid Proxmox instance at index ' + index);
    }
    const item = entry as Record<string, unknown>;
    if (!requiredString(item.id) || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(item.id)) {
      throw new Error('Invalid Proxmox instance ID at index ' + index);
    }
    if (ids.has(item.id)) throw new Error('Duplicate Proxmox instance ID: ' + item.id);
    ids.add(item.id);
    if (!requiredString(item.name) || item.name.length > 120) {
      throw new Error('Invalid Proxmox instance name for ' + item.id);
    }
    if (!requiredString(item.url) || !validUrl(item.url)) {
      throw new Error('Invalid Proxmox URL for ' + item.id + ' (HTTPS origin required)');
    }
    if (!requiredString(item.tokenId)) {
      throw new Error('Missing Proxmox token ID for ' + item.id);
    }
    // Exactly one credential source: legacy local value OR Infisical reference.
    const hasLocalSecret = requiredString(item.tokenSecret);
    const hasReference = requiredString(item.tokenSecretRef);
    if (hasLocalSecret === hasReference) {
      throw new Error('Choose exactly one of tokenSecret or tokenSecretRef for ' + item.id);
    }
    if (hasReference && !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(item.tokenSecretRef as string)) {
      throw new Error('Invalid Infisical secret reference for ' + item.id);
    }
    if (item.caPath !== undefined && item.caPath !== null && !requiredString(item.caPath)) {
      throw new Error('Invalid Proxmox CA path for ' + item.id);
    }
    return {
      id: item.id,
      name: item.name.trim(),
      url: item.url.trim(),
      tokenId: item.tokenId.trim(),
      ...(requiredString(item.tokenSecret) ? { tokenSecret: item.tokenSecret.trim() } : {}),
      ...(requiredString(item.tokenSecretRef) ? { tokenSecretRef: item.tokenSecretRef.trim() } : {}),
      ...(requiredString(item.caPath) ? { caPath: item.caPath.trim() } : {})
    };
  });
}

function nullable(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Some Proxmox versions serialize VMIDs as decimal strings in QEMU/LXC lists.
// Normalize only positive safe integers so the public API and SQLite keys
// keep consistent numeric IDs across installations.
function parseVmid(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

// HTTPS only, no redirect handling (to avoid forwarding tokens).
function requestData<T>(instance: ResolvedInstanceConfig, path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const endpoint = new URL(instance.url);
    const url = new URL('/api2/json' + path, endpoint);
    let ca: Buffer | undefined;
    try {
      if (instance.caPath) ca = readFileSync(instance.caPath);
    } catch {
      reject(new Error('Cannot read trusted Proxmox CA certificate.'));
      return;
    }
    const req = https.request(url, {
      method: 'GET',
      headers: {
        Authorization: 'PVEAPIToken=' + instance.tokenId + '=' + instance.tokenSecret,
        Accept: 'application/json'
      },
      ...(ca ? { ca } : {}),
      timeout: 8_000
    }, res => {
      const status = res.statusCode ?? 0;
      if (status === 401 || status === 403) {
        res.resume();
        reject(new Error('Proxmox rejected API token or read permissions (HTTP ' + status + ')'));
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
      res.on('error', () => reject(new Error('Proxmox response stream interrupted')));
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
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (error: NodeJS.ErrnoException) => {
      // Hide raw Node/TLS messages; they may reveal internal addresses.
      const code = error.code ?? '';
      if (code.startsWith('CERT_') || code.includes('CERT') ||
          code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
          code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
        reject(new Error('Proxmox TLS validation failed (hostname or CA certificate)'));
      } else if (error.message === 'timeout') {
        reject(new Error('Proxmox API timed out'));
      } else {
        reject(new Error('Cannot reach Proxmox HTTPS API'));
      }
    });
    req.end();
  });
}

function synchronizeInstances(instances: ProxmoxInstance[]): void {
  const lookup = db.prepare('SELECT id, status FROM systems WHERE source = ? AND external_id = ?');
  const insert = db.prepare('INSERT INTO systems (name, type, status, host, source, external_id, last_seen) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)');
  const update = db.prepare('UPDATE systems SET name = ?, type = ?, status = ?, host = ?, last_seen = CURRENT_TIMESTAMP WHERE id = ?');
  const addEvent = db.prepare('INSERT INTO events (system_id, severity, message) VALUES (?, ?, ?)');
  // Do not label unreachable hosts as offline. Their last known inventory remains
  // in SQLite, but status becomes unknown until polling succeeds again.
  const markUnknown = db.prepare("UPDATE systems SET status = 'unknown' WHERE source = 'proxmox' AND substr(external_id, 1, ?) = ? AND status != 'unknown'");

  const upsert = (key: string, name: string, type: string, status: string, host: string) => {
    const current = lookup.get('proxmox', key) as { id: number; status: string } | undefined;
    if (!current) {
      insert.run(name, type, status, host, 'proxmox', key);
      return;
    }
    update.run(name, type, status, host, current.id);
    // Suppress noisy "recovered" events after connection loss.
    if (current.status !== 'unknown' && current.status !== status) {
      addEvent.run(current.id, status === 'offline' ? 'warning' : 'info',
        type + ' ' + name + ' changed status: ' + current.status + ' → ' + status);
    }
  };

  db.transaction(() => {
    for (const instance of instances) {
      const prefix = instance.id + ':';
      if (instance.state === 'error') {
        markUnknown.run(prefix.length, prefix);
        continue;
      }
      for (const node of instance.nodes) {
        upsert(prefix + 'node:' + node.name,
          node.name, 'Proxmox node', node.status === 'online' ? 'online' : 'offline',
          instance.name);
      }
      for (const guest of instance.guests) {
        const status = guest.status === 'running' ? 'online' :
          guest.status === 'stopped' ? 'stopped' : 'unknown';
        upsert(prefix + guest.kind + ':' + guest.vmid,
          guest.name, guest.kind === 'qemu' ? 'Virtual machine' : 'LXC container',
          status, instance.name + ' / ' + guest.node);
      }
    }
  })();
}

async function discoverInstance(instance: ResolvedInstanceConfig): Promise<ProxmoxInstance> {
  const checkedAt = new Date().toISOString();
  try {
    const rawNodes = await requestData<PveNode[]>(instance, '/nodes');
    if (!Array.isArray(rawNodes)) throw new Error('Unexpected Proxmox node response');
    const nodes: ProxmoxNode[] = rawNodes
      .filter(n => n && typeof n.node === 'string')
      .map(n => ({
        instanceId: instance.id, instanceName: instance.name,
        name: n.node, status: n.status ?? 'unknown', cpu: nullable(n.cpu),
        maxcpu: nullable(n.maxcpu), mem: nullable(n.mem),
        maxmem: nullable(n.maxmem), uptime: nullable(n.uptime)
      }));
    const active = nodes.filter(n => n.status === 'online');
    const requests = active.flatMap(node => (['qemu', 'lxc'] as const).map(async kind => {
      const guests = await requestData<PveGuest[]>(instance, '/nodes/' + encodeURIComponent(node.name) + '/' + kind);
      if (!Array.isArray(guests)) throw new Error('Unexpected Proxmox guest response');
      return guests.flatMap(g => {
        const vmid = g ? parseVmid(g.vmid) : null;
        if (vmid === null) return [];
        return [{
          instanceId: instance.id, instanceName: instance.name,
          vmid, name: g.name || kind.toUpperCase() + ' ' + vmid,
          node: node.name, kind, status: g.status ?? 'unknown',
          cpu: nullable(g.cpu), mem: nullable(g.mem),
          maxmem: nullable(g.maxmem), template: Boolean(g.template)
        }];
      });
    }));
    const results = await Promise.allSettled(requests);
    const guests: ProxmoxGuest[] = results
      .filter((r): r is PromiseFulfilledResult<ProxmoxGuest[]> => r.status === 'fulfilled')
      .flatMap(r => r.value).sort((a, b) => a.vmid - b.vmid);
    const errors = results.filter(r => r.status === 'rejected').length;
    return {
      id: instance.id, name: instance.name,
      state: errors ? 'partial' : 'online', checkedAt, nodes, guests,
      ...(errors ? { error: errors + ' guest lists could not be read (check permissions).' } : {})
    };
  } catch (error) {
    return {
      id: instance.id, name: instance.name, state: 'error', checkedAt,
      nodes: [], guests: [],
      error: error instanceof Error ? error.message : 'Proxmox discovery failed'
    };
  }
}

async function discover(): Promise<ProxmoxInventory> {
  const checkedAt = new Date().toISOString();
  let configs: ProxmoxInstanceConfig[];
  try {
    configs = loadProxmoxConfigs();
  } catch (error) {
    return {
      configured: true, state: 'error', checkedAt,
      instances: [], nodes: [], guests: [],
      error: error instanceof Error ? error.message : 'Invalid Proxmox configuration'
    };
  }
  if (!configs.length) {
    return { configured: false, state: 'disabled', checkedAt: null, instances: [], nodes: [], guests: [] };
  }

  // Credential lookup and Proxmox discovery are isolated per installation.
  // One missing secret must not prevent the other Proxmox installation loading.
  const instances = await Promise.all(configs.map(async config => {
    try {
      const tokenSecret = config.tokenSecret ??
        await getInfisicalSecret(config.tokenSecretRef!);
      return await discoverInstance({ ...config, tokenSecret });
    } catch {
      return {
        id: config.id,
        name: config.name,
        state: 'error' as const,
        checkedAt: new Date().toISOString(),
        nodes: [],
        guests: [],
        error: 'Could not retrieve the Proxmox credential from Infisical.'
      };
    }
  }));
  try {
    synchronizeInstances(instances);
  } catch {
    return {
      configured: true, state: 'error', checkedAt,
      instances, nodes: instances.flatMap(i => i.nodes),
      guests: instances.flatMap(i => i.guests),
      error: 'Could not save discovered inventory to SQLite'
    };
  }
  const healthy = instances.filter(i => i.state === 'online').length;
  const failed = instances.filter(i => i.state === 'error').length;
  return {
    configured: true,
    state: failed === instances.length ? 'error' : failed > 0 || healthy !== instances.length ? 'partial' : 'online',
    checkedAt,
    instances,
    nodes: instances.flatMap(i => i.nodes),
    guests: instances.flatMap(i => i.guests)
  };
}

export function getProxmoxInventory(force = false): Promise<ProxmoxInventory> {
  if (!force && cached && Date.now() - cacheTime < cacheMs) return Promise.resolve(cached);
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
