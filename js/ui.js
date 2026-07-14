// ============================================================
// VOID LEGENDS — HUD, hero select, joystick, shop, scoreboard
// ============================================================
'use strict';

// ---------------- virtual joystick ----------------
class Joystick {
  constructor(zoneEl, baseEl, knobEl) {
    this.zone = zoneEl; this.base = baseEl; this.knob = knobEl;
    this.active = false;
    this.pointerId = null;
    this.vec = { x: 0, y: 0 };
    this.origin = { x: 0, y: 0 };
    this.RADIUS = 56;

    zoneEl.addEventListener('pointerdown', e => this.start(e));
    window.addEventListener('pointermove', e => this.move(e));
    window.addEventListener('pointerup', e => this.end(e));
    window.addEventListener('pointercancel', e => this.end(e));
  }
  start(e) {
    e.preventDefault();
    this.active = true;
    this.pointerId = e.pointerId;
    this.origin = { x: e.clientX, y: e.clientY };
    this.base.style.left = e.clientX + 'px';
    this.base.style.top = e.clientY + 'px';
    this.base.classList.add('visible');
    this.move(e);
  }
  move(e) {
    if (!this.active || e.pointerId !== this.pointerId) return;
    let dx = e.clientX - this.origin.x, dy = e.clientY - this.origin.y;
    const len = Math.hypot(dx, dy);
    if (len > this.RADIUS) { dx = dx / len * this.RADIUS; dy = dy / len * this.RADIUS; }
    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
    this.vec = len < 8 ? { x: 0, y: 0 } : { x: dx / this.RADIUS, y: dy / this.RADIUS };
  }
  end(e) {
    if (!this.active || e.pointerId !== this.pointerId) return;
    this.active = false;
    this.vec = { x: 0, y: 0 };
    this.knob.style.transform = 'translate(0px, 0px)';
    this.base.classList.remove('visible');
  }
}

// ---------------- hero portrait ----------------
function drawPortrait(canvas, def) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height, cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.36;
  const grad = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.4, r * 0.2, cx, cy, r * 1.4);
  grad.addColorStop(0, '#1e293b');
  grad.addColorStop(1, '#0b1220');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = def.color; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(cx, cy, r + 6, 0, 7); ctx.stroke();
  const body = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
  body.addColorStop(0, '#ffffff');
  body.addColorStop(0.25, def.color);
  body.addColorStop(1, def.color);
  ctx.fillStyle = body;
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fill();
  // glyph
  ctx.save();
  ctx.translate(cx, cy);
  ctx.strokeStyle = 'rgba(15,23,42,0.9)'; ctx.fillStyle = 'rgba(15,23,42,0.9)';
  ctx.lineWidth = 4; ctx.lineCap = 'round';
  const s = r * 0.62;
  const g = def.glyph;
  if (g === 'sword') {
    ctx.beginPath(); ctx.moveTo(-s * 0.6, s * 0.6); ctx.lineTo(s * 0.6, -s * 0.6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(-s * 0.1, -s * 0.5); ctx.lineTo(s * 0.5, s * 0.1); ctx.stroke();
  } else if (g === 'orb') {
    ctx.beginPath(); ctx.arc(0, 0, s * 0.55, 0, 7); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, s * 0.2, 0, 7); ctx.fill();
  } else if (g === 'shield') {
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.7); ctx.lineTo(s * 0.6, -s * 0.25); ctx.lineTo(s * 0.4, s * 0.55);
    ctx.lineTo(0, s * 0.8); ctx.lineTo(-s * 0.4, s * 0.55); ctx.lineTo(-s * 0.6, -s * 0.25);
    ctx.closePath(); ctx.stroke();
  } else if (g === 'arrow') {
    ctx.beginPath(); ctx.moveTo(-s * 0.6, s * 0.5); ctx.lineTo(s * 0.6, -s * 0.5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(s * 0.6, -s * 0.5); ctx.lineTo(s * 0.05, -s * 0.45);
    ctx.moveTo(s * 0.6, -s * 0.5); ctx.lineTo(s * 0.55, s * 0.1); ctx.stroke();
  } else if (g === 'lantern') {
    ctx.beginPath();
    ctx.moveTo(0, -s * 0.75); ctx.lineTo(s * 0.5, 0); ctx.lineTo(0, s * 0.75); ctx.lineTo(-s * 0.5, 0);
    ctx.closePath(); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, s * 0.18, 0, 7); ctx.fill();
  }
  ctx.restore();
}

// ---------------- UI controller ----------------
class UI {
  constructor() {
    this.$ = id => document.getElementById(id);
    this.flashQueue = [];
    this.game = null;
  }

