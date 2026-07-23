// ============================================================
// VOID ARENA — Input, HUD, joystick, skill buttons, minimap, shop, SFX
// ============================================================

const Input = {
  keys: {},
  joy: { active: false, dx: 0, dy: 0 },
  attackHeld: false,
  mouse: { x: 0, y: 0 },
};

// ---------------- Sound (procedural WebAudio synth) ----------------
// Everything here is generated live from oscillators + noise — no audio files.
// A master compressor keeps stacked hits from clipping, and a shared noise
// buffer powers the percussive impacts (whooshes, slams, tower crumble).
const Sfx = {
  ctx: null, on: true, master: null, noiseBuf: null, ambient: null,
  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.on = false; return; }
      // master chain: bus gain → soft compressor → speakers
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.9;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -14; comp.knee.value = 26; comp.ratio.value = 3.2;
      comp.attack.value = 0.004; comp.release.value = 0.2;
      this.master.connect(comp); comp.connect(this.ctx.destination);
      // one second of white noise, reused by every percussive voice
      const sr = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, sr, sr);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  // one enveloped oscillator voice with optional pitch slide + lowpass
  voice(freq, dur, type, vol, opts = {}) {
    if (!this.on || !this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type || 'square';
    if (opts.detune) o.detune.value = opts.detune;
    o.frequency.setValueAtTime(freq, t);
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + opts.slide), t + dur);
    // short attack, exponential decay to silence
    const atk = opts.atk != null ? opts.atk : 0.006;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = o;
    if (opts.filter) {
      const f = this.ctx.createBiquadFilter();
      f.type = opts.filterType || 'lowpass';
      f.frequency.setValueAtTime(opts.filter, t);
      if (opts.filterTo) f.frequency.exponentialRampToValueAtTime(Math.max(60, opts.filterTo), t + dur);
      o.connect(f); node = f;
    }
    node.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  },
  // legacy shim: old call sites pass (freq, dur, type, vol, slide)
  tone(freq, dur, type, vol, slide) { this.voice(freq, dur, type, vol, slide ? { slide } : {}); },
  // filtered noise burst — the body of every impact/whoosh
  noise(dur, vol, filterFreq, filterType, slideTo) {
    if (!this.on || !this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource(); src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = filterType || 'lowpass';
    f.frequency.setValueAtTime(filterFreq, t);
    if (slideTo) f.frequency.exponentialRampToValueAtTime(Math.max(60, slideTo), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t); src.stop(t + dur + 0.02);
  },
  // a fat detuned pair for musical stabs (fuller than a single oscillator)
  chord(freqs, dur, type, vol, opts = {}) {
    for (const fr of freqs) { this.voice(fr, dur, type, vol, opts); this.voice(fr, dur, type, vol*0.6, {...opts, detune:(opts.detune||0)+8}); }
  },
  arp(freqs, dur, type, vol, step, opts = {}) {
    freqs.forEach((fr, i) => setTimeout(() => this.voice(fr, dur, type, vol, opts), i * step));
  },
  // low ambient battlefield drone that fades in on match start
  startAmbient() {
    if (!this.on || !this.ctx || this.ambient) return;
    const t = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.016, t + 4);
    const lp = this.ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 420;
    const lfo = this.ctx.createOscillator(); lfo.frequency.value = 0.07;
    const lfoG = this.ctx.createGain(); lfoG.gain.value = 90;
    lfo.connect(lfoG); lfoG.connect(lp.frequency);
    const voices = [];
    for (const [f, tp] of [[55,'sawtooth'],[82.5,'triangle'],[110,'sine']]) {
      const o = this.ctx.createOscillator(); o.type = tp; o.frequency.value = f;
      o.detune.value = (Math.random()*10-5);
      o.connect(lp); o.start(t); voices.push(o);
    }
    lp.connect(g); g.connect(this.master); lfo.start(t);
    this.ambient = { g, voices, lfo };
  },
  stopAmbient() {
    if (!this.ambient || !this.ctx) return;
    const t = this.ctx.currentTime;
    const a = this.ambient; this.ambient = null;
    a.g.gain.cancelScheduledValues(t);
    a.g.gain.setValueAtTime(a.g.gain.value, t);
    a.g.gain.exponentialRampToValueAtTime(0.0001, t + 1.2);
    a.voices.forEach(o => o.stop(t + 1.3)); a.lfo.stop(t + 1.3);
  },
  play(name) {
    if (!this.ctx) return;
    const V = this.voice.bind(this), N = this.noise.bind(this), C = this.chord.bind(this), A = this.arp.bind(this);
    switch (name) {
      // ---- combat ----
      case 'attack': N(0.05, 0.05, 1400, 'bandpass'); V(180, 0.05, 'square', 0.03); break;
      case 'bolt': V(680, 0.14, 'sawtooth', 0.06, { slide:-380, filter:2600, filterTo:500 }); N(0.06, 0.03, 3000, 'highpass'); break;
      case 'skill': V(440, 0.16, 'triangle', 0.07, { slide:240, filter:2400 }); V(660, 0.14, 'sine', 0.04, { slide:200 }); break;
      case 'dash': N(0.22, 0.06, 900, 'bandpass', 2600); V(300, 0.16, 'sine', 0.05, { slide:520 }); break;
      case 'slam': V(120, 0.28, 'square', 0.09, { slide:-70 }); N(0.3, 0.11, 500, 'lowpass', 90); break;
      case 'shield': V(500, 0.24, 'sine', 0.06, { slide:260 }); V(750, 0.22, 'triangle', 0.03, { slide:260 }); break;
      case 'ult': C([196,262,392], 0.4, 'sawtooth', 0.06, { slide:120, filter:2600 }); N(0.35, 0.07, 700, 'lowpass', 140); break;
      // ---- kills / streaks ----
      case 'kill': A([880,1175], 0.2, 'square', 0.07, 110); break;
      case 'multikill': A([660,880,1100], 0.18, 'square', 0.07, 90); break;
      case 'savage': A([523,659,880,1046,1318], 0.24, 'sawtooth', 0.07, 100, { filter:3200 }); break;
      case 'death': V(300, 0.5, 'sawtooth', 0.08, { slide:-210, filter:1600, filterTo:200 }); N(0.4, 0.05, 800, 'lowpass', 120); break;
      // ---- structures / objectives ----
      case 'tower': V(90, 0.6, 'square', 0.1, { slide:-46 }); N(0.7, 0.13, 900, 'lowpass', 70); break;
      case 'boss': C([70,105], 0.85, 'sawtooth', 0.09, { slide:26, filter:1400 }); N(0.8, 0.08, 300, 'lowpass'); break;
      // ---- economy / utility ----
      case 'level': A([523,784,1046], 0.16, 'triangle', 0.06, 90, { filter:3000 }); break;
      case 'buy': V(700, 0.09, 'sine', 0.06, { slide:340 }); V(1050, 0.08, 'sine', 0.03, { slide:300 }); break;
      case 'recall': V(400, 0.42, 'sine', 0.06, { slide:420 }); V(600, 0.4, 'triangle', 0.03, { slide:400 }); break;
      // ---- match end fanfares ----
      case 'victory': A([523,659,784,1046,1318], 0.32, 'square', 0.07, 150, { filter:3400 }); setTimeout(()=>C([523,659,784], 0.6, 'triangle', 0.06), 760); break;
      case 'defeat': A([440,392,330,262], 0.4, 'sawtooth', 0.06, 190, { filter:1600, filterTo:600 }); break;
    }
  },
};

