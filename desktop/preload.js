'use strict';

// The bridges from a page to the app: the setup screen's three choices, and
// print preview, Save PDF and Share for Netfare's documents. main.js checks
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
  share: (title, text, url) => ipcRenderer.invoke('docs:share', { title: String(title || ''), text: String(text || ''), url: String(url || '') }),
});
