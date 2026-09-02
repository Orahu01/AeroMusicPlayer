/* =========================================================
   AeroMusic Player (AMP) — audio engine
   - 3系統の独立バス (BGM / SE / 試聴) をそれぞれ別の出力デバイスへ
   - SE は事前デコード済み AudioBuffer で低遅延・多重発音
   - BGM はストリーミング再生（長尺でもメモリを食わない）
   ========================================================= */
'use strict';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const AUDIO_EXT = /\.(mp3|wav|ogg|oga|m4a|mp4|aac|flac|opus|webm|aif|aiff)$/i;

const DECK_IDS = ['A', 'B', 'C', 'D', 'E', 'F'];
const MAX_DECKS = 6, MAX_PADS = 63, MAX_VOICES = 64;
const WAVE_MAX_BYTES = 80 << 20;

const PAD_COLORS = ['#c8c6c2','#d14b3f','#d98324','#c9a227','#4f8a4a','#3a72a8','#6d5aa8','#a8497e','#5a5a58','#141414'];
const KEY_LAYOUT = [
  ['Digit1','1'],['Digit2','2'],['Digit3','3'],['Digit4','4'],['Digit5','5'],
  ['Digit6','6'],['Digit7','7'],['Digit8','8'],['Digit9','9'],['Digit0','0'],
  ['KeyQ','Q'],['KeyW','W'],['KeyE','E'],['KeyR','R'],['KeyT','T'],
  ['KeyY','Y'],['KeyU','U'],['KeyI','I'],['KeyO','O'],['KeyP','P'],
  ['KeyA','A'],['KeyS','S'],['KeyD','D'],['KeyF','F'],['KeyG','G'],
  ['KeyH','H'],['KeyJ','J'],['KeyK','K'],['KeyL','L'],['Semicolon',';'],
  ['KeyZ','Z'],['KeyX','X'],['KeyC','C'],['KeyV','V'],['KeyB','B'],
  ['KeyN','N'],['KeyM','M'],['Comma',','],['Period','.'],['Slash','/'],
];
const MODE_LABEL = { poly:'重ねて', retrig:'鳴らし直し', toggle:'トグル', hold:'長押し' };
const MODE_HINT = {
  poly:'連打すると音が重なります。拍手・銃声・アラームなど、重なっても自然な音向け。',
  retrig:'前の音を止めてから頭出しします。ジングルやセリフなど、重なると聞き取れない音向け。',
  toggle:'1回目で再生、もう1回で停止。ループと組み合わせて環境音（雨・ざわめき）に。',
  hold:'キーやパッドを押している間だけ鳴ります。離すと停止フェードします。',
};

/* ---------------------------------------------------------
   設定
   --------------------------------------------------------- */
const EQ_DEFAULT = () => ({ on:false, hp:20, low:0, mid:0, midF:1000, high:0,
                            comp:false, thr:-18, ratio:3, makeup:0 });
const S = {
  theme:'light',
  ui:'mouse',            // 'mouse' = 従来の高密度UI / 'touch' = タッチ最適化UI
  sinks:{ bgm:'', sfx:'', cue:'' },
  duck:{ on:false, amount:9, release:600 },
  fade:{ in:1.5, out:2.5, xf:4 },
  vol:{ bgm:1, sfx:1, cue:0.8 },
  mute:{ bgm:false, sfx:false },
  eq:{ bgm:EQ_DEFAULT(), sfx:EQ_DEFAULT() },
  limiter:true, wake:true, confirmExit:true, autoAdv:true, autoMix:false,
  cols:5, padRows:4, padRowsAuto:true, padPage:0, padCount:20, deckCount:2,
  webVol:1, webOpen:false, webHistory:[],
  normalize:true,        // 曲ごとの音量を自動でそろえる
  normTarget:-16,        // そろえる目標ラウドネス(dBFS RMS)
  locked:false,          // 誤操作ロック
  ghk:false, ghkMod:'Control+Shift',   // グローバルホットキー
  tracks:{},             // 曲ごとの設定 { key: {in,out,auto:[{at,to,over}],rms} }
  cues:[], cueIdx:-1,    // キューリスト（進行表）
  plTab:'list',          // 'list' | 'cue'
};

/* 曲ごとの設定は、実ファイルパス → フォルダ内パス → ファイル名 の順で紐づける */
const trackKey = it => (it && (it.fsPath || it.path || it.name)) || '';

/* 曲の実体（File）を必要になった時点で用意する。
   ドラッグ＆ドロップで入れた曲も、実ファイルパスを覚えておけば
   次回起動時にそこから読み直せる（曲データ自体は複製しない）。 */
async function ensureFile(it) {
  if (!it) return null;
  if (it.file) return it.file;
  if (it.handle) { try { return await it.handle.getFile(); } catch { return null; } }
  if (it.fsPath && NATIVE && NATIVE.readFile) {
    const r = await NATIVE.readFile(it.fsPath).catch(() => null);
    if (r && r.bytes) { it.file = new File([new Uint8Array(r.bytes)], r.name || it.name); return it.file; }
    it.missing = true;
  }
  return null;
}
/* ドロップやファイル選択で入ってきた File から実パスを拾って覚える */
function stampPath(items) {
  if (!NATIVE || !NATIVE.pathForFile) return items;
  for (const it of items) {
    if (it.fsPath || !it.file) continue;
    const p = NATIVE.pathForFile(it.file);
    if (p) it.fsPath = p;
  }
  return items;
}
function trackConf(it, create) {
  const k = trackKey(it); if (!k) return null;
  if (!S.tracks[k] && create) S.tracks[k] = { in:0, out:0, auto:[], rms:null };
  return S.tracks[k] || null;
}

/* ---------------------------------------------------------
   IndexedDB
   --------------------------------------------------------- */
const DB = (() => {
  let p = null;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('amp-db', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror   = () => rej(r.error);
  }));
  const tx = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const t = db.transaction('kv', mode), st = t.objectStore('kv');
    const q = fn(st);
    t.oncomplete = () => res(q && q.result);
    t.onerror = () => rej(t.error);
  }));
  return {
    get: k => tx('readonly',  st => st.get(k)),
    set: (k, v) => tx('readwrite', st => st.put(v, k)),
    del: k => tx('readwrite', st => st.delete(k)),
  };
})();

/* ---------------------------------------------------------
   保存層
   Electron 版: userData 配下の実ファイル（ポートやプロファイルが
                変わっても消えない。手動バックアップもできる）
   ブラウザ版 : IndexedDB
   --------------------------------------------------------- */
const NATIVE = (typeof window !== 'undefined' && window.ampNative) || null;
const NSTORE = NATIVE && NATIVE.store ? NATIVE.store : null;
const PAD_BLOB_MAX = 60 << 20;
const padBlobKey = i => 'padblob:' + i;

const STORE = {
  kind: NSTORE ? 'file' : 'idb',
  async getState() {
    if (NSTORE) {
      const s = await NSTORE.getState().catch(() => null);
      if (s) return s;
      // 旧バージョン（IndexedDB 保存）からの引き継ぎ
      const legacy = await DB.get('state').catch(() => null);
      if (legacy) { await this.setState(legacy).catch(() => {}); return legacy; }
      return null;
    }
    return DB.get('state').catch(() => null);
  },
  async setState(obj) {
    if (NSTORE) return NSTORE.setState(JSON.stringify(obj));
    return DB.set('state', obj);
  },
  async getPad(i) {
    if (NSTORE) {
      const r = await NSTORE.getPad(i).catch(() => null);
      if (r && r.bytes) return new File([new Uint8Array(r.bytes)], r.name || ('pad-' + i));
      const legacy = await DB.get(padBlobKey(i)).catch(() => null);   // 旧保存からの引き継ぎ
      if (legacy) { this.setPad(i, legacy); return legacy; }
      return null;
    }
    return DB.get(padBlobKey(i)).catch(() => null);
  },
  async setPad(i, file) {
    if (!file || file.size > PAD_BLOB_MAX) return;
    if (NSTORE) {
      const ab = await file.arrayBuffer();
      return NSTORE.setPad(i, new Uint8Array(ab), file.name || ('pad-' + i + '.bin')).catch(() => {});
    }
    return DB.set(padBlobKey(i), file).catch(() => {});
  },
  async delPad(i) {
    if (NSTORE) { NSTORE.delPad(i).catch(() => {}); }
    return DB.del(padBlobKey(i)).catch(() => {});
  },
};
const savePadBlob = (i, f) => { STORE.setPad(i, f); };
const loadPadBlob = i => STORE.getPad(i);

/* ---------------------------------------------------------
   バス（AudioContext 1個 = 出力デバイス1個）
   --------------------------------------------------------- */
class Bus {
  constructor(name, hasEq = false) {
    this.name = name; this.hasEq = hasEq;
    const c = this.ctx = new AudioContext({ latencyHint:'interactive' });

    this.duck     = c.createGain();               // ダッキング（BGM のみ使用）
    this.master   = c.createGain();
    this.limiter  = c.createDynamicsCompressor(); // 音割れ防止の保険（常時）
    this.analyser = c.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buf = new Float32Array(this.analyser.fftSize);

    if (hasEq) {
      this.hpf  = c.createBiquadFilter(); this.hpf.type  = 'highpass';  this.hpf.frequency.value = 20; this.hpf.Q.value = .7;
      this.low  = c.createBiquadFilter(); this.low.type  = 'lowshelf';  this.low.frequency.value = 110;
      this.mid  = c.createBiquadFilter(); this.mid.type  = 'peaking';   this.mid.frequency.value = 1000; this.mid.Q.value = 1;
      this.high = c.createBiquadFilter(); this.high.type = 'highshelf'; this.high.frequency.value = 6000;
      this.comp = c.createDynamicsCompressor();
      this.makeup = c.createGain();
      this.duck.connect(this.hpf).connect(this.low).connect(this.mid)
               .connect(this.high).connect(this.comp).connect(this.makeup).connect(this.master);
    } else {
      this.duck.connect(this.master);
    }
    this.master.connect(this.limiter).connect(this.analyser).connect(c.destination);

    this.input = this.duck;
    this.peak = 0; this.hold = 0; this.holdT = 0;
    this.applyLimiter();
    if (hasEq) this.applyEq(EQ_DEFAULT());
  }
  applyLimiter() {
    const l = this.limiter, t = this.ctx.currentTime, v = (p, x) => p.setValueAtTime(x, t);
    if (S.limiter) { v(l.threshold,-1.5); v(l.knee,0); v(l.ratio,20); v(l.attack,.002); v(l.release,.18); }
    else           { v(l.threshold,0);    v(l.knee,0); v(l.ratio,1);  v(l.attack,.003); v(l.release,.25); }
  }
  /* EQ / コンプ。オフ時は各段を素通し値にするだけなので繋ぎ変えは発生しない */
  applyEq(e) {
    if (!this.hasEq) return;
    const t = this.ctx.currentTime, set = (p, x) => p.setTargetAtTime(x, t, .02);
    if (e.on) {
      set(this.hpf.frequency, e.hp);
      set(this.low.gain, e.low);
      set(this.mid.gain, e.mid); set(this.mid.frequency, e.midF);
      set(this.high.gain, e.high);
    } else {
      set(this.hpf.frequency, 20);
      set(this.low.gain, 0); set(this.mid.gain, 0); set(this.high.gain, 0);
    }
    if (e.comp) {
      set(this.comp.threshold, e.thr); set(this.comp.ratio, e.ratio); set(this.comp.knee, 6);
      set(this.comp.attack, .008); set(this.comp.release, .16);
      set(this.makeup.gain, Math.pow(10, e.makeup / 20));
    } else {
      set(this.comp.threshold, 0); set(this.comp.ratio, 1); set(this.comp.knee, 0);
      set(this.makeup.gain, 1);
    }
  }
  setVolume(v) { this.master.gain.setTargetAtTime(v, this.ctx.currentTime, .015); }
  async setSink(id) {
    if (typeof this.ctx.setSinkId !== 'function') throw new Error('この環境では出力先を指定できません');
    await this.ctx.setSinkId(!id || id === 'default' ? '' : id);
  }
  resume() { if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); }
  level() {
    this.analyser.getFloatTimeDomainData(this.buf);
    let m = 0;
    for (let i = 0; i < this.buf.length; i++) { const a = Math.abs(this.buf[i]); if (a > m) m = a; }
    this.peak = m > this.peak ? m : this.peak * .82 + m * .18;
    const now = performance.now();
    if (this.peak >= this.hold) { this.hold = this.peak; this.holdT = now; }
    else if (now - this.holdT > 900) this.hold *= .9;
    return this.peak;
  }
}

const BUS = { bgm:new Bus('bgm', true), sfx:new Bus('sfx', true), cue:new Bus('cue', false) };
const ALL_BUSES = [BUS.bgm, BUS.sfx, BUS.cue];
const applyAllEq = () => { BUS.bgm.applyEq(S.eq.bgm); BUS.sfx.applyEq(S.eq.sfx); };
const resumeAll = () => ALL_BUSES.forEach(b => b.resume());

/* 等パワークロスフェード用カーブ */
const XF_N = 65, XF_UP = new Float32Array(XF_N), XF_DN = new Float32Array(XF_N);
for (let i = 0; i < XF_N; i++) {
  const x = i / (XF_N - 1);
  XF_UP[i] = Math.max(Math.sin(x * Math.PI / 2), 1e-4);
  XF_DN[i] = Math.max(Math.cos(x * Math.PI / 2), 1e-4);
}

/* ---------------------------------------------------------
   デッキ
   --------------------------------------------------------- */
const DECK_HTML = `
<div class="d-top">
  <div class="d-id"></div>
  <div class="d-name empty">— 空 —</div>
  <div class="d-time num"><span class="c">0:00</span> / <span class="d">0:00</span><span class="d-rem"> -0:00</span></div>
</div>
<div class="d-seek"><canvas></canvas><div class="d-fill"></div><div class="d-head"></div></div>
<div class="d-ctrl">
  <button class="btn play" style="min-width:38px">▶</button>
  <button class="btn stop" style="min-width:34px">■</button>
  <button class="btn loop q">LOOP</button>
  <button class="btn fin q" title="フェードインして再生">F/I</button>
  <button class="btn fout q" title="フェードアウトして停止">F/O</button>
  <button class="btn xf q" title="今鳴っている曲からこのデッキへクロスフェード">⇄</button>
  <span class="spacer"></span>
  <span class="lbl">VOL</span>
  <input class="fader dvol" type="range" min="0" max="1.3" step="0.01" value="1">
  <span class="val num dvolv">100%</span>
</div>`;

