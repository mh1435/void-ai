// ============================================================
// VOID ARENA — Game Data: constants, heroes, items, map layout
// ============================================================

const WORLD = 3200;

const CFG = {
  firstWaveAt: 8,
  waveInterval: 28,
  passiveGoldPerSec: 1.8,
  startGold: 500,
  heroKillGold: 300,
  streakGoldBonus: 60,     // per streak level of victim
  assistGold: 150,
  towerGold: 250,
  towerTeamGold: 100,
  minionGold: 48,
  jungleGold: 85,
  bossGoldEach: 250,
  minionXp: 64,
  heroKillXp: 280,
  jungleXp: 120,
  bossXp: 400,
  xpShareRadius: 700,
  respawnBase: 5,
  respawnPerLevel: 1.7,
  maxLevel: 15,
  maxItems: 6,
  recallTime: 3.5,
  fountainRadius: 300,
  bossSpawnAt: 120,
  bossRespawn: 180,
  jungleRespawn: 55,
  viewHeight: 1000,        // world units visible vertically
  visionHero: 700,
  visionTower: 720,
  visionCore: 620,
  visionMinion: 380,
};

function xpToNext(level) { return 150 + level * 95; }

// ---------------- Map layout ----------------
const CORES = {
  blue: { x: 380, y: 2820 },
  red:  { x: 2820, y: 380 },
};

// Lane waypoint paths, blue core -> red core
const LANES = {
  top: [ [380,2820],[235,2150],[235,1150],[235,235],[1150,235],[2150,235],[2820,380] ],
  mid: [ [380,2820],[1050,2150],[1600,1600],[2150,1050],[2820,380] ],
  bot: [ [380,2820],[1150,2965],[2150,2965],[2965,2965],[2965,2150],[2965,1150],[2820,380] ],
};

// order 0 = outer (must fall before order 1 = inner)
const TOWER_SPOTS = [
  { team:'blue', lane:'top', order:0, x:235,  y:1150 },
  { team:'blue', lane:'top', order:1, x:235,  y:2150 },
  { team:'blue', lane:'mid', order:0, x:1450, y:1750 },
  { team:'blue', lane:'mid', order:1, x:1050, y:2150 },
  { team:'blue', lane:'bot', order:0, x:2150, y:2965 },
  { team:'blue', lane:'bot', order:1, x:1150, y:2965 },
  { team:'red',  lane:'top', order:0, x:1150, y:235 },
  { team:'red',  lane:'top', order:1, x:2150, y:235 },
  { team:'red',  lane:'mid', order:0, x:1750, y:1450 },
  { team:'red',  lane:'mid', order:1, x:2150, y:1050 },
  { team:'red',  lane:'bot', order:0, x:2965, y:2150 },
  { team:'red',  lane:'bot', order:1, x:2965, y:1150 },
];

const BUSHES = [
  { x:1150, y:1350, w:260, h:150 },
  { x:1800, y:1710, w:260, h:150 },
  { x:700,  y:1750, w:150, h:260 },
  { x:2350, y:1200, w:150, h:260 },
  { x:1450, y:600,  w:260, h:140 },
  { x:1500, y:2470, w:260, h:140 },
  { x:520,  y:950,  w:140, h:260 },
  { x:2540, y:2000, w:140, h:260 },
];

const ROCKS = [
  { x:900,  y:1050, r:95 },
  { x:2300, y:2150, r:95 },
  { x:1350, y:2050, r:80 },
  { x:1850, y:1150, r:80 },
  { x:750,  y:2350, r:70 },
  { x:2450, y:850,  r:70 },
];

const CAMPS = [
  { x:820,  y:1780 },
  { x:1500, y:2380 },
  { x:1700, y:820  },
  { x:2380, y:1500 },
];

const BOSS_SPOT = { x:1600, y:1600 };

const TEAM_COLOR   = { blue:'#3fa9ff', red:'#ff4d5e' };
const TEAM_COLOR_D = { blue:'#1c5c94', red:'#8f2430' };

