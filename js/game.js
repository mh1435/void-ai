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

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx*dx + dy*dy || 1;
  const t = clamp(((px - ax)*dx + (py - ay)*dy) / len2, 0, 1);
  return Math.hypot(px - (ax + dx*t), py - (ay + dy*t));
}

function distToLanes(x, y) {
  let best = 1e9;
  for (const lane of Object.values(LANES)) {
    for (let i = 0; i < lane.length - 1; i++) {
      best = Math.min(best, distToSegment(x, y, lane[i][0], lane[i][1], lane[i+1][0], lane[i+1][1]));
    }
  }
  return best;
}

// animated river sparkles (drawn live over the static map)
const RIVER_SPARKS = (() => {
  const rnd = mulberry32(777), out = [];
  for (let i = 0; i < 14; i++) {
    out.push({ u: (rnd()*2 - 1) * 1500, w: (rnd()*2 - 1) * 120, phase: rnd() * 6.28 });
  }
  return out;
})();

function buildMapCanvas() {
  const S = 0.5;
  mapCanvas = document.createElement('canvas');
  mapCanvas.width = WORLD * S; mapCanvas.height = WORLD * S;
  const c = mapCanvas.getContext('2d');
  c.scale(S, S);
  const rnd = mulberry32(1337);

  // ---- base ground ----
  const grd = c.createLinearGradient(0, 0, WORLD, WORLD);
  grd.addColorStop(0, '#13351f');
  grd.addColorStop(0.5, '#0f2c2c');
  grd.addColorStop(1, '#28142e');
  c.fillStyle = grd;
  c.fillRect(0, 0, WORLD, WORLD);

  // territory tints (blue owns the bottom-left half, red the top-right)
  c.fillStyle = 'rgba(40,110,170,0.10)';
  c.beginPath(); c.moveTo(0, 0); c.lineTo(0, WORLD); c.lineTo(WORLD, WORLD); c.closePath(); c.fill();
  c.fillStyle = 'rgba(170,50,70,0.09)';
  c.beginPath(); c.moveTo(0, 0); c.lineTo(WORLD, 0); c.lineTo(WORLD, WORLD); c.closePath(); c.fill();

  // mottled grass: layered soft blobs in varied greens
  const grassTones = ['rgba(60,140,80,0.06)', 'rgba(30,90,60,0.08)', 'rgba(90,160,90,0.045)', 'rgba(20,60,50,0.09)'];
  for (let i = 0; i < 700; i++) {
    const x = rnd()*WORLD, y = rnd()*WORLD;
    c.fillStyle = grassTones[(i % grassTones.length)];
    const r = 25 + rnd()*90;
    c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
  }
  // fine speckle
  for (let i = 0; i < 900; i++) {
    c.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.025)' : 'rgba(0,0,0,0.05)';
    c.beginPath(); c.arc(rnd()*WORLD, rnd()*WORLD, 3 + rnd()*7, 0, 7); c.fill();
  }

  // ---- trees (kept clear of lanes, bases, camps, boss pit) ----
  const clearOf = (x, y) =>
    distToLanes(x, y) > 190 &&
    dist({x, y}, CORES.blue) > 460 && dist({x, y}, CORES.red) > 460 &&
    CAMPS.every(cp => dist({x, y}, cp) > 190) &&
    dist({x, y}, BOSS_SPOT) > 260 &&
    ROCKS.every(r => dist({x, y}, r) > r.r + 90) &&
    BUSHES.every(b => x > b.x - 80 && x < b.x + b.w + 80 && y > b.y - 80 && y < b.y + b.h + 80 ? false : true);
  let planted = 0, tries = 0;
  while (planted < 110 && tries < 4000) {
    tries++;
    const x = 80 + rnd()*(WORLD - 160), y = 80 + rnd()*(WORLD - 160);
    if (!clearOf(x, y)) continue;
    planted++;
    const r = 42 + rnd()*46;
    const hue = rnd();
    const dark  = hue > 0.5 ? '#123b22' : '#0f3530';
    const mid   = hue > 0.5 ? '#1c5230' : '#175046';
    const light = hue > 0.5 ? '#2a6b3c' : '#22685a';
    c.fillStyle = 'rgba(0,0,0,0.30)';
    c.beginPath(); c.ellipse(x + r*0.25, y + r*0.35, r*1.05, r*0.5, 0, 0, 7); c.fill();
    c.fillStyle = dark;
    c.beginPath(); c.arc(x, y, r, 0, 7); c.fill();
    c.fillStyle = mid;
    c.beginPath(); c.arc(x - r*0.18, y - r*0.2, r*0.78, 0, 7); c.fill();
    c.fillStyle = light;
    c.beginPath(); c.arc(x - r*0.3, y - r*0.32, r*0.42, 0, 7); c.fill();
    // leaf clumps
    c.fillStyle = 'rgba(255,255,255,0.05)';
    for (let k = 0; k < 4; k++) {
      c.beginPath(); c.arc(x + (rnd()*2-1)*r*0.5, y + (rnd()*2-1)*r*0.5, 4 + rnd()*6, 0, 7); c.fill();
    }
    c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 3;
    c.beginPath(); c.arc(x, y, r, 0, 7); c.stroke();
  }

  // ---- river (anti-diagonal band with depth + ripples) ----
  c.save();
  c.translate(1600, 1600);
  c.rotate(Math.PI / 4);
  let rg = c.createLinearGradient(0, -170, 0, 170);
  rg.addColorStop(0, 'rgba(30,90,140,0)');
  rg.addColorStop(0.25, 'rgba(45,130,190,0.28)');
  rg.addColorStop(0.5, 'rgba(70,175,235,0.42)');
  rg.addColorStop(0.75, 'rgba(45,130,190,0.28)');
  rg.addColorStop(1, 'rgba(30,90,140,0)');
  c.fillStyle = rg;
  c.fillRect(-2400, -170, 4800, 340);
  // deep channel
  rg = c.createLinearGradient(0, -60, 0, 60);
  rg.addColorStop(0, 'rgba(10,40,80,0)');
  rg.addColorStop(0.5, 'rgba(8,35,70,0.35)');
  rg.addColorStop(1, 'rgba(10,40,80,0)');
  c.fillStyle = rg;
  c.fillRect(-2400, -60, 4800, 120);
  // ripple strokes
  c.strokeStyle = 'rgba(190,232,255,0.14)';
  c.lineWidth = 3; c.lineCap = 'round';
  for (let i = 0; i < 60; i++) {
    const u = (rnd()*2 - 1) * 2200, w = (rnd()*2 - 1) * 130;
    const len = 40 + rnd()*90;
    c.beginPath();
    c.moveTo(u, w);
    c.quadraticCurveTo(u + len/2, w - 6, u + len, w);
    c.stroke();
  }
  // banks
  c.strokeStyle = 'rgba(220,240,255,0.08)';
  c.lineWidth = 6;
  c.beginPath(); c.moveTo(-2400, -150); c.lineTo(2400, -150); c.stroke();
  c.beginPath(); c.moveTo(-2400, 150); c.lineTo(2400, 150); c.stroke();
  c.restore();

  // ---- lanes: stone roads ----
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const lane of Object.values(LANES)) {
    const path = () => {
      c.beginPath();
      c.moveTo(lane[0][0], lane[0][1]);
      for (const p of lane) c.lineTo(p[0], p[1]);
    };
    c.strokeStyle = 'rgba(0,0,0,0.30)'; c.lineWidth = 168; path(); c.stroke();   // road edge shadow
    c.strokeStyle = 'rgba(148,138,116,0.30)'; c.lineWidth = 150; path(); c.stroke(); // stone bed
    c.strokeStyle = 'rgba(196,184,152,0.18)'; c.lineWidth = 108; path(); c.stroke(); // worn center
    c.strokeStyle = 'rgba(255,246,214,0.10)'; c.lineWidth = 10;                   // guide line
    c.setLineDash([46, 64]); path(); c.stroke(); c.setLineDash([]);

    // paving seams: short ticks perpendicular to the road
    c.strokeStyle = 'rgba(0,0,0,0.10)'; c.lineWidth = 4;
    for (let i = 0; i < lane.length - 1; i++) {
      const [ax, ay] = lane[i], [bx, by] = lane[i+1];
      const segLen = Math.hypot(bx - ax, by - ay);
      const nx = -(by - ay)/segLen, ny = (bx - ax)/segLen;
      for (let d = 60; d < segLen - 30; d += 95) {
        const px = ax + (bx - ax)*d/segLen, py = ay + (by - ay)*d/segLen;
        const off = (rnd()*2 - 1) * 20;
        c.beginPath();
        c.moveTo(px + nx*(58 + off), py + ny*(58 + off));
        c.lineTo(px - nx*(58 - off), py - ny*(58 - off));
        c.stroke();
      }
    }
  }

  // ---- base platforms: hex courts with rune ring ----
  for (const team of ['blue', 'red']) {
    const b = CORES[team];
    const tc = TEAM_COLOR[team];
    const g = c.createRadialGradient(b.x, b.y, 40, b.x, b.y, 360);
    g.addColorStop(0, team === 'blue' ? 'rgba(63,169,255,0.34)' : 'rgba(255,77,94,0.34)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = g;
    c.beginPath(); c.arc(b.x, b.y, 360, 0, 7); c.fill();
    c.fillStyle = 'rgba(10,16,24,0.5)';
    hexPath(c, b.x, b.y, 230); c.fill();
    c.strokeStyle = tc; c.globalAlpha = 0.5; c.lineWidth = 8;
    hexPath(c, b.x, b.y, 230); c.stroke();
    c.lineWidth = 3;
    hexPath(c, b.x, b.y, 190); c.stroke();
    // rune dots
    c.fillStyle = tc;
    for (let i = 0; i < 12; i++) {
      const a = i * Math.PI/6;
      c.beginPath(); c.arc(b.x + Math.cos(a)*265, b.y + Math.sin(a)*265, 7, 0, 7); c.fill();
    }
    c.globalAlpha = 1;
  }

  // ---- boulders: shaded irregular rocks ----
  for (const r of ROCKS) {
    const pts = [];
    for (let i = 0; i < 9; i++) {
      const a = i/9 * Math.PI*2;
      const rr = r.r * (0.82 + rnd()*0.3);
      pts.push([r.x + Math.cos(a)*rr, r.y + Math.sin(a)*rr]);
    }
    const poly = () => {
      c.beginPath();
      c.moveTo(pts[0][0], pts[0][1]);
      for (const p of pts) c.lineTo(p[0], p[1]);
      c.closePath();
    };
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.beginPath(); c.ellipse(r.x + r.r*0.15, r.y + r.r*0.3, r.r*1.15, r.r*0.55, 0, 0, 7); c.fill();
    const rg2 = c.createLinearGradient(r.x - r.r, r.y - r.r, r.x + r.r, r.y + r.r);
    rg2.addColorStop(0, '#565f6a');
    rg2.addColorStop(0.55, '#3a424b');
    rg2.addColorStop(1, '#252b32');
    c.fillStyle = rg2;
    poly(); c.fill();
    c.strokeStyle = 'rgba(0,0,0,0.5)'; c.lineWidth = 4;
    poly(); c.stroke();
    // top highlight facet
    c.fillStyle = 'rgba(255,255,255,0.10)';
    c.beginPath();
    c.moveTo(r.x - r.r*0.45, r.y - r.r*0.15);
    c.lineTo(r.x - r.r*0.05, r.y - r.r*0.62);
    c.lineTo(r.x + r.r*0.4, r.y - r.r*0.3);
    c.lineTo(r.x + r.r*0.05, r.y + r.r*0.05);
    c.closePath(); c.fill();
    // cracks
    c.strokeStyle = 'rgba(0,0,0,0.35)'; c.lineWidth = 3;
    c.beginPath();
    c.moveTo(r.x - r.r*0.2, r.y + r.r*0.5);
    c.lineTo(r.x, r.y + r.r*0.1);
    c.lineTo(r.x + r.r*0.3, r.y - r.r*0.05);
    c.stroke();
  }

  // ---- bushes: layered leaf clusters ----
  for (const b of BUSHES) {
    c.fillStyle = 'rgba(0,0,0,0.28)';
    roundRect(c, b.x + 6, b.y + 10, b.w, b.h, 44); c.fill();
    c.fillStyle = 'rgba(26,92,48,0.85)';
    roundRect(c, b.x, b.y, b.w, b.h, 44); c.fill();
    const leaves = 10 + Math.floor((b.w * b.h) / 6000);
    for (let i = 0; i < leaves; i++) {
      const lx = b.x + 22 + rnd()*(b.w - 44);
      const ly = b.y + 22 + rnd()*(b.h - 44);
      const lr = 16 + rnd()*18;
      c.fillStyle = i % 3 === 0 ? 'rgba(76,175,102,0.75)' : 'rgba(46,138,74,0.8)';
      c.beginPath(); c.arc(lx, ly, lr, 0, 7); c.fill();
      c.fillStyle = 'rgba(158,230,170,0.35)';
      c.beginPath(); c.arc(lx - lr*0.3, ly - lr*0.35, lr*0.4, 0, 7); c.fill();
    }
    c.strokeStyle = 'rgba(120,220,150,0.35)'; c.lineWidth = 3;
    roundRect(c, b.x, b.y, b.w, b.h, 44); c.stroke();
  }

  // ---- jungle camp pads + boss pit ----
  for (const cp of CAMPS) {
    c.fillStyle = 'rgba(60,30,80,0.25)';
    c.beginPath(); c.arc(cp.x, cp.y, 120, 0, 7); c.fill();
    c.strokeStyle = 'rgba(199,125,255,0.22)'; c.lineWidth = 5;
    c.setLineDash([18, 14]);
    c.beginPath(); c.arc(cp.x, cp.y, 120, 0, 7); c.stroke();
    c.setLineDash([]);
  }
  const bp = c.createRadialGradient(BOSS_SPOT.x, BOSS_SPOT.y, 30, BOSS_SPOT.x, BOSS_SPOT.y, 190);
  bp.addColorStop(0, 'rgba(90,30,130,0.4)');
  bp.addColorStop(1, 'rgba(90,30,130,0)');
  c.fillStyle = bp;
  c.beginPath(); c.arc(BOSS_SPOT.x, BOSS_SPOT.y, 190, 0, 7); c.fill();
  c.strokeStyle = 'rgba(199,125,255,0.35)'; c.lineWidth = 8;
  c.beginPath(); c.arc(BOSS_SPOT.x, BOSS_SPOT.y, 160, 0, 7); c.stroke();
  c.strokeStyle = 'rgba(224,170,255,0.18)'; c.lineWidth = 3;
  c.beginPath(); c.arc(BOSS_SPOT.x, BOSS_SPOT.y, 135, 0, 7); c.stroke();

  // ---- scattered glow crystals near the river ----
  for (let i = 0; i < 30; i++) {
    const t = rnd()*WORLD;
    const off = (rnd()*2 - 1) * 260;
    const x = clamp(t + off*0.707, 60, WORLD - 60);
    const y = clamp(t - off*0.707, 60, WORLD - 60);
    if (distToLanes(x, y) < 130) continue;
    const s = 6 + rnd()*8;
    c.fillStyle = 'rgba(125,249,255,0.5)';
    c.beginPath();
    c.moveTo(x, y - s); c.lineTo(x + s*0.6, y); c.lineTo(x, y + s); c.lineTo(x - s*0.6, y);
    c.closePath(); c.fill();
    c.fillStyle = 'rgba(125,249,255,0.12)';
    c.beginPath(); c.arc(x, y, s*2, 0, 7); c.fill();
  }

  // ---- vignette ----
  const vg = c.createRadialGradient(1600, 1600, 900, 1600, 1600, 2400);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.42)');
  c.fillStyle = vg;
  c.fillRect(0, 0, WORLD, WORLD);

  // map border wall
  c.strokeStyle = 'rgba(125,249,255,0.15)'; c.lineWidth = 20;
  c.strokeRect(10, 10, WORLD - 20, WORLD - 20);
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

  // animated river shimmer
  ctx.save();
  ctx.translate(1600, 1600);
  ctx.rotate(Math.PI / 4);
  ctx.fillStyle = '#cfeeff';
  for (const s of RIVER_SPARKS) {
    ctx.globalAlpha = 0.04 + 0.10 * (0.5 + 0.5 * Math.sin(G.time*1.6 + s.phase));
    ctx.beginPath();
    ctx.ellipse(s.u + 60*Math.sin(G.time*0.5 + s.phase), s.w, 30, 7, 0, 0, 7);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.restore();

  // fountain pulse at each base
  for (const team of ['blue', 'red']) {
    const b = CORES[team];
    ctx.globalAlpha = 0.07 + 0.03 * Math.sin(G.time*2 + (team === 'blue' ? 0 : 2));
    ctx.fillStyle = TEAM_COLOR[team];
    ctx.beginPath(); ctx.arc(b.x, b.y, 250, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
  }

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

  // projectiles: glowing bolts with motion trails
  ctx.lineCap = 'round';
  for (const p of G.projectiles) {
    let vx, vy;
    if (p.homing) {
      const dx = p.homing.x - p.x, dy = p.homing.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      vx = dx/d; vy = dy/d;
    } else { vx = p.dx; vy = p.dy; }
    const len = (p.speed || 800) * 0.05;
    const tg = ctx.createLinearGradient(p.x - vx*len, p.y - vy*len, p.x, p.y);
    tg.addColorStop(0, 'rgba(0,0,0,0)');
    tg.addColorStop(1, p.color);
    ctx.strokeStyle = tg;
    ctx.lineWidth = (p.size || 8) * 1.4;
    ctx.beginPath();
    ctx.moveTo(p.x - vx*len, p.y - vy*len);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.size || 8, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.arc(p.x, p.y, (p.size || 8) * 0.45, 0, 7); ctx.fill();
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
    // ground shadow + stone base
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath(); ctx.ellipse(u.x, u.y + 14, u.radius + 18, (u.radius + 18)*0.5, 0, 0, 7); ctx.fill();
    const sb = ctx.createRadialGradient(u.x - 10, u.y - 12, 8, u.x, u.y, u.radius + 14);
    sb.addColorStop(0, '#4a545f');
    sb.addColorStop(1, '#20262d');
    ctx.fillStyle = sb;
    ctx.beginPath(); ctx.arc(u.x, u.y, u.radius + 14, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(u.x, u.y, u.radius + 14, 0, 7); ctx.stroke();
    // hex body
    const bg = ctx.createLinearGradient(u.x, u.y - u.radius, u.x, u.y + u.radius);
    bg.addColorStop(0, lighten(TEAM_COLOR_D[u.team], 0.18));
    bg.addColorStop(1, TEAM_COLOR_D[u.team]);
    ctx.fillStyle = bg;
    hexPath(ctx, u.x, u.y, u.radius);
    ctx.fill();
    ctx.strokeStyle = tc; ctx.lineWidth = 4;
    hexPath(ctx, u.x, u.y, u.radius);
    ctx.stroke();
    ctx.globalAlpha = 0.25;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    hexPath(ctx, u.x, u.y, u.radius - 8);
    ctx.stroke();
    ctx.globalAlpha = 1;
    // floating crystal
    const bob = 4 * Math.sin(G.time*3 + u.id);
    ctx.shadowColor = tc; ctx.shadowBlur = u.invulnerable ? 6 : 20;
    ctx.fillStyle = tc;
    const cs = 15 + 2*Math.sin(G.time*4 + u.id);
    ctx.beginPath();
    ctx.moveTo(u.x, u.y - cs + bob); ctx.lineTo(u.x + cs*0.65, u.y + bob);
    ctx.lineTo(u.x, u.y + cs + bob); ctx.lineTo(u.x - cs*0.65, u.y + bob);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(u.x, u.y - cs*0.45 + bob); ctx.lineTo(u.x + cs*0.28, u.y + bob);
    ctx.lineTo(u.x, u.y + cs*0.45 + bob); ctx.lineTo(u.x - cs*0.28, u.y + bob);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    if (u.invulnerable) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 3;
      ctx.setLineDash([10, 10]);
      ctx.beginPath(); ctx.arc(u.x, u.y, u.radius + 22, G.time, G.time + 7); ctx.stroke();
      ctx.setLineDash([]);
    }
    drawHpBar(ctx, u, 70);
    return;
  }

  if (u.type === 'core') {
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    ctx.beginPath(); ctx.ellipse(u.x, u.y + 16, u.radius + 16, (u.radius + 16)*0.45, 0, 0, 7); ctx.fill();
    const cg = ctx.createRadialGradient(u.x - 14, u.y - 16, 10, u.x, u.y, u.radius);
    cg.addColorStop(0, lighten(TEAM_COLOR_D[u.team], 0.25));
    cg.addColorStop(1, TEAM_COLOR_D[u.team]);
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(u.x, u.y, u.radius, 0, 7); ctx.fill();
    ctx.strokeStyle = tc; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.arc(u.x, u.y, u.radius, 0, 7); ctx.stroke();
    // rotating rune ring
    ctx.fillStyle = tc;
    for (let i = 0; i < 8; i++) {
      const a = G.time * 0.7 + i * Math.PI/4;
      ctx.beginPath();
      ctx.arc(u.x + Math.cos(a)*(u.radius - 14), u.y + Math.sin(a)*(u.radius - 14), 5, 0, 7);
      ctx.fill();
    }
    // pulsing heart
    const pul = 18 + 6*Math.sin(G.time*3);
    ctx.shadowColor = tc; ctx.shadowBlur = 28;
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(u.x, u.y, pul, 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
    if (u.invulnerable) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 4;
      ctx.setLineDash([14, 12]);
      ctx.beginPath(); ctx.arc(u.x, u.y, u.radius + 20, -G.time*0.8, -G.time*0.8 + 7); ctx.stroke();
      ctx.setLineDash([]);
    }
    drawHpBar(ctx, u, 100);
    return;
  }

  if (u.type === 'minion') {
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(u.x, u.y + u.radius*0.7, u.radius, u.radius*0.4, 0, 0, 7); ctx.fill();
    const bob = 1.5 * Math.sin(G.time*8 + u.id);
    const mg = ctx.createRadialGradient(u.x - 5, u.y - 6 + bob, 3, u.x, u.y + bob, u.radius);
    mg.addColorStop(0, lighten(TEAM_COLOR_D[u.team], 0.28));
    mg.addColorStop(1, TEAM_COLOR_D[u.team]);
    ctx.fillStyle = mg;
    ctx.beginPath(); ctx.arc(u.x, u.y + bob, u.radius, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(u.x, u.y + bob, u.radius, 0, 7); ctx.stroke();
    ctx.strokeStyle = tc; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(u.x, u.y + bob, u.radius, 0, 7); ctx.stroke();
    // glowing eye facing travel direction
    const ex = Math.cos(u.facing)*u.radius*0.45, ey = Math.sin(u.facing)*u.radius*0.45;
    ctx.fillStyle = '#fff';
    ctx.shadowColor = tc; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.arc(u.x + ex, u.y + ey + bob, 3.5, 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
    if (u.ranged) {
      ctx.fillStyle = tc;
      ctx.beginPath(); ctx.arc(u.x, u.y + bob, 5.5, 0, 7); ctx.fill();
    } else {
      ctx.strokeStyle = tc; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(u.x - 6, u.y - 4 + bob); ctx.lineTo(u.x + 6, u.y + 4 + bob);
      ctx.moveTo(u.x + 6, u.y - 4 + bob); ctx.lineTo(u.x - 6, u.y + 4 + bob);
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

  // body (with a light walk bob)
  const bob = 2 * Math.sin(G.time*7 + h.id);
  ctx.save();
  ctx.translate(0, bob);
  const g = ctx.createRadialGradient(h.x - r*0.3, h.y - r*0.3, r*0.2, h.x, h.y, r);
  g.addColorStop(0, lighten(c, 0.35));
  g.addColorStop(1, c);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(h.x, h.y, r, 0, 7); ctx.fill();
  // dark outline + rim light
  ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(h.x, h.y, r, 0, 7); ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(h.x, h.y, r - 2, -2.4, -0.9); ctx.stroke();

  drawHeroGlyph(ctx, h.def.id, h.x, h.y, r, h.facing);
  ctx.restore();

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
  const h = withMana ? 10 : 7;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(x - 1.5, y - 1.5, w + 3, h + 3);
  const base = u.team === G.player.team ? '#22b95c' : (u.team === 'jungle' ? '#9d5ed3' : '#d92f42');
  const top  = u.team === G.player.team ? '#5cf291' : (u.team === 'jungle' ? '#d9a6ff' : '#ff7385');
  const hg = ctx.createLinearGradient(0, y, 0, y + 5);
  hg.addColorStop(0, top); hg.addColorStop(1, base);
  ctx.fillStyle = hg;
  ctx.fillRect(x, y, w * frac, 5);
  const sh = u.shieldTotal ? u.shieldTotal() : 0;
  if (sh > 0) {
    const sf = clamp(sh / u.hpMax(), 0, 1 - frac);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(x + w*frac, y, w * sf, 5);
  }
  // segment ticks every 25% on bigger bars
  if (w >= 60) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    for (let q = 0.25; q < 1; q += 0.25) ctx.fillRect(x + w*q - 0.5, y, 1, 5);
  }
  if (withMana && u.manaMax > 0) {
    const mg = ctx.createLinearGradient(0, y + 6, 0, y + 9);
    mg.addColorStop(0, '#7cb7ff'); mg.addColorStop(1, '#2563eb');
    ctx.fillStyle = mg;
    ctx.fillRect(x, y + 6, w * clamp(u.mana / u.manaMax, 0, 1), 3);
  }
}

function lighten(hex, amt) {
  const n = parseInt(hex.slice(1), 16);
  let r = (n >> 16) + Math.round(255*amt), g = ((n >> 8) & 255) + Math.round(255*amt), b = (n & 255) + Math.round(255*amt);
  r = Math.min(255, r); g = Math.min(255, g); b = Math.min(255, b);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}
