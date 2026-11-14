'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const Database = require('better-sqlite3');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..', '..');
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const AXE_SOURCE = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

// Every API call needs a signed-in user. before() creates the admin; this
// sends its session cookie with the test's own fetch calls to the server.
const E2E_ADMIN = { full_name: 'E2E Admin', username: 'e2eadmin', password: 'e2e-admin-pass' };
const rawFetch = global.fetch;
let sessionCookie = '';
global.fetch = (url, options = {}) => {
  if (!sessionCookie || !String(url).startsWith(baseUrl)) return rawFetch(url, options);
  return rawFetch(url, { ...options, headers: { Cookie: sessionCookie, ...(options.headers || {}) } });
};

function chromePath() {
  const found = CHROME_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('Chrome/Chromium not found. Set CHROME_PATH to run browser tests.');
  }
  return found;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch (error) {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`Server did not become healthy at ${baseUrl}`);
}

async function getJson(baseUrl, endpoint) {
  const response = await fetch(`${baseUrl}${endpoint}`);
  assert.equal(response.status, 200, `${endpoint} should return 200`);
  return response.json();
}

async function postJson(baseUrl, endpoint, body = {}, expectedStatus = 201) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, expectedStatus, `${endpoint} should return ${expectedStatus}`);
  return response.json();
}

function seedListFixtures(dataDir) {
  const db = new Database(path.join(dataDir, 'accounting.db'));
  db.pragma('busy_timeout = 5000');
  try {
    const vendor = db.prepare('SELECT id FROM vendors ORDER BY id LIMIT 1').get();
    const account = db.prepare("SELECT id FROM accounts WHERE code = '6900'").get();
    assert.ok(vendor, 'Demo data should include a vendor');
    assert.ok(account, 'Default chart should include Other Expenses');

    const insertCompliance = db.prepare(`
      INSERT INTO compliance_items
        (name, kind, category, vendor_id, account_id, amount_cents, frequency, next_due_date,
         status, auto_create_bill, reminder_days, notes)
      VALUES (?, 'filing', 'Other', ?, ?, 10000, 'yearly', '2026-12-31', 'active', 0, 14, 'E2E fixture')
    `);
    const insertCheque = db.prepare(`
      INSERT INTO post_dated_cheques
        (vendor_id, cheque_number, cheque_date, amount_cents, bank_name, status, reference, notes)
      VALUES (?, ?, ?, 50000, 'E2E Bank', 'planned', ?, 'E2E fixture')
    `);
    const cash = db.prepare("SELECT id FROM accounts WHERE code = '1000'").get();
    const bank = db.prepare("SELECT id FROM accounts WHERE code = '1010'").get();
    assert.ok(cash && bank, 'Default chart should include cash and bank accounts');

    const storedXss = '<img data-xss src=x onerror="window.__xss = 1">';
    db.prepare('UPDATE bookings SET notes = ?').run(storedXss);
    db.prepare('UPDATE visa_applications SET notes = ?').run(storedXss);

    db.transaction(() => {
      for (let index = 1; index <= 30; index += 1) {
        insertCompliance.run(`E2E compliance ${index}`, vendor.id, account.id);
        const day = String((index % 28) + 1).padStart(2, '0');
        insertCheque.run(vendor.id, `E2E-CHQ-${index}`, `2026-11-${day}`, `E2E-REF-${index}`);
      }
      db.prepare(`
        INSERT INTO cash_deposits
          (number, deposit_date, amount_cents, from_account_id, to_account_id,
           reference, notes, status)
        VALUES ('CD-E2E-1', '2026-10-20', 10000, ?, ?, 'E2E-REF', 'E2E fixture', 'posted')
      `).run(cash.id, bank.id);
      db.prepare(`
        INSERT INTO audit_logs
          (entity_type, entity_number, action, remarks, amount_cents, metadata)
        VALUES ('invoice', 'E2E-AUDIT-1', 'void', 'E2E audit fixture', 10000, '{}')
      `).run();
    })();
  } finally {
    db.close();
  }
}

let serverProcess;
let dataDir;
let baseUrl;
let browser;
let context;
let page;
let consoleErrors = [];

async function openRoute(route) {
  consoleErrors = [];
  const url = `${baseUrl}/?e2e=${Date.now()}#${route}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const view = document.querySelector('#view');
    return view && view.children.length > 0 && !view.querySelector('.loading');
  });
  await page.waitForTimeout(150);
}

async function axeViolations() {
  await page.addStyleTag({
    content: '*, *::before, *::after { transition: none !important; animation: none !important; }',
  });
  await page.waitForTimeout(50);
  await page.evaluate(AXE_SOURCE);
  return page.evaluate(async () => {
    const results = await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.map((node) => ({
        target: node.target,
        summary: node.failureSummary,
      })),
    }));
  });
}

// Period reports open on this month, which can be empty early in a month.
// Widen the period so fixtures dated in earlier months are shown.
async function setReportPeriod(from) {
  const input = page.locator('#report-from');
  if (!(await input.count())) return;
  await input.fill(from);
  await input.dispatchEvent('change');
  await page.waitForFunction(() => !document.querySelector('#report-body .loading'));
  await page.waitForTimeout(250);
}

function yearAgoISO() {
  return new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
}

// Page actions such as Print, Void or Audit chain sit in the "More" menu.
async function clickPageAction(selector) {
  const target = page.locator(`#page-actions ${selector}`).first();
  if (!(await target.isVisible())) await page.locator('#page-actions .more-menu > summary').click();
  await target.click();
}

function assertNoConsoleErrors() {
  assert.deepEqual(consoleErrors, [], `Browser console should have no errors:\n${consoleErrors.join('\n')}`);
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledgerly-e2e-'));
  const port = await freePort();
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

  let serverOutput = '';
  serverProcess.stdout.on('data', (chunk) => { serverOutput += chunk.toString(); });
  serverProcess.stderr.on('data', (chunk) => { serverOutput += chunk.toString(); });
  serverProcess.once('exit', (code) => {
    if (code && code !== 0) serverOutput += `\nServer exited with code ${code}`;
  });

  try {
    await waitForHealth(baseUrl);
    const setup = await fetch(`${baseUrl}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(E2E_ADMIN),
    });
    assert.equal(setup.status, 201, 'Admin account should be created');
    sessionCookie = String(setup.headers.get('set-cookie')).split(';')[0];
    // Save the admin's recovery key now, so the app does not stop to show it.
    for (const step of ['/api/auth/recovery-key', '/api/auth/recovery-key/confirm']) {
      const saved = await fetch(`${baseUrl}${step}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: sessionCookie },
        body: '{}',
      });
      assert.equal(saved.status, 200, `${step} should work`);
    }
    const demoResponse = await fetch(`${baseUrl}/api/admin/demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(demoResponse.status, 201, 'Demo data should load');
    seedListFixtures(dataDir);

    browser = await chromium.launch({
      executablePath: chromePath(),
      headless: true,
      args: process.env.CHROME_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: 'light',
      reducedMotion: 'reduce',
    });
    const [cookieName, ...cookieValue] = sessionCookie.split('=');
    await context.addCookies([{ name: cookieName, value: cookieValue.join('='), url: baseUrl }]);
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
  } catch (error) {
    error.message += `\nServer output:\n${serverOutput}`;
    throw error;
  }
});

after(async () => {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
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

test('app shell, skip link, keyboard row and console health', async () => {
  await openRoute('/dashboard');
  assert.match(await page.title(), /Netfare/);
  // Netfare brand: sidebar logo loads, favicon points at the logo kit.
  const logo = page.locator('.sidebar .brand-logo');
  assert.equal(await logo.getAttribute('alt'), 'Netfare');
  assert.ok(await logo.evaluate((img) => img.complete && img.naturalWidth > 0), 'Sidebar logo loads');
  assert.equal(await page.locator('link[rel="icon"][type="image/svg+xml"]').getAttribute('href'), '/brand/netfare-icon.svg');
  assert.equal(await page.locator('#skip-link').getAttribute('href'), '#view');
  assert.ok(await page.locator('#main-nav [href]').count() >= 10, 'Grouped navigation should be present');
  assertNoConsoleErrors();

  await openRoute('/invoices');
  const row = page.locator('#invoice-body tr[data-id][tabindex="0"]').first();
  await row.waitFor();
  const invoiceId = await row.getAttribute('data-id');
  await row.focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction((id) => location.hash === `#/invoices/${id}`, invoiceId);
  await page.waitForSelector('#view .doc');
  assertNoConsoleErrors();
});

test('stored notes and confirmation messages render as text', async () => {
  const [bookings, visas] = await Promise.all([
    getJson(baseUrl, '/api/bookings'),
    getJson(baseUrl, '/api/visas'),
  ]);

  for (const [route, id] of [[`/bookings/${bookings[0].id}`, bookings[0].id], [`/visas/${visas[0].id}`, visas[0].id]]) {
    await openRoute(route);
    assert.equal(await page.locator('[data-xss]').count(), 0, `${route} must not render stored HTML`);
    // Notes are internal: shown as text in the screen-only box, never in the document.
    assert.match(await page.locator('[data-internal-notes]').innerText(), /<img data-xss/);
    assert.doesNotMatch(await page.locator('.doc-terms').first().innerText(), /data-xss/);
    assert.equal(await page.evaluate(() => window.__xss), undefined);
  }

  const payload = '<img data-xss src=x onerror="window.__xss = 1">';
  const response = await fetch(`${baseUrl}/api/customers`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `XSS customer ${payload}` }),
  });
  assert.equal(response.status, 201);
  const customer = await response.json();

  await openRoute('/customers');
  await page.locator('#party-search').fill('XSS customer');
  await page.waitForTimeout(100);
  await page.locator(`[data-delete="${customer.id}"]`).click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  assert.equal(await dialog.locator('[data-xss]').count(), 0, 'confirm dialog must not render stored HTML');
  assert.match(await dialog.locator('.confirm-text').innerText(), /<img data-xss/);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await page.keyboard.press('Escape');
  assertNoConsoleErrors();
});

test('data tables expose captions and column scopes', async () => {
  const [invoices, bookings, visas, bills, portals, customers] = await Promise.all([
    getJson(baseUrl, '/api/invoices'),
    getJson(baseUrl, '/api/bookings'),
    getJson(baseUrl, '/api/visas'),
    getJson(baseUrl, '/api/bills'),
    getJson(baseUrl, '/api/portals'),
    getJson(baseUrl, '/api/customers'),
  ]);

  const routes = [
    '/bookings',
    '/visas',
    '/customers',
    '/vendors',
    '/portals',
    '/settlement-queue',
    '/customer-balances',
    `/customer-balances/${customers[0].id}`,
    '/invoices',
    '/bills',
    '/journal',
    '/cheques',
    '/compliance',
    '/accounts',
    '/banking',
    '/opening-balances',
    '/audit-logs',
    '/reports/trial-balance',
    '/reports/daily-sales',
    '/reports/booking-margin',
    '/reports/visa-margin',
    '/reports/portal-wallets',
    '/reports/ar-aging',
    `/invoices/${invoices[0].id}`,
    `/bookings/${bookings[0].id}`,
    `/visas/${visas[0].id}`,
    `/bills/${bills[0].id}`,
    `/portals/${portals[0].id}`,
    `/portals/${portals[0].id}/ledger`,
    `/customers/${customers[0].id}/statement`,
  ];

  for (const route of routes) {
    await openRoute(route);
    if (route.startsWith('/reports/')) await setReportPeriod(yearAgoISO());
    const tables = await page.$$eval('#view table', (elements) => elements.map((table) => ({
      caption: table.querySelector('caption')?.textContent?.trim() || '',
      headers: [...table.querySelectorAll('thead th')].map((header) => header.getAttribute('scope')),
    })));
    assert.ok(tables.length > 0, `${route} should render at least one table`);
    for (const table of tables) {
      assert.ok(table.caption, `${route} table should have a caption`);
      assert.ok(table.headers.length > 0, `${route} table should have column headers`);
      assert.ok(table.headers.every((scope) => scope === 'col'), `${route} table headers should use scope="col"`);
    }
    assertNoConsoleErrors();
  }
});

test('customer balances and settlement queue stay derived from live documents', async () => {
  const [queue, balances] = await Promise.all([
    getJson(baseUrl, '/api/settlement-queue'),
    getJson(baseUrl, '/api/customer-balances'),
  ]);

  assert.ok(Array.isArray(queue.items), 'Settlement queue should return items');
  for (const type of ['cancellation_refund', 'customer_credit', 'customer_advance', 'supplier_credit']) {
    assert.ok(queue.totals.by_type[type], `Queue totals should include ${type}`);
    assert.equal(typeof queue.totals.by_type[type].amount_cents, 'number');
  }
  assert.equal(
    queue.totals.amount_cents,
    queue.items.reduce((sum, item) => sum + item.remaining_cents, 0),
    'Queue total should equal the sum of open items',
  );

  assert.ok(Array.isArray(balances) && balances.length > 0, 'Customer balances should list customers');
  const customer = balances.find((row) => row.outstanding_cents > 0 || row.credit_balance_cents > 0)
    || balances[0];
  const detail = await getJson(baseUrl, `/api/customer-balances/${customer.id}`);
  assert.equal(detail.customer.id, customer.id);
  assert.equal(detail.summary.net_balance_cents, customer.net_balance_cents);
  assert.ok(Array.isArray(detail.open_invoices));
  assert.ok(Array.isArray(detail.credits));
  assert.ok(Array.isArray(detail.advances));
  assert.ok(Array.isArray(detail.cancellation_refunds));

  await openRoute('/settlement-queue');
  assert.equal(await page.locator('.kpi').count(), 4);
  assert.match(await page.locator('#page-title').innerText(), /Settlements/i);
  const tableCaption = await page.locator('table.data caption').first().innerText();
  assert.match(tableCaption, /Settlements to make/i);

  await page.selectOption('#queue-type', 'customer_credit');
  await page.waitForTimeout(100);
  const filteredTypes = await page.$$eval(
    '#queue-body tr[data-href] td:first-child',
    (cells) => cells.map((cell) => cell.textContent.trim()),
  );
  assert.ok(filteredTypes.every((label) => label === 'Customer credit'),
    'Type filter should only show customer credits');
  assert.match(await page.locator('#queue-count').innerText(), /shown/);

  await openRoute('/customer-balances');
  assert.equal(await page.locator('.kpi').count(), 4);
  assert.match(await page.locator('#page-title').innerText(), /Customer balances/i);
  assert.ok(await page.locator('#balance-body tr[data-id]').count() > 0, 'Balances table should render rows');

  await page.fill('#balance-search', 'zzzz-no-such-customer');
  await page.waitForTimeout(100);
  assert.match(await page.locator('#balance-count').innerText(), /^0 shown$/);
  await page.fill('#balance-search', customer.name);
  await page.waitForTimeout(100);
  assert.ok(await page.locator('#balance-body tr[data-id]').count() > 0, 'Search should find the customer');

  await openRoute(`/customer-balances/${customer.id}`);
  assert.equal(await page.locator('.kpi').count(), 4);
  const title = (await page.locator('#page-title').innerText()).trim();
  assert.ok(title.startsWith(customer.name), title);
  assert.match(title, /CUS-\d{4}$/, 'the customer number sits beside the name');
  assert.ok(await page.locator('table.data caption').count() > 0, 'Balance detail should render tables');
  assertNoConsoleErrors();
});

