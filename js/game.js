// ============================================================
// VOID LEGENDS — game state, simulation loop & world rendering
// ============================================================
'use strict';

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Game {
  constructor(canvas, ui, playerHeroId) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.ui = ui;
    this.time = 0;
    this.over = false;
    this.winner = -1;
    this.kills = [0, 0];
    this.playerTeam = TEAM_BLUE;

    this.heroes = [];
    this.minions = [];
    this.towers = TOWER_DEFS.map(d => new Tower(d));
    this.cores = [new Core(TEAM_BLUE), new Core(TEAM_RED)];
    this.jungles = [];
    this.projectiles = [];
    this.zones = [];
    this.effects = [];
    this.timers = [];
    this.campTimers = [];
    this.nextWaveAt = FIRST_WAVE_AT;

    // rosters — player + 4 bots vs 5 bots
    const botLanes = ['top', 'bot', 'bot', 'top'];
    const enemyLanes = ['top', 'mid', 'bot', 'bot', 'top'];
    const pool = HERO_IDS.filter(id => id !== playerHeroId);
    this.player = new Hero(TEAM_BLUE, playerHeroId, true);
    this.heroes.push(this.player);
    for (let i = 0; i < 4; i++) {
      const h = new Hero(TEAM_BLUE, pool[i % pool.length], false);
      attachBotAI(h, botLanes[i]);
      this.heroes.push(h);
    }
    for (let i = 0; i < 5; i++) {
      const h = new Hero(TEAM_RED, HERO_IDS[i % HERO_IDS.length], false);
      attachBotAI(h, enemyLanes[i]);
      this.heroes.push(h);
    }

    for (const camp of JUNGLE_CAMPS) this.jungles.push(new JungleMonster(camp, 0));

    this.camX = 0; this.camY = 0;
    this.mapCanvas = this.renderMapTexture();
  }

  // ---------------- queries ----------------
  allTargets(team) {
    const out = [];
    for (const h of this.heroes) if (h.team !== team && !h.dead) out.push(h);
    for (const m of this.minions) if (m.team !== team && !m.dead) out.push(m);
    for (const t of this.towers) if (t.team !== team && !t.dead) out.push(t);
    for (const c of this.cores) if (c.team !== team && !c.dead) out.push(c);
    if (team !== -1) for (const j of this.jungles) if (!j.dead) out.push(j);
    return out;
  }

  nearestEnemy(unit, range, kinds) {
    let best = null, bestD = range;
    for (const u of this.allTargets(unit.team)) {
      if (kinds && !kinds.includes(u.kind)) continue;
      const d = distU(unit, u) - u.radius;
      if (d < bestD) { bestD = d; best = u; }
    }
    return best;
  }

  // ML-style smart aim for the player: nearest enemy hero, then anything, then facing
  aimFor(hero) {
    const h = this.nearestEnemy(hero, 640, ['hero']);
    if (h) return { x: h.x, y: h.y };
    const any = this.nearestEnemy(hero, 540, ['minion', 'tower', 'core', 'jungle']);
    if (any) return { x: any.x, y: any.y };
    const mi = hero.moveInput;
    const d = (mi.x || mi.y) ? norm(mi.x, mi.y) : { x: Math.cos(hero.facing), y: Math.sin(hero.facing) };
    return { x: hero.x + d.x * 400, y: hero.y + d.y * 400 };
  }

  castSkill(hero, i, aim) {
    if (this.over || !hero.canCast(i)) return false;
    const sk = hero.def.skills[i];
    hero.mana -= sk.mana;
    hero.cooldowns[i] = sk.cd;
    hero.interruptRecall();
    sk.cast(this, hero, aim || this.aimFor(hero));
    return true;
  }

  schedule(delay, fn) { this.timers.push({ t: this.time + delay, fn }); }
  scheduleCampRespawn(camp) { this.campTimers.push({ camp, t: this.time + JUNGLE_STATS.respawn }); }
  addEffect(e) { this.effects.push(e); if (e.ttl0 === undefined) e.ttl0 = e.ttl; }

  spawnWave() {
    const minute = this.time / 60;
    if (this.minions.length > 150) return;   // safety cap
    for (const lane of LANE_NAMES) {
      for (const team of [TEAM_BLUE, TEAM_RED]) {
        for (let i = 0; i < 3; i++) this.minions.push(new Minion(team, lane, false, minute));
        for (let i = 0; i < 2; i++) this.minions.push(new Minion(team, lane, true, minute));
      }
    }
  }

  endGame(winnerTeam) {
    if (this.over) return;
    this.over = true;
    this.winner = winnerTeam;
    this.ui.showEnd(this, winnerTeam === this.playerTeam);
  }

  // ---------------- simulation ----------------
  update(dt) {
    if (this.over) { this.updateFx(dt); return; }
    this.time += dt;

    if (this.time >= this.nextWaveAt) { this.nextWaveAt += WAVE_INTERVAL; this.spawnWave(); }

    for (let i = this.timers.length - 1; i >= 0; i--) {
      if (this.time >= this.timers[i].t) { const f = this.timers[i].fn; this.timers.splice(i, 1); f(); }
    }
    for (let i = this.campTimers.length - 1; i >= 0; i--) {
      if (this.time >= this.campTimers[i].t) {
        this.jungles.push(new JungleMonster(this.campTimers[i].camp, this.time / 60));
        this.campTimers.splice(i, 1);
      }
    }

    for (const h of this.heroes) {
      if (!h.isPlayer) updateBot(this, h, dt);
      h.update(this, dt);
    }
    for (const m of this.minions) m.update(this, dt);
    for (const t of this.towers) t.update(this, dt);
    for (const j of this.jungles) j.update(this, dt);
    for (const p of this.projectiles) p.update(this, dt);
    for (const z of this.zones) z.update(this, dt);

    this.minions = this.minions.filter(m => !m.dead);
    this.jungles = this.jungles.filter(j => !j.dead);
    this.projectiles = this.projectiles.filter(p => !p.done);
    this.zones = this.zones.filter(z => !z.done);
    this.updateFx(dt);
  }

  updateFx(dt) {
    for (const e of this.effects) e.ttl -= dt;
    this.effects = this.effects.filter(e => e.ttl > 0);
  }

  // ---------------- map texture (pre-rendered once) ----------------
  renderMapTexture() {
    const S = 0.5, size = WORLD * S;
    const c = document.createElement('canvas');
    c.width = size; c.height = size;
    const g = c.getContext('2d');
    g.scale(S, S);
    const rnd = mulberry32(1337);

    // grass base
    g.fillStyle = '#152b1c';
    g.fillRect(0, 0, WORLD, WORLD);
    for (let i = 0; i < 900; i++) {
      const x = rnd() * WORLD, y = rnd() * WORLD, r = 20 + rnd() * 90;
      g.fillStyle = rnd() < 0.5 ? 'rgba(30,58,36,0.35)' : 'rgba(16,34,22,0.4)';
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }

    // river along the x = y diagonal
    g.strokeStyle = 'rgba(38,92,132,0.9)';
    g.lineWidth = 210; g.lineCap = 'round';
    g.beginPath(); g.moveTo(240, 240); g.lineTo(WORLD - 240, WORLD - 240); g.stroke();
    g.strokeStyle = 'rgba(96,165,250,0.25)';
    g.lineWidth = 150;
    g.beginPath(); g.moveTo(240, 240); g.lineTo(WORLD - 240, WORLD - 240); g.stroke();

    // lanes
    const drawLane = (pts, w, color) => {
      g.strokeStyle = color; g.lineWidth = w;
      g.lineJoin = 'round'; g.lineCap = 'round';
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.stroke();
    };
    for (const lane of LANE_NAMES) drawLane(LANES[lane], 170, 'rgba(78,84,60,0.95)');
    for (const lane of LANE_NAMES) drawLane(LANES[lane], 140, 'rgba(122,124,88,0.9)');

    // helper: distance from point to a polyline
    const distToLane = (x, y) => {
      let best = Infinity;
      for (const lane of LANE_NAMES) {
        const pts = LANES[lane];
        for (let i = 0; i < pts.length - 1; i++) {
          const [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
          const dx = x2 - x1, dy = y2 - y1, l2 = dx * dx + dy * dy || 1;
          const t = clamp(((x - x1) * dx + (y - y1) * dy) / l2, 0, 1);
          best = Math.min(best, dist(x, y, x1 + dx * t, y1 + dy * t));
        }
      }
      return best;
    };

    // jungle trees (kept off lanes, river, bases and camps)
    for (let i = 0; i < 420; i++) {
      const x = 120 + rnd() * (WORLD - 240), y = 120 + rnd() * (WORLD - 240);
      if (distToLane(x, y) < 165) continue;
      if (Math.abs(x - y) < 200) continue;                       // river
      if (dist(x, y, BASE_POS[0].x, BASE_POS[0].y) < 430) continue;
      if (dist(x, y, BASE_POS[1].x, BASE_POS[1].y) < 430) continue;
      let nearCamp = false;
      for (const cp of JUNGLE_CAMPS) if (dist(x, y, cp.x, cp.y) < 130) nearCamp = true;
      if (nearCamp) continue;
      const r = 16 + rnd() * 22;
      g.fillStyle = 'rgba(8,20,12,0.55)';
      g.beginPath(); g.arc(x + 4, y + 6, r, 0, 7); g.fill();
      g.fillStyle = rnd() < 0.5 ? '#1e4428' : '#255232';
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.06)';
      g.beginPath(); g.arc(x - r * 0.3, y - r * 0.3, r * 0.5, 0, 7); g.fill();
    }

    // jungle camp pads
    for (const cp of JUNGLE_CAMPS) {
      g.fillStyle = 'rgba(70,52,36,0.55)';
      g.beginPath(); g.arc(cp.x, cp.y, 90, 0, 7); g.fill();
    }

    // base pads
    for (const team of [TEAM_BLUE, TEAM_RED]) {
      const b = BASE_POS[team];
      g.fillStyle = team === TEAM_BLUE ? 'rgba(37,99,235,0.25)' : 'rgba(220,38,38,0.25)';
      g.beginPath(); g.arc(b.x, b.y, 330, 0, 7); g.fill();
      g.strokeStyle = team === TEAM_BLUE ? 'rgba(96,165,250,0.5)' : 'rgba(248,113,113,0.5)';
      g.lineWidth = 10;
      g.beginPath(); g.arc(b.x, b.y, 330, 0, 7); g.stroke();
    }
    return c;
  }

  // ---------------- rendering ----------------
  draw() {
    const ctx = this.ctx;
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;

    // camera follows player
    const focus = this.player;
    this.camX = clamp(focus.x - w / 2, 0, WORLD - w);
    this.camY = clamp(focus.y - h / 2, 0, WORLD - h);

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0a1410';
    ctx.fillRect(0, 0, w, h);
    ctx.translate(-this.camX, -this.camY);

    ctx.drawImage(this.mapCanvas, 0, 0, WORLD, WORLD);

    for (const z of this.zones) this.drawZone(ctx, z);
    for (const t of this.towers) if (!t.dead) this.drawTower(ctx, t);
    for (const c of this.cores) if (!c.dead) this.drawCore(ctx, c);
    for (const j of this.jungles) this.drawJungle(ctx, j);
    for (const m of this.minions) this.drawMinion(ctx, m);
    for (const hero of this.heroes) if (!hero.dead) this.drawHero(ctx, hero);
    for (const p of this.projectiles) this.drawProjectile(ctx, p);
    for (const e of this.effects) this.drawEffect(ctx, e);

    ctx.restore();
  }

  drawHealthBar(ctx, u, color, width, showMana) {
    const wBar = width, hBar = 6;
    const x = u.x - wBar / 2, y = u.y - u.radius - 16;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(x - 1, y - 1, wBar + 2, hBar + (showMana ? 5 : 2));
    ctx.fillStyle = color;
    ctx.fillRect(x, y, wBar * clamp(u.hp / u.maxHp, 0, 1), hBar);
    if (u.shield > 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillRect(x, y, wBar * clamp(u.shield / u.maxHp, 0, 1), 2);
    }
    if (showMana && u.maxMana > 0) {
      ctx.fillStyle = '#38bdf8';
      ctx.fillRect(x, y + hBar + 1, wBar * clamp(u.mana / u.maxMana, 0, 1), 3);
    }
  }

  heroBarColor(hero) {
    if (hero.isPlayer) return '#4ade80';
    return hero.team === this.playerTeam ? '#60a5fa' : '#f87171';
  }

  drawHero(ctx, hh) {
    const r = hh.radius;
    // recall ring
    if (hh.recallTimer > 0) {
      const p = 1 - hh.recallTimer / RECALL_TIME;
      ctx.strokeStyle = '#8be9fd'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(hh.x, hh.y, r + 16, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2); ctx.stroke();
    }
    // shadow + team ring + body
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath(); ctx.ellipse(hh.x, hh.y + r * 0.65, r * 0.95, r * 0.45, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = TEAM_COLORS[hh.team]; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(hh.x, hh.y, r + 3, 0, 7); ctx.stroke();
    ctx.fillStyle = hh.def.color;
    ctx.beginPath(); ctx.arc(hh.x, hh.y, r, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    ctx.beginPath(); ctx.arc(hh.x - r * 0.3, hh.y - r * 0.3, r * 0.55, 0, 7); ctx.fill();
    // facing notch
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(hh.x + Math.cos(hh.facing) * r * 0.75, hh.y + Math.sin(hh.facing) * r * 0.75, 3.5, 0, 7);
    ctx.fill();
    this.drawGlyph(ctx, hh.def.glyph, hh.x, hh.y, r);
    // stun stars
    if (hh.stunned) {
      ctx.fillStyle = '#fde047';
      for (let i = 0; i < 3; i++) {
        const a = this.time * 5 + i * 2.1;
        ctx.beginPath(); ctx.arc(hh.x + Math.cos(a) * (r + 8), hh.y - r - 4 + Math.sin(a) * 4, 3, 0, 7); ctx.fill();
      }
    }
    this.drawHealthBar(ctx, hh, this.heroBarColor(hh), 52, true);
    // level + name
    ctx.fillStyle = '#0b1220';
    ctx.beginPath(); ctx.arc(hh.x - 32, hh.y - hh.radius - 12, 8, 0, 7); ctx.fill();
    ctx.fillStyle = '#fbbf24';
    ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(hh.level), hh.x - 32, hh.y - hh.radius - 11);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.font = 'bold 11px sans-serif';
    ctx.fillText(hh.def.name, hh.x, hh.y - hh.radius - 26);
  }

  drawGlyph(ctx, glyph, x, y, r) {
    ctx.save();
    ctx.translate(x, y);
    ctx.strokeStyle = 'rgba(15,23,42,0.9)';
    ctx.fillStyle = 'rgba(15,23,42,0.9)';
    ctx.lineWidth = 2.5; ctx.lineCap = 'round';
    const s = r * 0.55;
    if (glyph === 'sword') {
      ctx.beginPath(); ctx.moveTo(-s * 0.6, s * 0.6); ctx.lineTo(s * 0.6, -s * 0.6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-s * 0.1, -s * 0.5); ctx.lineTo(s * 0.5, s * 0.1); ctx.stroke();
    } else if (glyph === 'orb') {
      ctx.beginPath(); ctx.arc(0, 0, s * 0.55, 0, 7); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, s * 0.2, 0, 7); ctx.fill();
    } else if (glyph === 'shield') {
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.7); ctx.lineTo(s * 0.6, -s * 0.25); ctx.lineTo(s * 0.4, s * 0.55);
      ctx.lineTo(0, s * 0.8); ctx.lineTo(-s * 0.4, s * 0.55); ctx.lineTo(-s * 0.6, -s * 0.25);
      ctx.closePath(); ctx.stroke();
    } else if (glyph === 'arrow') {
      ctx.beginPath(); ctx.moveTo(-s * 0.6, s * 0.5); ctx.lineTo(s * 0.6, -s * 0.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(s * 0.6, -s * 0.5); ctx.lineTo(s * 0.05, -s * 0.45); ctx.moveTo(s * 0.6, -s * 0.5); ctx.lineTo(s * 0.55, 0.1 * s); ctx.stroke();
    } else if (glyph === 'lantern') {
      ctx.beginPath();
      ctx.moveTo(0, -s * 0.75); ctx.lineTo(s * 0.5, 0); ctx.lineTo(0, s * 0.75); ctx.lineTo(-s * 0.5, 0);
      ctx.closePath(); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, 0, s * 0.18, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  drawMinion(ctx, m) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(m.x, m.y + m.radius * 0.6, m.radius, m.radius * 0.45, 0, 0, 7); ctx.fill();
    ctx.fillStyle = TEAM_COLORS_DARK[m.team];
    ctx.beginPath(); ctx.arc(m.x, m.y, m.radius, 0, 7); ctx.fill();
    ctx.strokeStyle = TEAM_COLORS[m.team]; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(m.x, m.y, m.radius, 0, 7); ctx.stroke();
    if (m.isRanged) {
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(m.x, m.y, 3.5, 0, 7); ctx.fill();
    }
    if (m.hp < m.maxHp) this.drawHealthBar(ctx, m, TEAM_COLORS[m.team], 26, false);
  }

  drawJungle(ctx, j) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(j.x, j.y + j.radius * 0.6, j.radius, j.radius * 0.45, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#7c5231';
    ctx.beginPath(); ctx.arc(j.x, j.y, j.radius, 0, 7); ctx.fill();
    ctx.strokeStyle = '#3f2d1c'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(j.x, j.y, j.radius, 0, 7); ctx.stroke();
    // horns
    ctx.fillStyle = '#e7d8b0';
    ctx.beginPath(); ctx.moveTo(j.x - 12, j.y - 14); ctx.lineTo(j.x - 20, j.y - 26); ctx.lineTo(j.x - 6, j.y - 18); ctx.fill();
    ctx.beginPath(); ctx.moveTo(j.x + 12, j.y - 14); ctx.lineTo(j.x + 20, j.y - 26); ctx.lineTo(j.x + 6, j.y - 18); ctx.fill();
    if (j.hp < j.maxHp) this.drawHealthBar(ctx, j, '#f59e0b', 34, false);
  }

  drawTower(ctx, t) {
    const r = t.radius;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath(); ctx.ellipse(t.x, t.y + 10, r * 1.15, r * 0.5, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#334155';
    ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, 7); ctx.fill();
    ctx.strokeStyle = TEAM_COLORS[t.team]; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(t.x, t.y, r, 0, 7); ctx.stroke();
    // crystal top
    ctx.save();
    ctx.translate(t.x, t.y);
    ctx.rotate(this.time * 0.8);
    ctx.fillStyle = TEAM_COLORS[t.team];
    ctx.fillRect(-12, -12, 24, 24);
    ctx.restore();
    this.drawHealthBar(ctx, t, TEAM_COLORS[t.team], 60, false);
  }

  drawCore(ctx, c) {
    const pulse = 1 + Math.sin(this.time * 2.4) * 0.06;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath(); ctx.ellipse(c.x, c.y + 20, c.radius * 1.2, c.radius * 0.5, 0, 0, 7); ctx.fill();
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(Math.PI / 4);
    const s = c.radius * pulse;
    const grad = ctx.createLinearGradient(-s, -s, s, s);
    grad.addColorStop(0, TEAM_COLORS[c.team]);
    grad.addColorStop(1, '#ffffff');
    ctx.fillStyle = grad;
    ctx.fillRect(-s * 0.72, -s * 0.72, s * 1.44, s * 1.44);
    ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 4;
    ctx.strokeRect(-s * 0.72, -s * 0.72, s * 1.44, s * 1.44);
    ctx.restore();
    this.drawHealthBar(ctx, c, TEAM_COLORS[c.team], 90, false);
  }

  drawProjectile(ctx, p) {
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size, 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
  }

  drawZone(ctx, z) {
    ctx.fillStyle = z.color;
    ctx.beginPath(); ctx.arc(z.x, z.y, z.radius, 0, 7); ctx.fill();
    ctx.strokeStyle = z.color.replace(/[\d.]+\)$/, '0.85)');
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(z.x, z.y, z.radius, 0, 7); ctx.stroke();
  }

  drawEffect(ctx, e) {
    const p = 1 - e.ttl / e.ttl0;   // 0 → 1
    if (e.type === 'ring') {
      ctx.strokeStyle = e.color; ctx.globalAlpha = 1 - p; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(e.x, e.y, lerp(e.r, e.r2, p), 0, 7); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (e.type === 'nova') {
      ctx.fillStyle = e.color; ctx.globalAlpha = 0.5 * (1 - p);
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.4 + 0.6 * p), 0, 7); ctx.fill();
      ctx.globalAlpha = 1 - p; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.4 + 0.6 * p), 0, 7); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (e.type === 'telegraph') {
      ctx.strokeStyle = e.color; ctx.globalAlpha = 0.7;
      ctx.setLineDash([12, 10]); ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, 7); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = e.color; ctx.globalAlpha = 0.15 + 0.2 * p;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * p, 0, 7); ctx.fill();
      ctx.globalAlpha = 1;
    } else if (e.type === 'slash') {
      ctx.strokeStyle = e.color; ctx.globalAlpha = 1 - p; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(e.x, e.y, 18, e.angle - 0.8, e.angle + 0.8); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (e.type === 'trail') {
      ctx.strokeStyle = e.color; ctx.globalAlpha = 0.6 * (1 - p); ctx.lineWidth = 14 * (1 - p) + 2;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); ctx.stroke();
      ctx.globalAlpha = 1;
    } else if (e.type === 'dmgtext') {
      ctx.globalAlpha = 1 - p * p;
      ctx.fillStyle = e.color;
      ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(e.text, e.x, e.y - p * 34);
      ctx.globalAlpha = 1;
    } else if (e.type === 'levelup') {
      const u = e.unit;
      ctx.strokeStyle = '#fbbf24'; ctx.globalAlpha = 1 - p; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(u.x, u.y, 20 + p * 46, 0, 7); ctx.stroke();
      ctx.fillStyle = '#fbbf24';
      ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('LEVEL UP', u.x, u.y - u.radius - 38 - p * 16);
      ctx.globalAlpha = 1;
    }
  }

  // ---------------- minimap ----------------
  drawMinimap(mmCanvas) {
    const ctx = mmCanvas.getContext('2d');
    const S = mmCanvas.width / WORLD;
    ctx.clearRect(0, 0, mmCanvas.width, mmCanvas.height);
    ctx.fillStyle = 'rgba(8,16,12,0.9)';
    ctx.fillRect(0, 0, mmCanvas.width, mmCanvas.height);
    // river + lanes
    ctx.strokeStyle = 'rgba(56,130,180,0.6)'; ctx.lineWidth = 8 * S * 30;
    ctx.lineWidth = 10;
    ctx.beginPath(); ctx.moveTo(240 * S, 240 * S); ctx.lineTo((WORLD - 240) * S, (WORLD - 240) * S); ctx.stroke();
    ctx.strokeStyle = 'rgba(140,140,100,0.7)'; ctx.lineWidth = 6; ctx.lineJoin = 'round';
    for (const lane of LANE_NAMES) {
      const pts = LANES[lane];
      ctx.beginPath(); ctx.moveTo(pts[0][0] * S, pts[0][1] * S);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] * S, pts[i][1] * S);
      ctx.stroke();
    }
    // towers & cores
    for (const t of this.towers) {
      if (t.dead) continue;
      ctx.fillStyle = TEAM_COLORS[t.team];
      ctx.fillRect(t.x * S - 3, t.y * S - 3, 6, 6);
    }
    for (const c of this.cores) {
      if (c.dead) continue;
      ctx.save();
      ctx.translate(c.x * S, c.y * S); ctx.rotate(Math.PI / 4);
      ctx.fillStyle = TEAM_COLORS[c.team];
      ctx.fillRect(-5, -5, 10, 10);
      ctx.restore();
    }
    // minions
    for (const m of this.minions) {
      ctx.fillStyle = TEAM_COLORS[m.team];
      ctx.fillRect(m.x * S - 1, m.y * S - 1, 2, 2);
    }
    // heroes
    for (const hh of this.heroes) {
      if (hh.dead) continue;
      ctx.fillStyle = hh.isPlayer ? '#ffffff' : TEAM_COLORS[hh.team];
      ctx.beginPath(); ctx.arc(hh.x * S, hh.y * S, hh.isPlayer ? 4.5 : 3.5, 0, 7); ctx.fill();
      if (hh.isPlayer) {
        ctx.strokeStyle = '#4ade80'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(hh.x * S, hh.y * S, 6, 0, 7); ctx.stroke();
      }
    }
    // camera box
    const w = this.canvas.width / this.dpr, h = this.canvas.height / this.dpr;
    ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1;
    ctx.strokeRect(this.camX * S, this.camY * S, w * S, h * S);
  }
}
