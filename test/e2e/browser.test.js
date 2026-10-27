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
  assert.match(await page.title(), /Ledgerly/);
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
  assert.match(await page.locator('#page-title').innerText(), /Settlement queue/i);
  const tableCaption = await page.locator('table.data caption').first().innerText();
  assert.match(tableCaption, /Settlement queue/i);

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
  assert.match(await page.locator('#page-title').innerText(), new RegExp(`${customer.name} balance`));
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
  assert.match(choiceText, /2500 Refund Payable/i);
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

test('customer statement shows summary cards, presets and clean ledger rows', async () => {
  const customers = await getJson(baseUrl, '/api/customers');
  const customer = customers.find((row) => row.invoice_count > 0);
  assert.ok(customer, 'Demo data should include a customer with an invoice');

  await openRoute(`/customers/${customer.id}/statement`);
  const kpis = await page.locator('.kpi-grid .kpi').allInnerTexts();
  assert.equal(kpis.length, 4, 'Statement should show four summary cards');
  assert.match(kpis[1], /Invoiced/, 'Customer debits should be labelled Invoiced');
  assert.match(kpis[2], /Received/, 'Customer credits should be labelled Received');
  assert.equal(await page.locator('.statement-presets [data-statement-preset]').count(), 3);
  assert.match(await page.locator('.statement-status').innerText(), /Settled|Payment due|Credit balance/);

  const ledgerText = await page.locator('.statement-table tbody').innerText();
  assert.match(ledgerText, /Invoice raised/, 'Invoice descriptions should not repeat the reference');
  assert.doesNotMatch(ledgerText, /Invoice INV-/);
  assert.ok(await page.locator('.statement-desc-dot').count() > 0, 'Ledger rows should carry a type marker');

  await page.locator('[data-statement-preset="year"]').click();
  await page.waitForFunction(() => document.querySelector('[data-statement-preset="year"]')?.getAttribute('aria-pressed') === 'true');
  assert.match(await page.locator('#date-from').inputValue(), /^\d{4}-01-01$/);

  await page.emulateMedia({ media: 'print' });
  assert.equal(await page.locator('.kpi-grid').isVisible(), false, 'Summary cards should not print');
  assert.equal(await page.locator('.statement-card').isVisible(), true, 'The statement document should print');
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
  await openRoute('/visas');
  await page.locator('[data-action="new-visa"]').first().click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();

  const customer = dialog.locator('#visa-customer');
  const applicant = dialog.locator('#visa-applicant');
  const other = dialog.locator('#visa-applicant-other');
  const hint = dialog.locator('#visa-applicant-hint');
  const duration = dialog.locator('#visa-duration');

  assert.equal(await duration.getAttribute('type'), 'number');
  await duration.fill('30');
  assert.equal(await duration.inputValue(), '30');

  await customer.selectOption({ index: 1 });
  const customerName = (await customer.locator('option:checked').innerText()).trim();
  assert.ok(customerName);
  assert.equal(await applicant.inputValue(), customerName, 'customer mode fills the applicant name');
  assert.equal(await applicant.getAttribute('readonly'), '', 'customer mode keeps the applicant name read-only');
  assert.match(await hint.innerText(), /customer/i);

  await other.check();
  assert.equal(await applicant.inputValue(), '', 'visitor mode clears the prefilled customer name');
  assert.equal(await applicant.getAttribute('readonly'), null, 'visitor mode allows editing the name');
  assert.equal(await applicant.getAttribute('required'), '', 'visitor mode requires an applicant name');
  assert.match(await hint.innerText(), /visitor/i);

  await applicant.fill('Rahul Visitor');
  await other.uncheck();
  assert.equal(await applicant.inputValue(), customerName, 'switching back restores the customer name');
  assert.equal(await applicant.getAttribute('readonly'), '', 'switching back makes the name read-only again');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  assert.equal(await dialog.count(), 0);
  assertNoConsoleErrors();
});

test('invoice shows a separate visa applicant section for a visitor', async () => {
  const visas = await getJson(baseUrl, '/api/visas');
  const visitor = visas.find((visa) => Number(visa.applicant_is_customer) === 0 && visa.invoice_id);
  assert.ok(visitor, 'Demo data should include a submitted visa for a visitor');

  await openRoute(`/invoices/${visitor.invoice_id}`);
  const section = page.locator('.doc-visa-applicant');
  await section.waitFor();
  const applicantText = await section.innerText();
  assert.ok(applicantText.includes(visitor.applicant_name), 'Invoice should name the visa applicant');
  assert.match(applicantText, /Passport:/i);
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
  const revenue = accounts.find((account) => account.code === '4000');
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
  await page.locator('[data-delete-payment]').first().click();
  const paymentDialog = page.locator('[role="dialog"]');
  await paymentDialog.waitFor();
  const paymentPreview = await paymentDialog.locator('.void-preview').innerText();
  assert.match(paymentPreview, /Void preview/i);
  assert.match(paymentPreview, /Balance reopens/i);
  await paymentDialog.locator('.modal-head [data-close]').click();
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'));

  await page.locator('[data-action="void"]').click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.waitFor();
  assert.equal(await dialog.locator('#void-remarks').getAttribute('required'), '');

  const voidPreview = await dialog.locator('.void-preview').innerText();
  assert.match(voidPreview, /Void preview/i);
  assert.ok(voidPreview.includes(invoice.number), 'Void preview should name the invoice');
  assert.match(voidPreview, /linked payment/i);

  await dialog.locator('[data-submit]').click();
  await page.waitForTimeout(100);
  assert.match(await dialog.locator('.modal-error').textContent(), /Enter remarks/i);

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
  assert.match(await dialog.innerText(), /2450 Customer Credits/);
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
  assert.equal(reconciliation.checks.length, 8);

  await openRoute('/dashboard');
  const card = page.locator('[data-ledger-checks]');
  await card.waitFor();
  assert.equal(await card.locator('tbody tr').count(), 8);
  assert.match(await card.locator('caption').innerText(), /Ledger checks/);
  const summary = await card.locator('.card-title p').innerText();
  assert.match(summary, reconciliation.all_matched ? /All 8 checks match/ : /need/);

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
  await page.locator(`#page-actions a[href="#/audit-chain/${sourceType}/${cancellation.source_id}"]`).click();
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
  await page.locator('#page-actions [data-action="supplier-credit"]').click();
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

  const routes = [
    '/dashboard',
    '/invoices',
    `/invoices/${invoices[0].id}`,
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
    '/reports/daily-sales',
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