class Deck {
  constructor(id) {
    this.id = id; this.bus = BUS.bgm;
    const c = this.bus.ctx;

    this.audio = new Audio(); this.audio.preload = 'auto';
    this.node  = c.createMediaElementSource(this.audio);
    this.autoG = c.createGain();      // 曲内の音量オートメーション
    this.normG = c.createGain();      // 曲ごとの音量そろえ
    this.fadeG = c.createGain();      // フェード / クロスフェード用
    this.volG  = c.createGain();      // ユーザー操作のフェーダー
    this.node.connect(this.autoG).connect(this.normG)
             .connect(this.fadeG).connect(this.volG).connect(this.bus.input);

    this.meta = null; this.url = null; this.peaks = null;
    this.vol = 1; this.loop = false; this.fadeTok = 0; this.waveTok = 0;

    const el = this.el = document.createElement('div');
    el.className = 'deck'; el.dataset.deck = id; el.innerHTML = DECK_HTML;
    $('.d-id', el).textContent = id;

    this.$name = $('.d-name', el); this.$cur = $('.c', el); this.$dur = $('.d', el);
    this.$rem = $('.d-rem', el); this.$seek = $('.d-seek', el);
    this.$fill = $('.d-fill', el); this.$head = $('.d-head', el);
    this.$cv = $('canvas', el); this.$play = $('.play', el); this.$loop = $('.loop', el);

    $('.play', el).onclick = () => this.toggle();
    $('.stop', el).onclick = () => this.stop();
    $('.fin',  el).onclick = () => this.play(S.fade.in);
    $('.fout', el).onclick = () => this.fadeStop(S.fade.out);
    $('.xf',   el).onclick = () => crossfadeTo(this, S.fade.xf);
    this.$loop.onclick = () => { this.loop = !this.loop; this.audio.loop = this.loop; this.$loop.classList.toggle('on', this.loop); };

    const dv = $('.dvol', el), dvv = $('.dvolv', el);
    dv.oninput = () => { this.vol = +dv.value; this.volG.gain.setTargetAtTime(this.vol, c.currentTime, .01); dvv.textContent = Math.round(this.vol*100) + '%'; };
    this.$vol = dv; this.$volv = dvv;

    this.$seek.addEventListener('pointerdown', e => {
      if (!this.audio.duration) return;
      this.$seek.setPointerCapture(e.pointerId);
      const go = ev => {
        const r = this.$seek.getBoundingClientRect();
        this.audio.currentTime = clamp((ev.clientX - r.left) / r.width, 0, 1) * this.audio.duration;
      };
      go(e);
      const mv = ev => go(ev);
      const up = () => { this.$seek.removeEventListener('pointermove', mv); this.$seek.removeEventListener('pointerup', up); };
      this.$seek.addEventListener('pointermove', mv); this.$seek.addEventListener('pointerup', up);
    });

    el.addEventListener('pointerdown', () => selectDeck(this.id));
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('dragover'); });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation(); el.classList.remove('dragover');
      const f = await filesFromDataTransfer(e.dataTransfer);
      if (f.length) { await this.load(f[0]); addToPlaylist(f); }
    });

    this.audio.addEventListener('ended', () => onDeckEnded(this));
    this.audio.addEventListener('play',  () => this.sync());
    this.audio.addEventListener('pause', () => this.sync());
    this.audio.addEventListener('error', () => { if (this.audio.src) toast('再生できないファイルです: ' + (this.meta ? this.meta.name : ''), true); });
  }

  get playing() { return !this.audio.paused && !this.audio.ended; }
  sync() {
    this.$play.textContent = this.playing ? '❚❚' : '▶';
    this.el.classList.toggle('live', this.playing);
  }

  get conf() { return this.meta ? trackConf(this.meta, false) : null; }
  /* アウト点。未設定なら曲の終わりまで */
  get outAt() {
    const c = this.conf, d = this.audio.duration || 0;
    return (c && c.out > 0 && c.out < d) ? c.out : d;
  }
  get inAt() { const c = this.conf; return c && c.in > 0 ? c.in : 0; }

  /* 音量オートメーションの、その時刻での値。
     点は「at 秒から over 秒かけて to まで変える」の意味で、
     次の点まではその値を保つ。 */
  envAt(t) {
    const c = this.conf;
    if (!c || !c.auto || !c.auto.length) return 1;
    const pts = [...c.auto].sort((a, b) => a.at - b.at);
    let prev = 1;
    for (const p of pts) {
      if (t < p.at) return prev;
      if (p.over > 0 && t < p.at + p.over) return prev + (p.to - prev) * ((t - p.at) / p.over);
      prev = p.to;
    }
    return prev;
  }
  /* 毎フレーム呼ばれ、オートメーションの反映とアウト点の監視を行う */
  tickAuto() {
    if (!this.audio.src) return;
    const t = this.audio.currentTime || 0;
    const g = this.autoG.gain, ct = this.bus.ctx.currentTime;
    const target = clamp(this.envAt(t), 0, 2);
    if (Math.abs(g.value - target) > 0.002) g.setTargetAtTime(target, ct, 0.03);
    if (this.playing) {
      const out = this.outAt;
      if (out > 0 && t >= out - 0.02) {
        if (this.loop) { this.audio.currentTime = this.inAt; }
        else { this.audio.pause(); this.audio.currentTime = this.inAt; this.sync(); onDeckEnded(this); }
      }
    }
  }
  /* 曲ごとの音量そろえを反映 */
  applyNorm() {
    const c = this.conf, ct = this.bus.ctx.currentTime;
    let g = 1;
    if (S.normalize && c && c.rms != null && c.rms > 0) {
      const rmsDb = 20 * Math.log10(c.rms);
      g = Math.pow(10, clamp(S.normTarget - rmsDb, -12, 12) / 20);
      if (c.peak > 0) g = Math.min(g, 0.99 / c.peak);      // 上げすぎて歪ませない
    }
    this.normG.gain.setTargetAtTime(clamp(g, 0.05, 4), ct, 0.05);
  }

  async load(src) {
    const file = await ensureFile(src);
    if (!file) { toast('ファイルが見つかりません: ' + src.name, true); renderPlaylist(); return false; }
    this.audio.pause();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(file);
    this.audio.src = this.url; this.audio.loop = this.loop;
    this.meta = { ...src };
    this.peaks = null;
    this.$name.textContent = src.name;
    this.$name.classList.remove('empty');
    const g = this.fadeG.gain;
    g.cancelScheduledValues(this.bus.ctx.currentTime); g.value = 1;
    this.autoG.gain.cancelScheduledValues(this.bus.ctx.currentTime);
    this.autoG.gain.value = this.envAt(0);
    trackConf(this.meta, true);
    this.applyNorm();
    this.audio.addEventListener('loadedmetadata', () => {
      if (this.inAt > 0) this.audio.currentTime = this.inAt;
    }, { once:true });
    this.drawWave(); this.buildWave(file);
    renderPlaylist();
    return true;
  }

  play(fadeSec = 0) {
    resumeAll();
    if (!this.audio.src) { toast('デッキ ' + this.id + ' は空です'); return; }
    const g = this.fadeG.gain, t = this.bus.ctx.currentTime;
    this.fadeTok++;
    g.cancelScheduledValues(t);
    if (fadeSec > .01) { g.setValueAtTime(1e-4, t); g.exponentialRampToValueAtTime(1, t + fadeSec); }
    else g.setValueAtTime(1, t);
    this.audio.play().catch(e => toast('再生失敗: ' + e.message, true));
  }
  pause() { this.audio.pause(); }
  toggle() { this.playing ? this.pause() : this.play(); }
  stop() {
    this.fadeTok++;
    this.audio.pause(); this.audio.currentTime = 0;
    const g = this.fadeG.gain;
    g.cancelScheduledValues(this.bus.ctx.currentTime); g.value = 1;
    this.sync();
  }
  fadeStop(sec) {
    if (!this.playing) { this.stop(); return; }
    const g = this.fadeG.gain, t = this.bus.ctx.currentTime, tok = ++this.fadeTok;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(g.value, 1e-4), t);
    g.exponentialRampToValueAtTime(1e-4, t + Math.max(sec, .02));
    setTimeout(() => { if (tok === this.fadeTok) this.stop(); }, sec * 1000 + 60);
  }
  /* クロスフェードの片側 */
  rampCurve(curve, sec, thenStop) {
    const g = this.fadeG.gain, t = this.bus.ctx.currentTime, tok = ++this.fadeTok;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setValueCurveAtTime(curve, t, Math.max(sec, .05));
    if (thenStop) setTimeout(() => { if (tok === this.fadeTok) this.stop(); }, sec * 1000 + 80);
  }

  async buildWave(file) {
    const tok = ++this.waveTok;
    if (file.size > WAVE_MAX_BYTES) return;
    try {
      const buf = await this.bus.ctx.decodeAudioData(await file.arrayBuffer());
      if (tok !== this.waveTok) return;
      const N = 640, ch = buf.getChannelData(0), step = Math.max(1, Math.floor(ch.length / N));
      const pk = new Float32Array(N);
      let sum = 0, cnt = 0, peak = 0;
      for (let i = 0; i < N; i++) {
        let m = 0; const s = i * step, e = Math.min(s + step, ch.length);
        for (let j = s; j < e; j += 3) {
          const v = ch[j], a = Math.abs(v);
          if (a > m) m = a;
          sum += v * v; cnt++;
        }
        pk[i] = m; if (m > peak) peak = m;
      }
      // 音量そろえ用に、この曲の実効音量(RMS)とピークを覚えておく
      const c = trackConf(this.meta, true);
      if (c) { c.rms = cnt ? Math.sqrt(sum / cnt) : null; c.peak = peak; this.applyNorm(); saveState(); }
      this.peaks = pk; this.drawWave();
    } catch { /* 波形は諦める（再生には影響しない） */ }
  }
  drawWave() {
    const cv = this.$cv, r = cv.getBoundingClientRect();
    if (!r.width) return;
    const dpr = devicePixelRatio || 1;
    cv.width = r.width * dpr; cv.height = r.height * dpr;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    if (!this.peaks) return;
    const cs = getComputedStyle(this.el);
    g.fillStyle = cs.color;
    g.globalAlpha = this.el.classList.contains('live') ? .5 : .32;
    const n = this.peaks.length, w = cv.width / n, mid = cv.height / 2;
    for (let i = 0; i < n; i++) {
      const h = Math.max(dpr, this.peaks[i] * mid * 1.9);
      g.fillRect(i * w, mid - h, Math.max(dpr, w - dpr * .5), h * 2);
    }
    const dur = this.audio.duration || 0;
    if (!dur) return;
    const c = this.conf;
    // イン点／アウト点の外側を暗くする
    g.globalAlpha = .5; g.fillStyle = cs.backgroundColor || '#000';
    if (this.inAt > 0) g.fillRect(0, 0, (this.inAt / dur) * cv.width, cv.height);
    if (c && c.out > 0 && c.out < dur) {
      const x = (c.out / dur) * cv.width;
      g.fillRect(x, 0, cv.width - x, cv.height);
    }
    // 音量オートメーションのカーブ
    if (c && c.auto && c.auto.length) {
      g.globalAlpha = .95; g.strokeStyle = cs.color; g.lineWidth = Math.max(1, dpr);
      g.beginPath();
      for (let x = 0; x <= cv.width; x += dpr * 2) {
        const v = clamp(this.envAt((x / cv.width) * dur), 0, 1.3);
        const y = cv.height - (v / 1.3) * cv.height;
        x === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
      }
      g.stroke();
    }
    g.globalAlpha = 1;
  }
}

/* ---- デッキ管理 ---- */
let DECKS = [], selDeck = 0, mixArmed = false;

function buildDecks(n) {
  n = clamp(n, 1, MAX_DECKS);
  const box = $('#decks');
  while (DECKS.length < n) { const d = new Deck(DECK_IDS[DECKS.length]); DECKS.push(d); box.appendChild(d.el); d.sync(); }
  while (DECKS.length > n) { const d = DECKS.pop(); d.stop(); if (d.url) URL.revokeObjectURL(d.url); d.el.remove(); }
  S.deckCount = DECKS.length;
  $('#deckNum').textContent = DECKS.length;
  $('#deckMinus').disabled = DECKS.length <= 1;
  $('#deckPlus').disabled = DECKS.length >= MAX_DECKS;
  selectDeck(DECK_IDS[clamp(selDeck, 0, DECKS.length - 1)]);
  requestAnimationFrame(() => DECKS.forEach(d => d.drawWave()));
}
const deckOf = id => DECKS.find(d => d.id === id);
function selectDeck(id) {
  const i = DECKS.findIndex(d => d.id === id);
  if (i < 0) return;
  selDeck = i;
  DECKS.forEach((d, k) => d.el.classList.toggle('sel', k === i));
}
const curDeck = () => DECKS[clamp(selDeck, 0, DECKS.length - 1)];
function idleDeck() { return DECKS.find(d => !d.playing) || curDeck(); }

/* 今鳴っている全デッキ → 指定デッキ へ等パワークロスフェード */
function crossfadeTo(deck, sec) {
  if (!deck.audio.src) { toast('デッキ ' + deck.id + ' は空です'); return; }
  const others = DECKS.filter(d => d !== deck && d.playing);
  if (!deck.playing) { deck.play(0); }
  deck.rampCurve(XF_UP, sec, false);
  others.forEach(d => d.rampCurve(XF_DN, sec, true));
  selectDeck(deck.id);
}

function onDeckEnded(d) {
  d.sync();
  if (S.autoMix || !S.autoAdv) return;
  const nx = nextTrack();
  if (nx) d.load(nx.item).then(ok => { if (ok) { plCursor = nx.i; d.play(); } });
}
/* AUTO MIX: 残りがクロスフェード秒数を切ったら空きデッキで次曲を用意して繋ぐ */
async function checkAutoMix() {
  if (!S.autoMix || mixArmed) return;
  for (const d of DECKS) {
    if (!d.playing || d.loop || !d.audio.duration) continue;
    const rem = (d.outAt || d.audio.duration) - d.audio.currentTime;
    if (rem > S.fade.xf || rem <= 0) continue;
    const other = DECKS.find(x => x !== d && !x.playing);
    if (!other) continue;
    const nx = nextTrack(); if (!nx) continue;
    mixArmed = true;
    if (await other.load(nx.item)) { plCursor = nx.i; crossfadeTo(other, Math.min(S.fade.xf, rem)); }
    setTimeout(() => { mixArmed = false; }, (S.fade.xf + 1) * 1000);
    break;
  }
}

/* ---------------------------------------------------------
   SE パッド
   --------------------------------------------------------- */
const PAD_HTML = `<div class="p-key"></div><div class="p-name"></div>
<div class="p-meta"><span class="p-mode"></span><span class="p-vox"></span></div><div class="p-prog"></div>`;

