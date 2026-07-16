// ============================================================
// VOID ARENA — Entities: units, combat, projectiles, ability API
// ============================================================

let UID = 1;

function dist(a, b) { return Math.hypot(b.x - a.x, b.y - a.y); }
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function lerp(a, b, t) { return a + (b - a) * t; }

function inBushIdx(u) {
  for (let i = 0; i < BUSHES.length; i++) {
    const b = BUSHES[i];
    if (u.x > b.x && u.x < b.x + b.w && u.y > b.y && u.y < b.y + b.h) return i;
  }
  return -1;
}

// Fog of war: a hero is only visible to the enemy team if one of that team's
// units (hero/tower/core/minion) currently has it within vision range, and a
// hero standing in a bush is invisible to anyone outside that same bush unless
// they're right on top of it. `viewer` may be a unit (its .team is used) or
// a team string directly.
function isVisibleTo(target, viewer) {
  const viewerTeam = viewer.team || viewer;
  if (target.team === viewerTeam) return true;
  if (target.type !== 'hero') return true;
  const circles = G.vision && G.vision[viewerTeam];
  if (!circles) return true; // fog not initialized yet (e.g. pre-match)
  const bi = inBushIdx(target);
  for (const c of circles) {
    if (bi !== -1) {
      if (inBushIdx(c) === bi || dist(target, c) < 180) return true;
    } else if (dist(target, c) < c.r) {
      return true;
    }
  }
  return false;
}

// team-wide vision circles, recomputed once per simulation tick
function computeVisionCircles(team) {
  const out = [];
  for (const u of G.units) {
    if (u.team !== team || u.dead) continue;
    if (u.type === 'hero') out.push({ x:u.x, y:u.y, r:CFG.visionHero });
    else if (u.type === 'tower') out.push({ x:u.x, y:u.y, r:CFG.visionTower });
    else if (u.type === 'core') out.push({ x:u.x, y:u.y, r:CFG.visionCore });
    else if (u.type === 'minion') out.push({ x:u.x, y:u.y, r:CFG.visionMinion });
  }
  return out;
}

// ---------------- Base unit ----------------
class Unit {
  constructor(o) {
    this.id = UID++;
    this.team = 'blue';
    this.type = 'unit';
    this.x = 0; this.y = 0;
    this.radius = 20;
    this.hp = 100; this.hpMaxBase = 100;
    this.mana = 0; this.manaMax = 0;
    this.adBase = 10; this.spBase = 0;
    this.armorBase = 0; this.mrBase = 0;
    this.msBase = 200;
    this.atkRange = 90; this.atkCd = 1.1; this.atkTimer = 0;
    this.dead = false;
    this.buffs = [];
    this.facing = 0;
    this.target = null;
    this.recentDamagers = {}; // heroId -> time
    this.melee = true;
    this.level = 1;
    Object.assign(this, o);
    // effective stats (recomputed each frame)
    this.ad = this.adBase; this.sp = this.spBase;
    this.armor = this.armorBase; this.mr = this.mrBase;
    this.ms = this.msBase;
    this.asMult = 1; this.slowMult = 1; this.stunned = false;
    this.lifesteal = 0;
  }

  alive() { return !this.dead; }
  hpMax() { return this.hpMaxBase; }
  shieldTotal() { return this.buffs.reduce((s, b) => s + (b.shieldLeft || 0), 0); }

  hasBuff(id) { return this.buffs.some(b => b.id === id); }
  removeBuff(id) { this.buffs = this.buffs.filter(b => b.id !== id); }
  addBuff(b) {
    b.t = b.dur;
    if (b.shield) b.shieldLeft = b.shield;
    const ex = this.buffs.find(x => x.id === b.id);
    if (ex) Object.assign(ex, b); else this.buffs.push(b);
  }

  updateBuffs(dt) {
    this.stunned = false;
    this.slowMult = 1;
    let msMult = 1, asMult = 1, adMult = 1;
    let armorB = 0, mrB = 0, adB = 0, spB = 0;
    for (let i = this.buffs.length - 1; i >= 0; i--) {
      const b = this.buffs[i];
      b.t -= dt;
      if (b.t <= 0) { this.buffs.splice(i, 1); continue; }
      if (b.stun) this.stunned = true;
      if (b.slow) this.slowMult = Math.min(this.slowMult, 1 - b.slow);
      if (b.msMult) msMult *= b.msMult;
      if (b.asMult) asMult *= b.asMult;
      if (b.adMult) adMult *= b.adMult;
      if (b.armor) armorB += b.armor;
      if (b.mr) mrB += b.mr;
      if (b.ad) adB += b.ad;
      if (b.sp) spB += b.sp;
      if (b.dot) {
        b._acc = (b._acc || 0) + dt;
        if (b._acc >= 0.5) {
          b._acc -= 0.5;
          dealDamage(b.dot.src, this, b.dot.dps * 0.5, b.dot.type, { noText: false });
        }
      }
    }
    this._buffMods = { msMult, asMult, adMult, armorB, mrB, adB, spB };
  }