// ---------------- Items ----------------
const ITEMS = [
  { id:'boots',    name:'Swiftwind Boots',   cost:500,  icon:'B', stat:{ms:45},                 desc:'+45 Move Speed' },
  { id:'blade',    name:'Blade of Fury',     cost:900,  icon:'F', stat:{ad:35},                 desc:'+35 Attack' },
  { id:'bow',      name:'Gale Bow',          cost:850,  icon:'G', stat:{as:0.35},               desc:'+35% Attack Speed' },
  { id:'vamp',     name:'Vampiric Edge',     cost:1200, icon:'V', stat:{ad:25, ls:0.12},        desc:'+25 Attack, +12% Lifesteal' },
  { id:'plate',    name:'Titan Plate',       cost:1000, icon:'T', stat:{hp:450, armor:25},      desc:'+450 HP, +25 Armor' },
  { id:'heart',    name:'Heartstone',        cost:800,  icon:'H', stat:{hp:350, regen:6},       desc:'+350 HP, +6 HP/s' },
  { id:'orb',      name:'Arcane Orb',        cost:900,  icon:'O', stat:{sp:55},                 desc:'+55 Skill Power' },
  { id:'staff',    name:'Warlock Staff',     cost:1400, icon:'W', stat:{sp:85, cdr:0.10},       desc:'+85 Skill Power, +10% CDR' },
  { id:'edge',     name:"Executioner's Might",cost:1600,icon:'E', stat:{ad:45, hp:300},         desc:'+45 Attack, +300 HP' },
  { id:'aegis',    name:'Aegis Ward',        cost:1100, icon:'A', stat:{mr:30, hp:300},         desc:'+30 Magic Res, +300 HP' },
];
function itemById(id){ return ITEMS.find(i => i.id === id); }

