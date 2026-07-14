// ============================================================
// VOID LEGENDS — units, projectiles, zones, damage
// ============================================================
'use strict';

let NEXT_UID = 1;

// ------------------------------------------------------------
// base unit
// ------------------------------------------------------------
class Unit {
  constructor(team, x, y) {
    this.uid = NEXT_UID++;
    this.team = team;
    this.x = x; this.y = y;
    this.facing = team === TEAM_BLUE ? -Math.PI / 4 : Math.PI * 0.75;
    this.hp = 100; this.maxHp = 100;
    this.mana = 0; this.maxMana = 0;
    this.ad = 10; this.ap = 0;
    this.armor = 0; this.mr = 0;
    this.range = 60; this.atkSpd = 1; this.speed = 150;
    this.radius = 15;
    this.dead = false;
    this.shield = 0;
    this.attackCd = 0;
    this.attackTarget = null;
    this.stunTimer = 0;
    this.slowTimer = 0; this.slowAmount = 0;
    this.lifesteal = 0;
    this.kind = 'unit';
    this.recentDamagers = [];   // {unit, t} for assist credit
  }

  get alive() { return !this.dead; }
  get stunned() { return this.stunTimer > 0; }
  get effSpeed() {
    return this.speed * (this.slowTimer > 0 ? (1 - this.slowAmount) : 1);
  }

  updateTimers(dt) {
    if (this.attackCd > 0) this.attackCd -= dt;
    if (this.stunTimer > 0) this.stunTimer -= dt;
    if (this.slowTimer > 0) this.slowTimer -= dt;
  }

  moveBy(dx, dy, dt) {
    if (this.stunned || this.dead) return;
    const n = norm(dx, dy);
    if (n.x === 0 && n.y === 0) return;
    this.x = clamp(this.x + n.x * this.effSpeed * dt, 30, WORLD - 30);
    this.y = clamp(this.y + n.y * this.effSpeed * dt, 30, WORLD - 30);
    this.facing = Math.atan2(n.y, n.x);
  }

  inRangeOf(target) {
    return distU(this, target) <= this.range + target.radius + this.radius * 0.5;
  }

  // basic attack when off cooldown; melee hits instantly, ranged fires a bolt
  tryAttack(game, target) {
    if (this.dead || this.stunned || !target || target.dead) return;
    if (!this.inRangeOf(target)) return;
    const dir = norm(target.x - this.x, target.y - this.y);
    if (dir.x || dir.y) this.facing = Math.atan2(dir.y, dir.x);
    if (this.attackCd > 0) return;
    this.attackCd = 1 / this.atkSpd;
    if (this.range > 130) {
      game.projectiles.push(new Projectile({
        x: this.x, y: this.y, team: this.team, owner: this,
        target, speed: 640, dmg: this.ad, type: 'physical',
        color: this.kind === 'tower' ? '#ffd166' : TEAM_COLORS[this.team], size: this.kind === 'tower' ? 8 : 5,
      }));
    } else {
      game.addEffect({ type: 'slash', x: target.x, y: target.y, angle: this.facing, ttl: 0.18, color: '#fff' });
      dealDamage(game, this, target, this.ad, 'physical');
    }
  }
}

// ------------------------------------------------------------
// hero
// ------------------------------------------------------------
class Hero extends Unit {
  constructor(team, heroId, isPlayer) {
    const def = HEROES[heroId];
    const base = BASE_POS[team];
    super(team, base.x + (Math.random() - 0.5) * 120, base.y + (Math.random() - 0.5) * 120);
    this.kind = 'hero';
    this.heroId = heroId;
    this.def = def;
    this.isPlayer = !!isPlayer;
    this.level = 1;
    this.xp = 0;
    this.gold = START_GOLD;
    this.kills = 0; this.deaths = 0; this.assists = 0;
    this.items = [];
    this.cooldowns = [0, 0, 0];
    this.respawnTimer = 0;
    this.recallTimer = 0;       // >0 while channeling
    this.shieldTimer = 0;
    this.thorns = 0;            // reflected damage fraction while bastion is up
    this.atkSpdBuffTimer = 0; this.atkSpdBuff = 0;
    this.moveInput = { x: 0, y: 0 };   // set each frame by player / AI
    this.ai = null;             // attached by ai.js for bots
    this.recalc();
    this.hp = this.maxHp;
    this.mana = this.maxMana;
  }