test('cancelling a paid booking offers refund, credit or defer settlement', async () => {
  const [customers, accounts] = await Promise.all([
    getJson(baseUrl, '/api/customers'),
    getJson(baseUrl, '/api/accounts'),
  ]);
  const revenue = accounts.find((account) => account.code === '4000');
  const cash = accounts.find((account) => account.code === '1000');
  assert.ok(customers[0] && revenue && cash);

  const booking = await postJson(baseUrl, '/api/bookings', {
    customer_id: customers[0].id,
    booking_date: '2026-10-20',
    due_date: '2026-10-20',
    sale_items: [{
      description: 'E2E settlement booking',
      quantity: 1,
      unit_price_cents: 100_000,
      account_id: revenue.id,
    }],
  });
  const confirmed = await postJson(baseUrl, `/api/bookings/${booking.id}/confirm`, {}, 200);
  assert.ok(confirmed.invoice_id);

  await postJson(baseUrl, `/api/invoices/${confirmed.invoice_id}/payments`, {
    amount_cents: 100_000,
    payment_date: '2026-10-21',
    method: 'Cash',
    deposit_account_id: cash.id,
  });

  const cancelled = await postJson(baseUrl, `/api/bookings/${booking.id}/cancel`, {
    cancellation_date: '2026-10-22',
    customer_charges_cents: 20_000,
    reason: 'E2E settlement choice',
  }, 200);
  assert.ok(cancelled.cancellation?.id, 'Cancelling should return the cancellation record');
  const cancellationId = cancelled.cancellation.id;

  const cancellation = await getJson(baseUrl, `/api/cancellations/${cancellationId}`);
  assert.equal(cancellation.refund_remaining_cents, 80_000);

  const queue = await getJson(baseUrl, '/api/settlement-queue');
  assert.ok(
    queue.items.some((item) => item.type === 'cancellation_refund' && item.document_id === cancellationId),
    'Settlement queue should include the cancellation refund',
  );

  await openRoute(`/cancellations/${cancellationId}?settle=1`);
  const choice = page.locator('[data-settlement-choice]');
  await choice.waitFor();
  const choiceText = await choice.innerText();
  assert.match(choiceText, /Choose how to settle/i);
  assert.equal(await choice.locator('[data-choice="refund"]').count(), 1);
  assert.equal(await choice.locator('[data-choice="credit"]').count(), 1);
  assert.equal(await choice.locator('[data-choice="defer"]').count(), 1);

  await choice.locator('[data-choice="defer"]').click();
  await page.waitForFunction(() => !document.querySelector('[data-settlement-choice]'));

  await openRoute(`/cancellations/${cancellationId}`);
  assert.equal(await page.locator('[data-settlement-choice]').count(), 0);
  await page.locator('[data-action="settlement-options"]').click();
  await page.waitForFunction(() => location.hash.includes('settle=1'));
  await page.waitForSelector('[data-settlement-choice]');
  assertNoConsoleErrors();
});

test('customer statement shows one summary line, presets and short ledger rows', async () => {
  const customers = await getJson(baseUrl, '/api/customers');
  const customer = customers.find((row) => row.invoice_count > 0);
  assert.ok(customer, 'Demo data should include a customer with an invoice');

  await openRoute(`/customers/${customer.id}/statement`);
  assert.equal(await page.locator('.kpi-grid').count(), 0, 'No separate summary cards');
  const summary = await page.locator('[data-statement-summary] > div').allInnerTexts();
  assert.equal(summary.length, 4, 'Opening, Debit, Credit and Balance due on one line');
  assert.match(summary[1], /Debit/i, 'Statement of account uses Debit');
  assert.match(summary[2], /Credit/i, 'Statement of account uses Credit');
  assert.match(summary[3], /Balance due/i);
  assert.equal(await page.locator('.statement-presets [data-statement-preset]').count(), 3);
  assert.match(await page.locator('.statement-status').innerText(), /Settled|Payment due|Credit balance/);

  const ledgerText = await page.locator('.statement-table tbody').first().innerText();
  assert.match(ledgerText, /Invoice raised/, 'Invoice descriptions should not repeat the reference');
  assert.doesNotMatch(ledgerText, /Invoice INV-/);
  assert.ok(await page.locator('.statement-desc-dot').count() > 0, 'Ledger rows should carry a type marker');

  await page.locator('[data-statement-preset="year"]').click();
  await page.waitForFunction(() => document.querySelector('[data-statement-preset="year"]')?.getAttribute('aria-pressed') === 'true');
  assert.match(await page.locator('#date-from').inputValue(), /^\d{4}-01-01$/);

  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('.statement-toolbar').isVisible(), false, 'Period controls should not print');
  assert.equal(await page.locator('.statement-card').isVisible(), true, 'The statement document should print');
  assert.equal(await page.locator('[data-statement-summary]').isVisible(), true, 'The summary line prints');
  await page.emulateMedia({ media: 'screen' });
  assertNoConsoleErrors();
});

test('customer statement shows the visa applicant and invoice item', async () => {
  const visas = await getJson(baseUrl, '/api/visas');
  const visitor = visas.find((visa) => Number(visa.applicant_is_customer) === 0 && visa.invoice_id);
  assert.ok(visitor, 'Demo data should include a visitor visa with an invoice');
  const invoice = await getJson(baseUrl, `/api/invoices/${visitor.invoice_id}`);

  await openRoute(`/customers/${visitor.customer_id}/statement`);
  const invoiceRow = page.locator('.statement-table tbody tr').filter({ hasText: invoice.number }).first();
  await invoiceRow.waitFor();
  // Visa details stay folded until the row's Details button opens them.
  assert.equal(await invoiceRow.locator('.statement-visa').isVisible(), false);
  await invoiceRow.locator('[data-statement-row-toggle]').click();
  assert.equal(await invoiceRow.locator('.statement-visa').isVisible(), true);
  const applicantText = (await invoiceRow.locator('.statement-visa').innerText()).replace(/\u2011/g, '-');
  assert.ok(applicantText.includes(visitor.applicant_name), 'Statement should name the visa applicant');
  assert.match(applicantText, /Visitor/);
  if (visitor.nationality) assert.ok(applicantText.includes(visitor.nationality));
  if (visitor.passport_number) {
    assert.ok(applicantText.includes(`•••• ${visitor.passport_number.slice(-4)}`), 'Statement shows a masked passport');
    assert.ok(!applicantText.includes(visitor.passport_number), 'Statement never shows the full passport number');
  }
  assert.doesNotMatch(applicantText, /DOB/);
  assert.ok(applicantText.includes(visitor.number), 'Statement should show the visa number');
  assert.ok(
    (await invoiceRow.locator('.statement-item-line').first().innerText()).includes(invoice.items[0].description),
    'Statement should show the invoice item',
  );
  assert.ok(
    (await page.locator('.statement-parties').innerText()).includes(invoice.customer_name),
    'Bill To should stay with the paying customer',
  );
  // Show details opens every row and is remembered.
  await page.locator('[data-statement-details]').check();
  await page.reload();
  await page.locator('.statement-card.show-details').waitFor();
  assert.equal(await page.locator('[data-statement-row-toggle]').first().isVisible(), false);
  await page.locator('[data-statement-details]').uncheck();
  assertNoConsoleErrors();
});

test('pagination, page-size and filter reset work on compliance and cheques', async () => {
  for (const route of ['/compliance', '/cheques']) {
    await openRoute(route);
    const rows = page.locator('#view tbody tr[data-id]');
    await rows.first().waitFor();
    assert.equal(await rows.count(), 25, `${route} should show 25 rows on page 1`);
    assert.match(await page.locator('.pagination-info').innerText(), /^1–25 of 30$/);

    await page.locator('[data-page-next]').click();
    await page.waitForTimeout(100);
    assert.equal(await rows.count(), 5, `${route} page 2 should show the remaining 5 rows`);
    assert.match(await page.locator('.pagination-page').innerText(), /Page 2 of 2/);

    await page.locator('[data-page-size]').selectOption('10');
    await page.waitForTimeout(100);
    assert.equal(await rows.count(), 10, `${route} should apply the 10-row page size`);
    assert.match(await page.locator('.pagination-info').innerText(), /^1–10 of 30$/);

    await page.locator('[data-page-next]').click();
    await page.waitForTimeout(100);
    const search = page.locator('input[type="search"]');
    await search.fill(route === '/cheques' ? 'E2E-CHQ-1' : 'E2E compliance 1');
    await page.waitForTimeout(100);
    assert.match(await page.locator('.pagination-page').innerText(), /Page 1 of /, `${route} filter should reset to page 1`);
    assertNoConsoleErrors();
  }
});

test('theme persists across reload and printing stays light', async () => {
  await openRoute('/settings');
  await page.locator('[data-theme-choice="dark"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.equal(await page.evaluate(() => localStorage.getItem('ledgerly.theme')), 'dark');

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('#view')?.children.length > 0);
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');

  await page.emulateMedia({ media: 'print' });
  const printColors = await page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return { background: style.backgroundColor, color: style.color };
  });
  assert.equal(printColors.background, 'rgb(255, 255, 255)');
  assert.equal(printColors.color, 'rgb(17, 24, 39)');
  await page.emulateMedia({ media: 'screen' });
  await page.evaluate(() => {
    localStorage.removeItem('ledgerly.theme');
    document.documentElement.dataset.theme = 'light';
  });
  assertNoConsoleErrors();
});

test('modal trap, escape close and focus restore', async () => {
  await openRoute('/customers');
  const trigger = page.locator('[data-action="new-party"]').first();
  await trigger.click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  assert.ok(await dialog.getAttribute('aria-labelledby'));
  await page.waitForFunction(() => document.activeElement?.closest('[role="dialog"]') !== null);
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null), true);

  const beforeTab = await page.evaluate(() => document.activeElement?.outerHTML);
  await page.keyboard.press('Shift+Tab');
  const afterTab = await page.evaluate(() => document.activeElement?.outerHTML);
  assert.notEqual(beforeTab, afterTab, 'Shift+Tab should move focus inside the trap');
  assert.equal(await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null), true);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  assert.equal(await dialog.count(), 0);
  assert.equal(await trigger.evaluate((element) => element === document.activeElement), true);
  assertNoConsoleErrors();
});

test('supplier portal vendor picker searches active vendors', async () => {
  const vendors = await getJson(baseUrl, '/api/vendors');
  const vendor = vendors.find((row) => row.is_active);
  assert.ok(vendor, 'Demo data should include an active vendor');

  await openRoute('/portals');
  await page.locator('[data-action="new-portal"]').first().click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();

  const typeOptions = await dialog.locator('#pt-type option').evaluateAll((options) => options.map((option) => option.value));
  assert.ok(typeOptions.includes('visa_agent'), 'Portal type list should offer Visa Agent');
  assert.ok(
    (await dialog.locator('#pt-type option').allInnerTexts()).includes('Visa Agent'),
    'Visa Agent should have a readable label',
  );

  const search = dialog.locator('#pt-vendor-search');
  const select = dialog.locator('#pt-vendor');
  const hint = dialog.locator('#pt-vendor-search-hint');

  await search.fill(vendor.name);
  assert.ok(
    (await select.locator('option').allInnerTexts()).includes(vendor.name),
    'Vendor search should keep matching suppliers in the picker',
  );
  assert.match(await hint.innerText(), /suppliers? match/i);

  await search.fill('zzzz-no-vendor');
  assert.equal(await select.isDisabled(), true);
  assert.match(await hint.innerText(), /No suppliers match/i);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  assert.equal(await dialog.count(), 0);
  assertNoConsoleErrors();
});

test('visa applicant toggle separates customer and visitor details', async () => {
  const draft = (await getJson(baseUrl, '/api/visas')).find((visa) => visa.status === 'draft');
  assert.ok(draft, 'Demo data should include a draft visa');
  await openRoute(`/visas/${draft.id}`);
  await page.locator('[data-action="edit"]').click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  assert.equal(await dialog.locator('details.more-details').count(), 1);
  // Opens with notes already; make sure it is open either way.
  await dialog.locator('details.more-details').evaluate((details) => { details.open = true; });

  const customer = dialog.locator('#visa-customer');
  const applicant = dialog.locator('#visa-applicant');
  const other = dialog.locator('#visa-applicant-other');
  const duration = dialog.locator('#visa-duration');

  assert.equal(await duration.getAttribute('type'), 'number');
  await duration.fill('30');
  assert.equal(await duration.inputValue(), '30');

  if (await other.isChecked()) await other.uncheck();
  await customer.selectOption({ index: 1 });
  const customerName = (await customer.locator('option:checked').innerText()).trim();
  assert.ok(customerName);
  assert.equal(await applicant.inputValue(), customerName, 'customer mode fills the applicant name');
  assert.equal(await applicant.getAttribute('readonly'), '', 'customer mode keeps the applicant name read-only');
  assert.match(await applicant.getAttribute('placeholder'), /customer/i);

  await other.check();
  assert.equal(await applicant.inputValue(), '', 'visitor mode clears the prefilled customer name');
  assert.equal(await applicant.getAttribute('readonly'), null, 'visitor mode allows editing the name');
  assert.equal(await applicant.getAttribute('required'), '', 'visitor mode requires an applicant name');
  assert.match(await applicant.getAttribute('placeholder'), /visitor/i);

  await applicant.fill('Rahul Visitor');
  await other.uncheck();
  assert.equal(await applicant.inputValue(), customerName, 'switching back restores the customer name');
  assert.equal(await applicant.getAttribute('readonly'), '', 'switching back makes the name read-only again');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  assert.equal(await dialog.count(), 0);
  assertNoConsoleErrors();
});

