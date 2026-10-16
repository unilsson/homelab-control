import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';

test('two independent Proxmox servers have isolated inventories and errors', async () => {
  const work = mkdtempSync(join(tmpdir(), 'homelab-proxmox-test-'));
  const key = join(work, 'key.pem');
  const cert = join(work, 'cert.pem');
  const configPath = join(work, 'instances.json');
  const oldConfig = process.env.PROXMOX_INSTANCES_FILE;
  const oldDb = process.env.DATABASE_PATH;
  const servers: https.Server[] = [];

  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-keyout', key, '-out', cert, '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=IP:127.0.0.1'
    ], { stdio: 'ignore' });

    const createServer = (token: string, hostname: string, stringVmids = false) => {
      const server = https.createServer({
        key: readFileSync(key),
        cert: readFileSync(cert)
      }, (req, res) => {
        const expected = 'PVEAPIToken=monitor@pve!discovery=' + token;
        if (req.headers.authorization !== expected) {
          res.writeHead(403);
          res.end();
          return;
        }
        res.setHeader('Content-Type', 'application/json');
        if (req.url === '/api2/json/nodes') {
          res.end(JSON.stringify({ data: [{ node: hostname, status: 'online', cpu: 0.12, mem: 1073741824, maxmem: 8589934592 }] }));
        } else if (req.url === '/api2/json/nodes/' + hostname + '/qemu') {
          // Both installations intentionally use VMID 100.
          res.end(JSON.stringify({ data: [
            { vmid: stringVmids ? '100' : 100, name: 'web', status: 'running' },
            ...(stringVmids ? [{ vmid: 'not-a-vmid', name: 'invalid', status: 'running' }] : [])
          ] }));
        } else if (req.url === '/api2/json/nodes/' + hostname + '/lxc') {
          res.end(JSON.stringify({ data: [
            { vmid: stringVmids ? '200' : 200, name: 'monitor', status: 'stopped' },
            ...(stringVmids ? [{ vmid: '9007199254740992', name: 'out-of-range', status: 'stopped' }] : [])
          ] }));
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      servers.push(server);
      return server;
    };
    const first = createServer('first-secret', 'node-a', true);
    const second = createServer('second-secret', 'node-b');

    for (const server of servers) {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    }

    const portA = (first.address() as AddressInfo).port;
    const portB = (second.address() as AddressInfo).port;
    writeFileSync(configPath, JSON.stringify([
      { id: 'alpha', name: 'Proxmox A', url: 'https://127.0.0.1:' + portA, tokenId: 'monitor@pve!discovery', tokenSecret: 'first-secret', caPath: cert },
      { id: 'beta', name: 'Proxmox B', url: 'https://127.0.0.1:' + portB, tokenId: 'monitor@pve!discovery', tokenSecret: 'second-secret', caPath: cert }
    ]));

    process.env.PROXMOX_INSTANCES_FILE = configPath;
    process.env.DATABASE_PATH = join(work, 'inventory.sqlite');

    const { getProxmoxInventory, loadProxmoxConfigs } = await import('../src/integrations/proxmox.js');
    const { db } = await import('../src/database.js');

    assert.equal(loadProxmoxConfigs().length, 2);
    const inventory = await getProxmoxInventory(true);
    assert.equal(inventory.state, 'online');
    assert.equal(inventory.instances.length, 2);
    assert.equal(inventory.nodes.length, 2);
    assert.equal(inventory.guests.length, 4);
    assert.equal(inventory.guests.filter(g => g.vmid === 100).length, 2);
    assert.equal(inventory.guests.filter(g => g.vmid === 200).length, 2);
    assert.ok(inventory.guests.every(g => typeof g.vmid === 'number'));
    assert.ok(!inventory.guests.some(g => g.name === 'invalid' || g.name === 'out-of-range'));
    assert.deepEqual(inventory.instances[0].guests.map(g => g.vmid).sort((a, b) => a - b), [100, 200]);
    assert.equal(inventory.guests.find(g => g.instanceId === 'alpha')?.instanceName, 'Proxmox A');
    assert.equal(inventory.guests.find(g => g.instanceId === 'beta')?.instanceName, 'Proxmox B');
    assert.ok(!JSON.stringify(inventory).includes('first-secret'));
    assert.ok(!JSON.stringify(inventory).includes('second-secret'));

    const systems = db.prepare("SELECT external_id, status FROM systems WHERE source = 'proxmox'").all() as Array<{ external_id: string; status: string }>;
    assert.equal(systems.length, 6);
    assert.ok(systems.some(s => s.external_id === 'alpha:qemu:100'));
    assert.ok(systems.some(s => s.external_id === 'beta:qemu:100'));

    // Taking one Proxmox server offline does not hide or mark the other offline.
    await new Promise<void>((resolve, reject) => second.close(error => error ? reject(error) : resolve()));
    servers.pop();
    const degraded = await getProxmoxInventory(true);
    assert.equal(degraded.state, 'partial');
    assert.equal(degraded.instances[0].state, 'online');
    assert.equal(degraded.instances[1].state, 'error');
    assert.equal(degraded.guests.length, 2);

    const states = db.prepare("SELECT external_id, status FROM systems WHERE external_id LIKE '%:qemu:100' ORDER BY external_id").all() as Array<{ external_id: string; status: string }>;
    assert.deepEqual(states.map(s => s.status), ['online', 'unknown']);

    // A misconfigured duplicate ID should be rejected before any network calls.
    writeFileSync(configPath, JSON.stringify([
      { id: 'duplicate', name: 'A', url: 'https://127.0.0.1:8006', tokenId: 'a', tokenSecret: 's' },
      { id: 'duplicate', name: 'B', url: 'https://127.0.0.1:8007', tokenId: 'b', tokenSecret: 't' }
    ]));
    assert.throws(() => loadProxmoxConfigs(), /Duplicate Proxmox instance ID/);

    // A secret reference is accepted, but it must not be combined with plaintext.
    writeFileSync(configPath, JSON.stringify([
      { id: 'alpha', name: 'Proxmox A', url: 'https://127.0.0.1:' + portA, tokenId: 'monitor@pve!discovery', tokenSecret: 'first-secret', caPath: cert },
      { id: 'beta', name: 'Proxmox B', url: 'https://127.0.0.1:' + portB, tokenId: 'monitor@pve!discovery', tokenSecretRef: 'PROXMOX_B_TOKEN', caPath: cert }
    ]));
    assert.equal(loadProxmoxConfigs()[1].tokenSecretRef, 'PROXMOX_B_TOKEN');

    // Infisical is deliberately not configured in CI. A missing secret only
    // affects beta; alpha remains available, and tokens never reach the API.
    const withMissingSecret = await getProxmoxInventory(true);
    assert.equal(withMissingSecret.state, 'partial');
    assert.equal(withMissingSecret.instances[0].state, 'online');
    assert.equal(withMissingSecret.instances[1].state, 'error');
    assert.equal(withMissingSecret.instances[1].error, 'Could not retrieve the Proxmox credential from Infisical.');
    assert.ok(!JSON.stringify(withMissingSecret).includes('first-secret'));

    // A config must never ambiguously specify both a local secret and a ref.
    writeFileSync(configPath, JSON.stringify([{
      id: 'alpha', name: 'Proxmox A', url: 'https://127.0.0.1:' + portA,
      tokenId: 'monitor@pve!discovery', tokenSecret: 'unsafe-plaintext',
      tokenSecretRef: 'PROXMOX_A_TOKEN'
    }]));
    assert.throws(() => loadProxmoxConfigs(), /Choose exactly one/);

    db.close();
  } finally {
    for (const server of servers) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    if (oldConfig === undefined) delete process.env.PROXMOX_INSTANCES_FILE;
    else process.env.PROXMOX_INSTANCES_FILE = oldConfig;
    if (oldDb === undefined) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = oldDb;
    rmSync(work, { recursive: true, force: true });
  }
});