class Pad {
  constructor(i) {
    this.i = i;
    this.src = null; this.buffer = null; this.name = ''; this.loading = false;
    this.key = KEY_LAYOUT[i] ? KEY_LAYOUT[i][0] : null;
    this.mode = 'poly'; this.vol = 1; this.fade = 80; this.rate = 1; this.loop = false;
    this.color = PAD_COLORS[i % PAD_COLORS.length];
    this.voices = new Set();

    const el = this.el = document.createElement('div');
    el.className = 'pad empty'; el.dataset.i = i; el.innerHTML = PAD_HTML;
    this.$key = $('.p-key', el); this.$name = $('.p-name', el);
    this.$mode = $('.p-mode', el); this.$vox = $('.p-vox', el); this.$prog = $('.p-prog', el);

    el.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      if (!this.buffer && !this.loading) { pickForPad(this.i); return; }
      this.trigger();
      if (this.mode === 'hold') {
        const id = e.pointerId;
        const up = ev => {
          if (ev.pointerId !== id) return;
          this.release();
          removeEventListener('pointerup', up); removeEventListener('pointercancel', up);
        };
        addEventListener('pointerup', up); addEventListener('pointercancel', up);
      }
    });
    el.addEventListener('contextmenu', e => { e.preventDefault(); openPadDlg(this.i); });
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('dragover'); });
    el.addEventListener('dragleave', () => el.classList.remove('dragover'));
    el.addEventListener('drop', async e => {
      e.preventDefault(); e.stopPropagation(); el.classList.remove('dragover');
      const files = await filesFromDataTransfer(e.dataTransfer);
      for (let k = 0; k < files.length; k++) { const p = PADS[this.i + k]; if (p) await p.assign(files[k]); }
      if (files.length) saveState();
    });
    this.render();
  }
  get keyLabel() { const k = KEY_LAYOUT.find(x => x[0] === this.key); return k ? k[1] : ''; }

  async assign(src, { persist = true } = {}) {
    this.loading = true; this.el.classList.add('loading'); this.render();
    this.src = src; this.name = src.name.replace(/\.[^.]+$/, '');
    try {
      const file = src.file || await src.handle.getFile();
      this.buffer = await BUS.sfx.ctx.decodeAudioData(await file.arrayBuffer());
      if (persist) savePadBlob(this.i, file);
    } catch {
      this.buffer = null; this.src = null; this.name = '';
      toast('この形式は読み込めませんでした: ' + src.name, true);
    }
    this.loading = false; this.el.classList.remove('loading');
    this.render(); updateMem();
    return !!this.buffer;
  }
  clear() {
    this.stopAll(0);
    this.buffer = null; this.src = null; this.name = '';
    DB.del(padBlobKey(this.i)).catch(() => {});
    this.render(); updateMem();
  }

  trigger(vel = 1) {
    if (!this.buffer) return;
    resumeAll();
    if (this.mode === 'toggle' && this.voices.size) { this.stopAll(this.fade); return; }
    if (this.mode === 'retrig' || this.mode === 'hold') this.stopAll(Math.min(this.fade, 30));
    if (voiceCount() >= MAX_VOICES) stealOldestVoice();

    const c = BUS.sfx.ctx, t = c.currentTime;
    const s = c.createBufferSource();
    s.buffer = this.buffer; s.loop = this.loop; s.playbackRate.value = this.rate;
    const g = c.createGain(); g.gain.setValueAtTime(this.vol * vel, t);
    s.connect(g).connect(BUS.sfx.input);
    s.start(t);

    const v = { s, g, t0:t, dur:this.buffer.duration / this.rate };
    this.voices.add(v);
    s.onended = () => { this.voices.delete(v); try { g.disconnect(); } catch {} this.render(); updateDuck(); };
    this.render(); updateDuck();
  }
  release() { if (this.mode === 'hold') this.stopAll(this.fade); }
  stopAll(fadeMs) {
    const c = BUS.sfx.ctx, t = c.currentTime, f = Math.max(fadeMs, 0) / 1000;
    for (const v of [...this.voices]) {
      try {
        if (f > .005) {
          v.g.gain.cancelScheduledValues(t);
          v.g.gain.setValueAtTime(Math.max(v.g.gain.value, 1e-4), t);
          v.g.gain.exponentialRampToValueAtTime(1e-4, t + f);
          v.s.stop(t + f + .01);
        } else v.s.stop(t);
      } catch {}
    }
  }

  render() {
    const el = this.el;
    el.style.setProperty('--pc', this.color);
    el.classList.toggle('empty', !this.buffer && !this.loading);
    el.classList.toggle('playing', this.voices.size > 0);
    this.$key.textContent = this.keyLabel || '·';
    if (this.buffer || this.loading) {
      this.$name.textContent = this.loading ? '読込中…' : this.name;
      this.$mode.textContent = MODE_LABEL[this.mode] + (this.loop ? ' ↻' : '');
      this.$vox.textContent = this.voices.size > 1 ? '×' + this.voices.size : '';
    } else {
      this.$name.textContent = '＋ ドロップ / クリック';
      this.$mode.textContent = ''; this.$vox.textContent = '';
    }
    padsDirty = true;
  }
  tick() {
    if (!this.voices.size) { if (this.$prog.style.width !== '0px') this.$prog.style.width = '0px'; return; }
    let mx = 0; const now = BUS.sfx.ctx.currentTime;
    for (const v of this.voices) {
      const p = this.loop ? ((now - v.t0) % v.dur) / v.dur : clamp((now - v.t0) / v.dur, 0, 1);
      if (p > mx) mx = p;
    }
    this.$prog.style.width = (mx * 100) + '%';
  }
  conf() {
    return { path:this.src ? this.src.path : null, name:this.name, key:this.key, mode:this.mode,
             vol:this.vol, fade:this.fade, rate:this.rate, loop:this.loop, color:this.color };
  }
  applyConf(c) {
    if (!c) return;
    if (c.name) this.name = c.name;
    this.key = c.key ?? this.key; this.mode = c.mode || 'poly';
    this.vol = c.vol ?? 1; this.fade = c.fade ?? 80; this.rate = c.rate ?? 1;
    this.loop = !!c.loop; this.color = c.color || this.color;
    this.render();
  }
}

const PADS = [];
const voiceCount = () => PADS.reduce((n, p) => n + p.voices.size, 0);
function stealOldestVoice() {
  let o = null;
  for (const p of PADS) for (const v of p.voices) if (!o || v.t0 < o.t0) o = v;
  if (o) try { o.s.stop(); } catch {}
}
/* 実際に使う段数。自動なら「押しやすい高さ」から画面に入る段数を割り出す */
let effRows = 4;
function calcRows() {
  if (!S.padRowsAuto) return clamp(S.padRows, 1, 8);
  const g = $('#padGrid'); if (!g) return S.padRows;
  const cs = getComputedStyle(g);
  const avail = g.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0);
  if (!(avail > 60)) return S.padRows;                 // まだ描画前
  const gap = parseFloat(cs.rowGap || 0) || 0;
  const target = S.ui === 'touch' ? 94 : 80;           // 1段あたりの目標の高さ
  return clamp(Math.floor((avail + gap) / (target + gap)), 1, 8);
}
const padsPerPage = () => Math.max(1, S.cols * effRows);
const padPageCount = () => Math.max(1, Math.ceil(PADS.length / padsPerPage()));

/* パッドはスクロールさせず、画面にぴったり収める。
   指でなぞる操作＝スクロール、という誤解が起きないようにするため
   （パッドの上をなぞってもスクロールできないのは操作として最悪なので、
   そもそもスクロールを不要にする）。入りきらない分はページで切り替える。 */
function layoutPads() {
  const grid = $('#padGrid');
  effRows = calcRows();
  S.padPage = clamp(S.padPage, 0, padPageCount() - 1);
  const per = padsPerPage(), from = S.padPage * per, to = from + per;
  grid.style.setProperty('--cols', S.cols);
  grid.style.setProperty('--rows', Math.min(effRows, Math.ceil((Math.min(to, PADS.length) - from) / S.cols) || 1));
  PADS.forEach((p, i) => { p.el.style.display = (i >= from && i < to) ? '' : 'none'; });
  const multi = padPageCount() > 1;
  $('#padPager').style.display = multi ? '' : 'none';
  $('#padPageV').textContent = (S.padPage + 1) + ' / ' + padPageCount();
  $('#padPrev').disabled = S.padPage <= 0;
  $('#padNext').disabled = S.padPage >= padPageCount() - 1;
  const rl = $('#padRowsV');
  if (rl) rl.textContent = S.padRowsAuto ? '自動 ' + effRows : String(effRows);
  $('#padRows').value = effRows;
  padsDirty = true;
}
function buildPads(n) {
  n = clamp(n, 1, MAX_PADS);
  const grid = $('#padGrid');
  while (PADS.length < n) { const p = new Pad(PADS.length); PADS.push(p); grid.appendChild(p.el); }
  while (PADS.length > n) { const p = PADS.pop(); p.stopAll(0); p.el.remove(); }
  S.padCount = PADS.length;
  $('#padMinus').disabled = PADS.length <= S.cols;
  $('#padPlus').disabled = PADS.length >= MAX_PADS;
  rebuildKeyMap(); layoutPads();
}

/* ---------------------------------------------------------
   ファイル取り込み
   --------------------------------------------------------- */
const LIB = new Map();
let ROOT = null;

async function scanDir(h, base = '', out = LIB) {
  for await (const [name, e] of h.entries()) {
    const path = base ? base + '/' + name : name;
    if (e.kind === 'file') { if (AUDIO_EXT.test(name)) out.set(path, e); }
    else if (e.kind === 'directory') await scanDir(e, path, out);
  }
}
async function pickFolder() {
  if (!window.showDirectoryPicker) { toast('このブラウザはフォルダ選択に未対応です', true); return null; }
  try {
    const h = await showDirectoryPicker({ id:'amp-lib', mode:'read' });
    ROOT = h; LIB.clear(); await scanDir(h);
    await DB.set('root', h);
    const list = [...LIB.entries()].map(([path, handle]) => ({ path, handle, name:path.split('/').pop() }));
    list.sort((a, b) => a.path.localeCompare(b.path, 'ja', { numeric:true }));
    toast(list.length + ' 個の音声ファイルを読み込みました');
    return list;
  } catch (e) { if (e.name !== 'AbortError') toast('フォルダ読込失敗: ' + e.message, true); return null; }
}
function pickFiles(multiple = true) {
  return new Promise(res => {
    const inp = document.createElement('input');
    inp.type = 'file'; inp.multiple = multiple;
    inp.accept = 'audio/*,.mp3,.wav,.flac,.ogg,.m4a,.aac,.opus';
    inp.onchange = () => res(stampPath([...inp.files].map(f => ({ file:f, name:f.name, path:null }))));
    inp.oncancel = () => res([]);
    inp.click();
  });
}
async function filesFromDataTransfer(dt) {
  const out = [];
  const entries = [...(dt.items || [])].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (entries.length) {
    const walk = async (ent, base) => {
      if (ent.isFile) {
        if (!AUDIO_EXT.test(ent.name)) return;
        const f = await new Promise(r => ent.file(r, () => r(null)));
        if (f) out.push({ file:f, name:ent.name, path:base + ent.name });
      } else if (ent.isDirectory) {
        const rd = ent.createReader(), all = [];
        for (;;) { const b = await new Promise(r => rd.readEntries(r, () => r([]))); if (!b.length) break; all.push(...b); }
        for (const c of all) await walk(c, base + ent.name + '/');
      }
    };
    for (const e of entries) await walk(e, '');
  } else {
    for (const f of dt.files || []) if (AUDIO_EXT.test(f.name)) out.push({ file:f, name:f.name, path:null });
  }
  out.sort((a, b) => (a.path || a.name).localeCompare(b.path || b.name, 'ja', { numeric:true }));
  return stampPath(out);
}

/* ---------------------------------------------------------
   プレイリスト
   --------------------------------------------------------- */
let PL = [], plCursor = -1;
const durQ = []; let durRunning = 0;

function addToPlaylist(items) {
  const from = PL.length;
  stampPath(items);                    // 実ファイルパスを覚えておく（次回起動時の復元用）
  for (const it of items) PL.push({ ...it });
  renderPlaylist(); saveState();
  for (let i = from; i < PL.length; i++) { durQ.push(i); }
  pumpDuration();
}
function pumpDuration() {
  while (durRunning < 3 && durQ.length) {
    const i = durQ.shift(), it = PL[i];
    if (!it || it.dur != null) continue;
    durRunning++;
    (async () => {
      try {
        const f = await ensureFile(it);
        if (!f) throw 0;
        const u = URL.createObjectURL(f), a = new Audio();
        a.preload = 'metadata'; a.src = u;
        it.dur = await new Promise((res, rej) => {
          a.onloadedmetadata = () => res(a.duration);
          a.onerror = () => rej(0);
          setTimeout(() => rej(0), 12000);
        });
        URL.revokeObjectURL(u);
        const el = $('.pl-item[data-i="' + i + '"] .pl-dur');
        if (el) el.textContent = fmt(it.dur);
      } catch { it.dur = 0; }
      finally { durRunning--; pumpDuration(); }
    })();
  }
}
let plFilter = '';
function renderPlaylist() {
  const box = $('#playlist');
  $('#plCount').textContent = PL.length + '曲';
  if (!PL.length) {
    box.innerHTML = '<div class="pl-empty">曲をここにドラッグ＆ドロップ<br>または「フォルダ」でまとめて読み込み</div>';
    return;
  }
  const q = plFilter.trim().toLowerCase();
  const loaded = new Set(DECKS.map(d => d.meta && d.meta.name).filter(Boolean));
  const frag = document.createDocumentFragment();
  let shown = 0;
  PL.forEach((it, i) => {
    if (q && !it.name.toLowerCase().includes(q)) return;
    shown++;
    const c = trackConf(it, false);
    const marks = (c && (c.in > 0 || c.out > 0) ? '✂' : '') + (c && c.auto && c.auto.length ? '⌁' : '');
    const d = document.createElement('div');
    d.className = 'pl-item' + (loaded.has(it.name) ? ' cur' : '') + (it.missing ? ' missing' : '');
    d.dataset.i = i;
    if (it.missing) d.title = 'ファイルが見つかりません: ' + (it.fsPath || it.name);
    // タッチ時は HTML5 ドラッグを付けない（指でのスクロールを奪ってしまうため）。
    // 代わりに ▲▼ ボタンで並べ替える。検索中は順序が実際と違うので無効。
    const canDrag = !q && S.ui !== 'touch';
    d.draggable = canDrag;
    d.innerHTML = '<span class="pl-no num">' + (i + 1) + '</span><span class="pl-name"></span>' +
      '<span class="pl-mark">' + marks + '</span>' +
      '<span class="pl-acts">' +
      (canDrag || q ? '' : '<button class="btn sm q" data-a="up" title="上へ">▲</button><button class="btn sm q" data-a="dn" title="下へ">▼</button>') +
      DECKS.map(dk => '<button class="btn sm q" data-a="' + dk.id + '">' + dk.id + '</button>').join('') +
      '<button class="btn sm q" data-a="cue" title="ヘッドホンで試聴">試聴</button>' +
      '<button class="btn sm q" data-a="trk" title="イン点・アウト点・音量の自動変化">調整</button>' +
      '<button class="btn sm q" data-a="del">✕</button></span>' +
      '<span class="pl-dur num">' + (it.dur != null ? fmt(it.dur) : '') + '</span>';
    $('.pl-name', d).textContent = it.name;
    d.ondblclick = async () => { const dk = idleDeck(); if (await dk.load(it)) { plCursor = i; dk.play(); selectDeck(dk.id); } };
    d.onclick = async e => {
      const b = e.target.closest('button'); if (!b) return;
      e.stopPropagation();
      const a = b.dataset.a;
      if (a === 'del') { PL.splice(i, 1); renderPlaylist(); saveState(); return; }
      if (a === 'cue') { playCue(it, i); return; }
      if (a === 'trk') { openTrackDlg(it); return; }
      if (a === 'up' || a === 'dn') {
        const to = i + (a === 'up' ? -1 : 1);
        if (to < 0 || to >= PL.length) return;
        [PL[i], PL[to]] = [PL[to], PL[i]];
        plCursor = -1; renderPlaylist(); saveState(); return;
      }
      const dk = deckOf(a);
      if (dk && await dk.load(it)) { plCursor = i; selectDeck(a); }
    };
    // ドラッグで並べ替え
    d.ondragstart = e => { e.dataTransfer.setData('amp/pl', String(i)); e.dataTransfer.effectAllowed = 'move'; d.classList.add('dragging'); };
    d.ondragend = () => d.classList.remove('dragging');
    d.ondragover = e => {
      if (!e.dataTransfer.types.includes('amp/pl')) return;
      e.preventDefault(); e.stopPropagation();
      const r = d.getBoundingClientRect();
      d.classList.toggle('drop-after', e.clientY > r.top + r.height / 2);
      d.classList.add('drop');
    };
    d.ondragleave = () => d.classList.remove('drop', 'drop-after');
    d.ondrop = e => {
      if (!e.dataTransfer.types.includes('amp/pl')) return;
      e.preventDefault(); e.stopPropagation();
      const from = +e.dataTransfer.getData('amp/pl');
      const after = d.classList.contains('drop-after');
      d.classList.remove('drop', 'drop-after');
      if (!isFinite(from) || from === i) return;
      const [moved] = PL.splice(from, 1);
      let to = i + (after ? 1 : 0);
      if (from < to) to--;
      PL.splice(clamp(to, 0, PL.length), 0, moved);
      plCursor = -1;
      renderPlaylist(); saveState();
    };
    frag.appendChild(d);
  });
  if (!shown) {
    box.innerHTML = '<div class="pl-empty">「' + plFilter + '」に一致する曲がありません</div>';
    return;
  }
  box.replaceChildren(frag);
}

