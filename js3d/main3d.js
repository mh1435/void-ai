// ============================================================
// VOID ARENA — 3D mode bootstrap
//
// This page reuses js/data.js, js/entities.js, js/ai.js, js/game.js
// (simulation + Game.update) and js/ui.js (all-DOM HUD) completely
// unchanged — a hero's x/y position, HP, cooldowns etc. are computed
// exactly like the 2D game. Only the *visual* layer is new: render3d.js
// draws the same G state with a real Three.js scene and a real,
// properly-licensed anime-style VRM character model (see assets/models)
// instead of 2D canvas shapes.
//
// The VRM file is fetched over the network exactly once, then parsed
// into a small pool of fully independent character instances (one per
// possible hero slot) up front, during the loading screen — GLTFLoader's
// parse() works off the already-downloaded bytes, so this costs CPU time
// to build the pool, not repeated network transfer.
// ============================================================

import * as THREE from './vendor/three.module.min.js';
import { GLTFLoader } from './vendor/loaders/GLTFLoader.js';
import { VRMLoaderPlugin } from './vendor/three-vrm.module.min.js';

window.THREE = THREE;

const POOL_SIZE = 10; // max simultaneous heroes in a 5v5 match

window.addEventListener('load', async () => {
  const loadingEl = document.getElementById('loading3d');
  const pctEl = loadingEl.querySelector('.loadPct');
  const setPct = (label) => { pctEl.textContent = label; };

  try {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    setPct('downloading character model…');
    const res = await fetch('assets/models/hero.vrm');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buffer = await res.arrayBuffer();

    const pool = [];
    for (let i = 0; i < POOL_SIZE; i++) {
      setPct('preparing characters ' + (i + 1) + '/' + POOL_SIZE);
      // parseAsync re-parses the already-downloaded bytes into a fully
      // independent scene graph + VRM instance each time — simpler and
      // safer than trying to clone a skinned VRM's bone/humanoid mapping
      const gltf = await loader.parseAsync(buffer.slice(0), '');
      pool.push({ scene: gltf.scene, vrm: gltf.userData.vrm });
    }

    loadingEl.style.display = 'none';
    // UI.init() (which wires up the hero-select "ENTER THE ARENA" button)
    // is deliberately deferred until the pool is actually ready — starting
    // a match before then would leave the player staring at a blank scene
    UI.init();
    Render3D.init(pool);

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
  } catch (err) {
    console.error('Failed to load character model', err);
    loadingEl.style.display = 'none';
    document.getElementById('loadError').style.display = 'flex';
  }
});

document.addEventListener('touchmove', e => { if (e.target.tagName !== 'INPUT') e.preventDefault(); }, { passive: false });
document.addEventListener('contextmenu', e => e.preventDefault());
