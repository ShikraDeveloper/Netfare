'use strict';

// The bridges from a page to the app: the setup screen's three choices, and
// print preview, Save PDF and Share for Netfare's documents, and Restore from
// backup in Settings. main.js checks
// who is asking: the setup calls only from the setup screen, the document
// calls only from Netfare in the main window.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('netfareSetup', {
  useThisComputer: () => ipcRenderer.invoke('setup:main'),
  importBackup: () => ipcRenderer.invoke('setup:import'),
  connect: (address) => ipcRenderer.invoke('setup:connect', String(address || '')),
});

contextBridge.exposeInMainWorld('netfareDocs', {
  preview: (title) => ipcRenderer.invoke('docs:preview', String(title || '')),
  save: (title) => ipcRenderer.invoke('docs:save', String(title || '')),
  share: (title, url) => ipcRenderer.invoke('docs:share', { title: String(title || ''), url: String(url || '') }),
});

contextBridge.exposeInMainWorld('netfareBooks', {
  restore: () => ipcRenderer.invoke('books:restore'),
});

// The number of late reminders on the app's icon (Dock on the Mac).
contextBridge.exposeInMainWorld('netfareApp', {
  setBadge: (count) => ipcRenderer.send('app:badge', Number(count) || 0),
});
