// ============================================================
// VOID LEGENDS — hero skill implementations
// each cast: (game, hero, aim) where aim is a world point
// ============================================================
'use strict';

function enemiesWithin(game, team, x, y, r) {
  const out = [];
  for (const u of game.allTargets(team)) {
    if (!u.dead && dist(x, y, u.x, u.y) < r + u.radius) out.push(u);
  }
  return out;
}

function enemiesAlongSegment(game, team, x1, y1, x2, y2, width) {
  const out = [];
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  for (const u of game.allTargets(team)) {
    if (u.dead) continue;
    const t = clamp(((u.x - x1) * dx + (u.y - y1) * dy) / len2, 0, 1);
    const px = x1 + dx * t, py = y1 + dy * t;
    if (dist(px, py, u.x, u.y) < width + u.radius) out.push(u);
  }
  return out;
}

function aimDir(hero, aim) {
  const d = norm(aim.x - hero.x, aim.y - hero.y);
  if (d.x === 0 && d.y === 0) return { x: Math.cos(hero.facing), y: Math.sin(hero.facing) };
  return d;
}

function clampAim(hero, aim, maxRange) {
  const d = dist(hero.x, hero.y, aim.x, aim.y);
  if (d <= maxRange) return { x: aim.x, y: aim.y };
  const n = aimDir(hero, aim);
  return { x: hero.x + n.x * maxRange, y: hero.y + n.y * maxRange };
}

function dashTo(game, hero, dir, distance) {
  const nx = clamp(hero.x + dir.x * distance, 40, WORLD - 40);
  const ny = clamp(hero.y + dir.y * distance, 40, WORLD - 40);
  game.addEffect({ type: 'trail', x1: hero.x, y1: hero.y, x2: nx, y2: ny, ttl: 0.25, color: hero.def.color });
  hero.x = nx; hero.y = ny;
  hero.facing = Math.atan2(dir.y, dir.x);
  hero.interruptRecall();
}

// ---------------- Kaelis — Dawnblade (Fighter) ----------------
HEROES.kaelis.skills[0].cast = (game, hero, aim) => {   // Dawn Rush
  const dir = aimDir(hero, aim);
  const x1 = hero.x, y1 = hero.y;
  dashTo(game, hero, dir, 270);
  const dmg = 95 + 20 * hero.level + 0.8 * hero.ad;
  for (const u of enemiesAlongSegment(game, hero.team, x1, y1, hero.x, hero.y, 70)) {
    dealDamage(game, hero, u, dmg, 'physical');
  }
};
HEROES.kaelis.skills[1].cast = (game, hero) => {        // Crescent Sweep
  game.addEffect({ type: 'nova', x: hero.x, y: hero.y, r: 150, ttl: 0.35, color: '#f5a524' });
  const dmg = 120 + 18 * hero.level + 0.9 * hero.ad;
  for (const u of enemiesWithin(game, hero.team, hero.x, hero.y, 150)) {
    dealDamage(game, hero, u, dmg, 'physical');
    u.slowTimer = 1.5; u.slowAmount = 0.3;
  }
};
HEROES.kaelis.skills[2].cast = (game, hero, aim) => {   // Sunfall
  const p = clampAim(hero, aim, 380);
  dashTo(game, hero, aimDir(hero, p), dist(hero.x, hero.y, p.x, p.y));
  game.addEffect({ type: 'nova', x: hero.x, y: hero.y, r: 185, ttl: 0.5, color: '#fbbf24' });
  const dmg = 240 + 30 * hero.level + 1.1 * hero.ad;
  for (const u of enemiesWithin(game, hero.team, hero.x, hero.y, 185)) {
    dealDamage(game, hero, u, dmg, 'physical');
    if (u.kind !== 'tower' && u.kind !== 'core') u.stunTimer = Math.max(u.stunTimer, 1.0);
  }
};

// ---------------- Nyra — Void Weaver (Mage) ----------------
HEROES.nyra.skills[0].cast = (game, hero, aim) => {     // Void Bolt
  game.projectiles.push(new Projectile({
    x: hero.x, y: hero.y, team: hero.team, owner: hero,
    dir: aimDir(hero, aim), speed: 720, maxDist: 760,
    dmg: 150 + 22 * hero.level + 0.9 * hero.ap, type: 'magic',
    color: '#c084fc', size: 9, hitRadius: 26,
  }));
};
HEROES.nyra.skills[1].cast = (game, hero, aim) => {     // Gravity Well
  const p = clampAim(hero, aim, 480);
  game.zones.push(new Zone({
    x: p.x, y: p.y, radius: 155, team: hero.team, owner: hero,
    duration: 3, tickRate: 0.5, color: 'rgba(168,85,247,0.30)',
    onTick: (g, z) => {
      const dmg = 36 + 5 * hero.level + 0.15 * hero.ap;
      for (const u of z.unitsInside(g, hero.team)) {
        dealDamage(g, hero, u, dmg, 'magic');
        u.slowTimer = Math.max(u.slowTimer, 0.6); u.slowAmount = 0.4;
      }
    },
  }));
};
HEROES.nyra.skills[2].cast = (game, hero, aim) => {     // Event Horizon
  const p = clampAim(hero, aim, 520);
  game.addEffect({ type: 'telegraph', x: p.x, y: p.y, r: 230, ttl: 0.9, color: '#a855f7' });
  game.schedule(0.9, () => {
    game.addEffect({ type: 'nova', x: p.x, y: p.y, r: 230, ttl: 0.5, color: '#a855f7' });
    const dmg = 320 + 40 * hero.level + 1.0 * hero.ap;
    for (const u of enemiesWithin(game, hero.team, p.x, p.y, 230)) {
      dealDamage(game, hero, u, dmg, 'magic');
      if (u.kind !== 'tower' && u.kind !== 'core') {
        const pull = norm(p.x - u.x, p.y - u.y);
        u.x = clamp(u.x + pull.x * 110, 40, WORLD - 40);
        u.y = clamp(u.y + pull.y * 110, 40, WORLD - 40);
        u.stunTimer = Math.max(u.stunTimer, 0.6);
      }
    }
  });
};

