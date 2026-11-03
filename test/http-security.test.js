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
// The admin's session cookie, set up in before().
let cookie = '';
const ADMIN = { full_name: 'HTTP Test Admin', username: 'httpadmin', password: 'http-admin-pass' };

function cookieFrom(response) {
  const header = typeof response.headers.get === 'function'
    ? response.headers.get('set-cookie')
    : [].concat(response.headers['set-cookie'] || []).join(', ');
  return String(header || '').split(';')[0];
}

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
      headers: { Cookie: cookie, ...headers },
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
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: { Cookie: cookie, ...(options.headers || {}) },
  });
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
      NETFARE_UPDATE_FEED: 'off',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
  await waitForHealth();
  const setup = await fetch(`${baseUrl}/api/auth/setup`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify(ADMIN),
  });
  assert.equal(setup.status, 201, 'admin setup');
  cookie = cookieFrom(setup);
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
  const response = await fetch(`${baseUrl}/api/admin/backup/database`, { headers: { Cookie: cookie } });
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

async function postAs(sessionCookie, pathname, body, method = 'POST') {
  return jsonRequest(pathname, {
    method,
    headers: { Origin: baseUrl, 'Content-Type': 'application/json', Cookie: sessionCookie },
    body: JSON.stringify(body),
  });
}

async function signIn(username, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { status: response.status, cookie: cookieFrom(response), setCookie: response.headers.get('set-cookie'), data: await response.json() };
}

test('the API needs a signed-in user; health and sign-in stay open', async () => {
  for (const pathname of ['/api/settings', '/api/invoices', '/api/admin/backups', '/api/users']) {
    const anonymous = await jsonRequest(pathname, { headers: { Cookie: '' } });
    assert.equal(anonymous.status, 401, `${pathname} needs sign-in`);
  }
  const forged = await jsonRequest('/api/settings', { headers: { Cookie: `netfare_session_${port}=not-a-real-token` } });
  assert.equal(forged.status, 401);
  assert.equal((await jsonRequest('/api/health', { headers: { Cookie: '' } })).status, 200);
  const status = await jsonRequest('/api/auth/status', { headers: { Cookie: '' } });
  assert.deepEqual(status.data, { setup_needed: false, user: null });
  const again = await postAs('', '/api/auth/setup', { full_name: 'Second', username: 'second', password: 'second-pass' });
  assert.equal(again.status, 400, 'setup runs only once');
});

test('sign-in sets a strict HttpOnly cookie, wrong passwords lock the user, sign-out ends the session', async () => {
  const created = await postAs(cookie, '/api/users', { full_name: 'Lock Test', username: 'locktest', password: 'lock-pass-1' });
  assert.equal(created.status, 201);

  const good = await signIn('LockTest', 'lock-pass-1');
  assert.equal(good.status, 200);
  assert.match(good.setCookie, new RegExp(`^netfare_session_${port}=`));
  assert.match(good.setCookie, /HttpOnly/);
  assert.match(good.setCookie, /SameSite=Strict/);
  assert.equal((await jsonRequest('/api/settings', { headers: { Cookie: good.cookie } })).status, 200);

  const signedOut = await postAs(good.cookie, '/api/auth/logout', {});
  assert.equal(signedOut.status, 200);
  assert.equal((await jsonRequest('/api/settings', { headers: { Cookie: good.cookie } })).status, 401);

  const unknown = await signIn('nobody', 'whatever-1');
  assert.equal(unknown.status, 400);
  assert.match(unknown.data.error, /Wrong username or password/);
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    assert.match((await signIn('locktest', 'wrong-pass')).data.error, /Wrong username or password/);
  }
  assert.match((await signIn('locktest', 'wrong-pass')).data.error, /Too many wrong attempts/);
  assert.match((await signIn('locktest', 'lock-pass-1')).data.error, /Too many wrong attempts/, 'locked even with the right password');
});

