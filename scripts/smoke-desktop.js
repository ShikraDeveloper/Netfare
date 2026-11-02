'use strict';

// Opens the packaged desktop app (desktop/dist) once and checks that "Start
// new books here" runs Netfare inside it and creates the books. Uses a
// throwaway app folder and a spare port, never the real ones. Run after
// `node scripts/build-desktop.js dist`; the release workflow runs it on the
// Mac and Windows builds.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { _electron } = require('playwright-core');

const dist = path.join(__dirname, '..', 'desktop', 'dist');
const PORT = process.env.SMOKE_PORT || '4397';

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
    console.log(`  Smoke test passed: Netfare ${health.version} runs its own server and created the books.`);
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(userData, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`\n  Smoke test failed: ${error.message}\n`);
  process.exit(1);
});
