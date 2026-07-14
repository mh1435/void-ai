// ============================================================
// VOID ARENA — Game state, simulation loop, world renderer
// ============================================================

const G = {
  running: false,
  over: false,
  time: 0,
  units: [],
  towers: [],
  cores: {},
  projectiles: [],
  zones: [],
  player: null,
  heroes: [],
  kills: { blue: 0, red: 0 },
  camps: [],
  boss: null,
  bossTimer: CFG.bossSpawnAt,
  waveTimer: CFG.firstWaveAt,
  cam: { x: 0, y: 0, zoom: 1 },
  aimPreview: null,
  firstBlood: false,
};

const Game = {

  start(heroId) {
    G.running = true; G.over = false; G.time = 0;
    G.units = []; G.towers = []; G.projectiles = []; G.zones = [];
    G.kills = { blue: 0, red: 0 };
    G.heroes = []; G.camps = []; G.boss = null;
    G.bossTimer = CFG.bossSpawnAt;
    G.waveTimer = CFG.firstWaveAt;
    G.firstBlood = false;
    FX.length = 0;

    // player + team compositions
    const pool = HEROES.map(h => h.id).filter(id => id !== heroId);
    shuffle(pool);
    const blueIds = [heroId, ...pool.slice(0, 4)];
    const redPool = HEROES.map(h => h.id);
    shuffle(redPool);
    const redIds = redPool.slice(0, 5);

    const laneAssign = ['top', 'mid', 'bot', 'top', 'bot'];
    blueIds.forEach((id, i) => {
      const h = new Hero(heroById(id), 'blue', i === 0);
      h.lane = i === 0 ? 'mid' : laneAssign[i];
      G.units.push(h); G.heroes.push(h);
      if (i === 0) G.player = h;
    });
    redIds.forEach((id, i) => {
      const h = new Hero(heroById(id), 'red', false);
      h.lane = ['mid', 'top', 'bot', 'top', 'bot'][i];
      G.units.push(h); G.heroes.push(h);
    });

    for (const spot of TOWER_SPOTS) {
      const t = new Tower(spot);
      G.units.push(t); G.towers.push(t);
    }
    G.cores.blue = new Core('blue');
    G.cores.red = new Core('red');
    G.units.push(G.cores.blue, G.cores.red);

    for (const c of CAMPS) {
      const m = new JungleMonster(c, false);
      G.units.push(m);
      G.camps.push({ camp: c, mon: m, respawn: 0 });
    }

    buildMapCanvas();
    UI.onGameStart();
    UI.announce('Welcome to Void Arena!', '#7df9ff');
    UI.announce('Destroy the enemy Void Core!', '#fff');
  },

  update(dt) {
    if (!G.running || G.over) return;
    G.time += dt;

    // minion waves
    G.waveTimer -= dt;
    if (G.waveTimer <= 0) {
      G.waveTimer = CFG.waveInterval;
      for (const lane of ['top', 'mid', 'bot']) {
        for (const team of ['blue', 'red']) {
          for (let i = 0; i < 3; i++) G.units.push(new Minion(team, lane, false));
          for (let i = 0; i < 2; i++) G.units.push(new Minion(team, lane, true));
        }
      }
    }

    // jungle respawns
    for (const c of G.camps) {
      if (c.mon.dead) {
        c.respawn -= dt;
        if (c.respawn <= 0) {
          c.mon = new JungleMonster(c.camp, false);
          G.units.push(c.mon);
        }
      }
    }
    // boss
    G.bossTimer -= dt;
    if (G.bossTimer <= 0 && (!G.boss || G.boss.dead)) {
      G.boss = new JungleMonster(BOSS_SPOT, true);
      G.units.push(G.boss);
      G.bossTimer = 1e9;
      UI.announce('The Void Behemoth has awakened!', '#c77dff');
      Sfx.play('boss');
    }

    // tower invulnerability chain
    for (const t of G.towers) {
      if (t.dead) continue;
      t.invulnerable = G.towers.some(o => o.team === t.team && o.lane === t.lane && !o.dead && o.order < t.order);
    }
    for (const team of ['blue', 'red']) {
      const core = G.cores[team];
      if (!core.dead) {
        core.invulnerable = !['top', 'mid', 'bot'].some(lane =>
          G.towers.filter(t => t.team === team && t.lane === lane && !t.dead).length === 0);
      }
    }

    // hero respawns
    for (const h of G.heroes) {
      if (h.dead) {
        h.respawnT -= dt;
        if (h.respawnT <= 0) Game.respawn(h);
      }
    }

    for (const u of [...G.units]) u.update(dt);

    updateProjectiles(dt);
    updateZones(dt);
    updateFX(dt);
    resolveCollisions();

    // remove dead non-heroes
    G.units = G.units.filter(u => !u.dead || u.type === 'hero');

    // camera follows player
    const cv = UI.canvas;
    G.cam.zoom = cv.height / CFG.viewHeight;
    const halfW = cv.width / 2 / G.cam.zoom, halfH = cv.height / 2 / G.cam.zoom;
    G.cam.x = clamp(G.player.x, halfW, WORLD - halfW);
    G.cam.y = clamp(G.player.y, halfH, WORLD - halfH);
  },

  respawn(h) {
    h.dead = false;
    h.hp = h.hpMax(); h.mana = h.manaMax;
    h.buffs = []; h.cds = [0, 0, 0];
    h.dash = null; h.leap = null; h.recallT = 0;
    const c = CORES[h.team];
    h.x = c.x + (Math.random()*100 - 50);
    h.y = c.y + (Math.random()*100 - 50);
    h.wpIdx = 0; h.aiState = 'lane';
    if (h.isPlayer) UI.announce('Respawned — get back out there!', '#7dff9b');
  },

  onDeath(u, killer) {
    if (u.dead) return;
    u.dead = true;
    u.target = null;
    FX.push({ type:'ring', x:u.x, y:u.y, r0:u.radius, r1:u.radius*2.2, dur:0.4, color:'#fff', t:0 });

    const killerHero = killer && killer.type === 'hero' ? killer : null;

    if (u.type === 'minion') {
      if (killerHero) { killerHero.gold += CFG.minionGold; killerHero.cs++; }
      shareXp(u, CFG.minionXp);
      return;
    }

    if (u.type === 'jungle') {
      if (u.boss) {
        const team = killerHero ? killerHero.team : null;
        if (team) {
          for (const h of G.heroes.filter(x => x.team === team)) {
            h.gold += CFG.bossGoldEach;
            h.addBuff({ id:'bosspower', dur:60, adMult:1.15, sp:40 });
          }
          UI.announce((team === G.player.team ? 'Your team' : 'The enemy') + ' slew the Void Behemoth!', '#c77dff');
          Sfx.play('boss');
        }
        shareXp(u, CFG.bossXp);
        G.bossTimer = CFG.bossRespawn;
      } else {
        if (killerHero) killerHero.gold += CFG.jungleGold;
        shareXp(u, CFG.jungleXp);
        const c = G.camps.find(c => c.mon === u);
        if (c) c.respawn = CFG.jungleRespawn;
      }
      return;
    }

    if (u.type === 'tower') {
      if (killerHero) killerHero.gold += CFG.towerGold;
      const team = u.team === 'blue' ? 'red' : 'blue';
      for (const h of G.heroes.filter(x => x.team === team)) h.gold += CFG.towerTeamGold;
      UI.announce((u.team === G.player.team ? 'Your' : 'Enemy') + ' ' + u.lane + ' turret destroyed!',
        u.team === G.player.team ? '#ff8080' : '#7dff9b');
      Sfx.play('tower');
      return;
    }

    if (u.type === 'core') {
      Game.end(u.team === 'blue' ? 'red' : 'blue');
      return;
    }

    if (u.type === 'hero') {
      G.kills[u.team === 'blue' ? 'red' : 'blue']++;
      u.deaths++;
      const streakBonus = Math.min(5, u.streak) * CFG.streakGoldBonus;
      u.streak = 0;
      u.respawnT = CFG.respawnBase + u.level * CFG.respawnPerLevel;

      let killerName = 'a turret';
      if (killerHero) {
        killerHero.kills++;
        killerHero.streak++;
        killerHero.gold += CFG.heroKillGold + streakBonus;
        killerHero.gainXp(CFG.heroKillXp);
        killerName = killerHero.name;
        if (!G.firstBlood) {
          G.firstBlood = true;
          UI.announce('FIRST BLOOD! ' + killerHero.name + ' draws first blood!', '#ff5c5c');
          Sfx.play('kill');
        } else if (killerHero.streak >= 3) {
          UI.announce(killerHero.name + ' is on a killing spree! (' + killerHero.streak + ')', '#ffb84d');
        }
        // assists
        for (const h of G.heroes) {
          if (h === killerHero || h.team !== killerHero.team) continue;
          const t = u.recentDamagers[h.id];
          if (t !== undefined && G.time - t < 5) {
            h.assists++;
            h.gold += CFG.assistGold;
            h.gainXp(CFG.heroKillXp * 0.5);
          }
        }
      }
      u.recentDamagers = {};
      UI.feed(killerName, u.name, killerHero ? killerHero.team : (u.team === 'blue' ? 'red' : 'blue'));
      if (u.isPlayer) { UI.announce('You have been slain!', '#ff5c5c'); Sfx.play('death'); }
      else if (killerHero && killerHero.isPlayer) { UI.announce('You killed ' + u.name + '!', '#ffe27d'); Sfx.play('kill'); }
      shareXp(u, CFG.heroKillXp * 0.4);
    }
  },

  end(winner) {
    G.over = true;
    const won = winner === G.player.team;
    UI.showEnd(won);
    Sfx.play(won ? 'victory' : 'defeat');
  },

  // ---- player actions (called from UI) ----
  playerCast(i, dragDir) {
    const h = G.player;
    if (!h || h.dead || !h.skillReady(i)) return;
    const sk = h.def.skills[i];
    const range = sk.range || 300;
    let dx, dy;
    if (dragDir) { dx = dragDir.dx; dy = dragDir.dy; }
    else {
      // smart cast: aim at nearest visible enemy hero, else any enemy, else facing
      const t = nearestEnemy(h, Math.max(range, 400), u => u.type === 'hero') || nearestEnemy(h, Math.max(range, 400));
      if (t) { const d = dist(h, t) || 1; dx = (t.x - h.x)/d; dy = (t.y - h.y)/d; }
      else { dx = Math.cos(h.facing); dy = Math.sin(h.facing); }
    }
    const aim = { dx, dy, tx: h.x + dx*range, ty: h.y + dy*range };
    // clamp aoe target point to nearest enemy position when close enough
    const tgt = nearestEnemy(h, range, u => u.type === 'hero');
    if (!dragDir && tgt) { aim.tx = tgt.x; aim.ty = tgt.y; }
    h.cast(i, aim);
  },

  playerRecall() { if (G.player && !G.player.dead) G.player.startRecall(); },

  playerBuy() {
    const h = G.player;
    const next = h.nextBuildItem();
    if (next && h.buyItem(next)) h.buildIdx++;
  },
};

