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
      'heroGrid','btnStart','selInfo','lowHp'];
    for (const id of ids) this.els[id] = document.getElementById(id);

    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.buildHeroSelect();
    this.bindJoystick();
    this.bindButtons();
    this.bindKeyboard();
  },

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = window.innerWidth * dpr;
    this.canvas.height = window.innerHeight * dpr;
    this.canvas.style.width = window.innerWidth + 'px';
    this.canvas.style.height = window.innerHeight + 'px';
  },

  // ---------- hero select ----------
  selectedHero: 'kael',
  buildHeroSelect() {
    const grid = this.els.heroGrid;
    grid.innerHTML = '';
    for (const h of HEROES) {
      const card = document.createElement('div');
      card.className = 'heroCard';
      card.dataset.id = h.id;
      const cv = document.createElement('canvas');
      cv.width = 120; cv.height = 120;
      const c = cv.getContext('2d');
      c.translate(60, 60);
      const g = c.createRadialGradient(-10, -10, 8, 0, 0, 42);
      g.addColorStop(0, lighten(h.color, 0.35)); g.addColorStop(1, h.color);
      c.fillStyle = g;
      c.beginPath(); c.arc(0, 0, 42, 0, 7); c.fill();
      c.translate(-60, -60);
      drawHeroGlyph(c, h.id, 60, 60, 42, -Math.PI/2);
      card.appendChild(cv);
      const nm = document.createElement('div');
      nm.className = 'heroName';
      nm.textContent = h.name;
      const rl = document.createElement('div');
      rl.className = 'heroRole';
      rl.textContent = h.role;
      card.appendChild(nm); card.appendChild(rl);
      card.addEventListener('click', () => {
        this.selectedHero = h.id;
        document.querySelectorAll('.heroCard').forEach(x => x.classList.toggle('sel', x.dataset.id === h.id));
        this.els.selInfo.innerHTML =
          '<b>' + h.name + ' — ' + h.title + '</b> · ' + h.role + '<br>' +
          '<span class="passive">Passive: ' + h.passive + '</span><br>' +
          h.skills.map((s, i) => '<span class="sk"><b>' + ['S1','S2','ULT'][i] + ' ' + s.name + ':</b> ' + s.desc + '</span>').join('<br>');
      });
      grid.appendChild(card);
    }
    grid.firstChild.click();
    this.els.btnStart.addEventListener('click', () => {
      Sfx.ensure();
      Game.start(this.selectedHero);
    });
  },

  onGameStart() {
    this.els.select.style.display = 'none';
    this.els.end.style.display = 'none';
    this.els.hud.style.display = 'block';
    this.buildSkillButtons();
    this.buildShop();
    // portrait glyph
    const c = this.els.portGlyph.getContext('2d');
    c.clearRect(0, 0, 64, 64);
    c.save();
    const h = G.player.def;
    const g = c.createRadialGradient(26, 26, 5, 32, 32, 26);
    g.addColorStop(0, lighten(h.color, 0.35)); g.addColorStop(1, h.color);
    c.fillStyle = g;
    c.beginPath(); c.arc(32, 32, 26, 0, 7); c.fill();
    c.restore();
    drawHeroGlyph(c, h.id, 32, 32, 26, -Math.PI/2);
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
      const b = document.createElement('div');
      b.className = 'skillBtn' + (i === 2 ? ' ult' : '');
      b.innerHTML = '<span class="icon">' + sk.icon + '</span><div class="cdOverlay"></div><div class="cdText"></div><div class="lock">🔒</div>';
      holder.appendChild(b);
      this.skillEls.push(b);
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
    const wy = (Input.mouse.y * dpr - this.canvas.height/2) / z + G.cam.y;
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

  feed(killer, victim, team) {
    const el = document.createElement('div');
    el.className = 'feedLine';
    el.innerHTML = '<span style="color:' + TEAM_COLOR[team] + '">' + killer + '</span> ⚔ <span>' + victim + '</span>';
    this.els.killfeed.appendChild(el);
    while (this.els.killfeed.children.length > 4) this.els.killfeed.firstChild.remove();
    setTimeout(() => el.remove(), 5000);
  },

  showEnd(won) {
    this.els.end.style.display = 'flex';
    this.els.endTitle.textContent = won ? 'VICTORY' : 'DEFEAT';
    this.els.endTitle.className = won ? 'win' : 'lose';
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
          ov.style.height = (cd / (sk.cd * (1 - p.cdr)) * 100) + '%';
          tx.textContent = cd > 1 ? Math.ceil(cd) : cd.toFixed(1);
        } else { ov.style.height = '0%'; tx.textContent = ''; }
        b.classList.toggle('noMana', !locked && p.mana < sk.mana);
        b.classList.toggle('ready', !locked && cd <= 0 && p.mana >= sk.mana && !p.dead);
      });
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
    // boss
    if (G.boss && !G.boss.dead) {
      c.fillStyle = '#c77dff';
      c.beginPath(); c.arc(G.boss.x*S, G.boss.y*S, 4, 0, 7); c.fill();
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
    c.strokeRect((G.cam.x - cv.width/2/z)*S, (G.cam.y - cv.height/2/z)*S, cv.width/z*S, cv.height/z*S);
  },
};
