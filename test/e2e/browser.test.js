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
    const demoResponse = await fetch(`${baseUrl}/api/admin/demo`, { method: 'POST' });
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
    '/invoices',
    '/bills',
    '/journal',
    '/cheques',
    '/compliance',
    '/accounts',
    '/banking',
    '/opening-balances',
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

test('axe WCAG 2.1 AA audit is clean across light and dark themes', async () => {
  const [invoices, bookings, visas, bills, portals, customers] = await Promise.all([
    getJson(baseUrl, '/api/invoices'),
    getJson(baseUrl, '/api/bookings'),
    getJson(baseUrl, '/api/visas'),
    getJson(baseUrl, '/api/bills'),
    getJson(baseUrl, '/api/portals'),
    getJson(baseUrl, '/api/customers'),
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
    '/vendors',
    '/portals',
    `/portals/${portals[0].id}`,
    `/portals/${portals[0].id}/ledger`,
    '/refunds',
    '/credits',
    '/cheques',
    '/compliance',
    '/accounts',
    '/banking',
    '/bank-reconciliation',
    '/opening-balances',
    '/journal',
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