test('visa invoice names the visitor in its passenger table', async () => {
  const visas = await getJson(baseUrl, '/api/visas');
  const visitor = visas.find((visa) => Number(visa.applicant_is_customer) === 0 && visa.invoice_id);
  assert.ok(visitor, 'Demo data should include a submitted visa for a visitor');

  await openRoute(`/invoices/${visitor.invoice_id}`);
  const section = page.locator('.doc-items');
  await section.waitFor();
  const applicantText = await section.innerText();
  assert.ok(applicantText.includes(visitor.applicant_name), 'Invoice should name the visa applicant');
  if (visitor.passport_number) {
    assert.ok(applicantText.includes(`•••• ${visitor.passport_number.slice(-4)}`), 'Invoice shows a masked passport');
    assert.ok(!applicantText.includes(visitor.passport_number), 'Invoice never shows the full passport number');
  }
  assert.doesNotMatch(applicantText, /Date of birth/i);
  assert.match(applicantText, /60 days/);
  assert.ok(
    (await page.locator('.doc-parties').first().innerText()).includes(visitor.customer_name),
    'Bill To should stay with the paying customer',
  );
  assertNoConsoleErrors();
});

test('supplier portal statement shows the linked visa applicant', async () => {
  const [customers, accounts] = await Promise.all([
    getJson(baseUrl, '/api/customers'),
    getJson(baseUrl, '/api/accounts'),
  ]);
  const bank = accounts.find((account) => account.code === '1010');
  const revenue = accounts.find((account) => account.code === '4320');
  const visaCost = accounts.find((account) => account.code === '5120');
  assert.ok(customers[0] && bank && revenue && visaCost);

  const vendor = await postJson(baseUrl, '/api/vendors', { name: 'E2E Visa Supplier' });
  const portal = await postJson(baseUrl, '/api/portals', {
    name: 'E2E Visa Portal',
    portal_type: 'visa_agent',
    settlement: 'prepaid',
    vendor_id: vendor.id,
  });
  await postJson(baseUrl, `/api/portals/${portal.id}/topups`, {
    topup_date: '2026-10-20',
    amount_cents: 30_000,
    deposit_account_id: bank.id,
    method: 'Bank transfer',
  });

  const visa = await postJson(baseUrl, '/api/visas', {
    customer_id: customers[0].id,
    application_date: '2026-10-20',
    due_date: '2026-10-20',
    destination_country: 'UAE',
    visa_type: 'tourist',
    duration_days: 30,
    applicant_is_customer: false,
    applicant_name: 'Portal Visitor',
    nationality: 'Pakistani',
    passport_number: 'AX9999999',
    sale_items: [{
      description: 'E2E visa sale',
      quantity: 1,
      unit_price_cents: 35_000,
      account_id: revenue.id,
    }],
    cost_items: [{
      description: 'E2E visa supplier cost',
      quantity: 1,
      unit_price_cents: 30_000,
      account_id: visaCost.id,
      vendor_id: vendor.id,
    }],
  });
  await postJson(baseUrl, `/api/visas/${visa.id}/submit`, {}, 200);

  await openRoute(`/portals/${portal.id}`);
  const statementText = await page.locator('.doc-items-wrap').innerText();
  assert.ok(statementText.includes(visa.number), 'Statement should show the visa number');
  assert.match(statementText, /Applicant:\s*Portal Visitor/i);
  assert.match(statementText, /Passport\s+AX9999999/i);
  assertNoConsoleErrors();
});

test('void dialog requires remarks, reverses a paid invoice and records the audit log', async () => {
  const [customers, accounts] = await Promise.all([
    getJson(baseUrl, '/api/customers'),
    getJson(baseUrl, '/api/accounts'),
  ]);
  const revenue = accounts.find((account) => account.code === '4300');
  const cash = accounts.find((account) => account.code === '1000');
  assert.ok(customers[0] && revenue && cash);

  const invoiceResponse = await fetch(`${baseUrl}/api/invoices`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: customers[0].id,
      issue_date: '2026-10-22',
      due_date: '2026-10-22',
      status: 'sent',
      items: [{ description: 'E2E void test', quantity: 1, unit_price_cents: 25_000, account_id: revenue.id }],
    }),
  });
  assert.equal(invoiceResponse.status, 201);
  const invoice = await invoiceResponse.json();

  const paymentResponse = await fetch(`${baseUrl}/api/invoices/${invoice.id}/payments`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount_cents: 10_000,
      payment_date: '2026-10-22',
      method: 'Cash',
      deposit_account_id: cash.id,
    }),
  });
  assert.equal(paymentResponse.status, 201);

  await openRoute(`/invoices/${invoice.id}`);
  await page.locator('[data-fold="payments"] > summary').click();
  await page.locator('[data-delete-payment]').first().click();
  const paymentDialog = page.locator('[role="dialog"]');
  await paymentDialog.waitFor();
  const paymentPreview = await paymentDialog.locator('.void-preview').innerText();
  assert.match(paymentPreview, /Void preview/i);
  assert.match(paymentPreview, /Balance reopens/i);
  await paymentDialog.locator('.modal-head [data-close]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

  await clickPageAction('[data-action="void"]');
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  assert.equal(await dialog.locator('#void-remarks').getAttribute('required'), '');

  const voidPreview = await dialog.locator('.void-preview').innerText();
  assert.match(voidPreview, /Void preview/i);
  assert.ok(voidPreview.includes(invoice.number), 'Void preview should name the invoice');
  assert.match(voidPreview, /linked payment/i);

  await dialog.locator('[data-submit]').click();
  await page.waitForTimeout(100);
  assert.match(await dialog.locator('.modal-error').textContent(), /Enter a reason/i);

  await dialog.locator('#void-remarks').fill('E2E duplicate invoice');
  await dialog.locator('[data-submit]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.waitForSelector('.badge-void');

  const voided = await getJson(baseUrl, `/api/invoices/${invoice.id}`);
  assert.equal(voided.status, 'void');
  assert.equal(voided.amount_paid_cents, 0);
  assert.equal(voided.payments[0].status, 'void');

  await openRoute('/audit-logs');
  await page.waitForFunction(() => document.querySelector('#audit-body')?.textContent.includes('E2E duplicate invoice'));
  assert.match(await page.locator('#audit-body').innerText(), /Invoice payment/);
  assertNoConsoleErrors();
});

test('an unapplied customer credit can be refunded in cash from the credit note', async () => {
  const [customers, accounts] = await Promise.all([
    getJson(baseUrl, '/api/customers'),
    getJson(baseUrl, '/api/accounts'),
  ]);
  const revenue = accounts.find((account) => account.code === '4000');
  assert.ok(customers[0] && revenue);

  const credit = await postJson(baseUrl, '/api/credits', {
    customer_id: customers[0].id,
    revenue_account_id: revenue.id,
    amount_cents: 30_000,
    credit_date: '2026-10-22',
    notes: 'E2E credit refund',
  });

  await openRoute(`/credits/${credit.id}`);
  assert.match(await page.locator('table.data caption').last().innerText(), /Cash refunds of this customer credit/);
  await page.locator('#page-actions [data-action="refund-credit"]').click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Amount paid · AED\s[\d,.]+ available/);
  await dialog.locator('#cn-refund-amount').fill('100.00');
  await dialog.locator('#cn-refund-reference').fill('E2E-CN-REFUND');
  await dialog.locator('[data-submit]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.waitForFunction(() => document.querySelector('[data-applications-card] + .card tbody a[href^="#/refunds/"]'));

  const refreshed = await getJson(baseUrl, `/api/credits/${credit.id}`);
  assert.equal(refreshed.refunded_cents, 10_000);
  assert.equal(refreshed.remaining_cents, 20_000);
  assert.equal(refreshed.refunds.length, 1);

  const queue = await getJson(baseUrl, '/api/settlement-queue?type=customer_credit');
  const item = queue.items.find((row) => row.document_id === credit.id);
  assert.ok(item, 'The partly refunded credit stays in the queue');
  assert.equal(item.remaining_cents, 20_000);
  assert.equal(item.action_label, 'Apply or refund');

  const refund = await getJson(baseUrl, `/api/refunds/${refreshed.refunds[0].id}`);
  assert.equal(refund.source_type, 'credit');
  await openRoute(`/refunds/${refund.id}`);
  assert.ok(await page.locator(`a[href="#/credits/${credit.id}"]`).count() > 0, 'Refund voucher links back to the credit note');
  assertNoConsoleErrors();
});

test('dashboard ledger checks, settlement attachments and the audit chain page', async () => {
  const reconciliation = await getJson(baseUrl, '/api/reports/reconciliation');
  assert.equal(reconciliation.checks.length, 11);

  await openRoute('/dashboard');
  const card = page.locator('[data-ledger-checks]');
  await card.waitFor();
  assert.equal(await card.getAttribute('open'), reconciliation.all_matched ? null : '', 'folded when everything matches');
  if (reconciliation.all_matched) await card.locator('summary').click();
  assert.equal(await card.locator('tbody tr').count(), 11);
  assert.match(await card.locator('caption').innerText(), /Ledger checks/);
  const state = await card.locator('[data-ledger-state]').innerText();
  assert.match(state, reconciliation.all_matched ? /^\s*11\s*$/ : /to fix/);

  const cancellations = await getJson(baseUrl, '/api/cancellations');
  assert.ok(cancellations[0], 'Earlier tests and demo data include a cancellation');
  const cancellation = cancellations[0];
  const query = new URLSearchParams({
    entity_type: 'cancellation',
    entity_id: String(cancellation.id),
    filename: 'airline-cancellation.pdf',
    type: 'application/pdf',
  });
  const upload = await fetch(`${baseUrl}/api/attachments?${query}`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/octet-stream' },
    body: Buffer.from('%PDF-1.4 e2e'),
  });
  assert.equal(upload.status, 201);

  await openRoute(`/cancellations/${cancellation.id}`);
  const attachments = page.locator('.attachments-card');
  await attachments.waitFor();
  assert.match(await attachments.innerText(), /airline-cancellation\.pdf/);

  const sourceType = cancellation.source_type;
  await openRoute(`/${sourceType === 'visa' ? 'visas' : 'bookings'}/${cancellation.source_id}`);
  await clickPageAction(`a[href="#/audit-chain/${sourceType}/${cancellation.source_id}"]`);
  await page.waitForFunction(() => document.querySelector('#page-title')?.textContent.startsWith('Audit chain'));
  await page.waitForSelector('.chain-summary');
  const captions = await page.$$eval('table.data caption', (nodes) => nodes.map((node) => node.textContent));
  assert.deepEqual(captions, [
    'Linked documents in this audit chain',
    'Audit timeline of postings, reversals and voids',
    'Net ledger effect by account',
  ]);
  const documentsText = await page.locator('[data-chain-doc]').allInnerTexts();
  assert.ok(documentsText.some((text) => text.includes(cancellation.number)), 'The chain lists the cancellation');
  assert.match(await page.locator('.chain-summary').innerText(), /Balanced/i);
  assertNoConsoleErrors();
});

test('booking invoices and bills offer cancel or supplier credit instead of void', async () => {
  const [customers, vendors, accounts] = await Promise.all([
    getJson(baseUrl, '/api/customers'),
    getJson(baseUrl, '/api/vendors'),
    getJson(baseUrl, '/api/accounts'),
  ]);
  const revenue = accounts.find((account) => account.code === '4000');
  const cost = accounts.find((account) => account.code === '5000');
  const vendor = vendors.find((row) => row.is_active);
  assert.ok(customers[0] && vendor && revenue && cost);

  const booking = await postJson(baseUrl, '/api/bookings', {
    customer_id: customers[0].id,
    booking_date: '2026-10-22',
    due_date: '2026-10-22',
    sale_items: [{ description: 'E2E guard ticket', quantity: 1, unit_price_cents: 60_000, account_id: revenue.id }],
    cost_items: [{ description: 'E2E guard fare', quantity: 1, unit_price_cents: 45_000, account_id: cost.id, vendor_id: vendor.id }],
  });
  const confirmed = await postJson(baseUrl, `/api/bookings/${booking.id}/confirm`, {}, 200);
  const bill = confirmed.bills[0];
  assert.ok(confirmed.invoice_id && bill);

  const blocked = await fetch(`${baseUrl}/api/invoices/${confirmed.invoice_id}/void`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({ remarks: 'E2E direct void' }),
  });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /Cancel the booking/);

  await openRoute(`/invoices/${confirmed.invoice_id}`);
  assert.equal(await page.locator('#page-actions [data-action="void"]').count(), 0, 'No void on a booking invoice');
  assert.equal(
    await page.locator('#page-actions [data-action="cancel-job"]').getAttribute('href'),
    `#/bookings/${booking.id}`,
  );

  await openRoute(`/bills/${bill.id}`);
  assert.equal(await page.locator('#page-actions [data-action="void"]').count(), 0, 'No void on a booking bill');
  await clickPageAction('[data-action="supplier-credit"]');
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  await page.waitForFunction((billId) => document.querySelector('#sc-bill')?.value === String(billId), bill.id);
  assert.equal(await dialog.locator('#sc-vendor').inputValue(), String(bill.vendor_id));
  assert.equal(await dialog.locator('#sc-booking').inputValue(), String(booking.id));
  await dialog.locator('.modal-head [data-close]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  assertNoConsoleErrors();
});

test('internal booking notes stay on screen; only the invoice note is printed', async () => {
  const [customers, vendors, accounts] = await Promise.all([
    getJson(baseUrl, '/api/customers'),
    getJson(baseUrl, '/api/vendors'),
    getJson(baseUrl, '/api/accounts'),
  ]);
  const revenue = accounts.find((account) => account.code === '4000');
  const cost = accounts.find((account) => account.code === '5000');
  const vendor = vendors.find((row) => row.is_active);
  const booking = await postJson(baseUrl, '/api/bookings', {
    customer_id: customers[0].id,
    booking_date: '2026-10-22',
    due_date: '2026-10-22',
    notes: 'INTERNAL E2E: call before ticketing',
    invoice_notes: 'E2E invoice note for the customer',
    sale_items: [{ description: 'E2E notes ticket', quantity: 1, unit_price_cents: 50_000, account_id: revenue.id }],
    cost_items: [{ description: 'E2E notes fare', quantity: 1, unit_price_cents: 40_000, account_id: cost.id, vendor_id: vendor.id }],
  });

  await openRoute(`/bookings/${booking.id}`);
  const internal = page.locator('[data-internal-notes]');
  await internal.waitFor();
  assert.match(await internal.innerText(), /INTERNAL E2E: call before ticketing/);
  assert.match(await internal.getAttribute('class'), /no-print/);
  const documentText = await page.locator('.doc').first().innerText();
  assert.ok(documentText.includes('E2E invoice note for the customer'), 'the invoice note is on the printed booking');
  assert.ok(!documentText.includes('INTERNAL E2E'), 'internal notes are not on the printed booking');

  const confirmed = await postJson(baseUrl, `/api/bookings/${booking.id}/confirm`, {}, 200);
  await openRoute(`/invoices/${confirmed.invoice_id}`);
  const invoiceText = await page.locator('.doc').first().innerText();
  assert.ok(invoiceText.includes('E2E invoice note for the customer'));
  assert.ok(!invoiceText.includes('INTERNAL E2E'), 'internal notes never reach the invoice');
  assertNoConsoleErrors();
});

