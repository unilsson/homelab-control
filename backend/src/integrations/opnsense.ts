import { readFileSync } from 'node:fs';
import https from 'node:https';
import { getInfisicalSecret } from './infisical.js';

export type DhcpLease = {
  ip: string;
  mac: string | null;
  hostname: string | null;
  interface: string | null;
  state: string | null;
  starts: string | null;
  ends: string | null;
  type: string | null;
  status: string | null;
  description: string | null;
  manufacturer: string | null;
  isStatic: boolean;
};

export type OpnsenseConfig = {
  url: string;
  apiKeyRef: string;
  apiSecretRef: string;
  caPath?: string;
};

export type OpnsenseStatus = {
  configured: boolean;
  state: 'disabled' | 'idle' | 'online' | 'error';
  lastCheckedAt: string | null;
  message?: string;
};

let checkedAt: string | null = null;
let lastState: 'idle' | 'online' | 'error' = 'idle';

export function loadOpnsenseConfig(): OpnsenseConfig {
  const url = process.env.LANSCAN_OPNSENSE_URL?.trim() ?? '';
  const apiKeyRef = process.env.LANSCAN_OPNSENSE_API_KEY_REF?.trim() ?? '';
  const apiSecretRef = process.env.LANSCAN_OPNSENSE_API_SECRET_REF?.trim() ?? '';
  const caPath = process.env.LANSCAN_OPNSENSE_CA_PATH?.trim() || undefined;

  if (!url || !apiKeyRef || !apiSecretRef) {
    throw new Error('OPNsense requires an HTTPS URL and two Infisical secret references.');
  }

  try {
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
        endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
        endpoint.hostname.includes('%')) throw new Error('Invalid URL');
  } catch {
    throw new Error('OPNsense requires a trusted HTTPS origin.');
  }

  if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(apiKeyRef) ||
      !/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(apiSecretRef) ||
      apiKeyRef === apiSecretRef) {
    throw new Error('Invalid OPNsense Infisical secret references.');
  }
  // The CA path points only to mounted administrator-supplied PUBLIC certificates.
  if (caPath && (!caPath.startsWith('/app/certs/') || caPath.includes('..'))) {
    throw new Error('OPNsense CA certificate must be located under /app/certs.');
  }
  return { url, apiKeyRef, apiSecretRef, ...(caPath ? { caPath } : {}) };
}

export function getOpnsenseStatus(): OpnsenseStatus {
  const enabled = process.env.LANSCAN_WITH_OPNSENSE === 'true';
  const configured = enabled && Boolean(
    process.env.LANSCAN_OPNSENSE_URL?.trim() &&
    process.env.LANSCAN_OPNSENSE_API_KEY_REF?.trim() &&
    process.env.LANSCAN_OPNSENSE_API_SECRET_REF?.trim()
  );
  return {
    configured,
    state: !enabled ? 'disabled' : lastState,
    lastCheckedAt: checkedAt,
    ...(!configured && enabled ? { state: 'error' as const, message: 'OPNsense is not configured.' }
      : lastState === 'error' ? { message: 'OPNsense DHCP discovery failed; previous LAN snapshot was preserved.' } : {})
  };
}

function textField(value: unknown, maxLength = 300): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return text && text.length <= maxLength ? text : null;
}

function isActive(row: Record<string, unknown>): boolean {
  const state = textField(row.state)?.toLowerCase();
  return !state || !new Set(['abandoned', 'backup', 'declined', 'expired', 'free', 'inactive', 'released']).has(state);
}

function validIPv4(ip: string): boolean {
  const parts = ip.split('.');
  return parts.length === 4 && parts.every(part =>
    /^(0|[1-9][0-9]{0,2})$/.test(part) && Number(part) <= 255
  );
}

