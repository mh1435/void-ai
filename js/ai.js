// ============================================================
// VOID LEGENDS — bot hero AI
// ============================================================
'use strict';

function attachBotAI(hero, lane) {
  hero.ai = {
    lane,
    wpIndex: hero.team === TEAM_BLUE ? 1 : LANES[lane].length - 2,
    buyIndex: 0,
    resting: false,        // stay at fountain until healthy
    offLane: true,
  };
}

function botNearestLaneIndex(hero) {
  const wp = LANES[hero.ai.lane];
  let best = 0, bestD = Infinity;
  for (let i = 0; i < wp.length; i++) {
    const d = dist(hero.x, hero.y, wp[i][0], wp[i][1]);
    if (d < bestD) { bestD = d; best = i; }
  }
  const step = hero.team === TEAM_BLUE ? 1 : -1;
  return clamp(best + step, 0, wp.length - 1);
}

function underEnemyTowerFire(game, hero) {
  for (const t of game.towers) {
    if (t.dead || t.team === hero.team) continue;
    if (distU(t, hero) < t.range + 60) return t;
  }
  return null;
}

function botUseSkills(game, hero, target) {
  if (!target) return;
  const d = distU(hero, target);
  const aim = { x: target.x, y: target.y };
  const isStructure = target.kind === 'tower' || target.kind === 'core';

  // ult: only on heroes, when reasonably healthy and close
  if (!isStructure && target.kind === 'hero' && hero.canCast(2) && d < 420 && hero.hp > hero.maxHp * 0.35) {
    game.castSkill(hero, 2, aim);
    return;
  }
  if (hero.canCast(0) && d < 480 && (!isStructure || hero.heroId === 'sylfa')) {
    game.castSkill(hero, 0, aim);
    return;
  }
  if (hero.canCast(1)) {
    // self-buff / self-centred skills want the target close
    const selfCentred = ['kaelis', 'bram', 'miro'].includes(hero.heroId);
    if (hero.heroId === 'miro') {
      // heal when hurt allies are around
      let hurt = false;
      for (const h of game.heroes) {
        if (h.team === hero.team && !h.dead && h.hp < h.maxHp * 0.7 && distU(h, hero) < 210) hurt = true;
      }
      if (hurt) game.castSkill(hero, 1, aim);
    } else if (!selfCentred && d < 460) {
      game.castSkill(hero, 1, aim);
    } else if (selfCentred && d < 220 && !isStructure) {
      game.castSkill(hero, 1, aim);
    }
  }
}

function updateBot(game, hero, dt) {
  const ai = hero.ai;
  if (hero.dead) { ai.offLane = true; ai.resting = false; return; }
  if (hero.recallTimer > 0) return;

  // shopping
  const plan = hero.def.aiItems;
  while (ai.buyIndex < plan.length && hero.items.length < MAX_ITEMS) {
    const item = ITEMS.find(it => it.id === plan[ai.buyIndex]);
    if (item && hero.gold >= item.cost) { hero.buyItem(game, item); ai.buyIndex++; }
    else break;
  }

  hero.moveInput.x = 0; hero.moveInput.y = 0;
  const base = BASE_POS[hero.team];
  const hpFrac = hero.hp / hero.maxHp;
  const nearEnemyHero = game.nearestEnemy(hero, 560, ['hero']);
  const dangerClose = game.nearestEnemy(hero, 340, ['hero', 'minion', 'tower']);

  // fountain rest
  if (ai.resting) {
    if (hpFrac > 0.92 && hero.mana > hero.maxMana * 0.8) { ai.resting = false; ai.offLane = true; }
    else {
      hero.attackTarget = null;
      hero.moveInput.x = base.x - hero.x; hero.moveInput.y = base.y - hero.y;
      if (dist(hero.x, hero.y, base.x, base.y) < 80) { hero.moveInput.x = 0; hero.moveInput.y = 0; }
      return;
    }
  }

  // panic: flee toward base
  if (hpFrac < 0.2 && dangerClose) {
    hero.attackTarget = null;
    hero.moveInput.x = base.x - hero.x; hero.moveInput.y = base.y - hero.y;
    ai.offLane = true;
    return;
  }

  // low and safe: recall
  if (hpFrac < 0.34 && !nearEnemyHero && !dangerClose) {
    ai.resting = true;
    if (dist(hero.x, hero.y, base.x, base.y) > FOUNTAIN_RANGE) hero.startRecall(game);
    return;
  }

  // avoid tower dives without minion backup
  const dangerTower = underEnemyTowerFire(game, hero);
  if (dangerTower) {
    let backup = 0;
    for (const m of game.minions) {
      if (m.team === hero.team && !m.dead && distU(m, hero) < 360) backup++;
    }
    if (backup < 2) {
      hero.attackTarget = null;
      hero.moveInput.x = base.x - hero.x; hero.moveInput.y = base.y - hero.y;
      return;
    }
  }

  // fight: enemy hero nearby
  if (nearEnemyHero) {
    botUseSkills(game, hero, nearEnemyHero);
    hero.attackTarget = nearEnemyHero;
    ai.offLane = true;
    return;
  }

  // push: attack structures / minions in reach
  const pushTarget =
    game.nearestEnemy(hero, hero.range + 220, ['minion', 'jungle']) ||
    game.nearestEnemy(hero, hero.range + 160, ['tower', 'core']);
  if (pushTarget) {
    if (pushTarget.kind === 'tower' || pushTarget.kind === 'core') botUseSkills(game, hero, pushTarget);
    hero.attackTarget = pushTarget;
    ai.offLane = true;
    return;
  }

  // otherwise walk the lane
  hero.attackTarget = null;
  if (ai.offLane) { ai.wpIndex = botNearestLaneIndex(hero); ai.offLane = false; }
  const wp = LANES[ai.lane];
  const step = hero.team === TEAM_BLUE ? 1 : -1;
  ai.wpIndex = clamp(ai.wpIndex, 0, wp.length - 1);
  const target = wp[ai.wpIndex];
  if (dist(hero.x, hero.y, target[0], target[1]) < 70) {
    ai.wpIndex = clamp(ai.wpIndex + step, 0, wp.length - 1);
  }
  hero.moveInput.x = target[0] - hero.x;
  hero.moveInput.y = target[1] - hero.y;
}
