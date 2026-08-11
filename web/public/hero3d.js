/**
 * hero3d.js — the 0x sculpture.
 *
 * Two extruded solids in a lit room: a squircle ring (the 0) and a crossed pair
 * of rounded bars (the x). Matte, unlit by any neon, sitting on a plane that
 * catches a real shadow — the whole point is that it reads as an *object*, not
 * as a graphic. Colours come from the page's CSS custom properties, so the
 * sculpture themes itself along with everything else.
 *
 * Contract: startHero(canvas, opts) throws on no-WebGL; the caller hides the
 * canvas and the static fallback glyph stays. Nothing else on the page depends
 * on this module loading.
 */
import * as THREE from './vendor/three.module.min.js';

const token = (name, fallback) => {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
};

/* a superellipse ring reads as a technical zero: rounder than a rectangle,
   squarer than an ellipse. n=4 is the squircle; lower is closer to an oval. */
function superellipse(rx, ry, n, seg) {
  const pts = [];
  for (let i = 0; i < seg; i++) {
    const t = (i / seg) * Math.PI * 2;
    const c = Math.cos(t);
    const s = Math.sin(t);
    pts.push(new THREE.Vector2(
      rx * Math.sign(c) * Math.pow(Math.abs(c), 2 / n),
      ry * Math.sign(s) * Math.pow(Math.abs(s), 2 / n),
    ));
  }
  return pts;
}

function roundedBar(w, h, r) {
  const x = w / 2;
  const y = h / 2;
  const s = new THREE.Shape();
  s.moveTo(-x + r, -y);
  s.lineTo(x - r, -y);
  s.quadraticCurveTo(x, -y, x, -y + r);
  s.lineTo(x, y - r);
  s.quadraticCurveTo(x, y, x - r, y);
  s.lineTo(-x + r, y);
  s.quadraticCurveTo(-x, y, -x, y - r);
  s.lineTo(-x, -y + r);
  s.quadraticCurveTo(-x, -y, -x + r, -y);
  return s;
}

export function startHero(canvas, opts = {}) {
  const host = canvas.parentElement || canvas;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const lean = opts.lean ?? (innerWidth < 760 || (navigator.hardwareConcurrency || 8) <= 4);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: !lean,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, lean ? 1.5 : 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = lean ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);

  /* --- material: matte, near-white, one accent piece ------------------- */
  const bone = new THREE.MeshStandardMaterial({
    color: new THREE.Color(token('--three-bone', '#f7f5f1')),
    roughness: 0.66,
    metalness: 0,
  });
  const accent = new THREE.MeshStandardMaterial({
    color: new THREE.Color(token('--three-accent', '#2333c4')),
    roughness: 0.44,
    metalness: 0,
  });

  const extrude = {
    depth: 0.36,
    bevelEnabled: true,
    bevelThickness: 0.045,
    bevelSize: 0.045,
    bevelOffset: 0,
    bevelSegments: lean ? 1 : 3,
    curveSegments: lean ? 4 : 12,
    steps: 1,
  };

  /* --- the 0 ----------------------------------------------------------- */
  const seg = lean ? 40 : 88;
  const zeroShape = new THREE.Shape(superellipse(0.72, 1.06, 3.4, seg));
  zeroShape.holes.push(new THREE.Path(superellipse(0.38, 0.66, 3.0, seg).reverse()));
  const zeroGeo = new THREE.ExtrudeGeometry(zeroShape, extrude);
  zeroGeo.center();
  const zero = new THREE.Mesh(zeroGeo, bone);
  zero.position.set(-0.96, 0.02, 0.2);
  zero.rotation.y = 0.14;
  zero.castShadow = true;
  zero.receiveShadow = true;

  /* --- the x: two crossed bars, same bevel, same depth ------------------ */
  const barGeo = new THREE.ExtrudeGeometry(roundedBar(2.02, 0.42, 0.2), extrude);
  barGeo.center();
  const cross = new THREE.Group();
  for (const a of [Math.PI / 4, -Math.PI / 4]) {
    const bar = new THREE.Mesh(barGeo, accent);
    bar.rotation.z = a;
    bar.castShadow = true;
    bar.receiveShadow = true;
    cross.add(bar);
  }
  cross.position.set(1.06, 0.02, -0.24);
  cross.rotation.y = -0.2;

  const sculpture = new THREE.Group();
  sculpture.add(zero, cross);
  scene.add(sculpture);

  /* --- the room: one key, one fill, a floor that only shows shadow ------ */
  scene.add(new THREE.HemisphereLight(0xffffff, 0xdedad2, 1.05));

  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3.2, 5.6, 4.4);
  key.castShadow = true;
  key.shadow.mapSize.set(lean ? 512 : 1024, lean ? 512 : 1024);
  key.shadow.camera.top = 4;
  key.shadow.camera.bottom = -4;
  key.shadow.camera.left = -4;
  key.shadow.camera.right = 4;
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 18;
  key.shadow.bias = -0.0012;
  key.shadow.radius = lean ? 2 : 4;
  scene.add(key);

  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(-4.5, 1.2, -2.6);
  scene.add(fill);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 24),
    new THREE.ShadowMaterial({ opacity: parseFloat(token('--three-shadow', '0.15')) }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -1.5;
  floor.receiveShadow = true;
  scene.add(floor);

  /* --- framing: always fit the composition, however narrow the box ------ */
  const FIT_W = 4.3;
  const FIT_H = 2.95;
  function resize() {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    camera.aspect = w / h;
    const half = Math.tan((camera.fov * Math.PI) / 360);
    camera.position.z = Math.max(FIT_H / 2 / half, FIT_W / 2 / half / camera.aspect) * 1.1;
    camera.position.y = 0.5;
    camera.lookAt(0, -0.06, 0);
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
  }
  resize();

  if (typeof ResizeObserver === 'function') new ResizeObserver(resize).observe(host);
  else addEventListener('resize', resize, { passive: true });

  /* --- motion ----------------------------------------------------------- */
  const state = { px: 0, py: 0, tx: 0, ty: 0, scroll: 0 };

  function render() {
    renderer.render(scene, camera);
  }

  if (reduced) {
    // one composed frame, then nothing moves again.
    render();
    addEventListener('resize', () => { resize(); render(); }, { passive: true });
    return { render };
  }

  if (matchMedia('(hover: hover)').matches) {
    addEventListener('pointermove', (e) => {
      state.tx = (e.clientX / innerWidth) * 2 - 1;
      state.ty = (e.clientY / innerHeight) * 2 - 1;
    }, { passive: true });
  }

  addEventListener('scroll', () => {
    const span = Math.max(1, host.getBoundingClientRect().height + innerHeight * 0.5);
    state.scroll = Math.min(1, Math.max(0, scrollY / span));
  }, { passive: true });

  let visible = true;
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver(
      (entries) => { visible = entries[0].isIntersecting; },
      { threshold: 0 },
    ).observe(canvas);
  }

  const clock = new THREE.Clock();
  let t = 0;
  (function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(clock.getDelta(), 0.05);
    if (!visible || document.hidden) return;
    t += dt;

    state.px += (state.tx - state.px) * Math.min(1, dt * 3.4);
    state.py += (state.ty - state.py) * Math.min(1, dt * 3.4);

    sculpture.rotation.y = Math.sin(t * 0.3) * 0.34 + state.px * 0.36 + state.scroll * 0.38;
    sculpture.rotation.x = Math.sin(t * 0.23) * 0.09 - state.py * 0.2;
    sculpture.position.y = Math.sin(t * 0.55) * 0.055 - state.scroll * 0.4;
    render();
  })();

  return { render };
}
