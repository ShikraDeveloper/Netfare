'use strict';

// The only bridge from a page to the app: the setup screen's three choices.
// Netfare's own pages do not use it.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('netfareSetup', {
  useThisComputer: () => ipcRenderer.invoke('setup:main'),
  importBackup: () => ipcRenderer.invoke('setup:import'),
  connect: (address) => ipcRenderer.invoke('setup:connect', String(address || '')),
});
