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
  vision: { blue: [], red: [] },
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
    const randSpell = () => BATTLE_SPELLS[(Math.random() * BATTLE_SPELLS.length) | 0].id;
    blueIds.forEach((id, i) => {
      const h = new Hero(heroById(id), 'blue', i === 0);
      h.lane = i === 0 ? 'mid' : laneAssign[i];
      // player uses their picked spell; everyone else gets a random one
      h.battleSpell = i === 0 ? (UI.selectedSpell || 'flicker') : randSpell();
      G.units.push(h); G.heroes.push(h);
      if (i === 0) G.player = h;
    });
    redIds.forEach((id, i) => {
      const h = new Hero(heroById(id), 'red', false);
      h.lane = ['mid', 'top', 'bot', 'top', 'bot'][i];
      h.battleSpell = randSpell();
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
    initFog();
    G.vision = { blue: computeVisionCircles('blue'), red: computeVisionCircles('red') };
    UI.onGameStart();
    UI.announce('Welcome to Void Arena!', '#7df9ff');
    UI.announce('Destroy the enemy Void Core!', '#fff');
  },

  update(dt) {
    if (!G.running || G.over) return;
    G.time += dt;

    // fog of war: recomputed once per tick, used by this tick's AI and this frame's render
    G.vision = { blue: computeVisionCircles('blue'), red: computeVisionCircles('red') };

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

    // structure invulnerability chain (MLBB-style progression):
    //   outer lane turret → inner lane turret → [lane broken] → base turrets → Core
    for (const t of G.towers) {
      if (t.dead) continue;
      if (t.lane === 'base') {
        // base turrets stay shielded until at least one lane is fully cleared,
        // and then still fall outer-first
        const laneBroken = ['top', 'mid', 'bot'].some(lane =>
          G.towers.filter(o => o.team === t.team && o.lane === lane).every(o => o.dead));
        const higherBaseAlive = G.towers.some(o => o.team === t.team && o.lane === 'base' && !o.dead && o.order < t.order);
        t.invulnerable = !laneBroken || higherBaseAlive;
      } else {
        t.invulnerable = G.towers.some(o => o.team === t.team && o.lane === t.lane && !o.dead && o.order < t.order);
      }
    }
    for (const team of ['blue', 'red']) {
      const core = G.cores[team];
      if (!core.dead) {
        // the Core is exposed only once BOTH base turrets have fallen
        core.invulnerable = G.towers.some(t => t.team === team && t.lane === 'base' && !t.dead);
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

    // camera follows player (world y is foreshortened by YS on screen)
    const cv = UI.canvas;
    G.cam.zoom = cv.height / CFG.viewHeight;
    const halfW = cv.width / 2 / G.cam.zoom, halfH = cv.height / 2 / (G.cam.zoom * YS);
    G.cam.x = clamp(G.player.x, halfW, WORLD - halfW);
    G.cam.y = clamp(G.player.y, Math.min(halfH, WORLD/2), Math.max(WORLD - halfH, WORLD/2));
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
      if (killerHero) {
        killerHero.gold += CFG.minionGold; killerHero.cs++;
        if (killerHero === G.player) goldPop(u, CFG.minionGold);
      }
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
        if (killerHero) {
          killerHero.gold += CFG.jungleGold;
          if (killerHero === G.player) goldPop(u, CFG.jungleGold);
        }
        shareXp(u, CFG.jungleXp);
        // buff camps grant the killer a timed combat buff
        if (u.buffType && killerHero) {
          const bc = BUFF_CAMPS[u.buffType];
          if (bc) {
            bc.apply(killerHero);
            if (killerHero === G.player) UI.announce(bc.name + ' — buff claimed!', bc.color);
          }
        }
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
      u.mkCount = 0;            // dying breaks any multi-kill chain
      u.respawnT = CFG.respawnBase + u.level * CFG.respawnPerLevel;

      if (killerHero) {
        const kGold = CFG.heroKillGold + streakBonus;
        killerHero.kills++;
        killerHero.streak++;
        killerHero.gold += kGold;
        killerHero.gainXp(CFG.heroKillXp);
        if (killerHero === G.player) goldPop(u, kGold, true);

        // multi-kill chain: consecutive kills inside a short window
        killerHero.mkCount = (killerHero.mkTime !== undefined && G.time - killerHero.mkTime <= CFG.multiKillWindow)
          ? (killerHero.mkCount || 0) + 1 : 1;
        killerHero.mkTime = G.time;

        const first = !G.firstBlood;
        if (first) G.firstBlood = true;

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
        UI.killEvent(killerHero, u, first);
      }
      u.recentDamagers = {};
      UI.feed(killerHero, u, killerHero ? killerHero.team : (u.team === 'blue' ? 'red' : 'blue'));
      if (u.isPlayer && !killerHero) { UI.announce('You have been slain!', '#ff5c5c'); Sfx.play('death'); }
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

  playerBattleSpell(dragDir) {
    const h = G.player;
    if (!h || !h.bsReady()) return;
    let dx, dy;
    if (dragDir) { dx = dragDir.dx; dy = dragDir.dy; }
    else if (Input.joy.active && (Input.joy.dx || Input.joy.dy)) {
      const d = Math.hypot(Input.joy.dx, Input.joy.dy) || 1; dx = Input.joy.dx/d; dy = Input.joy.dy/d;
    } else {
      const t = nearestEnemy(h, 520, u => u.type === 'hero');
      if (t) { const d = dist(h, t) || 1; dx = (t.x - h.x)/d; dy = (t.y - h.y)/d; }
      else { dx = Math.cos(h.facing); dy = Math.sin(h.facing); }
    }
    h.castBattleSpell({ dx, dy });
  },

  playerBuy() {
    const h = G.player;
    const next = h.nextBuildItem();
    if (next && h.buyItem(next)) h.buildIdx++;
  },
};

// floating "+gold" number over a unit the player just last-hit (MLBB-style
// last-hit feedback). `big` is used for hero kills so they read as a bigger reward.
function goldPop(u, amount, big) {
  FX.push({ type:'text', x:u.x + (Math.random()*20 - 10), y:u.y - u.radius - 6,
    text:'+' + Math.round(amount), color:'#ffd24a', dur: big ? 1.2 : 0.9, big: !!big, t:0 });
}

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
const YS = 0.72;      // 2.5D ground foreshortening: world y compresses to y*YS on screen

// ---- fog of war ----
// fogExplored: low-res, persistent, never cleared — once the player's team
// has seen a spot it stays dimly visible forever, like the classic MOBA minimap fog.
// fogMask: rebuilt every frame from fogExplored + this frame's live vision circles,
// then drawn as a translucent black layer over both the main view and the minimap.
const FOG_RES = 256;
const FOG_S = FOG_RES / WORLD;
let fogExplored = null, fogMask = null, fogSmooth = null;

function initFog() {
  fogExplored = document.createElement('canvas');
  fogExplored.width = FOG_RES; fogExplored.height = FOG_RES;
  fogMask = document.createElement('canvas');
  fogMask.width = FOG_RES; fogMask.height = FOG_RES;
  fogSmooth = document.createElement('canvas');
  fogSmooth.width = FOG_RES; fogSmooth.height = FOG_RES;
}

function updateFogMask() {
  if (!fogExplored || !G.player) return;
  const circles = G.vision[G.player.team] || [];

  const ec = fogExplored.getContext('2d');
  for (const c of circles) {
    // wide taper so explored borders fade gently — hard rims make the
    // leftover fog pockets between circles read as sharp black shards
    const g = ec.createRadialGradient(c.x*FOG_S, c.y*FOG_S, 0, c.x*FOG_S, c.y*FOG_S, c.r*FOG_S);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.45, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ec.fillStyle = g;
    ec.beginPath(); ec.arc(c.x*FOG_S, c.y*FOG_S, c.r*FOG_S, 0, 7); ec.fill();
  }

  const mc = fogMask.getContext('2d');
  mc.globalCompositeOperation = 'source-over';
  // MLBB-style daylight fog: unexplored is dusk, not blackout, and explored
  // ground stays clearly readable under a light haze
  mc.fillStyle = 'rgba(8,14,22,0.55)';
  mc.fillRect(0, 0, FOG_RES, FOG_RES);
  // dim (but don't fully clear) areas the team has explored before
  mc.globalCompositeOperation = 'destination-out';
  mc.globalAlpha = 0.6;
  mc.drawImage(fogExplored, 0, 0);
  mc.globalAlpha = 1;
  // fully clear current live vision, with a long soft edge
  for (const c of circles) {
    const g = mc.createRadialGradient(c.x*FOG_S, c.y*FOG_S, c.r*FOG_S*0.3, c.x*FOG_S, c.y*FOG_S, c.r*FOG_S);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    mc.fillStyle = g;
    mc.beginPath(); mc.arc(c.x*FOG_S, c.y*FOG_S, c.r*FOG_S, 0, 7); mc.fill();
  }
  mc.globalCompositeOperation = 'source-over';

  // blur the finished mask: the leftover fog pockets between overlapping
  // vision circles have geometrically sharp cusps at the circle
  // intersections, which read on-screen as jagged black shards — a small
  // blur at mask resolution rounds every fog boundary into soft shade
  const sc = fogSmooth.getContext('2d');
  sc.clearRect(0, 0, FOG_RES, FOG_RES);
  sc.filter = 'blur(3px)';
  sc.drawImage(fogMask, 0, 0);
  sc.filter = 'none';
}

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

// Traces a smooth, irregular hand-painted-looking blob instead of a perfect
// circle/polygon: N control points at a jittered radius, joined with
// quadratic curves through their midpoints so the outline stays soft and
// organic rather than faceted. Used for every "natural" shape on the map —
// grass patches, foliage, dirt, stone, water — nothing round or boxy is left
// as a raw circle/rect once this is applied.
//
// blobPoints() generates the jittered unit-circle shape once; tracePts()
// paints it at any position/size/rotation. Split this way so shapes drawn
// live every frame (tree canopies, bush leaves) can precompute their outline
// once at placement time and stay visually stable instead of re-randomizing
// — a jittering canopy would look like static, not foliage.
function blobPoints(rnd, pts, jitter) {
  const P = [];
  for (let i = 0; i < pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    const rr = 1 - jitter/2 + rnd()*jitter;
    P.push([Math.cos(a)*rr, Math.sin(a)*rr]);
  }
  return P;
}
function tracePts(c, P, x, y, r, squash = 1, rot = 0) {
  const cos = Math.cos(rot), sin = Math.sin(rot);
  const T = P.map(([lx, ly]) => {
    const sx = lx*r, sy = ly*r*squash;
    return [x + sx*cos - sy*sin, y + sx*sin + sy*cos];
  });
  c.beginPath();
  let mx = (T[0][0]+T[T.length-1][0])/2, my = (T[0][1]+T[T.length-1][1])/2;
  c.moveTo(mx, my);
  for (let i = 0; i < T.length; i++) {
    const nxt = T[(i+1) % T.length];
    mx = (T[i][0]+nxt[0])/2; my = (T[i][1]+nxt[1])/2;
    c.quadraticCurveTo(T[i][0], T[i][1], mx, my);
  }
  c.closePath();
}
function blobPath(c, x, y, r, rnd, opts = {}) {
  const pts = opts.pts || (6 + Math.floor(rnd()*3));
  const jitter = opts.jitter !== undefined ? opts.jitter : 0.4;
  tracePts(c, blobPoints(rnd, pts, jitter), x, y, r, opts.squash || 1, opts.rot || 0);
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

  // ---- base ground: mid-value mossy sage, the classic hand-painted MOBA lawn ----
  const grd = c.createLinearGradient(0, 0, WORLD, WORLD);
  grd.addColorStop(0, '#4c6e51');
  grd.addColorStop(0.5, '#40655a');
  grd.addColorStop(1, '#5e6a40');
  c.fillStyle = grd;
  c.fillRect(0, 0, WORLD, WORLD);

  // territory tints (blue owns the bottom-left half, red the top-right)
  c.fillStyle = 'rgba(40,110,170,0.10)';
  c.beginPath(); c.moveTo(0, 0); c.lineTo(0, WORLD); c.lineTo(WORLD, WORLD); c.closePath(); c.fill();
  c.fillStyle = 'rgba(170,50,70,0.09)';
  c.beginPath(); c.moveTo(0, 0); c.lineTo(WORLD, 0); c.lineTo(WORLD, WORLD); c.closePath(); c.fill();

  // mottled grass: multi-octave irregular blobs (large soft patches, then
  // medium clumps, then tiny tufts) instead of uniform circles — this is
  // what gives painted grass its depth rather than a polka-dot look
  const grassTones = ['rgba(120,170,100,0.10)', 'rgba(50,105,70,0.12)', 'rgba(150,190,110,0.07)', 'rgba(30,70,55,0.12)'];
  for (let i = 0; i < 260; i++) {
    c.fillStyle = grassTones[i % grassTones.length];
    blobPath(c, rnd()*WORLD, rnd()*WORLD, 60 + rnd()*110, rnd, { pts:7, jitter:0.5 });
    c.fill();
  }
  for (let i = 0; i < 500; i++) {
    c.fillStyle = grassTones[(i+2) % grassTones.length];
    blobPath(c, rnd()*WORLD, rnd()*WORLD, 14 + rnd()*30, rnd, { pts:6, jitter:0.6 });
    c.fill();
  }
  // small grass tufts: short curved blade strokes fanning from a root point,
  // clustered instead of scattered so they read as tufts, not noise
  for (let i = 0; i < 420; i++) {
    const cx = rnd()*WORLD, cy = rnd()*WORLD;
    const dark = rnd() > 0.5;
    c.strokeStyle = dark ? 'rgba(15,45,25,0.20)' : 'rgba(215,240,185,0.20)';
    c.lineWidth = 1.6; c.lineCap = 'round';
    const blades = 3 + Math.floor(rnd()*3);
    for (let b = 0; b < blades; b++) {
      const a = rnd()*Math.PI*2, len = 6 + rnd()*10;
      const bend = (rnd()-0.5)*8;
      c.beginPath();
      c.moveTo(cx, cy);
      c.quadraticCurveTo(cx + Math.cos(a)*len*0.6 + bend, cy + Math.sin(a)*len*0.6,
                          cx + Math.cos(a)*len, cy + Math.sin(a)*len);
      c.stroke();
    }
  }
  // dirt/wear scuffs: thin irregular smudges instead of round speckle dots
  for (let i = 0; i < 260; i++) {
    c.fillStyle = rnd() > 0.5 ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.045)';
    blobPath(c, rnd()*WORLD, rnd()*WORLD, 4 + rnd()*10, rnd, { pts:5, jitter:0.7, squash:0.5, rot:rnd()*6.28 });
    c.fill();
  }
  // tiny wildflowers dotting the open grass
  for (let i = 0; i < 170; i++) {
    const x = rnd()*WORLD, y = rnd()*WORLD;
    if (distToLanes(x, y) < 120) continue;
    c.fillStyle = rnd() > 0.5 ? 'rgba(255,250,220,0.45)' : 'rgba(255,215,130,0.4)';
    c.beginPath(); c.arc(x, y, 2.2 + rnd()*1.8, 0, 7); c.fill();
  }

  // mowed-lawn stripes: alternating faint diagonal bands, the classic
  // groundskeeper texture on every MOBA's open grass
  c.save();
  c.translate(WORLD/2, WORLD/2);
  c.rotate(-Math.PI/4);
  const stripeW = 130;
  for (let i = -14; i < 14; i++) {
    c.fillStyle = i % 2 === 0 ? 'rgba(255,255,255,0.018)' : 'rgba(0,0,0,0.022)';
    c.fillRect(i*stripeW, -WORLD, stripeW, WORLD*2);
  }
  c.restore();

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
  // banks with a broken foam highlight just inside the waterline
  c.strokeStyle = 'rgba(220,240,255,0.08)';
  c.lineWidth = 6;
  c.beginPath(); c.moveTo(-2400, -150); c.lineTo(2400, -150); c.stroke();
  c.beginPath(); c.moveTo(-2400, 150); c.lineTo(2400, 150); c.stroke();
  c.strokeStyle = 'rgba(255,255,255,0.22)'; c.lineWidth = 3; c.setLineDash([26, 18]);
  c.beginPath(); c.moveTo(-2400, -138); c.lineTo(2400, -138); c.stroke();
  c.beginPath(); c.moveTo(-2400, 138); c.lineTo(2400, 138); c.stroke();
  c.setLineDash([]);

  // stepping-stone crossings
  for (const cu of [-950, 700]) {
    for (let s = -2; s <= 2; s++) {
      const sx = cu + s*4, sy = s*58 + (rnd()-0.5)*10;
      c.fillStyle = 'rgba(0,0,0,0.3)';
      c.beginPath(); c.ellipse(sx+3, sy+4, 26, 20, 0, 0, 7); c.fill();
      const sg = c.createLinearGradient(sx-24, sy-18, sx+24, sy+18);
      sg.addColorStop(0, '#6b7480'); sg.addColorStop(1, '#454d58');
      c.fillStyle = sg;
      c.beginPath(); c.ellipse(sx, sy, 25, 19, 0, 0, 7); c.fill();
      c.strokeStyle = 'rgba(0,0,0,0.4)'; c.lineWidth = 2;
      c.beginPath(); c.ellipse(sx, sy, 25, 19, 0, 0, 7); c.stroke();
    }
  }
  c.restore();

  // ---- lanes: stone roads ----
  c.lineCap = 'round'; c.lineJoin = 'round';
  for (const lane of Object.values(LANES)) {
    const path = () => {
      c.beginPath();
      c.moveTo(lane[0][0], lane[0][1]);
      for (const p of lane) c.lineTo(p[0], p[1]);
    };
    c.strokeStyle = 'rgba(30,25,15,0.30)'; c.lineWidth = 168; path(); c.stroke();   // road edge shadow
    c.strokeStyle = 'rgba(172,158,126,0.45)'; c.lineWidth = 150; path(); c.stroke(); // stone bed
    c.strokeStyle = 'rgba(214,200,164,0.32)'; c.lineWidth = 108; path(); c.stroke(); // worn center

    // cobblestone paving: individual offset-brick blocks laid across the road width
    for (let i = 0; i < lane.length - 1; i++) {
      const [ax, ay] = lane[i], [bx, by] = lane[i+1];
      const segLen = Math.hypot(bx - ax, by - ay);
      const ux = (bx - ax)/segLen, uy = (by - ay)/segLen;
      const nx = -uy, ny = ux;
      const stoneW = 34, stoneH = 26, rows = 4;
      let rowN = 0;
      for (let row = -rows/2; row < rows/2; row++) {
        const rowOff = (rowN++ % 2) * (stoneW/2);
        for (let d = rowOff; d < segLen; d += stoneW) {
          const px = ax + ux*d + nx*(row*stoneH + stoneH/2);
          const py = ay + uy*d + ny*(row*stoneH + stoneH/2);
          const shade = 0.5 + rnd()*0.5;
          const stonePts = blobPoints(rnd, 6, 0.22); // hand-cut stone, not a rounded rect
          c.save();
          c.translate(px, py);
          c.rotate(Math.atan2(uy, ux));
          c.fillStyle = `rgba(${Math.round(182*shade)},${Math.round(168*shade)},${Math.round(136*shade)},0.30)`;
          tracePts(c, stonePts, 0, 0, stoneW/2-1.5, (stoneH-3)/(stoneW-3));
          c.fill();
          c.strokeStyle = 'rgba(40,32,20,0.22)'; c.lineWidth = 1.5;
          tracePts(c, stonePts, 0, 0, stoneW/2-1.5, (stoneH-3)/(stoneW-3));
          c.stroke();
          c.restore();
        }
      }
    }
  }

  // ---- carved rune circles: the big concentric stone engravings MLBB-style
  // maps stamp along their lanes. Placed at interior lane waypoints. ----
  const runeCircle = (x, y, R) => {
    c.save(); c.translate(x, y);
    // stone slab disc the carving sits on
    c.fillStyle = 'rgba(196,182,150,0.30)';
    c.beginPath(); c.arc(0, 0, R + 8, 0, 7); c.fill();
    // outer groove + light chisel highlight beside it
    c.strokeStyle = 'rgba(52,42,26,0.38)'; c.lineWidth = 9;
    c.beginPath(); c.arc(0, 0, R, 0, 7); c.stroke();
    c.strokeStyle = 'rgba(228,214,178,0.30)'; c.lineWidth = 3;
    c.beginPath(); c.arc(0, 0, R - 8, 0, 7); c.stroke();
    // inner groove ring
    c.strokeStyle = 'rgba(52,42,26,0.30)'; c.lineWidth = 6;
    c.beginPath(); c.arc(0, 0, R*0.55, 0, 7); c.stroke();
    // radial spokes between the rings
    c.strokeStyle = 'rgba(52,42,26,0.24)'; c.lineWidth = 5;
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI/4 + 0.4;
      c.beginPath();
      c.moveTo(Math.cos(a)*R*0.58, Math.sin(a)*R*0.58);
      c.lineTo(Math.cos(a)*(R - 11), Math.sin(a)*(R - 11));
      c.stroke();
    }
    c.fillStyle = 'rgba(228,214,178,0.22)';
    c.beginPath(); c.arc(0, 0, 10, 0, 7); c.fill();
    c.restore();
  };
  for (const lane of Object.values(LANES)) {
    for (let i = 1; i < lane.length - 1; i++) {
      const [wx, wy] = lane[i];
      if (Math.hypot(wx - BOSS_SPOT.x, wy - BOSS_SPOT.y) < 300) continue;
      if (Math.hypot(wx - CORES.blue.x, wy - CORES.blue.y) < 520) continue;
      if (Math.hypot(wx - CORES.red.x, wy - CORES.red.y) < 520) continue;
      runeCircle(wx, wy, 72 + (i % 2) * 26);
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

    // fortress wall ring with a gate opening facing the lanes toward map center
    const gateAngle = Math.atan2(1600 - b.y, 1600 - b.x);
    const gateHalf = 0.55;
    const wallR = 300;
    c.strokeStyle = '#2a2f38'; c.lineWidth = 26; c.lineCap = 'butt';
    c.beginPath(); c.arc(b.x, b.y, wallR, gateAngle + gateHalf, gateAngle - gateHalf + Math.PI*2); c.stroke();
    c.strokeStyle = '#454d59'; c.lineWidth = 20;
    c.beginPath(); c.arc(b.x, b.y, wallR, gateAngle + gateHalf, gateAngle - gateHalf + Math.PI*2); c.stroke();
    c.strokeStyle = tc; c.globalAlpha = 0.4; c.lineWidth = 3;
    c.beginPath(); c.arc(b.x, b.y, wallR + 12, gateAngle + gateHalf, gateAngle - gateHalf + Math.PI*2); c.stroke();
    c.globalAlpha = 1;
    // merlons (crenellations) along the wall top
    const startA = gateAngle + gateHalf, endA = gateAngle - gateHalf + Math.PI*2;
    const merlons = 26;
    for (let i = 0; i <= merlons; i++) {
      const a = startA + (endA - startA) * (i / merlons);
      if (i % 2 === 0) continue;
      c.save();
      c.translate(b.x + Math.cos(a)*wallR, b.y + Math.sin(a)*wallR);
      c.rotate(a);
      c.fillStyle = '#5a6371';
      c.fillRect(-6, -14, 12, 14);
      c.restore();
    }
    // gate pillars flanking the opening, each topped with a team banner
    for (const ga of [gateAngle + gateHalf, gateAngle - gateHalf]) {
      const px = b.x + Math.cos(ga)*wallR, py = b.y + Math.sin(ga)*wallR;
      c.fillStyle = '#575f6b';
      c.beginPath(); c.arc(px, py, 17, 0, 7); c.fill();
      c.strokeStyle = tc; c.lineWidth = 2.5; c.globalAlpha = 0.6;
      c.beginPath(); c.arc(px, py, 17, 0, 7); c.stroke();
      c.globalAlpha = 1;
      c.strokeStyle = '#3a4048'; c.lineWidth = 5;
      c.beginPath(); c.moveTo(px, py - 8); c.lineTo(px, py - 58); c.stroke();
      c.fillStyle = tc; c.globalAlpha = 0.85;
      c.beginPath();
      c.moveTo(px, py - 58); c.lineTo(px + 26, py - 50); c.lineTo(px, py - 40);
      c.closePath(); c.fill();
      c.globalAlpha = 1;
    }

    // paved courtyard: concentric rings of radial stone wedges, kept inside the inner hex line
    for (let ring = 0; ring < 3; ring++) {
      const rIn = 25 + ring*52, rOut = rIn + 46;
      const wedges = 14 + ring*4;
      for (let i = 0; i < wedges; i++) {
        const a0 = (i/wedges)*Math.PI*2, a1 = ((i+0.92)/wedges)*Math.PI*2;
        const shade = 0.55 + rnd()*0.35;
        c.fillStyle = `rgba(${Math.round(60*shade)},${Math.round(70*shade)},${Math.round(82*shade)},0.4)`;
        c.beginPath();
        c.arc(b.x, b.y, rOut, a0, a1);
        c.arc(b.x, b.y, rIn, a1, a0, true);
        c.closePath(); c.fill();
        c.strokeStyle = 'rgba(0,0,0,0.25)'; c.lineWidth = 1.5; c.stroke();
      }
    }
  }

  // boulders are drawn upright at render time; leave a worn patch on the ground
  for (const r of ROCKS) {
    c.fillStyle = 'rgba(15,18,22,0.4)';
    c.beginPath(); c.ellipse(r.x, r.y, r.r*1.1, r.r*0.5, 0, 0, 7); c.fill();
  }

  // ---- bushes: irregular leaf-cluster silhouette, not a rounded box ----
  for (const b of BUSHES) {
    const cx = b.x + b.w/2, cy = b.y + b.h/2;
    const rad = Math.max(b.w, b.h)/2;
    const squash = Math.min(b.w, b.h) / Math.max(b.w, b.h);
    const rotBush = b.w >= b.h ? 0 : Math.PI/2;
    const bushPts = blobPoints(rnd, 9, 0.3);   // same outline reused for shadow/fill/stroke
    c.fillStyle = 'rgba(0,0,0,0.28)';
    tracePts(c, bushPts, cx + 6, cy + 10, rad*1.06, squash, rotBush);
    c.fill();
    c.fillStyle = 'rgba(26,92,48,0.85)';
    tracePts(c, bushPts, cx, cy, rad*1.06, squash, rotBush);
    c.fill();
    const leaves = 10 + Math.floor((b.w * b.h) / 6000);
    for (let i = 0; i < leaves; i++) {
      const lx = b.x + 22 + rnd()*(b.w - 44);
      const ly = b.y + 22 + rnd()*(b.h - 44);
      const lr = 16 + rnd()*18;
      c.fillStyle = i % 3 === 0 ? 'rgba(76,175,102,0.75)' : 'rgba(46,138,74,0.8)';
      blobPath(c, lx, ly, lr, rnd, { pts:6, jitter:0.45 });
      c.fill();
      c.fillStyle = 'rgba(158,230,170,0.35)';
      blobPath(c, lx - lr*0.3, ly - lr*0.35, lr*0.4, rnd, { pts:5, jitter:0.5 });
      c.fill();
    }
    // small berry/flower accents scattered through the foliage
    for (let i = 0; i < 4; i++) {
      const bx2 = b.x + 20 + rnd()*(b.w - 40), by2 = b.y + 20 + rnd()*(b.h - 40);
      c.fillStyle = rnd() > 0.5 ? 'rgba(255,120,140,0.6)' : 'rgba(255,224,140,0.55)';
      c.beginPath(); c.arc(bx2, by2, 3 + rnd()*2.5, 0, 7); c.fill();
    }
    c.strokeStyle = 'rgba(120,220,150,0.35)'; c.lineWidth = 3;
    tracePts(c, bushPts, cx, cy, rad*1.06, squash, rotBush);
    c.stroke();
  }

  // ---- jungle camp pads: trampled lair ground with bone/rubble scatter ----
  for (const cp of CAMPS) {
    c.fillStyle = 'rgba(40,25,20,0.30)';
    c.beginPath(); c.arc(cp.x, cp.y, 120, 0, 7); c.fill();
    c.fillStyle = 'rgba(60,30,80,0.22)';
    c.beginPath(); c.arc(cp.x, cp.y, 120, 0, 7); c.fill();
    c.strokeStyle = 'rgba(199,125,255,0.22)'; c.lineWidth = 5;
    c.setLineDash([18, 14]);
    c.beginPath(); c.arc(cp.x, cp.y, 120, 0, 7); c.stroke();
    c.setLineDash([]);
    // scattered bones and broken rubble marking the monster's lair
    for (let i = 0; i < 7; i++) {
      const a = rnd()*Math.PI*2, d = rnd()*90;
      const bx = cp.x + Math.cos(a)*d, by = cp.y + Math.sin(a)*d;
      c.save();
      c.translate(bx, by); c.rotate(rnd()*6.28);
      if (i % 3 === 0) {
        c.fillStyle = 'rgba(210,200,180,0.4)';
        c.beginPath(); c.ellipse(0, 0, 16, 4.5, 0, 0, 7); c.fill();
        c.beginPath(); c.arc(-14, 0, 5, 0, 7); c.fill();
        c.beginPath(); c.arc(14, 0, 5, 0, 7); c.fill();
      } else {
        c.fillStyle = 'rgba(70,60,55,0.35)';
        c.beginPath(); c.moveTo(-7,-5); c.lineTo(7,-3); c.lineTo(5,6); c.lineTo(-6,5); c.closePath(); c.fill();
      }
      c.restore();
    }
  }

  // ---- boss pit: cracked ground with glowing fissures radiating from the center ----
  const bp = c.createRadialGradient(BOSS_SPOT.x, BOSS_SPOT.y, 30, BOSS_SPOT.x, BOSS_SPOT.y, 190);
  bp.addColorStop(0, 'rgba(90,30,130,0.4)');
  bp.addColorStop(1, 'rgba(90,30,130,0)');
  c.fillStyle = bp;
  c.beginPath(); c.arc(BOSS_SPOT.x, BOSS_SPOT.y, 190, 0, 7); c.fill();
  c.fillStyle = 'rgba(10,4,16,0.35)';
  c.beginPath(); c.arc(BOSS_SPOT.x, BOSS_SPOT.y, 150, 0, 7); c.fill();
  for (let i = 0; i < 9; i++) {
    const a = (i/9)*Math.PI*2 + rnd()*0.3;
    let x = BOSS_SPOT.x, y = BOSS_SPOT.y, ang = a;
    c.strokeStyle = 'rgba(199,125,255,0.5)'; c.lineWidth = 2.5;
    c.beginPath(); c.moveTo(x, y);
    for (let seg = 0; seg < 4; seg++) {
      ang += (rnd()-0.5)*0.6;
      x += Math.cos(ang)*(20+rnd()*16); y += Math.sin(ang)*(20+rnd()*16);
      c.lineTo(x, y);
    }
    c.stroke();
  }
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

  // ---- jungle canopy overhanging the borders: MLBB frames its arena with
  // trees leaning into the play space, which instantly sells "forest" ----
  const canopy = (cx2, cy2, r) => {
    c.fillStyle = 'rgba(8,28,16,0.85)';
    blobPath(c, cx2 + 5, cy2 + 9, r*1.05, rnd, { pts:8, jitter:0.35 }); c.fill();
    c.fillStyle = '#1d4a2b';
    blobPath(c, cx2, cy2, r, rnd, { pts:8, jitter:0.35 }); c.fill();
    c.fillStyle = 'rgba(62,132,70,0.9)';
    blobPath(c, cx2 - r*0.15, cy2 - r*0.18, r*0.72, rnd, { pts:7, jitter:0.4 }); c.fill();
    c.fillStyle = 'rgba(135,200,120,0.4)';
    blobPath(c, cx2 - r*0.26, cy2 - r*0.3, r*0.4, rnd, { pts:6, jitter:0.5 }); c.fill();
  };
  for (let d = 0; d < WORLD; d += 95 + rnd()*70) {
    const rr = () => 55 + rnd()*45;
    canopy(d + rnd()*40, -15 + rnd()*50, rr());          // top edge
    canopy(d + rnd()*40, WORLD + 15 - rnd()*50, rr());   // bottom edge
    canopy(-15 + rnd()*50, d + rnd()*40, rr());          // left edge
    canopy(WORLD + 15 - rnd()*50, d + rnd()*40, rr());   // right edge
  }

  // ---- directional lighting: soft sun from the top-left, multiplied over everything ----
  c.globalCompositeOperation = 'multiply';
  const sun = c.createLinearGradient(0, 0, WORLD, WORLD);
  sun.addColorStop(0, 'rgba(255,255,255,1)');
  sun.addColorStop(0.55, 'rgba(255,255,255,0.96)');
  sun.addColorStop(1, 'rgba(190,190,200,0.92)');
  c.fillStyle = sun;
  c.fillRect(0, 0, WORLD, WORLD);
  // daylight lift: screen a pale green over everything so the whole arena
  // reads as sunlit meadow (matches MLBB's bright ground) despite the many
  // dark mottling layers stacked above
  c.globalCompositeOperation = 'screen';
  c.fillStyle = 'rgba(104,128,86,0.32)';
  c.fillRect(0, 0, WORLD, WORLD);
  c.globalCompositeOperation = 'source-over';

  // ---- vignette ----
  const vg = c.createRadialGradient(1600, 1600, 900, 1600, 1600, 2400);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.25)');
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
  const shakeAmt = (UI.hitShake || 0) * 10;
  const shakeX = shakeAmt ? (Math.random()*2-1)*shakeAmt : 0;
  const shakeY = shakeAmt ? (Math.random()*2-1)*shakeAmt : 0;
  ctx.save();
  ctx.translate(cv.width/2 - G.cam.x*z + shakeX, cv.height/2 - G.cam.y*YS*z + shakeY);
  ctx.scale(z, z);

  // ground plane, foreshortened by the 2.5D camera tilt
  if (mapCanvas) ctx.drawImage(mapCanvas, 0, 0, WORLD, WORLD*YS);

  // animated river shimmer (lives on the ground plane)
  ctx.save();
  ctx.scale(1, YS);
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
    ctx.beginPath(); ctx.ellipse(b.x, b.y*YS, 250, 250*YS, 0, 0, 7); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // zones (ground ellipses) — persistent skill areas with a spawn-in / fade-out
  for (const zn of G.zones) {
    ctx.save();
    ctx.translate(zn.x, zn.y*YS);
    ctx.scale(1, YS);
    // grow in over the first 0.25s, fade out over the last 0.4s of life
    const life = zn.dur ? clamp(zn.t / zn.dur, 0, 1) : 0;
    const grow = zn.dur ? clamp(zn.t / 0.25, 0, 1) : 1;
    const fade = zn.dur ? clamp((zn.dur - zn.t) / 0.4, 0, 1) : 1;
    const rr = zn.r * (0.7 + 0.3*grow);
    // filled body with soft radial falloff
    const zg = ctx.createRadialGradient(0, 0, rr*0.2, 0, 0, rr);
    zg.addColorStop(0, hexA(zn.color, (0.22 + 0.08*Math.sin(G.time*6)) * fade));
    zg.addColorStop(0.8, hexA(zn.color, 0.12 * fade));
    zg.addColorStop(1, hexA(zn.color, 0));
    ctx.fillStyle = zg;
    ctx.beginPath(); ctx.arc(0, 0, rr, 0, 7); ctx.fill();
    // crisp perimeter
    ctx.globalAlpha = 0.7 * fade;
    ctx.strokeStyle = zn.color; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, rr, 0, 7); ctx.stroke();
    // rotating rune ring for magic zones
    if (zn.rune) {
      ctx.globalAlpha = 0.55 * fade;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, rr*0.72, 0, 7); ctx.stroke();
      const dir = zn.swirl ? -1 : 1;
      const spokes = zn.frost ? 6 : 8;
      for (let i = 0; i < spokes; i++) {
        const a = G.time * 0.9 * dir + i * (Math.PI*2/spokes);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a)*rr*0.72, Math.sin(a)*rr*0.72);
        ctx.lineTo(Math.cos(a)*rr*0.94, Math.sin(a)*rr*0.94);
        ctx.stroke();
      }
      // frost zones sparkle with tiny crystal dots
      if (zn.frost) {
        ctx.fillStyle = '#eaf7ff'; ctx.globalAlpha = (0.3 + 0.3*Math.sin(G.time*5)) * fade;
        for (let i = 0; i < 6; i++) {
          const a = i * 1.7 + G.time*0.4, d = rr * (0.3 + 0.5*((i*0.19)%1));
          ctx.beginPath(); ctx.arc(Math.cos(a)*d, Math.sin(a)*d, 2, 0, 7); ctx.fill();
        }
      }
    }
    ctx.restore();
  }

  // aim preview: MOBA-style range ring + filled directional arrow + reticle
  if (G.aimPreview && !G.player.dead) {
    const ap = G.aimPreview;
    const h = G.player;
    const ang = Math.atan2(ap.dy, ap.dx);
    const ex = h.x + ap.dx*ap.range, ey = h.y + ap.dy*ap.range;
    ctx.save();
    // skill range ring around the hero
    ctx.strokeStyle = 'rgba(125,249,255,0.35)';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(h.x, h.y*YS, ap.range, ap.range*YS, 0, 0, 7); ctx.stroke();
    ctx.fillStyle = 'rgba(125,249,255,0.05)';
    ctx.beginPath(); ctx.ellipse(h.x, h.y*YS, ap.range, ap.range*YS, 0, 0, 7); ctx.fill();
    // filled arrow: shaft + head pointing at the target
    ctx.translate(h.x, h.y*YS);
    ctx.scale(1, YS);
    ctx.rotate(ang);
    const len = Math.max(30, ap.range - 42);
    const grad = ctx.createLinearGradient(0, 0, len + 40, 0);
    grad.addColorStop(0, 'rgba(125,249,255,0.12)');
    grad.addColorStop(1, 'rgba(125,249,255,0.55)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(20, -10); ctx.lineTo(len, -14); ctx.lineTo(len, -26);
    ctx.lineTo(len + 42, 0);
    ctx.lineTo(len, 26); ctx.lineTo(len, 14); ctx.lineTo(20, 10);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(200,250,255,0.8)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
    // glowing reticle at the target point
    ctx.strokeStyle = 'rgba(125,249,255,0.9)';
    ctx.lineWidth = 3.5;
    ctx.shadowColor = '#7df9ff'; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.ellipse(ex, ey*YS, 26, 26*YS, 0, 0, 7); ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // recall channel ring under the hero's feet
  for (const h of G.heroes) {
    if (!h.dead && h.recallT > 0 && isVisibleTo(h, G.player)) {
      ctx.save();
      ctx.translate(h.x, h.y*YS);
      ctx.scale(1, YS);
      ctx.strokeStyle = '#7df9ff'; ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.arc(0, 0, h.radius + 16, -Math.PI/2, -Math.PI/2 + (1 - h.recallT/CFG.recallTime) * Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  // depth-sorted scenery + units: everything stands upright on the tilted ground
  const viewW = cv.width / z, viewH = cv.height / (z * YS);
  const L = G.cam.x - viewW/2 - 260, R = G.cam.x + viewW/2 + 260;
  const T = G.cam.y - viewH/2 - 400, B = G.cam.y + viewH/2 + 400;
  const inView = (x, y) => x > L && x < R && y > T && y < B;

  const list = [];
  for (const u of G.units) {
    if (u.dead || !inView(u.x, u.y)) continue;
    if (u.type === 'hero' && !isVisibleTo(u, G.player)) continue;
    list.push(u);
  }
  for (const r of ROCKS) if (inView(r.x, r.y)) list.push({ y: r.y, _rock: r });
  list.sort((a, b) => a.y - b.y);
  for (const d of list) {
    if (d._rock) drawRock(ctx, d._rock);
    else drawUnit(ctx, d);
  }

  // projectiles fly above the ground plane
  ctx.lineCap = 'round';
  for (const p of G.projectiles) {
    let vx, vy;
    if (p.homing) {
      const dx = p.homing.x - p.x, dy = p.homing.y - p.y;
      const d = Math.hypot(dx, dy) || 1;
      vx = dx/d; vy = dy/d;
    } else { vx = p.dx; vy = p.dy; }
    const px = p.x, py = p.y*YS - 20;
    let sx = vx, sy = vy*YS;
    const sm = Math.hypot(sx, sy) || 1;
    sx /= sm; sy /= sm;
    const len = (p.speed || 800) * 0.05;
    const tg = ctx.createLinearGradient(px - sx*len, py - sy*len, px, py);
    tg.addColorStop(0, 'rgba(0,0,0,0)');
    tg.addColorStop(1, p.color);
    ctx.strokeStyle = tg;
    ctx.lineWidth = (p.size || 8) * 1.4;
    ctx.beginPath();
    ctx.moveTo(px - sx*len, py - sy*len);
    ctx.lineTo(px, py);
    ctx.stroke();
    ctx.fillStyle = p.color;
    ctx.shadowColor = p.color; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.arc(px, py, p.size || 8, 0, 7); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath(); ctx.arc(px, py, (p.size || 8) * 0.45, 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
  }

  // effects
  for (const e of FX) {
    const k = e.t / e.dur;
    if (e.type === 'ring') {
      ctx.save();
      ctx.translate(e.x, e.y*YS);
      ctx.scale(1, YS);
      const rr = lerp(e.r0, e.r1, k);
      // soft glow halo behind the crisp ring for that layered-VFX feel
      ctx.globalAlpha = (1 - k) * 0.4;
      ctx.strokeStyle = e.color; ctx.lineWidth = 13;
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, 7); ctx.stroke();
      ctx.globalAlpha = 1 - k;
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, 7); ctx.stroke();
      ctx.globalAlpha = (1 - k) * 0.7;
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, 0, rr*0.92, 0, 7); ctx.stroke();
      ctx.restore();
    } else if (e.type === 'spark') {
      ctx.strokeStyle = e.color; ctx.lineCap = 'round';
      for (const s of e.sparks) {
        const px = e.x + s.dx*k, py = e.y*YS + (s.dy + 120*k)*k;
        ctx.globalAlpha = (1 - k) * 0.9;
        ctx.lineWidth = 2.5 * (1 - k) + 0.5;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px - s.dx*0.06, py - (s.dy + 120*k)*0.06);
        ctx.stroke();
      }
    } else if (e.type === 'flash') {
      ctx.globalAlpha = (1 - k) * 0.8;
      ctx.fillStyle = e.color;
      ctx.beginPath(); ctx.ellipse(e.x, e.y*YS - 16, e.r0, e.r0*0.8, 0, 0, 7); ctx.fill();
    } else if (e.type === 'slash') {
      // crescent blade sweep: a filled arc that thins and fades as it travels
      ctx.save();
      ctx.translate(e.x, e.y*YS - 16);
      const spin = e.ang + k*1.1;
      const rad = 34 + k*22;
      ctx.globalAlpha = (1 - k) * 0.9;
      const wsg = ctx.createLinearGradient(-rad, 0, rad, 0);
      wsg.addColorStop(0, 'rgba(255,255,255,0)');
      wsg.addColorStop(0.5, e.color);
      wsg.addColorStop(1, 'rgba(255,255,255,0.9)');
      ctx.strokeStyle = wsg; ctx.lineCap = 'round';
      ctx.lineWidth = 9 * (1 - k) + 1;
      ctx.beginPath(); ctx.arc(0, 0, rad, spin - 0.85, spin + 0.85); ctx.stroke();
      ctx.globalAlpha = (1 - k) * 0.4; ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.arc(0, 0, rad + 5, spin - 0.7, spin + 0.7); ctx.stroke();
      ctx.restore();
    } else if (e.type === 'shockwave') {
      // expanding ground ring: bright leading edge, translucent filled body
      ctx.save();
      ctx.translate(e.x, e.y*YS); ctx.scale(1, YS);
      const rr = lerp(e.r0, e.r1, k);
      const wg = ctx.createRadialGradient(0, 0, rr*0.5, 0, 0, rr);
      wg.addColorStop(0, 'rgba(0,0,0,0)');
      wg.addColorStop(0.82, hexA(e.color, (1 - k) * 0.28));
      wg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = wg;
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, 7); ctx.fill();
      ctx.globalAlpha = (1 - k);
      ctx.strokeStyle = e.color; ctx.lineWidth = 6 * (1 - k) + 1.5;
      ctx.beginPath(); ctx.arc(0, 0, rr, 0, 7); ctx.stroke();
      ctx.globalAlpha = (1 - k) * 0.8; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, rr*0.96, 0, 7); ctx.stroke();
      ctx.restore();
    } else if (e.type === 'cone') {
      // filled directional sector sweeping outward from the caster
      ctx.save();
      ctx.translate(e.x, e.y*YS); ctx.scale(1, YS); ctx.rotate(e.ang);
      const reach = e.range * (0.35 + k*0.65);
      const cg = ctx.createLinearGradient(0, 0, reach, 0);
      cg.addColorStop(0, hexA(e.color, (1 - k) * 0.55));
      cg.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, reach, -e.arc, e.arc);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = (1 - k) * 0.7; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(0, 0, reach, -e.arc, e.arc); ctx.stroke();
      ctx.restore();
    } else if (e.type === 'bolt') {
      // jagged lightning polyline from caster to impact
      if (!e._pts) {
        e._pts = []; const segs = 7;
        const dx = e.x2 - e.x, dy = (e.y2 - e.y);
        const len = Math.hypot(dx, dy) || 1; const nx = -dy/len, ny = dx/len;
        for (let i = 0; i <= segs; i++) {
          const t = i/segs; const j = (i===0||i===segs) ? 0 : (Math.random()*2-1)*22;
          e._pts.push([e.x + dx*t + nx*j, e.y + dy*t + ny*j]);
        }
      }
      ctx.globalAlpha = 1 - k; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.shadowColor = e.color; ctx.shadowBlur = 14;
      for (const [w, col] of [[7, e.color], [2.5, '#ffffff']]) {
        ctx.strokeStyle = col; ctx.lineWidth = w;
        ctx.beginPath();
        ctx.moveTo(e._pts[0][0], e._pts[0][1]*YS - 22);
        for (const p of e._pts) ctx.lineTo(p[0], p[1]*YS - 22);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    } else if (e.type === 'beam') {
      // thick energy lance that flashes bright then thins away
      ctx.save();
      ctx.globalAlpha = 1 - k;
      ctx.lineCap = 'round';
      ctx.shadowColor = e.color; ctx.shadowBlur = 16;
      const y1 = e.y*YS - 22, y2 = e.y2*YS - 22;
      ctx.strokeStyle = hexA(e.color, 0.5); ctx.lineWidth = (e.width || 22) * (1 - k*0.6);
      ctx.beginPath(); ctx.moveTo(e.x, y1); ctx.lineTo(e.x2, y2); ctx.stroke();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = (e.width || 22) * 0.35 * (1 - k*0.6);
      ctx.beginPath(); ctx.moveTo(e.x, y1); ctx.lineTo(e.x2, y2); ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.restore();
    } else if (e.type === 'shards') {
      // crystalline shards bursting outward and settling (frost)
      if (!e._sh) { e._sh = []; const n = e.n || 8;
        for (let i = 0; i < n; i++) { const a = (i/n)*6.283 + Math.random()*0.4; e._sh.push([Math.cos(a), Math.sin(a), 0.7 + Math.random()*0.6]); } }
      ctx.save(); ctx.translate(e.x, e.y*YS); ctx.scale(1, YS);
      ctx.globalAlpha = 1 - k;
      for (const [cx, cy, sc] of e._sh) {
        const d = lerp(6, (e.r1 || 90), Math.min(1, k*1.6)) * sc;
        const sx = cx*d, sy = cy*d, sz = (8 + 6*sc) * (1 - k*0.5);
        ctx.fillStyle = e.color;
        ctx.beginPath();
        ctx.moveTo(sx, sy - sz); ctx.lineTo(sx + sz*0.4, sy); ctx.lineTo(sx, sy + sz*0.5); ctx.lineTo(sx - sz*0.4, sy);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.beginPath(); ctx.arc(sx, sy - sz*0.3, sz*0.14, 0, 7); ctx.fill();
      }
      ctx.restore();
    } else if (e.type === 'embers') {
      // rising fire embers
      if (!e._em) { e._em = []; const n = e.n || 10;
        for (let i = 0; i < n; i++) e._em.push([(Math.random()*2-1)*(e.spread||30), Math.random()*0.6, 20 + Math.random()*40]); }
      ctx.globalAlpha = 1 - k;
      for (const [ox, delay, rise] of e._em) {
        const kk = Math.max(0, (k - delay) / (1 - delay));
        ctx.fillStyle = kk > 0.6 ? '#ffce7a' : e.color;
        ctx.globalAlpha = (1 - kk) * (1 - k);
        const px = e.x + ox + Math.sin(kk*6 + ox)*4, py = e.y*YS - 16 - kk*rise;
        ctx.beginPath(); ctx.arc(px, py, (1 - kk)*3 + 1, 0, 7); ctx.fill();
      }
    } else if (e.type === 'text') {
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = e.color;
      const fsize = e.big ? 30 : 22;
      ctx.font = 'bold ' + fsize + 'px Rajdhani, sans-serif';
      ctx.textAlign = 'center';
      if (e.big) {
        ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 3;
        ctx.strokeText(e.text, e.x, e.y*YS - 40 - k*10);
      }
      ctx.fillText(e.text, e.x, e.y*YS - 36 - (e.big ? k*10 : 0));
    }
    ctx.globalAlpha = 1;
  }

  // fog of war: darkens anything outside the player's team's current/explored vision
  updateFogMask();
  ctx.save();
  ctx.scale(1, YS);
  ctx.drawImage(fogSmooth || fogMask, 0, 0, WORLD, WORLD);
  ctx.restore();

  ctx.restore();

  // low-hp / big-hit screen shake decays every frame
  if (UI.hitShake) UI.hitShake = Math.max(0, UI.hitShake - 0.06);
}

