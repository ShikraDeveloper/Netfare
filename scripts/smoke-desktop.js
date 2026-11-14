'use strict';

// Opens the packaged desktop app (desktop/dist) once and checks that "Start
// new books here" runs Netfare inside it and creates the books. Uses a
// throwaway app folder and a spare port, never the real ones. Run after
// `node scripts/build-desktop.js dist`; the release workflow runs it on the
// Mac and Windows builds.

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { _electron } = require('playwright-core');

const dist = path.join(__dirname, '..', 'desktop', 'dist');
const PORT = process.env.SMOKE_PORT || '4397';

// The window's own colour (#f3f6fa) in a PDF's drawing: Electron fills the
// A4 margins with it unless the app prints on a white window.
function hasWindowTint(pdf) {
  const tint = /0?\.9529 0?\.9647 0?\.9804 (?:rg|sc)/;
  for (const match of pdf.toString('latin1').matchAll(/stream\r?\n([\s\S]*?)endstream/g)) {
    try {
      if (tint.test(zlib.inflateSync(Buffer.from(match[1], 'latin1')).toString('latin1'))) return true;
    } catch { /* not a compressed drawing */ }
  }
  return false;
}

function packagedApp() {
  const candidates = process.platform === 'win32'
    ? [path.join(dist, 'win-unpacked', 'Netfare.exe')]
    : [
      path.join(dist, process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Netfare.app', 'Contents', 'MacOS', 'Netfare'),
      path.join(dist, 'mac-universal', 'Netfare.app', 'Contents', 'MacOS', 'Netfare'),
    ];
  const found = candidates.find((file) => fs.existsSync(file));
  if (!found) throw new Error(`No packaged app found in ${dist}. Build it first.`);
  return found;
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'netfare-smoke-'));
  const app = await _electron.launch({
    executablePath: packagedApp(),
    args: [],
    env: { ...process.env, NETFARE_USER_DATA: userData, PORT, LEDGERLY_AUTO_BACKUP_HOURS: '0' },
  });
  try {
    const win = await app.firstWindow();
    await win.waitForSelector('#use-main', { timeout: 30_000 });
    await win.click('#use-main');
    await win.waitForURL(`http://127.0.0.1:${PORT}/**`, { timeout: 30_000 });
    await win.waitForSelector('#auth-root', { timeout: 30_000 });
    const health = await win.evaluate(async () => (await fetch('/api/health')).json());
    if (health.app !== 'Netfare' || health.database !== 'ok') throw new Error(`Unexpected health: ${JSON.stringify(health)}`);
    if (!fs.existsSync(path.join(userData, 'data', 'accounting.db'))) throw new Error('The books were not created');

    // Print preview makes the PDF the way every document prints (preview,
    // Save PDF, Share): its margins must be white paper.
    const [temp, pid] = await app.evaluate(({ app: electronApp }) => [electronApp.getPath('temp'), process.pid]);
    const folder = path.join(temp, `netfare-pdf-${pid}`);
    await win.evaluate(() => window.netfareDocs.preview('Smoke test'));
    const pdfFile = fs.readdirSync(folder).find((name) => name.endsWith('.pdf'));
    if (!pdfFile) throw new Error('Print preview made no PDF');
    if (hasWindowTint(fs.readFileSync(path.join(folder, pdfFile)))) throw new Error('The printed PDF has tinted margins, not white paper');
    // A crashed window says so and loads Netfare again. The message box is
    // replaced so nobody has to press OK.
    const reload = await app.evaluate(({ dialog, BrowserWindow }) => new Promise((resolve) => {
      const contents = BrowserWindow.getAllWindows().find((window) => !window.getParentWindow()).webContents;
      let message = '';
      dialog.showMessageBox = async (window, options) => { message = options.message; return { response: 0 }; };
      contents.once('did-finish-load', async () => {
        for (let tries = 0; tries < 30; tries += 1) {
          if (await contents.executeJavaScript("Boolean(document.querySelector('#auth-root'))")) return resolve({ message, back: true });
          await new Promise((wait) => setTimeout(wait, 500));
        }
        resolve({ message, back: false });
      });
      contents.forcefullyCrashRenderer();
    }));
    if (!/window stopped/.test(reload.message) || !reload.back) throw new Error(`A crashed window was not reloaded with a message: ${JSON.stringify(reload)}`);

    // Last, as it ends the app: an unexpected error shows a message, then the
    // app closes (the server closes the books first).
    const exited = new Promise((resolve) => app.process().once('exit', resolve));
    const title = await app.evaluate(({ dialog }) => new Promise((resolve) => {
      dialog.showErrorBox = (boxTitle) => resolve(boxTitle);
      setTimeout(() => { throw new Error('Smoke test crash'); });
    }));
    const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve('still open'), 10_000))]);
    if (!/will close/.test(title) || code !== 1) throw new Error(`An unexpected error did not show the message and close the app (message "${title}", exit ${code})`);
    console.log(`  Smoke test passed: Netfare ${health.version} runs its own server, created the books, prints on white paper, reloads a crashed window and closes with a message on an error.`);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\n  Smoke test failed: ${error.message}\n`);
  process.exit(1);
});