test('job pages show status history, an early-travel guard and passport warnings', async () => {
  const [customers, vendors, accounts] = await Promise.all([
    getJson(baseUrl, '/api/customers'),
    getJson(baseUrl, '/api/vendors'),
    getJson(baseUrl, '/api/accounts'),
  ]);
  const revenue = accounts.find((account) => account.code === '4000');
  const visaRevenue = accounts.find((account) => account.code === '4320');
  const cost = accounts.find((account) => account.code === '5000');
  const vendor = vendors.find((row) => row.is_active);
  const future = new Date(Date.now() + 40 * 86_400_000).toISOString().slice(0, 10);

  const booking = await postJson(baseUrl, '/api/bookings', {
    customer_id: customers[0].id,
    booking_date: '2026-10-22',
    travel_date: future,
    sale_items: [{ description: 'E2E future ticket', quantity: 1, unit_price_cents: 50_000, account_id: revenue.id }],
    cost_items: [{ description: 'E2E future fare', quantity: 1, unit_price_cents: 40_000, account_id: cost.id, vendor_id: vendor.id }],
  });
  await postJson(baseUrl, `/api/bookings/${booking.id}/confirm`, {}, 200);

  await openRoute(`/bookings/${booking.id}`);
  const travel = page.locator('#page-actions [data-action="travel"]');
  assert.equal(await travel.isDisabled(), true, 'Mark travelled waits for the travel date');
  const history = page.locator('[data-status-history]');
  await history.waitFor();
  assert.match(await history.getAttribute('class'), /no-print/);
  assert.equal(await history.locator('tbody tr').count(), 2, 'created and confirmed');
  assert.match(await history.innerText(), /Invoice INV-/);

  const visa = await postJson(baseUrl, '/api/visas', {
    customer_id: customers[0].id,
    application_date: '2026-10-22',
    travel_date: '2026-12-01',
    passport_expiry: '2027-01-15',
    sale_items: [{ description: 'E2E passport visa', quantity: 1, unit_price_cents: 30_000, account_id: visaRevenue.id }],
  });
  assert.match(visa.passport_warning, /less than 6 months/);
  await openRoute(`/visas/${visa.id}`);
  const warning = page.locator('[data-passport-warning]');
  await warning.waitFor();
  assert.match(await warning.innerText(), /Check the passport validity/);
  assertNoConsoleErrors();
});

test('an invoice can be marked as for someone else', async () => {
  const [customers, accounts] = await Promise.all([
    getJson(baseUrl, '/api/customers'),
    getJson(baseUrl, '/api/accounts'),
  ]);
  const revenue = accounts.find((account) => account.code === '4300');

  await openRoute('/invoices?new=1');
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  // Service for reads "Same as customer" until a name is typed; then the
  // nationality and passport fields appear next to it.
  const nameInput = dialog.locator('#invoice-beneficiary');
  assert.equal(await nameInput.getAttribute('placeholder'), 'Same as customer');
  const passportField = dialog.locator('[data-beneficiary-field]').last();
  assert.equal(await passportField.getAttribute('hidden'), '');
  await nameInput.fill('E2E Traveller');
  assert.equal(await passportField.getAttribute('hidden'), null);
  await nameInput.fill('');
  assert.equal(await passportField.getAttribute('hidden'), '');
  await dialog.locator('.modal-head [data-close]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

  const invoice = await postJson(baseUrl, '/api/invoices', {
    customer_id: customers[0].id,
    issue_date: '2026-10-22',
    beneficiary_is_customer: false,
    beneficiary_name: 'E2E Traveller',
    beneficiary_nationality: 'Indian',
    beneficiary_passport: 'K1234987',
    items: [{ description: 'E2E ticket for a traveller', quantity: 1, unit_price_cents: 20_000, account_id: revenue.id }],
  });
  await openRoute(`/invoices/${invoice.id}`);
  const section = page.locator('[data-beneficiary]');
  await section.waitFor();
  const text = await section.innerText();
  assert.match(text, /Service for/i);
  assert.ok(text.includes('E2E Traveller'));
  assert.ok(text.includes('•••• 4987'), 'masked passport');
  assert.ok(!text.includes('K1234987'), 'never the full passport');
  assert.ok((await page.locator('.doc-parties').first().innerText()).includes(customers[0].name), 'still billed to the customer');

  await openRoute('/invoices');
  await page.locator('#invoice-search').fill('E2E Traveller');
  await page.waitForTimeout(100);
  assert.match(await page.locator('table.data tbody').innerText(), /For E2E Traveller/);
  assertNoConsoleErrors();
});

test('the service invoice form offers only service income and points sales to bookings and visas', async () => {
  const accounts = await getJson(baseUrl, '/api/accounts');
  const ticket = accounts.find((account) => account.code === '4000');
  const customers = await getJson(baseUrl, '/api/customers');

  const blocked = await fetch(`${baseUrl}/api/invoices`, {
    method: 'POST',
    headers: { Origin: baseUrl, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_id: customers[0].id,
      issue_date: '2026-10-22',
      items: [{ description: 'E2E ticket', quantity: 1, unit_price_cents: 10_000, account_id: ticket.id }],
    }),
  });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error, /Create a booking or visa/);

  await openRoute('/invoices');
  assert.match(await page.locator('#page-actions').innerText(), /New invoice/);
  await openRoute('/invoices?new=1');
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  assert.match(await dialog.locator('h2').first().innerText(), /New invoice/);
  assert.equal(await dialog.locator('.modal-head p').count(), 0, 'no subtitle');
  assert.equal(await dialog.locator('[data-seg="invoice-kind"] [aria-pressed="true"]').innerText(), 'Service');
  const accountCodes = await dialog.locator('.line-account option').evaluateAll(
    (options) => options.map((option) => option.textContent.trim().split(' ')[0]).filter((code) => /^\d+$/.test(code)),
  );
  assert.ok(accountCodes.length > 0);
  for (const code of ['4000', '4100', '4320']) assert.ok(!accountCodes.includes(code), `${code} is not offered`);
  assert.equal(accountCodes[0], '4300', 'service charges come first');

  await dialog.locator('[data-seg="invoice-kind"] [data-seg-value="booking"]').click();
  await page.waitForFunction(() => document.querySelector('[role="dialog"] h2')?.textContent.includes('New booking'));
  await page.locator('[role="dialog"] .modal-head [data-close]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

  await openRoute('/reports/daily-sales');
  assertNoConsoleErrors();
});