  computeStats() {
    const m = this._buffMods || { msMult:1, asMult:1, adMult:1, armorB:0, mrB:0, adB:0, spB:0 };
    this.ad = (this.adBase + m.adB) * m.adMult;
    this.sp = this.spBase + m.spB;
    this.armor = this.armorBase + m.armorB;
    this.mr = this.mrBase + m.mrB;
    this.ms = this.msBase * m.msMult * this.slowMult;
    this.asMult = m.asMult;
  }

  moveToward(x, y, dt) {
    if (this.stunned || this.dead) return false;
    const dx = x - this.x, dy = y - this.y;
    const d = Math.hypot(dx, dy);
    if (d < 3) return true;
    const step = Math.min(d, this.ms * dt);
    this.x += dx / d * step;
    this.y += dy / d * step;
    this.facing = Math.atan2(dy, dx);
    this.moving = true;
    if (this.recallT !== undefined && this.recallT > 0) this.recallT = 0; // moving cancels recall
    return d - step < 3;
  }

  tryAttack(t, dt) {
    if (this.stunned || this.dead || !t || t.dead) return;
    const d = dist(this, t) - t.radius;
    this.facing = Math.atan2(t.y - this.y, t.x - this.x);
    if (this.atkTimer > 0) return;
    if (d > this.atkRange) return;
    this.atkTimer = this.atkCd / this.asMult;
    if (this.melee) {
      basicHit(this, t);
      FX.push({ type:'slash', x:t.x, y:t.y, dur:0.15, color:'#ffffff', ang:this.facing, t:0 });
    } else {
      G.projectiles.push({
        x: this.x, y: this.y, homing: t, speed: 850, size: 8,
        color: this.type === 'tower' ? '#ffffff' : (TEAM_COLOR[this.team] || '#fff'),
        src: this, basic: true,
      });
    }
    if (this.type === 'hero' && this === G.player) Sfx.play('attack');
  }
}

function basicHit(src, t) {
  const dmg = dealDamage(src, t, src.ad, 'phys', { isBasic: true });
  if (src.type === 'hero') {
    if (src.lifesteal > 0 && dmg > 0) healUnit(src, src, dmg * src.lifesteal);
    if (src.def.onBasicHit && t.alive !== undefined) src.def.onBasicHit(src, t, dmg);
  }
}

// ---------------- Damage / heal ----------------
// returns damage dealt (0 if invulnerable); sets ._killed side info via Game.onDeath
function dealDamage(src, tgt, amount, dtype, opts = {}) {
  if (!tgt || tgt.dead || amount <= 0) return 0;
  if (tgt.invulnerable) {
    if (src === G.player) FX.push({ type:'text', x:tgt.x, y:tgt.y - tgt.radius, text:'IMMUNE', color:'#aaa', dur:0.8, t:0 });
    return 0;
  }
  let amt = amount;
  if (tgt.hasBuff('voidmark')) amt *= 1.12;
  if (dtype === 'phys') amt *= 100 / (100 + Math.max(0, tgt.armor));
  else if (dtype === 'magic') amt *= 100 / (100 + Math.max(0, tgt.mr));

  // shields absorb first
  for (const b of tgt.buffs) {
    if (b.shieldLeft > 0 && amt > 0) {
      const take = Math.min(b.shieldLeft, amt);
      b.shieldLeft -= take; amt -= take;
    }
  }

  tgt.hp -= amt;
  tgt._hitT = G.time;   // white hit-flash for the renderer
  if (tgt.recallT > 0) tgt.recallT = 0;

  const credit = src && src.type === 'hero' ? src : (src && src.owner && src.owner.type === 'hero' ? src.owner : null);
  if (credit && tgt.type === 'hero') tgt.recentDamagers[credit.id] = G.time;

  // tower protection: attacking a hero near their tower draws tower aggro
  if (credit && tgt.type === 'hero') {
    for (const tw of G.towers) {
      if (tw.team === tgt.team && !tw.dead && dist(tw, credit) < tw.atkRange) tw.target = credit;
    }
  }

  if (!opts.noText && credit && (credit === G.player || tgt === G.player)) {
    FX.push({ type:'text', x:tgt.x + (Math.random()*30-15), y:tgt.y - tgt.radius - 8,
      text: String(Math.round(amt)),
      color: dtype === 'phys' ? '#ffcf6b' : dtype === 'magic' ? '#b79bff' : '#fff',
      big: amt > 150,
      dur:0.7, t:0 });
  }
  if (tgt === G.player && amt > 0) UI.hitShake = Math.min(1, (UI.hitShake || 0) + Math.min(0.5, amt / 300));

  if (tgt.hp <= 0) {
    Game.onDeath(tgt, credit || src);
    return amt || 1;
  }
  return amt;
}

