'use strict';

// Netfare desktop app (Electron). On first run it asks whether this computer
// keeps the books (main computer) or opens the office computer. A main
// computer runs the Netfare server inside the app, with the books in the
// app's own folder; a connected computer just shows the office computer's
// Netfare. Either way the window shows only Netfare pages.

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, Menu, net, session, shell, ShareMenu } = require('electron');
const config = require('./config');

app.setName('Netfare');
// For testing: keep a test run's books and choice out of the real app folder.
if (process.env.NETFARE_USER_DATA) app.setPath('userData', process.env.NETFARE_USER_DATA);

// An unexpected error closes the app (the server's own handler closes the
// books first). Registered before the server, so this message shows first and
// the app does not just vanish. With no server here (a connected computer, the
// setup screen) nothing else would close it, so it closes itself.
process.on('uncaughtException', (error) => {
  dialog.showErrorBox('Netfare ran into a problem and will close',
    `Your books are safe. Open Netfare again to carry on.\n\nIf this happens again, send this to support:\n${error?.stack || error}`);
  if (!netfareServer) app.exit(1);
});

// The Netfare server and its node_modules (rebuilt for Electron) are staged
// by scripts/build-desktop.js and shipped as extra resources.
const SERVER_DIR = process.env.NETFARE_APP_DIR
  || (app.isPackaged ? path.join(process.resourcesPath, 'app-server') : path.join(__dirname, 'build', 'app-server'));

const userData = () => app.getPath('userData');
let mainWindow = null;
let appOrigin = null;
let netfareServer = null;

// The window's colour behind the page (the light theme's background).
const WINDOW_COLOUR = '#f3f6fa';

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 380,
    minHeight: 560,
    title: 'Netfare',
    backgroundColor: WINDOW_COLOUR,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Links to other sites open in the normal browser; the window never leaves
  // Netfare or the setup screen. A Netfare file opened for viewing (a PDF or
  // picture attachment) gets its own small window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (appOrigin && config.isSameOrigin(url, appOrigin)) {
      if (isFilePreview(url)) openFilePreview(url);
    } else if (/^https?:\/\//.test(url)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!appOrigin || !config.isSameOrigin(url, appOrigin)) event.preventDefault();
  });
  // A crashed page leaves a blank window: say so and load it again.
  mainWindow.webContents.on('render-process-gone', async (event, details) => {
    if (details.reason === 'clean-exit' || !mainWindow) return;
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      message: 'The Netfare window stopped and will reload',
      detail: `Your books are safe. Anything not yet saved on this screen must be entered again. (${details.reason})`,
    });
    mainWindow?.reload();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function isFilePreview(url) {
  try {
    const { pathname, search } = new URL(url);
    return /^\/api\/attachments\/\d+\/download$/.test(pathname) && search === '?inline=1';
  } catch {
    return false;
  }
}

// A plain viewer: no bridge, no Node, it cannot go anywhere else or open
// windows. It shares the main window's sign-in, so the file loads. A local
// PDF (the print preview) is opened by its path instead of a URL.
function openFilePreview(url, file = null) {
  const preview = new BrowserWindow({
    width: 980,
    height: 1000,
    parent: mainWindow,
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      plugins: true,
    },
  });
  preview.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  preview.webContents.on('will-navigate', (event) => event.preventDefault());
  if (file) preview.loadFile(file); else preview.loadURL(url);
}

// Print preview, Save PDF and Share for Netfare's documents (preload.js
// netfareDocs). Only the main window showing Netfare may ask. The PDF is the
// page as it prints; the copies made for preview and sharing are kept in a
// private folder that is emptied when the app quits.
function fromNetfarePage(event) {
  return Boolean(mainWindow && appOrigin && event.sender === mainWindow.webContents
    && config.isSameOrigin(String(event.senderFrame?.url || ''), appOrigin));
}

const pdfFolder = () => path.join(app.getPath('temp'), `netfare-pdf-${process.pid}`);

async function printPdf() {
  // The page's own print rules decide the size, margins and page numbers.
  // Electron fills the A4 margins with the window's colour, so the window is
  // white while the PDF is made: paper is white.
  mainWindow.setBackgroundColor('#ffffff');
  try {
    return await mainWindow.webContents.printToPDF({ pageSize: 'A4', printBackground: true, preferCSSPageSize: true });
  } finally {
    mainWindow.setBackgroundColor(WINDOW_COLOUR);
  }
}

// In the private folder a PDF is simply replaced; in Downloads a file that is
// already there is kept and the new one gets "(2)".
async function writePdf(folder, title, { keepExisting = false } = {}) {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const name = keepExisting
    ? config.freeName(config.pdfName(title), (candidate) => fs.existsSync(path.join(folder, candidate)))
    : config.pdfName(title);
  const file = path.join(folder, name);
  fs.writeFileSync(file, await printPdf(), { mode: 0o600 });
  return file;
}