test('staff cannot manage users or data; disabling or a new password ends their sessions', async () => {
  const created = await postAs(cookie, '/api/users', { full_name: 'Desk Staff', username: 'desk', password: 'desk-pass-1', permissions: { sales: 'edit' } });
  assert.equal(created.status, 201);
  const staffSignIn = await signIn('desk', 'desk-pass-1');
  const staffSettings = await jsonRequest('/api/settings', { headers: { Cookie: staffSignIn.cookie } });
  assert.equal(staffSettings.status, 200);
  assert.ok('company_name' in staffSettings.data);
  for (const key of ['backup_mirror_dir', 'update_feed', 'lan_enabled', 'lan_hosts']) {
    assert.ok(!(key in staffSettings.data), `staff do not see ${key}`);
  }
  assert.ok('update_feed' in (await jsonRequest('/api/settings', { headers: { Cookie: cookie } })).data, 'the admin does');
  const duplicate = await postAs(cookie, '/api/users', { full_name: 'Other', username: 'DESK', password: 'desk-pass-2' });
  assert.equal(duplicate.status, 400);
  const weak = await postAs(cookie, '/api/users', { full_name: 'Weak', username: 'weak', password: 'short' });
  assert.equal(weak.status, 400);

  let staff = await signIn('desk', 'desk-pass-1');
  for (const pathname of ['/api/users', '/api/admin/backups', '/api/admin/backup/database']) {
    assert.equal((await jsonRequest(pathname, { headers: { Cookie: staff.cookie } })).status, 403, `${pathname} is admin only`);
  }
  assert.equal((await postAs(staff.cookie, '/api/admin/reset', { confirm: 'RESET' })).status, 403);
  assert.equal((await jsonRequest('/api/invoices', { headers: { Cookie: staff.cookie } })).status, 200);

  const changed = await postAs(staff.cookie, '/api/auth/password', { current_password: 'desk-pass-1', new_password: 'desk-pass-9' });
  assert.equal(changed.status, 200);
  assert.equal((await jsonRequest('/api/invoices', { headers: { Cookie: staff.cookie } })).status, 200, 'this browser stays signed in');

  const reset = await postAs(cookie, `/api/users/${created.data.id}/password`, { password: 'desk-pass-new' });
  assert.equal(reset.status, 200);
  assert.equal((await jsonRequest('/api/invoices', { headers: { Cookie: staff.cookie } })).status, 401, 'a new password ends their sessions');

  staff = await signIn('desk', 'desk-pass-new');
  const disabled = await postAs(cookie, `/api/users/${created.data.id}`, { is_active: false }, 'PUT');
  assert.equal(disabled.status, 200);
  assert.equal((await jsonRequest('/api/invoices', { headers: { Cookie: staff.cookie } })).status, 401);
  assert.match((await signIn('desk', 'desk-pass-new')).data.error, /disabled/);

  const admin = (await jsonRequest('/api/users')).data.find((user) => user.is_admin);
  assert.equal((await postAs(cookie, `/api/users/${admin.id}`, { is_active: false }, 'PUT')).status, 400, 'the admin cannot be disabled');

  const audit = await jsonRequest('/api/audit-logs?entity_type=user');
  const rows = audit.data.rows || audit.data;
  const disable = rows.find((row) => row.action === 'disable' && row.entity_number === 'desk');
  assert.ok(disable, 'disabling is in the audit log');
  assert.equal(disable.user_name, ADMIN.full_name, 'with the name of who did it');
});