/* ---------------------------------------------------------
   キューリスト（進行表）
   進行順に「何をするか」を並べておき、GO（Enter）で1つずつ実行する。
   当日は順番を覚えなくてよく、担当者が交代しても引き継げる。
   --------------------------------------------------------- */
const CUE_KIND = {
  play:  { label:'曲を再生',        icon:'▶' },
  fade:  { label:'フェードアウト',  icon:'▼' },
  stop:  { label:'停止',            icon:'■' },
  sfx:   { label:'効果音',          icon:'♪' },
  note:  { label:'メモ（音は出ない）', icon:'·' },
};
function addCue(kind, extra = {}) {
  S.cues.push({ kind, label:'', deck:DECKS[0] ? DECKS[0].id : 'A', fade:S.fade.in, ...extra });
  renderCues(); saveState();
}
function renderCues() {
  const box = $('#cueList'); if (!box) return;
  $('#cueCount').textContent = S.cues.length + '件';
  if (!S.cues.length) {
    box.innerHTML = '<div class="pl-empty">進行表がまだありません。<br>下の「＋」で項目を足すか、プレイリストの曲を「進行表へ」で追加できます。</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  S.cues.forEach((c, i) => {
    const k = CUE_KIND[c.kind] || CUE_KIND.note;
    const row = document.createElement('div');
    row.className = 'cue-item' + (i === S.cueIdx ? ' done' : '') + (i === S.cueIdx + 1 ? ' next' : '');
    row.dataset.i = i;
    const canDrag = S.ui !== 'touch';        // タッチではドラッグを付けない（スクロールを奪うため）
    row.draggable = canDrag;
    let detail = '';
    if (c.kind === 'play') detail = (c.track || '（曲未設定）') + ' → デッキ' + c.deck + '　' + (c.fade > 0 ? c.fade.toFixed(1) + '秒でフェードイン' : '即再生');
    else if (c.kind === 'fade') detail = 'デッキ' + c.deck + ' を ' + (c.fade || S.fade.out).toFixed(1) + '秒でフェードアウト';
    else if (c.kind === 'stop') detail = c.deck === '*' ? '全部止める' : 'デッキ' + c.deck + ' を停止';
    else if (c.kind === 'sfx') detail = 'パッド ' + ((c.pad ?? 0) + 1) + '　' + (PADS[c.pad] && PADS[c.pad].name ? PADS[c.pad].name : '');
    row.innerHTML =
      '<span class="cue-no num">' + (i + 1) + '</span>' +
      '<span class="cue-icon">' + k.icon + '</span>' +
      '<span class="cue-body"><b class="cue-label"></b><span class="cue-detail"></span></span>' +
      '<span class="cue-acts">' +
        (canDrag ? '' : '<button class="btn sm q" data-a="up" title="上へ">▲</button><button class="btn sm q" data-a="dn" title="下へ">▼</button>') +
        '<button class="btn sm q" data-a="go" title="この項目をここから実行">▶</button>' +
        '<button class="btn sm q" data-a="edit">編集</button>' +
        '<button class="btn sm q" data-a="del">✕</button></span>';
    $('.cue-label', row).textContent = c.label || k.label;
    $('.cue-detail', row).textContent = detail;
    row.onclick = e => {
      const b = e.target.closest('button');
      if (!b) { S.cueIdx = i - 1; renderCues(); saveState(); return; }   // ここまで進んだ扱いにする
      e.stopPropagation();
      const a = b.dataset.a;
      if (a === 'del') { S.cues.splice(i, 1); if (S.cueIdx >= i) S.cueIdx--; renderCues(); saveState(); }
      if (a === 'edit') openCueDlg(i);
      if (a === 'go') { S.cueIdx = i - 1; cueGo(); }
      if (a === 'up' || a === 'dn') {
        const to = i + (a === 'up' ? -1 : 1);
        if (to < 0 || to >= S.cues.length) return;
        [S.cues[i], S.cues[to]] = [S.cues[to], S.cues[i]];
        renderCues(); saveState();
      }
    };
    row.ondragstart = e => { e.dataTransfer.setData('amp/cue', String(i)); row.classList.add('dragging'); };
    row.ondragend = () => row.classList.remove('dragging');
    row.ondragover = e => {
      if (!e.dataTransfer.types.includes('amp/cue')) return;
      e.preventDefault(); e.stopPropagation();
      const r = row.getBoundingClientRect();
      row.classList.toggle('drop-after', e.clientY > r.top + r.height / 2);
      row.classList.add('drop');
    };
    row.ondragleave = () => row.classList.remove('drop', 'drop-after');
    row.ondrop = e => {
      if (!e.dataTransfer.types.includes('amp/cue')) return;
      e.preventDefault(); e.stopPropagation();
      const from = +e.dataTransfer.getData('amp/cue');
      const after = row.classList.contains('drop-after');
      row.classList.remove('drop', 'drop-after');
      if (!isFinite(from) || from === i) return;
      const [m] = S.cues.splice(from, 1);
      let to = i + (after ? 1 : 0); if (from < to) to--;
      S.cues.splice(clamp(to, 0, S.cues.length), 0, m);
      renderCues(); saveState();
    };
    frag.appendChild(row);
  });
  box.replaceChildren(frag);
  updateCueGo();
  const el = box.querySelector('.cue-item.next');
  if (el) el.scrollIntoView({ block:'nearest' });
}
function updateCueGo() {
  const nx = S.cues[S.cueIdx + 1];
  const b = $('#cueGo'); if (!b) return;
  b.disabled = !nx;
  const k = nx && (CUE_KIND[nx.kind] || CUE_KIND.note);
  $('#cueNext').textContent = nx ? (nx.label || k.label) + (nx.track ? '： ' + nx.track : '') : '— 進行表の最後です —';
}
async function cueGo() {
  const c = S.cues[S.cueIdx + 1];
  if (!c) { toast('進行表の最後です'); return; }
  S.cueIdx++;
  try {
    if (c.kind === 'play') {
      const dk = deckOf(c.deck) || idleDeck();
      const it = PL.find(x => trackKey(x) === c.trackKey) || PL.find(x => x.name === c.track);
      if (!it) { toast('「' + (c.track || '') + '」がプレイリストにありません', true); }
      else if (await dk.load(it)) { plCursor = PL.indexOf(it); dk.play(c.fade || 0); selectDeck(dk.id); }
    } else if (c.kind === 'fade') {
      const dk = deckOf(c.deck); if (dk) dk.fadeStop(c.fade || S.fade.out);
    } else if (c.kind === 'stop') {
      if (c.deck === '*') { DECKS.forEach(d => d.stop()); PADS.forEach(p => p.stopAll(60)); }
      else { const dk = deckOf(c.deck); if (dk) dk.stop(); }
    } else if (c.kind === 'sfx') {
      const p = PADS[c.pad]; if (p && p.buffer) p.trigger(); else toast('パッド ' + ((c.pad ?? 0) + 1) + ' は空です', true);
    }
  } catch (e) { toast('実行できませんでした: ' + e.message, true); }
  renderCues(); saveState();
}

/* キュー編集ダイアログ */
let cueIdxEdit = -1;
function openCueDlg(i) {
  cueIdxEdit = i;
  const c = S.cues[i];
  $('#cueKind').value = c.kind;
  $('#cueLabel').value = c.label || '';
  const trk = $('#cueTrack');
  trk.replaceChildren();
  trk.add(new Option('（選んでください）', ''));
  PL.forEach(it => trk.add(new Option(it.name, trackKey(it))));
  trk.value = c.trackKey || '';
  const dk = $('#cueDeck');
  dk.replaceChildren();
  DECKS.forEach(d => dk.add(new Option('デッキ ' + d.id, d.id)));
  dk.add(new Option('すべて', '*'));
  dk.value = c.deck || DECKS[0].id;
  const pd = $('#cuePad');
  pd.replaceChildren();
  PADS.forEach((p, n) => pd.add(new Option('パッド ' + (n + 1) + (p.name ? '： ' + p.name : '（空）'), String(n))));
  pd.value = String(c.pad ?? 0);
  $('#cueFade').value = c.fade ?? S.fade.in;
  $('#cueFadeV').textContent = (c.fade ?? S.fade.in).toFixed(1) + ' 秒';
  syncCueDlg();
  $('#cueMask').classList.add('show');
}
function syncCueDlg() {
  const k = $('#cueKind').value;
  $('#cueRowTrack').style.display = k === 'play' ? '' : 'none';
  $('#cueRowDeck').style.display  = (k === 'play' || k === 'fade' || k === 'stop') ? '' : 'none';
  $('#cueRowPad').style.display   = k === 'sfx' ? '' : 'none';
  $('#cueRowFade').style.display  = (k === 'play' || k === 'fade') ? '' : 'none';
}

/* ---------------------------------------------------------
   試聴（Cue）
   --------------------------------------------------------- */
const CUE = (() => {
  const c = BUS.cue.ctx, a = new Audio(); a.preload = 'auto';
  c.createMediaElementSource(a).connect(BUS.cue.input);
  return { audio:a, url:null };
})();
async function playCue(it, idx) {
  resumeAll();
  try {
    const f = await ensureFile(it);
    if (!f) { toast('ファイルが見つかりません: ' + it.name, true); return; }
    if (CUE.url) URL.revokeObjectURL(CUE.url);
    CUE.url = URL.createObjectURL(f); CUE.audio.src = CUE.url;
    await CUE.audio.play();
    $$('.pl-item').forEach(e => e.classList.remove('cue'));
    const row = $('.pl-item[data-i="' + idx + '"]'); if (row) row.classList.add('cue');
    toast('試聴中（試聴バスのみ）: ' + it.name);
  } catch (e) { toast('試聴できません: ' + e.message, true); }
}
function stopCue() {
  CUE.audio.pause(); CUE.audio.currentTime = 0;
  $$('.pl-item').forEach(e => e.classList.remove('cue'));
}

/* ---------------------------------------------------------
   WEB プレイヤー（YouTube・配信リンク）
   各サービスの公式埋め込みプレイヤーをそのまま載せる方式。
   音声は 3 バスを通らず Windows の既定出力デバイスへ出る
   （Voicemeeter 利用時は既定を VoiceMeeter Input にすると BGM と同じ卓に乗る）。
   YouTube / YT Music はフル再生＋操作可。Spotify / Apple Music は公式
   ウィジェット（環境によりプレビューのみ）。Amazon Music はブラウザで開くだけ。
   --------------------------------------------------------- */
const WEB = { kind:null, player:null, ready:false, loop:false, fadeTok:0, rampT:null, pendingHist:null };

function parseMediaLink(raw) {
  let u; try { u = new URL(raw.trim()); } catch { return null; }
  const h = u.hostname.replace(/^(www|m)\./, '');
  if (h === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return id ? { type:'youtube', id, list:u.searchParams.get('list') || '' } : null;
  }
  if (h === 'youtube.com' || h === 'music.youtube.com' || h === 'youtube-nocookie.com') {
    const list = u.searchParams.get('list') || '';
    let id = u.searchParams.get('v') || '';
    const m = u.pathname.match(/^\/(?:shorts|live|embed)\/([\w-]+)/);
    if (!id && m) id = m[1];
    return (id || list) ? { type:'youtube', id, list } : null;
  }
  if (h === 'open.spotify.com') {
    const m = u.pathname.match(/^\/(?:intl-[a-z]{2}(?:-[A-Za-z]{2})?\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)/);
    return m ? { type:'spotify', embed:'https://open.spotify.com/embed/' + m[1] + '/' + m[2], label:m[1] + '/' + m[2] } : null;
  }
  if (h === 'music.apple.com') {
    const label = decodeURIComponent(u.pathname.split('/').filter(Boolean).slice(-2).join('/'));
    return { type:'apple', embed:'https://embed.music.apple.com' + u.pathname + u.search, label };
  }
  if (/(^|\.)music\.amazon\./.test(u.hostname)) return { type:'amazon', url:raw.trim() };
  return null;
}

let ytApiP = null;
function loadYtApi() {
  if (window.YT && window.YT.Player) return Promise.resolve(window.YT);
  if (ytApiP) return ytApiP;
  ytApiP = new Promise((res, rej) => {
    const fail = msg => { ytApiP = null; rej(new Error(msg)); };
    const to = setTimeout(() => fail('YouTube を読み込めません（インターネット接続を確認してください）'), 12000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(to); res(window.YT); };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { clearTimeout(to); fail('YouTube を読み込めません（インターネット接続を確認してください）'); };
    document.head.appendChild(s);
  });
  return ytApiP;
}

/* BGMフェーダー・ミュート・DUCK を反映した実効音量 (0-100) */
function webEffVol() {
  const duckF = (S.duck.on && voiceCount() > 0) ? Math.pow(10, -S.duck.amount / 20) : 1;
  const master = S.mute.bgm ? 0 : Math.min(S.vol.bgm, 1);
  return clamp(Math.round(S.webVol * 100 * master * duckF), 0, 100);
}
function applyWebVol(ms = 100) {
  if (WEB.kind !== 'yt' || !WEB.ready || !WEB.player) return;
  const target = webEffVol();
  clearInterval(WEB.rampT); WEB.rampT = null;
  let from; try { from = WEB.player.getVolume(); } catch { return; }
  if (ms <= 0 || Math.abs(from - target) < 2) { try { WEB.player.setVolume(target); } catch {} return; }
  const t0 = performance.now();
  WEB.rampT = setInterval(() => {
    const p = Math.min(1, (performance.now() - t0) / ms);
    try { WEB.player.setVolume(Math.round(from + (target - from) * p)); } catch {}
    if (p >= 1) { clearInterval(WEB.rampT); WEB.rampT = null; }
  }, 30);
}
const webPlaying = () =>
  WEB.kind === 'yt' && WEB.ready && WEB.player && WEB.player.getPlayerState && WEB.player.getPlayerState() === 1;

function webFade(dirIn) {
  if (WEB.kind !== 'yt' || !WEB.ready) return;
  const tok = ++WEB.fadeTok;
  clearInterval(WEB.rampT); WEB.rampT = null;
  const target = dirIn ? webEffVol() : 0;
  let from;
  if (dirIn) { try { WEB.player.setVolume(0); WEB.player.playVideo(); } catch {} from = 0; }
  else { try { from = WEB.player.getVolume(); } catch { return; } }
  const t0 = performance.now(), dur = Math.max(dirIn ? S.fade.in : S.fade.out, 0.05) * 1000;
  WEB.rampT = setInterval(() => {
    if (tok !== WEB.fadeTok) { clearInterval(WEB.rampT); WEB.rampT = null; return; }
    const p = Math.min(1, (performance.now() - t0) / dur);
    try { WEB.player.setVolume(Math.round(from + (target - from) * p)); } catch {}
    if (p >= 1) {
      clearInterval(WEB.rampT); WEB.rampT = null;
      if (!dirIn) {
        try { WEB.player.pauseVideo(); } catch {}
        setTimeout(() => { if (tok === WEB.fadeTok) applyWebVol(0); }, 150);   // 次回再生に備え音量を戻す
      }
    }
  }, 40);
}