  recalc() {
    const b = this.def.base, l = this.level - 1;
    const hpFrac = this.maxHp > 0 ? this.hp / this.maxHp : 1;
    const mpFrac = this.maxMana > 0 ? this.mana / this.maxMana : 1;
    let hp = b.hp + b.hpG * l, mana = b.mana + b.manaG * l;
    let ad = b.ad + b.adG * l, ap = b.ap + (b.ap > 0 ? 6 * l : 0);
    let armor = b.armor + b.armorG * l, mr = b.mr + b.mrG * l;
    let speed = b.speed, lifesteal = 0;
    for (const it of this.items) {
      const s = it.stats;
      if (s.hp) hp += s.hp;
      if (s.ad) ad += s.ad;
      if (s.ap) ap += s.ap;
      if (s.armor) armor += s.armor;
      if (s.mr) mr += s.mr;
      if (s.speed) speed += s.speed;
      if (s.lifesteal) lifesteal += s.lifesteal;
    }
    this.maxHp = hp; this.maxMana = mana;
    this.ad = ad; this.ap = ap;
    this.armor = armor; this.mr = mr;
    this.speed = speed; this.lifesteal = lifesteal;
    this.range = b.range;
    this.radius = b.radius;
    this.hpRegen = b.hpRegen + 0.18 * l;
    this.manaRegen = b.manaRegen + 0.14 * l;
    this.hp = hpFrac * this.maxHp;
    this.mana = mpFrac * this.maxMana;
  }

  get effAtkSpd() {
    const b = this.def.base;
    return b.atkSpd * (1 + 0.025 * (this.level - 1)) * (this.atkSpdBuffTimer > 0 ? 1 + this.atkSpdBuff : 1);
  }