/** Parse ISC DHCPv4 lease rows as exposed by OPNsense 26.x. */
export function parseOpnsenseLeases(payload: unknown): DhcpLease[] {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid OPNsense DHCP response.');
  }
  const rows = (payload as Record<string, unknown>).rows;
  if (!Array.isArray(rows) || rows.length > 10_000) {
    throw new Error('Invalid OPNsense DHCP lease list.');
  }
  const unique = new Map<string, DhcpLease>();
  for (const value of rows) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (!isActive(row)) continue;
    const ip = textField(row.address || row.ip);
    if (!ip || !validIPv4(ip)) continue;

    const type = textField(row.type);
    const lease: DhcpLease = {
      ip,
      mac: textField(row.hwaddr || row.mac, 32)?.toLowerCase() ?? null,
      hostname: textField(row.hostname || row['client-hostname'] || row.client_hostname, 160),
      interface: textField(row.if_descr || row.if_name || row['if'] || row.interface, 160),
      state: textField(row.state, 60),
      starts: textField(row.starts || row.start, 80),
      ends: textField(row.ends || row.end, 80),
      type,
      status: textField(row.status, 80),
      description: textField(row.descr || row.description),
      manufacturer: textField(row.man || row.manufacturer, 160),
      isStatic: type?.toLowerCase() === 'static'
    };
    const previous = unique.get(ip);
    if (!previous || lease.isStatic || !previous.isStatic) unique.set(ip, lease);
  }
  return Array.from(unique.values());
}

const responseLimit = 4_000_000;

/** HTTPS with full TLS verification. No redirects, credential URL parameters or raw error leaks. */
export function requestOpnsenseLeases(config: OpnsenseConfig, key: string, secret: string): Promise<DhcpLease[]> {
  return new Promise((resolve, reject) => {
    let ca: Buffer | undefined;
    try {
      if (config.caPath) ca = readFileSync(config.caPath);
    } catch {
      reject(new Error('Cannot read trusted OPNsense CA certificate.'));
      return;
    }
    const endpoint = new URL('/api/dhcpv4/leases/search_lease', config.url);
    endpoint.searchParams.set('current', '1');
    endpoint.searchParams.set('rowCount', '10000');
    endpoint.searchParams.set('searchPhrase', '');

    const authorization = Buffer.from(key + ':' + secret, 'utf8').toString('base64');
    const req = https.request(endpoint, {
      method: 'GET',
      headers: {
        Authorization: 'Basic ' + authorization,
        Accept: 'application/json'
      },
      ...(ca ? { ca } : {}),
      timeout: 8_000
    }, res => {
      if (res.statusCode !== 200) {
        // Do not follow redirects, including those which could expose credentials.
        res.resume();
        reject(new Error('OPNsense DHCP request failed.'));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (part: Buffer) => {
        size += part.length;
        if (size > responseLimit) {
          res.destroy(new Error('OPNsense DHCP response too large.'));
        } else {
          chunks.push(part);
        }
      });
      res.on('error', () => reject(new Error('OPNsense DHCP response interrupted.')));
      res.on('end', () => {
        try {
          resolve(parseOpnsenseLeases(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown));
        } catch {
          reject(new Error('Invalid OPNsense DHCP response.'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('OPNsense DHCP timed out.')));
    req.on('error', () => reject(new Error('Cannot reach OPNsense HTTPS API.')));
    req.end();
  });
}

/** No OPNsense API credentials are persisted. Only the backend sees Infisical values. */
export async function fetchOpnsenseLeases(deps: {
  secretGetter?: (name: string) => Promise<string>;
  request?: (config: OpnsenseConfig, key: string, secret: string) => Promise<DhcpLease[]>;
} = {}): Promise<DhcpLease[]> {
  try {
    const config = loadOpnsenseConfig();
    const getSecret = deps.secretGetter ?? getInfisicalSecret;
    const [key, secret] = await Promise.all([
      getSecret(config.apiKeyRef),
      getSecret(config.apiSecretRef)
    ]);
    const request = deps.request ?? requestOpnsenseLeases;
    const leases = await request(config, key, secret);
    lastState = 'online';
    checkedAt = new Date().toISOString();
    return leases;
  } catch {
    lastState = 'error';
    checkedAt = new Date().toISOString();
    throw new Error('Could not read OPNsense leases via Infisical and HTTPS.');
  }
}