test('npm run reset-admin gives a one-time password that must be changed first', async () => {
  const { execFileSync } = require('node:child_process');
  const output = execFileSync(process.execPath, ['scripts/reset-admin.js'], {
    cwd: ROOT,
    env: { ...process.env, LEDGERLY_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  const oneTime = /One-time password: (\S+)/.exec(output)?.[1];
  assert.ok(oneTime, output);
  assert.match(output, new RegExp(`Admin username: ${ADMIN.username}`));
  assert.equal((await jsonRequest('/api/settings')).status, 401, 'the old admin session has ended');

  const admin = await signIn(ADMIN.username, oneTime);
  assert.equal(admin.status, 200);
  assert.equal(admin.data.user.must_change_password, true);
  const blocked = await jsonRequest('/api/settings', { headers: { Cookie: admin.cookie } });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'password_change_required');

  const changed = await postAs(admin.cookie, '/api/auth/password', { current_password: oneTime, new_password: 'http-admin-pass-2' });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.user.must_change_password, false);
  assert.equal((await jsonRequest('/api/settings', { headers: { Cookie: admin.cookie } })).status, 200);
  cookie = admin.cookie;
});

test('rights: view, edit and void are enforced per area and changes apply at once', async () => {
  const created = await postAs(cookie, '/api/users', {
    full_name: 'Rights Staff', username: 'rights', password: 'rights-pass-1',
    permissions: { bookings: 'edit', sales: 'view', reports: 'edit', made_up: 'edit' },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.permissions, { bookings: 'edit', sales: 'view' }, 'Edit is refused for view-only Reports and unknown areas are dropped');
  const staff = await signIn('rights', 'rights-pass-1');
  const get = async (pathname) => (await jsonRequest(pathname, { headers: { Cookie: staff.cookie } }));

  assert.equal((await get('/api/bookings')).status, 200);
  assert.equal((await get('/api/invoices')).status, 200, 'View on invoices');
  assert.equal((await get('/api/settings')).status, 200, 'pickers stay readable');
  const bills = await get('/api/bills');
  assert.equal(bills.status, 403);
  assert.equal(bills.data.code, 'no_right');
  assert.match(bills.data.error, /View rights for Suppliers/);
  assert.equal((await get('/api/reports/trial-balance')).status, 403);
  assert.equal((await get('/api/audit-logs')).status, 403);

  const customer = (await jsonRequest('/api/customers')).data[0]
    || (await postAs(cookie, '/api/customers', { name: 'Rights Customer' })).data;
  const accounts = (await jsonRequest('/api/accounts')).data;
  const booking = await postAs(staff.cookie, '/api/bookings', {
    customer_id: customer.id, booking_date: '2026-11-02', due_date: '2026-11-02', destination: 'Rights test',
    sale_items: [{ description: 'Pax', quantity: 1, unit_price_cents: 10_000, account_id: accounts.find((a) => a.code === '4000').id }],
  });
  assert.equal(booking.status, 201, 'Edit on bookings');
  const invoice = await postAs(staff.cookie, '/api/invoices', { customer_id: customer.id });
  assert.equal(invoice.status, 403, 'View only on invoices');
  assert.match(invoice.data.error, /Edit rights for Invoices/);
  const removed = await jsonRequest(`/api/bookings/${booking.data.id}`, { method: 'DELETE', headers: { Origin: baseUrl, Cookie: staff.cookie } });
  assert.equal(removed.status, 403, 'deleting needs the void right');
  assert.match(removed.data.error, /void, cancel or delete/);

  const granted = await postAs(cookie, `/api/users/${created.data.id}`, { permissions: { bookings: 'edit', void: true } }, 'PUT');
  assert.equal(granted.status, 200);
  const again = await jsonRequest(`/api/bookings/${booking.data.id}`, { method: 'DELETE', headers: { Origin: baseUrl, Cookie: staff.cookie } });
  assert.equal(again.status, 200, 'new rights apply without signing in again');
  assert.equal((await get('/api/customer-balances')).status, 403, 'and removed rights are gone at once');
  assert.equal((await get('/api/invoices')).status, 200, 'bookings still show their invoices');
  assert.equal((await get('/api/journal-entries')).status, 403, 'but not the whole journal');

  const admin = (await jsonRequest('/api/users')).data.find((user) => user.is_admin);
  assert.equal(admin.permissions, null, 'the admin has every right');
  assert.equal((await postAs(cookie, `/api/users/${admin.id}`, { permissions: {} }, 'PUT')).status, 400);
  const audit = await jsonRequest('/api/audit-logs?entity_type=user&action=rights');
  const rows = audit.data.rows || audit.data;
  assert.ok(rows.some((row) => row.entity_number === 'rights' && /Bookings: Edit/.test(row.remarks) && /Void/.test(row.remarks)));
});

test('two people editing the same record: the older copy is refused, not saved over', async () => {
  const customers = (await jsonRequest('/api/customers')).data;
  const customer = customers[0] || (await postAs(cookie, '/api/customers', { name: 'Version Customer' })).data;
  const accounts = (await jsonRequest('/api/accounts')).data;
  const created = await postAs(cookie, '/api/bookings', {
    customer_id: customer.id, booking_date: '2026-11-02', due_date: '2026-11-02', destination: 'Version test',
    sale_items: [{ description: 'Pax', quantity: 1, unit_price_cents: 10_000, account_id: accounts.find((a) => a.code === '4000').id }],
  });
  assert.equal(created.status, 201);
  const loaded = (await jsonRequest(`/api/bookings/${created.data.id}`)).data;
  const put = (version, destination) => jsonRequest(`/api/bookings/${created.data.id}`, {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json', ...(version ? { 'X-Record-Version': version } : {}) },
    body: JSON.stringify({ ...loaded, destination }),
  });

  // Make sure the second save lands in a later second than the first load.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const first = await put(loaded.updated_at, 'Saved by the first person');
  assert.equal(first.status, 200);
  const second = await put(loaded.updated_at, 'Saved by the second person');
  assert.equal(second.status, 409);
  assert.equal(second.data.code, 'record_changed');
  assert.equal((await jsonRequest(`/api/bookings/${created.data.id}`)).data.destination, 'Saved by the first person');
  const fresh = (await jsonRequest(`/api/bookings/${created.data.id}`)).data;
  assert.equal((await put(fresh.updated_at, 'After reopening')).status, 200, 'a fresh copy saves');
  assert.equal((await put(null, 'A script without a version')).status, 200);

  const customerBefore = (await jsonRequest('/api/customers')).data.find((row) => row.id === customer.id);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const renamed = await jsonRequest(`/api/customers/${customer.id}`, {
    method: 'PUT', headers: { Origin: baseUrl, 'Content-Type': 'application/json', 'X-Record-Version': customerBefore.updated_at },
    body: JSON.stringify({ notes: 'first' }),
  });
  assert.equal(renamed.status, 200);
  assert.notEqual(renamed.data.updated_at, customerBefore.updated_at, 'customers now record their edit time');
  const stale = await jsonRequest(`/api/customers/${customer.id}`, {
    method: 'PUT', headers: { Origin: baseUrl, 'Content-Type': 'application/json', 'X-Record-Version': customerBefore.updated_at },
    body: JSON.stringify({ notes: 'second' }),
  });
  assert.equal(stale.status, 409);
});

test('office network settings are admin-only and apply after a restart', async () => {
  const status = await jsonRequest('/api/admin/network');
  assert.equal(status.status, 200);
  assert.equal(status.data.lan_enabled, false);
  assert.equal(status.data.running_on_network, false);

  const saved = await jsonRequest('/api/admin/network', {
    method: 'PUT',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ lan_enabled: true, lan_hosts: 'Office.tail9.ts.net bad_name' }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.lan_enabled, true);
  assert.deepEqual(saved.data.lan_hosts, ['office.tail9.ts.net']);
  assert.equal(saved.data.running_on_network, false, 'still this computer only until a restart');
  const officeHost = await rawRequest('/api/health', { headers: { Host: `192.168.1.20:${port}` } });
  assert.equal(officeHost.status, 421, 'office names are refused while listening on this computer only');

  const staff = await postAs(cookie, '/api/users', { full_name: 'Net Staff', username: 'netstaff', password: 'net-staff-1', permissions: { settings: 'edit' } });
  assert.equal(staff.status, 201);
  const signedIn = await signIn('netstaff', 'net-staff-1');
  const blocked = await postAs(signedIn.cookie, '/api/admin/network', { lan_enabled: false }, 'PUT');
  assert.equal(blocked.status, 403, 'Company settings Edit does not open the network');

  await jsonRequest('/api/admin/network', {
    method: 'PUT', headers: { Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ lan_enabled: false }),
  });
});

test('new-version notice: admin only, read from the update address', async () => {
  const feedServer = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ version: '99.1.0', released: '2026-12-01', notes: ['A newer Netfare'], page: 'https://example.com/download' }));
  });
  await new Promise((resolve) => feedServer.listen(0, '127.0.0.1', resolve));
  try {
    const off = await jsonRequest('/api/admin/updates');
    assert.equal(off.status, 200);
    assert.equal(off.data.enabled, false);
    assert.equal(off.data.current_version, require('../package.json').version);

    const refused = await jsonRequest('/api/admin/updates', {
      method: 'PUT', headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ feed_url: 'http://example.com/latest.json' }),
    });
    assert.equal(refused.status, 400, 'plain http is refused except on this computer');

    const saved = await jsonRequest('/api/admin/updates', {
      method: 'PUT', headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
      body: JSON.stringify({ feed_url: `http://127.0.0.1:${feedServer.address().port}/latest.json` }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.available, true);
    assert.equal(saved.data.latest.version, '99.1.0');
    assert.equal(saved.data.latest.download_url, 'https://example.com/download', 'falls back to the download page');

    const staff = await postAs(cookie, '/api/users', { full_name: 'Update Staff', username: 'updatestaff', password: 'update-pass-1', permissions: { settings: 'edit', dashboard: 'view' } });
    assert.equal(staff.status, 201);
    const signedIn = await signIn('updatestaff', 'update-pass-1');
    assert.equal((await jsonRequest('/api/admin/updates', { headers: { Cookie: signedIn.cookie } })).status, 403);
    assert.equal((await jsonRequest('/api/health', { headers: { Cookie: '' } })).data.version, require('../package.json').version);
  } finally {
    await jsonRequest('/api/admin/updates', {
      method: 'PUT', headers: { Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ feed_url: '' }),
    });
    feedServer.close();
  }
});