  addXp(game, amount) {
    if (this.level >= MAX_LEVEL) return;
    this.xp += amount;
    while (this.level < MAX_LEVEL && this.xp >= XP_TABLE[this.level]) {
      this.level++;
      this.recalc();
      this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.14);
      this.mana = Math.min(this.maxMana, this.mana + this.maxMana * 0.2);
      game.addEffect({ type: 'levelup', x: this.x, y: this.y, unit: this, ttl: 1.2 });
      if (this.isPlayer) game.ui.flash('LEVEL ' + this.level + '!');
    }
  }

  ultReady() { return this.level >= 4; }

  canCast(i) {
    if (this.dead || this.stunned) return false;
    if (i === 2 && !this.ultReady()) return false;
    if (this.cooldowns[i] > 0) return false;
    return this.mana >= this.def.skills[i].mana;
  }

  buyItem(game, item) {
    if (this.items.length >= MAX_ITEMS || this.gold < item.cost) return false;
    this.gold -= item.cost;
    this.items.push(item);
    this.recalc();
    if (this.isPlayer) game.ui.flash(item.name + ' purchased');
    return true;
  }

  startRecall(game) {
    if (this.dead || this.recallTimer > 0) return;
    this.recallTimer = RECALL_TIME;
    if (this.isPlayer) game.ui.flash('Recalling…');
  }

  interruptRecall() { this.recallTimer = 0; }

  update(game, dt) {
    if (this.dead) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) this.respawn(game);
      return;
    }
    this.updateTimers(dt);
    for (let i = 0; i < 3; i++) if (this.cooldowns[i] > 0) this.cooldowns[i] -= dt;
    if (this.atkSpdBuffTimer > 0) this.atkSpdBuffTimer -= dt;
    if (this.shieldTimer > 0) { this.shieldTimer -= dt; if (this.shieldTimer <= 0) { this.shield = 0; this.thorns = 0; } }
    this.atkSpd = this.effAtkSpd;

    // regen (boosted at own fountain)
    const base = BASE_POS[this.team];
    const atFountain = dist(this.x, this.y, base.x, base.y) < FOUNTAIN_RANGE;
    const hpR = atFountain ? this.maxHp * 0.09 : this.hpRegen;
    const mpR = atFountain ? this.maxMana * 0.12 : this.manaRegen;
    this.hp = Math.min(this.maxHp, this.hp + hpR * dt);
    this.mana = Math.min(this.maxMana, this.mana + mpR * dt);
    this.gold += PASSIVE_GOLD_PER_SEC * dt;

    // recall channel
    if (this.recallTimer > 0) {
      this.recallTimer -= dt;
      if (this.recallTimer <= 0) {
        this.x = base.x; this.y = base.y;
        game.addEffect({ type: 'ring', x: this.x, y: this.y, r: 20, r2: 120, ttl: 0.5, color: '#8be9fd' });
      }
      return; // channeling: no move / attack
    }

    // movement from input
    if (this.moveInput.x || this.moveInput.y) {
      this.moveBy(this.moveInput.x, this.moveInput.y, dt);
      this.attackTarget = null;
    } else if (this.attackTarget && !this.attackTarget.dead) {
      const t = this.attackTarget;
      if (this.inRangeOf(t)) this.tryAttack(game, t);
      else this.moveBy(t.x - this.x, t.y - this.y, dt);
    } else if (this.isPlayer) {
      // idle auto-attack, ML-style
      const t = game.nearestEnemy(this, this.range + 40, ['hero', 'minion', 'jungle', 'tower', 'core']);
      if (t) this.tryAttack(game, t);
    }

    // prune assist list
    const now = game.time;
    this.recentDamagers = this.recentDamagers.filter(d => now - d.t < 8);
  }

  respawn(game) {
    this.dead = false;
    const base = BASE_POS[this.team];
    this.x = base.x; this.y = base.y;
    this.hp = this.maxHp; this.mana = this.maxMana;
    this.stunTimer = 0; this.slowTimer = 0; this.shield = 0;
    this.attackTarget = null;
    game.addEffect({ type: 'ring', x: this.x, y: this.y, r: 20, r2: 140, ttl: 0.6, color: TEAM_COLORS[this.team] });
  }
}

// ------------------------------------------------------------
// minion
// ------------------------------------------------------------
class Minion extends Unit {
  constructor(team, lane, isRanged, minute) {
    const wp = LANES[lane];
    const start = team === TEAM_BLUE ? wp[0] : wp[wp.length - 1];
    super(team, start[0] + (Math.random() - 0.5) * 70, start[1] + (Math.random() - 0.5) * 70);
    this.kind = 'minion';
    this.lane = lane;
    this.isRanged = isRanged;
    const s = isRanged ? MINION_STATS.ranged : MINION_STATS.melee;
    this.maxHp = s.hp + s.hpPerMin * minute; this.hp = this.maxHp;
    this.ad = s.ad + s.adPerMin * minute;
    this.range = s.range; this.atkSpd = s.atkSpd; this.speed = s.speed;
    this.radius = s.radius;
    this.gold = s.gold; this.xp = s.xp;
    this.wpIndex = team === TEAM_BLUE ? 1 : wp.length - 2;
  }

