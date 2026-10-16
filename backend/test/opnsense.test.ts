import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { mergeOpnsenseLeases, parseLanSnapshot } from '../src/integrations/lanscan.js';
import {
  fetchOpnsenseLeases, getOpnsenseStatus, loadOpnsenseConfig,
  parseOpnsenseLeases, requestOpnsenseLeases, type DhcpLease
} from '../src/integrations/opnsense.js';

function arpDocument() {
  return {
    schema_version: 1,
    results: Array.from({ length: 254 }, (_, i) => ({
      ip: '192.168.1.' + (i + 1),
      status: i === 0 ? 'used' : i === 1 ? 'conflict' : 'free',
      hostname: null,
      devices: i === 0
        ? [{ mac: '11:22:33:44:55:66', vendor: 'Router' }]
        : i === 1
          ? [{ mac: 'aa:bb:cc:dd:ee:01', vendor: 'Unknown' }, { mac: 'aa:bb:cc:dd:ee:02', vendor: 'Unknown' }]
          : []
    }))
  };
}

const rows = {
  rows: [
    { address: '192.168.1.1', type: 'static', hwaddr: '11:22:33:44:55:66', hostname: 'opnsense', descr: 'Firewall' },
    { address: '192.168.1.2', type: 'dynamic', hwaddr: 'aa:bb:cc:dd:ee:01', hostname: 'conflicting-device' },
    { address: '192.168.1.3', type: 'dynamic', hwaddr: 'aa:bb:cc:dd:ee:03', hostname: 'laptop', state: 'active', man: 'Intel' },
    { address: '192.168.1.4', type: 'dynamic', hostname: 'old', state: 'expired' },
    { address: '192.168.1.4', type: 'static', hwaddr: 'aa:bb:cc:dd:ee:04', hostname: 'printer', descr: 'Office printer' },
    { address: '192.168.1.254', type: 'static', hostname: 'last-reservation' },
    { address: '10.0.0.5', type: 'static', hostname: 'outside-network' },
    { address: '192.168.1.6', type: 'dynamic', state: 'abandoned' },
    { address: 'not-an-ip', type: 'static' }
  ]
};

test('OPNsense merges live DHCP leases while ARP and conflicts retain precedence', () => {
  const leases = parseOpnsenseLeases(rows);
  assert.equal(leases.length, 6);
  const result = mergeOpnsenseLeases(arpDocument(), '192.168.1.0/24', leases);
  const parsed = parseLanSnapshot(result, '192.168.1.0/24');
  assert.equal(parsed.results.length, 254);
  assert.deepEqual(parsed.summary, {
    total: 254, occupied: 5, used: 1, free: 249,
    leased: 1, reserved: 2, conflicts: 1
  });
  assert.equal(parsed.results[0].status, 'used');
  assert.equal(parsed.results[0].lease?.description, 'Firewall');
  assert.equal(parsed.results[1].status, 'conflict');
  assert.equal(parsed.results[1].devices.length, 2);
  assert.equal(parsed.results[2].status, 'leased');
  assert.equal(parsed.results[2].hostname, 'laptop');
  assert.equal(parsed.results[2].lease?.manufacturer, 'Intel');
  assert.equal(parsed.results[3].status, 'reserved');
  assert.equal(parsed.results[3].lease?.description, 'Office printer');
  assert.equal(parsed.results[4].status, 'free');
  assert.equal(parsed.results[253].status, 'reserved');
  assert.equal(parsed.results.length, new Set(parsed.results.map(r => r.ip)).size);
});

test('OPNsense rejects malformed DHCP response and filters expired allocations', () => {
  assert.throws(() => parseOpnsenseLeases({ unknown: [] }), /Invalid/);
  assert.throws(() => parseOpnsenseLeases([]), /Invalid/);
  const data = parseOpnsenseLeases({
    rows: [
      { address: '192.168.1.10', type: 'dynamic', state: 'released' },
      { address: '192.168.1.11', type: 'static', descr: 'Static reservation' },
      { address: '192.168.1.12', type: 'dynamic', hostname: 'lease' },
      { address: '192.168.1.12', type: 'static', hostname: 'static-wins' }
    ]
  });
  assert.deepEqual(data.map(row => row.ip), ['192.168.1.11', '192.168.1.12']);
  assert.equal(data[1].hostname, 'static-wins');
  assert.equal(data[1].isStatic, true);
});

