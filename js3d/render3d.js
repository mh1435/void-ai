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
  let heroModels = null;              // { modelName: { scene, animations } } — KayKit templates, cloned per hero
  const unitMeshes = new Map();      // unit.id -> entry
  const projMeshes = new Map();      // projectile obj -> mesh
  const fxMeshes = [];               // transient effects
  const staticScenery = [];

  const TEAM_HEX = { blue: 0x3fa9ff, red: 0xff4d5e };
  const TEAM_HEX_D = { blue: 0x1c5c94, red: 0x8f2430 };

  function init(models) {
    heroModels = models; // { Knight: { scene, animations }, Mage: {...}, ... }
    // Normalise skin weights on every source mesh once (geometry is shared by
    // all clones of a model). Some mobile GPUs render vertices whose bone
    // weights don't sum to 1 as flung "spikes" stretching off the character —
    // the classic cause of a stray stretched limb. This makes the rig robust
    // across devices. Also disable frustum culling on the source so a wrong
    // skinned bounding sphere can't pop the whole character off-screen.
    for (const name in heroModels) {
      heroModels[name].scene.traverse(o => {
        if (o.isSkinnedMesh) {
          o.frustumCulled = false;
          if (o.geometry && o.geometry.attributes.skinWeight) o.normalizeSkinWeights();
        }
      });
    }
    camOffset = new THREE.Vector3(0, 820, 700); // pulled back + up so much more of the map is visible
    camTarget = new THREE.Vector3();

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x1a2a3a);
    scene.fog = new THREE.Fog(0x2a3d4e, 1600, 3400);

    camera = new THREE.PerspectiveCamera(42, window.innerWidth / window.innerHeight, 1, 4000);

    const canvas = document.getElementById('game3d');
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    resize();
    window.addEventListener('resize', resize);

    // lighting: soft ambient fill + a directional "sun" casting shadows
    scene.add(new THREE.HemisphereLight(0x9fc4ff, 0x263a26, 1.1));
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
    // backdrop: the fixed camera offset means a hero standing near a map
    // corner/edge (e.g. right at spawn) puts a large chunk of the frustum
    // — especially on a wide phone aspect ratio — looking past the WORLD x
    // WORLD ground plane's edge into pure emptiness, which rendered as a
    // flat, hard-edged block of the scene background color (looked like a
    // solid black half of the screen). A large dark plane just beneath the
    // real ground fills that empty space with plausible "distant terrain"
    // that scene.fog then fades to the background color, instead of nothing.
    const voidGeo = new THREE.PlaneGeometry(WORLD * 8, WORLD * 8, 1, 1);
    voidGeo.rotateX(-Math.PI / 2);
    const voidMat = new THREE.MeshStandardMaterial({ color: 0x12241f, roughness: 1 });
    const voidMesh = new THREE.Mesh(voidGeo, voidMat);
    voidMesh.position.y = -4;
    voidMesh.receiveShadow = true;
    scene.add(voidMesh);

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
    fogTexture = new THREE.CanvasTexture(typeof fogSmooth !== 'undefined' && fogSmooth ? fogSmooth : fogMask);
    fogTexture.colorSpace = THREE.SRGBColorSpace;
    const fogMat = new THREE.MeshBasicMaterial({ map: fogTexture, transparent: true, depthWrite: false });
    fogMesh = new THREE.Mesh(fogGeo, fogMat);
    fogMesh.position.y = 6;
    fogMesh.renderOrder = 5;
    scene.add(fogMesh);
  }

  // clone a loaded KayKit prop model scaled so its bounding-box height equals
  // `height` scene units; returns null when the prop didn't load (callers
  // fall back to the old procedural shapes)
  function cloneProp(name, height) {
    const src = heroModels[name];
    if (!src || !src.scene) return null;
    if (!src._size) {
      const box = new THREE.Box3().setFromObject(src.scene);
      src._size = box.getSize(new THREE.Vector3());
    }
    const obj = src.scene.clone(true);
    const s = height / Math.max(0.001, src._size.y);
    obj.scale.setScalar(s);
    obj.traverse(o => {
      if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
    });
    return obj;
  }

  // rocks + bushes are static, built once from the same data the 2D map uses
  function buildScenery() {
    const rockGeo = new THREE.IcosahedronGeometry(1, 1);
    jitterGeometry(rockGeo, 0.28);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x454c56, roughness: 0.9, flatShading: true });
    const rockProps = ['rock_single_A', 'rock_single_B', 'rock_single_C'];
    let ri = 0;
    for (const r of ROCKS) {
      const [x, z] = toScene(r.x, r.y);
      const prop = cloneProp(rockProps[ri++ % rockProps.length], r.r * 0.8);
      if (prop) {
        prop.position.set(x, 0, z);
        prop.rotation.y = Math.random() * Math.PI * 2;
        scene.add(prop); staticScenery.push(prop);
        continue;
      }
      const m = new THREE.Mesh(rockGeo, rockMat);
      m.position.set(x, r.r * 0.55, z);
      m.scale.setScalar(r.r * 0.85);
      m.rotation.y = Math.random() * Math.PI * 2;
      m.castShadow = true; m.receiveShadow = true;
      scene.add(m); staticScenery.push(m);
    }

    // forest wall framing the arena borders (mirrors the 2D map's canopy):
    // rings of KayKit trees just inside the world edge, skipping lane mouths
    if (heroModels['tree_single_A']) {
      let ti = 0;
      const treeAt = (wx, wy) => {
        if (distToLanes && distToLanes(wx, wy) < 170) return;   // keep lanes readable
        const h = 60 + Math.random() * 55;
        const prop = cloneProp(ti++ % 2 ? 'tree_single_A' : 'tree_single_B', h);
        if (!prop) return;
        const [x, z] = toScene(wx, wy);
        prop.position.set(x, 0, z);
        prop.rotation.y = Math.random() * Math.PI * 2;
        scene.add(prop); staticScenery.push(prop);
      };
      for (let d = 60; d < WORLD - 60; d += 130 + Math.random() * 90) {
        treeAt(d + Math.random()*50, 40 + Math.random()*70);
        treeAt(d + Math.random()*50, WORLD - 40 - Math.random()*70);
        treeAt(40 + Math.random()*70, d + Math.random()*50);
        treeAt(WORLD - 40 - Math.random()*70, d + Math.random()*50);
      }
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

  // ---------------- hero (KayKit fantasy character) instances ----------------
  // Heroes are stylised low-poly fantasy characters from the KayKit Adventurers
  // pack (CC0 / public domain — see assets/models/kaykit/KAYKIT_LICENSE.txt).
  // Every model is fully rigged and ships baked animation clips, so — unlike
  // the old VRM avatar, which had none and had to be hand-posed bone by bone —
  // we just drive a THREE.AnimationMixer and cross-fade between each model's
  // own Idle / Walk / Run / Attack / Death clips.
  const HERO_SCALE = 17; // KayKit chars are ~2.5u tall; brings them to game scale

  // hero id -> which KayKit model plays it (role-appropriate silhouette)
  const HERO_MODEL = {
    kael:  'Rogue_Hooded', // hooded rogue = assassin
    nyra:  'Mage',         // robed spellcaster
    grom:  'Knight',       // armoured tank
    lyra:  'Rogue',        // nimble marksman
    vex:   'Mage',         // second caster, tinted apart from Nyra
    thane: 'Barbarian',    // broad brawler
    isolde:'Rogue_Hooded', // hooded frost caster (icy tint sets her apart from Kael)
  };

  // subtle per-hero build so silhouettes still read by role at a glance
  const HERO_BUILD = {
    kael: 0.98, nyra: 0.98, grom: 1.14, lyra: 1.0, vex: 0.98, thane: 1.1, isolde: 0.98,
  };

  // light colour push toward each hero's signature colour — keeps the model's
  // own textured detail but reinforces identity (and pulls the two Mages,
  // Nyra vs Vex, visibly apart). 0 = untinted original texture.
  const HERO_TINT = { amount: 0.28 };

  // baked clip names used from the pack's 75 (see kaykit_inspect.html)
  const CLIP = { idle: 'Idle', walk: 'Walking_A', run: 'Running_A', death: 'Death_A' };
  const HERO_ATTACK_CLIP = {
    kael:  '1H_Melee_Attack_Stab',   // quick dagger jab
    nyra:  'Spellcast_Shoot',        // cast
    grom:  '1H_Melee_Attack_Chop',   // sword swing
    lyra:  '1H_Ranged_Shoot',        // crossbow shot
    vex:   'Spellcast_Shoot',        // cast
    thane: '2H_Melee_Attack_Chop',   // heavy axe
    isolde:'Spellcast_Shoot',        // frost cast
  };

  function createHero(u) {
    const modelName = HERO_MODEL[u.def.id] || 'Knight';
    const src = heroModels[modelName];
    const build = HERO_BUILD[u.def.id] || 1;

    // SkeletonUtils.clone() deep-clones the skinned mesh AND its skeleton, so
    // each hero animates independently — a plain Object3D.clone() would share
    // one skeleton and every hero of the same model would move in lockstep.
    const root = SkeletonClone(src.scene);
    root.scale.setScalar(HERO_SCALE * build);

    // clone materials per hero (the source materials are shared across every
    // clone of a model) and push each lightly toward the hero's colour, so the
    // two Mages read as different heroes and every hero keeps its identity
    const tint = new THREE.Color(u.def.color);
    root.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      o.frustumCulled = false; // skinned bounds can be wrong at this scale; don't cull
      const mats = (Array.isArray(o.material) ? o.material : [o.material]).map(m => {
        const c = m.clone();
        if (c.color) c.color.lerp(tint, HERO_TINT.amount);
        return c;
      });
      o.material = Array.isArray(o.material) ? mats : mats[0];
    });

    const group = new THREE.Group();
    group.add(root);

    // MOBA-style selection ring: ally (your team) reads blue, enemy reads red,
    // relative to the player — the same friend/foe cue MLBB uses on the ground.
    const ally = G.player && u.team === G.player.team;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(24, 28, 24),
      new THREE.MeshBasicMaterial({ color: ally ? 0x49b0ff : 0xff4d5e, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI/2; ring.position.y = 1;
    group.add(ring);

    // baked-clip animation: one mixer per hero, actions built from the shared
    // clips (retargeted by bone name onto this clone's identical skeleton)
    const mixer = new THREE.AnimationMixer(root);
    const clips = {};
    const find = (n) => THREE.AnimationClip.findByName(src.animations, n);
    for (const key of ['idle', 'walk', 'run', 'death']) {
      const c = find(CLIP[key]); if (c) clips[key] = mixer.clipAction(c);
    }
    const atk = find(HERO_ATTACK_CLIP[u.def.id] || '1H_Melee_Attack_Chop');
    if (atk) clips.attack = mixer.clipAction(atk);
    if (clips.death) { clips.death.setLoop(THREE.LoopOnce, 1); clips.death.clampWhenFinished = true; }
    if (clips.attack) { clips.attack.setLoop(THREE.LoopOnce, 1); clips.attack.clampWhenFinished = false; }
    if (clips.idle) clips.idle.play();
    mixer.update(0); // pose immediately so the first rendered frame isn't a raw T-pose

    scene.add(group);
    const bar = makeBar(58);
    return {
      group, root, mixer, clips, current: clips.idle ? 'idle' : null,
      attackEnd: 0, wasAttacking: false,
      hpBar: bar, barHeight: HERO_SCALE * build * 2.6, ring, team: u.team, kind: 'hero',
    };
  }

  // ---------------- hero animation state machine ----------------
  // Cross-fade the base locomotion loop (idle/walk/run) and layer a one-shot
  // attack / death clip on top via the mixer.
  function setAction(e, name, fade = 0.18) {
    if (e.current === name) return;
    const next = e.clips[name];
    if (!next) return;
    const prev = e.current && e.clips[e.current];
    next.enabled = true;
    next.setEffectiveTimeScale(1);
    next.setEffectiveWeight(1);
    next.reset();
    next.play();
    if (prev && prev !== next) prev.crossFadeTo(next, fade, false);
    e.current = name;
  }

  // lighter-weight action switcher for non-hero animated units (minions)
  function setGenericAction(anim, name, fade = 0.15) {
    if (anim.current === name || !anim.clips[name]) return;
    const next = anim.clips[name];
    next.reset(); next.play();
    const prev = anim.clips[anim.current];
    if (prev && prev !== next) prev.crossFadeTo(next, fade, false);
    anim.current = name;
  }

  function updateHero(e, u, dt) {
    const [x, z] = toScene(u.x, u.y);
    e.group.position.set(x, 0, z);
    // KayKit models face +Z in bind pose; the game's facing=0 points +X, and
    // the scene is Y-up, so this maps facing onto the model's forward correctly.
    e.group.rotation.y = -u.facing + Math.PI / 2;
    e.ring.material.opacity = u.isPlayer ? 1 : 0.7;

    e.group.visible = !u.dead || (G.time - (u._deathT || (u._deathT = G.time))) < 1.4;
    e.hpBar.visible = e.group.visible;
    if (e.group.visible) { e.hpBar.position.set(x, e.barHeight, z); updateBar(e.hpBar, u); }
    if (!e.group.visible) { return; }

    if (u.dead) {
      setAction(e, 'death', 0.12);
    } else {
      // a one-shot attack clip fires on the rising edge of "attacking" and
      // owns the body until its clip finishes, then locomotion resumes
      const attacking = (u._hitT !== undefined && G.time - u._hitT < 0.15) ||
        u.atkTimer > (u.atkCd / u.asMult) * 0.6;
      if (e.clips.attack && attacking && !e.wasAttacking) {
        e.attackEnd = G.time + Math.min(e.clips.attack.getClip().duration, 0.7);
        setAction(e, 'attack', 0.06);
      }
      e.wasAttacking = attacking;

      if (G.time < e.attackEnd) {
        // let the attack play out (setAction already switched us to it)
      } else {
        const running = u.moving && u._moving !== false;
        const walking = u.moving && !running;
        setAction(e, running ? 'run' : walking ? 'walk' : 'idle');
      }
    }

    e.mixer.update(dt);
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
      // rigged KayKit skeleton soldiers (melee grunt / robed caster), tinted
      // toward their team color; capsule-bot fallback if the pack didn't load
      const modelName = u.ranged ? 'Skeleton_Mage' : 'Skeleton_Minion';
      const src = heroModels[modelName];
      if (src && typeof SkeletonClone === 'function') {
        const root = SkeletonClone(src.scene);
        root.scale.setScalar(HERO_SCALE * 0.7);
        const tint = new THREE.Color(TEAM_HEX[u.team]);
        root.traverse(o => {
          if (!o.isMesh) return;
          o.castShadow = true;
          o.frustumCulled = false;
          if (o.isSkinnedMesh && o.geometry && o.geometry.attributes.skinWeight) o.normalizeSkinWeights();
          const mats = (Array.isArray(o.material) ? o.material : [o.material]).map(m => {
            const c = m.clone();
            if (c.color) c.color.lerp(tint, 0.4);
            return c;
          });
          o.material = Array.isArray(o.material) ? mats : mats[0];
        });
        group.add(root);
        const mixer = new THREE.AnimationMixer(root);
        const find = n => THREE.AnimationClip.findByName(src.animations, n);
        const clips = {};
        for (const [key, nm] of [['walk','Walking_A'], ['idle','Idle']]) {
          const c = find(nm); if (c) clips[key] = mixer.clipAction(c);
        }
        const atk = find(u.ranged ? 'Spellcast_Shoot' : '1H_Melee_Attack_Chop');
        if (atk) { clips.attack = mixer.clipAction(atk); clips.attack.setLoop(THREE.LoopOnce, 1); }
        const start = clips.walk || clips.idle;
        if (start) start.play();
        mixer.update(Math.random() * 0.8);   // desync the marching column, skip T-pose
        group.userData.anim = { mixer, clips, current: clips.walk ? 'walk' : 'idle', attackEnd: 0, wasAttacking: false };
        h = 42;
      } else {
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
      }
    } else if (u.type === 'jungle') {
      const s = u.boss ? 2.1 : 1;
      const bodyGeo = sharedGeo('jungleBody', () => {
        const g = new THREE.IcosahedronGeometry(1, 1);
        jitterGeometry(g, 0.22);
        return g;
      });
      const buffHex = (u.buffType && typeof BUFF_CAMPS !== 'undefined' && BUFF_CAMPS[u.buffType])
        ? new THREE.Color(BUFF_CAMPS[u.buffType].color).getHex() : 0xc77dff;
      const mat = new THREE.MeshStandardMaterial({
        color: u.boss ? 0x4a2a63 : (u.buffType ? new THREE.Color(buffHex).multiplyScalar(0.4).getHex() : 0x4d3a5e),
        roughness: 0.75, flatShading: true, emissive: buffHex, emissiveIntensity: u.buffType ? 0.3 : 0.12 });
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
      // real KayKit turret model in team colors, procedural column fallback
      const prop = cloneProp('building_tower_A_' + u.team, 96);
      if (prop) {
        group.add(prop);
      } else {
        const col = sharedGeo('towerCol', () => new THREE.CylinderGeometry(16, 22, 90, 8));
        const mat = sharedMat('towerCol_' + u.team, () => new THREE.MeshStandardMaterial({ color: TEAM_HEX_D[u.team], roughness: 0.7, metalness: 0.15 }));
        const c = new THREE.Mesh(col, mat); c.position.y = 45; c.castShadow = true; c.receiveShadow = true;
        group.add(c);
      }
      // crystal material is NOT shared: its emissiveIntensity is mutated
      // per-instance each frame (invulnerability glow); the floating crystal
      // stays even over the model — it's the shield/targetable indicator
      const crystalMat = new THREE.MeshStandardMaterial({ color: TEAM_HEX[u.team], emissive: TEAM_HEX[u.team], emissiveIntensity: 0.9 });
      const crystal = new THREE.Mesh(sharedGeo('towerCrystal', () => new THREE.OctahedronGeometry(13, 0)), crystalMat);
      crystal.position.y = prop ? 118 : 104;
      group.add(crystal);
      group.userData.crystal = crystal;
      h = prop ? 126 : 112;
    } else if (u.type === 'core') {
      // team castle as the Void Core seat, procedural pedestal fallback
      const prop = cloneProp('building_castle_' + u.team, 110);
      if (prop) {
        group.add(prop);
      } else {
        const baseMat = sharedMat('coreBase_' + u.team, () => new THREE.MeshStandardMaterial({ color: TEAM_HEX_D[u.team], roughness: 0.6 }));
        const base = new THREE.Mesh(sharedGeo('coreBase', () => new THREE.CylinderGeometry(60, 66, 20, 8)), baseMat);
        base.position.y = 10; base.castShadow = true; base.receiveShadow = true;
        group.add(base);
      }
      const crystalMat = sharedMat('coreCrystal_' + u.team, () =>
        new THREE.MeshStandardMaterial({ color: TEAM_HEX[u.team], emissive: TEAM_HEX[u.team], emissiveIntensity: 1 }));
      // with the castle model the crystal is a modest beacon over the keep,
      // not the structure itself
      const crystal = new THREE.Mesh(
        sharedGeo(prop ? 'coreCrystalSmall' : 'coreCrystal', () => new THREE.OctahedronGeometry(prop ? 16 : 34, 0)),
        crystalMat);
      crystal.position.y = prop ? 132 : 55;
      group.add(crystal);
      group.userData.crystal = crystal;
      h = prop ? 140 : 100;
    }
    scene.add(group);
    const barW = u.type === 'core' ? 90 : u.type === 'tower' ? 60 : u.type === 'jungle' ? (u.boss ? 110 : 40) : 26;
    const bar = makeBar(barW);
    return { group, hpBar: bar, barHeight: h + 14, kind: u.type };
  }

  function updateGeneric(e, u, dt) {
    const [x, z] = toScene(u.x, u.y);
    e.group.position.set(x, 0, z);
    if (u.type === 'minion') e.group.rotation.y = -u.facing + Math.PI/2;
    // animated skeleton minions: walk loop, one-shot attack on the swing edge
    const anim = e.group.userData.anim;
    if (anim) {
      const attacking = u.atkTimer > 0 && u.atkTimer > u.atkCd * 0.6;
      if (anim.clips.attack && attacking && !anim.wasAttacking) {
        anim.attackEnd = G.time + Math.min(anim.clips.attack.getClip().duration, 0.8);
        setGenericAction(anim, 'attack', 0.06);
      }
      anim.wasAttacking = attacking;
      if (G.time >= anim.attackEnd) setGenericAction(anim, u.moving !== false ? 'walk' : 'idle');
      anim.mixer.update(dt || 0.016);
    }
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

  // floating combat text (damage / heal / IMMUNE) — the iconic MOBA number
  // pop. The sim already emits these as 'text' FX (for the player's own
  // damage dealt/taken); we draw each as a camera-facing sprite that rises
  // and fades, rendered on top of everything like MLBB's damage numbers.
  function makeTextSprite(text, color, big) {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 128;
    const c = cv.getContext('2d');
    c.font = 'bold ' + (big ? 92 : 68) + 'px Rajdhani, Arial, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 9; c.lineJoin = 'round'; c.strokeStyle = 'rgba(0,0,0,0.8)';
    c.strokeText(text, 128, 64);
    c.fillStyle = color || '#ffffff';
    c.fillText(text, 128, 64);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false }));
    const h = big ? 52 : 38;
    sp.scale.set(h * 2, h, 1);
    sp.renderOrder = 20;
    return sp;
  }

  function spawnTextFX(x, y, text, color, big) {
    const sp = makeTextSprite(text, color, big);
    const [sx, sz] = toScene(x, y);
    const baseY = 95;
    sp.position.set(sx, baseY, sz);
    scene.add(sp);
    fxMeshes.push({ mesh: sp, t: 0, dur: 0.9, kind: 'text', baseY });
  }

  function syncFxFromEngine() {
    // FX is the shared 2D engine's effects array; it's mutated by splice as
    // entries expire (not just appended to), so track "already spawned" per
    // entry rather than by array index/length — an index-based cursor would
    // silently stop working the first time anything ahead of it expires.
    // Ring events become ground rings; text events become floating combat
    // numbers. (flashes/slashes are still skipped — the model's own attack
    // animation and hit read cover those.)
    for (const e of FX) {
      if (e._seen3d) continue;
      if (e.type === 'ring' || e.type === 'shockwave') { e._seen3d = true; spawnRingFX(e.x, e.y, e.color); }
      else if (e.type === 'text') { e._seen3d = true; spawnTextFX(e.x, e.y, e.text, e.color, e.big); }
    }
  }

  // ---------------- skill drag-aim preview (range ring + arrow on the ground) ----------------
  let aim3d = null;
  function updateAimPreview() {
    const ap = G.aimPreview;
    const show = !!(ap && G.player && !G.player.dead);
    if (!aim3d) {
      if (!show) return;
      const mat = () => new THREE.MeshBasicMaterial({ color: 0x7df9ff, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false });
      const group = new THREE.Group();
      const range = new THREE.Mesh(new THREE.RingGeometry(0.975, 1, 48), mat());
      range.rotation.x = -Math.PI/2; range.material.opacity = 0.3;
      const shaft = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat());
      shaft.rotation.x = -Math.PI/2; shaft.material.opacity = 0.28;
      const head = new THREE.Mesh(new THREE.CircleGeometry(1, 3), mat());
      head.rotation.x = -Math.PI/2; head.material.opacity = 0.5;
      const reticle = new THREE.Mesh(new THREE.RingGeometry(0.82, 1, 32), mat());
      reticle.rotation.x = -Math.PI/2; reticle.material.opacity = 0.85;
      group.add(range, shaft, head, reticle);
      group.renderOrder = 6;
      scene.add(group);
      aim3d = { group, range, shaft, head, reticle };
    }
    aim3d.group.visible = show;
    if (!show) return;
    const [px, pz] = toScene(G.player.x, G.player.y);
    const r = ap.range;
    aim3d.group.position.set(px, 6, pz);
    aim3d.group.rotation.y = -Math.atan2(ap.dy, ap.dx);
    aim3d.range.scale.setScalar(r);
    const len = Math.max(24, r - 46);
    aim3d.shaft.scale.set(len, 20, 1);
    aim3d.shaft.position.set(len / 2 + 14, 0, 0);
    aim3d.head.scale.setScalar(30);
    aim3d.head.position.set(len + 26, 0, 0);
    aim3d.reticle.scale.setScalar(28);
    aim3d.reticle.position.set(r, 0.5, 0);
  }

  function updateFx(dt) {
    for (let i = fxMeshes.length - 1; i >= 0; i--) {
      const f = fxMeshes[i];
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) {
        scene.remove(f.mesh);
        if (f.kind === 'text') f.mesh.material.map.dispose();
        else f.mesh.geometry.dispose();
        f.mesh.material.dispose();
        fxMeshes.splice(i, 1);
        continue;
      }
      if (f.kind === 'text') {
        f.mesh.position.y = f.baseY + k * 60;            // rise
        f.mesh.material.opacity = k < 0.65 ? 1 : 1 - (k - 0.65) / 0.35; // hold then fade
      } else {
        const r = f.r0 + (f.r1 - f.r0) * k;
        f.mesh.scale.setScalar(r);
        f.mesh.material.opacity = (1 - k) * 0.9;
      }
    }
  }

  // ---------------- camera ----------------
  // instantiated lazily inside init() — THREE isn't defined yet at the time
  // this classic script first runs (main3d.js, a deferred module, is what
  // sets window.THREE, and deferred modules execute after classic scripts)
  let camOffset, camTarget;
  // Hard-follow camera: every frame, plant the camera at a fixed offset from
  // the player and look straight at them. No lerp / no state flag — it can't
  // drift, lag, or freeze, so the hero is ALWAYS dead-centre. (An earlier
  // lerp+snap version worked in isolation but could get skipped by an early
  // return in render(); this runs unconditionally and is called before any
  // early return, so nothing can leave the camera stranded.)
  function updateCamera() {
    if (!G.player || !camOffset) return;
    const [x, z] = toScene(G.player.x, G.player.y);
    camTarget.set(x, 30, z);
    camera.position.set(x + camOffset.x, camOffset.y, z + camOffset.z);
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
      else updateGeneric(e, u, dt);
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
    updateCamera(); // FIRST — so the camera tracks the player even on frames that early-return below
    if (!G.running) { renderer.render(scene, camera); return; }
    if (!groundMesh && mapCanvas) buildGround();
    if (!groundMesh) { renderer.render(scene, camera); return; } // one-frame gap while it builds
    sync(dt);
    syncProjectiles();
    syncZones();
    syncFxFromEngine();
    updateFx(dt);
    updateAimPreview();
    // updateFogMask() is what actually paints the fogMask canvas each tick —
    // the 2D renderer calls it as part of its own render(), which we never
    // run here, so we call it ourselves to keep the fog-of-war texture live
    updateFogMask();
    if (fogTexture) fogTexture.needsUpdate = true;
    // billboard all HP bars toward the camera
    scene.traverse(o => { if (o.isGroup && o.renderOrder === 10) o.quaternion.copy(camera.quaternion); });
    renderer.render(scene, camera);
  }

  return { init, render, _debug: () => ({ scene, unitMeshes, heroModels, camera, renderer }) };
})();