  // ----- hero select -----
  showHeroSelect(onStart) {
    const grid = this.$('hero-grid');
    grid.innerHTML = '';
    let selected = null;
    const startBtn = this.$('btn-start');
    for (const id of HERO_IDS) {
      const def = HEROES[id];
      const card = document.createElement('div');
      card.className = 'hero-card';
      card.innerHTML = `
        <canvas width="150" height="120"></canvas>
        <div class="hc-name">${def.name}</div>
        <div class="hc-title">${def.title}</div>
        <div class="hc-role" style="color:${def.color}">${def.role}</div>
        <div class="hc-lore">${def.lore}</div>
        <div class="hc-skills">${def.skills.map(s => `<div><b>${s.name}</b> — ${s.desc}</div>`).join('')}</div>`;
      drawPortrait(card.querySelector('canvas'), def);
      card.addEventListener('click', () => {
        grid.querySelectorAll('.hero-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        selected = id;
        startBtn.disabled = false;
        startBtn.textContent = 'ENTER THE RIFT AS ' + def.name.toUpperCase();
      });
      grid.appendChild(card);
    }
    startBtn.disabled = true;
    startBtn.textContent = 'PICK YOUR HERO';
    startBtn.onclick = () => {
      if (!selected) return;
      this.$('hero-select').classList.add('hidden');
      onStart(selected);
    };
    this.$('hero-select').classList.remove('hidden');
  }

  // ----- in-game wiring -----
  bindGame(game, input) {
    this.game = game;
    this.$('hud').classList.remove('hidden');

    // skill buttons
    const skillBtns = [this.$('btn-s1'), this.$('btn-s2'), this.$('btn-ult')];
    skillBtns.forEach((btn, i) => {
      btn.querySelector('.sk-name').textContent = game.player.def.skills[i].name;
      btn.addEventListener('pointerdown', e => {
        e.preventDefault(); e.stopPropagation();
        game.castSkill(game.player, i);
      });
    });
    this.$('btn-attack').addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      input.attackTap();
    });
    this.$('btn-recall').addEventListener('pointerdown', e => {
      e.preventDefault(); game.player.startRecall(game);
    });
    this.$('btn-shop').addEventListener('pointerdown', e => {
      e.preventDefault(); this.toggleShop();
    });
    this.$('btn-score').addEventListener('pointerdown', e => {
      e.preventDefault(); this.toggleScoreboard();
    });
    this.$('shop-close').addEventListener('click', () => this.toggleShop(false));
    this.$('score-close').addEventListener('click', () => this.toggleScoreboard(false));
    this.buildShop();
  }

  buildShop() {
    const list = this.$('shop-items');
    list.innerHTML = '';
    for (const item of ITEMS) {
      const el = document.createElement('div');
      el.className = 'shop-item';
      el.innerHTML = `
        <div class="si-icon">${item.icon}</div>
        <div class="si-body">
          <div class="si-name">${item.name} <span class="si-cost">${item.cost}g</span></div>
          <div class="si-desc">${item.desc}</div>
        </div>
        <button class="si-buy">BUY</button>`;
      el.querySelector('.si-buy').addEventListener('click', () => {
        const p = this.game.player;
        if (p.items.length >= MAX_ITEMS) { this.flash('Inventory full'); return; }
        if (p.gold < item.cost) { this.flash('Not enough gold'); return; }
        p.buyItem(this.game, item);
      });
      list.appendChild(el);
    }
  }

  toggleShop(force) {
    const el = this.$('shop');
    const show = force !== undefined ? force : el.classList.contains('hidden');
    el.classList.toggle('hidden', !show);
    if (show) this.toggleScoreboard(false);
  }

  toggleScoreboard(force) {
    const el = this.$('scoreboard');
    const show = force !== undefined ? force : el.classList.contains('hidden');
    el.classList.toggle('hidden', !show);
    if (show) { this.toggleShop(false); this.renderScoreboard(); }
  }

  renderScoreboard() {
    const g = this.game;
    const rows = team => g.heroes
      .filter(h => h.team === team)
      .map(h => `
        <tr class="${h.isPlayer ? 'me' : ''}">
          <td><span class="dot" style="background:${h.def.color}"></span>${h.def.name}${h.isPlayer ? ' (You)' : ''}</td>
          <td>${h.level}</td>
          <td>${h.kills}/${h.deaths}/${h.assists}</td>
          <td>${Math.floor(h.gold)}g</td>
          <td>${h.items.map(it => it.icon).join(' ')}</td>
        </tr>`).join('');
    this.$('score-body').innerHTML = `
      <div class="score-team" style="color:${TEAM_COLORS[0]}">AZURE ${g.kills[0]}</div>
      <table><tr><th>Hero</th><th>Lv</th><th>K/D/A</th><th>Gold</th><th>Items</th></tr>${rows(0)}</table>
      <div class="score-team" style="color:${TEAM_COLORS[1]}">CRIMSON ${g.kills[1]}</div>
      <table><tr><th>Hero</th><th>Lv</th><th>K/D/A</th><th>Gold</th><th>Items</th></tr>${rows(1)}</table>`;
  }

  // ----- messages -----
  flash(msg) {
    const area = this.$('flash-area');
    while (area.children.length >= 4) area.firstChild.remove();
    const el = document.createElement('div');
    el.className = 'flash-msg';
    el.textContent = msg;
    area.appendChild(el);
    setTimeout(() => el.classList.add('out'), 1700);
    setTimeout(() => el.remove(), 2300);
  }

  killFeed(killer, victim, killerTeam) {
    const el = document.createElement('div');
    el.className = 'kf-row';
    el.innerHTML = `<span style="color:${TEAM_COLORS[killerTeam]}">${killer}</span> ⚔ <span style="color:${TEAM_COLORS[1 - killerTeam]}">${victim}</span>`;
    const feed = this.$('killfeed');
    feed.appendChild(el);
    while (feed.children.length > 4) feed.firstChild.remove();
    setTimeout(() => el.remove(), 6000);
  }

  // ----- per-frame HUD -----
  updateHUD(game) {
    const p = game.player;
    this.$('hud-time').textContent = fmtTime(game.time);
    this.$('hud-kills').textContent = `${game.kills[0]}  —  ${game.kills[1]}`;
    this.$('hud-gold').textContent = Math.floor(p.gold);
    this.$('hud-kda').textContent = `${p.kills}/${p.deaths}/${p.assists}`;
    this.$('hud-level').textContent = p.level;
    this.$('bar-hp').style.width = clamp(p.hp / p.maxHp * 100, 0, 100) + '%';
    this.$('bar-mana').style.width = clamp(p.mana / p.maxMana * 100, 0, 100) + '%';
    this.$('bar-hp-text').textContent = `${Math.ceil(p.hp)} / ${Math.ceil(p.maxHp)}`;

    // xp progress ring not needed — show xp bar
    const prev = XP_TABLE[p.level - 1] ?? 0;
    const next = XP_TABLE[p.level] ?? XP_TABLE[XP_TABLE.length - 1];
    const frac = p.level >= MAX_LEVEL ? 1 : (p.xp - prev) / Math.max(1, next - prev);
    this.$('bar-xp').style.width = clamp(frac * 100, 0, 100) + '%';

    // skills
    const btns = [this.$('btn-s1'), this.$('btn-s2'), this.$('btn-ult')];
    btns.forEach((btn, i) => {
      const sk = p.def.skills[i];
      const cdEl = btn.querySelector('.sk-cd');
      const locked = i === 2 && !p.ultReady();
      const noMana = p.mana < sk.mana;
      if (locked) { cdEl.textContent = '🔒'; cdEl.style.display = 'flex'; }
      else if (p.cooldowns[i] > 0) { cdEl.textContent = Math.ceil(p.cooldowns[i]); cdEl.style.display = 'flex'; }
      else { cdEl.style.display = 'none'; }
      btn.classList.toggle('nomana', !locked && p.cooldowns[i] <= 0 && noMana);
    });

    // items strip
    const strip = this.$('item-strip');
    const owned = p.items.map(it => `<span class="item-chip" title="${it.name}">${it.icon}</span>`).join('');
    if (strip.dataset.last !== owned) { strip.innerHTML = owned; strip.dataset.last = owned; }

    // respawn overlay
    const ro = this.$('respawn-overlay');
    if (p.dead) {
      ro.classList.remove('hidden');
      this.$('respawn-timer').textContent = Math.ceil(p.respawnTimer);
    } else ro.classList.add('hidden');
  }

  showEnd(game, won) {
    const el = this.$('end-screen');
    el.classList.remove('hidden');
    this.$('end-title').textContent = won ? 'VICTORY' : 'DEFEAT';
    this.$('end-title').className = won ? 'victory' : 'defeat';
    const p = game.player;
    this.$('end-stats').innerHTML =
      `${p.def.name} — Level ${p.level} · ${p.kills}/${p.deaths}/${p.assists} · ${fmtTime(game.time)}`;
    this.$('btn-again').onclick = () => location.reload();
  }
}