test('created by: each new document carries the signed-in name, and the DSR groups sales by staff', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const made = await postAs(cookie, '/api/users', {
    full_name: 'Sara Counter', username: 'sara', password: 'sara-pass-1',
    permissions: { bookings: 'edit', sales: 'edit', customers: 'view', reports: 'view', books: 'view' },
  });
  assert.equal(made.status, 201);
  const sara = await signIn('sara', 'sara-pass-1');
  const customer = (await jsonRequest('/api/customers')).data[0];
  const accounts = (await jsonRequest('/api/accounts')).data;
  const vendor = (await jsonRequest('/api/vendors')).data[0]
    || (await postAs(cookie, '/api/vendors', { name: 'Staff Test Airline' })).data;
  const booking = await postAs(sara.cookie, '/api/bookings', {
    customer_id: customer.id, booking_date: today, due_date: today, destination: 'Staff test',
    sale_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 20_000, account_id: accounts.find((a) => a.code === '4000').id }],
    cost_items: [{ description: 'Ticket', quantity: 1, unit_price_cents: 15_000, account_id: accounts.find((a) => a.code === '5000').id, vendor_id: vendor.id }],
  });
  assert.equal(booking.status, 201);
  assert.equal(booking.data.created_by, 'Sara Counter');
  const confirmed = await postAs(sara.cookie, `/api/bookings/${booking.data.id}/confirm`, {});
  assert.equal(confirmed.status, 200);

  const invoice = (await jsonRequest(`/api/invoices/${confirmed.data.invoice_id}`, { headers: { Cookie: sara.cookie } })).data;
  assert.equal(invoice.created_by, 'Sara Counter');
  const entry = (await jsonRequest(`/api/journal-entries/${invoice.journal_entry_id}`, { headers: { Cookie: sara.cookie } })).data;
  assert.equal(entry.created_by, 'Sara Counter', 'postings carry the name too');
  const adminBooking = await postAs(cookie, '/api/bookings', {
    customer_id: customer.id, booking_date: today, due_date: today, destination: 'Admin test',
    sale_items: [{ description: 'Hotel', quantity: 1, unit_price_cents: 5_000, account_id: accounts.find((a) => a.code === '4000').id }],
  });
  assert.equal(adminBooking.data.created_by, ADMIN.full_name);

  const dsr = (await jsonRequest(`/api/reports/daily-sales?from=${today}&to=${today}`)).data;
  const saraRow = dsr.staff_totals.find((row) => row.staff === 'Sara Counter');
  assert.ok(saraRow, 'Sara has her own line in Sales by staff');
  assert.equal(saraRow.sales, 1);
  assert.equal(saraRow.sale_cents, 20_000);
  assert.ok(dsr.sections.tickets.some((row) => row.id === invoice.id && row.staff === 'Sara Counter'));

  const onlySara = (await jsonRequest(`/api/reports/daily-sales?from=${today}&to=${today}&staff=${encodeURIComponent('Sara Counter')}`)).data;
  assert.equal(onlySara.staff, 'Sara Counter');
  assert.ok(onlySara.sections.tickets.every((row) => row.staff === 'Sara Counter'));
  assert.equal(onlySara.totals.sale_cents, 20_000);
  assert.deepEqual(onlySara.staff_totals, dsr.staff_totals, 'the staff summary always covers everyone');
});

test('second copy of backups: admin only, copies at once, Copy now works', async () => {
  const place = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-http-mirror-'));
  try {
    const staff = await signIn('sara', 'sara-pass-1');
    assert.equal((await jsonRequest('/api/admin/backup-mirror', { headers: { Cookie: staff.cookie } })).status, 403);
    const bad = await jsonRequest('/api/admin/backup-mirror', {
      method: 'PUT', headers: { Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: 'not/absolute' }),
    });
    assert.equal(bad.status, 400);
    const saved = await jsonRequest('/api/admin/backup-mirror', {
      method: 'PUT', headers: { Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: place }),
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.dir, place);
    assert.equal(saved.data.copies, 1, 'the first copy is made straight away');
    const copied = await jsonRequest('/api/admin/backup-mirror/copy', { method: 'POST', headers: { Origin: baseUrl, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(copied.status, 200);
    assert.equal(copied.data.copies, 2);
    const off = await jsonRequest('/api/admin/backup-mirror', {
      method: 'PUT', headers: { Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ dir: '' }),
    });
    assert.equal(off.data.dir, '');
  } finally {
    fs.rmSync(place, { recursive: true, force: true });
  }
});