function onYtState(e) {
  $('#webPlay').textContent = e.data === 1 ? '❚❚' : '▶';
  if (e.data === 1 && WEB.pendingHist) {
    let label = '';
    try { label = (WEB.player.getVideoData() || {}).title || ''; } catch {}
    pushWebHistory(WEB.pendingHist, label || 'YouTube', 'YouTube');
    WEB.pendingHist = null;
  }
  if (e.data === 0 && WEB.loop) { try { WEB.player.seekTo(0, true); WEB.player.playVideo(); } catch {} }
}

async function loadWebLink(raw) {
  const info = parseMediaLink(raw);
  if (!info) { toast('対応していないリンクです（YouTube / Spotify / Apple Music / Amazon Music）', true); return; }
  if (info.type === 'amazon') {
    window.open(info.url);
    toast('Amazon Music は埋め込み再生に対応していないため、ブラウザで開きました');
    pushWebHistory(raw, 'Amazon Music のリンク', 'Amazon');
    return;
  }
  setWebOpen(true);
  const ytWrap = $('#ytWrap'), frame = $('#webFrame'), empty = $('#webEmpty'), ctrl = $('#webCtrl');
  if (info.type === 'youtube') {
    frame.style.display = 'none'; frame.src = 'about:blank';
    empty.style.display = 'none'; ytWrap.style.display = '';
    ctrl.classList.remove('noctl');
    WEB.kind = 'yt'; WEB.pendingHist = raw;
    try {
      const api = await loadYtApi();
      if (!WEB.player) {
        WEB.ready = false;
        WEB.player = new api.Player('ytHost', {
          width:'100%', height:'100%',
          videoId: info.id || undefined,
          playerVars: { controls:1, rel:0, playsinline:1, origin:location.origin,
                        ...(info.list ? { listType:'playlist', list:info.list } : {}) },
          events: {
            onReady: () => { WEB.ready = true; applyWebVol(0); try { WEB.player.playVideo(); } catch {} },
            onStateChange: onYtState,
            onError: ev => {
              const msg = { 2:'リンクが正しくありません', 5:'再生できません', 100:'動画が見つかりません',
                            101:'この動画は埋め込み再生が許可されていません',
                            150:'この動画は埋め込み再生が許可されていません' }[ev.data] || '再生できません';
              toast('YouTube: ' + msg, true);
            },
          },
        });
      } else {
        WEB.fadeTok++;
        if (info.list) WEB.player.loadPlaylist({ listType:'playlist', list:info.list });
        else WEB.player.loadVideoById(info.id);
        applyWebVol(0);
      }
    } catch (e) {
      toast(e.message, true);
      WEB.kind = null; ytWrap.style.display = 'none'; empty.style.display = '';
    }
    return;
  }
  /* Spotify / Apple Music: 公式ウィジェット（操作はウィジェット内のボタンで） */
  if (webPlaying()) { WEB.fadeTok++; try { WEB.player.pauseVideo(); } catch {} }
  WEB.kind = 'iframe';
  ytWrap.style.display = 'none'; empty.style.display = 'none';
  frame.style.display = ''; frame.src = info.embed;
  ctrl.classList.add('noctl');
  pushWebHistory(raw, (info.type === 'spotify' ? 'Spotify ' : 'Apple Music ') + (info.label || ''),
                 info.type === 'spotify' ? 'Spotify' : 'Apple');
  toast(info.type === 'spotify'
    ? 'Spotify ウィジェットを読み込みました（再生はウィジェット内のボタンで）'
    : 'Apple Music ウィジェットを読み込みました（プレビュー再生）');
}

function pushWebHistory(url, label, badge) {
  S.webHistory = (S.webHistory || []).filter(x => x.url !== url);
  S.webHistory.unshift({ url, label:(label || url).slice(0, 80), badge });
  S.webHistory = S.webHistory.slice(0, 12);
  renderWebHistory(); saveState();
}
function renderWebHistory() {
  const box = $('#webHist'); if (!box) return;
  box.replaceChildren();
  for (const it of S.webHistory || []) {
    const d = document.createElement('div');
    d.className = 'wh'; d.title = it.url;
    d.innerHTML = '<span class="b"></span><span class="t"></span><button class="x">✕</button>';
    $('.b', d).textContent = it.badge || 'link';
    $('.t', d).textContent = it.label;
    d.onclick = e => {
      if (e.target.closest('.x')) {
        S.webHistory = S.webHistory.filter(x => x !== it);
        renderWebHistory(); saveState(); return;
      }
      $('#webUrl').value = it.url; loadWebLink(it.url);
    };
    box.appendChild(d);
  }
}

function setWebOpen(open) {
  S.webOpen = !!open;
  $('#webPanel').style.display = S.webOpen ? '' : 'none';
  $('#webToggle').classList.toggle('on', S.webOpen);
  $('#webToggle').textContent = S.webOpen ? '閉じる' : '表示';
  saveState();
}
function updateWebTime() {
  if (WEB.kind !== 'yt' || !WEB.ready) return;
  let c = 0, d = 0;
  try { c = WEB.player.getCurrentTime() || 0; d = WEB.player.getDuration() || 0; } catch {}
  $('#webTime').textContent = fmt(c) + ' / ' + fmt(d);
}
function bindWebUI() {
  $('#webToggle').onclick = () => setWebOpen(!S.webOpen);
  $('#webLoad').onclick = () => { const v = $('#webUrl').value.trim(); if (v) loadWebLink(v); };
  $('#webUrl').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#webLoad').click(); } });
  $('#webExt').onclick = () => { const v = $('#webUrl').value.trim(); if (v) window.open(v); };
  $('#webPlay').onclick = () => {
    if (WEB.kind !== 'yt' || !WEB.ready) return;
    WEB.fadeTok++;
    try { webPlaying() ? WEB.player.pauseVideo() : (applyWebVol(0), WEB.player.playVideo()); } catch {}
  };
  $('#webStop').onclick = () => {
    if (WEB.kind !== 'yt' || !WEB.ready) return;
    WEB.fadeTok++;
    try { WEB.player.stopVideo(); } catch {}
    $('#webPlay').textContent = '▶';
  };
  $('#webLoop').onclick = e => { WEB.loop = !WEB.loop; e.target.classList.toggle('on', WEB.loop); };
  $('#webFin').onclick = () => webFade(true);
  $('#webFout').onclick = () => webFade(false);
  const wv = $('#webVol'), wvv = $('#webVolV');
  wv.value = S.webVol; wvv.textContent = Math.round(S.webVol * 100) + '%';
  wv.oninput = () => { S.webVol = +wv.value; wvv.textContent = Math.round(S.webVol * 100) + '%'; applyWebVol(0); saveState(); };
  renderWebHistory();
  $('#webPanel').style.display = S.webOpen ? '' : 'none';
  $('#webToggle').classList.toggle('on', S.webOpen);
  $('#webToggle').textContent = S.webOpen ? '閉じる' : '表示';
}

/* ---------------------------------------------------------
   ダッキング
   --------------------------------------------------------- */
let duckState = false;
function updateDuck() {
  const active = voiceCount() > 0;
  if (active === duckState) return;
  duckState = active;
  const g = BUS.bgm.duck.gain, t = BUS.bgm.ctx.currentTime;
  g.cancelScheduledValues(t);
  if (!S.duck.on) { g.setTargetAtTime(1, t, .01); applyWebVol(60); return; }
  g.setTargetAtTime(active ? Math.pow(10, -S.duck.amount / 20) : 1,
                    t, active ? .02 : S.duck.release / 3000);
  applyWebVol(active ? 80 : Math.min(S.duck.release, 600));   // WEB プレイヤーにも DUCK を反映
}

/* ---------------------------------------------------------
   出力デバイス
   --------------------------------------------------------- */
let DEVICES = [];
const SINK_OK = typeof AudioContext.prototype.setSinkId === 'function';

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  DEVICES = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
  $('#devWarn').style.display = DEVICES.some(d => !d.label) ? '' : 'none';
  for (const [k, sel] of [['bgm', $('#devBgm')], ['sfx', $('#devSfx')], ['cue', $('#devCue')]]) {
    const cur = S.sinks[k];
    sel.replaceChildren();
    sel.add(new Option('（Windows の既定デバイス）', ''));
    for (const d of DEVICES) {
      if (!d.deviceId || d.deviceId === 'default' || d.deviceId === 'communications') continue;
      sel.add(new Option(d.label || ('出力 ' + d.deviceId.slice(0, 6)), d.deviceId));
    }
    sel.value = [...sel.options].some(o => o.value === cur) ? cur : '';
  }
  guessVoicemeeter();
  updateDevTags();
}
function guessVoicemeeter() {
  if (S.sinks.bgm || S.sinks.sfx) return;
  const find = re => DEVICES.find(d => re.test(d.label || ''));
  const vaio = find(/VoiceMeeter\s+Input/i), aux = find(/VoiceMeeter\s+Aux\s+Input/i);
  if (vaio) { S.sinks.bgm = vaio.deviceId; $('#devBgm').value = vaio.deviceId; }
  if (aux)  { S.sinks.sfx = aux.deviceId;  $('#devSfx').value = aux.deviceId; }
  if (vaio || aux) { applySinks(); toast('Voicemeeter を検出しました（BGM → VAIO / SE → AUX）'); }
}
async function applySinks() {
  if (!SINK_OK) { setStatus('この環境では出力先を個別に指定できません（既定デバイスへ出力）'); return; }
  for (const [k, b] of [['bgm', BUS.bgm], ['sfx', BUS.sfx], ['cue', BUS.cue]]) {
    try { await b.setSink(S.sinks[k]); }
    catch (e) { toast(k.toUpperCase() + ' の出力先を設定できません: ' + e.message, true); }
  }
  updateDevTags(); saveState();
}
function devName(id) {
  if (!id) return '既定';
  const d = DEVICES.find(x => x.deviceId === id);
  return d && d.label ? d.label.replace(/\s*\(.*?\)\s*$/, '') : '指定済み';
}
function updateDevTags() {
  const b = $('#bgmDev'), s = $('#sfxDev');
  b.textContent = '出力: ' + devName(S.sinks.bgm); b.classList.toggle('on', !!S.sinks.bgm);
  s.textContent = '出力: ' + devName(S.sinks.sfx); s.classList.toggle('on', !!S.sinks.sfx);
}
async function unlockDeviceLabels() {
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio:true });
    st.getTracks().forEach(t => t.stop());
    await refreshDevices();
    toast('デバイス名を取得しました');
  } catch (e) { toast('許可されませんでした: ' + e.message, true); }
}

/* ---------------------------------------------------------
   ミキサー UI
   --------------------------------------------------------- */
const MIX_DEF = [
  { bus:'bgm', label:'BGM' },
  { bus:'sfx', label:'効果音' },
];
function buildMixer() {
  const box = $('#mixStrips'); box.replaceChildren();
  for (const def of MIX_DEF) {
    const e = S.eq[def.bus];
    const d = document.createElement('div');
    d.className = 'mix';
    d.innerHTML =
      '<div class="mix-h"><span class="t">' + def.label + '</span><button class="btn sm q" data-t="on">EQ</button></div>' +
      knob('hp',   'ローカット', 20, 400, 1, 'Hz') +
      knob('low',  'LOW',      -12, 12, .5, 'dB') +
      knob('mid',  'MID',      -12, 12, .5, 'dB') +
      knob('midF', 'MID周波数', 200, 6000, 10, 'Hz') +
      knob('high', 'HIGH',     -12, 12, .5, 'dB') +
      '<div class="mix-sub"><div class="mix-h" style="margin:0 0 6px;padding:0;border:none">' +
        '<span class="t">コンプレッサー</span><button class="btn sm q" data-t="comp">COMP</button></div>' +
      knob('thr',    'スレッショルド', -40, 0, 1, 'dB') +
      knob('ratio',  'レシオ',          1, 12, .5, ':1') +
      knob('makeup', 'メイクアップ',     0, 12, .5, 'dB') +
      '<div class="gr"><i data-gr></i></div></div>';

    const sync = () => {
      $('[data-t="on"]', d).classList.toggle('on', e.on);
      $('[data-t="comp"]', d).classList.toggle('on', e.comp);
      $$('input', d).forEach(inp => { inp.disabled = ['thr','ratio','makeup'].includes(inp.dataset.k) ? !e.comp : !e.on; });
      BUS[def.bus].applyEq(e); saveState();
    };
    $('[data-t="on"]', d).onclick = () => { e.on = !e.on; sync(); };
    $('[data-t="comp"]', d).onclick = () => { e.comp = !e.comp; sync(); };
    $$('input', d).forEach(inp => {
      const k = inp.dataset.k, unit = inp.dataset.u, out = inp.parentElement.querySelector('.val');
      inp.value = e[k];
      out.textContent = fmtUnit(e[k], unit);
      inp.oninput = () => { e[k] = +inp.value; out.textContent = fmtUnit(e[k], unit); BUS[def.bus].applyEq(e); saveState(); };
    });
    d.dataset.bus = def.bus;
    box.appendChild(d); sync();
  }
}
const fmtUnit = (v, u) => u === 'Hz' ? Math.round(v) + ' Hz'
                       : u === ':1' ? v.toFixed(1) + ':1'
                       : (v > 0 ? '+' : '') + v.toFixed(1) + ' dB';
function knob(k, label, min, max, step, unit) {
  return '<label class="knob"><span>' + label + '</span>' +
         '<input type="range" data-k="' + k + '" data-u="' + unit + '" min="' + min + '" max="' + max + '" step="' + step + '">' +
         '<span class="val num"></span></label>';
}

/* ---------------------------------------------------------
   別ウィンドウのパッド（SuperDisplay / タブレット操作用）
   --------------------------------------------------------- */
const CH = ('BroadcastChannel' in self) ? new BroadcastChannel('amp-pads') : null;
let padsDirty = true, popWin = null, popAlive = 0;

function padState() {
  return { t:'state', cols:S.cols, rows:S.padRows, theme:S.theme,
    pads: PADS.map(p => ({ i:p.i, name:p.name, key:p.keyLabel, color:p.color,
      mode:MODE_LABEL[p.mode] + (p.loop ? ' ↻' : ''), loaded:!!p.buffer, playing:p.voices.size })) };
}
function pushPadState() { if (CH && popAlive) CH.postMessage(padState()); }
if (CH) CH.onmessage = ev => {
  const m = ev.data; if (!m) return;
  if (m.t === 'hello') { popAlive = Date.now(); CH.postMessage(padState()); return; }
  if (m.t === 'ping')  { popAlive = Date.now(); return; }
  if (m.t === 'bye')   { popAlive = 0; return; }
  const p = PADS[m.i];
  if (m.t === 'down' && p) p.trigger();
  if (m.t === 'up'   && p) p.release();
  if (m.t === 'panic') panic();
  if (m.t === 'stopSfx') PADS.forEach(x => x.stopAll(80));
};
function openPopout() {
  if (!CH) { toast('この環境では別ウィンドウに対応していません', true); return; }
  popWin = open('pads.html', 'amp-pads', 'width=900,height=650');
  if (!popWin) toast('ポップアップがブロックされました。許可してください', true);
  else toast('別ウィンドウを開きました。タブレット側の画面へドラッグしてください');
}