function healUnit(src, tgt, amount) {
  if (!tgt || tgt.dead) return;
  const before = tgt.hp;
  tgt.hp = Math.min(tgt.hpMax(), tgt.hp + amount);
  const healed = tgt.hp - before;
  if (healed > 2 && (src === G.player || tgt === G.player)) {
    FX.push({ type:'text', x:tgt.x, y:tgt.y - tgt.radius - 8, text:'+' + Math.round(healed), color:'#7dff9b', dur:0.7, t:0 });
  }
}

// ---------------- Ability API (used by hero skill definitions) ----------------
const A = {
  damage: (h, u, amt, type) => {
    const hpBefore = u.hp;
    dealDamage(h, u, amt * (h && h.castMult ? h.castMult : 1), type);
    return u.dead && hpBefore > 0;
  },
  heal: (h, u, amt) => healUnit(h, u, amt),
  slow: (u, pct, dur) => u.addBuff({ id:'slow' + Math.floor(Math.random()*1e6), dur, slow:pct }),
  stun: (u, dur) => u.addBuff({ id:'stun' + Math.floor(Math.random()*1e6), dur, stun:true }),
  mark: (u, dur) => u.addBuff({ id:'voidmark', dur }),
  fx: (e) => { e.t = 0; FX.push(e); },

  enemiesIn(h, x, y, r) {
    return G.units.filter(u => u.team !== h.team && !u.dead && !u.untargetable && dist(u, {x, y}) < r + u.radius);
  },
  alliesIn(h, x, y, r) {
    return G.units.filter(u => u.team === h.team && u.type === 'hero' && !u.dead && dist(u, {x, y}) < r + u.radius);
  },
  aoe(h, x, y, r, fn) { for (const u of A.enemiesIn(h, x, y, r)) fn(u); },
  aoeAlly(h, x, y, r, fn) { for (const u of A.alliesIn(h, x, y, r)) fn(u); },

  cone(h, aim, range, arc, fn) {
    const a0 = Math.atan2(aim.dy, aim.dx);
    for (const u of A.enemiesIn(h, h.x, h.y, range)) {
      const a = Math.atan2(u.y - h.y, u.x - h.x);
      let da = Math.abs(a - a0); if (da > Math.PI) da = 2*Math.PI - da;
      if (da < arc) fn(u);
    }
  },

  // nearest enemy hero near the aim point (for targeted skills)
  pickHero(h, aim, range) {
    let best = null, bd = 1e9;
    for (const u of G.units) {
      if (u.team === h.team || u.dead || u.type !== 'hero') continue;
      if (!isVisibleTo(u, h)) continue;
      const d = dist(h, u);
      if (d > range) continue;
      // prefer units along aim direction
      const a = Math.atan2(u.y - h.y, u.x - h.x);
      const a0 = Math.atan2(aim.dy, aim.dx);
      let da = Math.abs(a - a0); if (da > Math.PI) da = 2*Math.PI - da;
      const score = d + da * 200;
      if (score < bd) { bd = score; best = u; }
    }
    return best;
  },
  pickAny(h, aim, range) {
    return A.pickHero(h, aim, range) || (() => {
      let best = null, bd = 1e9;
      for (const u of G.units) {
        if (u.team === h.team || u.dead || u.untargetable) continue;
        const d = dist(h, u);
        if (d < range && d < bd) { bd = d; best = u; }
      }
      return best;
    })();
  },

  dash(h, aim, distance, speed, onPass) {
    h.dash = { dx: aim.dx, dy: aim.dy, left: distance, speed, onPass, hit: new Set() };
  },
  leap(h, tx, ty, maxRange, onLand) {
    const d = dist(h, {x:tx, y:ty});
    const r = Math.min(d, maxRange);
    const a = Math.atan2(ty - h.y, tx - h.x);
    h.leap = { tx: h.x + Math.cos(a)*r, ty: h.y + Math.sin(a)*r, speed: 1100, onLand };
  },

  shot(h, aim, o) {
    G.projectiles.push({
      x: h.x, y: h.y, dx: aim.dx, dy: aim.dy,
      speed: o.speed, size: o.size || 12, range: o.range, traveled: 0,
      pierce: !!o.pierce, hit: new Set(), color: o.color || '#fff',
      owner: h, team: h.team, onHitFn: o.onHit, skillshot: true,
    });
  },

  zone(h, x, y, o) {
    G.zones.push({
      x, y, r: o.r, dur: o.dur, t: 0, tick: o.tick || 0.5, acc: 0,
      pull: o.pull || 0, color: o.color || '#fff', team: h.team, owner: h, onTick: o.onTick,
    });
  },
};

