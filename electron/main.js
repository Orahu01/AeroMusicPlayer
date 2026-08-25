/* =========================================================
   AeroMusic Player — Electron エントリポイント
   Web版（AMP.bat + Chrome）と全く同じ HTML/JS をそのまま読み込む。
   file:// ではなく 127.0.0.1 のローカルサーバ経由で配信することで、
   Web 版（Chrome）で検証済みの挙動（IndexedDB / setSinkId / secure-context
   前提の機能）との差異を避ける。

   加えて electron-updater により「ソフト側からの自動更新」に対応。
   起動時に GitHub Releases（Orahu01/AeroMusicPlayer）を確認し、
   新しいバージョンがあればバックグラウンドでダウンロード、
   ユーザーが「再起動して適用」を押した時だけ入れ替える（本番中に勝手に落ちない）。
   ========================================================= */
'use strict';
const { app, BrowserWindow, session, shell } = require('electron');
const { ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',   '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

let server = null, port = 0;
let mainWin = null;
const windows = new Set();

function startServer() {
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/') p = '/AeroMusicPlayer.html';
      const full = path.normalize(path.join(ROOT, p));
      if (!full.startsWith(ROOT) || !fs.existsSync(full) || !fs.statSync(full).isFile()) {
        res.writeHead(404); res.end('404'); return;
      }
      const ext = path.extname(full).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      fs.createReadStream(full).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); });
    server.on('error', reject);
  });
}

function createWindow(urlPath, opts = {}) {
  const win = new BrowserWindow({
    width: opts.width || 1500, height: opts.height || 940,
    minWidth: 760, minHeight: 560,
    autoHideMenuBar: true,
    backgroundColor: '#efeeec',
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false,   // 最小化中も再生・タイマーを止めない
      preload: opts.preload ? path.join(__dirname, 'preload.js') : undefined,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadURL(`http://127.0.0.1:${port}/${urlPath}`);
  windows.add(win);
  win.on('closed', () => { windows.delete(win); if (win === mainWin) mainWin = null; });

  // 本体からの window.open('pads.html', …) を独立ウィンドウとして開く
  // （SuperDisplay 等でタブレット側の画面へドラッグできるように）。
  // それ以外の外部リンク（GitHub・Amazon Music 等）は既定のブラウザへ。
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.endsWith('pads.html')) { createWindow('pads.html', { width: 900, height: 650 }); return { action: 'deny' }; }
    if (/^https?:\/\//i.test(url) && !url.startsWith('http://127.0.0.1')) shell.openExternal(url);
    return { action: 'deny' };
  });

  return win;
}

/* ---------------- 自動更新 ---------------- */
function sendUpdateStatus(status) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update-status', status);
}
function wireUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = false;   // 勝手には入れ替えない。ユーザーの明示操作でのみ適用
  autoUpdater.on('checking-for-update', () => sendUpdateStatus({ status: 'checking' }));
  autoUpdater.on('update-available', info => sendUpdateStatus({ status: 'available', version: info.version }));
  autoUpdater.on('update-not-available', info => sendUpdateStatus({ status: 'not-available', version: info.version }));
  autoUpdater.on('download-progress', p => sendUpdateStatus({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', info => sendUpdateStatus({ status: 'downloaded', version: info.version }));
  autoUpdater.on('error', err => sendUpdateStatus({ status: 'error', message: String(err && err.message || err) }));

  ipcMain.handle('app-version', () => app.getVersion());
  ipcMain.handle('check-update', async () => {
    if (!app.isPackaged) { sendUpdateStatus({ status: 'error', message: '開発モードでは更新確認できません（パッケージ版のみ）' }); return; }
    try { await autoUpdater.checkForUpdates(); } catch (e) { sendUpdateStatus({ status: 'error', message: String(e.message || e) }); }
  });
  ipcMain.on('install-update', () => autoUpdater.quitAndInstall(false, true));
}

app.whenReady().then(async () => {
  // 出力デバイス名の取得（getUserMedia）を、プロンプトなしで許可する。
  // マイクの実データは一切使用しない（ラベル取得後は即座に stop）。
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media');

  wireUpdater();
  await startServer();
  mainWin = createWindow('AeroMusicPlayer.html', { preload: true });

  app.on('activate', () => { if (windows.size === 0) mainWin = createWindow('AeroMusicPlayer.html', { preload: true }); });

  // 起動から少し待って自動チェック（起動直後の帯域を再生準備と取り合わないように）
  if (app.isPackaged) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
});

app.on('window-all-closed', () => {
  if (server) server.close();
  if (process.platform !== 'darwin') app.quit();
});