  update(game, dt) {
    if (this.dead) return;
    this.updateTimers(dt);
    // fight anything close
    if (!this.attackTarget || this.attackTarget.dead ||
        distU(this, this.attackTarget) > AGGRO_RANGE_MINION + 120) {
      this.attackTarget = game.nearestEnemy(this, AGGRO_RANGE_MINION, ['minion', 'hero', 'tower', 'core']);
    }
    if (this.attackTarget) {
      const t = this.attackTarget;
      if (this.inRangeOf(t)) { this.tryAttack(game, t); return; }
      this.moveBy(t.x - this.x, t.y - this.y, dt);
      return;
    }
    // walk the lane
    const wp = LANES[this.lane];
    const step = this.team === TEAM_BLUE ? 1 : -1;
    if (this.wpIndex < 0 || this.wpIndex >= wp.length) return;
    const target = wp[this.wpIndex];
    if (dist(this.x, this.y, target[0], target[1]) < 46) this.wpIndex += step;
    else this.moveBy(target[0] - this.x, target[1] - this.y, dt);
  }
}

// ------------------------------------------------------------
// towers & core
// ------------------------------------------------------------
class Tower extends Unit {
  constructor(def) {
    super(def.team, def.x, def.y);
    this.kind = 'tower';
    this.lane = def.lane; this.tier = def.tier;
    const s = TOWER_STATS[def.tier];
    this.maxHp = s.hp; this.hp = s.hp;
    this.ad = s.ad; this.range = s.range; this.atkSpd = s.atkSpd;
    this.radius = s.radius; this.goldReward = s.gold;
    this.speed = 0;
  }

  update(game, dt) {
    if (this.dead) return;
    this.updateTimers(dt);
    if (!this.attackTarget || this.attackTarget.dead || !this.inRangeOf(this.attackTarget)) {
      this.attackTarget =
        game.nearestEnemy(this, this.range, ['minion']) ||
        game.nearestEnemy(this, this.range, ['hero']);
    }
    if (this.attackTarget) this.tryAttack(game, this.attackTarget);
  }
}

class Core extends Unit {
  constructor(team) {
    const b = BASE_POS[team];
    super(team, b.x, b.y);
    this.kind = 'core';
    this.maxHp = CORE_HP; this.hp = CORE_HP;
    this.radius = CORE_RADIUS;
    this.speed = 0;
  }
  update() {}
}

// ------------------------------------------------------------
// jungle monster
// ------------------------------------------------------------
class JungleMonster extends Unit {
  constructor(camp, minute) {
    super(-1, camp.x, camp.y);           // team -1: hostile to everyone
    this.kind = 'jungle';
    this.camp = camp;
    const s = JUNGLE_STATS;
    this.maxHp = s.hp + s.hpPerMin * minute; this.hp = this.maxHp;
    this.ad = s.ad; this.range = s.range; this.atkSpd = s.atkSpd;
    this.speed = s.speed; this.radius = s.radius;
    this.gold = s.gold; this.xp = s.xp;
  }

  update(game, dt) {
    if (this.dead) return;
    this.updateTimers(dt);
    const home = this.camp;
    const far = dist(this.x, this.y, home.x, home.y) > JUNGLE_STATS.leash;
    if (far) { this.attackTarget = null; this.hp = Math.min(this.maxHp, this.hp + this.maxHp * 0.5 * dt); }
    if (this.attackTarget && (this.attackTarget.dead || distU(this, this.attackTarget) > JUNGLE_STATS.leash)) {
      this.attackTarget = null;
    }
    if (this.attackTarget) {
      const t = this.attackTarget;
      if (this.inRangeOf(t)) this.tryAttack(game, t);
      else this.moveBy(t.x - this.x, t.y - this.y, dt);
    } else if (dist(this.x, this.y, home.x, home.y) > 12) {
      this.moveBy(home.x - this.x, home.y - this.y, dt);
    }
  }
}

// ------------------------------------------------------------
// projectile: homing (target) or linear (dir)
// ------------------------------------------------------------
class Projectile {
  constructor(o) {
    this.x = o.x; this.y = o.y;
    this.team = o.team; this.owner = o.owner || null;
    this.target = o.target || null;         // homing
    this.dir = o.dir || null;               // linear {x,y} normalized
    this.speed = o.speed || 600;
    this.dmg = o.dmg; this.type = o.type || 'physical';
    this.color = o.color || '#fff';
    this.size = o.size || 6;
    this.pierce = !!o.pierce;
    this.maxDist = o.maxDist || 900;
    this.traveled = 0;
    this.hitRadius = o.hitRadius || 24;
    this.onHit = o.onHit || null;           // (game, unit) extra effect
    this.hitSet = new Set();
    this.done = false;
  }