/* ---------------------------------------------------------
   小物
   --------------------------------------------------------- */
function fmt(s) {
  if (!isFinite(s) || s < 0) s = 0;
  return Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
}
let toastT = 0;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => t.className = '', err ? 4200 : 2400);
}
const setStatus = msg => { $('#stMsg').textContent = msg; };
function updateMem() {
  let bytes = 0, n = 0;
  for (const p of PADS) if (p.buffer) { n++; bytes += p.buffer.length * p.buffer.numberOfChannels * 4; }
  $('#stMem').textContent = n + '個 / ' + (bytes / 1048576).toFixed(1) + 'MB';
}
function applyTheme() {
  document.documentElement.dataset.theme = S.theme;
  requestAnimationFrame(() => DECKS.forEach(d => d.drawWave()));
  pushPadState();
}
/* 誤操作ロック。本番中の誤クリックで BGM が止まる事故を防ぐ。
   効果音のパッドと全停止だけは、ロック中でも使えるようにしておく。 */
function applyLock() {
  document.documentElement.dataset.lock = S.locked ? 'on' : 'off';
  const b = $('#btnLock');
  if (b) { b.classList.toggle('on', S.locked); b.textContent = S.locked ? '🔒 ロック中' : '🔓 ロック'; }
}

/* 起動時セルフチェック。当日の朝に気づけるよう、問題があれば画面上部に出す */
function selfCheck() {
  const bad = [];
  for (const [k, name] of [['bgm','BGM'], ['sfx','SE'], ['cue','試聴']]) {
    const id = S.sinks[k];
    if (id && !DEVICES.some(d => d.deviceId === id)) bad.push(name + ' に設定した出力先が見つかりません');
  }
  if (!DEVICES.length) bad.push('音の出力先が1つも見つかりません');
  const missing = PADS.filter(p => { const c = p.conf(); return c.path && !p.buffer; }).length;
  if (missing) bad.push('効果音 ' + missing + ' 個が読み込めていません');
  const bar = $('#checkBar');
  if (!bar) return;
  if (!bad.length) { bar.style.display = 'none'; return; }
  bar.style.display = '';
  $('#checkMsg').textContent = '⚠ ' + bad.join(' / ') + ' — 「設定」で確認してください';
}

/* マウス用UI ⇄ タッチ用UI の切替。CSS 側で密度と当たり判定をまるごと差し替える */
function applyUiMode() {
  document.documentElement.dataset.ui = S.ui;
  const b = $('#btnUi');
  if (b) {
    b.classList.toggle('on', S.ui === 'touch');
    b.textContent = S.ui === 'touch' ? 'タッチ' : 'マウス';
    b.title = S.ui === 'touch' ? 'タッチ最適化UI（クリックでマウス用に戻す）' : 'マウス用UI（クリックでタッチ最適化に切替）';
  }
  // 行のドラッグ可否がモードで変わるので、リストを組み直す
  if (PADS.length) { renderPlaylist(); renderCues(); layoutPads(); }
  requestAnimationFrame(() => DECKS.forEach(d => d.drawWave()));
}

/* ---------------------------------------------------------
   メインループ
   --------------------------------------------------------- */
let frame = 0;
function loop() {
  frame++;
  meter('#mtBgm', '#pkBgm', BUS.bgm);
  meter('#mtSfx', '#pkSfx', BUS.sfx);
  meter('#mtCue', null, BUS.cue);

  for (const d of DECKS) {
    d.tickAuto();
    const a = d.audio, dur = a.duration || 0, cur = a.currentTime || 0;
    const p = dur ? cur / dur : 0;
    d.$fill.style.width = (p * 100) + '%';
    d.$head.style.left  = (p * 100) + '%';
    if (frame % 3 === 0) {
      d.$cur.textContent = fmt(cur); d.$dur.textContent = fmt(d.outAt || dur);
      const rem = Math.max(0, (d.outAt || dur) - cur);   // アウト点までの残り
      d.$rem.textContent = ' -' + fmt(rem);
      d.$rem.classList.toggle('hot', d.playing && dur > 0 && rem <= 15);
    }
  }
  if (frame % 30 === 0) updateWebTime();
  if (frame % 6 === 0) {
    for (const p of PADS) p.tick();
    $('#sfxVoices').textContent = voiceCount() + ' 音';
    checkAutoMix();
    if (padsDirty) { padsDirty = false; pushPadState(); }
    const mm = $('#mixMask');
    if (mm.classList.contains('show')) {
      for (const def of MIX_DEF) {
        const el = $('.mix[data-bus="' + def.bus + '"] [data-gr]');
        if (el) el.style.width = clamp(-BUS[def.bus].comp.reduction / 20, 0, 1) * 100 + '%';
      }
    }
  }
  requestAnimationFrame(loop);
}
function meter(bar, pk, bus) {
  const v = bus.level(), db = 20 * Math.log10(Math.max(v, 1e-5));
  const el = $(bar);
  el.style.width = clamp((db + 54) / 57, 0, 1) * 100 + '%';
  el.classList.toggle('clip', v >= .995);
  if (pk) $(pk).style.left = clamp((20 * Math.log10(Math.max(bus.hold, 1e-5)) + 54) / 57, 0, 1) * 100 + '%';
}
/* 最小化中や裏に回っているときは requestAnimationFrame が止まる。
   音量オートメーション・アウト点・曲つなぎは音に直結するので、
   描画とは切り離してタイマーでも必ず回す。 */
setInterval(() => {
  for (const d of DECKS) d.tickAuto();
  checkAutoMix();
  updateWebTime();
  if (CH && popAlive && Date.now() - popAlive > 4000) popAlive = 0;
}, 100);

/* ---------------------------------------------------------
   キーボード
   --------------------------------------------------------- */
const keyMap = new Map();
function rebuildKeyMap() {
  keyMap.clear();
  PADS.forEach((p, i) => {
    if (!p.key) return;
    if (keyMap.has(p.key)) { p.key = null; p.render(); return; }
    keyMap.set(p.key, i);
  });
}
addEventListener('keydown', e => {
  if (capturingKey) return;
  if (e.target.matches('input,select,textarea')) return;
  if (e.code === 'Escape') { e.preventDefault(); panic(); return; }
  if (e.ctrlKey || e.altKey || e.metaKey) return;
  if (e.code === 'Enter') { e.preventDefault(); if (!e.repeat) cueGo(); return; }   // GO
  // ロック中はパッドと全停止だけ効かせる（BGM を止める操作は無効）
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat && !S.locked) curDeck().toggle(); return; }
  if (e.code === 'Tab')   { e.preventDefault(); if (!e.repeat) selectDeck(DECK_IDS[(selDeck + 1) % DECKS.length]); return; }
  const i = keyMap.get(e.code);
  if (i == null) return;
  e.preventDefault();
  if (!e.repeat && PADS[i].buffer) PADS[i].trigger();
});

/* グローバルホットキー（.exe 版のみ）。
   単独キーを全体に奪うと他アプリで文字が打てなくなるため、必ず修飾キー付きで登録する。 */
function syncGlobalKeys() {
  if (!NATIVE || !NATIVE.setGlobalKeys) return;
  const keys = S.ghk
    ? PADS.map((p, i) => p.key ? { accel: S.ghkMod + '+' + accelOf(p.key), i } : null).filter(Boolean)
    : [];
  NATIVE.setGlobalKeys(keys, S.ghk ? S.ghkMod + '+Backspace' : null)
    .then(r => {
      if (!r || !S.ghk) return;
      if (r.failed && r.failed.length) toast('一部のキーは他のソフトが使用中で登録できませんでした（' + r.failed.length + '個）', true);
    }).catch(() => {});
}
const accelOf = code => {
  const k = KEY_LAYOUT.find(x => x[0] === code); if (!k) return '';
  const ch = k[1];
  return ch === ';' ? 'Semicolon' : ch === ',' ? 'Comma' : ch === '.' ? 'Period' : ch === '/' ? 'Slash' : ch;
};
if (NATIVE && NATIVE.onGlobalTrigger) {
  NATIVE.onGlobalTrigger(i => {
    if (i === -1) { panic(); return; }
    const p = PADS[i]; if (p && p.buffer) p.trigger();
  });
}
addEventListener('keyup', e => { const i = keyMap.get(e.code); if (i != null) PADS[i].release(); });

function panic() {
  PADS.forEach(p => p.stopAll(60));
  DECKS.forEach(d => d.stop());
  stopCue();
  WEB.fadeTok++;
  if (WEB.kind === 'yt' && WEB.ready) { try { WEB.player.pauseVideo(); } catch {} }
  toast('全停止しました');
}

/* ---------------------------------------------------------
   パッド設定ダイアログ
   --------------------------------------------------------- */
let padDlgIdx = -1, capturingKey = false;
function openPadDlg(i) {
  padDlgIdx = i; const p = PADS[i];
  $('#padIdx').textContent = 'PAD ' + (i + 1);
  $('#padName').value = p.name;
  $('#padKey').textContent = p.keyLabel || '（なし）';
  $('#padVol').value = p.vol;   $('#padVolV').textContent = Math.round(p.vol * 100) + '%';
  $('#padFade').value = p.fade; $('#padFadeV').textContent = p.fade + ' ms';
  $('#padRate').value = p.rate; $('#padRateV').textContent = p.rate.toFixed(2) + '倍';
  $('#padLoop').checked = p.loop;
  $('#padFile').textContent = p.src ? (p.src.path || p.src.name) : '（未設定）';
  $$('#padModeSeg .btn').forEach(b => b.classList.toggle('on', b.dataset.mode === p.mode));
  $('#padModeHint').textContent = MODE_HINT[p.mode];
  const sw = $('#padColors'); sw.replaceChildren();
  PAD_COLORS.forEach(c => {
    const d = document.createElement('div');
    d.className = 'sw' + (c === p.color ? ' sel' : ''); d.style.background = c;
    d.onclick = () => { p.color = c; p.render(); $$('.sw', sw).forEach(x => x.classList.remove('sel')); d.classList.add('sel'); saveState(); };
    sw.appendChild(d);
  });
  $('#padMask').classList.add('show');
}
function closePadDlg() { $('#padMask').classList.remove('show'); capturingKey = false; saveState(); }
async function pickForPad(i) {
  const files = await pickFiles(true);
  for (let k = 0; k < files.length; k++) { const p = PADS[i + k]; if (p) await p.assign(files[k]); }
  if (files.length) saveState();
}

/* ---------------------------------------------------------
   保存 / 復元
   --------------------------------------------------------- */
let saveT = 0, lastSaved = 0;
/* セット読込中は自動保存を止める。
   読み込んだ直後に reload すると beforeunload の保存が走り、
   まだ古いままのメモリ上の状態で上書きしてしまうため。 */
let saveSuspended = false;
function stateSnapshot() {
  return {
    theme:S.theme, ui:S.ui, sinks:S.sinks, duck:S.duck, fade:S.fade, vol:S.vol, mute:S.mute, eq:S.eq,
    limiter:S.limiter, wake:S.wake, confirmExit:S.confirmExit, autoAdv:S.autoAdv, autoMix:S.autoMix,
    cols:S.cols, padRows:S.padRows, padRowsAuto:S.padRowsAuto, padPage:S.padPage,
    padCount:PADS.length, deckCount:DECKS.length,
    webVol:S.webVol, webOpen:S.webOpen, webHistory:S.webHistory,
    normalize:S.normalize, normTarget:S.normTarget, locked:S.locked,
    ghk:S.ghk, ghkMod:S.ghkMod, tracks:S.tracks,
    cues:S.cues, cueIdx:S.cueIdx, plTab:S.plTab,
    pads:PADS.map(p => p.conf()),
    playlist:PL.map(it => ({ name:it.name, path:it.path, fsPath:it.fsPath })),
  };
}
/* 自動保存。操作のたびに呼ばれるので 400ms まとめてから書き込む */
function saveState() {
  if (saveSuspended) return;
  clearTimeout(saveT);
  saveT = setTimeout(async () => {
    if (saveSuspended) return;
    try { await STORE.setState(stateSnapshot()); lastSaved = Date.now(); markSaved(); }
    catch { markSaved('保存に失敗しました'); }
  }, 400);
}
/* 終了時など、待たずに今すぐ書き込む */
async function saveStateNow() {
  if (saveSuspended) return;
  clearTimeout(saveT);
  try { await STORE.setState(stateSnapshot()); lastSaved = Date.now(); markSaved(); } catch {}
}
function markSaved(err) {
  const el = $('#stSave'); if (!el) return;
  if (err) { el.textContent = err; el.classList.add('warn'); return; }
  const d = new Date(lastSaved);
  el.textContent = '保存済 ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
  el.classList.remove('warn');
}
async function restoreState() {
  const d = await STORE.getState();
  if (!d) return null;
  S.ui = d.ui === 'touch' ? 'touch' : 'mouse';
  S.theme = d.theme === 'dark' ? 'dark' : 'light';
  Object.assign(S.sinks, d.sinks || {}); Object.assign(S.duck, d.duck || {});
  Object.assign(S.fade, d.fade || {});   Object.assign(S.vol, d.vol || {});
  Object.assign(S.mute, d.mute || {});
  if (d.eq) { Object.assign(S.eq.bgm, d.eq.bgm || {}); Object.assign(S.eq.sfx, d.eq.sfx || {}); }
  S.limiter = d.limiter !== false; S.wake = d.wake !== false;
  S.confirmExit = d.confirmExit !== false; S.autoAdv = d.autoAdv !== false;
  S.autoMix = !!d.autoMix;
  S.cols = clamp(d.cols || 5, 2, 9);
  S.padRows = clamp(d.padRows || 4, 1, 8);
  S.padRowsAuto = d.padRowsAuto !== false;
  S.padPage = Math.max(0, d.padPage | 0);
  S.deckCount = clamp(d.deckCount || 2, 1, MAX_DECKS);
  S.padCount = clamp(d.padCount || 20, 1, MAX_PADS);
  S.webVol = clamp(d.webVol != null ? +d.webVol : 1, 0, 1);
  S.webOpen = !!d.webOpen;
  S.webHistory = Array.isArray(d.webHistory) ? d.webHistory.slice(0, 12) : [];
  S.normalize = d.normalize !== false;
  S.normTarget = clamp(d.normTarget != null ? +d.normTarget : -16, -30, -6);
  S.locked = !!d.locked;
  S.ghk = !!d.ghk;
  S.ghkMod = ['Control+Shift','Control+Alt','Alt+Shift'].includes(d.ghkMod) ? d.ghkMod : 'Control+Shift';
  S.tracks = (d.tracks && typeof d.tracks === 'object') ? d.tracks : {};
  S.cues = Array.isArray(d.cues) ? d.cues : [];
  S.cueIdx = Number.isInteger(d.cueIdx) ? clamp(d.cueIdx, -1, S.cues.length - 1) : -1;
  S.plTab = d.plTab === 'cue' ? 'cue' : 'list';
  return d;
}
/* ---------------------------------------------------------
   曲ごとの設定（イン点 / アウト点 / 音量オートメーション）
   --------------------------------------------------------- */
let trkItem = null;
const secToStr = s => fmt(s || 0);
function strToSec(v) {
  const m = String(v).trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  return m ? (+(m[1] || 0)) * 60 + (+m[2]) : NaN;
}
/* その曲が今どのデッキに載っているか（あれば現在位置を取れる） */
const deckOfTrack = it => DECKS.find(d => d.meta && trackKey(d.meta) === trackKey(it));