ipcMain.handle('docs:preview', async (event, title) => {
  if (!fromNetfarePage(event)) return { error: 'Not allowed' };
  openFilePreview(null, await writePdf(pdfFolder(), title));
  return { ok: true };
});

ipcMain.handle('docs:save', async (event, title) => {
  if (!fromNetfarePage(event)) return { error: 'Not allowed' };
  const data = await printPdf();
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: path.join(app.getPath('downloads'), config.pdfName(title)),
    filters: [{ name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { canceled: true };
  fs.writeFileSync(filePath, data);
  return { saved: path.basename(filePath) };
});

// On the Mac the system share menu takes the PDF straight to WhatsApp, Mail
// and the rest. Elsewhere the PDF is saved to Downloads and shown, and the
// WhatsApp chat or email opens with the message, ready for the file.
ipcMain.handle('docs:share', async (event, request = {}) => {
  if (!fromNetfarePage(event)) return { error: 'Not allowed' };
  const text = String(request.text || '').slice(0, 4000);
  if (process.platform === 'darwin') {
    const file = await writePdf(pdfFolder(), request.title);
    new ShareMenu({ filePaths: [file], texts: text ? [text] : [] }).popup({ window: mainWindow });
    return { shared: 'menu' };
  }
  const file = await writePdf(app.getPath('downloads'), request.title, { keepExisting: true });
  shell.showItemInFolder(file);
  if (config.isShareUrl(request.url)) await shell.openExternal(request.url);
  return { shared: 'file', file: path.basename(file) };
});

function showSetup(message = '') {
  appOrigin = null;
  mainWindow.loadFile(path.join(__dirname, 'setup.html'), { query: message ? { message } : {} });
}

function openOrigin(origin) {
  appOrigin = origin;
  mainWindow.loadURL(`${origin}/`);
}

// Replaces the books with the backup chosen in "Restore from backup…" while
// the server is not running yet. The current books are kept as a
// pre-restore backup first. A failed restore leaves the books as they were.
async function restoreRequested() {
  const source = config.restoreSource(process.argv);
  if (!source) return;
  try {
    const { restoreDatabase } = require(path.join(SERVER_DIR, 'scripts', 'restore.js'));
    // force: the last run stopped with app.exit, so its WAL file may still be
    // there; the safety backup reads it in, and no server holds the books yet.
    const { safety } = await restoreDatabase({ source, dataDir: config.dataDir(userData()), checkServer: async () => false, force: true });
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: 'The backup is restored',
      detail: `Netfare now shows the books from ${path.basename(source)}.${safety ? `\n\nThe books from before are saved as ${path.basename(safety)} in the backups folder.` : ''}`,
    });
  } catch (error) {
    dialog.showErrorBox('The backup could not be restored', `${error.message}\n\nYour books are unchanged.`);
  }
}

// Runs the Netfare server in this app, with the books in the app folder.
async function startMainComputer() {
  if (!netfareServer) {
    await restoreRequested();
    process.env.LEDGERLY_DATA_DIR = config.dataDir(userData());
    process.env.PORT = process.env.PORT || String(config.DEFAULT_PORT);
    netfareServer = require(path.join(SERVER_DIR, 'server', 'index.js'));
  }
  try {
    await netfareServer.ready;
  } catch (error) {
    dialog.showErrorBox('Netfare could not start', error.code === 'EADDRINUSE'
      ? `Port ${process.env.PORT} is already in use. Close the other copy of Netfare (or the program using that port) and open Netfare again.`
      : error.message);
    app.quit();
    return;
  }
  openOrigin(`http://127.0.0.1:${process.env.PORT}`);
}

async function officeAnswers(origin) {
  try {
    const response = await net.fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(5000) });
    const body = await response.json();
    return response.ok && body.app === 'Netfare';
  } catch {
    return false;
  }
}

async function start() {
  const chosen = config.readConfig(userData());
  if (!chosen) return showSetup();
  if (chosen.mode === 'main') return startMainComputer();
  if (await officeAnswers(chosen.office_url)) return openOrigin(chosen.office_url);
  return showSetup(`The office computer (${chosen.office_url}) did not answer. Check it is on and Netfare is open there, then try again.`);
}

// First-run choices, called from the setup screen through preload.js. Only
// the app's own setup page may make them, never a Netfare page.
function fromSetupPage(event) {
  return String(event.senderFrame?.url || '').startsWith('file://');
}

ipcMain.handle('setup:main', async (event) => {
  if (!fromSetupPage(event)) return { error: 'Not allowed' };
  config.writeConfig(userData(), { mode: 'main' });
  await startMainComputer();
});