  update(game, dt) {
    if (this.done) return;
    if (this.target) {
      if (this.target.dead) { this.done = true; return; }
      const d = norm(this.target.x - this.x, this.target.y - this.y);
      this.x += d.x * this.speed * dt;
      this.y += d.y * this.speed * dt;
      if (distU(this, this.target) < this.target.radius + this.size + 6) {
        dealDamage(game, this.owner, this.target, this.dmg, this.type);
        if (this.onHit) this.onHit(game, this.target);
        this.done = true;
      }
      return;
    }
    // linear
    const step = this.speed * dt;
    this.x += this.dir.x * step;
    this.y += this.dir.y * step;
    this.traveled += step;
    for (const u of game.allTargets(this.team)) {
      if (u.dead || this.hitSet.has(u.uid)) continue;
      if (dist(this.x, this.y, u.x, u.y) < u.radius + this.hitRadius) {
        this.hitSet.add(u.uid);
        dealDamage(game, this.owner, u, this.dmg, this.type);
        if (this.onHit) this.onHit(game, u);
        if (!this.pierce) { this.done = true; return; }
      }
    }
    if (this.traveled >= this.maxDist || this.x < 0 || this.y < 0 || this.x > WORLD || this.y > WORLD) {
      this.done = true;
    }
  }
}

// ------------------------------------------------------------
// persistent ground zone (wells, storms, sanctuaries)
// ------------------------------------------------------------
class Zone {
  constructor(o) {
    this.x = o.x; this.y = o.y; this.radius = o.radius;
    this.team = o.team; this.owner = o.owner;
    this.duration = o.duration;
    this.tickRate = o.tickRate || 0.5;
    this.tickTimer = 0;
    this.color = o.color;
    this.onTick = o.onTick;   // (game, zone)
    this.done = false;
  }
  update(game, dt) {
    this.duration -= dt;
    this.tickTimer -= dt;
    if (this.tickTimer <= 0) { this.tickTimer = this.tickRate; if (this.onTick) this.onTick(game, this); }
    if (this.duration <= 0) this.done = true;
  }
  unitsInside(game, enemiesOf) {
    const out = [];
    for (const u of game.allTargets(enemiesOf)) {
      if (!u.dead && dist(this.x, this.y, u.x, u.y) < this.radius + u.radius) out.push(u);
    }
    return out;
  }
  alliesInside(game) {
    const out = [];
    for (const u of game.heroes) {
      if (u.team === this.team && !u.dead && dist(this.x, this.y, u.x, u.y) < this.radius + u.radius) out.push(u);
    }
    return out;
  }
}

// ------------------------------------------------------------
// damage & death
// ------------------------------------------------------------
function dealDamage(game, source, target, amount, type) {
  if (!target || target.dead || game.over) return;
  let dmg = amount;
  if (type === 'physical') dmg *= 100 / (100 + Math.max(0, target.armor));
  else if (type === 'magic') dmg *= 100 / (100 + Math.max(0, target.mr));
  dmg = Math.max(1, dmg);

  // thorns (Bram's bastion)
  if (target.thorns > 0 && source && source.alive && source.kind !== 'tower') {
    const back = amount * target.thorns;
    source.hp -= back * 100 / (100 + Math.max(0, source.armor));
    if (source.hp <= 0) onUnitDeath(game, source, target);
  }

  if (target.shield > 0) {
    const absorbed = Math.min(target.shield, dmg);
    target.shield -= absorbed;
    dmg -= absorbed;
  }
  target.hp -= dmg;

  if (source && source.lifesteal > 0 && type === 'physical') {
    source.hp = Math.min(source.maxHp, source.hp + dmg * source.lifesteal);
  }
  if (target.kind === 'hero') {
    target.interruptRecall();
    if (source && source.kind === 'hero') {
      target.recentDamagers = target.recentDamagers.filter(d => d.unit !== source);
      target.recentDamagers.push({ unit: source, t: game.time });
    }
  }
  if (dmg >= 1 && (target.kind === 'hero' || target.kind === 'tower' || target.kind === 'core' || Math.random() < 0.35)) {
    game.addEffect({
      type: 'dmgtext', x: target.x + (Math.random() - 0.5) * 24, y: target.y - target.radius - 8,
      text: String(Math.round(dmg)), ttl: 0.8,
      color: type === 'magic' ? '#c084fc' : (type === 'true' ? '#f8fafc' : '#fca5a5'),
    });
  }
  // jungle monsters fight back
  if (target.kind === 'jungle' && !target.attackTarget && source && source.alive) {
    target.attackTarget = source;
  }
  if (target.hp <= 0) onUnitDeath(game, target, source);
}

