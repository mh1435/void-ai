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

## 🧱 Code layout

```
index.html      HUD + screens (hero select, HUD, shop, scoreboard, end screen)
style.css       all styling
js/data.js      constants, map layout, hero kits, items
js/entities.js  Unit/Hero/Minion/Tower/Jungle classes, combat, ability API
js/ai.js        bot decision-making
js/game.js      match state, simulation loop, world renderer
js/ui.js        input (joystick, drag-aim skills, keyboard), HUD, minimap, SFX
js/main.js      bootstrap + requestAnimationFrame loop
```

## 🛣 Roadmap → multiplayer

The simulation is already isolated from input/rendering (`Game.update(dt)` vs `render()`),
which is the shape needed for netcode. Plan:

1. Fixed-timestep, deterministic sim (seeded RNG, integer positions).
2. Authoritative Node/WebSocket server running the same `js/` sim.
3. Client-side prediction for your own hero + interpolation for everyone else.
4. Lobby/matchmaking, then ranked-style progression.

Also on the list: more heroes, skill leveling choices, equipment tiers/recipes, fog of war.
