// ============================================================
// VOID ARENA — Bot AI for allied and enemy heroes
// ============================================================

function botUpdate(h, dt) {
  h.aiT -= dt;
  if (h.aiT <= 0) {
    h.aiT = 0.25;
    botThink(h);
  }
  botAct(h, dt);
}

function botThink(h) {
  // shopping: buy next recommended item whenever affordable
  const next = h.nextBuildItem();
  if (next && h.gold >= next.cost) {
    if (h.buyItem(next)) h.buildIdx++;
  }

  // skill points: prioritize the ult whenever it's off cooldown-gate,
  // otherwise round-robin the two basics like a typical MLBB build
  while (h.skillPoints > 0) {
    let order = [2, 0, 1];
    if (!h.canUpgrade(2)) order = h.skillLv[0] <= h.skillLv[1] ? [0, 1] : [1, 0];
    const pick = order.find(i => h.canUpgrade(i));
    if (pick === undefined) break;
    h.upgradeSkill(pick);
  }

  const hpFrac = h.hp / h.hpMax();
  const enemyHero = nearestEnemy(h, 700, u => u.type === 'hero');
  const anyEnemy = nearestEnemy(h, 600);

  // danger: enemy tower shooting at us with no minion screen
  const dangerTower = G.towers.find(t =>
    t.team !== h.team && !t.dead && dist(t, h) < t.atkRange + 40 &&
    !G.units.some(m => m.type === 'minion' && m.team === h.team && !m.dead && dist(m, t) < t.atkRange));

  if (hpFrac < 0.28 || (dangerTower && hpFrac < 0.6)) {
    h.aiState = 'retreat';
  } else if (h.aiState === 'retreat') {
    const safe = !nearestEnemy(h, 800, u => u.type === 'hero' || u.type === 'tower');
    if (hpFrac > 0.55 && !safe && h.recallT <= 0) h.aiState = 'lane';
    if (safe && hpFrac < 0.6 && h.recallT <= 0 && dist(h, CORES[h.team]) > CFG.fountainRadius) {
      h.startRecall();
    }
    if (hpFrac > 0.9) h.aiState = 'lane';
  } else if (enemyHero || anyEnemy) {
    h.aiState = 'fight';
    h.aiTarget = pickBotTarget(h, enemyHero, anyEnemy);
  } else {
    h.aiState = 'lane';
    h.aiTarget = null;
  }

  // skill usage during fights
  if (h.aiState === 'fight' && h.aiTarget && h.aiTarget.type === 'hero') {
    const t = h.aiTarget;
    const d = dist(h, t);
    const aim = aimAt(h, t);
    for (let i = 0; i < 2; i++) {
      const sk = h.def.skills[i];
      const range = sk.range || 250;
      if (h.skillReady(i) && d < range + 60) h.cast(i, aim);
    }
    const ult = h.def.skills[2];
    const alliesNear = G.units.filter(u => u.type === 'hero' && u.team === h.team && !u.dead && dist(u, h) < 500).length;
    if (h.skillReady(2) && d < (ult.range || 350) + 60 &&
        (t.hp < t.hpMax() * 0.55 || alliesNear >= 2 || h.hp < h.hpMax() * 0.4)) {
      h.cast(2, aim);
    }
  }

  botBattleSpell(h);
}

// bots use their battle spell situationally, matched to what it does
function botBattleSpell(h) {
  if (!h.bsReady()) return;
  const hpFrac = h.hp / h.hpMax();
  const enemyHero = nearestEnemy(h, 520, u => u.type === 'hero');
  switch (h.battleSpell) {
    case 'heal':
      if (hpFrac < 0.4 && enemyHero) h.castBattleSpell(null);
      break;
    case 'execute':
      if (enemyHero && enemyHero.hp < enemyHero.hpMax() * 0.42) h.castBattleSpell(aimAt(h, enemyHero));
      break;
    case 'flicker':
      // blink toward base to escape when cornered while retreating
      if (h.aiState === 'retreat' && nearestEnemy(h, 340, u => u.type === 'hero')) {
        const c = CORES[h.team];
        const a = Math.atan2(c.y - h.y, c.x - h.x);
        h.castBattleSpell({ dx: Math.cos(a), dy: Math.sin(a) });
      }
      break;
    case 'sprint':
      if ((h.aiState === 'retreat' && hpFrac < 0.5) ||
          (h.aiState === 'fight' && enemyHero && dist(h, enemyHero) > 280)) {
        h.castBattleSpell(null);
      }
      break;
  }
}

function botAct(h, dt) {
  if (h.recallT > 0) return;

  if (h.aiState === 'retreat') {
    const c = CORES[h.team];
    h.moveToward(c.x, c.y, dt);
    return;
  }

  if (h.aiState === 'fight' && h.aiTarget && !h.aiTarget.dead) {
    const t = h.aiTarget;
    const d = dist(h, t) - t.radius;
    if (d > h.atkRange * 0.95) {
      h.moveToward(t.x, t.y, dt);
    } else {
      h.tryAttack(t, dt);
      // ranged heroes kite a little
      if (!h.melee && d < h.atkRange * 0.5 && t.type === 'hero') {
        const a = Math.atan2(h.y - t.y, h.x - t.x);
        h.moveToward(h.x + Math.cos(a)*100, h.y + Math.sin(a)*100, dt);
      }
    }
    return;
  }

  // lane push: walk waypoints toward enemy core
  const path = h.team === 'blue' ? LANES[h.lane] : [...LANES[h.lane]].reverse();
  let wp = path[Math.min(h.wpIdx, path.length - 1)];
  if (dist(h, {x:wp[0], y:wp[1]}) < 90) {
    if (h.wpIdx < path.length - 1) h.wpIdx++;
    wp = path[Math.min(h.wpIdx, path.length - 1)];
  }
  // sync waypoint index to current position (after respawn/recall walk to nearest forward wp)
  if (h.wpIdx === 0) {
    let bi = 0, bd = 1e9;
    for (let i = 0; i < path.length; i++) {
      const d = dist(h, {x:path[i][0], y:path[i][1]});
      if (d < bd) { bd = d; bi = i; }
    }
    h.wpIdx = bi;
    wp = path[Math.min(h.wpIdx, path.length - 1)];
  }
  h.moveToward(wp[0], wp[1], dt);
}

function pickBotTarget(h, enemyHero, anyEnemy) {
  // prefer low-hp visible heroes, else structures/minions
  if (enemyHero) {
    let best = enemyHero, bs = 1e9;
    for (const u of G.units) {
      if (u.team === h.team || u.dead || u.type !== 'hero') continue;
      if (!isVisibleTo(u, h)) continue;
      const d = dist(h, u);
      if (d > 700) continue;
      const score = d + (u.hp / u.hpMax()) * 600;
      if (score < bs) { bs = score; best = u; }
    }
    return best;
  }
  return anyEnemy;
}

function nearestEnemy(h, range, filter) {
  let best = null, bd = range;
  for (const u of G.units) {
    if (u.team === h.team || u.team === 'jungle' || u.dead || u.untargetable || u.invulnerable) continue;
    if (filter && !filter(u)) continue;
    if (u.type === 'hero' && !isVisibleTo(u, h)) continue;
    const d = dist(h, u);
    if (d < bd) { bd = d; best = u; }
  }
  return best;
}

function aimAt(h, t) {
  const dx = t.x - h.x, dy = t.y - h.y;
  const d = Math.hypot(dx, dy) || 1;
  return { dx: dx/d, dy: dy/d, tx: t.x, ty: t.y };
}
