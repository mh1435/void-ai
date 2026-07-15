# ⚔ Void Arena

A 5v5 MOBA in the style of Mobile Legends, built with plain HTML5 Canvas + JavaScript — no
dependencies, no build step. Runs on phones (touch joystick + skill buttons) and desktop.

**Current mode:** you + 4 AI teammates vs 5 AI enemies. Multiplayer is the next milestone
(see roadmap below).

## ▶ How to run

Just open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

## 🎮 Controls

| Action | Mobile | Desktop |
|---|---|---|
| Move | left virtual joystick | WASD / arrows |
| Basic attack | ⚔ button (hold) — auto-attacks when idle | Space (hold) |
| Skills 1 / 2 / Ult | tap = smart cast, **drag = aim** | 1 / 2 / 3 (aimed at mouse) |
| Recall to base | ⌂ button | B |
| Quick-buy next item | gold button | F |
| Shop / Scoreboard | 🛒 / ☰ | P / Tab |

## 🗺 The game

- Three lanes with **2 turrets each + a Void Core** per team — turrets must fall in order,
  and the Core only becomes vulnerable once a lane is broken.
- **Minion waves** every 28s, jungle camps that respawn, and the **Void Behemoth** boss
  (spawns at 2:00) that grants your whole team gold + a damage buff.
- **Bushes** hide you from enemies, gold/XP/levels (cap 15), items (6 slots), kill streaks,
  first blood, assists, respawn timers — the full MOBA loop.
- Ultimate unlocks at level 4.

## 🦸 Original roster

| Hero | Role | Signature |
|---|---|---|
| **Kael, the Ashblade** | Assassin | Blink execution that refunds cooldown on kill |
| **Nyra, Storm Weaver** | Mage | Skillshot bolts + triple-wave storm ultimate |
| **Grom, the Ironhide** | Tank | Max-HP scaling slams, leap + AoE stun ult |
| **Lyra, Dawnstrider** | Marksman | Piercing arrows, arrow-rain ultimate |
| **Vex, the Void Caller** | Support | Marks enemies (+12% dmg taken), heals, gravity well |
| **Thane, Wolfheart** | Fighter | Lifesteal brawler with bleed and rage ultimate |

## 🧊 3D Mode (Beta)

`3d.html` is a real 3D build of the same game, rendered with [Three.js](https://threejs.org)
(MIT license) instead of the 2D canvas. It reuses the entire simulation — `js/data.js`,
`js/entities.js`, `js/ai.js`, and `Game.update()` in `js/game.js` — completely unchanged;
only the rendering layer (`js3d/render3d.js`) is new, so gameplay, fog of war, and the DOM
HUD all work identically to the 2D version. The 2D game at `index.html` is untouched and
remains the main, complete version — 3D is an added mode, not a replacement.

Heroes are a real anime-style VRM avatar (`assets/models/hero.vrm`), tinted per hero —
pixiv's official sample model for their [`three-vrm`](https://github.com/pixiv/three-vrm)
library, licensed for commercial use, modification and redistribution, no attribution
required (license terms are embedded in the file itself; see
`assets/models/hero_VRM_LICENSE.md`). Three.js, GLTFLoader and `@pixiv/three-vrm` are all
MIT licensed — see the `*_LICENSE.txt` files in `js3d/vendor/`.

The VRM avatar has no baked-in game animations, so Idle/Walk/Run/Punch/Death are hand-built
in `js3d/render3d.js` by rotating the model's standardized VRM humanoid bones directly each
frame, rather than played from motion-captured clips — simpler motion than a fully animated
rig would give, by design of this first pass.

Being a beta: it's one shared character model recolored per hero rather than six unique
designs (free rigged/animated humanoid models are scarce), and towers/minions/environment
are built from real 3D geometry rather than a second licensed model pack.

## 🧱 Code layout

```
index.html      2D game: HUD + screens (hero select, HUD, shop, scoreboard, end screen)
3d.html         3D beta: same HUD/screens, real Three.js scene instead of canvas
style.css       all styling (shared by both)
js/data.js      constants, map layout, hero kits, items (shared)
js/entities.js  Unit/Hero/Minion/Tower/Jungle classes, combat, ability API (shared)
js/ai.js        bot decision-making (shared)
js/game.js      match state, simulation loop, 2D world renderer
js/ui.js        input (joystick, drag-aim skills, keyboard), HUD, minimap, SFX (shared)
js/main.js      2D bootstrap + requestAnimationFrame loop
js3d/render3d.js  3D renderer: reads the same G/UI state as js/game.js's render()
js3d/main3d.js    3D bootstrap: loads the character model, then starts the loop
js3d/vendor/      self-hosted Three.js + GLTFLoader + @pixiv/three-vrm (no CDN dependency)
```

## 🛣 Roadmap → multiplayer

The simulation is already isolated from input/rendering (`Game.update(dt)` vs `render()`),
which is the shape needed for netcode. Plan:

1. Fixed-timestep, deterministic sim (seeded RNG, integer positions).
2. Authoritative Node/WebSocket server running the same `js/` sim.
3. Client-side prediction for your own hero + interpolation for everyone else.
4. Lobby/matchmaking, then ranked-style progression.

Also on the list: more heroes, skill leveling choices, equipment tiers/recipes, fog of war.
