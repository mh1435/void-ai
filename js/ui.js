// ============================================================
// VOID ARENA — Input, HUD, joystick, skill buttons, minimap, shop, SFX
// ============================================================

const Input = {
  keys: {},
  joy: { active: false, dx: 0, dy: 0 },
  attackHeld: false,
  mouse: { x: 0, y: 0 },
};

// ---------------- Sound (tiny WebAudio synth) ----------------
const Sfx = {
  ctx: null, on: true,
  ensure() {
    if (!this.ctx) {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { this.on = false; }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(freq, dur, type, vol, slide) {
    if (!this.on || !this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
    g.gain.setValueAtTime(vol || 0.08, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(t); o.stop(t + dur);
  },
  play(name) {
    if (!this.ctx) return;
    switch (name) {
      case 'attack': this.tone(220, 0.06, 'square', 0.04); break;
      case 'bolt': this.tone(600, 0.12, 'sawtooth', 0.05, -300); break;
      case 'skill': this.tone(440, 0.15, 'triangle', 0.07, 200); break;
      case 'dash': this.tone(300, 0.15, 'sine', 0.07, 500); break;
      case 'slam': this.tone(120, 0.25, 'square', 0.09, -60); break;
      case 'shield': this.tone(500, 0.2, 'sine', 0.06, 250); break;
      case 'ult': this.tone(200, 0.35, 'sawtooth', 0.08, 400); break;
      case 'kill': this.tone(880, 0.15, 'square', 0.08); setTimeout(()=>this.tone(1175, 0.25, 'square', 0.08), 120); break;
      case 'death': this.tone(300, 0.5, 'sawtooth', 0.08, -200); break;
      case 'tower': this.tone(90, 0.6, 'square', 0.1, -40); break;
      case 'level': this.tone(523, 0.1, 'square', 0.06); setTimeout(()=>this.tone(784, 0.2, 'square', 0.06), 100); break;
      case 'buy': this.tone(700, 0.08, 'sine', 0.06, 300); break;
      case 'recall': this.tone(400, 0.4, 'sine', 0.07, 400); break;
      case 'boss': this.tone(80, 0.8, 'sawtooth', 0.1, 30); break;
      case 'victory': [523,659,784,1046].forEach((f,i)=>setTimeout(()=>this.tone(f,0.3,'square',0.08), i*150)); break;
      case 'defeat': [400,350,300,250].forEach((f,i)=>setTimeout(()=>this.tone(f,0.35,'sawtooth',0.07), i*180)); break;
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
      const g = c.createRadialGradient(120, 78, 10, 120, 110, 140);
      g.addColorStop(0, lighten(h.color, 0.14));
      g.addColorStop(0.65, 'rgba(20,30,45,0.35)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      c.globalAlpha = 0.55; c.fillStyle = g;
      c.beginPath(); c.arc(120, 105, 130, 0, 7); c.fill();
      c.globalAlpha = 1;
      drawHeroCardArt(c, h, 120, 196, 3.1);
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
    this.buildSkillButtons();
    this.buildSpellButton();
    this.buildBuffRow();
    this.buildObjTimer();
    if (this.spellBtn) {
      const sp = battleSpellById(G.player.battleSpell);
      this.spellBtn.querySelector('.icon').textContent = sp ? sp.icon : '';
      this.spellBtn.title = sp ? sp.name : '';
    }
    this.buildShop();
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
      b.innerHTML = '<span class="icon">' + sk.icon + '</span><div class="cdOverlay"></div><div class="cdText"></div>' +
        '<div class="lock">🔒</div><div class="upBadge">+</div>' +
        '<div class="pips">' + Array.from({length: maxLv}, () => '<i></i>').join('') + '</div>';
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
    b.innerHTML = '<span class="icon"></span><div class="cdOverlay"></div><div class="cdText"></div>';
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
  buildShop() {
    const grid = this.els.shopGrid;
    grid.innerHTML = '';
    for (const it of ITEMS) {
      const d = document.createElement('div');
      d.className = 'shopItem';
      d.dataset.id = it.id;
      d.innerHTML = '<span class="itIcon">' + it.icon + '</span><div class="itName">' + it.name + '</div>' +
        '<div class="itDesc">' + it.desc + '</div><div class="itCost">' + it.cost + 'g</div>';
      d.addEventListener('click', () => {
        if (G.player.buyItem(it)) {
          const bi = G.player.def.build[G.player.buildIdx];
          if (bi === it.id) G.player.buildIdx++;
          this.refreshShop();
        }
      });
      grid.appendChild(d);
    }
  },

  refreshShop() {
    if (this.els.shopPanel.style.display !== 'block') return;
    this.els.shopGold.textContent = Math.floor(G.player.gold) + ' gold';
    document.querySelectorAll('.shopItem').forEach(el => {
      const it = itemById(el.dataset.id);
      el.classList.toggle('afford', G.player.gold >= it.cost && G.player.items.length < CFG.maxItems);
    });
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

  // performance score used for MVP + medals (rewards kills/assists/objectives,
  // penalises deaths) — the same idea as MLBB's post-game rating
  mvpScore(h) {
    return h.kills*4 + h.assists*2 - h.deaths*1.5 + h.cs*0.03 + h.level*0.8 + Math.floor(h.gold)*0.001;
  },

  showEnd(won) {
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
    this.els.goldVal.textContent = Math.floor(p.gold);
    this.els.kdaVal.textContent = p.kills + '/' + p.deaths + '/' + p.assists;
    this.els.csVal.textContent = p.cs;

    // bars
    this.els.hpFill.style.width = clamp(p.hp / p.hpMax() * 100, 0, 100) + '%';
    this.els.mpFill.style.width = clamp(p.mana / p.manaMax * 100, 0, 100) + '%';
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

    // items row
    this.els.itemsRow.textContent = p.items.map(i => i.icon).join(' ');

    // death overlay
    if (p.dead) {
      this.els.deathOverlay.style.display = 'flex';
      this.els.deathTimer.textContent = Math.ceil(p.respawnT);
    } else this.els.deathOverlay.style.display = 'none';

    this.drawMinimap();
  },

  drawMinimap() {
    const c = this.mmCtx, S = this.mmCanvas.width / WORLD;
    c.fillStyle = 'rgba(8,14,20,0.85)';
    c.fillRect(0, 0, this.mmCanvas.width, this.mmCanvas.height);
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
    // heroes
    for (const h of G.heroes) {
      if (h.dead) continue;
      if (h.team !== G.player.team && !isVisibleTo(h, G.player)) continue;
      c.fillStyle = h.isPlayer ? '#fff' : TEAM_COLOR[h.team];
      c.beginPath(); c.arc(h.x*S, h.y*S, h.isPlayer ? 4 : 3, 0, 7); c.fill();
    }
    // view box
    const cv = this.canvas, z = G.cam.zoom;
    c.strokeStyle = 'rgba(255,255,255,0.3)';
    c.lineWidth = 1;
    c.strokeRect((G.cam.x - cv.width/2/z)*S, (G.cam.y - cv.height/2/(z*YS))*S, cv.width/z*S, cv.height/(z*YS)*S);
  },
};