// ---------------- Hero ----------------
class Hero extends Unit {
  constructor(def, team, isPlayer) {
    super({ team, type:'hero', radius:26, melee:def.melee, atkRange:def.atkRange, atkCd:def.atkCd });
    this.def = def;
    this.isPlayer = !!isPlayer;
    this.name = def.name;
    this.level = 1; this.xp = 0;
    this.gold = CFG.startGold;
    this.items = [];
    this.buildIdx = 0;
    this.cds = [0, 0, 0];
    this.skillLv = [1, 0, 0];   // S1 learned at spawn; spend points on the rest
    this.skillPoints = 0;
    this.battleSpell = null;    // equipped battle-spell id (set by game.js at spawn)
    this.bsCd = 0;              // battle-spell cooldown remaining
    this.kills = 0; this.deaths = 0; this.assists = 0; this.cs = 0;
    this.streak = 0;
    this.recallT = 0;
    this.respawnT = 0;
    this.moveDir = null;        // {x,y} normalized input (player)
    this.aiT = 0; this.aiState = 'lane'; this.lane = 'mid'; this.wpIdx = 0;
    this.cdr = 0;
    this.applyLevelStats();
    this.hp = this.hpMax(); this.mana = this.manaMax;
    const c = CORES[team];
    this.x = c.x + (Math.random()*120 - 60);
    this.y = c.y + (Math.random()*120 - 60);
  }

  applyLevelStats() {
    const d = this.def, L = this.level - 1;
    this.hpMaxBase = d.hp[0] + d.hp[1]*L + this.itemStat('hp');
    this.manaMax = d.mana[0] + d.mana[1]*L;
    this.adBase = d.ad[0] + d.ad[1]*L + this.itemStat('ad');
    this.spBase = this.itemStat('sp');
    this.armorBase = d.armor[0] + d.armor[1]*L + this.itemStat('armor');
    this.mrBase = d.mr[0] + d.mr[1]*L + this.itemStat('mr');
    this.msBase = d.ms + this.itemStat('ms');
    this.regen = d.regen[0] + d.regen[1]*L + this.itemStat('regen');
    this.lifesteal = this.itemStat('ls');
    this.cdr = Math.min(0.4, this.itemStat('cdr'));
    this.atkCd = d.atkCd / (1 + this.itemStat('as'));
  }

  itemStat(k) { return this.items.reduce((s, it) => s + (it.stat[k] || 0), 0); }

  hpMax() {
    let m = this.hpMaxBase;
    return m;
  }

  gainXp(amt) {
    if (this.level >= CFG.maxLevel) return;
    this.xp += amt;
    while (this.level < CFG.maxLevel && this.xp >= xpToNext(this.level)) {
      this.xp -= xpToNext(this.level);
      this.level++;
      this.skillPoints++;
      const hpFrac = this.hp / this.hpMax();
      this.applyLevelStats();
      this.hp = Math.max(this.hp, this.hpMax() * Math.max(hpFrac, 0.4));
      FX.push({ type:'ring', x:this.x, y:this.y, r0:20, r1:70, dur:0.5, color:'#ffe27d', t:0 });
      if (this.isPlayer) { UI.announce('Level ' + this.level + '!', '#ffe27d'); Sfx.play('level'); }
    }
  }

  skillUnlocked(i) { return this.skillLv[i] > 0; }
  skillReady(i) {
    return this.skillUnlocked(i) && this.cds[i] <= 0 && !this.dead && !this.stunned &&
           this.mana >= this.def.skills[i].mana;
  }

