// ============================================================
// VOID LEGENDS — config, constants & static data
// ============================================================
'use strict';

const WORLD = 3000;                 // world is WORLD x WORLD px
const TEAM_BLUE = 0;
const TEAM_RED = 1;
const TEAM_COLORS  = ['#4da3ff', '#ff5a5a'];
const TEAM_COLORS_DARK = ['#1d4ed8', '#b91c1c'];
const TEAM_NAMES   = ['Azure', 'Crimson'];

const BASE_POS = [{ x: 300, y: 2700 }, { x: 2700, y: 300 }];

// ---------- small math helpers ----------
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function dist(ax, ay, bx, by) { const dx = bx - ax, dy = by - ay; return Math.hypot(dx, dy); }
function distU(a, b) { return dist(a.x, a.y, b.x, b.y); }
function lerp(a, b, t) { return a + (b - a) * t; }
function norm(dx, dy) {
  const l = Math.hypot(dx, dy);
  if (l < 0.0001) return { x: 0, y: 0 };
  return { x: dx / l, y: dy / l };
}
function fmtTime(t) {
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

// ---------- lanes (waypoints from BLUE base to RED base) ----------
const LANES = {
  top: [
    [300, 2700], [330, 2250], [300, 1500], [330, 750],
    [430, 430],
    [750, 330], [1500, 300], [2250, 330], [2700, 300],
  ],
  mid: [
    [300, 2700], [700, 2300], [1100, 1900], [1500, 1500],
    [1900, 1100], [2300, 700], [2700, 300],
  ],
  bot: [
    [300, 2700], [750, 2670], [1500, 2700], [2250, 2670],
    [2570, 2570],
    [2670, 2250], [2700, 1500], [2670, 750], [2700, 300],
  ],
};
const LANE_NAMES = ['top', 'mid', 'bot'];

// ---------- towers ----------
// tier 1 = outer, tier 2 = inner, tier 3 = base guardian
const TOWER_DEFS = [
  // blue
  { team: TEAM_BLUE, lane: 'top', tier: 1, x: 300,  y: 1180 },
  { team: TEAM_BLUE, lane: 'top', tier: 2, x: 330,  y: 1980 },
  { team: TEAM_BLUE, lane: 'mid', tier: 1, x: 1180, y: 1820 },
  { team: TEAM_BLUE, lane: 'mid', tier: 2, x: 780,  y: 2220 },
  { team: TEAM_BLUE, lane: 'bot', tier: 1, x: 1820, y: 2670 },
  { team: TEAM_BLUE, lane: 'bot', tier: 2, x: 1020, y: 2680 },
  { team: TEAM_BLUE, lane: 'mid', tier: 3, x: 500,  y: 2500 },
  // red (mirror across centre)
  { team: TEAM_RED, lane: 'bot', tier: 1, x: 2700, y: 1820 },
  { team: TEAM_RED, lane: 'bot', tier: 2, x: 2670, y: 1020 },
  { team: TEAM_RED, lane: 'mid', tier: 1, x: 1820, y: 1180 },
  { team: TEAM_RED, lane: 'mid', tier: 2, x: 2220, y: 780 },
  { team: TEAM_RED, lane: 'top', tier: 1, x: 1180, y: 330 },
  { team: TEAM_RED, lane: 'top', tier: 2, x: 1980, y: 320 },
  { team: TEAM_RED, lane: 'mid', tier: 3, x: 2500, y: 500 },
];

const TOWER_STATS = {
  1: { hp: 3400, ad: 190, range: 400, atkSpd: 0.8, radius: 42, gold: 150 },
  2: { hp: 3900, ad: 220, range: 400, atkSpd: 0.8, radius: 42, gold: 180 },
  3: { hp: 4400, ad: 260, range: 430, atkSpd: 0.9, radius: 46, gold: 220 },
};
const CORE_HP = 5600;
const CORE_RADIUS = 66;

// ---------- jungle camps ----------
const JUNGLE_CAMPS = [
  { x: 1000, y: 1560 }, { x: 1560, y: 2130 },   // blue side
  { x: 2000, y: 1440 }, { x: 1440, y: 870 },    // red side
];
const JUNGLE_STATS = {
  hp: 850, hpPerMin: 90, ad: 55, range: 70, atkSpd: 0.8,
  speed: 140, radius: 22, gold: 55, xp: 60, respawn: 45, leash: 320,
};

// ---------- minions ----------
const WAVE_INTERVAL = 30;      // seconds between waves
const FIRST_WAVE_AT = 3;
const MINION_STATS = {
  melee:  { hp: 500, hpPerMin: 28, ad: 44, adPerMin: 3, range: 60,  atkSpd: 1.0, speed: 150, radius: 14, gold: 24, xp: 34 },
  ranged: { hp: 330, hpPerMin: 20, ad: 50, adPerMin: 4, range: 270, atkSpd: 0.9, speed: 150, radius: 12, gold: 30, xp: 34 },
};

// ---------- economy / xp ----------
const PASSIVE_GOLD_PER_SEC = 1.4;
const START_GOLD = 400;
const KILL_GOLD = 250;
const ASSIST_GOLD = 90;
const MAX_LEVEL = 15;
const XP_TABLE = (() => {          // cumulative xp needed to reach level i+1
  const t = [0];
  let need = 130;
  for (let i = 1; i < MAX_LEVEL; i++) { t.push(t[i - 1] + need); need += 55; }
  return t;
})();
const XP_SHARE_RANGE = 800;

// ---------- misc ----------
const RECALL_TIME = 4.5;
const FOUNTAIN_RANGE = 300;
const RESPAWN_BASE = 5;
const RESPAWN_PER_LEVEL = 1.6;
const AGGRO_RANGE_MINION = 320;
const HERO_SIGHT = 900;

// ---------- shop items ----------
const ITEMS = [
  { id: 'blade',  name: 'Fury Blade',    icon: '⚔️', cost: 900,  desc: '+55 Attack',                stats: { ad: 55 } },
  { id: 'codex',  name: 'Void Codex',    icon: '📖', cost: 900,  desc: '+75 Magic Power',           stats: { ap: 75 } },
  { id: 'plate',  name: 'Titan Plate',   icon: '🛡️', cost: 1000, desc: '+750 HP, +30 Armor',        stats: { hp: 750, armor: 30 } },
  { id: 'veil',   name: 'Aegis Veil',    icon: '🌀', cost: 850,  desc: '+400 HP, +45 Magic Res',    stats: { hp: 400, mr: 45 } },
  { id: 'boots',  name: 'Swift Boots',   icon: '🥾', cost: 500,  desc: '+45 Move Speed',            stats: { speed: 45 } },
  { id: 'fang',   name: 'Vampiric Fang', icon: '🩸', cost: 1000, desc: '+30 Attack, +15% Lifesteal', stats: { ad: 30, lifesteal: 0.15 } },
];
const MAX_ITEMS = 6;

// ---------- hero roster (original designs) ----------
// growth values are per level above 1
const HEROES = {
  kaelis: {
    id: 'kaelis', name: 'Kaelis', title: 'the Dawnblade', role: 'Fighter',
    color: '#f5a524', glyph: 'sword',
    lore: 'A wandering duelist whose twin blade drinks the first light of day.',
    base: {
      hp: 700, hpG: 98, mana: 260, manaG: 20, ad: 64, adG: 5.8, ap: 0,
      armor: 24, armorG: 3.4, mr: 16, mrG: 1.8, range: 80, atkSpd: 1.05,
      speed: 220, hpRegen: 2.0, manaRegen: 1.2, radius: 20,
    },
    aiItems: ['blade', 'fang', 'plate', 'boots', 'blade', 'veil'],
    skills: [
      { key: '1', name: 'Dawn Rush',      cd: 8,  mana: 45, desc: 'Dash forward, slashing every enemy in your path.' },
      { key: '2', name: 'Crescent Sweep', cd: 9,  mana: 55, desc: 'Spin your blade, damaging and slowing nearby enemies.' },
      { key: 'R', name: 'Sunfall',        cd: 42, mana: 100, desc: 'Leap to a location and slam down, stunning enemies in the blast.' },
    ],
  },
  nyra: {
    id: 'nyra', name: 'Nyra', title: 'the Void Weaver', role: 'Mage',
    color: '#a855f7', glyph: 'orb',
    lore: 'She stitches rips in reality into weapons of collapsing starlight.',
    base: {
      hp: 560, hpG: 72, mana: 480, manaG: 42, ad: 48, adG: 3.0, ap: 30,
      armor: 16, armorG: 2.4, mr: 20, mrG: 2.2, range: 380, atkSpd: 0.85,
      speed: 210, hpRegen: 1.4, manaRegen: 2.6, radius: 18,
    },
    aiItems: ['codex', 'boots', 'codex', 'veil', 'codex', 'plate'],
    skills: [
      { key: '1', name: 'Void Bolt',     cd: 6,  mana: 55, desc: 'Hurl a rift bolt that bursts on the first enemy hit.' },
      { key: '2', name: 'Gravity Well',  cd: 12, mana: 75, desc: 'Open a well that slows and shreds enemies inside it.' },
      { key: 'R', name: 'Event Horizon', cd: 48, mana: 130, desc: 'Collapse space in an area — after a beat it detonates and drags enemies inward.' },
    ],
  },
  bram: {
    id: 'bram', name: 'Bram', title: 'the Ironhide', role: 'Tank',
    color: '#94a3b8', glyph: 'shield',
    lore: 'A mountain-clan warden fused to living granite armor.',
    base: {
      hp: 900, hpG: 130, mana: 300, manaG: 22, ad: 58, adG: 4.2, ap: 0,
      armor: 34, armorG: 4.4, mr: 26, mrG: 3.0, range: 85, atkSpd: 0.9,
      speed: 215, hpRegen: 2.8, manaRegen: 1.2, radius: 24,
    },
    aiItems: ['plate', 'veil', 'boots', 'plate', 'veil', 'blade'],
    skills: [
      { key: '1', name: 'Bull Charge',  cd: 10, mana: 50, desc: 'Charge ahead — the first enemy struck is stunned.' },
      { key: '2', name: 'Iron Bastion', cd: 13, mana: 60, desc: 'Gain a rock shield that returns damage to attackers.' },
      { key: 'R', name: 'Seismic Slam', cd: 48, mana: 110, desc: 'Smash the ground, stunning every enemy around you.' },
    ],
  },
  sylfa: {
    id: 'sylfa', name: 'Sylfa', title: 'the Windarrow', role: 'Marksman',
    color: '#34d399', glyph: 'arrow',
    lore: 'An exiled sky-elf who never fires the same gust twice.',
    base: {
      hp: 580, hpG: 78, mana: 300, manaG: 24, ad: 68, adG: 6.6, ap: 0,
      armor: 18, armorG: 2.8, mr: 15, mrG: 1.6, range: 360, atkSpd: 1.1,
      speed: 220, hpRegen: 1.5, manaRegen: 1.5, radius: 18,
    },
    aiItems: ['blade', 'boots', 'fang', 'blade', 'blade', 'plate'],
    skills: [
      { key: '1', name: 'Piercing Gale', cd: 7,  mana: 50, desc: 'Loose an arrow of wind that pierces through every enemy.' },
      { key: '2', name: 'Zephyr Step',   cd: 10, mana: 45, desc: 'Dash on the wind and gain attack speed.' },
      { key: 'R', name: 'Arrowstorm',    cd: 45, mana: 110, desc: 'Rain arrows on an area for several seconds.' },
    ],
  },
  miro: {
    id: 'miro', name: 'Miro', title: 'the Lantern Sage', role: 'Support',
    color: '#facc15', glyph: 'lantern',
    lore: 'An old spirit-keeper whose lantern holds a captive sunrise.',
    base: {
      hp: 640, hpG: 84, mana: 440, manaG: 38, ad: 50, adG: 3.4, ap: 25,
      armor: 20, armorG: 2.8, mr: 22, mrG: 2.4, range: 360, atkSpd: 0.9,
      speed: 215, hpRegen: 2.0, manaRegen: 2.4, radius: 18,
    },
    aiItems: ['codex', 'boots', 'veil', 'plate', 'codex', 'codex'],
    skills: [
      { key: '1', name: 'Spirit Flame',   cd: 6,  mana: 50, desc: 'Send a burning wisp that damages and slows the first enemy hit.' },
      { key: '2', name: 'Soothing Light', cd: 11, mana: 70, desc: 'Pulse warm light, healing yourself and nearby allies.' },
      { key: 'R', name: 'Sanctuary',      cd: 52, mana: 120, desc: 'Bless the ground around you — allies inside heal rapidly, enemies are slowed.' },
    ],
  },
};
const HERO_IDS = Object.keys(HEROES);