test('the booking form takes one row per passenger with sale, cost and supplier', async () => {
  const vendors = await getJson(baseUrl, '/api/vendors');
  const vendor = vendors.find((row) => row.is_active);

  await openRoute('/bookings?new=1');
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  assert.match(await dialog.locator('label[for="bk-destination"]').innerText(), /Route/);
  assert.equal(await dialog.locator('details.more-details').getAttribute('open'), null, 'More details starts closed');

  await dialog.locator('#bk-customer').selectOption({ index: 1 });
  await dialog.locator('#bk-destination').fill('E2E Dubai–Paris return');
  await dialog.locator('#bk-pnr').fill('E2EPNR1');
  const first = dialog.locator('[data-px-row]').nth(0);
  await first.locator('.px-label').fill('E2E Passenger One');
  await first.locator('.px-sale').fill('1500');
  await first.locator('.px-cost').fill('1200');
  await first.locator('.px-vendor').selectOption(String(vendor.id));
  await dialog.locator('[data-px-add="passenger"]').click();
  const second = dialog.locator('[data-px-row]').nth(1);
  assert.equal(await second.locator('.px-vendor').inputValue(), String(vendor.id), 'supplier carries over');
  await second.locator('.px-label').fill('E2E Passenger Two');
  await second.locator('.px-sale').fill('1500');
  await second.locator('.px-cost').fill('1200');
  assert.equal(await second.locator('.px-qty').isVisible(), false, 'quantity and accounts sit behind ⋯');
  await second.locator('.px-ref').fill('TKT-2');
  assert.equal(await dialog.locator('[data-px-count]').innerText(), '2');
  assert.equal((await dialog.locator('#bk-margin').innerText()).replace(/\s+/g, ' '), 'AED 600.00');
  // A ticket no. is kept with the cost, so without a cost the form says so instead of dropping it.
  await second.locator('.px-cost').fill('');
  await dialog.locator('[data-submit]').click();
  await dialog.locator('.modal-error:not([hidden])', { hasText: 'enter the supplier cost to keep the ticket no.' }).waitFor();
  await second.locator('.px-cost').fill('1200');
  await dialog.locator('[data-submit]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

  const [saved] = await getJson(baseUrl, '/api/bookings?search=E2EPNR1');
  assert.equal(saved.passenger_names, 'E2E Passenger One, E2E Passenger Two');
  const confirmed = await postJson(baseUrl, `/api/bookings/${saved.id}/confirm`, {}, 200);
  const invoice = await getJson(baseUrl, `/api/invoices/${confirmed.invoice_id}`);
  assert.deepEqual(invoice.items.map((item) => item.description), [
    'E2E Dubai–Paris return – E2E Passenger One',
    'E2E Dubai–Paris return – E2E Passenger Two',
  ]);
  const detail = await getJson(baseUrl, `/api/bookings/${saved.id}`);
  assert.equal(detail.cost_items.find((item) => item.passenger_name === 'E2E Passenger Two').supplier_ref, 'TKT-2');

  await openRoute('/bookings');
  await page.locator('#booking-search').fill('E2E Passenger Two');
  await page.waitForTimeout(100);
  assert.match(await page.locator('table.data tbody').innerText(), /E2E Passenger One, E2E Passenger Two/);
  assertNoConsoleErrors();
});

test('a new visa takes several applicants, links them as a group and submits them together', async () => {
  const vendors = await getJson(baseUrl, '/api/vendors');
  const vendor = vendors.find((row) => row.is_active);

  await openRoute('/visas?new=1');
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  assert.match(await dialog.locator('h2').first().innerText(), /New visa application/);
  assert.equal(await dialog.locator('details.more-details').getAttribute('open'), null, 'More details starts closed');

  await dialog.locator('#vg-customer').selectOption({ index: 1 });
  const customerName = (await dialog.locator('#vg-customer option:checked').innerText()).trim();
  await dialog.locator('#vg-country').fill('E2E Schengen');
  const first = dialog.locator('[data-va-row]').nth(0);
  assert.equal(await first.locator('.va-name').inputValue(), customerName, 'the first applicant defaults to the customer');
  await first.locator('.va-passport').fill('E2EP0001');
  await first.locator('.va-sale').fill('450');
  await first.locator('.va-cost').fill('380');
  await first.locator('.va-vendor').selectOption(String(vendor.id));
  await dialog.locator('[data-va-add]').click();
  const second = dialog.locator('[data-va-row]').nth(1);
  assert.equal(await second.locator('.va-sale').inputValue(), '450.00', 'the price carries over');
  assert.equal(await second.locator('.va-vendor').inputValue(), String(vendor.id), 'the supplier carries over');
  await second.locator('.va-name').fill('E2E Visa Child');
  await second.locator('[data-va-more]').click();
  await second.locator('.va-nationality').fill('Pakistani');
  assert.equal((await dialog.locator('#vg-margin').innerText()).replace(/\s+/g, ' '), 'AED 140.00');
  await dialog.locator('[data-submit]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.waitForFunction(() => location.hash.startsWith('#/visas/'));

  const group = page.locator('[data-visa-group]');
  await group.waitFor();
  assert.match(await group.innerText(), /E2E Visa Child/);
  const created = (await getJson(baseUrl, '/api/visas')).filter((visa) => visa.destination_country === 'E2E Schengen');
  assert.equal(created.length, 2);
  assert.ok(created.every((visa) => visa.group_number && visa.group_size === 2 && visa.status === 'draft'));

  await group.locator('[data-action="submit-group"]').click();
  await page.locator('[role="dialog"] [data-submit]').click();
  await page.waitForFunction(() => !document.querySelector('[data-action="submit-group"]'));
  const submitted = (await getJson(baseUrl, '/api/visas')).filter((visa) => visa.destination_country === 'E2E Schengen');
  assert.ok(submitted.every((visa) => visa.status === 'submitted' && visa.invoice_id), 'each applicant has its own invoice');
  assert.notEqual(submitted[0].invoice_id, submitted[1].invoice_id);

  await openRoute('/visas');
  await page.locator('#visa-search').fill(created[0].group_number);
  await page.waitForTimeout(100);
  assert.equal(await page.locator('table.data tbody .group-chip').count(), 2);
  assertNoConsoleErrors();
});

test('the service invoice form shows dates, lines with quantity and income type, and a total bar', async () => {
  const customers = await getJson(baseUrl, '/api/customers');
  await openRoute('/invoices?new=1');
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  assert.equal(await dialog.locator('#invoice-due').isVisible(), true, 'payment due sits next to the date');
  assert.equal(await dialog.locator('.line-qty').first().isVisible(), true, 'quantity is a column');
  assert.equal(await dialog.locator('#sum-subtotal').count(), 0, 'a single total');

  await dialog.locator('#invoice-customer').selectOption(String(customers[0].id));
  const line = dialog.locator('[data-line]').first();
  await line.locator('.line-desc').fill('E2E meet and assist');
  await line.locator('.line-price').fill('125');
  await dialog.locator('[data-add-line]').click();
  const extra = dialog.locator('[data-line]').nth(1);
  await extra.locator('.line-desc').fill('E2E porter');
  await extra.locator('.line-price').fill('40');
  await extra.locator('.line-qty').fill('2');
  assert.equal(await dialog.locator('[data-line-count]').innerText(), '2 lines');
  assert.equal((await dialog.locator('#sum-total').innerText()).replace(/\s+/g, ' '), 'AED 205.00');
  await dialog.locator('[data-submit]').click();
  await page.waitForFunction(() => location.hash.startsWith('#/invoices/'));

  const id = Number(await page.evaluate(() => location.hash.split('/').pop()));
  const invoice = await getJson(baseUrl, `/api/invoices/${id}`);
  assert.equal(invoice.total_cents, 20_500);
  assert.deepEqual(invoice.items.map((item) => [item.description, item.quantity, item.account_code]), [
    ['E2E meet and assist', 1, '4300'],
    ['E2E porter', 2, '4300'],
  ]);
  assertNoConsoleErrors();
});

test('ticket, visa and service invoices print with their own heading and details', async () => {
  const [customers, vendors, accounts] = await Promise.all([
    getJson(baseUrl, '/api/customers'),
    getJson(baseUrl, '/api/vendors'),
    getJson(baseUrl, '/api/accounts'),
  ]);
  const code = (value) => accounts.find((row) => row.code === value).id;
  const vendor = vendors.find((row) => row.is_active);
  const pax = (name, group) => ({ description: name, passenger_name: name, line_group: group, quantity: 1 });
  const booking = await postJson(baseUrl, '/api/bookings', {
    customer_id: customers[0].id,
    booking_date: '2026-10-20',
    travel_date: '2026-11-10',
    return_date: '2026-11-17',
    destination: 'E2E Dubai–Rome return',
    pnr: 'E2EROM',
    sale_items: [{ ...pax('E2E Rome One', 1), unit_price_cents: 180_000, account_id: code('4000') }],
    cost_items: [{ ...pax('E2E Rome One', 1), unit_price_cents: 150_000, account_id: code('5000'), vendor_id: vendor.id, supplier_ref: '176-5550001112' }],
  });
  const confirmed = await postJson(baseUrl, `/api/bookings/${booking.id}/confirm`, {}, 200);
  await openRoute(`/invoices/${confirmed.invoice_id}`);
  await page.locator('[data-trip-details]').waitFor();
  assert.equal((await page.locator('.doc-kind').innerText()).trim().toLowerCase(), 'ticket invoice');
  const trip = await page.locator('[data-trip-details]').innerText();
  assert.ok(trip.includes('E2E Dubai–Rome return') && trip.includes(booking.number));
  const table = await page.locator('.doc-items').innerText();
  assert.match(table, /Passenger/i);
  assert.match(table, /E2E Rome One[\s\S]*176-5550001112/, 'each passenger with their ticket number');
  assert.doesNotMatch(table, /Unit price/i, 'no Qty or Unit price when every quantity is 1');
  assert.doesNotMatch(await page.locator('.doc').innerText(), /Destination:/, 'no repeated destination in terms');
  assert.doesNotMatch(await page.locator('.doc').innerText(), /1,500\.00/, 'supplier cost is never printed');

  const visas = await postJson(baseUrl, '/api/visas/groups', {
    customer_id: customers[0].id,
    application_date: '2026-10-20',
    destination_country: 'E2E Italy',
    applicants: [{ applicant_is_customer: true, applicant_name: customers[0].name, passport_number: 'E2EV12345',
      sale_items: [{ description: 'Tourist visa', quantity: 1, unit_price_cents: 40_000, account_id: code('4320') }] }],
  });
  const visa = await postJson(baseUrl, `/api/visas/${visas.applications[0].id}/submit`, {}, 200);
  await openRoute(`/invoices/${visa.invoice_id}`);
  await page.locator('[data-visa-details]').waitFor();
  assert.equal((await page.locator('.doc-kind').innerText()).trim().toLowerCase(), 'visa invoice');
  const details = await page.locator('.doc-items').innerText();
  assert.ok(details.includes('E2E Italy') && details.includes('•••• 2345'), 'visa details show for the customer too');
  assert.ok(!details.includes('E2EV12345'));

  const service = await postJson(baseUrl, '/api/invoices', {
    customer_id: customers[0].id,
    issue_date: '2026-10-20',
    items: [{ description: 'E2E consultancy', quantity: 1, unit_price_cents: 10_000, account_id: code('4300') }],
  });
  await openRoute(`/invoices/${service.id}`);
  await page.locator('.doc-kind').waitFor();
  assert.equal((await page.locator('.doc-kind').innerText()).trim().toLowerCase(), 'invoice');
  assert.equal(await page.locator('[data-trip-details], [data-visa-details]').count(), 0);
  assertNoConsoleErrors();
});

test('confirm preview, payment column, amount in words, receipt voucher and share links', async () => {
  const [customers, vendors, accounts] = await Promise.all([
    getJson(baseUrl, '/api/customers'),
    getJson(baseUrl, '/api/vendors'),
    getJson(baseUrl, '/api/accounts'),
  ]);
  const code = (value) => accounts.find((row) => row.code === value).id;
  const vendor = vendors.find((row) => row.is_active);
  const booking = await postJson(baseUrl, '/api/bookings', {
    customer_id: customers[0].id,
    booking_date: '2026-10-21',
    due_date: '2099-01-01',
    destination: 'E2E Dubai–Muscat',
    pnr: 'E2EMCT',
    sale_items: [{ description: 'E2E Muscat Pax', passenger_name: 'E2E Muscat Pax', line_group: 1, quantity: 1, unit_price_cents: 73_000, account_id: code('4000') }],
    cost_items: [{ description: 'E2E Muscat Pax', passenger_name: 'E2E Muscat Pax', line_group: 1, quantity: 1, unit_price_cents: 60_000, account_id: code('5000'), vendor_id: vendor.id }],
  });

  await openRoute('/bookings');
  await page.locator('#booking-search').fill('E2EMCT');
  await page.waitForTimeout(100);
  assert.match(await page.locator('table.data tbody [data-payment-status]').first().innerText(), /Not invoiced/);

  await openRoute(`/bookings/${booking.id}`);
  await page.locator('[data-action="confirm"]').click();
  const preview = page.locator('[role="dialog"] [data-preview]');
  await preview.waitFor();
  const previewText = (await preview.innerText()).replace(/\s+/g, ' ');
  assert.match(previewText, /Customer invoice/);
  assert.ok(previewText.includes(`Supplier bill — ${vendor.name}`));
  assert.match(previewText, /Gross profit AED 130\.00/);
  await page.locator('[role="dialog"] [data-submit]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.waitForFunction(() => !document.querySelector('[data-action="confirm"]'));

  const saved = await getJson(baseUrl, `/api/bookings/${booking.id}`);
  await openRoute('/bookings');
  await page.locator('#booking-search').fill('E2EMCT');
  await page.waitForTimeout(100);
  assert.match(await page.locator('table.data tbody [data-payment-status]').first().innerText(), /Unpaid/);

  await postJson(baseUrl, `/api/invoices/${saved.invoice_id}/payments`, {
    amount_cents: 30_000, payment_date: '2026-10-22', deposit_account_id: code('1000'), method: 'Cash',
  });
  await openRoute(`/invoices/${saved.invoice_id}`);
  await page.locator('[data-amount-words]').waitFor();
  assert.match(await page.locator('[data-amount-words]').innerText(), /UAE Dirhams Seven Hundred Thirty Only/);

  await clickPageAction('[data-action="share"]');
  const share = page.locator('[role="dialog"]');
  await share.waitFor();
  assert.match(await share.locator('#share-message').inputValue(), /Amount due: AED 430\.00/);
  assert.match(await share.locator('[data-share="email"]').getAttribute('href'), /^mailto:/);
  assert.match(await share.locator('[data-share="whatsapp"]').getAttribute('href'), /^https:\/\/wa\.me\/\d*\?text=/);
  await share.locator('.modal-head [data-close]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

  await page.locator('[data-fold="payments"] > summary').click();
  await page.locator('[data-receipt-link]').first().click();
  await page.locator('[data-receipt]').waitFor();
  const receipt = (await page.locator('[data-receipt]').innerText()).replace(/\s+/g, ' ');
  assert.match(receipt, /receipt voucher/i);
  assert.match(receipt, /AED 300\.00/);
  assert.match(receipt, /UAE Dirhams Three Hundred Only/);
  assert.match(receipt, /Invoice balance now AED 430\.00/);
  assert.ok(receipt.includes(saved.number), 'names the booking');

  await openRoute('/bookings');
  await page.locator('#booking-search').fill('E2EMCT');
  await page.waitForTimeout(100);
  assert.match((await page.locator('table.data tbody [data-payment-status]').first().innerText()).replace(/\s+/g, ' '), /Partial AED 430\.00 due/);
  assertNoConsoleErrors();
});

test('a cancelled sale stays on its day in the DSR and statement, with its own cancellation line', async () => {
  const [vendors, accounts] = await Promise.all([getJson(baseUrl, '/api/vendors'), getJson(baseUrl, '/api/accounts')]);
  const code = (value) => accounts.find((row) => row.code === value).id;
  const vendor = vendors.find((row) => row.is_active);
  const customer = await postJson(baseUrl, '/api/customers', { name: 'E2E Cancel History' });
  const booking = await postJson(baseUrl, '/api/bookings', {
    customer_id: customer.id,
    booking_date: '2026-10-15',
    due_date: '2026-10-15',
    destination: 'E2E Dubai–Doha',
    sale_items: [{ description: 'E2E Doha Pax', quantity: 1, unit_price_cents: 50_000, account_id: code('4000') }],
    cost_items: [{ description: 'E2E Doha Pax', quantity: 1, unit_price_cents: 40_000, account_id: code('5000'), vendor_id: vendor.id }],
  });
  const confirmed = await postJson(baseUrl, `/api/bookings/${booking.id}/confirm`, {}, 200);
  await postJson(baseUrl, `/api/invoices/${confirmed.invoice_id}/payments`, {
    amount_cents: 50_000, payment_date: '2026-10-15', deposit_account_id: code('1000'), method: 'Cash',
  });
  await postJson(baseUrl, `/api/bookings/${booking.id}/cancel`, { cancellation_date: '2026-10-18', customer_charges_cents: 5_000 }, 200);
  const cancellation = (await getJson(baseUrl, '/api/cancellations')).find((row) => row.source_type === 'booking' && row.source_id === booking.id);

  await openRoute('/reports/daily-sales');
  await setReportPeriod('2026-10-01');
  await page.locator('[data-dsr]').waitFor();
  await page.locator('[data-dsr-section="cancellations"] [data-dsr-fold]').click();
  const tickets = page.locator('[data-dsr-table="tickets"]');
  const saleRow = tickets.locator('tr', { has: page.locator(`a[href="#/invoices/${confirmed.invoice_id}"]`) });
  assert.match(await saleRow.innerText(), /Cancelled/);
  const reversal = page.locator('[data-dsr-table="cancellations"] tr.dsr-cancellation-row', { has: page.locator(`a[href="#/cancellations/${cancellation.id}"]`) });
  const cells = await reversal.locator('td').allInnerTexts();
  assert.deepEqual(cells.slice(3, 7).map((text) => text.trim()), ['-500.00', '50.00', '—', '-450.00'], 'sale reversed, charges kept, no supplier credit, net');

  await openRoute(`/customers/${customer.id}/statement`);
  await page.locator('.statement-desc-title').first().waitFor();
  const titles = await page.locator('.statement-desc-title').allInnerTexts();
  assert.deepEqual(titles, ['Invoice raised', 'Payment received', 'Booking or visa cancelled', 'Cancellation charges']);
  assertNoConsoleErrors();
});

test('the DSR shows sales by type with how each was settled, money out and a cash summary', async () => {
  const [customers, accounts] = await Promise.all([getJson(baseUrl, '/api/customers'), getJson(baseUrl, '/api/accounts')]);
  const code = (value) => accounts.find((row) => row.code === value).id;
  const today = new Date().toLocaleDateString('en-CA');
  const service = await postJson(baseUrl, '/api/invoices', {
    customer_id: customers[0].id,
    issue_date: today,
    items: [
      { description: 'E2E DSR meet and assist', quantity: 1, unit_price_cents: 30_000, account_id: code('4300') },
    ],
  });
  await postJson(baseUrl, `/api/invoices/${service.id}/payments`, {
    amount_cents: 10_000, payment_date: today, deposit_account_id: code('1000'), method: 'Cash',
  });

  await openRoute('/reports/daily-sales');
  await page.locator('[data-action="daily-today"]').click();
  await page.locator('[data-dsr-table="services"]').waitFor();
  for (const id of ['tickets', 'visas', 'services', 'cancellations', 'collections', 'cash-out', 'summary']) {
    assert.equal(await page.locator(`[data-dsr-section="${id}"]`).count(), 1, `section ${id}`);
  }
  const row = page.locator('[data-dsr-table="services"] tr', { has: page.locator(`a[href="#/invoices/${service.id}"]`) });
  const cells = (await row.locator('td').allInnerTexts()).map((text) => text.trim());
  assert.deepEqual(cells.slice(3), ['300.00', 'Cash 100.00', '200.00'], 'total, paid by, due');
  assert.equal(await page.locator('[data-dsr-section="collections"] .dsr-section-body').isVisible(), false, 'smaller sections start folded');
  await page.locator('[data-dsr-section="collections"] [data-dsr-fold]').click();
  assert.equal(await page.locator('[data-dsr-section="collections"] .dsr-section-body').isVisible(), true, 'and open on a click');

  assert.equal(await page.locator('[data-dsr] th.dsr-profit:has-text("Gross profit")').first().isVisible(), false, 'profit hidden by default');
  await page.locator('[data-dsr-profit]').check();
  assert.equal(await page.locator('[data-dsr] th.dsr-profit:has-text("Gross profit")').first().isVisible(), true);
  await page.locator('[data-dsr-profit]').uncheck();
  const overview = await page.locator('[data-dsr-summary]').innerText();
  assert.match(overview, /Total sales[\s\S]*Received[\s\S]*On credit/i, 'the totals come first');
  assert.match(overview, /How the money came in[\s\S]*Cash[\s\S]*Opening[\s\S]*Closing/i);
  // Received is every cash, card and bank amount in the legend added up.
  const toCents = (text) => Math.round(Number(String(text).replace(/[^0-9.-]/g, '')) * 100);
  const received = toCents(await page.locator('[data-dsr-summary] .dsr-tile', { hasText: 'Received' }).locator('.dsr-tile-value').innerText());
  const legend = (await page.locator('[data-dsr-summary] .dsr-legend span').allInnerTexts()).map((text) => toCents(text.split(' ').pop()));
  assert.equal(received, legend.reduce((sum, cents) => sum + cents, 0), 'Received equals cash + card + bank');
  assert.ok(received >= 10_000, 'it includes the 100.00 cash taken today');
  assertNoConsoleErrors();
});

test('a visa security deposit is taken with the application, shown apart from sales and refunded', async () => {
  await openRoute('/visas?new=1');
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  await dialog.locator('#vg-customer').selectOption({ index: 1 });
  await dialog.locator('#vg-country').fill('E2E Deposit UAE');
  const row = dialog.locator('[data-va-row]').first();
  await row.locator('.va-name').fill('E2E Deposit Visitor');
  await row.locator('.va-sale').fill('350');
  assert.equal(await dialog.locator('[data-deposit-received]').isVisible(), false, 'deposit fields appear only with a deposit');
  await row.locator('.va-deposit').fill('4000');
  assert.equal(await dialog.locator('[data-deposit-received]').isVisible(), true);
  assert.equal((await dialog.locator('#vg-margin').innerText()).replace(/\s+/g, ' '), 'AED 350.00', 'the deposit is not part of the margin');
  await dialog.locator('[data-submit]').click();
  await page.waitForFunction(() => location.hash.startsWith('#/visas/'));

  const card = page.locator('[data-visa-deposits]');
  await card.waitFor();
  assert.match((await card.innerText()).replace(/\s+/g, ' '), /Still held AED 4,000\.00/);
  await card.locator('[data-deposit-action="refund"]').click();
  const refund = page.locator('[role="dialog"]');
  await refund.waitFor();
  await refund.locator('#dep-amount').fill('1500');
  await refund.locator('[data-submit]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.waitForFunction(() => /still held aed 2,500\.00/i.test((document.querySelector('[data-visa-deposits]')?.innerText || '').replace(/\s+/g, ' ')));

  const visaId = Number(await page.evaluate(() => location.hash.split('/').pop()));
  await openRoute('/reports/visa-deposits');
  await page.locator('[data-deposit-register]').waitFor();
  const registerRow = page.locator('[data-deposit-register] tbody tr', { has: page.locator(`a[href="#/visas/${visaId}"]`) });
  assert.match((await registerRow.innerText()).replace(/\s+/g, ' '), /AED 4,000\.00.*AED 1,500\.00.*AED 2,500\.00/);

  const checks = await getJson(baseUrl, '/api/reports/reconciliation');
  for (const key of ['visa_deposits', 'deposits_with_suppliers']) {
    assert.equal(checks.checks.find((item) => item.key === key).matched, true, `${key} matches`);
  }

  // The deposit refund page names the deposit and sends Void to the deposit card.
  const visaDetail = await getJson(baseUrl, `/api/visas/${visaId}`);
  const refundId = visaDetail.deposits[0].events.find((event) => event.event_type === 'refund').refund_id;
  await openRoute(`/refunds/${refundId}`);
  await page.locator('[data-void-elsewhere]').waitFor();
  assert.equal(await page.locator('#page-actions [data-action="void"]').count(), 0);
  assert.equal(await page.locator(`#page-actions a[href="#/visas/${visaId}"]`).count(), 1);

  // The visa invoice shows the deposit in its own card (not in the total) and the visa terms.
  const putSettings = (body) => fetch(`${baseUrl}/api/settings`, { method: 'PUT', headers: { Origin: baseUrl, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const before = await getJson(baseUrl, '/api/settings');
  await putSettings({ invoice_terms_visa: 'E2E visa terms', invoice_terms_ticket: 'E2E ticket terms' });
  try {
    const submitted = await postJson(baseUrl, `/api/visas/${visaId}/submit`, {}, 200);
    await openRoute(`/invoices/${submitted.invoice_id}`);
    const depositCard = page.locator('[data-visa-deposit]');
    await depositCard.waitFor();
    const depositText = (await depositCard.innerText()).replace(/\s+/g, ' ');
    assert.match(depositText, /Held/);
    assert.match(depositText, /AED 4,000\.00/, 'the amount collected');
    assert.match(depositText, /Returned .*AED 1,500\.00/);
    assert.match((await page.locator('.doc-total-area').innerText()).replace(/\s+/g, ' '), /AED 350\.00/, 'the total is the sale only');
    assert.equal((await page.locator('.doc-terms-foot').innerText()).trim(), 'E2E visa terms');

    // Dark screen: the document stays white paper with readable text; the amount keeps a gap from the box edge.
    const looks = await page.evaluate(() => {
      document.documentElement.dataset.theme = 'dark';
      const light = (color) => { const [r, g, b] = color.match(/\d+/g).map(Number); return (r + g + b) / 3 > 128; };
      const style = (selector) => getComputedStyle(document.querySelector(selector));
      const result = {
        paper: light(style('.doc').backgroundColor),
        totals: light(style('.doc-totals').backgroundColor),
        header: light(style('.doc-items-wrap th').backgroundColor),
        text: light(style('.doc-company-name').color),
        gap: parseFloat(style('.doc-items-wrap tbody td:last-child').paddingRight),
      };
      document.documentElement.dataset.theme = 'light';
      return result;
    });
    assert.deepEqual([looks.paper, looks.totals, looks.header, looks.text], [true, true, true, false], 'white paper with dark text in dark mode');
    assert.ok(looks.gap > 0, 'the amount does not touch the table edge');
    // Paper stays light even when the screen is dark (the margins too).
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; document.documentElement.style.colorScheme = 'dark'; });
    await page.emulateMedia({ media: 'print' });
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme), 'light');
    await page.emulateMedia({ media: 'screen' });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; document.documentElement.style.colorScheme = 'light'; });
  } finally {
    await putSettings({ invoice_terms_visa: before.invoice_terms_visa || '', invoice_terms_ticket: before.invoice_terms_ticket || '' });
  }

  // A statement with deposits does not scroll sideways on a phone.
  await page.setViewportSize({ width: 375, height: 800 });
  await openRoute(`/customers/${visaDetail.customer_id}/statement`);
  await page.locator('[data-statement-deposits]').waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await page.setViewportSize({ width: 1440, height: 1000 });
  assertNoConsoleErrors();
});

test('simplified navigation, Today box, summary strip, More menu and phone layout', async () => {
  await openRoute('/dashboard');
  // Sidebar: everyday groups open, "Bank and books" starts closed and opens on click.
  const more = page.locator('[data-nav-group="books"]');
  assert.match(await more.getAttribute('class'), /collapsed/);
  assert.equal(await page.locator('#main-nav a[href="#/journal"]').isVisible(), false);
  await more.locator('.nav-group-label').click();
  assert.equal(await page.locator('#main-nav a[href="#/journal"]').isVisible(), true);
  await more.locator('.nav-group-label').click();
  assert.match(await page.locator('#main-nav').innerText(), /Suppliers/);

  // "Things pending": one closed line; it opens into groups, a group into
  // items with their days, each linking to the work.
  const pending = page.locator('[data-pending]');
  await pending.waitFor();
  const bar = pending.locator('[data-pending-toggle]');
  assert.match(await bar.innerText(), /\d+\s+things? pending/);
  assert.equal(await pending.locator('#pending-panel').isVisible(), false, 'closed at first');
  await bar.click();
  assert.equal(await bar.getAttribute('aria-expanded'), 'true');
  const group = pending.locator('.pending-group-head').first();
  await group.click();
  const firstItem = pending.locator('.pending-items:not([hidden]) .pending-item').first();
  await firstItem.waitFor();
  assert.match(await firstItem.getAttribute('href'), /^#\//);
  assert.match(await firstItem.innerText(), /day|today/);

  // Recent shows one list at a time; the switch changes which.
  const recent = page.locator('[data-recent]');
  const shownLists = () => recent.locator('[data-recent-list]').evaluateAll((lists) => lists.filter((list) => list.offsetParent).map((list) => list.dataset.recentList));
  assert.deepEqual(await shownLists(), ['invoices']);
  await recent.locator('[data-seg-value="bills"]').click();
  assert.deepEqual(await shownLists(), ['bills']);
  assert.equal(await recent.locator('[data-seg-value="bills"]').getAttribute('aria-pressed'), 'true');
  await recent.locator('[data-seg-value="invoices"]').click();
  await page.evaluate(AXE_SOURCE);
  assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document.querySelector('[data-pending]'), {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
  })).violations.map((violation) => violation.id)), [], 'pending reminder axe');
  await bar.click();

  // Detail page: summary strip, account codes hidden until switched on, More menu.
  const bookings = await getJson(baseUrl, '/api/bookings');
  const booking = bookings.find((row) => row.status === 'confirmed') || bookings[0];
  await openRoute(`/bookings/${booking.id}`);
  const strip = page.locator('[data-summary-strip]');
  assert.match((await strip.innerText()).replace(/\s+/g, ' '), /Total.*Paid.*Balance.*Gross profit/i);
  // Who made it: a small line at the bottom of the page.
  const meta = page.locator('#view [data-record-meta]');
  await meta.waitFor();
  assert.match(await meta.innerText(), /Created by .+ · \d{1,2} \w{3} \d{4}/);
  assert.equal(await page.locator('th.acct-col').first().isVisible(), false, 'account codes hidden by default');
  await clickPageAction('[data-action="toggle-accounting"]');
  assert.equal(await page.locator('th.acct-col').first().isVisible(), true);
  await clickPageAction('[data-action="toggle-accounting"]');
  assert.equal(await page.locator('#page-actions .more-menu').getAttribute('open'), null, 'menu closes after a choice');

  // Quick dates on lists.
  await openRoute('/invoices');
  await page.locator('[data-date-preset="month"]').click();
  assert.match(await page.locator('#date-from').inputValue(), /-01$/);

  // Phone: tab bar and card rows.
  await page.setViewportSize({ width: 375, height: 800 });
  await openRoute('/bookings');
  const tabbar = page.locator('.tabbar');
  assert.equal(await tabbar.isVisible(), true);
  assert.match(await tabbar.locator('.tab-item.active').innerText(), /Bookings/);
  const firstCell = page.locator('table.cards-sm tbody tr').first().locator('td').nth(3);
  assert.ok(await firstCell.getAttribute('data-label'), 'cells are labelled for the card layout');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  await tabbar.locator('[data-tab-more]').click();
  assert.match(await page.locator('#sidebar').getAttribute('class'), /open/);
  await page.setViewportSize({ width: 1440, height: 1000 });
  assertNoConsoleErrors();
});