  // MLBB-style leveling: ult caps at 3 and gates on hero level 4/8/12,
  // basic skills cap at 5 and can't outrun your hero level
  canUpgrade(i) {
    if (i === 2) return this.skillLv[2] < 3 && this.level >= 4 + this.skillLv[2] * 4;
    return this.skillLv[i] < 5 && this.skillLv[i] < this.level;
  }

  upgradeSkill(i) {
    if (this.skillPoints <= 0 || !this.canUpgrade(i)) return false;
    this.skillPoints--;
    this.skillLv[i]++;
    if (this.isPlayer) Sfx.play('buy');
    return true;
  }

  cast(i, aim) {
    if (!this.skillReady(i)) return false;
    const sk = this.def.skills[i];
    this.castMult = 1 + 0.12 * (this.skillLv[i] - 1);  // read by A.damage
    const ok = sk.cast(this, aim);
    if (ok === false) return false;
    this.cds[i] = sk.cd * (1 - this.cdr) * (1 - 0.05 * (this.skillLv[i] - 1));
    this.mana -= sk.mana;
    this.recallT = 0;
    if (this.def.onSkillCast) this.def.onSkillCast(this);
    this.facing = Math.atan2(aim.dy, aim.dx);
    return true;
  }

  bsReady() { return !!this.battleSpell && this.bsCd <= 0 && !this.dead && !this.stunned; }

  castBattleSpell(aim) {
    if (!this.bsReady()) return false;
    const sp = battleSpellById(this.battleSpell);
    if (!sp) return false;
    const a = aim || { dx: Math.cos(this.facing), dy: Math.sin(this.facing) };
    if (sp.cast(this, a) === false) return false; // no valid target — not consumed
    this.bsCd = sp.cd * (1 - this.cdr * 0.5);
    this.recallT = 0;
    return true;
  }

  buyItem(item) {
    if (this.items.length >= CFG.maxItems || this.gold < item.cost) return false;
    this.gold -= item.cost;
    this.items.push(item);
    const hpFrac = this.hp / this.hpMax();
    this.applyLevelStats();
    this.hp = this.hpMax() * hpFrac + (item.stat.hp || 0);
    this.hp = Math.min(this.hp, this.hpMax());
    if (this.isPlayer) Sfx.play('buy');
    return true;
  }

  nextBuildItem() {
    const build = this.def.build;
    if (this.buildIdx >= build.length || this.items.length >= CFG.maxItems) return null;
    return itemById(build[this.buildIdx]);
  }

  update(dt) {
    if (this.dead) return;
    this.moving = false;
    this.updateBuffs(dt);
    this.computeStats();
    this.atkTimer = Math.max(0, this.atkTimer - dt);
    for (let i = 0; i < 3; i++) this.cds[i] = Math.max(0, this.cds[i] - dt);
    if (this.bsCd > 0) this.bsCd = Math.max(0, this.bsCd - dt);
    this.gold += CFG.passiveGoldPerSec * dt;

    // Grom passive
    if (this.def.id === 'grom') {
      const low = this.hp < this.hpMax() * 0.4;
      if (low && !this.hasBuff('stonewill')) this.addBuff({ id:'stonewill', dur:0.6, armor:35, mr:35 });
    }

    // regen (+fountain)
    const core = CORES[this.team];
    const atFountain = dist(this, core) < CFG.fountainRadius;
    healUnit(null, this, (this.regen + (atFountain ? this.hpMax()*0.12 : 0)) * dt);
    this.mana = Math.min(this.manaMax, this.mana + (2 + this.level*0.4 + (atFountain ? this.manaMax*0.15 : 0)) * dt);

    // recall channel
    if (this.recallT > 0) {
      this.recallT -= dt;
      if (this.recallT <= 0) {
        this.x = core.x; this.y = core.y;
        FX.push({ type:'ring', x:this.x, y:this.y, r0:10, r1:90, dur:0.5, color:'#7df9ff', t:0 });
        if (this.isPlayer) Sfx.play('recall');
      }
      return; // channeling: no movement/attacks
    }

    // dash
    if (this.dash) {
      const d = this.dash;
      const step = Math.min(d.left, d.speed * dt);
      this.x += d.dx * step; this.y += d.dy * step;
      d.left -= step;
      this.moving = true;
      this.facing = Math.atan2(d.dy, d.dx);
      if (d.onPass) {
        for (const u of G.units) {
          if (u.team === this.team || u.dead || d.hit.has(u.id) || u.untargetable) continue;
          if (dist(this, u) < this.radius + u.radius + 20) { d.hit.add(u.id); d.onPass(u); }
        }
      }
      if (d.left <= 0) this.dash = null;
      return;
    }
    // leap
    if (this.leap) {
      const l = this.leap;
      const dx = l.tx - this.x, dy = l.ty - this.y;
      const dd = Math.hypot(dx, dy);
      const step = l.speed * dt;
      if (dd <= step) { this.x = l.tx; this.y = l.ty; const f = l.onLand; this.leap = null; if (f) f(); }
      else { this.x += dx/dd*step; this.y += dy/dd*step; this.facing = Math.atan2(dy, dx); }
      return;
    }

    if (this.isPlayer) this.playerControl(dt);
    else botUpdate(this, dt);
  }