test('OPNsense config contains only Infisical references and requires HTTPS', () => {
  const keys = [
    'LANSCAN_WITH_OPNSENSE','LANSCAN_OPNSENSE_URL','LANSCAN_OPNSENSE_API_KEY_REF',
    'LANSCAN_OPNSENSE_API_SECRET_REF', 'LANSCAN_OPNSENSE_CA_PATH'
  ] as const;
  const old = keys.map(key => process.env[key]);
  try {
    process.env.LANSCAN_WITH_OPNSENSE = 'true';
    process.env.LANSCAN_OPNSENSE_URL = 'https://opnsense.ulnihnw.net';
    process.env.LANSCAN_OPNSENSE_API_KEY_REF = 'OPNSENSE_API_KEY';
    process.env.LANSCAN_OPNSENSE_API_SECRET_REF = 'OPNSENSE_API_SECRET';
    delete process.env.LANSCAN_OPNSENSE_CA_PATH;
    assert.deepEqual(loadOpnsenseConfig(), {
      url: 'https://opnsense.ulnihnw.net',
      apiKeyRef: 'OPNSENSE_API_KEY',
      apiSecretRef: 'OPNSENSE_API_SECRET'
    });
    assert.equal(getOpnsenseStatus().configured, true);
    process.env.LANSCAN_OPNSENSE_URL = 'http://opnsense.ulnihnw.net';
    assert.throws(() => loadOpnsenseConfig(), /HTTPS/);
    process.env.LANSCAN_OPNSENSE_URL = 'https://user:password@opnsense.ulnihnw.net';
    assert.throws(() => loadOpnsenseConfig(), /HTTPS/);
    process.env.LANSCAN_OPNSENSE_URL = 'https://opnsense.ulnihnw.net';
    process.env.LANSCAN_OPNSENSE_CA_PATH = '/app/secrets/not-a-ca.pem';
    assert.throws(() => loadOpnsenseConfig(), /CA certificate/);
    delete process.env.LANSCAN_OPNSENSE_CA_PATH;
    process.env.LANSCAN_OPNSENSE_API_KEY_REF = 'INVALID-NAME';
    assert.throws(() => loadOpnsenseConfig(), /secret references/);
  } finally {
    keys.forEach((key, i) => old[i] === undefined ? delete process.env[key] : process.env[key] = old[i]);
  }
});

test('OPNsense Infisical lookup uses two refs; secrets never enter the LAN results', async () => {
  const keys = ['LANSCAN_OPNSENSE_URL', 'LANSCAN_OPNSENSE_API_KEY_REF', 'LANSCAN_OPNSENSE_API_SECRET_REF'] as const;
  const old = keys.map(key => process.env[key]);
  try {
    process.env.LANSCAN_OPNSENSE_URL = 'https://opnsense.ulnihnw.net';
    process.env.LANSCAN_OPNSENSE_API_KEY_REF = 'OPNSENSE_API_KEY';
    process.env.LANSCAN_OPNSENSE_API_SECRET_REF = 'OPNSENSE_API_SECRET';
    const queried: string[] = [];
    const result = await fetchOpnsenseLeases({
      secretGetter: async name => {
        queried.push(name);
        return name === 'OPNSENSE_API_KEY' ? 'never-expose-key' : 'never-expose-secret';
      },
      request: async (_config, key, secret) => {
        assert.equal(key, 'never-expose-key');
        assert.equal(secret, 'never-expose-secret');
        return parseOpnsenseLeases(rows);
      }
    });
    assert.deepEqual(queried.sort(), ['OPNSENSE_API_KEY','OPNSENSE_API_SECRET']);
    const inventory = mergeOpnsenseLeases(arpDocument(), '192.168.1.0/24', result);
    assert.ok(!JSON.stringify(inventory).includes('never-expose'));
    assert.ok(!JSON.stringify(getOpnsenseStatus()).includes('never-expose'));
    await assert.rejects(fetchOpnsenseLeases({
      secretGetter: async () => { throw new Error('sensitive-token-in-error'); }
    }), /Could not read OPNsense leases via Infisical and HTTPS/);
    assert.ok(!JSON.stringify(getOpnsenseStatus()).includes('sensitive-token-in-error'));
  } finally {
    keys.forEach((key, i) => old[i] === undefined ? delete process.env[key] : process.env[key] = old[i]);
  }
});

test('OPNsense API verifies TLS and never follows redirects with Basic credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'homelab-opnsense-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  const servers: https.Server[] = [];
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', keyPath, '-out', certPath, '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1'
    ], { stdio: 'ignore' });
    let redirect = false;
    const server = https.createServer({
      key: readFileSync(keyPath), cert: readFileSync(certPath)
    }, (req, res) => {
      assert.equal(req.headers.authorization, 'Basic ' +
        Buffer.from('correct-key:correct-secret').toString('base64'));
      assert.ok(req.url?.startsWith('/api/dhcpv4/leases/search_lease?'));
      if (redirect) {
        res.writeHead(302, { Location: 'https://another.invalid/hijack' });
        res.end();
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(rows));
      }
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'https://127.0.0.1:' + (server.address() as AddressInfo).port;
    const config = { url, apiKeyRef: 'OPNSENSE_API_KEY', apiSecretRef: 'OPNSENSE_API_SECRET', caPath: certPath };
    const result = await requestOpnsenseLeases(config, 'correct-key', 'correct-secret');
    assert.equal(result.length, 6);
    redirect = true;
    await assert.rejects(requestOpnsenseLeases(config, 'correct-key', 'correct-secret'), /DHCP request failed/);
    await assert.rejects(requestOpnsenseLeases({
      ...config, caPath: undefined
    }, 'correct-key', 'correct-secret'), /Cannot reach OPNsense HTTPS API/);
  } finally {
    for (const server of servers) {
      await new Promise<void>(resolve => server.close(resolve));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
