'use strict';

// Netfare desktop app (Electron). On first run it asks whether this computer
// keeps the books (main computer) or opens the office computer. A main
// computer runs the Netfare server inside the app, with the books in the
// app's own folder; a connected computer just shows the office computer's
// Netfare. Either way the window shows only Netfare pages.

const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, Menu, net, session, shell } = require('electron');
const config = require('./config');

app.setName('Netfare');
// For testing: keep a test run's books and choice out of the real app folder.
if (process.env.NETFARE_USER_DATA) app.setPath('userData', process.env.NETFARE_USER_DATA);

// The Netfare server and its node_modules (rebuilt for Electron) are staged
// by scripts/build-desktop.js and shipped as extra resources.
const SERVER_DIR = process.env.NETFARE_APP_DIR
  || (app.isPackaged ? path.join(process.resourcesPath, 'app-server') : path.join(__dirname, 'build', 'app-server'));

const userData = () => app.getPath('userData');
let mainWindow = null;
let appOrigin = null;
let netfareServer = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 380,
    minHeight: 560,
    title: 'Netfare',
    backgroundColor: '#f3f6fa',
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
// windows. It shares the main window's sign-in, so the file loads.
function openFilePreview(url) {
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
  preview.loadURL(url);
}

function showSetup(message = '') {
  appOrigin = null;
  mainWindow.loadFile(path.join(__dirname, 'setup.html'), { query: message ? { message } : {} });
}

function openOrigin(origin) {
  appOrigin = origin;
  mainWindow.loadURL(`${origin}/`);
}

// Runs the Netfare server in this app, with the books in the app folder.
async function startMainComputer() {
  if (!netfareServer) {
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
  app.relaunch();
  app.exit(0);
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
}