  playerControl(dt) {
    const inp = Input;
    let mx = 0, my = 0;
    if (inp.joy.active) { mx = inp.joy.dx; my = inp.joy.dy; }
    if (inp.keys['w'] || inp.keys['arrowup']) my -= 1;
    if (inp.keys['s'] || inp.keys['arrowdown']) my += 1;
    if (inp.keys['a'] || inp.keys['arrowleft']) mx -= 1;
    if (inp.keys['d'] || inp.keys['arrowright']) mx += 1;
    const mag = Math.hypot(mx, my);
    if (mag > 0.15 && !this.stunned) {
      mx /= mag; my /= mag;
      this.x += mx * this.ms * dt;
      this.y += my * this.ms * dt;
      this.facing = Math.atan2(my, mx);
      this.recallT = 0;
      this._moving = true;
      this.moving = true;
    } else {
      this._moving = false;
      // idle or attack held: auto-attack nearest visible enemy in range
      const t = nearestAttackTarget(this);
      if (t) this.tryAttack(t, dt);
    }
    if (inp.attackHeld) {
      const t = nearestAttackTarget(this, true);
      if (t && !this._moving) this.tryAttack(t, dt);
      else if (t && this._moving) this.tryAttack(t, dt);
    }
  }

  startRecall() {
    if (this.dead || this.recallT > 0) return;
    this.recallT = CFG.recallTime;
    FX.push({ type:'ring', x:this.x, y:this.y, r0:60, r1:30, dur:CFG.recallTime, color:'#7df9ff', t:0 });
  }
}

function nearestAttackTarget(h, preferHero) {
  let best = null, bd = 1e9;
  const reach = h.atkRange + 60;
  for (const u of G.units) {
    if (u.team === h.team || u.dead || u.untargetable || u.invulnerable) continue;
    if (!isVisibleTo(u, h)) continue;
    const d = dist(h, u) - u.radius;
    if (d > reach) continue;
    let score = d;
    if (preferHero && u.type === 'hero') score -= 500;
    if (u.type === 'hero' && u.hp < u.hpMax() * 0.35) score -= 200;
    if (score < bd) { bd = score; best = u; }
  }
  return best;
}

// ---------------- Minion ----------------
class Minion extends Unit {
  constructor(team, lane, ranged) {
    super({ team, type:'minion', radius: ranged ? 14 : 16, melee: !ranged });
    this.lane = lane;
    this.ranged = ranged;
    const scale = 1 + G.time / 240 * 0.15; // minions slowly get stronger
    this.hpMaxBase = (ranged ? 340 : 480) * scale;
    this.hp = this.hpMaxBase;
    this.adBase = (ranged ? 42 : 34) * scale;
    this.armorBase = 4; this.mrBase = 4;
    this.msBase = 190;
    this.atkRange = ranged ? 280 : 55;
    this.atkCd = ranged ? 1.6 : 1.1;
    const path = LANES[lane];
    this.path = team === 'blue' ? path : [...path].reverse();
    this.wpIdx = 0;
    this.x = this.path[0][0] + (Math.random()*80 - 40);
    this.y = this.path[0][1] + (Math.random()*80 - 40);
  }