test('quiet transitions run, mark wrong input, and switch off for reduced motion', async () => {
  // The suite runs with reduced motion; nothing animates then.
  await openRoute('/invoices');
  const pageAnimation = () => page.evaluate(() => getComputedStyle(document.querySelector('#view > *')).animationName);
  assert.equal(await pageAnimation(), 'none', 'no motion when the system asks for reduced motion');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await openRoute('/invoices');
  assert.equal(await pageAnimation(), 't-page');

  // A missing customer: the message and the empty field shake, the field is marked.
  await openRoute('/invoices?new=1');
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  await dialog.locator('.line-desc').first().fill('E2E shake');
  await dialog.locator('.line-price').first().fill('10');
  await dialog.locator('[data-submit]').click();
  await dialog.locator('.modal-error:not([hidden])').waitFor();
  assert.equal(await dialog.locator('#invoice-customer').getAttribute('aria-invalid'), 'true');
  await dialog.locator('.modal-head [data-close]').click();

  // More menu opens with its dropdown animation.
  const invoices = await getJson(baseUrl, '/api/invoices');
  await openRoute(`/invoices/${invoices[0].id}`);
  await page.locator('#page-actions .more-menu > summary').click();
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.more-menu-list')).animationName), 't-menu-in');

  await page.emulateMedia({ reducedMotion: 'reduce' });

  // On a phone the tab bar's More turns into Close (✕) while the sidebar is open.
  await page.setViewportSize({ width: 375, height: 800 });
  await openRoute('/dashboard');
  const more = page.locator('.tabbar [data-tab-more]');
  const iconOpacity = (name) => page.evaluate((n) => getComputedStyle(document.querySelector(`[data-tab-more] .tab-icon-${n}`)).opacity, name);
  assert.deepEqual([await iconOpacity('open'), await iconOpacity('close')], ['1', '0']);
  await more.click();
  assert.equal(await more.getAttribute('aria-expanded'), 'true');
  assert.deepEqual([await iconOpacity('open'), await iconOpacity('close')], ['0', '1']);
  assert.match(await more.innerText(), /Close/);
  await more.click();
  assert.doesNotMatch(await page.locator('#sidebar').getAttribute('class'), /\bopen\b/);
  assert.deepEqual([await iconOpacity('open'), await iconOpacity('close')], ['1', '0']);

  // The hamburger reappears at the top of the open sidebar as ✕ and closes it.
  await page.locator('#menu-btn').click();
  const burger = page.locator('#sidebar-close');
  assert.equal(await burger.isVisible(), true);
  const burgerOpacity = (name) => page.evaluate((n) => getComputedStyle(document.querySelector(`#sidebar-close .burger-${n}`)).opacity, name);
  assert.deepEqual([await burgerOpacity('open'), await burgerOpacity('close')], ['0', '1']);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#sidebar-close .burger-close')).animationName), 't-burger-in');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await burger.click();
  assert.doesNotMatch(await page.locator('#sidebar').getAttribute('class'), /\bopen\b/);

  // Desktop: the hamburger folds into ← while the sidebar is shown, ☰ when hidden.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openRoute('/dashboard');
  const topLine = () => page.evaluate(() => getComputedStyle(document.querySelector('#menu-btn .burger-top')).transform);
  assert.equal(await page.locator('#menu-btn').getAttribute('aria-expanded'), 'true');
  assert.notEqual(await topLine(), 'none', 'arrow while the sidebar is shown');
  await page.locator('#menu-btn').click();
  assert.equal(await page.locator('#menu-btn').getAttribute('aria-expanded'), 'false');
  assert.equal(await topLine(), 'none', 'hamburger while the sidebar is hidden');
  await page.locator('#menu-btn').click();
  assert.equal(await page.locator('#menu-btn').getAttribute('aria-expanded'), 'true');
  await page.setViewportSize({ width: 1440, height: 1000 });
  assertNoConsoleErrors();
});