function heal(game, target, amount) {
  if (target.dead) return;
  const before = target.hp;
  target.hp = Math.min(target.maxHp, target.hp + amount);
  const gained = target.hp - before;
  if (gained > 5) {
    game.addEffect({ type: 'dmgtext', x: target.x, y: target.y - target.radius - 10, text: '+' + Math.round(gained), ttl: 0.8, color: '#4ade80' });
  }
}

function onUnitDeath(game, unit, killer) {
  if (unit.dead) return;
  unit.dead = true;
  unit.hp = 0;
  game.addEffect({ type: 'ring', x: unit.x, y: unit.y, r: unit.radius, r2: unit.radius + 40, ttl: 0.4, color: '#fff' });

  const killerHero = killer && killer.kind === 'hero' ? killer : null;

  if (unit.kind === 'minion' || unit.kind === 'jungle') {
    if (killerHero) killerHero.gold += unit.gold;
    // xp to nearby enemy-of-unit heroes
    for (const h of game.heroes) {
      if (h.dead || (unit.team !== -1 && h.team === unit.team)) continue;
      if (distU(h, unit) < XP_SHARE_RANGE) h.addXp(game, unit.xp);
    }
    if (unit.kind === 'jungle') game.scheduleCampRespawn(unit.camp);
  } else if (unit.kind === 'hero') {
    unit.deaths++;
    unit.respawnTimer = RESPAWN_BASE + RESPAWN_PER_LEVEL * unit.level;
    unit.recallTimer = 0;
    let killerName = 'a Turret';
    if (killer && killer.kind === 'minion') killerName = 'Minions';
    if (killer && killer.kind === 'jungle') killerName = 'the Jungle';
    if (killerHero) {
      killerHero.kills++;
      killerHero.gold += KILL_GOLD + unit.level * 12;
      killerHero.addXp(game, 90 + unit.level * 16);
      killerName = killerHero.def.name;
      for (const d of unit.recentDamagers) {
        if (d.unit !== killerHero && d.unit.alive) { d.unit.assists++; d.unit.gold += ASSIST_GOLD; }
      }
    }
    unit.recentDamagers = [];
    game.kills[1 - unit.team]++;
    game.ui.killFeed(killerName, unit.def.name, killerHero ? killerHero.team : 1 - unit.team);
    if (unit.isPlayer) game.ui.flash('You died — respawning…');
    if (killerHero && killerHero.isPlayer) game.ui.flash('You slew ' + unit.def.name + '!  +' + (KILL_GOLD + unit.level * 12) + 'g');
  } else if (unit.kind === 'tower') {
    for (const h of game.heroes) if (h.team !== unit.team) h.gold += 60;
    if (killerHero) killerHero.gold += unit.goldReward;
    game.ui.flash((unit.team === game.playerTeam ? 'Your team lost a turret!' : 'Enemy turret destroyed!  +60g'));
  } else if (unit.kind === 'core') {
    game.endGame(1 - unit.team);
  }
}
