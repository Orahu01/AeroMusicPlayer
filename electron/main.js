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
const { app, BrowserWindow, session, shell, dialog, globalShortcut } = require('electron');
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

/* ポートは必ず固定する。
   ここを 0（自動割り当て）にすると起動のたびに origin が変わり、
   ブラウザから見て「別サイト」扱いになって IndexedDB の中身
   （＝設定とパッドに登録した効果音）が毎回消えてしまう。 */
const PORT_BASE = 8781;
let server = null, port = 0;
let mainWin = null;
const windows = new Set();

function listenOn(p) {
  return new Promise((resolve, reject) => {
    const onErr = e => { server.removeListener('error', onErr); reject(e); };
    server.once('error', onErr);
    server.listen(p, '127.0.0.1', () => { server.removeListener('error', onErr); resolve(p); });
  });
}
async function startServer() {
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
  // 通常は必ず PORT_BASE。他ソフトに塞がれている時だけ隣を試す
  // （その場合も設定・効果音は下の saveStore 側＝実ファイルに残るので失われない）。
  for (let i = 0; i < 8; i++) {
    try { port = await listenOn(PORT_BASE + i); return; } catch (e) {
      if (e.code !== 'EADDRINUSE') throw e;
    }
  }
  throw new Error('ポート ' + PORT_BASE + '〜 が使用中で起動できません');
}

/* ---------------- 設定・効果音の保存（実ファイル） ----------------
   ブラウザの保存領域（IndexedDB）は origin に紐づくため脆い。
   Electron 版では userData 配下に実ファイルとして持ち、
   アプリの更新・ポート変更・プロファイル再作成があっても残るようにする。 */
const STORE_DIR = path.join(app.getPath('userData'), 'store');
const PADS_DIR  = path.join(STORE_DIR, 'pads');
const STATE_FILE = path.join(STORE_DIR, 'state.json');

function ensureStore() { fs.mkdirSync(PADS_DIR, { recursive: true }); }
function writeAtomic(file, buf) {
  ensureStore();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);          // 書き込み中の電源断で壊れないように
}
function padPath(i) {
  ensureStore();
  const pre = 'pad-' + i + '.';
  const hit = fs.readdirSync(PADS_DIR).find(f => f.startsWith(pre));
  return hit ? path.join(PADS_DIR, hit) : null;
}
function wireStore() {
  ipcMain.handle('store-get-state', () => {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
  });
  ipcMain.handle('store-set-state', (_e, json) => {
    try { writeAtomic(STATE_FILE, Buffer.from(json, 'utf8')); return true; } catch { return false; }
  });
  ipcMain.handle('store-get-pad', (_e, i) => {
    try {
      const p = padPath(i); if (!p) return null;
      return { name: path.basename(p), bytes: fs.readFileSync(p) };
    } catch { return null; }
  });
  ipcMain.handle('store-set-pad', (_e, i, bytes, name) => {
    try {
      const old = padPath(i); if (old) fs.unlinkSync(old);
      const ext = (path.extname(name || '') || '.bin').toLowerCase();
      writeAtomic(path.join(PADS_DIR, 'pad-' + i + ext), Buffer.from(bytes));
      return true;
    } catch { return false; }
  });
  ipcMain.handle('store-del-pad', (_e, i) => {
    try { const p = padPath(i); if (p) fs.unlinkSync(p); return true; } catch { return false; }
  });
  ipcMain.handle('store-reveal', () => { ensureStore(); shell.openPath(STORE_DIR); });

  // 手動保存 / 読込用のファイルダイアログ
  ipcMain.handle('save-file', async (_e, defaultName, bytes) => {
    const r = await dialog.showSaveDialog(mainWin, {
      defaultPath: defaultName,
      filters: [{ name: 'AeroMusic セット', extensions: ['ampset'] }],
    });
    if (r.canceled || !r.filePath) return null;
    fs.writeFileSync(r.filePath, Buffer.from(bytes));
    return r.filePath;
  });
  ipcMain.handle('open-file', async () => {
    const r = await dialog.showOpenDialog(mainWin, {
      properties: ['openFile'],
      filters: [{ name: 'AeroMusic セット', extensions: ['ampset'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    return { name: path.basename(r.filePaths[0]), bytes: fs.readFileSync(r.filePaths[0]) };
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

/* ---------------- グローバルホットキー ----------------
   AMP が最前面でなくても効果音を鳴らせるようにする。
   スライドや資料を同じ PC で出しているときの取りこぼし防止。
   単独キーを奪うと他アプリで文字入力ができなくなるので、
   必ず修飾キー付きのアクセラレータのみ受け付ける。 */
function wireGlobalKeys() {
  ipcMain.handle('set-global-keys', (_e, keys, panicAccel) => {
    globalShortcut.unregisterAll();
    const failed = [];
    const send = i => { if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('global-trigger', i); };
    for (const k of keys || []) {
      if (!k.accel || !/\+/.test(k.accel)) continue;     // 修飾キーなしは拒否
      try { if (!globalShortcut.register(k.accel, () => send(k.i))) failed.push(k.accel); }
      catch { failed.push(k.accel); }
    }
    if (panicAccel && /\+/.test(panicAccel)) {
      try { if (!globalShortcut.register(panicAccel, () => send(-1))) failed.push(panicAccel); } catch { failed.push(panicAccel); }
    }
    return { registered: (keys || []).length - failed.length, failed };
  });
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

/* 二重起動を防ぐ。放置すると2つ目が別ポートで立ち上がり、
   保存先が食い違って「設定が消えた」ように見える原因になる。 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWin && !mainWin.isDestroyed()) { if (mainWin.isMinimized()) mainWin.restore(); mainWin.focus(); }
  });

  app.whenReady().then(async () => {
    // 出力デバイス名の取得（getUserMedia）を、プロンプトなしで許可する。
    // マイクの実データは一切使用しない（ラベル取得後は即座に stop）。
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media'));
    session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media');

    ensureStore();
    wireStore();
    wireGlobalKeys();
    wireUpdater();
    try {
      await startServer();
    } catch (e) {
      dialog.showErrorBox('AeroMusic Player', String(e.message || e));
      app.quit(); return;
    }
    mainWin = createWindow('AeroMusicPlayer.html', { preload: true });

    app.on('activate', () => { if (windows.size === 0) mainWin = createWindow('AeroMusicPlayer.html', { preload: true }); });

    // 起動から少し待って自動チェック（起動直後の帯域を再生準備と取り合わないように）
    if (app.isPackaged) setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.on('window-all-closed', () => {
    if (server) server.close();
    if (process.platform !== 'darwin') app.quit();
  });
}
