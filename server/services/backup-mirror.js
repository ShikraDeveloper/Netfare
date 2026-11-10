'use strict';

// A second copy of every backup in another place: iCloud Drive, Google
// Drive, OneDrive, Dropbox, a USB drive or another disk. If this computer is
// lost or broken, the books can be restored from there. The copy goes into
// "<chosen folder>/Netfare backups"; the newest KEEP files are kept there.
// A missing folder (USB unplugged) never stops the backup itself: the error
// is shown in Settings and the next check copies the newest backup again.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { bad } = require('../util');
const { restrictFile } = require('../file-safety');

const SUBFOLDER = 'Netfare backups';
const KEEP = 30;

function readSettings(db) {
  try {
    return db.prepare('SELECT backup_mirror_dir, backup_mirror_at, backup_mirror_error FROM settings WHERE id = 1').get() || {};
  } catch {
    return {}; // a database from before this feature (scripts open it raw)
  }
}

function saveResult(db, { at = null, error = '' }) {
  try {
    if (at) db.prepare('UPDATE settings SET backup_mirror_at = ?, backup_mirror_error = ? WHERE id = 1').run(at, error);
    else db.prepare('UPDATE settings SET backup_mirror_error = ? WHERE id = 1').run(error);
  } catch { /* old database: nothing to record */ }
}

function targetDir(dir) {
  return path.join(dir, SUBFOLDER);
}

function backupFiles(dir) {
  return fs.readdirSync(dir)
    .filter((name) => /^(?:netfare|ledgerly)-.*\.db$/.test(name))
    .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
}

// Copies one backup file (written to a temporary name first, so a half copy
// is never left behind) and keeps the newest KEEP there.
function copyBackup(db, backup) {
  const { backup_mirror_dir: dir } = readSettings(db);
  if (!dir || !backup?.path) return null;
  try {
    if (!fs.existsSync(dir)) throw new Error(`${dir} is not reachable. Is the drive connected and the cloud app signed in?`);
    const target = targetDir(dir);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const file = path.join(target, backup.name);
    const temp = `${file}.copying`;
    fs.copyFileSync(backup.path, temp);
    fs.renameSync(temp, file);
    restrictFile(file);
    for (const old of backupFiles(target).slice(KEEP)) fs.rmSync(path.join(target, old.name), { force: true });
    const at = new Date().toISOString();
    saveResult(db, { at, error: '' });
    return { ok: true, at, file };
  } catch (error) {
    saveResult(db, { error: error.message || 'The copy failed' });
    return { ok: false, error: error.message };
  }
}

// Called on the automatic-backup timer: if the newest local backup is not in
// the second place yet (the drive was away), copy it now.
function catchUp(db, latest) {
  const { backup_mirror_dir: dir } = readSettings(db);
  if (!dir || !latest) return null;
  if (fs.existsSync(path.join(targetDir(dir), latest.name))) return null;
  return copyBackup(db, latest);
}

// True when dir is the data folder or inside it ("data-copy" is not).
function isInside(dir, dataDir) {
  const relative = path.relative(path.resolve(dataDir), path.resolve(dir));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function home(...parts) {
  return path.join(os.homedir(), ...parts);
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

// Folders that are good second places on this computer.
function suggestions(dataDir) {
  const found = [];
  const add = (label, dir, kind) => {
    try {
      if (!fs.statSync(dir).isDirectory()) return;
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      return;
    }
    if (isInside(dir, dataDir)) return;
    if (!found.some((item) => item.path === dir)) found.push({ label, path: dir, kind });
  };
  if (process.platform === 'darwin') {
    add('iCloud Drive', home('Library', 'Mobile Documents', 'com~apple~CloudDocs'), 'cloud');
    for (const dir of listDirs(home('Library', 'CloudStorage'))) {
      const name = path.basename(dir);
      if (name.startsWith('GoogleDrive')) add(`Google Drive (${name.replace(/^GoogleDrive-?/, '') || 'account'})`, path.join(dir, 'My Drive'), 'cloud');
      else if (name.startsWith('OneDrive')) add(`OneDrive${name.includes('-') ? ` (${name.split('-').slice(1).join('-')})` : ''}`, dir, 'cloud');
      else if (name.startsWith('Dropbox')) add('Dropbox', dir, 'cloud');
    }
    add('Dropbox', home('Dropbox'), 'cloud');
    let root = '/';
    try { root = fs.realpathSync('/'); } catch { /* keep "/" */ }
    for (const volume of listDirs('/Volumes')) {
      let real = volume;
      try { real = fs.realpathSync(volume); } catch { /* keep the name */ }
      if (real !== root) add(`Drive: ${path.basename(volume)}`, volume, 'drive');
    }
  } else if (process.platform === 'win32') {
    for (const dir of listDirs(os.homedir())) {
      const name = path.basename(dir);
      if (name.startsWith('OneDrive')) add(name.replace('OneDrive - ', 'OneDrive: '), dir, 'cloud');
      if (name === 'Dropbox') add('Dropbox', dir, 'cloud');
      if (name === 'Google Drive') add('Google Drive', dir, 'cloud');
    }
    const systemDrive = (process.env.SystemDrive || 'C:').toUpperCase();
    for (const letter of 'DEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      if (`${letter}:` === systemDrive) continue;
      const googleDrive = path.join(drive, 'My Drive');
      if (fs.existsSync(googleDrive)) add('Google Drive', googleDrive, 'cloud');
      else add(`Drive ${letter}:`, drive, 'drive');
    }
  }
  return found;
}

function status(db, dataDir) {
  const settings = readSettings(db);
  const dir = settings.backup_mirror_dir || '';
  let copies = 0;
  let latest = null;
  if (dir) {
    try {
      const files = backupFiles(targetDir(dir));
      copies = files.length;
      latest = files[0]?.name || null;
    } catch { /* not reachable now */ }
  }
  return {
    dir,
    target: dir ? targetDir(dir) : '',
    reachable: dir ? fs.existsSync(dir) : false,
    last_copied_at: settings.backup_mirror_at || '',
    last_error: settings.backup_mirror_error || '',
    copies,
    latest,
    keep: KEEP,
    suggestions: suggestions(dataDir),
  };
}

// Sets (or clears) the second place. It must be an existing folder this
// computer can write to, outside Netfare's own data folder.
function setFolder(db, dataDir, value) {
  const text = String(value || '').trim();
  if (!text) {
    db.prepare("UPDATE settings SET backup_mirror_dir = '', backup_mirror_error = '' WHERE id = 1").run();
    return '';
  }
  if (!path.isAbsolute(text)) throw bad('Choose a full folder path');
  const dir = path.resolve(text);
  let stat;
  try { stat = fs.statSync(dir); } catch { throw bad('That folder does not exist'); }
  if (!stat.isDirectory()) throw bad('That is not a folder');
  if (isInside(dir, dataDir)) throw bad("Choose a place outside Netfare's own folder");
  try {
    fs.mkdirSync(targetDir(dir), { recursive: true, mode: 0o700 });
    const probe = path.join(targetDir(dir), '.netfare-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
  } catch {
    throw bad('Netfare cannot write to that folder');
  }
  db.prepare("UPDATE settings SET backup_mirror_dir = ?, backup_mirror_error = '' WHERE id = 1").run(dir);
  return dir;
}

module.exports = { SUBFOLDER, KEEP, copyBackup, catchUp, status, setFolder, suggestions };