  update(dt) {
    if (this.dead) return;
    this.moving = false;
    this.updateBuffs(dt);
    this.computeStats();
    this.atkTimer = Math.max(0, this.atkTimer - dt);

    // acquire target
    if (!this.target || this.target.dead || dist(this, this.target) > 420) {
      this.target = null;
      let bd = 340;
      for (const u of G.units) {
        if (u.team === this.team || u.dead || u.untargetable || u.invulnerable) continue;
        const d = dist(this, u);
        if (d < bd) { bd = d; this.target = u; }
      }
    }

    if (this.target) {
      const d = dist(this, this.target) - this.target.radius;
      if (d > this.atkRange) this.moveToward(this.target.x, this.target.y, dt);
      else this.tryAttack(this.target, dt);
      return;
    }

    // follow lane
    const wp = this.path[Math.min(this.wpIdx, this.path.length - 1)];
    if (this.moveToward(wp[0], wp[1], dt) || dist(this, {x:wp[0], y:wp[1]}) < 60) {
      if (this.wpIdx < this.path.length - 1) this.wpIdx++;
    }
  }
}

// ---------------- Tower ----------------
class Tower extends Unit {
  constructor(spot) {
    super({ team: spot.team, type:'tower', radius:42, melee:false });
    this.lane = spot.lane; this.order = spot.order;
    this.x = spot.x; this.y = spot.y;
    this.hpMaxBase = 3800; this.hp = this.hpMaxBase;
    this.adBase = 190;
    this.armorBase = 20; this.mrBase = 20;
    this.atkRange = 420;
    this.atkCd = 1.0;
    this.invulnerable = false;
  }

  update(dt) {
    if (this.dead) return;
    this.atkTimer = Math.max(0, this.atkTimer - dt);
    // keep current target if valid
    if (this.target && (this.target.dead || dist(this, this.target) > this.atkRange + this.target.radius)) this.target = null;
    if (!this.target) {
      // prefer minions
      let bd = 1e9, best = null;
      for (const u of G.units) {
        if (u.team === this.team || u.dead || u.untargetable) continue;
        const d = dist(this, u) - u.radius;
        if (d > this.atkRange) continue;
        const score = d + (u.type === 'hero' ? 2000 : 0);
        if (score < bd) { bd = score; best = u; }
      }
      this.target = best;
    }
    if (this.target) this.tryAttack(this.target, dt);
  }
}

class Core extends Unit {
  constructor(team) {
    super({ team, type:'core', radius:58, melee:false });
    const c = CORES[team];
    this.x = c.x; this.y = c.y;
    this.hpMaxBase = 5600; this.hp = this.hpMaxBase;
    this.adBase = 160; this.armorBase = 25; this.mrBase = 25;
    this.atkRange = 460; this.atkCd = 0.9;
    this.invulnerable = true;
  }
  update(dt) {
    if (this.dead) return;
    this.atkTimer = Math.max(0, this.atkTimer - dt);
    if (this.target && (this.target.dead || dist(this, this.target) > this.atkRange)) this.target = null;
    if (!this.target) {
      let bd = 1e9, best = null;
      for (const u of G.units) {
        if (u.team === this.team || u.dead || u.untargetable) continue;
        const d = dist(this, u) - u.radius;
        if (d < this.atkRange && d < bd) { bd = d; best = u; }
      }
      this.target = best;
    }
    if (this.target) this.tryAttack(this.target, dt);
  }
}

// ---------------- Jungle ----------------
class JungleMonster extends Unit {
  constructor(camp, boss) {
    super({ team:'jungle', type:'jungle', radius: boss ? 46 : 26, melee:true });
    this.camp = camp;
    this.boss = !!boss;
    this.buffType = camp.buff || null; // buff-camp reward id, if any
    this.homeX = camp.x; this.homeY = camp.y;
    this.x = camp.x; this.y = camp.y;
    const scale = 1 + G.time / 300 * 0.2;
    this.hpMaxBase = (boss ? 4200 : 750) * scale;
    this.hp = this.hpMaxBase;
    this.adBase = (boss ? 130 : 62) * scale;
    this.armorBase = 10; this.mrBase = 10;
    this.msBase = 210;
    this.atkRange = boss ? 90 : 60;
    this.atkCd = 1.2;
  }

  update(dt) {
    if (this.dead) return;
    this.moving = false;
    this.updateBuffs(dt);
    this.computeStats();
    this.atkTimer = Math.max(0, this.atkTimer - dt);

    // aggro on whoever damaged us most recently
    if (!this.target || this.target.dead) {
      this.target = null;
      let latest = -1;
      for (const u of G.units) {
        if (u.type !== 'hero' || u.dead) continue;
        const t = this.recentDamagers[u.id];
        if (t !== undefined && t > latest && G.time - t < 4) { latest = t; this.target = u; }
      }
    }

    const leash = this.boss ? 520 : 420;
    if (this.target) {
      if (dist({x:this.homeX, y:this.homeY}, this.target) > leash) {
        this.target = null; this.recentDamagers = {};
      } else {
        const d = dist(this, this.target) - this.target.radius;
        if (d > this.atkRange) this.moveToward(this.target.x, this.target.y, dt);
        else this.tryAttack(this.target, dt);
        return;
      }
    }
    // return home + regen
    if (dist(this, {x:this.homeX, y:this.homeY}) > 12) this.moveToward(this.homeX, this.homeY, dt);
    else this.hp = Math.min(this.hpMax(), this.hp + this.hpMax()*0.1*dt);
  }
}

