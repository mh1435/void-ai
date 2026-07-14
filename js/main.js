// ============================================================
// VOID ARENA — bootstrap and main loop
// ============================================================

window.addEventListener('load', () => {
  UI.init();

  let last = performance.now();
  function frame(now) {
    let dt = (now - last) / 1000;
    last = now;
    dt = Math.min(dt, 0.05); // clamp for tab switches / hitches

    Game.update(dt);
    render(UI.ctx);
    UI.update();

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
});

// stop mobile browser gestures fighting the game
document.addEventListener('touchmove', e => { if (e.target.tagName !== 'INPUT') e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', e => e.preventDefault());
