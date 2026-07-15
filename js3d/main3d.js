// ============================================================
// VOID ARENA — 3D mode bootstrap
//
// This page reuses js/data.js, js/entities.js, js/ai.js, js/game.js
// (simulation + Game.update) and js/ui.js (all-DOM HUD) completely
// unchanged — a hero's x/y position, HP, cooldowns etc. are computed
// exactly like the 2D game. Only the *visual* layer is new: render3d.js
// draws the same G state with a real Three.js scene and a real,
// CC0-licensed animated 3D character model instead of 2D canvas shapes.
// ============================================================

import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';
import { clone as skeletonClone } from './vendor/utils/SkeletonUtils.js';

window.THREE = THREE;
window.GLTFLoader = GLTFLoader;
window.cloneSkinned = skeletonClone;

window.addEventListener('load', () => {
  // UI.init() (which wires up the hero-select "ENTER THE ARENA" button) is
  // deliberately deferred until the character model has actually loaded —
  // starting a match before the model is ready would leave the player
  // staring at a blank scene while G.running silently ticks in the background.
  const loader = new GLTFLoader();
  loader.load('assets/models/RobotExpressive.glb', (gltf) => {
    document.getElementById('loading3d').style.display = 'none';
    UI.init();
    Render3D.init(gltf);

    let last = performance.now();
    function frame(now) {
      let dt = (now - last) / 1000;
      last = now;
      dt = Math.min(dt, 0.05);

      Game.update(dt);
      Render3D.render(dt);
      UI.update();

      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }, (progress) => {
    if (progress.total) {
      const pct = Math.round(progress.loaded / progress.total * 100);
      document.getElementById('loading3d').querySelector('.loadPct').textContent = pct + '%';
    }
  }, (err) => {
    console.error('Failed to load character model', err);
    document.getElementById('loading3d').style.display = 'none';
    document.getElementById('loadError').style.display = 'flex';
  });
});

document.addEventListener('touchmove', e => { if (e.target.tagName !== 'INPUT') e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', e => e.preventDefault());
