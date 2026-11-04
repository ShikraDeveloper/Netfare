'use strict';

// Where the books live. The desktop app sets LEDGERLY_DATA_DIR to its own
// folder before it starts the server. Without it, the server and the scripts
// (npm start, backup, restore, reset-admin) use data/ in this folder: the
// books from before the desktop app. Once the desktop app holds books on this
// computer, opening the old folder by mistake would show stale books and let
// work go into the wrong file, so it is refused unless LEDGERLY_DATA_DIR names
// a folder or NETFARE_USE_REPO_DATA=1 says the old folder is meant.

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_DATA_DIR = path.join(__dirname, '..', 'data');

// The desktop app's books folder: Electron's userData for "Netfare", plus data/.
function desktopDataDir({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Netfare', 'data');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Netfare', 'data');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Netfare', 'data');
}

function resolveDataDir({ env = process.env, exists = fs.existsSync, platform, home } = {}) {
  if (env.LEDGERLY_DATA_DIR) return path.resolve(env.LEDGERLY_DATA_DIR);
  const desktop = desktopDataDir({ platform, home, env });
  if (env.NETFARE_USE_REPO_DATA !== '1' && exists(path.join(desktop, 'accounting.db'))) {
    const error = new Error([
      'Stopped: your books are in the Netfare desktop app,',
      `  ${desktop}`,
      'but this would open the old books from before the desktop app,',
      `  ${REPO_DATA_DIR}`,
      'Use the Netfare app instead. To run this anyway, set LEDGERLY_DATA_DIR to the',
      'folder you mean, or NETFARE_USE_REPO_DATA=1 to open the old folder on purpose.',
    ].join('\n'));
    error.code = 'NETFARE_DESKTOP_BOOKS';
    throw error;
  }
  return REPO_DATA_DIR;
}

module.exports = { REPO_DATA_DIR, desktopDataDir, resolveDataDir };