test('the reports home groups reports and each report has quick periods', async () => {
  await openRoute('/reports');
  const home = page.locator('[data-reports-home]');
  await home.waitFor();
  assert.deepEqual(
    (await home.locator('h2').allInnerTexts()).map((text) => text.trim().toLowerCase()),
    ['daily work', 'how the business is doing', 'for your accountant'],
  );
  assert.equal(await home.locator('[data-report-link]').count(), 11);
  await home.locator('[data-report-link="income-statement"]').click();
  await page.locator('[data-profit-or-loss]').waitFor();
  assert.match(await page.locator('#page-title').innerText(), /Statement of Profit or Loss/);
  assert.equal(await page.locator('.tabs').count(), 0, 'no long tab strip');
  await page.locator('[data-preset="year"]').click();
  await page.waitForFunction(() => document.querySelector('#report-from')?.value.endsWith('-01-01'));
  await page.locator('[data-profit-or-loss]').waitFor();
  await page.locator('[data-preset="last-month"]').click();
  assert.match(await page.locator('#report-to').inputValue(), /^\d{4}-\d{2}-\d{2}$/);
  await page.locator('#page-actions [data-all-reports]').click();
  await page.locator('[data-reports-home]').waitFor();
  assertNoConsoleErrors();
});

test('a quick expense is saved and paid in one step', async () => {
  await openRoute('/bills');
  await page.locator('#page-actions [data-action="quick-expense"]').click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  assert.match(await dialog.locator('h2').first().innerText(), /Quick expense/);
  await dialog.locator('#qe-description').fill('E2E taxi to embassy');
  await dialog.locator('#qe-amount').fill('45');
  await dialog.locator('[data-submit]').click();
  await page.waitForFunction(() => /^#\/bills\/\d+/.test(location.hash));
  const id = Number(await page.evaluate(() => location.hash.split('/').pop()));
  const bill = await getJson(baseUrl, `/api/bills/${id}`);
  assert.equal(bill.total_cents, 4_500);
  assert.equal(bill.status_display, 'paid');
  assert.equal(bill.vendor_name, 'Sundry (cash expenses)');
  assert.equal(bill.payments[0].method, 'Cash');
  assertNoConsoleErrors();
});

test('advances are used on confirm, recorded from the customer page and shown on the statement', async () => {
  const [vendors, accounts] = await Promise.all([getJson(baseUrl, '/api/vendors'), getJson(baseUrl, '/api/accounts')]);
  const code = (value) => accounts.find((row) => row.code === value).id;
  const customer = await postJson(baseUrl, '/api/customers', { name: 'E2E Advance Customer' });
  const booking = await postJson(baseUrl, '/api/bookings', {
    customer_id: customer.id, booking_date: '2026-10-20', due_date: '2026-10-20',
    sale_items: [{ description: 'E2E ticket', quantity: 1, unit_price_cents: 50_000, account_id: code('4000') }],
    cost_items: [{ description: 'E2E fare', quantity: 1, unit_price_cents: 40_000, account_id: code('5000'), vendor_id: vendors.find((row) => row.is_active).id }],
  });
  await postJson(baseUrl, '/api/advances', {
    customer_id: customer.id, booking_id: booking.id, amount_cents: 20_000, advance_date: '2026-10-19', deposit_account_id: code('1010'),
  });

  await openRoute(`/bookings/${booking.id}`);
  await page.locator('[data-action="confirm"]').click();
  const preview = page.locator('[role="dialog"] [data-preview]');
  await preview.waitFor();
  assert.match((await preview.innerText()).replace(/\s+/g, ' '), /Paid from advance ADV-\d{4}-\d{4} .*−AED 200\.00/);
  await page.locator('[role="dialog"] [data-submit]').click();
  await page.waitForFunction(() => !document.querySelector('[data-action="confirm"]'));
  const confirmed = await getJson(baseUrl, `/api/bookings/${booking.id}`);
  assert.equal(confirmed.invoice.amount_paid_cents, 20_000);

  // A general advance from the customer balance page.
  await openRoute(`/customer-balances/${customer.id}`);
  await clickPageAction('[data-action="record-advance"]');
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  await dialog.locator('#ca-amount').fill('150');
  await dialog.locator('[data-submit]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.locator('[data-fold="advances"] > summary').click();
  await page.locator('[data-advance-apply]').first().waitFor();

  await openRoute(`/customers/${customer.id}/statement?to=2026-12-31`);
  const section = page.locator('[data-statement-advances]');
  await section.waitFor();
  assert.match(await section.innerText(), /Advances held for you/);
  // One line with the amount; the history opens on click.
  assert.equal(await section.locator('table').isVisible(), false);
  await section.locator('summary').click();
  assert.match((await section.innerText()).replace(/\s+/g, ' '), /Advance used to pay invoice/);
  assertNoConsoleErrors();
});

test('monthly bank charges in Compliance are recorded as paid bank debits', async () => {
  const lastMonth = new Date();
  lastMonth.setMonth(lastMonth.getMonth() - 1);
  const due = lastMonth.toLocaleDateString('en-CA');

  await openRoute('/compliance');
  await clickPageAction('[data-action="new-compliance"]');
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  assert.equal(await dialog.locator('#ci-debit-account').isVisible(), false, 'bank debit is off by default');
  await dialog.locator('#ci-category').selectOption('Bank charges');
  assert.equal(await dialog.locator('#ci-bank-debit').isChecked(), true, 'Bank charges turns bank debit on');
  assert.match(await dialog.locator('#ci-account option:checked').innerText(), /6700 · Bank Charges/);
  assert.match(await dialog.locator('#ci-debit-account option:checked').innerText(), /1010/);
  assert.equal(await dialog.locator('#ci-auto-field').isVisible(), false, 'no draft option for a bank debit');
  assert.equal(await dialog.locator('#ci-payment-method').isVisible(), false);
  await dialog.locator('#ci-name').fill('E2E bank maintenance charges');
  // No supplier needed for money the bank takes itself: it saves without one.
  await dialog.locator('#ci-amount').fill('26.25');
  await dialog.locator('#ci-next-due').fill(due);
  await dialog.locator('[data-submit]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

  // Run due bills records the due period as a paid bill.
  const row = page.locator('tr', { hasText: 'E2E bank maintenance charges' });
  await row.waitFor();
  assert.match((await row.innerText()).replace(/\s+/g, ' '), /Bank Account \(bank debits\)/);
  assert.match((await row.innerText()).replace(/\s+/g, ' '), /Bank debit/);
  await clickPageAction('[data-action="run-due"]');
  await page.waitForFunction((date) => {
    const cell = [...document.querySelectorAll('tr')].find((tr) => tr.textContent.includes('E2E bank maintenance charges'));
    return cell && /Last bill/.test(cell.textContent);
  }, due);
  const bills = await getJson(baseUrl, '/api/bills');
  const bill = bills.find((row) => row.bill_date === due && row.total_cents === 2_625 && row.status_display === 'paid');
  assert.ok(bill, 'the bank charge is a paid bill on its due date');
  assertNoConsoleErrors();
});

test('bank charges on a payment, a charge added in bank reconciliation, and petty cash', async () => {
  const [customers, accounts] = await Promise.all([getJson(baseUrl, '/api/customers'), getJson(baseUrl, '/api/accounts')]);
  const code = (value) => accounts.find((row) => row.code === value).id;
  const invoice = await postJson(baseUrl, '/api/invoices', {
    customer_id: customers[0].id, issue_date: new Date().toLocaleDateString('en-CA'), status: 'sent',
    items: [{ description: 'E2E charges service', quantity: 1, unit_price_cents: 100_000, account_id: code('4300') }],
  });

  // Record payment: the bank charges field shows for a transfer, hides for cash.
  await openRoute(`/invoices/${invoice.id}`);
  await clickPageAction('[data-action="payment"]');
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  assert.equal(await dialog.locator('#bank-charges').isVisible(), true);
  await dialog.locator('#payment-method').selectOption('Cash');
  assert.equal(await dialog.locator('#bank-charges').isVisible(), false, 'no bank charge on cash');
  await dialog.locator('#payment-method').selectOption('Bank transfer');
  await dialog.locator('#bank-charges').fill('15');
  await dialog.locator('[data-submit]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.locator('[data-fold="payments"] > summary').click();
  await page.locator('.payment-item', { hasText: 'Bank charges' }).waitFor();
  const paid = await getJson(baseUrl, `/api/invoices/${invoice.id}`);
  assert.equal(paid.status_display, 'paid');
  assert.equal(paid.payments[0].bank_charges_cents, 1_500);

  // Bank reconciliation: add a charge that is on the statement, ticked straight away.
  await openRoute('/bank-reconciliation');
  await clickPageAction('[data-action="new-reconciliation"]');
  const recon = page.locator('[role="dialog"]');
  await recon.waitFor();
  await recon.locator('#recon-account').selectOption(String(code('1010')));
  await recon.locator('#recon-balance').fill('0');
  await recon.locator('[data-load-workspace]').click();
  await recon.locator('[data-recon-charge] summary').click();
  await recon.locator('#recon-charge-amount').fill('26.25');
  await recon.locator('[data-recon-charge-add]').click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-line-select]:checked')]
    .some((input) => input.dataset.amount === '-2625'));
  await recon.locator('[data-close]').first().click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

  // Petty cash: top up from the bank, then count it short.
  await openRoute('/petty-cash');
  await clickPageAction('[data-action="pc-top-up"]');
  const topUp = page.locator('[role="dialog"]');
  await topUp.locator('#pc-amount').fill('500');
  await topUp.locator('[data-submit]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.locator('[data-petty-lines]').waitFor();
  await clickPageAction('[data-action="pc-count"]');
  const count = page.locator('[role="dialog"]');
  await count.locator('#pc-counted').fill('490');
  await count.locator('[data-count-diff]', { hasText: 'Short by' }).waitFor();
  await count.locator('[data-submit]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.locator('[data-petty-counts]').waitFor();
  const petty = await getJson(baseUrl, '/api/petty-cash');
  assert.equal(petty.balance_cents, 49_000);

  // A count dated before today's top-up is checked against the books on that
  // date, as the server posts it, not against today's 490.00.
  await clickPageAction('[data-action="pc-count"]');
  const backdated = page.locator('[role="dialog"]');
  const yesterday = new Date(Date.now() - 86_400_000).toLocaleDateString('en-CA');
  const before = await getJson(baseUrl, `/api/petty-cash?to=${yesterday}`);
  assert.notEqual(before.closing_cents, 49_000);
  const shown = (before.closing_cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  await backdated.locator('#pc-count-date').fill(yesterday);
  await backdated.locator('#pc-counted').fill('490');
  const note = backdated.locator('[data-count-diff]', { hasText: shown });
  await note.waitFor();
  assert.match(await note.innerText(), /Over by/, 'not "Matches the books"');
  await backdated.locator('[data-close]').first().click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  assertNoConsoleErrors();
});

test('payment link: method sends money to 1030, the link goes on the invoice, and a card settlement takes the fee', async () => {
  const [customers, accounts] = await Promise.all([getJson(baseUrl, '/api/customers'), getJson(baseUrl, '/api/accounts')]);
  const code = (value) => accounts.find((row) => row.code === value).id;
  const invoice = await postJson(baseUrl, '/api/invoices', {
    customer_id: customers[0].id, issue_date: new Date().toLocaleDateString('en-CA'), status: 'sent',
    items: [{ description: 'E2E link service', quantity: 1, unit_price_cents: 40_000, account_id: code('4300') }],
  });

  await openRoute(`/invoices/${invoice.id}`);
  await clickPageAction('[data-action="payment-link"]');
  const linkDialog = page.locator('[role="dialog"]');
  await linkDialog.locator('#pay-link').fill('https://pay.example.com/e2e');
  await linkDialog.locator('[data-submit]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  await page.locator('[data-pay-online]').waitFor();
  assert.match(await page.locator('[data-pay-online]').innerText(), /https:\/\/pay\.example\.com\/e2e/);

  await clickPageAction('[data-action="payment"]');
  const dialog = page.locator('[role="dialog"]');
  await dialog.locator('#payment-method').selectOption('Payment link');
  assert.match(await dialog.locator('#payment-account option:checked').innerText(), /^1030/);
  assert.equal(await dialog.locator('#bank-charges').isVisible(), false, 'the fee is taken at settlement');
  await dialog.locator('[data-submit]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  assert.equal(await page.locator('[data-pay-online]').count(), 0, 'no pay link once paid');

  await openRoute('/card-settlements');
  const row = page.locator('[data-settle-items] tbody tr').last();
  await row.locator('[data-settle-item]').check();
  await page.locator('#settle-net').fill('390');
  assert.match(await page.locator('[data-settle-fee]').innerText(), /10\.00/);
  await page.locator('[data-settle-form] button[type="submit"]').click();
  await page.locator('[data-settlements]').waitFor();
  const data = await getJson(baseUrl, '/api/card-settlements');
  assert.equal(data.settlements[0].fee_cents, 1_000);
  assert.equal(data.open_total_cents, data.in_transit_cents);

  // Advances follow the method too: a payment link advance waits in 1030.
  await openRoute(`/customer-balances/${customers[0].id}`);
  await clickPageAction('[data-action="record-advance"]');
  const advance = page.locator('[role="dialog"]');
  await advance.locator('#ca-method').selectOption('Payment link');
  assert.match(await advance.locator('#ca-account option:checked').innerText(), /^1030/);
  await advance.locator('#ca-method').selectOption('Cash');
  assert.match(await advance.locator('#ca-account option:checked').innerText(), /^1000/);
  await advance.locator('[data-close]').first().click();
  assertNoConsoleErrors();
});

test('the booking and visa pages open Record customer advance, with payment link sent to 1030', async () => {
  const [bookings, visas] = await Promise.all([getJson(baseUrl, '/api/bookings'), getJson(baseUrl, '/api/visas')]);
  const booking = bookings.find((row) => row.status !== 'cancelled');
  const visa = visas.find((row) => !['cancelled', 'rejected'].includes(row.status));
  for (const route of [`/bookings/${booking.id}`, `/visas/${visa.id}`]) {
    await openRoute(route);
    await page.locator('[data-action="record-advance"]').first().click();
    const dialog = page.locator('[role="dialog"]');
    await dialog.locator('#adv-method').waitFor();
    await dialog.locator('#adv-method').selectOption('Payment link');
    assert.match(await dialog.locator('#adv-account option:checked').innerText(), /^1030/, `${route} sends payment link to 1030`);
    await dialog.locator('[data-close]').first().click();
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));
  }
  assertNoConsoleErrors();
});

test('documents show the agency initial, not a Netfare or old Ledgerly mark', async () => {
  const [invoices, settings] = await Promise.all([getJson(baseUrl, '/api/invoices'), getJson(baseUrl, '/api/settings')]);
  await openRoute(`/invoices/${invoices[0].id}`);
  const mark = page.locator('.doc-brand .brand-mark');
  await mark.waitFor();
  assert.equal((await mark.innerText()).trim(), settings.company_name.trim().charAt(0).toUpperCase());
  await openRoute('/settings');
  assert.ok(await page.locator('.about-logo-light').evaluate((img) => img.complete && img.naturalWidth > 0), 'About logo loads');
  assertNoConsoleErrors();
});

test('sign-in: the admin adds a staff user in Settings, who signs in without admin cards', async () => {
  await openRoute('/settings');
  await page.locator('#recovery-key-status', { hasText: 'Made on' }).waitFor();
  const card = page.locator('#users-card');
  await card.waitFor();
  assert.match(await card.innerText(), /E2E Admin/);
  await card.locator('#user-new').click();
  const modal = page.locator('.modal');
  await modal.locator('#user-name').fill('Counter Staff');
  await modal.locator('#user-username').fill('counter');
  await modal.locator('#pw-new').fill('counter-pass-1');
  await modal.locator('#pw-confirm').fill('counter-pass-2');
  await modal.locator('[data-submit]').click();
  // The error box is always in the modal (hidden, empty); wait for the text
  // itself, which appears only once the form has been checked.
  await modal.locator('.modal-error:not([hidden])', { hasText: 'do not match' }).waitFor();
  await modal.locator('#pw-confirm').fill('counter-pass-1');
  await modal.locator('[data-submit]').click();
  await modal.waitFor({ state: 'detached' });
  const row = card.locator('tbody tr', { hasText: 'Counter Staff' });
  await row.waitFor();
  assert.match(await row.innerText(), /View 1/, 'a new user starts with Dashboard only');

  // Rights: Bookings Edit, Invoices View, nothing to void.
  await row.locator('[data-user-rights]').click();
  const rights = page.locator('.modal');
  await rights.locator('input[name="right-bookings"][value="edit"]').check();
  await rights.locator('input[name="right-sales"][value="view"]').check();
  assert.equal(await rights.locator('input[name="right-reports"][value="edit"]').count(), 0, 'Reports has no Edit');
  await rights.locator('[data-submit]').click();
  await rights.waitFor({ state: 'detached' });
  await card.locator('tbody tr', { hasText: 'Edit 1 · View 2' }).waitFor();
  assertNoConsoleErrors();

  // A browser with no session sees the sign-in screen, never the books.
  const guest = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  try {
    const guestPage = await guest.newPage();
    const errors = [];
    guestPage.on('pageerror', (error) => errors.push(error.message));
    await guestPage.goto(`${baseUrl}/#/invoices`);
    const signIn = guestPage.locator('#auth-root');
    await signIn.waitFor();
    assert.equal(await guestPage.locator('.app').isVisible(), false, 'the app stays hidden');
    for (const theme of ['light', 'dark']) {
      await guestPage.evaluate((name) => { document.documentElement.dataset.theme = name; }, theme);
      await guestPage.evaluate(AXE_SOURCE);
      const violations = await guestPage.evaluate(async () => (await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      })).violations.map((violation) => violation.id));
      assert.deepEqual(violations, [], `sign-in screen axe (${theme})`);
    }
    // Forgot password: help for staff and the admin; this is the main
    // computer, so the reset with the recovery key is offered too.
    await guestPage.locator('[data-forgot]').click();
    await guestPage.locator('#auth-title', { hasText: 'Forgot your password?' }).waitFor();
    await guestPage.locator('[data-reset]').click();
    await guestPage.locator('#auth-recovery_key').waitFor();
    await guestPage.evaluate(AXE_SOURCE);
    assert.deepEqual(await guestPage.evaluate(async () => (await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    })).violations.map((violation) => violation.id)), [], 'reset screen axe');
    await guestPage.locator('#auth-recovery_key').fill('NF-0000-0000-0000-0000');
    await guestPage.locator('#auth-new_password').fill('not-the-one-1');
    await guestPage.locator('#auth-confirm').fill('not-the-one-1');
    await guestPage.locator('.auth-submit').click();
    await guestPage.locator('.auth-error', { hasText: "That recovery key doesn't match" }).waitFor();
    await guestPage.locator('[data-cancel]').click();
    await guestPage.locator('#auth-username').fill('counter');
    await guestPage.locator('#auth-password').fill('wrong-pass');
    await guestPage.locator('.auth-submit').click();
    await guestPage.locator('.auth-error', { hasText: 'Wrong username or password' }).waitFor();
    await guestPage.locator('#auth-password').fill('counter-pass-1');
    await guestPage.locator('.auth-submit').click();
    await guestPage.locator('#auth-root').waitFor({ state: 'detached' });
    await guestPage.locator('.company-meta', { hasText: 'Counter Staff' }).waitFor();
    assert.deepEqual(
      await guestPage.locator('#main-nav .nav-item span').allInnerTexts(),
      ['Dashboard', 'Reminders', 'Bookings', 'Invoices', 'Customer balances', 'Settlements', 'Settings'],
      'the menu shows only screens the user may open (Reminders is open to everyone)',
    );
    const visible = async (selector) => guestPage.locator(selector).evaluateAll((nodes) => nodes.filter((node) => node.offsetParent).length);
    await guestPage.goto(`${baseUrl}/?staff=0#/dashboard`);
    // The one New menu offers only what this user may open.
    await guestPage.locator('#side-tools .tn-new-item[href="#/bookings?new=1"]').waitFor({ state: 'attached' });
    assert.equal(await guestPage.locator('#side-tools .tn-new-item[href="#/bills?new=1"]').count(), 0, 'no New bill without Suppliers rights');
    await guestPage.locator('[data-recent]').waitFor();
    assert.deepEqual(await guestPage.locator('[data-recent] [data-seg-value]').evaluateAll((nodes) => nodes.map((node) => node.dataset.segValue)),
      ['invoices', 'bookings'], 'Recent offers only the lists this user may open');
    await guestPage.goto(`${baseUrl}/?staff=1#/bills`);
    await guestPage.locator('#view .error-state', { hasText: 'You do not have access to this screen' }).waitFor();
    await guestPage.goto(`${baseUrl}/?staff=2#/invoices`);
    await guestPage.locator('#view table').first().waitFor();
    assert.equal(await visible('#page-actions [data-action="new-invoice"]'), 0, 'View only: no New invoice');
    await guestPage.goto(`${baseUrl}/?staff=3#/settings`);
    await guestPage.locator('#company-form').waitFor();
    assert.equal(await guestPage.locator('#users-card').count(), 0, 'no Users card for staff');
    assert.equal(await guestPage.locator('#recovery-key-card').count(), 0, 'no recovery key card for staff');
    assert.equal(await guestPage.locator('#reset-data').isVisible(), false, 'no Clear all data for staff');
    assert.equal(await guestPage.locator('#company-name').isDisabled(), true, 'company settings are read-only without Edit');
    await guestPage.locator('[data-account="signout"]').click();
    await guestPage.locator('#auth-root').waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await guest.close();
  }
});

test('menu: Settings switches to the top menu, its panels and search work, and back to the side', async () => {
  await openRoute('/settings');
  await page.locator('[data-menu-choice="top"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('menu-top')), true);
  assert.equal(await page.locator('#sidebar').isVisible(), false, 'no side menu with the top menu');
  const topNav = page.locator('#top-nav');
  assert.equal(await topNav.isVisible(), true);
  assert.equal(await topNav.locator('#topbar-tools').count(), 1, 'the bell moves into the top menu');

  // A group opens on click with its screens, quick actions and recent records.
  const money = topNav.locator('[data-pop="money-back"]');
  await money.locator('.tn-trigger').click();
  const panel = money.locator('.tn-panel');
  await panel.waitFor();
  assert.equal(await money.locator('.tn-trigger').getAttribute('aria-expanded'), 'true');
  assert.match(await panel.innerText(), /Customer balances/);
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  await money.locator('.tn-trigger').click();
  await panel.locator('a.tn-item[href="#/customer-balances"]').click();
  await page.locator('#page-title', { hasText: 'Customer balances' }).waitFor();
  assert.match(await money.getAttribute('class'), /active/, 'the open screen marks its group');

  // "/" opens search; a customer name jumps to their page.
  const customer = (await getJson(baseUrl, '/api/customers'))[0];
  await page.locator('#view').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('/');
  const search = page.locator('#nf-search-input');
  await search.waitFor();
  await search.fill(customer.name.slice(0, 5));
  await page.locator('.nf-search-row', { hasText: customer.name }).first().waitFor();
  await page.keyboard.press('Enter');
  await page.waitForURL(new RegExp(`#/customer-balances/${customer.id}$`));
  await page.locator('#nf-search').waitFor({ state: 'detached' });

  // The New menu lists only what may be created.
  await topNav.locator('[data-pop="new"] > button').click();
  assert.match(await topNav.locator('.tn-panel-new').innerText(), /New booking[\s\S]*New invoice/);
  await page.keyboard.press('Escape');

  // The top menu with a panel open passes axe in both themes.
  await money.locator('.tn-trigger').click();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((name) => { document.documentElement.dataset.theme = name; }, theme);
    // Let the colour transition finish before checking contrast.
    await page.waitForTimeout(400);
    await page.evaluate(AXE_SOURCE);
    const violations = await page.evaluate(async () => (await window.axe.run(document.getElementById('top-nav'), {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    })).violations.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`));
    assert.deepEqual(violations, [], `top menu axe (${theme})`);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await page.keyboard.press('Escape');

  await openRoute('/settings');
  await page.locator('[data-menu-choice="side"]').click();
  assert.equal(await page.locator('#sidebar').isVisible(), true);
  assert.equal(await topNav.isVisible(), false);
  assert.equal(await page.locator('.topbar #topbar-tools').count(), 1, 'the bell goes back beside the title');
  assertNoConsoleErrors();
});

test('axe WCAG 2.1 AA audit is clean across light and dark themes', async () => {
  const [invoices, bookings, visas, bills, portals, customers, cancellations, credits] = await Promise.all([
    getJson(baseUrl, '/api/invoices'),
    getJson(baseUrl, '/api/bookings'),
    getJson(baseUrl, '/api/visas'),
    getJson(baseUrl, '/api/bills'),
    getJson(baseUrl, '/api/portals'),
    getJson(baseUrl, '/api/customers'),
    getJson(baseUrl, '/api/cancellations'),
    getJson(baseUrl, '/api/credits'),
  ]);

  const paidInvoice = invoices.find((invoice) => invoice.status_display === 'paid');
  const receiptPayment = paidInvoice ? (await getJson(baseUrl, `/api/invoices/${paidInvoice.id}`)).payments[0] : null;
  const routes = [
    '/dashboard',
    '/invoices',
    `/invoices/${invoices[0].id}`,
    ...(receiptPayment ? [`/receipts/${receiptPayment.id}`] : []),
    '/bills',
    `/bills/${bills[0].id}`,
    '/bookings',
    `/bookings/${bookings[0].id}`,
    '/visas',
    `/visas/${visas[0].id}`,
    '/customers',
    `/customers/${customers[0].id}/statement`,
    '/customer-balances',
    `/customer-balances/${customers[0].id}`,
    '/settlement-queue',
    '/cancellations',
    ...(cancellations[0] ? [`/cancellations/${cancellations[0].id}`] : []),
    '/vendors',
    '/portals',
    `/portals/${portals[0].id}`,
    `/portals/${portals[0].id}/ledger`,
    '/refunds',
    '/credits',
    ...(credits[0] ? [`/credits/${credits[0].id}`] : []),
    '/cheques',
    '/compliance',
    '/petty-cash',
    '/card-settlements',
    '/accounts',
    '/banking',
    '/bank-reconciliation',
    '/opening-balances',
    '/journal',
    '/audit-logs',
    `/audit-chain/booking/${bookings[0].id}`,
    '/settings',
    '/reports/income-statement',
    '/reports/balance-sheet',
    '/reports/trial-balance',
    '/reports',
    '/reports/daily-sales',
    '/reports/visa-deposits',
    '/reports/booking-margin',
    '/reports/visa-margin',
    '/reports/portal-wallets',
    '/reports/ar-aging',
    '/reports/ap-aging',
  ];
  const audits = routes.flatMap((route) => ['light', 'dark'].map((theme) => ({ route, theme })));
  const failures = [];

  for (const audit of audits) {
    await openRoute(audit.route);
    await page.evaluate((theme) => {
      localStorage.setItem('ledgerly.theme', theme);
      document.documentElement.dataset.theme = theme;
    }, audit.theme);
    const violations = await axeViolations();
    if (violations.length) failures.push({ route: audit.route, theme: audit.theme, violations });
    assertNoConsoleErrors();
  }

  assert.deepEqual(
    failures,
    [],
    `axe WCAG violations:\n${JSON.stringify(failures, null, 2)}`,
  );

  await page.evaluate(() => localStorage.removeItem('ledgerly.theme'));
});

test('a large photo is made smaller before upload; the books keep a small JPG', async () => {
  const [customer] = await getJson(baseUrl, '/api/customers');
  await openRoute(`/customer-balances/${customer.id}`);
  const input = page.locator('[data-attachment-input]').first();
  await input.waitFor({ state: 'attached' });
  // A 2000 × 1500 photo-like PNG (noise does not compress), several MB.
  const base64 = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2000; canvas.height = 1500;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(canvas.width, canvas.height);
    for (let i = 0; i < image.data.length; i += 4) {
      image.data[i] = Math.random() * 255; image.data[i + 1] = Math.random() * 255; image.data[i + 2] = Math.random() * 255; image.data[i + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png').split(',')[1];
  });
  const original = Buffer.from(base64, 'base64');
  assert.ok(original.length > 3_000_000, 'a large photo');
  await input.setInputFiles({ name: 'passport-scan.png', mimeType: 'image/png', buffer: original });
  await page.waitForFunction(() => /passport-scan\.jpg/.test(document.body.textContent));
  const saved = (await getJson(baseUrl, `/api/attachments?entity_type=customer&entity_id=${customer.id}`))
    .find((row) => row.file_name === 'passport-scan.jpg');
  assert.equal(saved.mime_type, 'image/jpeg');
  assert.ok(saved.size_bytes < original.length / 3, `stored ${saved.size_bytes} bytes instead of ${original.length}`);
  assertNoConsoleErrors();
});
