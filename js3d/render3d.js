// ============================================================
// VOID ARENA — 3D renderer
//
// Reads the exact same G/UI state the 2D renderer (js/game.js render())
// reads — same units, same fog of war, same HP/mana — and draws it with a
// real Three.js scene instead of flat canvas shapes. Heroes use a real
// anime-style VRM character model (see assets/models for its license),
// hand-posed each frame via its standardized humanoid bones since VRM
// avatars carry no baked-in animation clips; every other entity is built
// from proper 3D geometry (extruded/lofted shapes with real volume and
// lighting), not flat 2D primitives.
//
// World-to-scene mapping: game (x, y) in [0, WORLD] -> scene (x, 0, z)
// centered at the origin, i.e. scene.x = x - WORLD/2, scene.z = y - WORLD/2.
// ============================================================

const Render3D = (() => {
  const HALF = WORLD / 2;
  const toScene = (x, y) => [x - HALF, y - HALF];

  let scene, camera, renderer, clock;
  let groundMesh, fogMesh, fogTexture;
  let heroPool = null;                // [{ scene, vrm }, ...] — one per hero slot, assigned permanently
  const unitMeshes = new Map();      // unit.id -> entry
  const projMeshes = new Map();      // projectile obj -> mesh
  const fxMeshes = [];               // transient effects
  const staticScenery = [];

  const TEAM_HEX = { blue: 0x3fa9ff, red: 0xff4d5e };
  const TEAM_HEX_D = { blue: 0x1c5c94, red: 0x8f2430 };

  function init(pool) {
    heroPool = pool;
    // capture each bone's true bind-pose quaternion exactly once, before
    // any animation ever touches it — createHero() can run more than once
    // per hero (fog-of-war hide/show, or after the death-collapse pose),
    // and re-capturing "rest" from whatever pose the bones were last left
    // in would corrupt every animation after the first hide/death
    for (const entry of heroPool) {
      entry.restQuats = {};
      for (const name of BONE_NAMES) {
        const b = entry.vrm.humanoid.getNormalizedBoneNode(name);
        if (b) entry.restQuats[name] = b.quaternion.clone();
      }
    }
    camOffset = new THREE.Vector3(0, 640, 500);
    _q = new THREE.Quaternion();
    camTarget = new THREE.Vector3();

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x060a10);
    scene.fog = new THREE.Fog(0x060a10, 900, 2400);

    camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 1, 4000);

    const canvas = document.getElementById('game3d');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    resize();
    window.addEventListener('resize', resize);

    // lighting: soft ambient fill + a directional "sun" casting shadows
    scene.add(new THREE.HemisphereLight(0x8fb8ff, 0x1a2a1a, 0.9));
    const sun = new THREE.DirectionalLight(0xfff2d8, 1.6);
    sun.position.set(-500, 900, -400);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -1400; sun.shadow.camera.right = 1400;
    sun.shadow.camera.top = 1400; sun.shadow.camera.bottom = -1400;
    sun.shadow.camera.near = 200; sun.shadow.camera.far = 2600;
    sun.shadow.bias = -0.0008;
    scene.add(sun);
    scene.add(sun.target);

    // buildGround() needs mapCanvas, which doesn't exist yet — Game.start()
    // (fired later, once the player picks a hero) is what creates it via
    // buildMapCanvas(). render() lazily builds the ground on its first
    // call after that's happened instead of wiring a separate hook.
    buildScenery();

    clock = new THREE.Clock();
    UI.mouseAim = mouseAim3D; // override the 2D screen-space version with a real raycast
  }

  function resize() {
    if (!renderer) return;
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  }

  // ---------------- ground + fog of war ----------------
  function buildGround() {
    const geo = new THREE.PlaneGeometry(WORLD, WORLD, 1, 1);
    geo.rotateX(-Math.PI / 2);
    const tex = new THREE.CanvasTexture(mapCanvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0.02 });
    groundMesh = new THREE.Mesh(geo, mat);
    groundMesh.receiveShadow = true;
    scene.add(groundMesh);

    // fog-of-war overlay: the same live fogMask canvas (already computed by
    // the shared 2D game code each tick), painted as a translucent layer
    // just above the ground so unexplored/out-of-vision terrain darkens
    const fogGeo = new THREE.PlaneGeometry(WORLD, WORLD, 1, 1);
    fogGeo.rotateX(-Math.PI / 2);
    fogTexture = new THREE.CanvasTexture(fogMask);
    fogTexture.colorSpace = THREE.SRGBColorSpace;
    const fogMat = new THREE.MeshBasicMaterial({ map: fogTexture, transparent: true, depthWrite: false });
    fogMesh = new THREE.Mesh(fogGeo, fogMat);
    fogMesh.position.y = 6;
    fogMesh.renderOrder = 5;
    scene.add(fogMesh);
  }

  // rocks + bushes are static, built once from the same data the 2D map uses
  function buildScenery() {
    const rockGeo = new THREE.IcosahedronGeometry(1, 1);
    jitterGeometry(rockGeo, 0.28);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x454c56, roughness: 0.9, flatShading: true });
    for (const r of ROCKS) {
      const m = new THREE.Mesh(rockGeo, rockMat);
      const [x, z] = toScene(r.x, r.y);
      m.position.set(x, r.r * 0.55, z);
      m.scale.setScalar(r.r * 0.85);
      m.rotation.y = Math.random() * Math.PI * 2;
      m.castShadow = true; m.receiveShadow = true;
      scene.add(m); staticScenery.push(m);
    }
    const bushMat = new THREE.MeshStandardMaterial({ color: 0x2f8a4d, roughness: 0.85, transparent: true, opacity: 0.88 });
    for (const b of BUSHES) {
      const cx = b.x + b.w/2, cy = b.y + b.h/2;
      const [x, z] = toScene(cx, cy);
      const g = new THREE.Group();
      const clumps = 5;
      for (let i = 0; i < clumps; i++) {
        const geo = new THREE.IcosahedronGeometry(1, 1);
        jitterGeometry(geo, 0.3);
        const mesh = new THREE.Mesh(geo, bushMat);
        const rad = Math.max(b.w, b.h) * 0.24;
        const a = (i / clumps) * Math.PI * 2;
        mesh.position.set(Math.cos(a) * rad * 0.5, rad * 0.5, Math.sin(a) * rad * 0.5);
        mesh.scale.setScalar(rad * (0.6 + Math.random()*0.3));
        mesh.castShadow = true;
        g.add(mesh);
      }
      g.position.set(x, 0, z);
      scene.add(g); staticScenery.push(g);
    }
  }

  function jitterGeometry(geo, amt) {
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const s = 1 + (Math.random()*2 - 1) * amt;
      pos.setXYZ(i, pos.getX(i)*s, pos.getY(i)*s, pos.getZ(i)*s);
    }
    geo.computeVertexNormals();
  }

  // ---------------- HP/mana billboard bars ----------------
  // Bars are added directly to the scene (never as a child of a rotating
  // unit group) and repositioned explicitly each frame, so the billboard
  // pass can set their world quaternion straight from the camera without
  // it composing with — and being skewed by — the parent's facing rotation.
  function makeBar(width) {
    const g = new THREE.Group();
    const bgGeo = new THREE.PlaneGeometry(width + 2, 7);
    const bg = new THREE.Mesh(bgGeo, new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6, depthTest: false }));
    const hpGeo = new THREE.PlaneGeometry(width, 5);
    hpGeo.translate(0.5, 0, 0); // pivot at left edge so we can scale.x for fill %
    const hp = new THREE.Mesh(hpGeo, new THREE.MeshBasicMaterial({ color: 0x4ade80, depthTest: false }));
    hp.position.x = -width/2;
    g.add(bg, hp);
    g.renderOrder = 10;
    g.userData.hp = hp; g.userData.width = width;
    scene.add(g);
    return g;
  }

  // ---------------- hero (real VRM character) instances ----------------
  // The VRM avatar has no baked-in game animations (see README), so motion
  // is hand-authored here: each frame we rotate its VRM "normalized" bones
  // — a virtual rig three-vrm keeps consistent regardless of the avatar's
  // raw bind pose — directly, as a function of the hero's live sim state.
  const HERO_SCALE = 58;
  const ARM_DOWN = 1.4; // Z-rotation bringing a T-pose arm down to the side
  const BONE_NAMES = ['hips','spine','chest','head',
    'leftUpperArm','rightUpperArm','leftLowerArm','rightLowerArm',
    'leftUpperLeg','rightUpperLeg','leftLowerLeg','rightLowerLeg'];

  function createHero(u) {
    const idx = G.heroes.indexOf(u);
    const { scene: root, vrm } = heroPool[idx];
    root.scale.setScalar(HERO_SCALE);
    root.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true; o.receiveShadow = true;
        if (o.material && /CLOTH/i.test(o.material.name)) o.material = o.material.clone();
      }
    });
    const tint = new THREE.Color(u.def.color);
    root.traverse(o => { if (o.isMesh && o.material && /CLOTH/i.test(o.material.name)) o.material.color.copy(tint); });

    const bones = {};
    const rest = {};
    const restQuats = heroPool[idx].restQuats;
    for (const name of BONE_NAMES) {
      const b = vrm.humanoid.getNormalizedBoneNode(name);
      if (b && restQuats[name]) { bones[name] = b; rest[name] = restQuats[name].clone(); }
    }

    const group = new THREE.Group();
    group.add(root);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(24, 28, 24),
      new THREE.MeshBasicMaterial({ color: TEAM_HEX[u.team], transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI/2; ring.position.y = 1;
    group.add(ring);

    scene.add(group);
    const bar = makeBar(58);
    return {
      group, root, vrm, bones, rest, animT: 0, punchT: 0,
      hpBar: bar, barHeight: HERO_SCALE * 1.7, ring, team: u.team, kind: 'hero',
    };
  }

  // small helper: rotate a bone by (x,y,z) radians on top of its rest pose
  // (lazily instantiated in init(), same THREE-not-defined-yet reason as camOffset above)
  let _q;
  function poseBone(e, name, x, y, z) {
    const b = e.bones[name];
    if (!b) return;
    _q.setFromEuler(new THREE.Euler(x, y, z));
    b.quaternion.copy(e.rest[name]).multiply(_q);
  }

  function updateHero(e, u, dt) {
    const [x, z] = toScene(u.x, u.y);
    e.group.position.set(x, 0, z);
    e.group.rotation.y = -u.facing;
    e.ring.material.opacity = u.isPlayer ? 1 : 0.7;

    e.group.visible = !u.dead || (G.time - (u._deathT || (u._deathT = G.time))) < 1.4;
    e.hpBar.visible = e.group.visible;
    if (e.group.visible) { e.hpBar.position.set(x, e.barHeight, z); updateBar(e.hpBar, u); }

    if (!e.group.visible) return;

    if (u.dead) {
      const k = Math.min(1, (G.time - u._deathT) / 0.6);
      poseBone(e, 'hips', -k * 1.1, 0, 0);
      poseBone(e, 'spine', -k * 0.5, 0, 0);
      poseBone(e, 'head', k * 0.3, 0, 0);
      poseBone(e, 'leftUpperArm', -k * 0.3, 0, -ARM_DOWN);
      poseBone(e, 'rightUpperArm', -k * 0.3, 0, ARM_DOWN);
      e.group.position.y = -k * HERO_SCALE * 0.25;
    } else {
      e.group.position.y = 0;
      const attacking = (u._hitT !== undefined && G.time - u._hitT < 0.15) || u.atkTimer > (u.atkCd / u.asMult) * 0.6;
      if (attacking) e.punchT = 0.28;
      e.punchT = Math.max(0, e.punchT - dt);

      const running = u.moving && u._moving !== false;
      const walking = u.moving && !running;
      const speed = running ? 7 : walking ? 4.5 : 0;
      e.animT += dt * speed;

      // the model's rest pose is a T-pose (arms straight out); ARM_DOWN is
      // the fixed Z-rotation that brings each arm down to hang naturally at
      // the side — every arm pose below is built on top of this base, not
      // on top of the raw T-pose, or the character stands with arms flung
      // out sideways the whole match
      if (speed > 0) {
        const s = Math.sin(e.animT), c = Math.cos(e.animT);
        const legAmp = running ? 0.55 : 0.32, armAmp = running ? 0.5 : 0.28;
        poseBone(e, 'leftUpperLeg', s * legAmp, 0, 0);
        poseBone(e, 'rightUpperLeg', -s * legAmp, 0, 0);
        poseBone(e, 'leftLowerLeg', Math.max(0, -c) * legAmp * 0.9, 0, 0);
        poseBone(e, 'rightLowerLeg', Math.max(0, c) * legAmp * 0.9, 0, 0);
        poseBone(e, 'leftUpperArm', -s * armAmp, 0, -ARM_DOWN + 0.2);
        poseBone(e, 'rightUpperArm', s * armAmp, 0, ARM_DOWN - 0.2);
        poseBone(e, 'hips', 0, 0, Math.sin(e.animT * 2) * 0.03);
        poseBone(e, 'spine', 0.06, 0, 0);
      } else {
        const breathe = Math.sin(G.time * 1.6 + u.id) * 0.03;
        poseBone(e, 'spine', breathe, 0, 0);
        poseBone(e, 'leftUpperArm', 0, 0, -ARM_DOWN + breathe * 0.3);
        poseBone(e, 'rightUpperArm', 0, 0, ARM_DOWN - breathe * 0.3);
        poseBone(e, 'leftUpperLeg', 0, 0, 0);
        poseBone(e, 'rightUpperLeg', 0, 0, 0);
        poseBone(e, 'leftLowerLeg', 0, 0, 0);
        poseBone(e, 'rightLowerLeg', 0, 0, 0);
      }

      if (e.punchT > 0) {
        const k = 1 - e.punchT / 0.28;
        const thrust = Math.sin(k * Math.PI); // wind up then release
        poseBone(e, 'rightUpperArm', -thrust * 1.3, -thrust * 0.3, ARM_DOWN - thrust * 1.1);
        poseBone(e, 'chest', 0, -thrust * 0.15, 0);
      }
    }

    e.vrm.update(dt);
  }

  function updateBar(bar, u) {
    const frac = Math.max(0, Math.min(1, u.hp / u.hpMax()));
    bar.userData.hp.scale.x = frac;
    bar.userData.hp.material.color.setHex(u.team === G.player.team ? 0x4ade80 : (u.team === 'jungle' ? 0xc77dff : 0xef4444));
  }

  // ---------------- non-hero entities ----------------
  const geoCache = {};
  function sharedGeo(key, factory) { return geoCache[key] || (geoCache[key] = factory()); }
  const matCache = {};
  function sharedMat(key, factory) { return matCache[key] || (matCache[key] = factory()); }

  function createGeneric(u) {
    const group = new THREE.Group();
    let h = 40;
    if (u.type === 'minion') {
      const bodyGeo = sharedGeo('minionBody', () => new THREE.CapsuleGeometry(10, 14, 4, 8));
      const headGeo = sharedGeo('minionHead', () => new THREE.SphereGeometry(7, 10, 10));
      // dozens of these can be alive at once, so the material (unlike a
      // hero's, which needs a unique tint) is cached per team, not per instance
      const mat = sharedMat('minion_' + u.team, () =>
        new THREE.MeshStandardMaterial({ color: TEAM_HEX_D[u.team], roughness: 0.6, emissive: TEAM_HEX[u.team], emissiveIntensity: 0.15 }));
      const body = new THREE.Mesh(bodyGeo, mat); body.position.y = 14; body.castShadow = true;
      const head = new THREE.Mesh(headGeo, mat); head.position.y = 26; head.castShadow = true;
      group.add(body, head);
      h = 34;
    } else if (u.type === 'jungle') {
      const s = u.boss ? 2.1 : 1;
      const bodyGeo = sharedGeo('jungleBody', () => {
        const g = new THREE.IcosahedronGeometry(1, 1);
        jitterGeometry(g, 0.22);
        return g;
      });
      const mat = new THREE.MeshStandardMaterial({ color: u.boss ? 0x4a2a63 : 0x4d3a5e, roughness: 0.75, flatShading: true, emissive: 0xc77dff, emissiveIntensity: 0.12 });
      const body = new THREE.Mesh(bodyGeo, mat);
      body.scale.setScalar(26 * s); body.position.y = 26 * s; body.castShadow = true;
      group.add(body);
      for (let i = 0; i < (u.boss ? 6 : 3); i++) {
        const spike = new THREE.Mesh(sharedGeo('spike', () => new THREE.ConeGeometry(3, 14, 5)),
          new THREE.MeshStandardMaterial({ color: 0x9d4edd, emissive: 0x9d4edd, emissiveIntensity: 0.5 }));
        const a = (i / (u.boss?6:3)) * Math.PI * 2;
        spike.position.set(Math.cos(a)*22*s, 26*s, Math.sin(a)*22*s);
        spike.rotation.x = Math.PI/2 * 0.4;
        spike.lookAt(spike.position.x*1.5, 30*s, spike.position.z*1.5);
        group.add(spike);
      }
      h = u.boss ? 78 : 42;
    } else if (u.type === 'tower') {
      const col = sharedGeo('towerCol', () => new THREE.CylinderGeometry(16, 22, 90, 8));
      const mat = sharedMat('towerCol_' + u.team, () => new THREE.MeshStandardMaterial({ color: TEAM_HEX_D[u.team], roughness: 0.7, metalness: 0.15 }));
      const c = new THREE.Mesh(col, mat); c.position.y = 45; c.castShadow = true; c.receiveShadow = true;
      // crystal material is NOT shared, unlike the column above: its
      // emissiveIntensity is mutated per-instance each frame (invulnerability
      // glow) and towers of the same team must be able to differ
      const crystalMat = new THREE.MeshStandardMaterial({ color: TEAM_HEX[u.team], emissive: TEAM_HEX[u.team], emissiveIntensity: 0.9 });
      const crystal = new THREE.Mesh(sharedGeo('towerCrystal', () => new THREE.OctahedronGeometry(13, 0)), crystalMat);
      crystal.position.y = 104;
      group.add(c, crystal);
      group.userData.crystal = crystal;
      h = 112;
    } else if (u.type === 'core') {
      const baseMat = sharedMat('coreBase_' + u.team, () => new THREE.MeshStandardMaterial({ color: TEAM_HEX_D[u.team], roughness: 0.6 }));
      const base = new THREE.Mesh(sharedGeo('coreBase', () => new THREE.CylinderGeometry(60, 66, 20, 8)), baseMat);
      base.position.y = 10; base.castShadow = true; base.receiveShadow = true;
      const crystalMat = sharedMat('coreCrystal_' + u.team, () =>
        new THREE.MeshStandardMaterial({ color: TEAM_HEX[u.team], emissive: TEAM_HEX[u.team], emissiveIntensity: 1 }));
      const crystal = new THREE.Mesh(sharedGeo('coreCrystal', () => new THREE.OctahedronGeometry(34, 0)), crystalMat);
      crystal.position.y = 55;
      group.add(base, crystal);
      group.userData.crystal = crystal;
      h = 100;
    }
    scene.add(group);
    const barW = u.type === 'core' ? 90 : u.type === 'tower' ? 60 : u.type === 'jungle' ? (u.boss ? 110 : 40) : 26;
    const bar = makeBar(barW);
    return { group, hpBar: bar, barHeight: h + 14, kind: u.type };
  }

  function updateGeneric(e, u) {
    const [x, z] = toScene(u.x, u.y);
    e.group.position.set(x, 0, z);
    if (u.type === 'minion') e.group.rotation.y = -u.facing + Math.PI/2;
    if (e.group.userData.crystal) {
      const pulse = 1 + 0.08*Math.sin(G.time*3 + u.id);
      e.group.userData.crystal.scale.setScalar(pulse);
      e.group.userData.crystal.material.emissiveIntensity = (u.invulnerable ? 0.3 : 0.9);
    }
    e.hpBar.position.set(x, e.barHeight, z);
    updateBar(e.hpBar, u);
  }

  // ---------------- projectiles / zones / fx ----------------
  function syncProjectiles() {
    const active = new Set();
    for (const p of G.projectiles) {
      active.add(p);
      let mesh = projMeshes.get(p);
      if (!mesh) {
        mesh = new THREE.Mesh(
          sharedGeo('proj', () => new THREE.SphereGeometry(1, 8, 8)),
          new THREE.MeshBasicMaterial({ color: p.color || '#fff' })
        );
        scene.add(mesh);
        projMeshes.set(p, mesh);
      }
      const [x, z] = toScene(p.x, p.y);
      mesh.position.set(x, 24, z);
      mesh.scale.setScalar(p.size || 8);
    }
    for (const [p, mesh] of projMeshes) {
      if (!active.has(p)) { scene.remove(mesh); projMeshes.delete(p); }
    }
  }

  const zoneMeshes = new Map();
  function syncZones() {
    const active = new Set(G.zones);
    for (const z of G.zones) {
      active.add(z);
      let mesh = zoneMeshes.get(z);
      if (!mesh) {
        mesh = new THREE.Mesh(new THREE.CircleGeometry(1, 24),
          new THREE.MeshBasicMaterial({ color: z.color, transparent: true, opacity: 0.3, side: THREE.DoubleSide }));
        mesh.rotation.x = -Math.PI/2;
        scene.add(mesh);
        zoneMeshes.set(z, mesh);
      }
      const [x, zz] = toScene(z.x, z.y);
      mesh.position.set(x, 3, zz);
      mesh.scale.setScalar(z.r);
      mesh.material.opacity = 0.22 + 0.1*Math.sin(G.time*8);
    }
    for (const [z, mesh] of zoneMeshes) if (!active.has(z)) { scene.remove(mesh); zoneMeshes.delete(z); }
  }

  function spawnRingFX(x, y, color) {
    const mesh = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide }));
    mesh.rotation.x = -Math.PI/2;
    const [sx, sz] = toScene(x, y);
    mesh.position.set(sx, 4, sz);
    scene.add(mesh);
    fxMeshes.push({ mesh, t: 0, dur: 0.5, r0: 10, r1: 90 });
  }

  function syncFxFromEngine() {
    // FX is the shared 2D engine's effects array; it's mutated by splice as
    // entries expire (not just appended to), so track "already spawned" per
    // entry rather than by array index/length — an index-based cursor would
    // silently stop working the first time anything ahead of it expires.
    // Only ring events get a 3D counterpart (flashes/slashes/text are
    // skipped — the model's own hit-flash and animations cover that read).
    for (const e of FX) {
      if (e.type === 'ring' && !e._seen3d) {
        e._seen3d = true;
        spawnRingFX(e.x, e.y, e.color);
      }
    }
  }

  function updateFx(dt) {
    for (let i = fxMeshes.length - 1; i >= 0; i--) {
      const f = fxMeshes[i];
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) { scene.remove(f.mesh); f.mesh.geometry.dispose(); fxMeshes.splice(i, 1); continue; }
      const r = f.r0 + (f.r1 - f.r0) * k;
      f.mesh.scale.setScalar(r);
      f.mesh.material.opacity = (1 - k) * 0.9;
    }
  }

  // ---------------- camera ----------------
  // instantiated lazily inside init() — THREE isn't defined yet at the time
  // this classic script first runs (main3d.js, a deferred module, is what
  // sets window.THREE, and deferred modules execute after classic scripts)
  let camOffset, camTarget;
  function updateCamera() {
    if (!G.player) return;
    const [x, z] = toScene(G.player.x, G.player.y);
    camTarget.lerp(new THREE.Vector3(x, 30, z), 0.12);
    camera.position.lerp(new THREE.Vector3(x + camOffset.x, camOffset.y, z + camOffset.z), 0.12);
    camera.lookAt(camTarget);
  }

  function mouseAim3D() {
    if (!G.player) return null;
    const ndc = new THREE.Vector2(
      (Input.mouse.x / window.innerWidth) * 2 - 1,
      -(Input.mouse.y / window.innerHeight) * 2 + 1
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const t = -ray.ray.origin.y / ray.ray.direction.y;
    if (t < 0) return null;
    const hit = ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
    const wx = hit.x + HALF, wy = hit.z + HALF;
    const dx = wx - G.player.x, dy = wy - G.player.y;
    const d = Math.hypot(dx, dy);
    if (d < 5) return null;
    return { dx: dx/d, dy: dy/d };
  }

  // ---------------- main sync + render ----------------
  function sync(dt) {
    const alive = new Set();
    for (const u of G.units) {
      if (u.type === 'hero' && u.dead) {
        // let the death animation play out briefly, but only while the
        // team would still have vision of where the hero fell — matches
        // the 2D renderer, which never shows a hero outside fog of war
        const withinWindow = (G.time - (u._deathT || G.time)) <= 1.4;
        if (!withinWindow || !isVisibleTo(u, G.player)) continue;
      } else if (u.type === 'hero' && !isVisibleTo(u, G.player)) {
        const e = unitMeshes.get(u.id); if (e) e.group.visible = false;
        continue;
      }
      if (u.dead && u.type !== 'hero') continue;
      alive.add(u.id);
      let e = unitMeshes.get(u.id);
      if (!e) {
        e = u.type === 'hero' ? createHero(u) : createGeneric(u);
        unitMeshes.set(u.id, e);
      }
      e.group.visible = true;
      if (u.type === 'hero') updateHero(e, u, dt);
      else updateGeneric(e, u);
    }
    for (const [id, e] of unitMeshes) {
      if (!alive.has(id)) {
        scene.remove(e.group);
        scene.remove(e.hpBar);
        unitMeshes.delete(id);
      }
    }
  }

  function render(dt) {
    if (!G.running) { renderer.render(scene, camera); return; }
    if (!groundMesh && mapCanvas) buildGround();
    if (!groundMesh) { renderer.render(scene, camera); return; } // one-frame gap while it builds
    sync(dt);
    syncProjectiles();
    syncZones();
    syncFxFromEngine();
    updateFx(dt);
    updateCamera();
    // updateFogMask() is what actually paints the fogMask canvas each tick —
    // the 2D renderer calls it as part of its own render(), which we never
    // run here, so we call it ourselves to keep the fog-of-war texture live
    updateFogMask();
    if (fogTexture) fogTexture.needsUpdate = true;
    // billboard all HP bars toward the camera
    scene.traverse(o => { if (o.isGroup && o.renderOrder === 10) o.quaternion.copy(camera.quaternion); });
    renderer.render(scene, camera);
  }

  return { init, render, _debug: () => ({ scene, unitMeshes, heroPool }) };
})();