// Start a main computer from a backup made by the old Netfare (a .db file).
ipcMain.handle('setup:import', async (event) => {
  if (!fromSetupPage(event)) return { error: 'Not allowed' };
  const fs = require('fs');
  const dir = config.dataDir(userData());
  if (fs.existsSync(path.join(dir, 'accounting.db'))) {
    return { error: 'This computer already has books. Import is only for a new main computer.' };
  }
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a Netfare backup',
    properties: ['openFile'],
    filters: [{ name: 'Netfare backup', extensions: ['db'] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
  try {
    const { restoreDatabase } = require(path.join(SERVER_DIR, 'scripts', 'restore.js'));
    await restoreDatabase({ source: picked.filePaths[0], dataDir: dir, checkServer: async () => false });
  } catch (error) {
    return { error: `That backup could not be used: ${error.message}` };
  }
  config.writeConfig(userData(), { mode: 'main' });
  await startMainComputer();
  return { ok: true };
});

ipcMain.handle('setup:connect', async (event, address) => {
  if (!fromSetupPage(event)) return { error: 'Not allowed' };
  let origin;
  try {
    origin = config.normalizeOfficeUrl(address);
  } catch (error) {
    return { error: error.message };
  }
  if (!(await officeAnswers(origin))) {
    return { error: `No Netfare answered at ${origin}. On the office computer, turn on Settings → Office network and restart Netfare.` };
  }
  config.writeConfig(userData(), { mode: 'connect', office_url: origin });
  openOrigin(origin);
  return { ok: true };
});

async function changeSetup() {
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'question',
    buttons: ['Change setup', 'Cancel'],
    defaultId: 1,
    message: 'Choose again between main computer and office computer?',
    detail: 'The books on this computer are kept. Netfare restarts.',
  });
  if (response !== 0) return;
  config.clearConfig(userData());
  app.relaunch({ args: config.relaunchArgs(process.argv) });
  app.exit(0);
}

// Netfare → Restore from backup… (main computer only). The app restarts and
// restores before the server opens the books (restoreRequested).
async function restoreFromBackup() {
  if (!mainWindow) return;
  if (!netfareServer) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: 'Restore a backup at the main computer',
      detail: 'Open Netfare on the computer that keeps the books and choose Netfare → Restore from backup.',
    });
    return;
  }
  const picked = await dialog.showOpenDialog(mainWindow, {
    title: 'Choose a Netfare backup',
    defaultPath: path.join(config.dataDir(userData()), 'backups'),
    properties: ['openFile'],
    filters: [{ name: 'Netfare backup', extensions: ['db'] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return;
  const { response } = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Restore and restart', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Replace the books with ${path.basename(picked.filePaths[0])}?`,
    detail: 'Everything entered after that backup is replaced. The current books are saved as a backup first. Everyone is signed out and Netfare restarts.',
  });
  if (response !== 0) return;
  app.relaunch({ args: config.relaunchArgs(process.argv, picked.filePaths[0]) });
  app.exit(0);
}

// Help → Reset admin password. Only the main computer can do it (the server
// accepts the reset only from this computer), so an office computer just
// says where to go.
async function resetAdminPassword() {
  if (!mainWindow) return;
  if (!netfareServer || !appOrigin) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      message: 'Reset the admin password at the main computer',
      detail: 'Open Netfare on the computer that keeps the books, choose Help → Reset admin password and enter the recovery key.',
    });
    return;
  }
  mainWindow.loadURL(`${appOrigin}/?reset=admin`);
}

function buildMenu() {
  // Hide, Hide Others and Show All exist only on a Mac.
  const macOnly = process.platform === 'darwin'
    ? [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }]
    : [];
  const template = [
    {
      label: 'Netfare',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Change setup…', click: changeSetup },
        { label: 'Restore from backup…', click: restoreFromBackup },
        { label: 'Show books folder', click: () => shell.openPath(config.dataDir(userData())) },
        { type: 'separator' },
        ...macOnly,
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'reload' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }],
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Reset admin password…', click: resetAdminPassword },
        { type: 'separator' },
        { label: 'Netfare on GitHub', click: () => shell.openExternal('https://github.com/ShikraDeveloper/Netfare') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.whenReady().then(() => {
    buildMenu();
    // Downloads (an attachment's Download button) ask where to save, starting
    // in the Downloads folder.
    session.defaultSession.on('will-download', (event, item) => {
      item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), item.getFilename()) });
    });
    createWindow();
    start();
  });
  // Closing the window quits, which stops the server cleanly.
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => {
    if (netfareServer) netfareServer.shutdown(0);
  });
  app.on('will-quit', () => {
    try { fs.rmSync(pdfFolder(), { recursive: true, force: true }); } catch { /* already gone */ }
  });
}