// ---------------- UI ----------------
const UI = {
  canvas: null, ctx: null, mmCanvas: null, mmCtx: null,
  els: {},

  init() {
    this.canvas = document.getElementById('game');
    this.ctx = this.canvas.getContext('2d');
    this.mmCanvas = document.getElementById('minimap');
    this.mmCtx = this.mmCanvas.getContext('2d');
    const ids = ['select','hud','end','joyZone','joyBase','joyKnob','btnAttack','btnRecall','btnBuy',
      'announce','killfeed','topTimer','topBlue','topRed','goldVal','kdaVal','csVal',
      'hpFill','mpFill','xpFill','lvlBadge','portGlyph','itemsRow','shopPanel','shopGrid','shopGold',
      'btnShop','btnCloseShop','deathOverlay','deathTimer','scoreboard','btnScore','endTitle','btnRestart',
      'heroGrid','btnStart','selInfo','lowHp','endSub','endStats'];
    for (const id of ids) this.els[id] = document.getElementById(id);

    this.resize();
    window.addEventListener('resize', () => this.resize());

    // MLBB-order HUD: the shop opener lives under the minimap (top-left
    // column with quick-buy), and the scoreboard opens by tapping the
    // top-centre score bar — so the ☰ button is retired from the arc.
    this.els.hud.appendChild(this.els.btnShop);
    this.els.btnScore.style.display = 'none';
    const topbar = document.getElementById('topbar');
    if (topbar) topbar.addEventListener('click', () => this.els.btnScore.click());
    // numeric readouts over the HP/MP bars
    for (const [fill, id] of [[this.els.hpFill, 'hpNum'], [this.els.mpFill, 'mpNum']]) {
      const n = document.createElement('span');
      n.className = 'barNum'; n.id = id;
      fill.parentNode.appendChild(n);
    }

    this.buildHeroSelect();
    this.bindJoystick();
    this.bindButtons();
    this.bindKeyboard();
    this.bindMinimap();
  },

  // tap the minimap to send your hero there (MLBB-style map travel)
  bindMinimap() {
    const mm = this.mmCanvas;
    mm.style.touchAction = 'none';
    mm.addEventListener('pointerdown', e => {
      e.preventDefault();
      if (!G.player || G.player.dead) return;
      const r = mm.getBoundingClientRect();
      const wx = clamp((e.clientX - r.left) / r.width * WORLD, 30, WORLD - 30);
      const wy = clamp((e.clientY - r.top) / r.height * WORLD, 30, WORLD - 30);
      G.player.navTarget = { x: wx, y: wy };
      Sfx.ensure();
    });
  },

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.canvas.style.width = window.innerWidth + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
    this.updateScale();
  },

  // HUD panels are designed at a ~900x420 landscape reference; scale the whole
  // HUD uniformly to that so it fits phones, tablets and desktop windows alike
  // without any control overflowing the screen or shrinking below a tappable size
  updateScale() {
    const s = clamp(Math.min(window.innerWidth / 900, window.innerHeight / 420), 0.72, 1.3);
    document.documentElement.style.setProperty('--ui-scale', s);
  },

  // ---------- hero select ----------
  selectedHero: 'kael',
  selectedSpell: 'flicker',
  buildHeroSelect() {
    if (this._lobbyBuilt) return;
    this._lobbyBuilt = true;
    const grid = this.els.heroGrid;
    grid.innerHTML = '';
    this.heroCards = {};

    // ---- roster cards ----
    for (const h of HEROES) {
      const card = document.createElement('div');
      card.className = 'heroCard';
      card.dataset.id = h.id; card.dataset.role = h.role;
      const cv = document.createElement('canvas');
      cv.width = 120; cv.height = 120;
      const c = cv.getContext('2d');
      const g = c.createRadialGradient(60, 50, 8, 60, 60, 55);
      g.addColorStop(0, 'rgba(255,255,255,0.14)');
      g.addColorStop(0.6, lighten(h.color, 0.05) + '');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = 0.35; c.fillStyle = g;
      c.beginPath(); c.arc(60, 60, 55, 0, 7); c.fill();
      c.globalAlpha = 1;
      drawHeroCardArt(c, h, 60, 104, 1.5);
      card.appendChild(cv);
      const nm = document.createElement('div'); nm.className = 'heroName'; nm.textContent = h.name;
      const rl = document.createElement('div'); rl.className = 'heroRole'; rl.textContent = h.role;
      card.appendChild(nm); card.appendChild(rl);
      card.addEventListener('click', () => this.selectHero(h.id));
      grid.appendChild(card);
      this.heroCards[h.id] = card;
    }

    // ---- role filter tabs ----
    const roles = ['All', ...Array.from(new Set(HEROES.map(h => h.role)))];
    const tabs = document.createElement('div'); tabs.id = 'roleTabs';
    roles.forEach((role, i) => {
      const t = document.createElement('div');
      t.className = 'roleTab' + (i === 0 ? ' sel' : '');
      t.textContent = role; t.dataset.role = role;
      t.addEventListener('click', () => {
        tabs.querySelectorAll('.roleTab').forEach(x => x.classList.toggle('sel', x === t));
        for (const h of HEROES) this.heroCards[h.id].style.display = (role === 'All' || h.role === role) ? '' : 'none';
      });
      tabs.appendChild(t);
    });

    // ---- left showcase panel ----
    const show = document.createElement('div'); show.id = 'heroShowcase';
    show.innerHTML =
      '<div id="showLane"></div>' +
      '<canvas id="showArt" width="240" height="210"></canvas>' +
      '<div id="showName"></div><div id="showTitle"></div>' +
      '<div id="showStats"></div>' +
      '<div id="showSkills"></div><div id="showDesc"></div>';

    // ---- right roster panel ----
    const roster = document.createElement('div'); roster.id = 'heroRoster';
    roster.appendChild(tabs);
    roster.appendChild(grid);

    // ---- match-prep bar: blue side vs red side + pick countdown ----
    const strip = document.createElement('div'); strip.id = 'teamStrip';
    strip.innerHTML =
      '<div class="tsGroup"><span class="tsLabel">YOUR TEAM · <b class="bl">BLUE</b></span>' +
        '<div class="tsSlots">' +
        '<div class="tsSlot me"><canvas id="tsMe" width="64" height="64"></canvas></div>' +
        Array.from({length:4}, () => '<div class="tsSlot"><span>?</span></div>').join('') +
        '</div></div>' +
      '<div id="pickTimer"><b>45</b><span>PICK</span></div>' +
      '<div class="tsGroup right"><span class="tsLabel"><b class="rd">RED</b> · ENEMY TEAM</span>' +
        '<div class="tsSlots">' +
        Array.from({length:5}, () => '<div class="tsSlot enemy"><span>?</span></div>').join('') +
        '</div></div>';

    // ---- assemble two-column lobby ----
    const main = document.createElement('div'); main.id = 'lobbyMain';
    main.appendChild(show); main.appendChild(roster);
    const box = this.els.btnStart.parentNode; // .selBox
    box.insertBefore(strip, this.els.selInfo);
    box.insertBefore(main, this.els.selInfo);
    this.els.selInfo.style.display = 'none';

    // battle-spell picker + start button live under the roster
    this.buildSpellPicker();
    const sp = document.getElementById('spellPick');
    if (sp) roster.appendChild(sp);
    roster.appendChild(this.els.btnStart);

    this.selectHero(HEROES[0].id);
    this.els.btnStart.addEventListener('click', () => { Sfx.ensure(); Game.start(this.selectedHero); });
    this.startPickTimer();
  },

  // draft countdown: while the lobby is visible, tick down and auto-lock the
  // current pick at 0 (the standard MOBA "pick phase" pressure). Resets to a
  // fresh 45s every time the lobby is re-entered (e.g. Play Again).
  startPickTimer() {
    if (this._pickInt) return;
    this.pickT = 45;
    this._wasHidden = false;
    this._pickInt = setInterval(() => {
      const sel = this.els.select;
      const visible = sel && getComputedStyle(sel).display !== 'none';
      if (!visible) { this._wasHidden = true; return; }
      if (this._wasHidden) { this._wasHidden = false; this.pickT = 45; }
      this.pickT--;
      const el = document.getElementById('pickTimer');
      if (el) {
        el.querySelector('b').textContent = Math.max(0, this.pickT);
        el.classList.toggle('urgent', this.pickT <= 10);
      }
      if (this.pickT <= 0) { Sfx.ensure(); Game.start(this.selectedHero); }
    }, 1000);
  },

  selectHero(id) {
    this.selectedHero = id;
    const h = heroById(id);
    if (this.heroCards) Object.values(this.heroCards).forEach(c => c.classList.toggle('sel', c.dataset.id === id));
    const cv = document.getElementById('showArt');
    if (cv) {
      const c = cv.getContext('2d');
      c.clearRect(0, 0, cv.width, cv.height);
      // splash-style backdrop: radial glow + light rays + hero-color halo
      const g = c.createRadialGradient(120, 78, 10, 120, 110, 140);
      g.addColorStop(0, lighten(h.color, 0.14));
      g.addColorStop(0.65, 'rgba(20,30,45,0.35)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = 0.55; c.fillStyle = g;
      c.beginPath(); c.arc(120, 105, 130, 0, 7); c.fill();
      c.globalAlpha = 1;
      c.save();
      c.translate(120, 108);
      for (let i = 0; i < 12; i++) {
        const a = i * Math.PI/6 + 0.26;
        const rayG = c.createLinearGradient(0, 0, Math.cos(a)*150, Math.sin(a)*150);
        rayG.addColorStop(0, 'rgba(255,255,255,0.10)');
        rayG.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = rayG;
        c.beginPath();
        c.moveTo(0, 0);
        c.lineTo(Math.cos(a - 0.06)*150, Math.sin(a - 0.06)*150);
        c.lineTo(Math.cos(a + 0.06)*150, Math.sin(a + 0.06)*150);
        c.closePath(); c.fill();
      }
      c.restore();
      // champion pedestal: glowing floor ellipse under the feet
      c.fillStyle = 'rgba(0,0,0,0.5)';
      c.beginPath(); c.ellipse(120, 198, 62, 15, 0, 0, 7); c.fill();
      c.strokeStyle = h.color; c.globalAlpha = 0.7; c.lineWidth = 2.5;
      c.beginPath(); c.ellipse(120, 198, 62, 15, 0, 0, 7); c.stroke();
      c.globalAlpha = 0.35;
      c.beginPath(); c.ellipse(120, 198, 46, 10.5, 0, 0, 7); c.stroke();
      c.globalAlpha = 1;
      drawHeroCardArt(c, h, 120, 196, 3.3);
    }
    const set = (sel, html) => { const el = document.getElementById(sel); if (el) el.innerHTML = html; };
    set('showName', h.name);
    set('showTitle', '<span>' + h.title + '</span> · <b style="color:' + h.color + '">' + h.role + '</b>');
    // stat bars + recommended lane badge (hero-select metadata from data.js)
    const rt = (typeof HERO_RATING !== 'undefined' && HERO_RATING[h.id]) || { dur:5, off:5, ctl:5, dif:5, lane:'MID' };
    set('showLane', '⚑ ' + rt.lane + ' LANE');
    set('showStats', [['Durability', rt.dur, '#4ade80'], ['Offense', rt.off, '#ff7a5c'], ['Control', rt.ctl, '#7db7ff'], ['Difficulty', rt.dif, '#e0aaff']]
      .map(([lbl, v, col]) =>
        '<div class="stRow"><span class="stLbl">' + lbl + '</span>' +
        '<span class="stBar"><i style="width:' + (v * 10) + '%;background:' + col + '"></i></span></div>').join(''));
    set('showSkills', h.skills.map((s, i) =>
      '<div class="showSkill"><span class="ssIcon">' + s.icon + '</span><span class="ssLbl">' + ['S1','S2','ULT'][i] + '</span></div>'
    ).join(''));
    set('showDesc',
      '<div class="dLine"><b class="dPassive">PASSIVE</b> ' + h.passive + '</div>' +
      h.skills.map((s, i) => '<div class="dLine"><b>' + ['S1','S2','ULT'][i] + ' · ' + s.name + '</b> ' + s.desc + '</div>').join(''));
    // team-strip portrait
    const ts = document.getElementById('tsMe');
    if (ts) {
      const c = ts.getContext('2d');
      c.clearRect(0, 0, 64, 64);
      const g = c.createRadialGradient(32, 24, 4, 32, 32, 34);
      g.addColorStop(0, lighten(h.color, 0.2)); g.addColorStop(1, 'rgba(6,12,20,0.9)');
      c.fillStyle = g; c.fillRect(0, 0, 64, 64);
      drawHeroCardArt(c, h, 32, 58, 0.85);
    }
  },

  // small mute toggle (works on touch + the M key); persists in localStorage
  buildMuteBtn() {
    if (!this._muteBtn) {
      const b = document.createElement('div');
      b.id = 'btnMute'; b.className = 'miniBtn';
      this.els.hud.appendChild(b);
      b.addEventListener('click', () => this.toggleMute());
      this._muteBtn = b;
      try { if (localStorage.getItem('va_muted') === '1') Sfx.on = false; } catch (e) {}
    }
    this._syncMute();
  },
  toggleMute() {
    Sfx.on = !Sfx.on;
    if (!Sfx.on) Sfx.stopAmbient(); else { Sfx.ensure(); Sfx.startAmbient(); }
    try { localStorage.setItem('va_muted', Sfx.on ? '0' : '1'); } catch (e) {}
    this._syncMute();
  },
  _syncMute() {
    if (this._muteBtn) {
      this._muteBtn.textContent = Sfx.on ? '🔊' : '🔇';
      this._muteBtn.classList.toggle('muted', !Sfx.on);
    }
  },

  // top-of-screen team portrait strips: ally heads on the left of the score,
  // enemy heads on the right, each with a live HP bar and respawn countdown
  buildTeamStrips() {
    for (const old of document.querySelectorAll('.teamHeads')) old.remove();
    this.headEls = [];
    const mk = (heroes, cls) => {
      const strip = document.createElement('div');
      strip.className = 'teamHeads ' + cls;
      for (const h of heroes) {
        const cell = document.createElement('div');
        cell.className = 'headCell';
        const cv = document.createElement('canvas');
        cv.width = 64; cv.height = 64;
        const c = cv.getContext('2d');
        const g = c.createRadialGradient(32, 22, 4, 32, 32, 34);
        g.addColorStop(0, lighten(h.def.color, 0.22));
        g.addColorStop(1, 'rgba(6,12,20,0.95)');
        c.fillStyle = g; c.fillRect(0, 0, 64, 64);
        drawHeroCardArt(c, h.def, 32, 60, 0.88);
        cell.appendChild(cv);
        const bar = document.createElement('div');
        bar.className = 'headHp';
        bar.innerHTML = '<i></i>';
        cell.appendChild(bar);
        const dead = document.createElement('span');
        dead.className = 'headDead';
        cell.appendChild(dead);
        strip.appendChild(cell);
        this.headEls.push({ h, cell, fill: bar.firstChild, dead });
      }
      this.els.hud.appendChild(strip);
      return strip;
    };
    const myTeam = G.player.team;
    mk(G.heroes.filter(h => h.team === myTeam && !h.isPlayer), 'ally');
    mk(G.heroes.filter(h => h.team !== myTeam), 'enemy');
  },

  // battle-spell chooser on the hero-select screen (built once)
  buildSpellPicker() {
    if (this._spellPickBuilt) return;
    this._spellPickBuilt = true;
    const box = this.els.btnStart.parentNode; // .selBox
    const wrap = document.createElement('div');
    wrap.id = 'spellPick';
    const label = document.createElement('div');
    label.className = 'spellPickLabel';
    label.textContent = 'BATTLE SPELL';
    wrap.appendChild(label);
    const row = document.createElement('div');
    row.className = 'spellPickRow';
    BATTLE_SPELLS.forEach(sp => {
      const el = document.createElement('div');
      el.className = 'spellOpt' + (sp.id === this.selectedSpell ? ' sel' : '');
      el.dataset.id = sp.id;
      el.innerHTML = '<span class="spIcon">' + sp.icon + '</span><span class="spName">' + sp.name + '</span>';
      el.title = sp.desc;
      el.addEventListener('click', () => {
        this.selectedSpell = sp.id;
        row.querySelectorAll('.spellOpt').forEach(x => x.classList.toggle('sel', x.dataset.id === sp.id));
      });
      row.appendChild(el);
    });
    wrap.appendChild(row);
    box.insertBefore(wrap, this.els.btnStart);
  },

  onGameStart() {
    this.els.select.style.display = 'none';
    this.els.end.style.display = 'none';
    this.els.hud.style.display = 'block';
    Sfx.ensure(); Sfx.startAmbient();
    this.buildSkillButtons();
    this.buildSpellButton();
    this.buildBuffRow();
    this.buildObjTimer();
    if (this.spellBtn) {
      const sp = battleSpellById(G.player.battleSpell);
      if (sp) this.drawSkillIcon(this.spellBtn.querySelector('canvas.icon'), sp.icon, '#c77dff');
      this.spellBtn.title = sp ? sp.name : '';
      // MLBB-style text labels under the utility buttons
      const label = (el, txt) => {
        if (!el) return;
        let l = el.querySelector('.btnLabel');
        if (!l) { l = document.createElement('span'); l.className = 'btnLabel'; el.appendChild(l); }
        l.textContent = txt;
      };
      label(this.els.btnRecall, 'Recall');
      label(this.spellBtn, sp ? sp.name : 'Spell');
      label(this.els.btnShop, 'Shop');
    }
    this.buildTeamStrips();
    this.buildShop();
    this.buildMuteBtn();
    // portrait: the hero's character bust
    const c = this.els.portGlyph.getContext('2d');
    const h = G.player.def;
    c.clearRect(0, 0, 64, 64);
    c.save();
    c.beginPath(); c.arc(32, 32, 30, 0, 7); c.clip();
    const g = c.createRadialGradient(32, 24, 4, 32, 32, 32);
    g.addColorStop(0, lighten(h.color, 0.15));
    g.addColorStop(1, '#0a1420');
    c.fillStyle = g;
    c.fillRect(0, 0, 64, 64);
    drawHeroCardArt(c, h, 32, 86, 1.15);
    c.restore();
  },

  // ---------- joystick ----------
  bindJoystick() {
    const zone = this.els.joyZone, base = this.els.joyBase, knob = this.els.joyKnob;
    let pid = null, cx = 0, cy = 0;
    const R = 62;
    zone.addEventListener('pointerdown', e => {
      pid = e.pointerId;
      cx = e.clientX; cy = e.clientY;
      base.style.left = (cx - 70) + 'px'; base.style.top = (cy - 70) + 'px';
      base.style.opacity = 1;
      Input.joy.active = true; Input.joy.dx = 0; Input.joy.dy = 0;
      zone.setPointerCapture(pid);
      Sfx.ensure();
    });
    zone.addEventListener('pointermove', e => {
      if (e.pointerId !== pid) return;
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const d = Math.hypot(dx, dy);
      const k = Math.min(d, R);
      if (d > 0) { dx /= d; dy /= d; }
      knob.style.transform = 'translate(' + dx*k + 'px,' + dy*k + 'px)';
      Input.joy.dx = dx * (k / R);
      Input.joy.dy = dy * (k / R);
    });
    const up = e => {
      if (e.pointerId !== pid) return;
      pid = null;
      Input.joy.active = false; Input.joy.dx = 0; Input.joy.dy = 0;
      knob.style.transform = 'translate(0,0)';
      base.style.opacity = 0.45;
    };
    zone.addEventListener('pointerup', up);
    zone.addEventListener('pointercancel', up);
  },

  // ---------- vector-drawn ability icons ----------
  // Each glyph used in the hero kits maps to a hand-drawn motif rendered on a
  // small canvas — white-hot strokes over the hero's accent glow — replacing
  // raw emoji, which render inconsistently across phones and read as
  // placeholder art. Unknown glyphs fall back to text.
  drawSkillIcon(cv, glyph, accent) {
    const c = cv.getContext('2d'), S = cv.width, u = S / 64;
    c.clearRect(0, 0, S, S);
    const g = c.createRadialGradient(S/2, S*0.42, 2, S/2, S/2, S*0.55);
    g.addColorStop(0, 'rgba(255,255,255,0.10)'); g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g; c.fillRect(0, 0, S, S);
    c.strokeStyle = '#f2fbff'; c.fillStyle = '#f2fbff';
    c.lineWidth = 4.5*u; c.lineCap = 'round'; c.lineJoin = 'round';
    c.shadowColor = accent; c.shadowBlur = 10*u;
    const line = (x1,y1,x2,y2) => { c.beginPath(); c.moveTo(x1*u,y1*u); c.lineTo(x2*u,y2*u); c.stroke(); };
    const ring = (x,y,r,fill) => { c.beginPath(); c.arc(x*u,y*u,r*u,0,7); fill?c.fill():c.stroke(); };
    switch (glyph) {
      case '➤': case '⇒': // dash
        line(12,32,40,32);
        c.beginPath(); c.moveTo(32*u,18*u); c.lineTo(52*u,32*u); c.lineTo(32*u,46*u); c.closePath(); c.fill();
        break;
      case '⇉': line(10,24,38,24); line(10,40,38,40); // double dash
        c.beginPath(); c.moveTo(34*u,14*u); c.lineTo(52*u,32*u); c.lineTo(34*u,50*u); c.closePath(); c.fill();
        break;
      case '⚔': line(16,48,46,16); line(18,16,48,48); line(12,42,22,52); line(42,52,52,42); break; // crossed blades
      case '☠': ring(32,28,14,true); c.shadowBlur=0; c.fillStyle='#0a1420';
        ring(27,26,3.4,true); ring(37,26,3.4,true);
        c.fillRect(26*u,38*u,3*u,7*u); c.fillRect(31*u,40*u,3*u,7*u); c.fillRect(36*u,38*u,3*u,7*u);
        c.fillStyle='#f2fbff'; break;
      case '⚡': c.beginPath(); c.moveTo(36*u,10*u); c.lineTo(22*u,36*u); c.lineTo(31*u,36*u);
        c.lineTo(27*u,54*u); c.lineTo(44*u,28*u); c.lineTo(34*u,28*u); c.closePath(); c.fill(); break;
      case '✵': ring(32,32,9); for (let i=0;i<4;i++){const a=i*Math.PI/2+Math.PI/4;
        line(32+Math.cos(a)*13,32+Math.sin(a)*13,32+Math.cos(a)*22,32+Math.sin(a)*22);} break;
      case '☄': ring(24,40,9,true); line(32,32,50,14); line(36,38,52,26); line(28,28,42,12); break; // comet
      case '◈': c.beginPath(); c.moveTo(32*u,12*u); c.lineTo(50*u,32*u); c.lineTo(32*u,52*u); c.lineTo(14*u,32*u);
        c.closePath(); c.stroke(); ring(32,32,6,true); break;
      case '◉': ring(32,32,17); ring(32,32,7,true); break;   // gravity well
      case '◎': ring(32,32,17); ring(32,32,9); break;        // ward ring
      case '☆': { c.beginPath(); for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5;
        const r=i%2===0?19:8.5; c[i===0?'moveTo':'lineTo']((32+Math.cos(a)*r)*u,(34+Math.sin(a)*r)*u);}
        c.closePath(); c.fill(); break; }
      case '♛': c.beginPath(); c.moveTo(14*u,44*u); c.lineTo(12*u,22*u); c.lineTo(23*u,32*u); c.lineTo(32*u,16*u);
        c.lineTo(41*u,32*u); c.lineTo(52*u,22*u); c.lineTo(50*u,44*u); c.closePath(); c.fill(); break;
      case '⛨': c.beginPath(); c.moveTo(32*u,10*u); c.lineTo(50*u,18*u); c.lineTo(48*u,40*u); c.lineTo(32*u,54*u);
        c.lineTo(16*u,40*u); c.lineTo(14*u,18*u); c.closePath(); c.stroke(); line(32,22,32,42); line(24,32,40,32); break;
      case '✚': c.fillRect(26*u,14*u,12*u,36*u); c.fillRect(14*u,26*u,36*u,12*u); break;
      case '✦': c.beginPath(); c.moveTo(32*u,10*u); c.quadraticCurveTo(34*u,28*u,54*u,32*u);
        c.quadraticCurveTo(34*u,36*u,32*u,54*u); c.quadraticCurveTo(30*u,36*u,10*u,32*u);
        c.quadraticCurveTo(30*u,28*u,32*u,10*u); c.fill(); break;
      case '✳': for (let i=0;i<6;i++){const a=i*Math.PI/3; line(32,32,32+Math.cos(a)*20,32+Math.sin(a)*20);} ring(32,32,5,true); break;
      case '❄': case '❆': for (let i=0;i<6;i++){const a=i*Math.PI/3;
          const ex=32+Math.cos(a)*20, ey=32+Math.sin(a)*20;
          line(32,32,ex,ey);
          line((32+ex)/2,(32+ey)/2,(32+ex)/2+Math.cos(a+1.05)*6,(32+ey)/2+Math.sin(a+1.05)*6);
          line((32+ex)/2,(32+ey)/2,(32+ex)/2+Math.cos(a-1.05)*6,(32+ey)/2+Math.sin(a-1.05)*6);
        }
        if (glyph==='❆') ring(32,32,23);
        break;
      case '❈': for (let i=0;i<4;i++){const a=i*Math.PI/2;
        c.beginPath(); c.ellipse((32+Math.cos(a)*11)*u,(32+Math.sin(a)*11)*u,10*u,5*u,a,0,7); c.stroke();} break;
      case '»': line(18,18,32,32); line(18,46,32,32); line(34,18,48,32); line(34,46,48,32); break;
      case '➳': line(12,52,46,18); c.beginPath(); c.moveTo(38*u,12*u); c.lineTo(52*u,12*u); c.lineTo(52*u,26*u);
        c.closePath(); c.fill(); line(16,44,24,48); line(16,44,12,38); break;
      case '⬇': line(32,12,32,42); c.beginPath(); c.moveTo(18*u,36*u); c.lineTo(46*u,36*u); c.lineTo(32*u,54*u);
        c.closePath(); c.fill(); break;
      default:
        c.font = 'bold ' + 34*u + 'px Rajdhani, sans-serif';
        c.textAlign = 'center'; c.textBaseline = 'middle';
        c.fillText(glyph, 32*u, 34*u);
    }
    c.shadowBlur = 0;
  },

  // ---------- skill buttons (tap = smart cast, drag = aim) ----------
  buildSkillButtons() {
    const holder = document.getElementById('skills');
    holder.innerHTML = '';
    this.skillEls = [];
    G.aimPreview = null;
    const defs = G.player.def.skills;
    defs.forEach((sk, i) => {
      const maxLv = i === 2 ? 3 : 5;
      const b = document.createElement('div');
      b.className = 'skillBtn sk' + i + (i === 2 ? ' ult' : '');
      b.innerHTML = '<canvas class="icon" width="64" height="64"></canvas><div class="cdOverlay"></div><div class="cdText"></div>' +
        '<div class="lock">🔒</div><div class="upBadge">+</div>' +
        '<div class="pips">' + Array.from({length: maxLv}, () => '<i></i>').join('') + '</div>';
      this.drawSkillIcon(b.querySelector('canvas.icon'), sk.icon, G.player.def.color);
      holder.appendChild(b);
      this.skillEls.push(b);
      const upBadge = b.querySelector('.upBadge');
      upBadge.addEventListener('pointerdown', e => {
        e.preventDefault(); e.stopPropagation();
        Sfx.ensure();
        G.player.upgradeSkill(i);
      });
      let pid = null, sx = 0, sy = 0, dragging = false;
      b.addEventListener('pointerdown', e => {
        e.preventDefault();
        Sfx.ensure();
        pid = e.pointerId; sx = e.clientX; sy = e.clientY; dragging = false;
        b.setPointerCapture(pid);
      });
      b.addEventListener('pointermove', e => {
        if (e.pointerId !== pid) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        if (Math.hypot(dx, dy) > 22) {
          dragging = true;
          const d = Math.hypot(dx, dy);
          G.aimPreview = { dx: dx/d, dy: dy/d, range: sk.range || 300, skill: i };
        }
      });
      const fin = e => {
        if (e.pointerId !== pid) return;
        pid = null;
        if (dragging && G.aimPreview) {
          Game.playerCast(i, { dx: G.aimPreview.dx, dy: G.aimPreview.dy });
        } else {
          Game.playerCast(i, null);
        }
        G.aimPreview = null;
      };
      b.addEventListener('pointerup', fin);
      b.addEventListener('pointercancel', e => { if (e.pointerId === pid) { pid = null; G.aimPreview = null; } });
    });
  },

  // ---------- battle-spell button (tap = smart cast, drag = aim, e.g. Flicker) ----------
  buildSpellButton() {
    if (this.spellBtn) return;
    const actions = document.getElementById('actions');
    const b = document.createElement('div');
    b.id = 'btnSpell';
    b.innerHTML = '<canvas class="icon" width="64" height="64"></canvas><div class="cdOverlay"></div><div class="cdText"></div>';
    actions.appendChild(b);
    this.spellBtn = b;
    let pid = null, sx = 0, sy = 0, dragging = false;
    b.addEventListener('pointerdown', e => {
      e.preventDefault(); Sfx.ensure();
      pid = e.pointerId; sx = e.clientX; sy = e.clientY; dragging = false;
      b.setPointerCapture(pid);
    });
    b.addEventListener('pointermove', e => {
      if (e.pointerId !== pid) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.hypot(dx, dy) > 22) {
        dragging = true;
        const d = Math.hypot(dx, dy);
        G.aimPreview = { dx: dx/d, dy: dy/d, range: 300, skill: 'spell' };
      }
    });
    const fin = e => {
      if (e.pointerId !== pid) return;
      pid = null;
      if (dragging && G.aimPreview) Game.playerBattleSpell({ dx: G.aimPreview.dx, dy: G.aimPreview.dy });
      else Game.playerBattleSpell(null);
      G.aimPreview = null;
    };
    b.addEventListener('pointerup', fin);
    b.addEventListener('pointercancel', e => { if (e.pointerId === pid) { pid = null; G.aimPreview = null; } });
  },

  // ---------- active-buff indicator ----------
  buildBuffRow() {
    if (this.buffRow) return;
    const row = document.createElement('div');
    row.id = 'buffRow';
    this.els.hud.appendChild(row);
    this.buffRow = row;
  },

  // ---------- objective (Void Behemoth) timer ----------
  buildObjTimer() {
    if (this.objTimer) return;
    const el = document.createElement('div');
    el.id = 'objTimer';
    el.innerHTML = '<span class="objIcon">🐉</span><b>--:--</b>';
    this.els.hud.appendChild(el);
    this.objTimer = el;
  },

  bindButtons() {
    const atk = this.els.btnAttack;
    atk.addEventListener('pointerdown', e => { e.preventDefault(); Sfx.ensure(); Input.attackHeld = true; });
    atk.addEventListener('pointerup', () => Input.attackHeld = false);
    atk.addEventListener('pointercancel', () => Input.attackHeld = false);

    this.els.btnRecall.addEventListener('click', () => Game.playerRecall());
    this.els.btnBuy.addEventListener('click', () => { Game.playerBuy(); this.refreshShop(); });
    this.els.btnShop.addEventListener('click', () => {
      const p = this.els.shopPanel;
      p.style.display = p.style.display === 'block' ? 'none' : 'block';
      this.refreshShop();
    });
    this.els.btnCloseShop.addEventListener('click', () => this.els.shopPanel.style.display = 'none');
    this.els.btnScore.addEventListener('click', () => {
      const s = this.els.scoreboard;
      s.style.display = s.style.display === 'block' ? 'none' : 'block';
      if (s.style.display === 'block') this.refreshScoreboard();
    });
    this.els.btnRestart.addEventListener('click', () => {
      this.els.end.style.display = 'none';
      this.els.hud.style.display = 'none';
      this.els.select.style.display = 'flex';
    });
  },

  bindKeyboard() {
    window.addEventListener('keydown', e => {
      const k = e.key.toLowerCase();
      Input.keys[k] = true;
      if (k === 'm') { this.toggleMute(); return; }
      if (!G.running || G.over) return;
      Sfx.ensure();
      if (k === '1') Game.playerCast(0, this.mouseAim());
      if (k === '2') Game.playerCast(1, this.mouseAim());
      if (k === '3') Game.playerCast(2, this.mouseAim());
      if (k === ' ') Input.attackHeld = true;
      if (k === 'b') Game.playerRecall();
      if (k === 'd') Game.playerBattleSpell(this.mouseAim());
      if (k === 'f') { Game.playerBuy(); this.refreshShop(); }
      if (k === 'p') this.els.btnShop.click();
      if (k === 'tab') { e.preventDefault(); this.els.btnScore.click(); }
    });
    window.addEventListener('keyup', e => {
      const k = e.key.toLowerCase();
      Input.keys[k] = false;
      if (k === ' ') Input.attackHeld = false;
    });
    this.canvas ||= document.getElementById('game');
    window.addEventListener('mousemove', e => { Input.mouse.x = e.clientX; Input.mouse.y = e.clientY; });
  },

  mouseAim() {
    if (!G.player) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const z = G.cam.zoom;
    const wx = (Input.mouse.x * dpr - this.canvas.width/2) / z + G.cam.x;
    const wy = (Input.mouse.y * dpr - this.canvas.height/2) / (z * YS) + G.cam.y;
    const dx = wx - G.player.x, dy = wy - G.player.y;
    const d = Math.hypot(dx, dy);
    if (d < 5) return null;
    return { dx: dx/d, dy: dy/d };
  },

  // ---------- shop ----------
  // sort each item into an MLBB-style shop category from its stat block
  itemCat(it) {
    const s = it.stat || {};
    if (s.ms) return 'move';
    if (s.sp) return 'arcane';
    if (s.ad || s.as || s.ls) return 'attack';
    if (s.hp || s.armor || s.mr || s.regen) return 'defense';
    return 'attack';
  },

  shopFilter: 'all',
  buildShop() {
    const panel = this.els.shopPanel;
    const grid = this.els.shopGrid;

    // category tab bar (built once, above the grid)
    if (!this._shopTabs) {
      const tabs = document.createElement('div');
      tabs.id = 'shopTabs';
      const CATS = [['all','All'],['attack','Attack'],['arcane','Magic'],['defense','Defense'],['move','Move']];
      for (const [id, label] of CATS) {
        const t = document.createElement('div');
        t.className = 'shopTab' + (id === 'all' ? ' sel' : '');
        t.dataset.cat = id; t.textContent = label;
        t.addEventListener('click', () => {
          this.shopFilter = id;
          tabs.querySelectorAll('.shopTab').forEach(x => x.classList.toggle('sel', x.dataset.cat === id));
          this.refreshShop();
        });
        tabs.appendChild(t);
      }
      panel.insertBefore(tabs, grid);
      this._shopTabs = tabs;
      // recommended-build strip
      const rec = document.createElement('div');
      rec.id = 'shopRec';
      panel.insertBefore(rec, grid);
      this._shopRec = rec;
    }

    grid.innerHTML = '';
    for (const it of ITEMS) {
      const cat = this.itemCat(it);
      const d = document.createElement('div');
      d.className = 'shopItem';
      d.dataset.id = it.id; d.dataset.cat = cat;
      const cv = document.createElement('canvas');
      cv.width = 44; cv.height = 44; cv.className = 'itIcon';
      this.drawItemIcon(cv, cat);
      d.appendChild(cv);
      const body = document.createElement('div');
      body.className = 'itBody';
      body.innerHTML = '<div class="itName">' + it.name + '</div><div class="itDesc">' + it.desc + '</div>';
      d.appendChild(body);
      const cost = document.createElement('div');
      cost.className = 'itCost'; cost.textContent = it.cost;
      d.appendChild(cost);
      d.addEventListener('click', () => {
        if (G.player.buyItem(it)) {
          Sfx.play('buy');
          const bi = G.player.def.build[G.player.buildIdx];
          if (bi === it.id) G.player.buildIdx++;
          this.refreshShop();
        }
      });
      grid.appendChild(d);
    }
  },

  // hand-drawn category emblem so items read at a glance, not just by letter
  drawItemIcon(cv, cat) {
    const c = cv.getContext('2d');
    const W = cv.width, H = cv.height;
    const accent = { attack:'#ff8a5c', arcane:'#c77dff', defense:'#7db7ff', move:'#7dff9b' }[cat] || '#ffd166';
    c.clearRect(0, 0, W, H);
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, hexA(accent, 0.28)); g.addColorStop(1, hexA(accent, 0.08));
    c.fillStyle = g;
    roundRect(c, 2, 2, W-4, H-4, 8); c.fill();
    c.strokeStyle = hexA(accent, 0.6); c.lineWidth = 1.5;
    roundRect(c, 2, 2, W-4, H-4, 8); c.stroke();
    c.save(); c.translate(W/2, H/2); c.strokeStyle = accent; c.fillStyle = accent;
    c.lineWidth = 3; c.lineCap = 'round'; c.lineJoin = 'round';
    if (cat === 'attack') {                       // upright sword
      c.beginPath(); c.moveTo(0, -13); c.lineTo(0, 8); c.stroke();
      c.beginPath(); c.moveTo(-6, 4); c.lineTo(6, 4); c.stroke();
      c.beginPath(); c.moveTo(0, 8); c.lineTo(0, 13); c.stroke();
    } else if (cat === 'arcane') {                // orb with spark
      c.beginPath(); c.arc(0, 0, 9, 0, 7); c.stroke();
      c.fillStyle = '#fff'; c.beginPath(); c.arc(-3, -3, 2.5, 0, 7); c.fill();
      c.fillStyle = accent;
      for (let i=0;i<4;i++){ const a=i*Math.PI/2+0.4; c.beginPath(); c.moveTo(Math.cos(a)*11, Math.sin(a)*11); c.lineTo(Math.cos(a)*15, Math.sin(a)*15); c.stroke(); }
    } else if (cat === 'defense') {               // shield
      c.beginPath();
      c.moveTo(0, -13); c.lineTo(11, -8); c.lineTo(9, 6); c.lineTo(0, 14); c.lineTo(-9, 6); c.lineTo(-11, -8);
      c.closePath(); c.stroke();
      c.beginPath(); c.moveTo(0, -6); c.lineTo(0, 8); c.moveTo(-6, 0); c.lineTo(6, 0); c.stroke();
    } else {                                      // winged boot / speed
      c.beginPath(); c.moveTo(-9, -6); c.lineTo(-9, 8); c.lineTo(11, 8); c.lineTo(11, 2); c.lineTo(-2, 2); c.lineTo(-2, -6); c.closePath(); c.stroke();
      c.lineWidth = 2;
      for (let i=0;i<3;i++){ const yy=-8+i*5; c.beginPath(); c.moveTo(-14, yy); c.lineTo(-6, yy); c.stroke(); }
    }
    c.restore();
  },

  refreshShop() {
    if (this.els.shopPanel.style.display !== 'block') return;
    const p = G.player;
    this.els.shopGold.textContent = Math.floor(p.gold) + ' gold';
    const owned = new Set(p.items.map(i => i.id));
    const full = p.items.length >= CFG.maxItems;
    document.querySelectorAll('.shopItem').forEach(el => {
      const it = itemById(el.dataset.id);
      el.style.display = (this.shopFilter === 'all' || el.dataset.cat === this.shopFilter) ? '' : 'none';
      el.classList.toggle('afford', p.gold >= it.cost && !full);
      el.classList.toggle('owned', owned.has(it.id));
    });
    // recommended next item from the hero's build path
    if (this._shopRec) {
      const nextId = p.def.build[p.buildIdx];
      const next = nextId && itemById(nextId);
      if (next && !full) {
        this._shopRec.style.display = '';
        this._shopRec.innerHTML = '<span class="recLabel">RECOMMENDED</span>' +
          '<span class="recName">' + next.name + '</span>' +
          '<span class="recCost' + (p.gold >= next.cost ? ' ok' : '') + '">◆ ' + next.cost + '</span>';
        this._shopRec.onclick = () => {
          if (p.buyItem(next)) { Sfx.play('buy'); p.buildIdx++; this.refreshShop(); }
        };
      } else {
        this._shopRec.style.display = 'none';
      }
    }
  },

  refreshScoreboard() {
    const sb = this.els.scoreboard;
    const row = h =>
      '<tr class="' + h.team + (h.isPlayer ? ' me' : '') + '"><td>' + h.name + '</td><td>' + h.level + '</td>' +
      '<td>' + h.kills + '/' + h.deaths + '/' + h.assists + '</td><td>' + h.cs + '</td><td>' + Math.floor(h.gold) + '</td></tr>';
    sb.innerHTML = '<h3>Scoreboard <span class="dim">(tap ☰ to close)</span></h3>' +
      '<table><tr><th>Hero</th><th>Lv</th><th>K/D/A</th><th>CS</th><th>Gold</th></tr>' +
      G.heroes.filter(h => h.team === 'blue').map(row).join('') +
      '<tr class="sep"><td colspan="5"></td></tr>' +
      G.heroes.filter(h => h.team === 'red').map(row).join('') + '</table>';
  },

  // ---------- announcements / killfeed ----------
  announce(text, color) {
    const el = document.createElement('div');
    el.className = 'ann';
    el.style.color = color || '#fff';
    el.textContent = text;
    this.els.announce.appendChild(el);
    while (this.els.announce.children.length > 3) this.els.announce.firstChild.remove();
    setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 600); }, 2600);
  },

  // small colored badge for a kill-feed entry: a hero's own portrait color, or a
  // neutral turret glyph when a structure gets the kill
  feedIcon(hero) {
    if (!hero) {
      return '<span class="feedIcon turret" style="background:#3a424b">🗼</span>';
    }
    return '<span class="feedIcon" style="background:' + hero.def.color + '">' +
      HERO_INITIAL[hero.def.id] + '</span>';
  },

  feed(killerHero, victim, team) {
    const el = document.createElement('div');
    el.className = 'feedLine';
    const killerName = killerHero ? killerHero.name : 'a turret';
    el.innerHTML = this.feedIcon(killerHero) +
      '<span style="color:' + TEAM_COLOR[team] + '">' + killerName + '</span> ⚔ ' +
      this.feedIcon(victim) + '<span>' + victim.name + '</span>';
    this.els.killfeed.appendChild(el);
    while (this.els.killfeed.children.length > 4) this.els.killfeed.firstChild.remove();
    setTimeout(() => el.remove(), 5000);
  },

  // MLBB-style kill spectacle: the big center-screen callout (First Blood,
  // Double Kill … Savage) plus the spree ticker and the player's own callout.
  killEvent(killer, victim, firstBlood) {
    const mk = killer.mkCount || 1;
    const streak = killer.streak || 1;
    const you = killer.isPlayer, iDied = victim.isPlayer;

    // marquee multi-kill banner
    const MK = { 2:['DOUBLE KILL','#ffd24a'], 3:['TRIPLE KILL','#ff9f43'], 4:['MANIAC','#ff5c8a'], 5:['SAVAGE','#c77dff'] };
    const sub = killer.name + (you ? ' (You)' : '');
    let toned = false;
    if (mk >= 2) {
      const [label, col] = MK[Math.min(mk, 5)];
      this.killBanner(label, sub, col, mk >= 4, killer, victim);
      Sfx.play(mk >= 4 ? 'savage' : 'multikill'); toned = true;
    } else if (firstBlood) {
      this.killBanner('FIRST BLOOD', sub, '#ff5c5c', false, killer, victim);
      Sfx.play('kill'); toned = true;
    }

    // running kill-streak (no death) — announced in the ticker
    const SPREE = { 3:'KILLING SPREE', 5:'DOMINATING', 7:'UNSTOPPABLE', 9:'GODLIKE', 12:'LEGENDARY' };
    if (SPREE[streak]) this.announce(killer.name + ' — ' + SPREE[streak] + '! (' + streak + ')', '#ffb84d');

    // personal callouts (only the player's own kills/deaths get the ticker line)
    if (you) { this.announce('You killed ' + victim.name + '!', '#ffe27d'); if (!toned) Sfx.play('kill'); }
    else if (iDied) { this.announce('You were slain by ' + killer.name + '!', '#ff5c5c'); if (!toned) Sfx.play('death'); }
  },

  // the pop-scale center banner element, created on first use; killer/victim
  // busts flank a crossed-swords divider above the title
  killBanner(title, sub, color, big, killer, victim) {
    let kb = this._kb;
    if (!kb) {
      kb = this._kb = document.createElement('div');
      kb.id = 'killBanner';
      document.body.appendChild(kb);
    }
    let heads = '';
    if (killer && victim) heads =
      '<div class="kbHeads"><span class="kbHead k"></span><span class="kbVs">⚔</span><span class="kbHead v"></span></div>';
    kb.innerHTML = heads +
      '<div class="kbTitle" style="color:' + color + '">' + title + '</div>' +
      (sub ? '<div class="kbSub">' + sub + '</div>' : '');
    if (killer && victim) {
      const bust = (holder, h, ring) => {
        const cv = document.createElement('canvas');
        cv.width = 72; cv.height = 72;
        const c = cv.getContext('2d');
        const g = c.createRadialGradient(36, 26, 4, 36, 36, 38);
        g.addColorStop(0, lighten(h.def.color, 0.22));
        g.addColorStop(1, 'rgba(6,12,20,0.95)');
        c.fillStyle = g; c.fillRect(0, 0, 72, 72);
        drawHeroCardArt(c, h.def, 36, 68, 0.95);
        holder.style.borderColor = ring;
        holder.appendChild(cv);
      };
      bust(kb.querySelector('.kbHead.k'), killer, TEAM_COLOR[killer.team]);
      bust(kb.querySelector('.kbHead.v'), victim, '#5a6470');
    }
    kb.classList.remove('anim', 'big');
    void kb.offsetWidth;                 // restart the CSS animation
    kb.className = 'anim' + (big ? ' big' : '');
    clearTimeout(this._kbT);
    this._kbT = setTimeout(() => kb.classList.remove('anim', 'big'), big ? 2600 : 2000);
  },

  // performance score used for MVP + medals (rewards kills/assists/objectives,
  // penalises deaths) — the same idea as MLBB's post-game rating
  mvpScore(h) {
    return h.kills*4 + h.assists*2 - h.deaths*1.5 + h.cs*0.03 + h.level*0.8 + Math.floor(h.gold)*0.001;
  },

  showEnd(won) {
    Sfx.stopAmbient();
    this.els.end.style.display = 'flex';
    this.els.endTitle.textContent = won ? 'VICTORY' : 'DEFEAT';
    this.els.endTitle.className = won ? 'win' : 'lose';
    this.els.endSub.textContent = 'Void Core destroyed at ' +
      Math.floor(G.time/60) + ':' + String(Math.floor(G.time%60)).padStart(2,'0');

    // rank every hero by performance; top 3 get medals, and the highest
    // scorer on the winning team is the match MVP
    const ranked = [...G.heroes].sort((a, b) => this.mvpScore(b) - this.mvpScore(a));
    const medal = new Map();
    ['🥇', '🥈', '🥉'].forEach((m, i) => { if (ranked[i]) medal.set(ranked[i], m); });
    const winTeam = won ? G.player.team : (G.player.team === 'blue' ? 'red' : 'blue');
    const mvp = ranked.find(h => h.team === winTeam) || ranked[0];

    // MVP banner
    const mvpBanner = '<div class="mvpBanner" style="border-color:' + mvp.def.color + '">' +
      '<span class="mvpMedal">⭐</span>' +
      '<span class="mvpLabel">MVP</span>' +
      '<span class="mvpName" style="color:' + mvp.def.color + '">' + mvp.name + (mvp.isPlayer ? ' (You)' : '') + '</span>' +
      '<span class="mvpKda">' + mvp.kills + '/' + mvp.deaths + '/' + mvp.assists + '</span>' +
      '</div>';

    const row = h => '<tr class="' + (h.isPlayer ? 'me' : '') + (h === mvp ? ' mvpRow' : '') + '">' +
      '<td class="hn" style="color:' + h.def.color + '">' + (medal.get(h) || '') + ' ' + h.name + '</td>' +
      '<td>' + h.level + '</td><td>' + h.kills + '/' + h.deaths + '/' + h.assists + '</td>' +
      '<td>' + h.cs + '</td><td class="gold">' + Math.floor(h.gold) + '</td></tr>';
    const side = (team, label) =>
      '<table class="endTable ' + team + '"><caption>' + label + (team === (G.player.team) ? ' (You)' : '') + '</caption>' +
      '<tr><th>Hero</th><th>Lv</th><th>K/D/A</th><th>CS</th><th>Gold</th></tr>' +
      G.heroes.filter(h => h.team === team).sort((a,b)=>this.mvpScore(b)-this.mvpScore(a)).map(row).join('') + '</table>';
    this.els.endStats.innerHTML = mvpBanner + '<div class="endTables">' + side('blue', 'Blue Team') + side('red', 'Red Team') + '</div>';
  },

  // ---------- per-frame HUD refresh ----------
  update() {
    if (!G.running) return;
    const p = G.player;

    // top bar
    const m = Math.floor(G.time / 60), s = Math.floor(G.time % 60);
    this.els.topTimer.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    this.els.topBlue.textContent = G.kills.blue;
    this.els.topRed.textContent = G.kills.red;
    // team gold totals flanking the kill score, like MLBB's top bar
    if (!this.tgBlue) {
      const tb = document.getElementById('topbar');
      if (tb) {
        this.tgBlue = document.createElement('span'); this.tgBlue.className = 'tGold';
        this.tgRed = document.createElement('span'); this.tgRed.className = 'tGold';
        tb.insertBefore(this.tgBlue, tb.firstChild);
        tb.appendChild(this.tgRed);
      }
    }
    if (this.tgBlue && (this._tgT === undefined || G.time - this._tgT > 0.5)) {
      this._tgT = G.time;
      const sum = t => Math.round(G.heroes.filter(h => h.team === t)
        .reduce((a, h) => a + h.gold, 0) / 100) / 10;
      this.tgBlue.textContent = '◆' + sum('blue') + 'k';
      this.tgRed.textContent = '◆' + sum('red') + 'k';
    }
    // team head strips: HP fills, dead grey-out + respawn countdown
    if (this.headEls) {
      for (const e of this.headEls) {
        e.fill.style.width = Math.round(clamp(e.h.hp / e.h.hpMax(), 0, 1) * 100) + '%';
        const dead = e.h.dead;
        e.cell.classList.toggle('down', dead);
        e.dead.textContent = dead ? Math.ceil(e.h.respawnT) : '';
      }
    }
    this.els.goldVal.textContent = Math.floor(p.gold);
    this.els.kdaVal.textContent = p.kills + '/' + p.deaths + '/' + p.assists;
    this.els.csVal.textContent = p.cs;

    // bars
    this.els.hpFill.style.width = clamp(p.hp / p.hpMax() * 100, 0, 100) + '%';
    this.els.mpFill.style.width = clamp(p.mana / p.manaMax * 100, 0, 100) + '%';
    const hpNum = document.getElementById('hpNum'), mpNum = document.getElementById('mpNum');
    if (hpNum) hpNum.textContent = Math.ceil(p.hp) + ' / ' + Math.ceil(p.hpMax());
    if (mpNum) mpNum.textContent = Math.ceil(p.mana) + ' / ' + Math.ceil(p.manaMax);
    this.els.xpFill.style.width = clamp(p.xp / xpToNext(p.level) * 100, 0, 100) + '%';
    this.els.lvlBadge.textContent = p.level;

    // skill buttons
    if (this.skillEls) {
      this.skillEls.forEach((b, i) => {
        const sk = p.def.skills[i];
        const locked = !p.skillUnlocked(i);
        b.querySelector('.lock').style.display = locked ? 'flex' : 'none';
        const cd = p.cds[i];
        const ov = b.querySelector('.cdOverlay');
        const tx = b.querySelector('.cdText');
        if (cd > 0) {
          const frac = clamp(cd / (sk.cd * (1 - p.cdr) * (1 - 0.05*(p.skillLv[i]-1))), 0, 1);
          ov.style.background = 'conic-gradient(rgba(0,0,0,0.76) ' + (frac * 360) + 'deg, transparent 0deg)';
          tx.textContent = cd > 1 ? Math.ceil(cd) : cd.toFixed(1);
        } else { ov.style.background = 'none'; tx.textContent = ''; }
        b.classList.toggle('noMana', !locked && p.mana < sk.mana);
        b.classList.toggle('ready', !locked && cd <= 0 && p.mana >= sk.mana && !p.dead);

        const pips = b.querySelectorAll('.pips i');
        pips.forEach((pip, pi) => pip.classList.toggle('lit', pi < p.skillLv[i]));
        const canUp = p.skillPoints > 0 && p.canUpgrade(i);
        b.classList.toggle('canUp', canUp);
        b.querySelector('.upBadge').style.display = canUp ? 'flex' : 'none';
      });
    }
    this.els.lvlBadge.classList.toggle('hasPoints', p.skillPoints > 0);

    // battle-spell button
    if (this.spellBtn && p.battleSpell) {
      const sp = battleSpellById(p.battleSpell);
      const ov = this.spellBtn.querySelector('.cdOverlay');
      const tx = this.spellBtn.querySelector('.cdText');
      if (p.bsCd > 0 && sp) {
        const frac = clamp(p.bsCd / (sp.cd * (1 - p.cdr * 0.5)), 0, 1);
        ov.style.background = 'conic-gradient(rgba(0,0,0,0.76) ' + (frac * 360) + 'deg, transparent 0deg)';
        tx.textContent = Math.ceil(p.bsCd);
      } else { ov.style.background = 'none'; tx.textContent = ''; }
      this.spellBtn.classList.toggle('ready', p.bsCd <= 0 && !p.dead);
    }

    // active-buff indicator
    if (this.buffRow) {
      const icons = {
        buff_crimson: ['⚔', '#ff6a4d'], buff_azure: ['◆', '#4db8ff'],
        bosspower: ['☯', '#c77dff'], sprint: ['»', '#7dff9b'],
      };
      let html = '';
      for (const b of p.buffs) {
        const ic = icons[b.id];
        if (ic) html += '<span class="buffPip" style="border-color:' + ic[1] + ';color:' + ic[1] +
          '">' + ic[0] + '<b>' + Math.ceil(b.t) + '</b></span>';
      }
      this.buffRow.innerHTML = html;
    }

    // objective (Void Behemoth) timer
    if (this.objTimer) {
      const alive = G.boss && !G.boss.dead;
      const b = this.objTimer.querySelector('b');
      if (alive) {
        this.objTimer.classList.add('up');
        b.textContent = 'UP';
      } else {
        this.objTimer.classList.remove('up');
        const t = Math.max(0, G.bossTimer);
        const bm = Math.floor(t / 60), bs = Math.floor(t % 60);
        b.textContent = bm + ':' + (bs < 10 ? '0' : '') + bs;
      }
    }

    // low-HP warning vignette
    this.els.lowHp.style.opacity = (!p.dead && p.hp < p.hpMax() * 0.3) ? 1 : 0;

    // buy button
    const next = p.nextBuildItem();
    const bb = this.els.btnBuy;
    if (next) {
      bb.style.display = 'flex';
      bb.innerHTML = '<span class="itIcon">' + next.icon + '</span><span class="cost">' + next.cost + '</span>';
      bb.classList.toggle('afford', p.gold >= next.cost);
    } else bb.style.display = 'none';

    // items row: drawn category emblems for each owned item (+ empty slots)
    const row = this.els.itemsRow;
    const sig = p.items.map(i => i.id).join(',');
    if (this._itemSig !== sig) {
      this._itemSig = sig;
      row.innerHTML = '';
      for (let s = 0; s < CFG.maxItems; s++) {
        const it = p.items[s];
        const slot = document.createElement('span');
        slot.className = 'itemSlot' + (it ? '' : ' empty');
        if (it) {
          const cv = document.createElement('canvas');
          cv.width = 30; cv.height = 30;
          this.drawItemIcon(cv, this.itemCat(it));
          slot.appendChild(cv);
          slot.title = it.name + ' — ' + it.desc;
        }
        row.appendChild(slot);
      }
    }

    // death overlay
    if (p.dead) {
      this.els.deathOverlay.style.display = 'flex';
      this.els.deathTimer.textContent = Math.ceil(p.respawnT);
    } else this.els.deathOverlay.style.display = 'none';

    this.drawMinimap();
  },

  drawMinimap() {
    const c = this.mmCtx, S = this.mmCanvas.width / WORLD;
    c.fillStyle = '#0b140f';
    c.fillRect(0, 0, this.mmCanvas.width, this.mmCanvas.height);
    // real terrain art as the minimap base, like MLBB's painted minimap
    if (typeof mapCanvas !== 'undefined' && mapCanvas) {
      c.globalAlpha = 0.92;
      c.drawImage(mapCanvas, 0, 0, this.mmCanvas.width, this.mmCanvas.height);
      c.globalAlpha = 1;
    }
    // lanes
    c.strokeStyle = 'rgba(210,190,150,0.25)';
    c.lineWidth = 5; c.lineCap = 'round';
    for (const lane of Object.values(LANES)) {
      c.beginPath();
      c.moveTo(lane[0][0]*S, lane[0][1]*S);
      for (const pnt of lane) c.lineTo(pnt[0]*S, pnt[1]*S);
      c.stroke();
    }
    // towers + cores
    for (const t of G.towers) {
      if (t.dead) continue;
      c.fillStyle = TEAM_COLOR[t.team];
      c.fillRect(t.x*S - 3, t.y*S - 3, 6, 6);
    }
    for (const team of ['blue', 'red']) {
      const core = G.cores[team];
      if (core.dead) continue;
      c.fillStyle = TEAM_COLOR[team];
      c.beginPath(); c.arc(core.x*S, core.y*S, 5, 0, 7); c.fill();
    }
    // buff camps (coloured; hollow while respawning)
    for (const cc of G.camps) {
      if (!cc.camp.buff) continue;
      const col = (typeof BUFF_CAMPS !== 'undefined' && BUFF_CAMPS[cc.camp.buff]) ? BUFF_CAMPS[cc.camp.buff].color : '#c77dff';
      const alive = cc.mon && !cc.mon.dead;
      const bx = cc.camp.x*S, by = cc.camp.y*S;
      c.beginPath(); c.arc(bx, by, 3.5, 0, 7);
      if (alive) { c.fillStyle = col; c.fill(); }
      else { c.strokeStyle = col; c.lineWidth = 1.5; c.globalAlpha = 0.5; c.stroke(); c.globalAlpha = 1; }
    }
    // boss
    if (G.boss && !G.boss.dead) {
      c.fillStyle = '#c77dff';
      c.beginPath(); c.arc(G.boss.x*S, G.boss.y*S, 5, 0, 7); c.fill();
      c.strokeStyle = '#e0aaff'; c.lineWidth = 1.5; c.stroke();
    }
    // tap-to-move destination marker
    if (G.player && G.player.navTarget) {
      const nx = G.player.navTarget.x*S, ny = G.player.navTarget.y*S;
      const pulse = 3 + Math.sin(G.time*8)*1.5;
      c.strokeStyle = '#7df9ff'; c.lineWidth = 1.5;
      c.beginPath(); c.arc(nx, ny, pulse, 0, 7); c.stroke();
    }
    // fog of war (dims terrain/structures outside explored & current vision;
    // hero markers are drawn on top so allies and spotted enemies stay crisp)
    if (typeof fogMask !== 'undefined' && fogMask) {
      c.drawImage(fogMask, 0, 0, this.mmCanvas.width, this.mmCanvas.height);
    }
    // heroes: initial-letter badges (MOBA minimap convention), player ringed white
    for (const h of G.heroes) {
      if (h.dead) continue;
      if (h.team !== G.player.team && !isVisibleTo(h, G.player)) continue;
      const r = h.isPlayer ? 6 : 5.2;
      c.fillStyle = TEAM_COLOR[h.team];
      c.beginPath(); c.arc(h.x*S, h.y*S, r, 0, 7); c.fill();
      c.strokeStyle = h.isPlayer ? '#ffffff' : 'rgba(0,0,0,0.55)';
      c.lineWidth = h.isPlayer ? 1.6 : 1;
      c.beginPath(); c.arc(h.x*S, h.y*S, r, 0, 7); c.stroke();
      c.fillStyle = '#06111c';
      c.font = 'bold 7px Rajdhani, sans-serif';
      c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillText(HERO_INITIAL[h.def.id] || '?', h.x*S, h.y*S + 0.5);
    }
    // view box
    const cv = this.canvas, z = G.cam.zoom;
    c.strokeStyle = 'rgba(255,255,255,0.3)';
    c.lineWidth = 1;
    c.strokeRect((G.cam.x - cv.width/2/z)*S, (G.cam.y - cv.height/2/(z*YS))*S, cv.width/z*S, cv.height/(z*YS)*S);
  },
};