// ---------------- Bram — Ironhide (Tank) ----------------
HEROES.bram.skills[0].cast = (game, hero, aim) => {     // Bull Charge
  const dir = aimDir(hero, aim);
  const x1 = hero.x, y1 = hero.y;
  dashTo(game, hero, dir, 330);
  const hits = enemiesAlongSegment(game, hero.team, x1, y1, hero.x, hero.y, 75)
    .filter(u => u.kind !== 'tower' && u.kind !== 'core')
    .sort((a, b) => dist(x1, y1, a.x, a.y) - dist(x1, y1, b.x, b.y));
  if (hits.length) {
    const u = hits[0];
    dealDamage(game, hero, u, 100 + 15 * hero.level + 0.7 * hero.ad, 'physical');
    u.stunTimer = Math.max(u.stunTimer, 0.9);
    // stop next to the victim
    hero.x = clamp(u.x - dir.x * (u.radius + hero.radius), 40, WORLD - 40);
    hero.y = clamp(u.y - dir.y * (u.radius + hero.radius), 40, WORLD - 40);
  }
};
HEROES.bram.skills[1].cast = (game, hero) => {          // Iron Bastion
  hero.shield = 200 + 30 * hero.level + hero.maxHp * 0.12;
  hero.shieldTimer = 5;
  hero.thorns = 0.35;
  game.addEffect({ type: 'ring', x: hero.x, y: hero.y, r: hero.radius, r2: hero.radius + 34, ttl: 0.5, color: '#cbd5e1' });
};
HEROES.bram.skills[2].cast = (game, hero) => {          // Seismic Slam
  game.addEffect({ type: 'nova', x: hero.x, y: hero.y, r: 290, ttl: 0.55, color: '#94a3b8' });
  const dmg = 180 + 25 * hero.level + 0.8 * hero.ad;
  for (const u of enemiesWithin(game, hero.team, hero.x, hero.y, 290)) {
    dealDamage(game, hero, u, dmg, 'magic');
    if (u.kind !== 'tower' && u.kind !== 'core') u.stunTimer = Math.max(u.stunTimer, 1.2);
  }
};

// ---------------- Sylfa — Windarrow (Marksman) ----------------
HEROES.sylfa.skills[0].cast = (game, hero, aim) => {    // Piercing Gale
  game.projectiles.push(new Projectile({
    x: hero.x, y: hero.y, team: hero.team, owner: hero,
    dir: aimDir(hero, aim), speed: 860, maxDist: 830, pierce: true,
    dmg: 120 + 18 * hero.level + 1.0 * hero.ad, type: 'physical',
    color: '#6ee7b7', size: 7, hitRadius: 24,
  }));
};
HEROES.sylfa.skills[1].cast = (game, hero, aim) => {    // Zephyr Step
  dashTo(game, hero, aimDir(hero, aim), 240);
  hero.atkSpdBuff = 0.6; hero.atkSpdBuffTimer = 4;
};
HEROES.sylfa.skills[2].cast = (game, hero, aim) => {    // Arrowstorm
  const p = clampAim(hero, aim, 620);
  game.zones.push(new Zone({
    x: p.x, y: p.y, radius: 215, team: hero.team, owner: hero,
    duration: 3, tickRate: 0.4, color: 'rgba(52,211,153,0.28)',
    onTick: (g, z) => {
      const dmg = 46 + 7 * hero.level + 0.35 * hero.ad;
      for (const u of z.unitsInside(g, hero.team)) dealDamage(g, hero, u, dmg, 'physical');
    },
  }));
};

// ---------------- Miro — Lantern Sage (Support) ----------------
HEROES.miro.skills[0].cast = (game, hero, aim) => {     // Spirit Flame
  game.projectiles.push(new Projectile({
    x: hero.x, y: hero.y, team: hero.team, owner: hero,
    dir: aimDir(hero, aim), speed: 680, maxDist: 720,
    dmg: 130 + 20 * hero.level + 0.8 * hero.ap, type: 'magic',
    color: '#fde047', size: 8, hitRadius: 26,
    onHit: (g, u) => { u.slowTimer = 1.5; u.slowAmount = 0.35; },
  }));
};
HEROES.miro.skills[1].cast = (game, hero) => {          // Soothing Light
  game.addEffect({ type: 'nova', x: hero.x, y: hero.y, r: 210, ttl: 0.5, color: '#fde047' });
  const amount = 140 + 22 * hero.level + 0.6 * hero.ap;
  for (const h of game.heroes) {
    if (h.team === hero.team && !h.dead && distU(h, hero) < 210 + h.radius) heal(game, h, amount);
  }
};
HEROES.miro.skills[2].cast = (game, hero) => {          // Sanctuary
  game.zones.push(new Zone({
    x: hero.x, y: hero.y, radius: 265, team: hero.team, owner: hero,
    duration: 4.5, tickRate: 0.5, color: 'rgba(250,204,21,0.22)',
    onTick: (g, z) => {
      const amount = 45 + 6 * hero.level + 0.25 * hero.ap;
      for (const h of z.alliesInside(g)) heal(g, h, amount);
      for (const u of z.unitsInside(g, hero.team)) {
        if (u.kind !== 'tower' && u.kind !== 'core') { u.slowTimer = Math.max(u.slowTimer, 0.6); u.slowAmount = 0.35; }
      }
    },
  }));
};