function openTrackDlg(it) {
  trkItem = it;
  const c = trackConf(it, true);
  $('#trkName').textContent = it.name;
  $('#trkIn').value = secToStr(c.in);
  $('#trkOut').value = c.out > 0 ? secToStr(c.out) : '';
  $('#trkRms').textContent = c.rms != null
    ? (20 * Math.log10(c.rms)).toFixed(1) + ' dB（自動そろえ ' + (S.normalize ? '有効' : '無効') + '）'
    : '未解析（デッキに読み込むと解析されます）';
  renderAutoList();
  $('#trkMask').classList.add('show');
}
function renderAutoList() {
  const c = trackConf(trkItem, true), box = $('#trkAuto');
  box.replaceChildren();
  const pts = c.auto.sort((a, b) => a.at - b.at);
  if (!pts.length) {
    box.innerHTML = '<div class="hint">まだありません。曲を再生しながら「今の位置に追加」を押すと、その時点からの音量変化を作れます。</div>';
    return;
  }
  pts.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'auto-row';
    row.innerHTML =
      '<input class="inp t" value="' + secToStr(p.at) + '" title="開始時刻">' +
      '<span class="lbl">から</span>' +
      '<input class="inp o" type="number" min="0" max="60" step="0.5" value="' + p.over + '" title="かける秒数">' +
      '<span class="lbl">秒かけて</span>' +
      '<input class="inp v" type="range" min="0" max="1.3" step="0.01" value="' + p.to + '">' +
      '<span class="val num">' + Math.round(p.to * 100) + '%</span>' +
      '<button class="btn sm q x">削除</button>';
    const redraw = () => { DECKS.forEach(d => d.drawWave()); saveState(); };
    $('.t', row).onchange = e => { const v = strToSec(e.target.value); if (isFinite(v)) { p.at = v; renderAutoList(); redraw(); } };
    $('.o', row).oninput = e => { p.over = Math.max(0, +e.target.value); redraw(); };
    $('.v', row).oninput = e => { p.to = +e.target.value; $('.val', row).textContent = Math.round(p.to * 100) + '%'; redraw(); };
    $('.x', row).onclick = () => { c.auto.splice(c.auto.indexOf(p), 1); renderAutoList(); redraw(); };
    box.appendChild(row);
  });
}
function bindTrackDlg() {
  $('#trkOk').onclick = () => { $('#trkMask').classList.remove('show'); saveState(); };
  $('#trkMask').onclick = e => { if (e.target.id === 'trkMask') { e.target.classList.remove('show'); saveState(); } };
  const apply = () => { DECKS.forEach(d => { d.drawWave(); d.applyNorm(); }); saveState(); };
  $('#trkIn').onchange = e => {
    const v = strToSec(e.target.value); const c = trackConf(trkItem, true);
    c.in = isFinite(v) ? Math.max(0, v) : 0; e.target.value = secToStr(c.in); apply();
  };
  $('#trkOut').onchange = e => {
    const c = trackConf(trkItem, true);
    if (!e.target.value.trim()) { c.out = 0; apply(); return; }
    const v = strToSec(e.target.value);
    c.out = isFinite(v) ? Math.max(0, v) : 0; e.target.value = c.out ? secToStr(c.out) : ''; apply();
  };
  $('#trkInNow').onclick = () => {
    const d = deckOfTrack(trkItem); if (!d) { toast('この曲をデッキに読み込むと現在位置を取得できます', true); return; }
    const c = trackConf(trkItem, true); c.in = d.audio.currentTime; $('#trkIn').value = secToStr(c.in); apply();
  };
  $('#trkOutNow').onclick = () => {
    const d = deckOfTrack(trkItem); if (!d) { toast('この曲をデッキに読み込むと現在位置を取得できます', true); return; }
    const c = trackConf(trkItem, true); c.out = d.audio.currentTime; $('#trkOut').value = secToStr(c.out); apply();
  };
  $('#trkAutoAdd').onclick = () => {
    const d = deckOfTrack(trkItem);
    const c = trackConf(trkItem, true);
    const at = d ? d.audio.currentTime : (c.auto.length ? c.auto[c.auto.length - 1].at + 10 : 0);
    c.auto.push({ at, to: 0.4, over: 3 });
    renderAutoList(); apply();
  };
  $('#trkReset').onclick = () => {
    const c = trackConf(trkItem, true);
    c.in = 0; c.out = 0; c.auto = [];
    $('#trkIn').value = '0:00'; $('#trkOut').value = '';
    renderAutoList(); apply();
    toast('この曲の設定を初期化しました');
  };
}

/* ---------------------------------------------------------
   手動保存 / 読込（.ampset）
   設定・パッドの割当・効果音の音源そのものを 1 ファイルにまとめる。
   USB で別の PC へ持っていく、本番前の状態をバックアップする、といった用途。
   --------------------------------------------------------- */
const b64enc = buf => {
  const b = new Uint8Array(buf); let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
};
const b64dec = str => {
  const bin = atob(str), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

async function exportSet() {
  try {
    toast('セットを書き出しています…');
    const pads = [];
    for (let i = 0; i < PADS.length; i++) {
      if (!PADS[i].buffer) continue;
      const f = await STORE.getPad(i);
      if (!f) continue;
      pads.push({ i, name: f.name || ('pad-' + i), type: f.type || '', data: b64enc(await f.arrayBuffer()) });
    }
    const bundle = { amp:'ampset', v:1, savedAt:new Date().toISOString(), state:stateSnapshot(), pads };
    const bytes = new TextEncoder().encode(JSON.stringify(bundle));
    const name = 'AMP-セット-' + new Date().toISOString().slice(0, 10) + '.ampset';

    if (NATIVE && NATIVE.saveFile) {
      const p = await NATIVE.saveFile(name, bytes);
      toast(p ? '保存しました: ' + p : '保存をやめました');
      return;
    }
    if (window.showSaveFilePicker) {
      const h = await showSaveFilePicker({ suggestedName:name,
        types:[{ description:'AeroMusic セット', accept:{ 'application/json':['.ampset'] } }] });
      const w = await h.createWritable(); await w.write(bytes); await w.close();
      toast('保存しました: ' + h.name);
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type:'application/json' }));
    a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast('保存しました: ' + name);
  } catch (e) {
    if (e.name !== 'AbortError') toast('書き出しに失敗しました: ' + e.message, true);
  }
}

async function importSet() {
  try {
    let bytes = null, label = '';
    if (NATIVE && NATIVE.openFile) {
      const r = await NATIVE.openFile();
      if (!r) return;
      bytes = new Uint8Array(r.bytes); label = r.name;
    } else if (window.showOpenFilePicker) {
      const [h] = await showOpenFilePicker({ types:[{ description:'AeroMusic セット', accept:{ 'application/json':['.ampset'] } }] });
      const f = await h.getFile(); bytes = new Uint8Array(await f.arrayBuffer()); label = f.name;
    } else {
      const f = await new Promise(res => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.ampset,application/json';
        inp.onchange = () => res(inp.files[0]); inp.oncancel = () => res(null);
        inp.click();
      });
      if (!f) return;
      bytes = new Uint8Array(await f.arrayBuffer()); label = f.name;
    }
    const bundle = JSON.parse(new TextDecoder().decode(bytes));
    if (!bundle || bundle.amp !== 'ampset' || !bundle.state) { toast('AMP のセットファイルではありません', true); return; }
    if (!confirm('「' + label + '」を読み込みます。\n現在の設定と効果音は置き換わります。よろしいですか？')) return;

    panic();
    // ここから reload までの間に自動保存が走ると、読み込んだ内容を
    // 古いメモリ上の状態で上書きしてしまうので完全に止める
    saveSuspended = true;
    clearTimeout(saveT);
    toast('セットを読み込んでいます…');
    await STORE.setState(bundle.state);
    for (let i = 0; i < MAX_PADS; i++) await STORE.delPad(i);
    for (const p of bundle.pads || []) {
      await STORE.setPad(p.i, new File([b64dec(p.data)], p.name, { type:p.type || 'audio/*' }));
    }
    await new Promise(r => setTimeout(r, 200));
    location.reload();
  } catch (e) {
    saveSuspended = false;
    if (e.name !== 'AbortError') toast('読込に失敗しました: ' + e.message, true);
  }
}

async function reconnectLibrary(interactive) {
  const h = await DB.get('root').catch(() => null);
  if (!h) return false;
  let perm = await h.queryPermission({ mode:'read' });
  if (perm !== 'granted') {
    if (!interactive) return 'prompt';
    perm = await h.requestPermission({ mode:'read' });
    if (perm !== 'granted') return false;
  }
  ROOT = h; LIB.clear(); await scanDir(h);
  return true;
}
async function restorePads(saved) {
  if (!saved?.pads) return 0;
  let n = 0;
  for (let i = 0; i < PADS.length; i++) {
    const c = saved.pads[i]; if (!c) continue;
    PADS[i].applyConf(c);
    let src = null;
    if (c.path && LIB.has(c.path)) src = { path:c.path, handle:LIB.get(c.path), name:c.name || c.path.split('/').pop() };
    else { const b = await loadPadBlob(i); if (b) src = { path:c.path, file:b, name:c.name || ('SE ' + (i + 1)) }; }
    if (src && await PADS[i].assign(src, { persist:false })) { PADS[i].applyConf(c); n++; }
  }
  rebuildKeyMap();
  return n;
}
/* プレイリストの復元。
   ・フォルダから読み込んだ曲 … 再接続したフォルダのハンドルから
   ・ドラッグ＆ドロップした曲 … 覚えておいた実ファイルパスから読み直す
   実体は必要になった時点で読むので、曲数が多くても起動は遅くならない。 */
function relinkPlaylist(saved) {
  if (!saved) return 0;
  const pl = [];
  for (const it of saved.playlist || []) {
    if (it.path && LIB.has(it.path)) pl.push({ name:it.name, path:it.path, fsPath:it.fsPath, handle:LIB.get(it.path) });
    else if (it.fsPath && NATIVE && NATIVE.readFile) pl.push({ name:it.name, path:it.path, fsPath:it.fsPath });
  }
  if (!pl.length) return 0;
  PL = pl; renderPlaylist();
  PL.forEach((_, i) => durQ.push(i)); pumpDuration();
  return pl.length;
}

/* ---------------------------------------------------------
   UI 結線
   --------------------------------------------------------- */
