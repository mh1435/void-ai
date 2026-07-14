// ============================================================
// VOID LEGENDS — bootstrap, input & main loop
// ============================================================
'use strict';

(function () {
  const canvas = document.getElementById('game');
  const minimap = document.getElementById('minimap');
  const ui = new UI();
  let game = null;

  // ---------- canvas sizing ----------
  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
    if (game) game.dpr = dpr;
  }
  window.addEventListener('resize', resize);
  resize();

  // ---------- input state ----------
  const keys = {};
  const input = {
    attackHeld: false,
    attackTap() {
      if (!game || game.player.dead) return;
      const p = game.player;
      const t =
        game.nearestEnemy(p, 700, ['hero']) ||
        game.nearestEnemy(p, 600, ['minion', 'jungle']) ||
        game.nearestEnemy(p, 600, ['tower', 'core']);
      if (t) { p.attackTarget = t; p.moveInput.x = 0; p.moveInput.y = 0; }
    },
  };

  window.addEventListener('keydown', e => {
    if (e.repeat) return;
    const k = e.key.toLowerCase();
    keys[k] = true;
    if (!game || game.over) return;
    if (k === 'q' || k === '1') game.castSkill(game.player, 0);
    if (k === 'e' || k === '2') game.castSkill(game.player, 1);
    if (k === 'r' || k === '3') game.castSkill(game.player, 2);
    if (k === ' ') { e.preventDefault(); input.attackTap(); }
    if (k === 'b') game.player.startRecall(game);
    if (k === 'p') ui.toggleShop();
    if (k === 'tab') { e.preventDefault(); ui.toggleScoreboard(); }
    if (k === 'escape') { ui.toggleShop(false); ui.toggleScoreboard(false); }
  });
  window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });

  const joystick = new Joystick(
    document.getElementById('joy-zone'),
    document.getElementById('joy-base'),
    document.getElementById('joy-knob'),
  );

  function readMoveInput() {
    let x = 0, y = 0;
    if (keys['a'] || keys['arrowleft']) x -= 1;
    if (keys['d'] || keys['arrowright']) x += 1;
    if (keys['w'] || keys['arrowup']) y -= 1;
    if (keys['s'] || keys['arrowdown']) y += 1;
    if (joystick.vec.x || joystick.vec.y) { x = joystick.vec.x; y = joystick.vec.y; }
    return { x, y };
  }

  // ---------- main loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (game) {
      const p = game.player;
      if (!p.dead && !game.over) {
        const mv = readMoveInput();
        p.moveInput.x = mv.x; p.moveInput.y = mv.y;
      } else {
        p.moveInput.x = 0; p.moveInput.y = 0;
      }
      game.update(dt);
      game.draw();
      game.drawMinimap(minimap);
      ui.updateHUD(game);
    }
    requestAnimationFrame(frame);
  }

  // ---------- start ----------
  ui.showHeroSelect(heroId => {
    game = new Game(canvas, ui, heroId);
    game.dpr = Math.min(window.devicePixelRatio || 1, 2);
    window.game = game;   // handy for debugging in the console
    ui.bindGame(game, input);
    ui.flash('Welcome to the Rift — destroy the enemy core!');
  });

  requestAnimationFrame(frame);
})();