// ---------------- Heroes ----------------
// stat arrays are [base, perLevel]
const HEROES = [
{
  id:'kael', name:'Kael', title:'the Ashblade', role:'Assassin', color:'#ff6a3d',
  melee:true, atkRange:100, atkCd:1.0,
  hp:[640,96], mana:[300,34], ad:[66,7.2], sp:0, armor:[16,2.4], mr:[12,1.8], ms:250, regen:[1.8,0.3],
  build:['boots','blade','vamp','edge','plate','edge'],
  passive:'Ember Brand — every 3rd basic attack burns for bonus magic damage (35% AD + 30% SP).',
  skills:[
    { name:'Flame Dash', icon:'➤', cd:8, mana:45, range:340,
      desc:'Dash forward, burning enemies in your path.',
      cast(h,aim){
        A.dash(h, aim, 340, 1400, (u)=>{
          A.damage(h, u, 90 + h.level*18 + h.sp*0.6, 'magic');
        });
        A.fx({type:'slash', x:h.x, y:h.y, dur:0.25, color:'#ff8a4d', ang:Math.atan2(aim.dy,aim.dx)});
        Sfx.play('dash');
      }},
    { name:'Cinder Slash', icon:'⚔', cd:6, mana:50, range:200,
      desc:'Slash a cone, damaging and slowing enemies.',
      cast(h,aim){
        A.cone(h, aim, 210, 1.1, (u)=>{
          A.damage(h, u, 70 + h.level*15 + h.ad*0.8, 'phys');
          A.slow(u, 0.4, 1.5);
        });
        A.fx({type:'slash', x:h.x, y:h.y, dur:0.3, color:'#ffd24d', ang:Math.atan2(aim.dy,aim.dx)});
        Sfx.play('skill');
      }},
    { name:'Ember Execution', icon:'☠', cd:34, mana:110, range:520,
      desc:'Blink to a hero and strike a lethal blow. Kills refund 60% cooldown.',
      cast(h,aim){
        const t = A.pickHero(h, aim, 520);
        if (!t) return false;
        h.x = t.x - aim.dx*70; h.y = t.y - aim.dy*70;
        A.fx({type:'ring', x:t.x, y:t.y, r0:10, r1:120, dur:0.35, color:'#ff5c33'});
        const killed = A.damage(h, t, 180 + h.level*28 + h.ad*1.3, 'phys');
        if (killed) h.cds[2] *= 0.4;
        Sfx.play('ult');
      }},
  ],
  onBasicHit(h,t){
    h._brand = (h._brand||0) + 1;
    if (h._brand >= 3) {
      h._brand = 0;
      A.damage(h, t, h.ad*0.35 + h.sp*0.3, 'magic');
      A.fx({type:'flash', x:t.x, y:t.y, r0:26, dur:0.2, color:'#ff8a4d'});
    }
  },
},
{
  id:'nyra', name:'Nyra', title:'Storm Weaver', role:'Mage', color:'#7f7bff',
  melee:false, atkRange:430, atkCd:1.15,
  hp:[560,78], mana:[440,52], ad:[52,4.5], sp:0, armor:[13,1.9], mr:[16,2.2], ms:238, regen:[1.4,0.22],
  build:['orb','boots','staff','orb','aegis','staff'],
  passive:'Charged Air — after casting a skill, your next basic attack within 4s deals bonus magic damage.',
  skills:[
    { name:'Arc Bolt', icon:'⚡', cd:5, mana:55, range:750,
      desc:'Fire a lightning bolt that damages and briefly slows the first enemy hit.',
      cast(h,aim){
        A.shot(h, aim, { speed:900, range:750, size:14, color:'#9d9bff',
          onHit(u){ A.damage(h, u, 110 + h.level*20 + h.sp*0.85, 'magic'); A.slow(u, 0.3, 1.0); } });
        Sfx.play('bolt');
      }},
    { name:'Static Field', icon:'✵', cd:9, mana:70, range:550,
      desc:'Electrify an area, damaging and slowing enemies inside.',
      cast(h,aim){
        A.zone(h, aim.tx, aim.ty, { r:170, dur:2.5, tick:0.5, color:'#7f7bff',
          onTick(u){ A.damage(h, u, 30 + h.level*6 + h.sp*0.25, 'magic'); A.slow(u, 0.35, 0.6); } });
        Sfx.play('skill');
      }},
    { name:'Tempest', icon:'☄', cd:40, mana:130, range:330,
      desc:'Summon a storm around you: three waves of heavy magic damage.',
      cast(h,aim){
        let wave = 0;
        const id = setInterval(()=>{
          if (h.dead || wave >= 3) { clearInterval(id); return; }
          wave++;
          A.aoe(h, h.x, h.y, 330, (u)=>{
            A.damage(h, u, 90 + h.level*16 + h.sp*0.55, 'magic');
            A.slow(u, 0.3, 0.8);
          });
          A.fx({type:'ring', x:h.x, y:h.y, r0:40, r1:330, dur:0.5, color:'#8f8bff'});
          Sfx.play('ult');
        }, 600);
      }},
  ],
  onSkillCast(h){ h.addBuff({ id:'charged', dur:4 }); },
  onBasicHit(h,t){
    if (h.hasBuff('charged')) {
      h.removeBuff('charged');
      A.damage(h, t, 40 + h.level*8 + h.sp*0.5, 'magic');
      A.fx({type:'flash', x:t.x, y:t.y, r0:30, dur:0.2, color:'#9d9bff'});
    }
  },
},
{
  id:'grom', name:'Grom', title:'the Ironhide', role:'Tank', color:'#8fa64f',
  melee:true, atkRange:110, atkCd:1.2,
  hp:[840,130], mana:[320,36], ad:[60,6], sp:0, armor:[24,3.4], mr:[18,2.6], ms:240, regen:[2.6,0.45],
  build:['plate','boots','heart','aegis','plate','edge'],
  passive:'Stone Will — below 40% HP, gain +35 Armor and Magic Resist.',
  skills:[
    { name:'Seismic Slam', icon:'◉', cd:7, mana:50, range:200,
      desc:'Slam the ground, damaging and slowing nearby enemies.',
      cast(h,aim){
        A.aoe(h, h.x, h.y, 210, (u)=>{
          A.damage(h, u, 80 + h.level*14 + h.hpMax()*0.03, 'phys');
          A.slow(u, 0.35, 1.5);
        });
        A.fx({type:'ring', x:h.x, y:h.y, r0:20, r1:210, dur:0.35, color:'#a8c25c'});
        Sfx.play('slam');
      }},
    { name:'Bulwark', icon:'⛨', cd:12, mana:60, range:0,
      desc:'Raise a shield (scales with max HP) and gain move speed for 2.5s.',
      cast(h,aim){
        h.addBuff({ id:'bulwark', dur:3, shield: 120 + h.level*25 + h.hpMax()*0.12, msMult:1.25 });
        A.fx({type:'ring', x:h.x, y:h.y, r0:60, r1:90, dur:0.4, color:'#cfe8a0'});
        Sfx.play('shield');
      }},
    { name:'Earthbreaker', icon:'⬇', cd:38, mana:120, range:480,
      desc:'Leap to an area, damaging and stunning enemies on impact.',
      cast(h,aim){
        A.leap(h, aim.tx, aim.ty, 480, ()=>{
          A.aoe(h, h.x, h.y, 240, (u)=>{
            A.damage(h, u, 140 + h.level*22 + h.hpMax()*0.05, 'phys');
            A.stun(u, 1.0);
          });
          A.fx({type:'ring', x:h.x, y:h.y, r0:30, r1:240, dur:0.45, color:'#a8c25c'});
          Sfx.play('slam');
        });
      }},
  ],
},
{
  id:'lyra', name:'Lyra', title:'Dawnstrider', role:'Marksman', color:'#ffd166',
  melee:false, atkRange:470, atkCd:1.05,
  hp:[580,82], mana:[300,36], ad:[62,7.8], sp:0, armor:[14,2.0], mr:[12,1.7], ms:242, regen:[1.5,0.25],
  build:['bow','boots','blade','vamp','edge','bow'],
  passive:'Dawn Sight — every 4th basic attack deals +60% AD bonus damage.',
  skills:[
    { name:'Piercing Arrow', icon:'➳', cd:6, mana:50, range:820,
      desc:'Fire an arrow that pierces through all enemies in a line.',
      cast(h,aim){
        A.shot(h, aim, { speed:1000, range:820, size:12, pierce:true, color:'#ffe08a',
          onHit(u){ A.damage(h, u, 90 + h.level*16 + h.ad*0.9, 'phys'); } });
        Sfx.play('bolt');
      }},
    { name:'Swift Step', icon:'⇉', cd:10, mana:45, range:260,
      desc:'Dash and gain +50% attack speed for 3s.',
      cast(h,aim){
        A.dash(h, aim, 260, 1300, null);
        h.addBuff({ id:'swift', dur:3, asMult:1.5 });
        Sfx.play('dash');
      }},
    { name:'Starfall Volley', icon:'☆', cd:42, mana:120, range:750,
      desc:'Rain arrows on an area: four waves of physical damage.',
      cast(h,aim){
        const tx = aim.tx, ty = aim.ty;
        let wave = 0;
        const id = setInterval(()=>{
          if (wave >= 4) { clearInterval(id); return; }
          wave++;
          A.aoe(h, tx, ty, 210, (u)=>{
            A.damage(h, u, 55 + h.level*10 + h.ad*0.45, 'phys');
            A.slow(u, 0.25, 0.5);
          });
          A.fx({type:'ring', x:tx, y:ty, r0:180, r1:210, dur:0.3, color:'#ffd166'});
          Sfx.play('bolt');
        }, 450);
      }},
  ],
  onBasicHit(h,t){
    h._dawn = (h._dawn||0) + 1;
    if (h._dawn >= 4) {
      h._dawn = 0;
      A.damage(h, t, h.ad*0.6, 'phys');
      A.fx({type:'flash', x:t.x, y:t.y, r0:28, dur:0.2, color:'#ffd166'});
    }
  },
},
{
  id:'vex', name:'Vex', title:'the Void Caller', role:'Support', color:'#c77dff',
  melee:false, atkRange:420, atkCd:1.2,
  hp:[600,84], mana:[420,50], ad:[50,4.2], sp:0, armor:[15,2.1], mr:[16,2.3], ms:240, regen:[1.6,0.28],
  build:['orb','boots','staff','heart','aegis','staff'],
  passive:'Void Mark — your skills mark enemies for 4s; marked enemies take +12% damage from all sources.',
  skills:[
    { name:'Void Pulse', icon:'◈', cd:7, mana:60, range:600,
      desc:'Detonate void energy: damages enemies and heals allies in the area.',
      cast(h,aim){
        A.aoe(h, aim.tx, aim.ty, 180, (u)=>{
          A.damage(h, u, 85 + h.level*14 + h.sp*0.6, 'magic');
          A.mark(u, 4);
        });
        A.aoeAlly(h, aim.tx, aim.ty, 180, (u)=>{
          A.heal(h, u, 60 + h.level*12 + h.sp*0.5);
        });
        A.fx({type:'ring', x:aim.tx, y:aim.ty, r0:20, r1:180, dur:0.4, color:'#c77dff'});
        Sfx.play('skill');
      }},
    { name:'Gravity Well', icon:'◎', cd:11, mana:75, range:550,
      desc:'Create a well that slows enemies and drags them toward its center.',
      cast(h,aim){
        A.zone(h, aim.tx, aim.ty, { r:190, dur:2.2, tick:0.5, pull:110, color:'#9d4edd',
          onTick(u){ A.damage(h, u, 20 + h.level*4 + h.sp*0.2, 'magic'); A.slow(u, 0.5, 0.6); A.mark(u, 4); } });
        Sfx.play('skill');
      }},
    { name:'Rift Guard', icon:'✦', cd:45, mana:130, range:0,
      desc:'Shield all nearby allies and grant them +30% move speed for 3s.',
      cast(h,aim){
        A.aoeAlly(h, h.x, h.y, 380, (u)=>{
          u.addBuff({ id:'rift', dur:3, shield: 150 + h.level*20 + h.sp*0.8, msMult:1.3 });
          A.fx({type:'ring', x:u.x, y:u.y, r0:30, r1:60, dur:0.4, color:'#e0aaff'});
        });
        Sfx.play('ult');
      }},
  ],
},
{
  id:'thane', name:'Thane', title:'Wolfheart', role:'Fighter', color:'#6ee7b7',
  melee:true, atkRange:105, atkCd:1.05,
  hp:[720,110], mana:[310,36], ad:[64,7], sp:0, armor:[19,2.8], mr:[14,2.1], ms:248, regen:[2.2,0.4],
  build:['blade','boots','vamp','plate','edge','heart'],
  passive:'Feral Hunger — basic attacks heal for 12% of damage dealt.',
  skills:[
    { name:'Lunge', icon:'⇒', cd:7, mana:40, range:300,
      desc:'Lunge forward, clawing enemies in your path.',
      cast(h,aim){
        A.dash(h, aim, 300, 1300, (u)=>{
          A.damage(h, u, 80 + h.level*14 + h.ad*0.7, 'phys');
        });
        Sfx.play('dash');
      }},
    { name:'Rending Claws', icon:'❈', cd:8, mana:55, range:220,
      desc:'Rend the nearest enemy: heavy bleed over 3s and a slow.',
      cast(h,aim){
        const t = A.pickAny(h, aim, 240);
        if (!t) return false;
        A.damage(h, t, 50 + h.level*8 + h.ad*0.4, 'phys');
        t.addBuff({ id:'bleed', dur:3, dot:{ dps: 25 + h.level*6 + h.ad*0.25, type:'phys', src:h } });
        A.slow(t, 0.25, 2);
        A.fx({type:'slash', x:t.x, y:t.y, dur:0.3, color:'#6ee7b7', ang:Math.random()*6.28});
        Sfx.play('skill');
      }},
    { name:'Feral Rage', icon:'♛', cd:40, mana:110, range:0,
      desc:'Unleash the wolf: heal instantly, +40% AD, +25% speed, +30 Armor for 6s.',
      cast(h,aim){
        A.heal(h, h, 150 + h.level*25);
        h.addBuff({ id:'rage', dur:6, adMult:1.4, msMult:1.25, armor:30 });
        A.fx({type:'ring', x:h.x, y:h.y, r0:30, r1:140, dur:0.5, color:'#6ee7b7'});
        Sfx.play('ult');
      }},
  ],
  onBasicHit(h,t,dmg){ A.heal(h, h, dmg*0.12); },
},
];

function heroById(id){ return HEROES.find(h => h.id === id); }

const HERO_INITIAL = { kael:'K', nyra:'N', grom:'G', lyra:'L', vex:'V', thane:'T' };
