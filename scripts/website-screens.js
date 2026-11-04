'use strict';

// Takes the four app screenshots on the website (website/assets/screens) from
// a throwaway copy of Netfare with the sample agency loaded, so they always
// show the current design. Run: npm run website:screens
// Uses the installed Google Chrome (or CHROME_PATH) through playwright-core.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright-core');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'website', 'assets', 'screens');
const ADMIN = { full_name: 'Jamal', username: 'screens', password: 'screens-pass-1' };
const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).find((candidate) => fs.existsSync(candidate));

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

async function waitForServer(base) {
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch { /* still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Netfare did not start');
}

async function main() {
  if (!CHROME) throw new Error('Chrome not found. Set CHROME_PATH.');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'netfare-screens-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, LEDGERLY_DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', NETFARE_UPDATE_FEED: 'off', LEDGERLY_AUTO_BACKUP_HOURS: '0' },
    stdio: 'ignore',
  });
  let browser;
  try {
    await waitForServer(base);
    const json = { 'Content-Type': 'application/json' };
    const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: json, body: JSON.stringify(ADMIN) });
    const cookie = String(setup.headers.get('set-cookie')).split(';')[0];
    const post = (url, body = {}) => fetch(`${base}${url}`, { method: 'POST', headers: { ...json, Cookie: cookie }, body: JSON.stringify(body) });
    await post('/api/auth/recovery-key');
    await post('/api/auth/recovery-key/confirm');
    await post('/api/admin/demo');
    // The sample agency carries ShikraGroup's own name, with no contact details.
    await fetch(`${base}/api/settings`, {
      method: 'PUT',
      headers: { ...json, Cookie: cookie },
      body: JSON.stringify({ company_name: 'Shikra Travel', company_email: '', company_phone: '', company_address: 'Dubai, United Arab Emirates' }),
    });
    await post('/api/users', {
      full_name: 'Sara Counter', username: 'sara', password: 'sara-pass-123',
      permissions: { dashboard: 'view', bookings: 'edit', visas: 'edit', customers: 'view', sales: 'edit' },
    });
    const bookings = await (await fetch(`${base}/api/bookings`, { headers: { Cookie: cookie } })).json();
    const booking = bookings.find((row) => row.status === 'confirmed') || bookings[0];

    browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const [name, value] = cookie.split('=');
    await context.addCookies([{ name, value, url: base }]);
    const page = await context.newPage();
    await page.addInitScript(() => { try { localStorage.setItem('ledgerly.theme', 'light'); } catch { /* ignore */ } });

    async function shot(route, file, prepare = async () => {}) {
      await page.goto(`${base}/#${route}`);
      await page.locator('#view > *').first().waitFor();
      await prepare();
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUT, file), type: 'jpeg', quality: 82 });
      console.log(`  ${file}`);
    }

    await shot('/invoices', 'invoices.jpg', () => page.locator('#view table tbody tr').first().waitFor());
    await shot(`/bookings/${booking.id}`, 'booking.jpg', () => page.locator('[data-summary-strip]').waitFor());
    await shot('/reports/daily-sales', 'dsr.jpg', async () => {
      await page.getByRole('button', { name: 'Last month' }).click();
      await page.locator('#view table').first().waitFor();
    });
    await shot('/settings', 'rights.jpg', async () => {
      await page.locator('#users-card [data-user-rights]').first().click();
      await page.locator('.modal .rights-table').waitFor();
    });
  } finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
