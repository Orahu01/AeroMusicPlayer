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
  sinks:{ bgm:'', sfx:'', cue:'' },
  duck:{ on:false, amount:9, release:600 },
  fade:{ in:1.5, out:2.5, xf:4 },
  vol:{ bgm:1, sfx:1, cue:0.8 },
  mute:{ bgm:false, sfx:false },
  eq:{ bgm:EQ_DEFAULT(), sfx:EQ_DEFAULT() },
  limiter:true, wake:true, confirmExit:true, autoAdv:true, autoMix:false,
  cols:5, padCount:20, deckCount:2,
};

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

/* SE の音源そのものを保存しておき、次回起動時にそのまま復元する */
const PAD_BLOB_MAX = 60 << 20;
const padBlobKey = i => 'padblob:' + i;
const savePadBlob = (i, f) => { if (f && f.size <= PAD_BLOB_MAX) DB.set(padBlobKey(i), f).catch(() => {}); };
const loadPadBlob = i => DB.get(padBlobKey(i)).catch(() => null);

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
    this.fadeG = c.createGain();      // フェード / クロスフェード用
    this.volG  = c.createGain();      // ユーザー操作のフェーダー
    this.node.connect(this.fadeG).connect(this.volG).connect(this.bus.input);

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

  async load(src) {
    const file = src.file || (src.handle && await src.handle.getFile());
    if (!file) { toast('ファイルが見つかりません: ' + src.name, true); return false; }
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
      for (let i = 0; i < N; i++) {
        let m = 0; const s = i * step, e = Math.min(s + step, ch.length);
        for (let j = s; j < e; j += 3) { const a = Math.abs(ch[j]); if (a > m) m = a; }
        pk[i] = m;
      }
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
    const rem = d.audio.duration - d.audio.currentTime;
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
function buildPads(n) {
  n = clamp(n, 1, MAX_PADS);
  const grid = $('#padGrid');
  while (PADS.length < n) { const p = new Pad(PADS.length); PADS.push(p); grid.appendChild(p.el); }
  while (PADS.length > n) { const p = PADS.pop(); p.stopAll(0); p.el.remove(); }
  S.padCount = PADS.length;
  grid.style.setProperty('--cols', S.cols);
  $('#padMinus').disabled = PADS.length <= S.cols;
  $('#padPlus').disabled = PADS.length >= MAX_PADS;
  rebuildKeyMap(); padsDirty = true;
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
    inp.onchange = () => res([...inp.files].map(f => ({ file:f, name:f.name, path:null })));
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
  return out;
}

/* ---------------------------------------------------------
   プレイリスト
   --------------------------------------------------------- */
let PL = [], plCursor = -1;
const durQ = []; let durRunning = 0;

function addToPlaylist(items) {
  const from = PL.length;
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
        const f = it.file || (it.handle && await it.handle.getFile());
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
function renderPlaylist() {
  const box = $('#playlist');
  $('#plCount').textContent = PL.length + '曲';
  if (!PL.length) {
    box.innerHTML = '<div class="pl-empty">曲をここにドラッグ＆ドロップ<br>または「フォルダ」でまとめて読み込み</div>';
    return;
  }
  const loaded = new Set(DECKS.map(d => d.meta && d.meta.name).filter(Boolean));
  const frag = document.createDocumentFragment();
  PL.forEach((it, i) => {
    const d = document.createElement('div');
    d.className = 'pl-item' + (loaded.has(it.name) ? ' cur' : '');
    d.dataset.i = i;
    d.innerHTML = '<span class="pl-no num">' + (i + 1) + '</span><span class="pl-name"></span>' +
      '<span class="pl-acts">' + DECKS.map(dk => '<button class="btn sm q" data-a="' + dk.id + '">' + dk.id + '</button>').join('') +
      '<button class="btn sm q" data-a="cue" title="ヘッドホンで試聴">試聴</button>' +
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
      const dk = deckOf(a);
      if (dk && await dk.load(it)) { plCursor = i; selectDeck(a); }
    };
    frag.appendChild(d);
  });
  box.replaceChildren(frag);
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
    const f = it.file || await it.handle.getFile();
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
   ダッキング
   --------------------------------------------------------- */
let duckState = false;
function updateDuck() {
  const active = voiceCount() > 0;
  if (active === duckState) return;
  duckState = active;
  const g = BUS.bgm.duck.gain, t = BUS.bgm.ctx.currentTime;
  g.cancelScheduledValues(t);
  if (!S.duck.on) { g.setTargetAtTime(1, t, .01); return; }
  g.setTargetAtTime(active ? Math.pow(10, -S.duck.amount / 20) : 1,
                    t, active ? .02 : S.duck.release / 3000);
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
  return { t:'state', cols:S.cols, theme:S.theme,
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
    const a = d.audio, dur = a.duration || 0, cur = a.currentTime || 0;
    const p = dur ? cur / dur : 0;
    d.$fill.style.width = (p * 100) + '%';
    d.$head.style.left  = (p * 100) + '%';
    if (frame % 3 === 0) {
      d.$cur.textContent = fmt(cur); d.$dur.textContent = fmt(dur);
      const rem = Math.max(0, dur - cur);
      d.$rem.textContent = ' -' + fmt(rem);
      d.$rem.classList.toggle('hot', d.playing && dur > 0 && rem <= 15);
    }
  }
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
/* 最小化中は requestAnimationFrame が止まるため、曲つなぎだけはタイマーでも監視する */
setInterval(() => { checkAutoMix(); if (CH && popAlive && Date.now() - popAlive > 4000) popAlive = 0; }, 250);

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
  if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) curDeck().toggle(); return; }
  if (e.code === 'Tab')   { e.preventDefault(); if (!e.repeat) selectDeck(DECK_IDS[(selDeck + 1) % DECKS.length]); return; }
  const i = keyMap.get(e.code);
  if (i == null) return;
  e.preventDefault();
  if (!e.repeat && PADS[i].buffer) PADS[i].trigger();
});
addEventListener('keyup', e => { const i = keyMap.get(e.code); if (i != null) PADS[i].release(); });

