'use strict';

// Office network mode: which addresses and names may reach Netfare.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, after } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-network-test-'));
process.env.LEDGERLY_DATA_DIR = tempDir;

const db = require('../server/db');
const network = require('../server/network');
const { hostGuard, apiGuard } = require('../server/security');

after(() => {
  network.setRunning('127.0.0.1', 4173);
  try { db.close(); } catch { /* ignore */ }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function guard(middleware, { host, origin, method = 'GET' }) {
  let status = 0;
  const req = {
    method,
    path: '/api/settings',
    headers: { 'content-type': 'application/json' },
    get: (name) => ({ host, origin }[name.toLowerCase()]),
    is: () => true,
  };
  const res = { status(code) { status = code; return this; }, json() { return this; }, type() { return this; }, send() { return this; } };
  let passed = false;
  middleware(req, res, () => { passed = true; });
  return passed ? 'pass' : status;
}

test('office addresses: loopback, private LAN, Tailscale and link-local only', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:192.168.1.20', '10.0.0.5', '172.16.4.2', '172.31.255.1',
    '192.168.0.9', '100.101.102.103', 'fd7a:115c:a1e0::1', 'fe80::1', '169.254.3.4']) {
    assert.equal(network.isOfficeAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '203.0.113.9', '::ffff:1.2.3.4', '2001:db8::1', '', 'nonsense']) {
    assert.equal(network.isOfficeAddress(address), false, address);
  }
});

test('names added by the admin are cleaned', () => {
  assert.deepEqual(
    network.cleanHostList(' Office-Mac.tail1234.ts.net, http://desk.local:4173/x  bad_name!  '),
    ['office-mac.tail1234.ts.net', 'desk.local'],
  );
});

test('this-computer mode accepts only localhost names, even in office mode settings', () => {
  db.prepare("UPDATE settings SET lan_enabled = 1, lan_hosts = 'office.tail1.ts.net' WHERE id = 1").run();
  network.setRunning('127.0.0.1', 4173);
  const extra = (hostname) => network.isOfficeHostname(db, hostname);
  const hosts = hostGuard({ extra });
  assert.equal(guard(hosts, { host: '127.0.0.1:4173' }), 'pass');
  assert.equal(guard(hosts, { host: '192.168.1.20:4173' }), 421, 'not until Netfare listens on the network');
});

test('office mode accepts office IPs, this computer and added names, never other names', () => {
  network.setRunning('0.0.0.0', 4173);
  const extra = (hostname) => network.isOfficeHostname(db, hostname);
  const hosts = hostGuard({ extra });
  const ownName = os.hostname().toLowerCase().replace(/\.local$/, '');
  for (const host of ['127.0.0.1:4173', '192.168.1.20:4173', '100.70.1.2:4173', '[fd7a:115c:a1e0::5]:4173',
    'office.tail1.ts.net:4173', `${ownName}.local:4173`]) {
    assert.equal(guard(hosts, { host }), 'pass', host);
  }
  for (const host of ['evil.example:4173', '8.8.8.8:4173', 'office.tail1.ts.net.evil.example:4173']) {
    assert.equal(guard(hosts, { host }), 421, host);
  }
  const api = apiGuard({ port: 4173, extra });
  assert.equal(guard(api, { method: 'POST', host: '192.168.1.20:4173', origin: 'http://192.168.1.20:4173' }), 'pass');
  assert.equal(guard(api, { method: 'POST', host: '192.168.1.20:4173', origin: 'http://192.168.1.20:9999' }), 403, 'another port');
  assert.equal(guard(api, { method: 'POST', host: '192.168.1.20:4173', origin: 'http://evil.example:4173' }), 403);
  assert.ok(network.connectAddresses(db).some((address) => address.url === 'http://office.tail1.ts.net:4173'));
});