const AMP = {};          // 初期化後に他所から呼びたい関数の置き場
let applyVol = () => {};
function bindUI() {
  applyVol = () => {
    BUS.bgm.setVolume(S.mute.bgm ? 0 : S.vol.bgm);
    BUS.sfx.setVolume(S.mute.sfx ? 0 : S.vol.sfx);
    BUS.cue.setVolume(S.vol.cue);
  };
  const vb = $('#volBgm'), vs = $('#volSfx'), vc = $('#volCue');
  vb.oninput = () => { S.vol.bgm = +vb.value; applyVol(); applyWebVol(60); saveState(); };
  vs.oninput = () => { S.vol.sfx = +vs.value; applyVol(); saveState(); };
  vc.oninput = () => { S.vol.cue = +vc.value; applyVol(); saveState(); };
  $('#muteBgm').onclick = e => { S.mute.bgm = !S.mute.bgm; e.target.classList.toggle('muted', S.mute.bgm); applyVol(); applyWebVol(60); saveState(); };
  $('#muteSfx').onclick = e => { S.mute.sfx = !S.mute.sfx; e.target.classList.toggle('muted', S.mute.sfx); applyVol(); saveState(); };
  $('#cueStop').onclick = stopCue;

  $('#btnPanic').onclick = panic;
  $('#btnDuck').onclick = e => { S.duck.on = !S.duck.on; e.target.classList.toggle('on', S.duck.on); duckState = !duckState; updateDuck(); saveState(); };
  $('#btnTheme').onclick = () => { S.theme = S.theme === 'light' ? 'dark' : 'light'; applyTheme(); saveState(); };
  $('#btnUi').onclick = () => {
    S.ui = S.ui === 'touch' ? 'mouse' : 'touch';
    applyUiMode(); saveState();
    toast(S.ui === 'touch' ? 'タッチ最適化UIに切り替えました' : 'マウス用UIに切り替えました');
  };
  $('#setExport').onclick = exportSet;
  $('#setImport').onclick = importSet;
  $('#setSaveNow').onclick = async () => { await saveStateNow(); toast('現在の状態を保存しました'); };
  const rev = $('#setReveal');
  if (NSTORE) rev.onclick = () => NSTORE.reveal(); else rev.style.display = 'none';
  $('#btnMixer').onclick = () => $('#mixMask').classList.add('show');
  $('#mixClose').onclick = () => $('#mixMask').classList.remove('show');
  $('#mixReset').onclick = () => { S.eq.bgm = EQ_DEFAULT(); S.eq.sfx = EQ_DEFAULT(); buildMixer(); applyAllEq(); saveState(); toast('ミキサーを初期値に戻しました'); };
  $('#btnSetup').onclick = async () => { $('#setupMask').classList.add('show'); await refreshDevices(); };
  $('#setupClose').onclick = () => $('#setupMask').classList.remove('show');
  for (const id of ['setupMask','mixMask']) $('#' + id).onclick = e => { if (e.target.id === id) e.target.classList.remove('show'); };

  $('#btnUnlockDev').onclick = unlockDeviceLabels;
  $('#devRefresh').onclick = refreshDevices;
  for (const [k, id] of [['bgm','#devBgm'],['sfx','#devSfx'],['cue','#devCue']])
    $(id).onchange = async e => { S.sinks[k] = e.target.value; await applySinks(); };
  navigator.mediaDevices?.addEventListener('devicechange', async () => {
    await refreshDevices(); await applySinks();
    toast('オーディオデバイスの変更を検出し、出力先を貼り直しました');
  });

  const range = (id, vid, get, set, f) => {
    const el = $(id), lab = $(vid);
    el.value = get(); lab.textContent = f(get());
    el.oninput = () => { set(+el.value); lab.textContent = f(+el.value); saveState(); };
  };
  range('#duckAmt','#duckAmtV', () => S.duck.amount, v => { S.duck.amount = v; duckState = !duckState; updateDuck(); }, v => '-' + v + ' dB');
  range('#duckRel','#duckRelV', () => S.duck.release, v => S.duck.release = v, v => v + ' ms');
  range('#fadeIn', '#fadeInV',  () => S.fade.in,  v => S.fade.in = v,  v => v.toFixed(1) + ' 秒');
  range('#fadeOut','#fadeOutV', () => S.fade.out, v => S.fade.out = v, v => v.toFixed(1) + ' 秒');
  range('#xfTime', '#xfTimeV',  () => S.fade.xf,  v => S.fade.xf = v,  v => v.toFixed(1) + ' 秒');

  const chk = (id, get, set) => { const e = $(id); e.checked = get(); e.onchange = () => { set(e.checked); saveState(); }; };
  range('#normTarget','#normTargetV', () => S.normTarget, v => { S.normTarget = v; DECKS.forEach(d => d.applyNorm()); }, v => v + ' dB');
  chk('#optNorm', () => S.normalize, v => { S.normalize = v; DECKS.forEach(d => d.applyNorm()); });
  chk('#optGhk', () => S.ghk, v => { S.ghk = v; syncGlobalKeys(); });
  $('#ghkMod').value = S.ghkMod;
  $('#ghkMod').onchange = e => { S.ghkMod = e.target.value; syncGlobalKeys(); saveState(); };
  if (!NATIVE || !NATIVE.setGlobalKeys) {
    $('#optGhk').disabled = true; $('#ghkMod').disabled = true;
    $('#optGhk').parentElement.style.opacity = '.5';
  }
  chk('#optLimiter', () => S.limiter, v => { S.limiter = v; ALL_BUSES.forEach(b => b.applyLimiter()); });
  chk('#optWake', () => S.wake, v => { S.wake = v; updateWakeLock(); });
  chk('#optConfirmExit', () => S.confirmExit, v => S.confirmExit = v);
  chk('#optAutoAdv', () => S.autoAdv, v => S.autoAdv = v);

  $('#deckPlus').onclick  = () => { buildDecks(DECKS.length + 1); renderPlaylist(); saveState(); };
  $('#deckMinus').onclick = () => { buildDecks(DECKS.length - 1); renderPlaylist(); saveState(); };
  $('#btnAutoMix').onclick = e => { S.autoMix = !S.autoMix; e.target.classList.toggle('on', S.autoMix); saveState(); };

  /* タブ（プレイリスト / 進行表） */
  const setTab = t => {
    S.plTab = t;
    $('#tabList').classList.toggle('on', t === 'list');
    $('#tabCue').classList.toggle('on', t === 'cue');
    $('#playlist').style.display = t === 'list' ? '' : 'none';
    $('#cuePanel').style.display = t === 'cue' ? '' : 'none';
    $('#plCount').style.display = t === 'list' ? '' : 'none';
    $('#cueCount').style.display = t === 'cue' ? '' : 'none';
    $$('.pl-only').forEach(e => e.style.display = t === 'list' ? 'contents' : 'none');
    $$('.cue-only').forEach(e => e.style.display = t === 'cue' ? 'contents' : 'none');
    saveState();
  };
  $('#tabList').onclick = () => setTab('list');
  $('#tabCue').onclick  = () => setTab('cue');
  AMP.setTab = setTab;

  $('#plSearch').oninput = e => { plFilter = e.target.value; renderPlaylist(); };

  /* 進行表 */
  $('#cueGo').onclick = cueGo;
  $('#cueAddPlay').onclick = () => { addCue('play', { fade:S.fade.in }); openCueDlg(S.cues.length - 1); };
  $('#cueAddSfx').onclick  = () => { addCue('sfx', { pad:0 }); openCueDlg(S.cues.length - 1); };
  $('#cueAddFade').onclick = () => { addCue('fade', { fade:S.fade.out }); openCueDlg(S.cues.length - 1); };
  $('#cueAddNote').onclick = () => { addCue('note'); openCueDlg(S.cues.length - 1); };
  $('#cueReset').onclick = () => { S.cueIdx = -1; renderCues(); saveState(); toast('進行表を最初に戻しました'); };
  $('#cueClear').onclick = () => { if (confirm('進行表をすべて消します。よろしいですか？')) { S.cues = []; S.cueIdx = -1; renderCues(); saveState(); } };
  $('#cueKind').onchange = syncCueDlg;
  $('#cueFade').oninput = e => $('#cueFadeV').textContent = (+e.target.value).toFixed(1) + ' 秒';
  $('#cueOk').onclick = () => {
    const c = S.cues[cueIdxEdit]; if (!c) { $('#cueMask').classList.remove('show'); return; }
    c.kind = $('#cueKind').value;
    c.label = $('#cueLabel').value.trim();
    c.trackKey = $('#cueTrack').value;
    const it = PL.find(x => trackKey(x) === c.trackKey);
    c.track = it ? it.name : '';
    c.deck = $('#cueDeck').value;
    c.pad = +$('#cuePad').value;
    c.fade = +$('#cueFade').value;
    $('#cueMask').classList.remove('show');
    renderCues(); saveState();
  };
  $('#cueMask').onclick = e => { if (e.target.id === 'cueMask') e.target.classList.remove('show'); };
  bindTrackDlg();

  /* ロック / セルフチェック */
  $('#btnLock').onclick = () => {
    S.locked = !S.locked; applyLock(); saveState();
    toast(S.locked ? 'ロックしました（効果音と全停止は使えます）' : 'ロックを解除しました');
  };
  $('#checkFix').onclick = async () => { $('#setupMask').classList.add('show'); await refreshDevices(); };

  $('#plAdd').onclick    = async () => { const f = await pickFiles(true); if (f.length) addToPlaylist(f); };
  $('#plFolder').onclick = async () => { const f = await pickFolder(); if (f) { PL = []; addToPlaylist(f); } };
  $('#plShuffle').onclick = () => { for (let i = PL.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [PL[i], PL[j]] = [PL[j], PL[i]]; } plCursor = -1; renderPlaylist(); saveState(); };
  $('#plClear').onclick  = () => { PL = []; plCursor = -1; renderPlaylist(); saveState(); };

  $('#padCols').oninput = e => { S.cols = +e.target.value; layoutPads(); saveState(); };
  $('#padRows').oninput = e => { S.padRowsAuto = false; S.padRows = +e.target.value; layoutPads(); saveState(); };
  $('#padRowsAuto').onclick = () => {
    S.padRowsAuto = !S.padRowsAuto;
    $('#padRowsAuto').classList.toggle('on', S.padRowsAuto);
    layoutPads(); saveState();
    toast(S.padRowsAuto ? '段数を画面の高さから自動で決めます' : '段数を手動で指定します');
  };
  $('#padPrev').onclick = () => { S.padPage--; layoutPads(); saveState(); };
  $('#padNext').onclick = () => { S.padPage++; layoutPads(); saveState(); };
  $('#padPlus').onclick  = () => { buildPads(PADS.length + S.cols); saveState(); };
  $('#padMinus').onclick = () => { buildPads(PADS.length - S.cols); saveState(); };
  $('#sfxStopAll').onclick = () => { PADS.forEach(p => p.stopAll(80)); toast('効果音を停止しました'); };
  $('#btnPopout').onclick = openPopout;
  $('#sfxFolder').onclick = async () => {
    const f = await pickFolder(); if (!f) return;
    if (f.length > PADS.length) buildPads(Math.min(Math.ceil(f.length / S.cols) * S.cols, MAX_PADS));
    const n = Math.min(f.length, PADS.length);
    for (let i = 0; i < n; i++) await PADS[i].assign(f[i]);
    rebuildKeyMap(); saveState();
    toast(n + ' 個の効果音をパッドに割り当てました');
  };

  $('#padOk').onclick = closePadDlg;
  $('#padMask').onclick = e => { if (e.target.id === 'padMask') closePadDlg(); };
  const pd = () => PADS[padDlgIdx];
  $('#padName').oninput = e => { pd().name = e.target.value; pd().render(); };
  $('#padVol').oninput  = e => { pd().vol = +e.target.value; $('#padVolV').textContent = Math.round(pd().vol * 100) + '%'; };
  $('#padFade').oninput = e => { pd().fade = +e.target.value; $('#padFadeV').textContent = pd().fade + ' ms'; };
  $('#padRate').oninput = e => { pd().rate = +e.target.value; $('#padRateV').textContent = pd().rate.toFixed(2) + '倍'; };
  $('#padLoop').onchange = e => { pd().loop = e.target.checked; pd().render(); };
  $('#padClear').onclick = () => { pd().clear(); closePadDlg(); };
  $('#padPreview').onclick = () => {
    const p = pd(); if (!p.buffer) return;
    resumeAll();
    const c = BUS.cue.ctx, s = c.createBufferSource(), g = c.createGain();
    s.buffer = p.buffer; s.playbackRate.value = p.rate; g.gain.value = p.vol;
    s.connect(g).connect(BUS.cue.input); s.start();
  };
  $$('#padModeSeg .btn').forEach(b => b.onclick = () => {
    pd().mode = b.dataset.mode;
    $$('#padModeSeg .btn').forEach(x => x.classList.toggle('on', x === b));
    $('#padModeHint').textContent = MODE_HINT[pd().mode];
    pd().render();
  });
  $('#padKey').onclick = () => {
    capturingKey = true;
    $('#padKey').textContent = 'キーを押してください…';
    const h = e => {
      e.preventDefault(); e.stopPropagation();
      removeEventListener('keydown', h, true);
      capturingKey = false;
      const p = pd();
      if (e.code === 'Escape') p.key = null;
      else if (KEY_LAYOUT.some(k => k[0] === e.code)) {
        PADS.forEach(o => { if (o !== p && o.key === e.code) { o.key = null; o.render(); } });
        p.key = e.code;
      } else toast('そのキーは使えません（英数字・記号キーのみ）', true);
      $('#padKey').textContent = p.keyLabel || '（なし）';
      p.render(); rebuildKeyMap(); saveState();
    };
    addEventListener('keydown', h, true);
  };

  let dragN = 0;
  addEventListener('dragenter', e => { e.preventDefault(); if (++dragN === 1) $('#drop').classList.add('show'); });
  addEventListener('dragleave', () => { if (--dragN <= 0) { dragN = 0; $('#drop').classList.remove('show'); } });
  addEventListener('dragover', e => e.preventDefault());
  addEventListener('drop', async e => {
    e.preventDefault(); dragN = 0; $('#drop').classList.remove('show');
    if (e.target.closest('.pad') || e.target.closest('.deck')) return;
    const files = await filesFromDataTransfer(e.dataTransfer);
    if (!files.length) { toast('対応する音声ファイルがありません', true); return; }
    addToPlaylist(files);
    toast(files.length + ' 曲をプレイリストに追加しました');
  });

  const kick = () => { resumeAll(); updateLatency(); };
  addEventListener('pointerdown', kick, { once:true });
  addEventListener('keydown', kick, { once:true });

  addEventListener('beforeunload', e => {
    if (CH) CH.postMessage({ t:'close' });
    saveStateNow();      // 閉じる直前の状態を取りこぼさない
    if (S.confirmExit && (DECKS.some(d => d.playing) || voiceCount() > 0 || webPlaying())) { e.preventDefault(); e.returnValue = ''; }
  });
  // タブ/ウィンドウが隠れた時にも保存（強制終了・電源断への保険）
  addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveStateNow(); });
  addEventListener('resize', () => { layoutPads(); DECKS.forEach(d => d.drawWave()); });
}

let wakeLock = null;
async function updateWakeLock() {
  try {
    if (S.wake && !wakeLock && navigator.wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!S.wake && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') updateWakeLock(); });

function updateLatency() {
  const c = BUS.sfx.ctx;
  const lat = (c.outputLatency || c.baseLatency || 0) * 1000;
  $('#stLat').textContent = lat ? lat.toFixed(1) + ' ms' : '-';
  $('#stSr').textContent = (c.sampleRate / 1000).toFixed(1) + ' kHz';
}

/* ---------------------------------------------------------
   アップデート（.exe / Electron 版のみ。window.ampNative は
   electron/preload.js が公開する橋渡し。素の Chrome 版では存在しないため
   その場合は GitHub へのリンクを出すだけにフォールバックする）
   --------------------------------------------------------- */
function bindUpdater() {
  const tag = $('#appVerTag'), status = $('#updateStatus'), btn = $('#btnCheckUpdate');
  let restartBtn = null;

  if (!window.ampNative) {
    tag.textContent = 'Web版';
    status.innerHTML = 'このWeb版（AMP.bat）に自動更新はありません。最新版は '
      + '<a href="https://github.com/Orahu01/AeroMusicPlayer" target="_blank" rel="noopener">GitHub のリポジトリ</a> から取得してください。';
    btn.style.display = 'none';
    return;
  }

  window.ampNative.appVersion().then(v => tag.textContent = 'v' + v);
  status.textContent = '起動時に自動で確認しています。';
  btn.onclick = () => { status.textContent = '確認中…'; window.ampNative.checkForUpdate(); };

  window.ampNative.onUpdateStatus(s => {
    if (restartBtn) { restartBtn.remove(); restartBtn = null; }
    switch (s.status) {
      case 'checking':       status.textContent = '確認中…'; break;
      case 'available':      status.textContent = '新しいバージョン v' + s.version + ' が見つかりました。ダウンロード中…'; break;
      case 'downloading':    status.textContent = 'ダウンロード中… ' + s.percent + '%'; break;
      case 'not-available':  status.textContent = '最新の状態です（v' + s.version + '）'; break;
      case 'error':          status.textContent = '確認できませんでした: ' + s.message; break;
      case 'downloaded':
        status.textContent = '更新の準備ができました（v' + s.version + '）。都合の良いタイミングで反映してください。';
        restartBtn = document.createElement('button');
        restartBtn.className = 'btn sm on'; restartBtn.style.marginTop = '6px';
        restartBtn.textContent = '再起動して更新を適用';
        restartBtn.onclick = () => {
          const busy = DECKS.some(d => d.playing) || voiceCount() > 0;
          if (busy && !confirm('再生中です。今すぐ再起動して更新を適用しますか？')) return;
          window.ampNative.installUpdate();
        };
        status.after(restartBtn);
        toast('アップデートの準備ができました（設定 → 再起動して適用）');
        break;
    }
  });
}

/* ---------------------------------------------------------
   起動
   --------------------------------------------------------- */
(async function init() {
  const saved = await restoreState();
  applyTheme();
  applyUiMode();
  buildDecks(S.deckCount);
  buildPads(S.padCount);
  bindUI();
  buildMixer();
  bindUpdater();
  bindWebUI();

  $('#volBgm').value = S.vol.bgm; $('#volSfx').value = S.vol.sfx; $('#volCue').value = S.vol.cue;
  $('#muteBgm').classList.toggle('muted', S.mute.bgm);
  $('#muteSfx').classList.toggle('muted', S.mute.sfx);
  $('#btnDuck').classList.toggle('on', S.duck.on);
  $('#btnAutoMix').classList.toggle('on', S.autoMix);
  $('#padCols').value = S.cols;
  $('#padRows').value = S.padRows;
  $('#padRowsAuto').classList.toggle('on', S.padRowsAuto);
  layoutPads();
  requestAnimationFrame(layoutPads);      // 実寸が確定してから段数を決め直す
  ALL_BUSES.forEach(b => b.applyLimiter());
  applyAllEq(); applyVol(); duckState = true; updateDuck();

  applyLock();
  renderPlaylist();
  renderCues();
  AMP.setTab(S.plTab);
  await refreshDevices();
  await applySinks();
  updateLatency(); updateMem(); updateWakeLock();

  const r = await reconnectLibrary(false);
  // フォルダを再接続できなくても、実ファイルパスを覚えている曲は戻せる
  const songs = relinkPlaylist(saved);
  const se = await restorePads(saved);
  if (se || songs) toast('前回の構成を復元しました（効果音 ' + se + '個 / 曲 ' + songs + '曲）');

  if (r === 'prompt') {
    setStatus('前回のフォルダを再接続するとプレイリストも戻ります →');
    const btn = document.createElement('button');
    btn.className = 'btn sm q'; btn.textContent = 'フォルダを再接続'; btn.style.marginLeft = '6px';
    btn.onclick = async () => {
      if (await reconnectLibrary(true) === true) { const n = relinkPlaylist(saved); btn.remove(); setStatus('準備完了（' + n + '曲を復元）'); }
    };
    $('#stMsg').after(btn);
  } else {
    setStatus(SINK_OK ? '準備完了 — 「設定」から出力先を選べます' : 'この環境では出力先を個別に指定できません');
  }
  selfCheck();
  syncGlobalKeys();
  loop();
})();
