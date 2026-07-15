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
import { clone as skeletonClone } from './vendor/utils/SkeletonUtils.js';

window.THREE = THREE;
// render3d.js is a classic (non-module) script, so it can't import — expose
// the skinned-mesh clone helper the same way THREE itself is exposed
window.SkeletonClone = skeletonClone;

// the distinct KayKit models the six heroes are drawn from (CC0 — see
// assets/models/kaykit/KAYKIT_LICENSE.txt). Loaded once each, then cloned
// per hero unit in render3d.js.
const HERO_MODEL_FILES = ['Knight', 'Mage', 'Rogue', 'Rogue_Hooded', 'Barbarian'];

window.addEventListener('load', async () => {
  const loadingEl = document.getElementById('loading3d');
  const pctEl = loadingEl.querySelector('.loadPct');
  const setPct = (label) => { pctEl.textContent = label; };

  try {
    const loader = new GLTFLoader();

    const models = {};
    for (let i = 0; i < HERO_MODEL_FILES.length; i++) {
      const name = HERO_MODEL_FILES[i];
      setPct('loading characters ' + (i + 1) + '/' + HERO_MODEL_FILES.length);
      const gltf = await loader.loadAsync('assets/models/kaykit/' + name + '.glb');
      models[name] = { scene: gltf.scene, animations: gltf.animations };
    }

    loadingEl.style.display = 'none';
    // UI.init() (which wires up the hero-select "ENTER THE ARENA" button)
    // is deliberately deferred until the models are actually ready — starting
    // a match before then would leave the player staring at a blank scene
    UI.init();
    Render3D.init(models);

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
