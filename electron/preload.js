/* レンダラー（amp.js）に安全な最小限の橋渡しだけを公開する。
   nodeIntegration は無効なので、ここを通さない限り Node.js には触れられない。 */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ampNative', {
  platform: 'electron',
  appVersion: () => ipcRenderer.invoke('app-version'),
  checkForUpdate: () => ipcRenderer.invoke('check-update'),
  installUpdate: () => ipcRenderer.send('install-update'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, status) => cb(status)),
});
