'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');

const ROOT = path.join(__dirname, '..');
let serverProcess;
let dataDir;
let port;
let baseUrl;
let serverOutput = '';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy at ${baseUrl}\n${serverOutput}`);
}

function rawRequest(pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function jsonRequest(pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { status: response.status, data };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-http-security-'));
  port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      LEDGERLY_DATA_DIR: dataDir,
      LEDGERLY_AUTO_BACKUP_HOURS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
  await waitForHealth();
});

after(async () => {
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await Promise.race([
      once(serverProcess, 'exit'),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (serverProcess.exitCode === null) serverProcess.kill('SIGKILL');
  }
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});

test('Host header allowlist blocks DNS rebinding', async () => {
  const response = await rawRequest('/api/admin/backup', {
    headers: { Host: `attacker.example:${port}` },
  });
  assert.equal(response.status, 421);
  assert.match(response.body, /Misdirected request/i);

  const health = await rawRequest('/api/health', {
    headers: { Host: `127.0.0.1:${port}` },
  });
  assert.equal(health.status, 200);
});

test('mutating requests are blocked cross-origin and without JSON or binary content', async () => {
  const crossOrigin = await jsonRequest('/api/compliance/run-due', {
    method: 'POST',
    headers: { Origin: 'https://evil.example', 'Content-Type': 'text/plain' },
    body: 'x',
  });
  assert.equal(crossOrigin.status, 403);

  const plainText = await jsonRequest('/api/compliance/run-due', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'x',
  });
  assert.equal(plainText.status, 415);

  const allowed = await jsonRequest('/api/compliance/run-due', {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(allowed.status, 200);
});

test('run-due ignores a client-supplied today date', async () => {
  const headers = { Origin: baseUrl, 'Content-Type': 'application/json' };
  const accounts = await jsonRequest('/api/accounts');
  const expense = accounts.data.find((account) => account.code === '5000');
  assert.ok(expense, 'default expense account exists');

  const vendor = await jsonRequest('/api/vendors', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'N2 Future Vendor' }),
  });
  assert.equal(vendor.status, 201);

  const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const item = await jsonRequest('/api/compliance', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: 'N2 future recurring bill',
      kind: 'recurring_bill',
      vendor_id: vendor.data.id,
      account_id: expense.id,
      amount_cents: 10_000,
      frequency: 'monthly',
      anchor_date: future,
      next_due_date: future,
      auto_create_bill: true,
    }),
  });
  assert.equal(item.status, 201);

  const run = await jsonRequest('/api/compliance/run-due', {
    method: 'POST',
    headers,
    body: JSON.stringify({ today: '2099-01-01' }),
  });
  assert.equal(run.status, 200);
  assert.equal(run.data.generated.length, 0);

  const refreshed = await jsonRequest(`/api/compliance/${item.data.id}`);
  assert.equal(refreshed.status, 200);
  assert.equal(refreshed.data.next_due_date, future);
  assert.ok(!refreshed.data.last_generated_date);
});

test('downloads use temporary copies and do not consume backup slots', async () => {
  const before = await jsonRequest('/api/admin/backups');
  const response = await fetch(`${baseUrl}/api/admin/backup/database`);
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.match(bytes.subarray(0, 16).toString('utf8'), /^SQLite format 3/);
  const after = await jsonRequest('/api/admin/backups');
  assert.equal(after.data.length, before.data.length);
});

test('a refused demo load does not create a backup', async () => {
  const first = await jsonRequest('/api/admin/demo', {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(first.status, 201);
  const afterLoad = await jsonRequest('/api/admin/backups');

  const refused = await jsonRequest('/api/admin/demo', {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(refused.status, 400);
  const afterRefused = await jsonRequest('/api/admin/backups');
  assert.equal(afterRefused.data.length, afterLoad.data.length);
});

test('currency cannot be changed away from AED', async () => {
  const response = await jsonRequest('/api/settings', {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ currency: 'USD' }),
  });
  assert.equal(response.status, 400);
  assert.match(String(response.data.error), /AED/);

  const settings = await jsonRequest('/api/settings');
  assert.equal(settings.data.currency, 'AED');
});

test('other sites and local ports cannot read the API, and nothing is embeddable cross-origin', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const backup = await rawRequest('/api/admin/backup', { headers: { 'Sec-Fetch-Site': site } });
    assert.equal(backup.status, 403, `${site} backup download is blocked`);
    const attachment = await rawRequest('/api/attachments/1/download', { headers: { 'Sec-Fetch-Site': site, 'Sec-Fetch-Dest': 'image' } });
    assert.equal(attachment.status, 403, `${site} attachment probe is blocked`);
  }
  for (const site of ['same-origin', 'none']) {
    const health = await rawRequest('/api/health', { headers: { 'Sec-Fetch-Site': site } });
    assert.equal(health.status, 200, `${site} is allowed`);
  }
  const page = await rawRequest('/');
  assert.equal(page.headers['cross-origin-resource-policy'], 'same-origin');
  const api = await rawRequest('/api/health');
  assert.equal(api.headers['cross-origin-resource-policy'], 'same-origin');
});