// standing boulder
// MLBB-style boulder: warm weathered tan stone with a horizontal strata crack
// and moss creeping over the sunlit top face
function drawRock(ctx, r) {
  const gx = r.x, gy = r.y * YS;
  if (!r._pts) {
    const rr = mulberry32(Math.floor(r.x * 7 + r.y));
    r._pts = [];
    for (let i = 0; i < 8; i++) {
      const a = i/8 * Math.PI*2;
      const rad = r.r * (0.8 + rr()*0.3);
      r._pts.push([Math.cos(a)*rad, Math.sin(a)*rad*0.72 - r.r*0.45]);
    }
    r._moss = [];
    for (let i = 0; i < 4; i++) {
      r._moss.push([(rr()-0.5)*r.r*0.8, -r.r*(0.68 + rr()*0.4), r.r*(0.18 + rr()*0.16)]);
    }
  }
  ctx.fillStyle = 'rgba(15,25,15,0.4)';
  ctx.beginPath(); ctx.ellipse(gx + 6, gy + 2, r.r*1.05, r.r*0.42, 0, 0, 7); ctx.fill();
  const rg2 = ctx.createLinearGradient(gx - r.r, gy - r.r*1.3, gx + r.r, gy);
  rg2.addColorStop(0, '#b3a184');
  rg2.addColorStop(0.55, '#84765c');
  rg2.addColorStop(1, '#4e4433');
  ctx.fillStyle = rg2;
  ctx.beginPath();
  ctx.moveTo(gx + r._pts[0][0], gy + r._pts[0][1]);
  for (const p of r._pts) ctx.lineTo(gx + p[0], gy + p[1]);
  ctx.closePath(); ctx.fill();
  ctx.strokeStyle = 'rgba(45,35,22,0.55)'; ctx.lineWidth = 3.5;
  ctx.stroke();
  // horizontal strata cracks — the layered-slab reading without fake geometry
  ctx.strokeStyle = 'rgba(45,35,22,0.4)'; ctx.lineWidth = 2.5;
  for (const f of [0.35, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(gx - r.r*0.72, gy - r.r*f);
    ctx.quadraticCurveTo(gx, gy - r.r*f - r.r*0.12, gx + r.r*0.7, gy - r.r*f + r.r*0.06);
    ctx.stroke();
  }
  // sunlit top facet
  ctx.fillStyle = 'rgba(255,244,214,0.16)';
  ctx.beginPath();
  ctx.moveTo(gx - r.r*0.4, gy - r.r*0.55);
  ctx.lineTo(gx - r.r*0.02, gy - r.r*1.0);
  ctx.lineTo(gx + r.r*0.38, gy - r.r*0.68);
  ctx.lineTo(gx + r.r*0.05, gy - r.r*0.35);
  ctx.closePath(); ctx.fill();
  // moss clumps hugging the top
  for (const [mx, my, mr] of r._moss) {
    ctx.fillStyle = 'rgba(80,138,66,0.7)';
    ctx.beginPath(); ctx.ellipse(gx + mx, gy + my, mr, mr*0.6, 0, 0, 7); ctx.fill();
  }
}

function drawUnit(ctx, u) {
  const tc = u.team === 'jungle' ? '#c77dff' : TEAM_COLOR[u.team];
  const gx = u.x, gy = u.y * YS;

  if (u.type === 'tower') {
    const H = 106;
    // shadow + plinth
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath(); ctx.ellipse(gx + 10, gy + 4, 64, 27, 0, 0, 7); ctx.fill();
    // weathered golden-stone base pedestal with a carved ring (MLBB turrets
    // read as ancient gilded monuments, not military hardware)
    const pb = ctx.createLinearGradient(gx - 54, gy, gx + 54, gy);
    pb.addColorStop(0, '#8d7f5e'); pb.addColorStop(1, '#4a4130');
    ctx.fillStyle = pb;
    ctx.beginPath(); ctx.ellipse(gx, gy, 54, 23, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(30,24,14,0.55)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(gx, gy, 54, 23, 0, 0, 7); ctx.stroke();
    ctx.strokeStyle = 'rgba(30,24,14,0.3)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(gx, gy, 40, 17, 0, 0, 7); ctx.stroke();
    // tapered golden stone column
    const cb = ctx.createLinearGradient(gx - 42, 0, gx + 42, 0);
    cb.addColorStop(0, '#cdb384');
    cb.addColorStop(0.55, '#93805a');
    cb.addColorStop(1, '#4c422e');
    ctx.fillStyle = cb;
    ctx.beginPath();
    ctx.moveTo(gx - 42, gy);
    ctx.lineTo(gx - 26, gy - H);
    ctx.lineTo(gx + 26, gy - H);
    ctx.lineTo(gx + 42, gy);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(40,32,18,0.5)'; ctx.lineWidth = 2.5;
    ctx.stroke();
    // carved masonry bands + a few weathering cracks
    ctx.strokeStyle = 'rgba(40,32,18,0.35)'; ctx.lineWidth = 2;
    for (const f of [0.24, 0.5, 0.74]) {
      const w = 42 - 16*f;
      ctx.beginPath(); ctx.moveTo(gx - w, gy - H*f); ctx.lineTo(gx + w, gy - H*f); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(255,240,200,0.25)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(gx - 32, gy - H*0.12); ctx.lineTo(gx - 20, gy - H*0.86); ctx.stroke();
    ctx.strokeStyle = tc; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(gx - 28, gy - H*0.82); ctx.lineTo(gx + 28, gy - H*0.82); ctx.stroke();
    // team pennant flying from the column side
    ctx.strokeStyle = '#3a3122'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(gx + 30, gy - H*0.66); ctx.lineTo(gx + 46, gy - H*0.86); ctx.stroke();
    ctx.fillStyle = tc; ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.moveTo(gx + 46, gy - H*0.86);
    ctx.lineTo(gx + 68, gy - H*0.80);
    ctx.lineTo(gx + 46, gy - H*0.72);
    ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
    // gilded top platform + floating guardian crystal in a gold halo
    ctx.fillStyle = '#6b5c3e';
    ctx.beginPath(); ctx.ellipse(gx, gy - H, 32, 13, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = '#e4c98a'; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.ellipse(gx, gy - H, 32, 13, 0, 0, 7); ctx.stroke();
    const bob = 5 * Math.sin(G.time*3 + u.id);
    const cs = 21 + 2.5*Math.sin(G.time*4 + u.id);
    const cy = gy - H - 34 + bob;
    // soft gold radiance behind the guardian, like the reference's statue glow
    const gg = ctx.createRadialGradient(gx, cy, 4, gx, cy, cs*2.6);
    gg.addColorStop(0, 'rgba(255,220,140,0.4)');
    gg.addColorStop(1, 'rgba(255,220,140,0)');
    ctx.fillStyle = gg;
    ctx.beginPath(); ctx.arc(gx, cy, cs*2.6, 0, 7); ctx.fill();
    // slowly-turning gold halo ring
    ctx.strokeStyle = 'rgba(255,215,130,0.6)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.ellipse(gx, cy, cs*1.5, cs*0.55, 0, G.time*0.8, G.time*0.8 + 5.2); ctx.stroke();
    ctx.shadowColor = tc; ctx.shadowBlur = u.invulnerable ? 6 : 22;
    ctx.fillStyle = tc;
    ctx.beginPath();
    ctx.moveTo(gx, cy - cs); ctx.lineTo(gx + cs*0.62, cy);
    ctx.lineTo(gx, cy + cs); ctx.lineTo(gx - cs*0.62, cy);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.beginPath();
    ctx.moveTo(gx, cy - cs*0.45); ctx.lineTo(gx + cs*0.26, cy);
    ctx.lineTo(gx, cy + cs*0.45); ctx.lineTo(gx - cs*0.26, cy);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    if (u.invulnerable) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 3;
      ctx.setLineDash([10, 10]);
      ctx.beginPath(); ctx.ellipse(gx, gy, 58, 25, 0, G.time, G.time + 7); ctx.stroke();
      ctx.setLineDash([]);
    }
    drawHpBar(ctx, u, 70, gx, gy - H - 62);
    return;
  }

  if (u.type === 'core') {
    const H = 96;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath(); ctx.ellipse(gx + 10, gy + 5, 78, 32, 0, 0, 7); ctx.fill();
    // platform
    const pg = ctx.createLinearGradient(gx - 70, gy, gx + 70, gy);
    pg.addColorStop(0, lighten(TEAM_COLOR_D[u.team], 0.25));
    pg.addColorStop(1, TEAM_COLOR_D[u.team]);
    ctx.fillStyle = pg;
    ctx.beginPath(); ctx.ellipse(gx, gy, 68, 28, 0, 0, 7); ctx.fill();
    ctx.strokeStyle = tc; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.ellipse(gx, gy, 68, 28, 0, 0, 7); ctx.stroke();
    // rotating rune orbs around the platform
    ctx.fillStyle = tc;
    for (let i = 0; i < 8; i++) {
      const a = G.time * 0.7 + i * Math.PI/4;
      ctx.beginPath();
      ctx.arc(gx + Math.cos(a)*58, gy + Math.sin(a)*24, 5, 0, 7);
      ctx.fill();
    }
    // grand crystal monument
    const pul = 1 + 0.06*Math.sin(G.time*3);
    ctx.shadowColor = tc; ctx.shadowBlur = 30;
    ctx.fillStyle = tc;
    ctx.beginPath();
    ctx.moveTo(gx, gy - H*pul);
    ctx.lineTo(gx + 34, gy - H*0.42);
    ctx.lineTo(gx + 16, gy - 4);
    ctx.lineTo(gx - 16, gy - 4);
    ctx.lineTo(gx - 34, gy - H*0.42);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.moveTo(gx, gy - H*0.8*pul);
    ctx.lineTo(gx + 14, gy - H*0.4);
    ctx.lineTo(gx, gy - 10);
    ctx.lineTo(gx - 14, gy - H*0.4);
    ctx.closePath(); ctx.fill();
    ctx.shadowBlur = 0;
    if (u.invulnerable) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 4;
      ctx.setLineDash([14, 12]);
      ctx.beginPath(); ctx.ellipse(gx, gy, 84, 35, 0, -G.time*0.8, -G.time*0.8 + 7); ctx.stroke();
      ctx.setLineDash([]);
    }
    drawHpBar(ctx, u, 100, gx, gy - H - 34);
    return;
  }

  if (u.type === 'minion') {
    // little lane soldiers, MLBB-style: armored sword grunts and hooded
    // robed casters marching in team colors
    const ph = G.time*9 + u.id;
    const swing = Math.sin(ph)*3.5;
    const bobY = -Math.abs(Math.sin(ph))*1.5;
    const side = Math.cos(u.facing) >= 0 ? 1 : -1;
    const dark = TEAM_COLOR_D[u.team];
    ctx.fillStyle = 'rgba(0,0,0,0.32)';
    ctx.beginPath(); ctx.ellipse(gx, gy, u.radius*0.95, u.radius*0.4, 0, 0, 7); ctx.fill();
    ctx.save();
    ctx.translate(gx, gy + bobY);
    ctx.lineCap = 'round';
    if (u.ranged) {
      // robed caster: cowled cloak sweeping to the ground, glowing staff
      const rg = ctx.createLinearGradient(0, -26, 0, 0);
      rg.addColorStop(0, lighten(dark, 0.28)); rg.addColorStop(1, dark);
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.moveTo(0, -26);
      ctx.quadraticCurveTo(-11, -14, -8 - swing*0.4, 0);
      ctx.lineTo(8 + swing*0.4, 0);
      ctx.quadraticCurveTo(11, -14, 0, -26);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 1.8; ctx.stroke();
      // rope belt
      ctx.strokeStyle = 'rgba(255,220,150,0.5)'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(-7, -11); ctx.lineTo(7, -11); ctx.stroke();
      // deep hood with glowing eyes
      ctx.fillStyle = lighten(dark, 0.15);
      ctx.beginPath(); ctx.arc(0, -27, 7.5, 0, 7); ctx.fill();
      ctx.fillStyle = 'rgba(8,10,16,0.95)';
      ctx.beginPath(); ctx.arc(side*1.5, -26.5, 5, 0, 7); ctx.fill();
      ctx.fillStyle = tc; ctx.shadowColor = tc; ctx.shadowBlur = 5;
      ctx.beginPath(); ctx.arc(side*3, -27, 1.4, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(side*0.5, -27, 1.4, 0, 7); ctx.fill();
      ctx.shadowBlur = 0;
      // staff with a crackling orb
      ctx.strokeStyle = '#5b4a33'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(side*9, 0); ctx.lineTo(side*11, -30); ctx.stroke();
      ctx.fillStyle = tc; ctx.shadowColor = tc; ctx.shadowBlur = 9;
      ctx.beginPath(); ctx.arc(side*11, -33, 3.6 + Math.sin(G.time*5 + u.id)*0.8, 0, 7); ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      // armored grunt: stubby legs, chest plate, kettle helm, sword + shield
      ctx.strokeStyle = '#1c222b'; ctx.lineWidth = 4.5;
      ctx.beginPath(); ctx.moveTo(-4, -10); ctx.lineTo(-4 + swing, 0); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(4, -10); ctx.lineTo(4 - swing, 0); ctx.stroke();
      const bg = ctx.createLinearGradient(0, -24, 0, -8);
      bg.addColorStop(0, lighten(dark, 0.32)); bg.addColorStop(1, dark);
      ctx.fillStyle = bg;
      roundRect(ctx, -9, -24, 18, 16, 6); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 1.8;
      roundRect(ctx, -9, -24, 18, 16, 6); ctx.stroke();
      // team tabard stripe
      ctx.fillStyle = tc;
      ctx.fillRect(-3, -23, 6, 14);
      // kettle helm with brim + plume
      ctx.fillStyle = '#8b95a3';
      ctx.beginPath(); ctx.arc(0, -27, 6.5, Math.PI, 0); ctx.fill();
      ctx.fillRect(-8, -27.5, 16, 2.5);
      ctx.fillStyle = tc;
      ctx.beginPath(); ctx.ellipse(0, -33, 2, 3.5, 0, 0, 7); ctx.fill();
      // face shadow + eyes
      ctx.fillStyle = '#2a2015';
      ctx.fillRect(-4.5, -24.5, 9, 3.5);
      // round shield on off-hand
      ctx.fillStyle = lighten(dark, 0.2);
      ctx.beginPath(); ctx.arc(-side*10, -14, 5.5, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(230,220,190,0.6)'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(-side*10, -14, 5.5, 0, 7); ctx.stroke();
      // short sword, raised a touch mid-swing
      const striking = u.atkTimer > 0 && u.atkTimer > u.atkCd*0.7;
      ctx.strokeStyle = '#d9dde3'; ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(side*9, -15);
      ctx.lineTo(side*(striking ? 20 : 16), striking ? -26 : -21);
      ctx.stroke();
    }
    ctx.restore();
    drawHpBar(ctx, u, 34, gx, gy - 48);
    return;
  }

  if (u.type === 'jungle') {
    const acc = (u.buffType && BUFF_CAMPS[u.buffType]) ? BUFF_CAMPS[u.buffType].color : '#c77dff';
    const lift = u.boss ? 26 : 16;
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(gx, gy, u.radius*1.05, u.radius*0.42, 0, 0, 7); ctx.fill();
    const jg = ctx.createRadialGradient(gx - 8, gy - lift - 10, 5, gx, gy - lift, u.radius);
    jg.addColorStop(0, u.boss ? '#6b3d8f' : '#5e4a73');
    jg.addColorStop(1, u.boss ? '#3a1f52' : '#3c2c4d');
    ctx.fillStyle = jg;
    ctx.beginPath(); ctx.arc(gx, gy - lift, u.radius, 0, 7); ctx.fill();
    ctx.strokeStyle = acc; ctx.lineWidth = u.boss ? 5 : (u.buffType ? 4 : 3);
    ctx.beginPath(); ctx.arc(gx, gy - lift, u.radius, 0, 7); ctx.stroke();
    // horns
    ctx.fillStyle = u.boss ? '#9d4edd' : '#7b5a99';
    ctx.beginPath();
    ctx.moveTo(gx - u.radius*0.6, gy - lift - u.radius*0.5);
    ctx.lineTo(gx - u.radius*0.85, gy - lift - u.radius*1.15);
    ctx.lineTo(gx - u.radius*0.25, gy - lift - u.radius*0.8);
    ctx.closePath(); ctx.fill();
    ctx.beginPath();
    ctx.moveTo(gx + u.radius*0.6, gy - lift - u.radius*0.5);
    ctx.lineTo(gx + u.radius*0.85, gy - lift - u.radius*1.15);
    ctx.lineTo(gx + u.radius*0.25, gy - lift - u.radius*0.8);
    ctx.closePath(); ctx.fill();
    // eyes toward facing
    ctx.fillStyle = u.buffType ? acc : '#e0aaff';
    ctx.shadowColor = acc; ctx.shadowBlur = 8;
    const ex = Math.cos(u.facing)*u.radius*0.35, ey = Math.sin(u.facing)*u.radius*0.2;
    ctx.beginPath(); ctx.arc(gx + ex - 6, gy - lift + ey, u.boss ? 7 : 4, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.arc(gx + ex + 6, gy - lift + ey, u.boss ? 7 : 4, 0, 7); ctx.fill();
    ctx.shadowBlur = 0;
    if (u.boss) {
      ctx.strokeStyle = '#9d4edd'; ctx.lineWidth = 5;
      for (let i = 0; i < 6; i++) {
        const a = G.time*0.6 + i * Math.PI/3;
        ctx.beginPath();
        ctx.moveTo(gx + Math.cos(a)*u.radius, gy - lift + Math.sin(a)*u.radius*0.8);
        ctx.lineTo(gx + Math.cos(a)*(u.radius+18), gy - lift + Math.sin(a)*(u.radius+18)*0.8);
        ctx.stroke();
      }
    }
    drawHpBar(ctx, u, u.boss ? 90 : 44, gx, gy - lift - u.radius - (u.boss ? 30 : 16));
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
  const gx = h.x, gy = h.y * YS;

  // ground team ring
  ctx.save();
  ctx.translate(gx, gy);
  ctx.scale(1, YS);
  ctx.globalAlpha = h.isPlayer ? 1 : 0.75;
  ctx.strokeStyle = tc; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(0, 0, h.radius + 6, 0, 7); ctx.stroke();
  if (h.isPlayer) {
    ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(0, 0, h.radius + 12, 0, 7); ctx.stroke();
  }
  ctx.restore();
  ctx.globalAlpha = 1;

  // shadow
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.beginPath(); ctx.ellipse(gx, gy, 19, 7.5, 0, 0, 7); ctx.fill();

  // walk cycle / idle breathing
  const ph = h.moving ? G.time*11 + h.id : 0;
  const swing = h.moving ? Math.sin(ph)*5 : 0;
  const bobY = h.moving ? -Math.abs(Math.sin(ph))*2.5 : Math.sin(G.time*2 + h.id)*1.2;
  const side = Math.cos(h.facing) >= 0 ? 1 : -1;
  const striking = h.atkTimer > (h.atkCd / h.asMult) * 0.7;

  ctx.save();
  ctx.translate(gx, gy + bobY);
  ctx.lineCap = 'round';

  drawHeroBody(ctx, h.def, tc, { swing, side, striking });
  drawHeroHead(ctx, h.def.id);
  drawHeroWeapon(ctx, h, side);

  // white hit-flash pulse
  if (h._hitT !== undefined && G.time - h._hitT < 0.14) {
    const fk = 1 - (G.time - h._hitT) / 0.14;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = fk * 0.65;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(0, -24, 22, 0, 7); ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  ctx.restore();

  // shield bubble
  if (h.shieldTotal() > 0) {
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.ellipse(gx, gy - 28, 26, 35, 0, 0, 7); ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // stun stars
  if (h.stunned) {
    ctx.fillStyle = '#ffe27d';
    for (let i = 0; i < 3; i++) {
      const a = G.time*5 + i*2.1;
      ctx.beginPath(); ctx.arc(gx + Math.cos(a)*16, gy - 64 + Math.sin(a)*4, 4, 0, 7); ctx.fill();
    }
  }

  drawHeroPlate(ctx, h, gx, gy - 76);
}

// MLBB-style overhead hero plate: level diamond + HP bar segmented into
// fixed-size chunks (so max HP is readable at a glance) + mana sliver
function drawHeroPlate(ctx, h, cx, cy) {
  const tc = TEAM_COLOR[h.team];
  const w = 66, x = cx - w/2, y = cy;
  // name
  ctx.fillStyle = h.isPlayer ? '#ffe9a8' : tc;
  ctx.font = 'bold 14px Rajdhani, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(h.name, cx + 5, y - 5);
  // backing plate
  ctx.fillStyle = 'rgba(6,10,16,0.72)';
  roundRect(ctx, x - 14, y - 2, w + 18, 15, 3.5); ctx.fill();
  // level diamond on the left lip
  ctx.fillStyle = TEAM_COLOR_D[h.team];
  ctx.save();
  ctx.translate(x - 5, y + 5.5);
  ctx.rotate(Math.PI/4);
  ctx.fillRect(-6.4, -6.4, 12.8, 12.8);
  ctx.strokeStyle = h.isPlayer ? '#ffd166' : 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1.6;
  ctx.strokeRect(-6.4, -6.4, 12.8, 12.8);
  ctx.restore();
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 11px Rajdhani, sans-serif';
  ctx.fillText(h.level, x - 5, y + 9.5);
  // HP fill
  const frac = clamp(h.hp / h.hpMax(), 0, 1);
  const ally = h.team === G.player.team;
  const hg = ctx.createLinearGradient(0, y, 0, y + 7);
  hg.addColorStop(0, ally ? '#5cf291' : '#ff7385');
  hg.addColorStop(1, ally ? '#1ea854' : '#c9243a');
  ctx.fillStyle = hg;
  ctx.fillRect(x + 3, y + 1, (w - 4) * frac, 7);
  // shield overlay
  const sh = h.shieldTotal ? h.shieldTotal() : 0;
  if (sh > 0) {
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(x + 3 + (w - 4)*frac, y + 1, (w - 4) * clamp(sh / h.hpMax(), 0, 1 - frac), 7);
  }
  // fixed-chunk pips every 500 max HP
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  const chunk = 500 / h.hpMax();
  for (let q = chunk; q < 1; q += chunk) ctx.fillRect(x + 3 + (w - 4)*q - 0.5, y + 1, 1, 7);
  // mana sliver
  if (h.manaMax > 0) {
    ctx.fillStyle = '#2b5f9e';
    ctx.fillRect(x + 3, y + 9, w - 4, 3);
    ctx.fillStyle = '#6fb9ff';
    ctx.fillRect(x + 3, y + 9, (w - 4) * clamp(h.mana / h.manaMax, 0, 1), 3);
  }
}

// shared hero body used in-game and on UI cards: role-based silhouette
// (robes for casters, heavy pauldrons for bruisers), swinging arms, and an
// attack lunge — feet anchored at local (0,0)
function drawHeroBody(ctx, def, teamColor, anim) {
  const c = def.color;
  const sw = anim.swing || 0, side = anim.side || 1;
  const robe = def.role === 'Mage' || def.role === 'Support';
  const heavy = def.role === 'Tank' || def.role === 'Fighter';
  const hw = heavy ? 15 : 13;                     // torso half-width
  ctx.save();
  if (anim.striking) ctx.rotate(side * 0.10);     // lunge into the attack

  // off-hand arm behind the torso, counter-swinging the legs
  ctx.strokeStyle = lighten(c, -0.18); ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-side*hw*0.8, -33);
  ctx.lineTo(-side*(hw + 3) - sw*0.5, -18);
  ctx.stroke();
  ctx.fillStyle = '#f0c49b';
  ctx.beginPath(); ctx.arc(-side*(hw + 3) - sw*0.5, -17, 3, 0, 7); ctx.fill();

  if (robe) {
    // flowing robe: hem sways opposite the stride
    const rg = ctx.createLinearGradient(0, -38, 0, 0);
    rg.addColorStop(0, lighten(c, 0.28)); rg.addColorStop(1, lighten(c, -0.25));
    ctx.fillStyle = rg;
    ctx.beginPath();
    ctx.moveTo(-hw, -36);
    ctx.quadraticCurveTo(-hw - 4, -16, -11 - sw*0.5, 0);
    ctx.lineTo(11 - sw*0.5, 0);
    ctx.quadraticCurveTo(hw + 4, -16, hw, -36);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 2; ctx.stroke();
    // hem trim
    ctx.strokeStyle = 'rgba(255,240,200,0.4)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(-10 - sw*0.5, -2.5); ctx.lineTo(10 - sw*0.5, -2.5); ctx.stroke();
  } else {
    // legs with boots
    ctx.strokeStyle = '#1c222b'; ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(-6, -16); ctx.lineTo(-6 + sw*0.6, -1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(6, -16); ctx.lineTo(6 - sw*0.6, -1); ctx.stroke();
    ctx.fillStyle = lighten(c, -0.3);
    ctx.beginPath(); ctx.ellipse(-6 + sw*0.6, -1, 4.5, 2.5, 0, 0, 7); ctx.fill();
    ctx.beginPath(); ctx.ellipse(6 - sw*0.6, -1, 4.5, 2.5, 0, 0, 7); ctx.fill();
    // hip fauld
    ctx.fillStyle = lighten(c, -0.12);
    roundRect(ctx, -hw + 1, -20, (hw - 1)*2, 7, 3); ctx.fill();
  }

  // chest plate with rim light
  const tg = ctx.createLinearGradient(0, -40, 0, -14);
  tg.addColorStop(0, lighten(c, 0.30));
  tg.addColorStop(1, c);
  ctx.fillStyle = tg;
  roundRect(ctx, -hw, -38, hw*2, robe ? 20 : 24, 8);
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'; ctx.lineWidth = 2;
  roundRect(ctx, -hw, -38, hw*2, robe ? 20 : 24, 8);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(-hw + 5, -36.5); ctx.quadraticCurveTo(0, -39.5, hw - 5, -36.5); ctx.stroke();
  // team sash
  ctx.fillStyle = teamColor;
  ctx.fillRect(-hw, robe ? -22 : -20, hw*2, 4);
  // belt buckle glint
  ctx.fillStyle = 'rgba(255,230,170,0.85)';
  ctx.beginPath(); ctx.arc(0, robe ? -20 : -18, 2.2, 0, 7); ctx.fill();

  // pauldrons — spiked and oversized on heavy roles
  ctx.fillStyle = lighten(c, 0.12);
  const pr = heavy ? 8 : 6;
  ctx.beginPath(); ctx.arc(-hw, -34, pr, 0, 7); ctx.fill();
  ctx.beginPath(); ctx.arc(hw, -34, pr, 0, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(-hw, -34, pr, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.arc(hw, -34, pr, 0, 7); ctx.stroke();
  if (heavy) {
    ctx.fillStyle = lighten(c, 0.3);
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(s*hw - 4, -40); ctx.lineTo(s*hw, -50); ctx.lineTo(s*hw + 4, -40);
      ctx.closePath(); ctx.fill();
    }
  }

  // weapon-side arm reaching to the weapon anchor
  ctx.strokeStyle = lighten(c, -0.1); ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(side*hw*0.8, -33);
  ctx.lineTo(side*(hw + 2), anim.striking ? -27 : -23);
  ctx.stroke();
  ctx.fillStyle = '#f0c49b';
  ctx.beginPath(); ctx.arc(side*(hw + 2), anim.striking ? -26 : -22, 3, 0, 7); ctx.fill();
  ctx.restore();
}

// heads: hair, helmets and hoods that make each hero readable at a glance
function drawHeroHead(ctx, id) {
  ctx.fillStyle = '#f0c49b';
  ctx.beginPath(); ctx.arc(0, -47, 9, 0, 7); ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.3)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(0, -47, 9, 0, 7); ctx.stroke();
  switch (id) {
    case 'kael': // spiked ember hair
      ctx.fillStyle = '#8a2a10';
      ctx.beginPath();
      ctx.moveTo(-9, -49); ctx.lineTo(-7, -60); ctx.lineTo(-3, -51);
      ctx.lineTo(0, -62); ctx.lineTo(3, -51); ctx.lineTo(7, -59);
      ctx.lineTo(9, -49); ctx.closePath(); ctx.fill();
      break;
    case 'nyra': // long violet hair
      ctx.fillStyle = '#b9aefc';
      ctx.beginPath(); ctx.arc(0, -50, 9.5, Math.PI*0.9, Math.PI*2.1); ctx.fill();
      ctx.fillRect(-11, -52, 4, 16);
      ctx.fillRect(7, -52, 4, 16);
      break;
    case 'grom': // full helm with crest
      ctx.fillStyle = '#6d7f45';
      ctx.beginPath(); ctx.arc(0, -48, 10, 0, 7); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(0, -48, 10, 0, 7); ctx.stroke();
      ctx.fillStyle = '#1a1f14';
      ctx.fillRect(-7, -49, 14, 3.5);
      ctx.fillStyle = '#dbe8b0';
      ctx.fillRect(-1.5, -61, 3, 9);
      break;
    case 'lyra': // golden ponytail
      ctx.fillStyle = '#e8b13e';
      ctx.beginPath(); ctx.arc(0, -50, 9.5, Math.PI*0.85, Math.PI*2.15); ctx.fill();
      ctx.strokeStyle = '#e8b13e'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(8, -52); ctx.quadraticCurveTo(16, -46, 13, -34); ctx.stroke();
      break;
    case 'vex': // hood with glowing eyes
      ctx.fillStyle = '#3d1f5c';
      ctx.beginPath(); ctx.arc(0, -48, 10.5, 0, 7); ctx.fill();
      ctx.fillStyle = '#150a24';
      ctx.beginPath(); ctx.arc(0, -46.5, 7, 0, 7); ctx.fill();
      ctx.fillStyle = '#e0aaff';
      ctx.beginPath(); ctx.arc(-3, -47, 1.6, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.arc(3, -47, 1.6, 0, 7); ctx.fill();
      break;
    case 'thane': // wild mane + wolf ears
      ctx.fillStyle = '#1f6b4e';
      ctx.beginPath(); ctx.arc(0, -50, 9.5, Math.PI*0.9, Math.PI*2.1); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-8, -53); ctx.lineTo(-11, -63); ctx.lineTo(-3, -56); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(8, -53); ctx.lineTo(11, -63); ctx.lineTo(3, -56); ctx.closePath(); ctx.fill();
      break;
    case 'isolde': { // frost hood + ice crown
      ctx.fillStyle = '#bfeaff';
      ctx.beginPath(); ctx.arc(0, -49, 10, Math.PI*0.85, Math.PI*2.15); ctx.fill();
      ctx.fillRect(-10, -50, 4, 15); ctx.fillRect(6, -50, 4, 15);
      ctx.fillStyle = '#5fd0ff';
      ctx.beginPath();
      ctx.moveTo(-6, -56); ctx.lineTo(-4, -64); ctx.lineTo(-1, -57);
      ctx.lineTo(0, -66); ctx.lineTo(1, -57); ctx.lineTo(4, -64); ctx.lineTo(6, -56);
      ctx.closePath(); ctx.fill();
      break;
    }
  }
}

// signature weapons, held on the side the hero is facing
function drawHeroWeapon(ctx, h, side) {
  const id = h.def.id;
  const striking = h.atkTimer > (h.atkCd / h.asMult) * 0.7;
  ctx.lineCap = 'round';
  switch (id) {
    case 'kael': {
      ctx.strokeStyle = '#ffd9c2'; ctx.lineWidth = 3.5;
      ctx.shadowColor = '#ff6a3d'; ctx.shadowBlur = 8;
      const a1 = striking ? -1.3 : -0.5;
      ctx.beginPath();
      ctx.moveTo(side*15, -24);
      ctx.lineTo(side*15 + Math.cos(a1)*side*20, -24 + Math.sin(a1)*20);
      ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-side*14, -22); ctx.lineTo(-side*26, -32); ctx.stroke();
      ctx.shadowBlur = 0;
      break;
    }
    case 'nyra': {
      ctx.strokeStyle = '#5a4d8f'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(side*16, -8); ctx.lineTo(side*16, -50); ctx.stroke();
      ctx.fillStyle = '#b7a8ff';
      ctx.shadowColor = '#7f7bff'; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(side*16, -54, 5.5 + Math.sin(G.time*4), 0, 7); ctx.fill();
      ctx.shadowBlur = 0;
      break;
    }
    case 'grom': {
      ctx.fillStyle = '#55663a';
      roundRect(ctx, side*12 - 6, -38, 13, 26, 4); ctx.fill();
      ctx.strokeStyle = '#dbe8b0'; ctx.lineWidth = 2;
      roundRect(ctx, side*12 - 6, -38, 13, 26, 4); ctx.stroke();
      ctx.strokeStyle = '#7d6a4a'; ctx.lineWidth = 3.5;
      ctx.beginPath(); ctx.moveTo(-side*16, -12); ctx.lineTo(-side*22, -36); ctx.stroke();
      ctx.fillStyle = '#c9ccd1';
      ctx.beginPath(); ctx.arc(-side*22, -38, 6, 0, 7); ctx.fill();
      break;
    }
    case 'lyra': {
      ctx.save();
      ctx.translate(side*17, -28);
      if (side < 0) ctx.rotate(Math.PI);
      ctx.strokeStyle = '#ffdf94'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(0, 0, 15, -1.15, 1.15); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)'; ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(15*Math.cos(-1.15), 15*Math.sin(-1.15));
      ctx.lineTo(15*Math.cos(1.15), 15*Math.sin(1.15));
      ctx.stroke();
      ctx.restore();
      break;
    }
    case 'vex': {
      for (let i = 0; i < 2; i++) {
        const a = G.time*3 + i*Math.PI;
        ctx.fillStyle = '#e0aaff';
        ctx.shadowColor = '#c77dff'; ctx.shadowBlur = 10;
        ctx.beginPath(); ctx.arc(Math.cos(a)*20, -30 + Math.sin(a)*7, 4.5, 0, 7); ctx.fill();
        ctx.shadowBlur = 0;
      }
      break;
    }
    case 'thane': {
      ctx.strokeStyle = '#d1fae5'; ctx.lineWidth = 2.5;
      const reach = striking ? 6 : 0;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath(); ctx.moveTo(side*15 + i*3, -22); ctx.lineTo(side*(19 + reach) + i*3, -12); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(-side*15 + i*3, -22); ctx.lineTo(-side*19 + i*3, -12); ctx.stroke();
      }
      break;
    }
    case 'isolde': { // frost staff with a crystalline shard
      ctx.strokeStyle = '#3a6a8f'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(side*16, -8); ctx.lineTo(side*16, -50); ctx.stroke();
      ctx.fillStyle = '#bfeaff';
      ctx.shadowColor = '#5fd0ff'; ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.moveTo(side*16, -62); ctx.lineTo(side*16 + 5, -53); ctx.lineTo(side*16, -49);
      ctx.lineTo(side*16 - 5, -53); ctx.closePath(); ctx.fill();
      ctx.shadowBlur = 0;
      break;
    }
  }
}

// full standing character for UI cards and portraits — same body as in-game
function drawHeroCardArt(ctx, def, x, footY, scale) {
  ctx.save();
  ctx.translate(x, footY);
  ctx.scale(scale, scale);
  ctx.lineCap = 'round';
  drawHeroBody(ctx, def, '#7df9ff', { swing: 0, side: 1, striking: false });
  drawHeroHead(ctx, def.id);
  drawHeroWeapon(ctx, { def, atkTimer: 0, atkCd: 1, asMult: 1 }, 1);
  ctx.restore();
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
    case 'isolde': // snowflake
      ctx.strokeStyle = '#bfeaff'; ctx.lineWidth = 3; ctx.lineCap = 'round';
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3;
        const ex = Math.cos(a)*r*0.7, ey = Math.sin(a)*r*0.7;
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(ex, ey); ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(ex*0.6, ey*0.6); ctx.lineTo(ex*0.6 + Math.cos(a+0.6)*r*0.18, ey*0.6 + Math.sin(a+0.6)*r*0.18);
        ctx.moveTo(ex*0.6, ey*0.6); ctx.lineTo(ex*0.6 + Math.cos(a-0.6)*r*0.18, ey*0.6 + Math.sin(a-0.6)*r*0.18);
        ctx.stroke();
      }
      ctx.fillStyle = '#5fd0ff';
      ctx.beginPath(); ctx.arc(0, 0, r*0.22, 0, 7); ctx.fill();
      break;
  }
  ctx.restore();
}

function drawHpBar(ctx, u, w, cx, cy, withMana) {
  const frac = clamp(u.hp / u.hpMax(), 0, 1);
  const x = cx - w/2, y = cy;
  const h = withMana ? 10 : 7;
  const structural = u.type === 'tower' || u.type === 'core';
  if (structural) {
    // MLBB-style structure plate: gold-trimmed backing + shield glyph while
    // the invulnerability chain still protects this building
    ctx.fillStyle = 'rgba(6,10,16,0.72)';
    roundRect(ctx, x - 5, y - 4, w + 10, h + 9, 3.5); ctx.fill();
    ctx.strokeStyle = u.invulnerable ? 'rgba(160,175,190,0.55)' : 'rgba(226,183,104,0.55)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, x - 5, y - 4, w + 10, h + 9, 3.5); ctx.stroke();
    if (u.invulnerable) {
      ctx.fillStyle = '#c9d4de';
      ctx.beginPath();
      ctx.moveTo(x - 12, y - 1); ctx.lineTo(x - 5.5, y + 1.5); ctx.lineTo(x - 5.5, y + 5);
      ctx.quadraticCurveTo(x - 8.75, y + 9.5, x - 12, y + 5);
      ctx.closePath(); ctx.fill();
    }
  }
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
  // segment ticks: five pips on structures, quarters on other big bars
  if (w >= 60) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    const step = structural ? 0.2 : 0.25;
    for (let q = step; q < 0.999; q += step) ctx.fillRect(x + w*q - 0.5, y, 1, 5);
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
  r = Math.min(255, Math.max(0, r)); g = Math.min(255, Math.max(0, g)); b = Math.min(255, Math.max(0, b));
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// hex (#rgb / #rrggbb) or shorthand → rgba() string with the given alpha; used
// by the ability-VFX gradients. Non-hex inputs (already rgb/rgba) pass through.
function hexA(color, a) {
  if (typeof color !== 'string' || color[0] !== '#') return color;
  let h = color.slice(1);
  if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
  const n = parseInt(h, 16);
  return 'rgba(' + (n>>16 & 255) + ',' + (n>>8 & 255) + ',' + (n & 255) + ',' + a + ')';
}