function panic() {
  PADS.forEach(p => p.stopAll(60));
  DECKS.forEach(d => d.stop());
  stopCue();
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
let saveT = 0;
function saveState() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    DB.set('state', {
      theme:S.theme, sinks:S.sinks, duck:S.duck, fade:S.fade, vol:S.vol, mute:S.mute, eq:S.eq,
      limiter:S.limiter, wake:S.wake, confirmExit:S.confirmExit, autoAdv:S.autoAdv, autoMix:S.autoMix,
      cols:S.cols, padCount:PADS.length, deckCount:DECKS.length,
      pads:PADS.map(p => p.conf()),
      playlist:PL.map(it => ({ name:it.name, path:it.path })),
    }).catch(() => {});
  }, 400);
}
async function restoreState() {
  const d = await DB.get('state').catch(() => null);
  if (!d) return null;
  S.theme = d.theme === 'dark' ? 'dark' : 'light';
  Object.assign(S.sinks, d.sinks || {}); Object.assign(S.duck, d.duck || {});
  Object.assign(S.fade, d.fade || {});   Object.assign(S.vol, d.vol || {});
  Object.assign(S.mute, d.mute || {});
  if (d.eq) { Object.assign(S.eq.bgm, d.eq.bgm || {}); Object.assign(S.eq.sfx, d.eq.sfx || {}); }
  S.limiter = d.limiter !== false; S.wake = d.wake !== false;
  S.confirmExit = d.confirmExit !== false; S.autoAdv = d.autoAdv !== false;
  S.autoMix = !!d.autoMix; S.cols = d.cols || 5;
  S.deckCount = clamp(d.deckCount || 2, 1, MAX_DECKS);
  S.padCount = clamp(d.padCount || 20, 1, MAX_PADS);
  return d;
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
function relinkPlaylist(saved) {
  if (!saved) return 0;
  const pl = [];
  for (const it of saved.playlist || []) if (it.path && LIB.has(it.path)) pl.push({ name:it.name, path:it.path, handle:LIB.get(it.path) });
  if (!pl.length) return 0;
  PL = pl; renderPlaylist();
  PL.forEach((_, i) => durQ.push(i)); pumpDuration();
  return pl.length;
}

/* ---------------------------------------------------------
   UI 結線
   --------------------------------------------------------- */
let applyVol = () => {};
function bindUI() {
  applyVol = () => {
    BUS.bgm.setVolume(S.mute.bgm ? 0 : S.vol.bgm);
    BUS.sfx.setVolume(S.mute.sfx ? 0 : S.vol.sfx);
    BUS.cue.setVolume(S.vol.cue);
  };
  const vb = $('#volBgm'), vs = $('#volSfx'), vc = $('#volCue');
  vb.oninput = () => { S.vol.bgm = +vb.value; applyVol(); saveState(); };
  vs.oninput = () => { S.vol.sfx = +vs.value; applyVol(); saveState(); };
  vc.oninput = () => { S.vol.cue = +vc.value; applyVol(); saveState(); };
  $('#muteBgm').onclick = e => { S.mute.bgm = !S.mute.bgm; e.target.classList.toggle('muted', S.mute.bgm); applyVol(); saveState(); };
  $('#muteSfx').onclick = e => { S.mute.sfx = !S.mute.sfx; e.target.classList.toggle('muted', S.mute.sfx); applyVol(); saveState(); };
  $('#cueStop').onclick = stopCue;

  $('#btnPanic').onclick = panic;
  $('#btnDuck').onclick = e => { S.duck.on = !S.duck.on; e.target.classList.toggle('on', S.duck.on); duckState = !duckState; updateDuck(); saveState(); };
  $('#btnTheme').onclick = () => { S.theme = S.theme === 'light' ? 'dark' : 'light'; applyTheme(); saveState(); };
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
  chk('#optLimiter', () => S.limiter, v => { S.limiter = v; ALL_BUSES.forEach(b => b.applyLimiter()); });
  chk('#optWake', () => S.wake, v => { S.wake = v; updateWakeLock(); });
  chk('#optConfirmExit', () => S.confirmExit, v => S.confirmExit = v);
  chk('#optAutoAdv', () => S.autoAdv, v => S.autoAdv = v);

  $('#deckPlus').onclick  = () => { buildDecks(DECKS.length + 1); renderPlaylist(); saveState(); };
  $('#deckMinus').onclick = () => { buildDecks(DECKS.length - 1); renderPlaylist(); saveState(); };
  $('#btnAutoMix').onclick = e => { S.autoMix = !S.autoMix; e.target.classList.toggle('on', S.autoMix); saveState(); };

  $('#plAdd').onclick    = async () => { const f = await pickFiles(true); if (f.length) addToPlaylist(f); };
  $('#plFolder').onclick = async () => { const f = await pickFolder(); if (f) { PL = []; addToPlaylist(f); } };
  $('#plShuffle').onclick = () => { for (let i = PL.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [PL[i], PL[j]] = [PL[j], PL[i]]; } plCursor = -1; renderPlaylist(); saveState(); };
  $('#plClear').onclick  = () => { PL = []; plCursor = -1; renderPlaylist(); saveState(); };

  $('#padCols').oninput = e => { S.cols = +e.target.value; $('#padGrid').style.setProperty('--cols', S.cols); padsDirty = true; saveState(); };
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
    if (S.confirmExit && (DECKS.some(d => d.playing) || voiceCount() > 0)) { e.preventDefault(); e.returnValue = ''; }
  });
  addEventListener('resize', () => DECKS.forEach(d => d.drawWave()));
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
  buildDecks(S.deckCount);
  buildPads(S.padCount);
  bindUI();
  buildMixer();
  bindUpdater();

  $('#volBgm').value = S.vol.bgm; $('#volSfx').value = S.vol.sfx; $('#volCue').value = S.vol.cue;
  $('#muteBgm').classList.toggle('muted', S.mute.bgm);
  $('#muteSfx').classList.toggle('muted', S.mute.sfx);
  $('#btnDuck').classList.toggle('on', S.duck.on);
  $('#btnAutoMix').classList.toggle('on', S.autoMix);
  $('#padCols').value = S.cols;
  ALL_BUSES.forEach(b => b.applyLimiter());
  applyAllEq(); applyVol(); duckState = true; updateDuck();

  renderPlaylist();
  await refreshDevices();
  await applySinks();
  updateLatency(); updateMem(); updateWakeLock();

  const r = await reconnectLibrary(false);
  const songs = r === true ? relinkPlaylist(saved) : 0;
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
  loop();
})();