// ---------------- Projectiles / zones / effects update ----------------
function updateProjectiles(dt) {
  for (let i = G.projectiles.length - 1; i >= 0; i--) {
    const p = G.projectiles[i];
    if (p.homing) {
      const t = p.homing;
      if (t.dead) { G.projectiles.splice(i, 1); continue; }
      const dx = t.x - p.x, dy = t.y - p.y;
      const d = Math.hypot(dx, dy);
      const step = p.speed * dt;
      if (d <= step + t.radius) {
        basicHit(p.src, t);
        G.projectiles.splice(i, 1);
        continue;
      }
      p.x += dx/d*step; p.y += dy/d*step;
    } else {
      const step = p.speed * dt;
      p.x += p.dx * step; p.y += p.dy * step;
      p.traveled += step;
      let consumed = false;
      for (const u of G.units) {
        if (u.team === p.team || u.dead || u.untargetable || p.hit.has(u.id)) continue;
        if (Math.hypot(u.x - p.x, u.y - p.y) < u.radius + p.size) {
          p.hit.add(u.id);
          p.onHitFn(u);
          if (!p.pierce) { consumed = true; break; }
        }
      }
      if (consumed || p.traveled >= p.range ||
          p.x < 0 || p.y < 0 || p.x > WORLD || p.y > WORLD) {
        G.projectiles.splice(i, 1);
      }
    }
  }
}

function updateZones(dt) {
  for (let i = G.zones.length - 1; i >= 0; i--) {
    const z = G.zones[i];
    z.t += dt; z.acc += dt;
    const affected = G.units.filter(u => u.team !== z.team && u.team !== 'jungle' && !u.dead && !u.untargetable &&
      u.type !== 'tower' && u.type !== 'core' && dist(u, z) < z.r + u.radius);
    if (z.pull) {
      for (const u of affected) {
        const dx = z.x - u.x, dy = z.y - u.y;
        const d = Math.hypot(dx, dy) || 1;
        u.x += dx/d * z.pull * dt;
        u.y += dy/d * z.pull * dt;
      }
    }
    if (z.acc >= z.tick) {
      z.acc -= z.tick;
      for (const u of affected) z.onTick(u);
    }
    if (z.t >= z.dur) G.zones.splice(i, 1);
  }
}

const FX = [];
function updateFX(dt) {
  for (let i = FX.length - 1; i >= 0; i--) {
    const e = FX[i];
    e.t += dt;
    if (e.type === 'text') e.y -= 30 * dt;
    if (e.t >= e.dur) FX.splice(i, 1);
  }
}

// soft unit collision + map bounds + rocks
function resolveCollisions() {
  const movers = G.units.filter(u => !u.dead && u.type !== 'tower' && u.type !== 'core');
  for (const u of movers) {
    u.x = clamp(u.x, u.radius + 10, WORLD - u.radius - 10);
    u.y = clamp(u.y, u.radius + 10, WORLD - u.radius - 10);
    for (const r of ROCKS) {
      const dx = u.x - r.x, dy = u.y - r.y;
      const d = Math.hypot(dx, dy);
      const min = r.r + u.radius;
      if (d < min && d > 0.01) { u.x = r.x + dx/d*min; u.y = r.y + dy/d*min; }
    }
  }
  // pairwise separation (cheap: only minion-vs-minion and hero-vs-minion within same cell skipped; brute force ok at this scale)
  for (let i = 0; i < movers.length; i++) {
    for (let j = i + 1; j < movers.length; j++) {
      const a = movers[i], b = movers[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy);
      const min = (a.radius + b.radius) * 0.8;
      if (d < min && d > 0.01) {
        const push = (min - d) / 2;
        const nx = dx/d, ny = dy/d;
        a.x -= nx*push; a.y -= ny*push;
        b.x += nx*push; b.y += ny*push;
      }
    }
  }
}
