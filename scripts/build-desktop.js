'use strict';

// Builds the Netfare desktop app (desktop/).
//
//   node scripts/build-desktop.js stage   copy the server and its packages into
//                                         desktop/build/app-server
//   node scripts/build-desktop.js run     stage, then open the app from source
//   node scripts/build-desktop.js dist    stage, then make desktop/dist/Netfare-*.dmg
//
// The server gets its own production copy of node_modules. better-sqlite3
// (13+) ships Node-API prebuilds, which load in Electron without a rebuild.
// Needs Electron and electron-builder installed in desktop/ first
// (`cd desktop && npm install`), which downloads them.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const desktop = path.join(root, 'desktop');
const stageDir = path.join(desktop, 'build', 'app-server');
const SERVER_FILES = ['server', 'public', 'package.json', 'package-lock.json'];
const SCRIPT_FILES = ['restore.js', 'backup.js', 'reset-admin.js'];

function requireDesktopTools() {
  if (!fs.existsSync(path.join(desktop, 'node_modules', 'electron', 'package.json'))) {
    console.error('\n  Electron is not installed. Run `cd desktop && npm install` first (this downloads it).\n');
    process.exit(1);
  }
}

// The desktop app carries the same version as Netfare (package.json), which
// is also what the update check compares.
function syncVersion() {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const file = path.join(desktop, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (pkg.version !== version) {
    pkg.version = version;
    fs.writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
  }
}

function stage() {
  requireDesktopTools();
  syncVersion();
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(stageDir, 'scripts'), { recursive: true });
  for (const item of SERVER_FILES) fs.cpSync(path.join(root, item), path.join(stageDir, item), { recursive: true });
  for (const file of SCRIPT_FILES) fs.copyFileSync(path.join(root, 'scripts', file), path.join(stageDir, 'scripts', file));
  console.log('  Installing the server packages…');
  execFileSync('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stageDir, stdio: 'inherit' });
  console.log(`  Staged in ${path.relative(root, stageDir)}`);
}

async function main() {
  const command = process.argv[2] || 'stage';
  if (!['stage', 'run', 'dist'].includes(command)) {
    console.error('\n  Usage: node scripts/build-desktop.js stage|run|dist\n');
    process.exit(1);
  }
  stage();
  if (command === 'run') {
    execFileSync(path.join(desktop, 'node_modules', '.bin', 'electron'), ['.'], {
      cwd: desktop,
      stdio: 'inherit',
      env: { ...process.env, NETFARE_APP_DIR: stageDir },
    });
  } else if (command === 'dist') {
    execFileSync(path.join(desktop, 'node_modules', '.bin', 'electron-builder'), ['--mac', 'dmg'], { cwd: desktop, stdio: 'inherit' });
    console.log(`\n  Built: ${path.relative(root, path.join(desktop, 'dist'))}\n`);
  }
}

main().catch((error) => {
  console.error(`\n  Desktop build failed: ${error.message}\n`);
  process.exit(1);
});
