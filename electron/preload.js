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

  /* 設定・効果音の保存先（userData 配下の実ファイル）。
     ブラウザの保存領域と違い、ポートやプロファイルが変わっても消えない。 */
  store: {
    getState: () => ipcRenderer.invoke('store-get-state'),
    setState: (json) => ipcRenderer.invoke('store-set-state', json),
    getPad: (i) => ipcRenderer.invoke('store-get-pad', i),
    setPad: (i, bytes, name) => ipcRenderer.invoke('store-set-pad', i, bytes, name),
    delPad: (i) => ipcRenderer.invoke('store-del-pad', i),
    reveal: () => ipcRenderer.invoke('store-reveal'),
  },

  /* 手動保存 / 読込（.ampset ファイル） */
  saveFile: (defaultName, bytes) => ipcRenderer.invoke('save-file', defaultName, bytes),
  openFile: () => ipcRenderer.invoke('open-file'),

  /* グローバルホットキー（他アプリを操作中でも効果音を鳴らす） */
  setGlobalKeys: (keys, panicAccel) => ipcRenderer.invoke('set-global-keys', keys, panicAccel),
  onGlobalTrigger: (cb) => ipcRenderer.on('global-trigger', (_e, i) => cb(i)),
});
