# ⚔️ Void Legends

A **Mobile Legends–style 5v5 MOBA** that runs entirely in the browser — no install, no build step, works on desktop **and** phone.

You + 4 AI teammates vs 5 AI enemies. Push three lanes, break turrets, and shatter the enemy **Core** to win.

## ▶️ Play

Just open `index.html` in a browser, or serve the folder:

```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

## 🎮 Controls

| Action | Desktop | Mobile |
|---|---|---|
| Move | `WASD` / arrows | virtual joystick (left side) |
| Basic attack | `Space` | ⚔ button |
| Skill 1 / 2 | `Q` / `E` | skill buttons |
| Ultimate (unlocks at Lv.4) | `R` | gold button |
| Recall to base | `B` | ⛺ button |
| Item shop | `P` | 🛒 button |
| Scoreboard | `Tab` | 📊 button |

Skills smart-aim at the nearest enemy hero (Mobile Legends style). Standing still auto-attacks whatever is in range.

## 🦸 The Roster (all original heroes)

| Hero | Role | Kit |
|---|---|---|
| **Kaelis, the Dawnblade** | Fighter | Dash strike · spin slow · leaping AoE stun ult |
| **Nyra, the Void Weaver** | Mage | Skillshot bolt · slowing gravity well · delayed black-hole ult |
| **Bram, the Ironhide** | Tank | Charge stun · thorns shield · massive AoE stun ult |
| **Sylfa, the Windarrow** | Marksman | Piercing arrow · dash + attack speed · arrow rain ult |
| **Miro, the Lantern Sage** | Support | Slowing flame · AoE heal · sanctuary zone ult |

## 🗺️ The Map

- 3 lanes (top / mid / bot) with 2 turrets per lane per team + a base guardian
- Minion waves every 30s, a river across the middle, jungle camps for bonus gold/XP
- Leveling to 15, gold economy, a 6-item shop, kill/assist credit, respawn timers

## 🛠️ Tech

Vanilla JavaScript + Canvas 2D. Zero dependencies.

```
index.html      entry point + HUD markup
style.css       HUD / menus
js/config.js    map layout, balance numbers, hero data
js/entities.js  units, projectiles, zones, damage model
js/heroes.js    the 5 hero kits
js/ai.js        bot brains (lane push, retreat, recall, shopping, skill usage)
js/game.js      simulation loop + world rendering
js/ui.js        HUD, hero select, joystick, shop, scoreboard
js/main.js      bootstrap + input
```

## 🔜 Roadmap

- [ ] Real multiplayer (WebSocket rooms)
- [ ] More heroes & items
- [ ] Sound effects / music
- [ ] Ranked bot difficulties
