'use strict';

// The data folder holds the books, passport numbers and attachments. Keep it
// readable by this OS user only: new files are created owner-only, and files
// left by older versions are tightened once at startup. Some volumes (exFAT,
// or APFS with ownership ignored) do not enforce this; that is reported by
// the OS, not here, so failures are ignored.

const fs = require('fs');
const path = require('path');

function restrictFile(file, mode = 0o600) {
  try { fs.chmodSync(file, mode); } catch { /* volume without permissions */ }
}

function restrictDataDir(dataDir) {
  if (process.platform === 'win32') return;
  process.umask(0o077);
  restrictFile(dataDir, 0o700);
  for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
    const full = path.join(dataDir, entry.name);
    if (entry.isFile()) restrictFile(full);
    else if (entry.isDirectory() && ['backups', 'attachments'].includes(entry.name)) {
      restrictFile(full, 0o700);
      for (const inner of fs.readdirSync(full, { withFileTypes: true })) {
        if (inner.isFile()) restrictFile(path.join(full, inner.name));
      }
    }
  }
}

module.exports = { restrictFile, restrictDataDir };