function shareXp(victim, amount) {
  const enemies = G.heroes.filter(h => h.team !== victim.team && !h.dead && dist(h, victim) < CFG.xpShareRadius);
  if (victim.team === 'jungle') {
    // jungle xp goes to the killer's nearby team only — approximate with all nearby heroes
  }
  for (const h of enemies) h.gainXp(amount / Math.max(1, enemies.length * 0.7));
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
}

// ============================================================
// Rendering
// ============================================================

let mapCanvas = null;

function buildMapCanvas() {
  const S = 0.5;
  mapCanvas = document.createElement('canvas');
  mapCanvas.width = WORLD * S; mapCanvas.height = WORLD * S;
  const c = mapCanvas.getContext('2d');
  c.scale(S, S);

  // ground
  const grd = c.createLinearGradient(0, 0, WORLD, WORLD);
  grd.addColorStop(0, '#12331f');
  grd.addColorStop(0.5, '#0e2a2e');
  grd.addColorStop(1, '#2a1530');
  c.fillStyle = grd;
  c.fillRect(0, 0, WORLD, WORLD);

  // subtle texture blobs
  for (let i = 0; i < 260; i++) {
    c.fillStyle = 'rgba(255,255,255,' + (Math.random()*0.02) + ')';
    const r = 20 + Math.random()*70;
    c.beginPath();
    c.arc(Math.random()*WORLD, Math.random()*WORLD, r, 0, 7);
    c.fill();
  }

  // river (anti-diagonal band through center)
  c.save();
  c.translate(1600, 1600);
  c.rotate(Math.PI / 4);
  const rg = c.createLinearGradient(0, -160, 0, 160);
  rg.addColorStop(0, 'rgba(40,120,180,0)');
  rg.addColorStop(0.5, 'rgba(60,160,220,0.30)');
  rg.addColorStop(1, 'rgba(40,120,180,0)');
  c.fillStyle = rg;
  c.fillRect(-2400, -160, 4800, 320);
  c.restore();

  // lanes
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const lane of Object.values(LANES)) {
    c.strokeStyle = 'rgba(210,190,150,0.16)';
    c.lineWidth = 150;
    c.beginPath();
    c.moveTo(lane[0][0], lane[0][1]);
    for (const p of lane) c.lineTo(p[0], p[1]);
    c.stroke();
    c.strokeStyle = 'rgba(230,215,170,0.10)';
    c.lineWidth = 90;
    c.stroke();
  }

  // base platforms
  for (const team of ['blue', 'red']) {
    const b = CORES[team];
    const g = c.createRadialGradient(b.x, b.y, 40, b.x, b.y, 340);
    g.addColorStop(0, team === 'blue' ? 'rgba(63,169,255,0.30)' : 'rgba(255,77,94,0.30)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(b.x, b.y, 340, 0, 7); c.fill();
  }

  // rocks
  for (const r of ROCKS) {
    c.fillStyle = '#3a4148';
    c.beginPath(); c.arc(r.x, r.y, r.r, 0, 7); c.fill();
    c.fillStyle = '#4d565f';
    c.beginPath(); c.arc(r.x - r.r*0.2, r.y - r.r*0.25, r.r*0.7, 0, 7); c.fill();
  }

  // bushes
  for (const b of BUSHES) {
    c.fillStyle = 'rgba(40,160,80,0.55)';
    roundRect(c, b.x, b.y, b.w, b.h, 40);
    c.fill();
    c.fillStyle = 'rgba(70,200,110,0.35)';
    for (let i = 0; i < 6; i++) {
      c.beginPath();
      c.arc(b.x + 20 + Math.random()*(b.w-40), b.y + 20 + Math.random()*(b.h-40), 18 + Math.random()*16, 0, 7);
      c.fill();
    }
  }

  // camp markers
  for (const cp of CAMPS) {
    c.strokeStyle = 'rgba(255,255,255,0.10)';
    c.lineWidth = 6;
    c.beginPath(); c.arc(cp.x, cp.y, 120, 0, 7); c.stroke();
  }
  c.strokeStyle = 'rgba(199,125,255,0.25)';
  c.lineWidth = 8;
  c.beginPath(); c.arc(BOSS_SPOT.x, BOSS_SPOT.y, 160, 0, 7); c.stroke();
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function render(ctx) {
  const cv = UI.canvas;
  ctx.fillStyle = '#060a10';
  ctx.fillRect(0, 0, cv.width, cv.height);
  if (!G.running) return;

  const z = G.cam.zoom;
  ctx.save();
  ctx.translate(cv.width/2 - G.cam.x*z, cv.height/2 - G.cam.y*z);
  ctx.scale(z, z);

  if (mapCanvas) ctx.drawImage(mapCanvas, 0, 0, WORLD, WORLD);

  // zones
  for (const zn of G.zones) {
    ctx.globalAlpha = 0.25 + 0.1*Math.sin(G.time*8);
    ctx.fillStyle = zn.color;
    ctx.beginPath(); ctx.arc(zn.x, zn.y, zn.r, 0, 7); ctx.fill();
    ctx.globalAlpha = 0.8;
    ctx.strokeStyle = zn.color; ctx.lineWidth = 3;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // aim preview
  if (G.aimPreview && !G.player.dead) {
    const ap = G.aimPreview;
    const h = G.player;
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.lineWidth = 5;
    ctx.setLineDash([16, 12]);
    ctx.beginPath();
    ctx.moveTo(h.x, h.y);
    ctx.lineTo(h.x + ap.dx*ap.range, h.y + ap.dy*ap.range);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(h.x + ap.dx*ap.range, h.y + ap.dy*ap.range, 26, 0, 7);
    ctx.stroke();
  }

  // sort drawables by y for a hint of depth
  const drawList = G.units.filter(u => !u.dead).sort((a, b) => a.y - b.y);
  for (const u of drawList) {
    if (u.type === 'hero' && !isVisibleTo(u, G.player)) continue;
    drawUnit(ctx, u);
  }

  // projectiles
  for (const p of G.projectiles) {
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color; ctx.shadowBlur = 12;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size || 8, 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
  }

  // effects
  for (const e of FX) {
    const k = e.t / e.dur;
    if (e.type === 'ring') {
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = e.color; ctx.lineWidth = 5;
      ctx.beginPath(); ctx.arc(e.x, e.y, lerp(e.r0, e.r1, k), 0, 7); ctx.stroke();
    } else if (e.type === 'flash') {
      ctx.globalAlpha = (1 - k) * 0.8;
      ctx.fillStyle = e.color;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r0, 0, 7); ctx.fill();
    } else if (e.type === 'slash') {
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = e.color; ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(e.x, e.y, 40, e.ang - 0.8 + k*1.2, e.ang + 0.8 + k*1.2);
      ctx.stroke();
    } else if (e.type === 'text') {
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = e.color;
      ctx.font = 'bold 22px Rajdhani, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(e.text, e.x, e.y);
    }
    ctx.globalAlpha = 1;
  }

  // recall channel indicator
  for (const h of G.heroes) {
    if (!h.dead && h.recallT > 0 && isVisibleTo(h, G.player)) {
      ctx.strokeStyle = '#7df9ff'; ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(h.x, h.y, h.radius + 14, -Math.PI/2, -Math.PI/2 + (1 - h.recallT/CFG.recallTime) * Math.PI * 2);
      ctx.stroke();
    }
  }

  ctx.restore();
}

function drawUnit(ctx, u) {
  const tc = u.team === 'jungle' ? '#c77dff' : TEAM_COLOR[u.team];

  if (u.type === 'tower') {
    ctx.fillStyle = '#242a33';
    ctx.beginPath(); ctx.arc(u.x, u.y + 6, u.radius + 8, 0, 7); ctx.fill();
    ctx.fillStyle = TEAM_COLOR_D[u.team];
    hexPath(ctx, u.x, u.y, u.radius);
    ctx.fill();
    ctx.strokeStyle = tc; ctx.lineWidth = 4;
    hexPath(ctx, u.x, u.y, u.radius);
    ctx.stroke();
    ctx.fillStyle = tc;
    ctx.shadowColor = tc; ctx.shadowBlur = u.invulnerable ? 0 : 16;
    ctx.beginPath(); ctx.arc(u.x, u.y, 12 + 3*Math.sin(G.time*4), 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
    if (u.invulnerable) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(u.x, u.y, u.radius + 16, 0, 7); ctx.stroke();
    }
    drawHpBar(ctx, u, 70);
    return;
  }

  if (u.type === 'core') {
    ctx.fillStyle = TEAM_COLOR_D[u.team];
    ctx.beginPath(); ctx.arc(u.x, u.y, u.radius, 0, 7); ctx.fill();
    ctx.strokeStyle = tc; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(u.x, u.y, u.radius, 0, 7); ctx.stroke();
    const pul = 18 + 6*Math.sin(G.time*3);
    ctx.shadowColor = tc; ctx.shadowBlur = 24;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(u.x, u.y, pul, 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
    if (u.invulnerable) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(u.x, u.y, u.radius + 18, 0, 7); ctx.stroke();
    }
    drawHpBar(ctx, u, 100);
    return;
  }

  if (u.type === 'minion') {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(u.x, u.y + u.radius*0.7, u.radius, u.radius*0.4, 0, 0, 7); ctx.fill();
    ctx.fillStyle = TEAM_COLOR_D[u.team];
    ctx.beginPath(); ctx.arc(u.x, u.y, u.radius, 0, 7); ctx.fill();
    ctx.strokeStyle = tc; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(u.x, u.y, u.radius, 0, 7); ctx.stroke();
    if (u.ranged) {
      ctx.fillStyle = tc;
      ctx.beginPath(); ctx.arc(u.x, u.y, 5, 0, 7); ctx.fill();
    } else {
      ctx.strokeStyle = tc; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(u.x - 6, u.y - 4); ctx.lineTo(u.x + 6, u.y + 4);
      ctx.moveTo(u.x + 6, u.y - 4); ctx.lineTo(u.x - 6, u.y + 4);
      ctx.stroke();
    }
    drawHpBar(ctx, u, 34);
    return;
  }

  if (u.type === 'jungle') {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(u.x, u.y + u.radius*0.7, u.radius, u.radius*0.4, 0, 0, 7); ctx.fill();
    ctx.fillStyle = u.boss ? '#4a2a63' : '#4d3a5e';
    ctx.beginPath(); ctx.arc(u.x, u.y, u.radius, 0, 7); ctx.fill();
    ctx.strokeStyle = '#c77dff'; ctx.lineWidth = u.boss ? 5 : 3;
    ctx.beginPath(); ctx.arc(u.x, u.y, u.radius, 0, 7); ctx.stroke();
    // eyes
    ctx.fillStyle = '#e0aaff';
    const ex = Math.cos(u.facing)*u.radius*0.4, ey = Math.sin(u.facing)*u.radius*0.4;
    ctx.beginPath(); ctx.arc(u.x + ex - 6, u.y + ey, u.boss ? 7 : 4, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(u.x + ex + 6, u.y + ey, u.boss ? 7 : 4, 0, 7); ctx.fill();
    if (u.boss) {
      // spikes
      ctx.strokeStyle = '#9d4edd'; ctx.lineWidth = 5;
      for (let i = 0; i < 6; i++) {
        const a = G.time*0.6 + i * Math.PI/3;
        ctx.beginPath();
        ctx.moveTo(u.x + Math.cos(a)*u.radius, u.y + Math.sin(a)*u.radius);
        ctx.lineTo(u.x + Math.cos(a)*(u.radius+18), u.y + Math.sin(a)*(u.radius+18));
        ctx.stroke();
      }
    }
    drawHpBar(ctx, u, u.boss ? 90 : 44);
    return;
  }

  // ---- hero ----
  drawHero(ctx, u);
}

function hexPath(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI/6 + i*Math.PI/3;
    const px = x + Math.cos(a)*r, py = y + Math.sin(a)*r;
    if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  }
  ctx.closePath();
}

function drawHero(ctx, h) {
  const tc = TEAM_COLOR[h.team];
  const c = h.def.color;
  const r = h.radius;

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(h.x, h.y + r*0.75, r*1.1, r*0.45, 0, 0, 7); ctx.fill();

  // team ring
  ctx.strokeStyle = tc; ctx.lineWidth = 4;
  ctx.globalAlpha = h.isPlayer ? 1 : 0.8;
  ctx.beginPath(); ctx.arc(h.x, h.y, r + 7, 0, 7); ctx.stroke();
  ctx.globalAlpha = 1;
  if (h.isPlayer) {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(h.x, h.y, r + 12, 0, 7); ctx.stroke();
  }

  // body
  const g = ctx.createRadialGradient(h.x - r*0.3, h.y - r*0.3, r*0.2, h.x, h.y, r);
  g.addColorStop(0, lighten(c, 0.35));
  g.addColorStop(1, c);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(h.x, h.y, r, 0, 7); ctx.fill();

  drawHeroGlyph(ctx, h.def.id, h.x, h.y, r, h.facing);

  // shield bubble
  if (h.shieldTotal() > 0) {
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.arc(h.x, h.y, r + 4, 0, 7); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // stun stars
  if (h.stunned) {
    ctx.fillStyle = '#ffe27d';
    for (let i = 0; i < 3; i++) {
      const a = G.time*5 + i*2.1;
      ctx.beginPath(); ctx.arc(h.x + Math.cos(a)*(r+10), h.y - r - 8 + Math.sin(a)*6, 4, 0, 7); ctx.fill();
    }
  }

  drawHpBar(ctx, h, 66, true);

  // name + level
  ctx.fillStyle = h.isPlayer ? '#fff' : tc;
  ctx.font = 'bold 15px Rajdhani, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(h.name + ' · ' + h.level, h.x, h.y - r - 26);
}

// each hero gets a hand-drawn vector glyph — our own character designs
function drawHeroGlyph(ctx, id, x, y, r, facing) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(facing + Math.PI/2);
  ctx.lineCap = 'round';
  switch (id) {
    case 'kael': // twin blades
      ctx.strokeStyle = '#fff1e0'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(-r*0.55, r*0.35); ctx.lineTo(-r*0.15, -r*0.75); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(r*0.55, r*0.35); ctx.lineTo(r*0.15, -r*0.75); ctx.stroke();
      ctx.fillStyle = '#3a1408';
      ctx.beginPath(); ctx.arc(0, 0, r*0.32, 0, 7); ctx.fill();
      ctx.fillStyle = '#ffb84d';
      ctx.beginPath(); ctx.arc(0, -r*0.05, r*0.14, 0, 7); ctx.fill();
      break;
    case 'nyra': // lightning sigil
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.moveTo(-r*0.1, -r*0.6); ctx.lineTo(r*0.25, -r*0.1);
      ctx.lineTo(-r*0.15, 0); ctx.lineTo(r*0.15, r*0.55);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, r*0.72, 0, 7); ctx.stroke();
      break;
    case 'grom': // shield emblem
      ctx.fillStyle = '#2d3a14';
      ctx.beginPath();
      ctx.moveTo(0, -r*0.6); ctx.lineTo(r*0.5, -r*0.25); ctx.lineTo(r*0.4, r*0.4);
      ctx.lineTo(0, r*0.65); ctx.lineTo(-r*0.4, r*0.4); ctx.lineTo(-r*0.5, -r*0.25);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#dbe8b0'; ctx.lineWidth = 3;
      ctx.stroke();
      ctx.fillStyle = '#dbe8b0';
      ctx.beginPath(); ctx.arc(0, 0, r*0.15, 0, 7); ctx.fill();
      break;
    case 'lyra': // bow + arrow
      ctx.strokeStyle = '#fff7dd'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(0, 0, r*0.6, Math.PI*0.75, Math.PI*2.25); ctx.stroke();
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(0, r*0.55); ctx.lineTo(0, -r*0.8); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -r*0.8); ctx.lineTo(-r*0.15, -r*0.5);
      ctx.moveTo(0, -r*0.8); ctx.lineTo(r*0.15, -r*0.5);
      ctx.stroke();
      break;
    case 'vex': // void diamond with orbiters
      ctx.fillStyle = '#31104f';
      ctx.beginPath();
      ctx.moveTo(0, -r*0.55); ctx.lineTo(r*0.4, 0); ctx.lineTo(0, r*0.55); ctx.lineTo(-r*0.4, 0);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#e0aaff'; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.fillStyle = '#e0aaff';
      for (let i = 0; i < 3; i++) {
        const a = G.time*3 + i*2.1;
        ctx.beginPath(); ctx.arc(Math.cos(a)*r*0.75, Math.sin(a)*r*0.75, 3.5, 0, 7); ctx.fill();
      }
      break;
    case 'thane': // wolf ears + claws
      ctx.fillStyle = '#134e3a';
      ctx.beginPath(); ctx.moveTo(-r*0.5, -r*0.3); ctx.lineTo(-r*0.25, -r*0.9); ctx.lineTo(-r*0.05, -r*0.35); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(r*0.5, -r*0.3); ctx.lineTo(r*0.25, -r*0.9); ctx.lineTo(r*0.05, -r*0.35); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = '#d1fae5'; ctx.lineWidth = 3;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(i*r*0.25 - r*0.1, r*0.05); ctx.lineTo(i*r*0.25 + r*0.1, r*0.5);
        ctx.stroke();
      }
      ctx.fillStyle = '#fef08a';
      ctx.beginPath(); ctx.arc(-r*0.2, -r*0.15, 3.5, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(r*0.2, -r*0.15, 3.5, 0, 7); ctx.fill();
      break;
  }
  ctx.restore();
}

function drawHpBar(ctx, u, w, withMana) {
  const frac = clamp(u.hp / u.hpMax(), 0, 1);
  const x = u.x - w/2, y = u.y - u.radius - 18;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(x - 1, y - 1, w + 2, withMana ? 10 : 7);
  ctx.fillStyle = u.team === G.player.team ? '#4ade80' : (u.team === 'jungle' ? '#c77dff' : '#ef4444');
  ctx.fillRect(x, y, w * frac, 5);
  const sh = u.shieldTotal ? u.shieldTotal() : 0;
  if (sh > 0) {
    const sf = clamp(sh / u.hpMax(), 0, 1 - frac);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(x + w*frac, y, w * sf, 5);
  }
  if (withMana && u.manaMax > 0) {
    ctx.fillStyle = '#3b82f6';
    ctx.fillRect(x, y + 6, w * clamp(u.mana / u.manaMax, 0, 1), 3);
  }
}

function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + Math.round(255*amt), g = ((n >> 8) & 255) + Math.round(255*amt), b = (n & 255) + Math.round(255*amt);
  r = Math.min(255, r); g = Math.min(255, g); b = Math.min(255, b);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}
