// Разбитые очки: выстрел себе в глаз -> оба глаза видят трещины на «линзах» 5 с.
// createCrackedGlasses({ THREE, camera, renderer, shared }) -> { test(muzzle, dir) -> -1|0|1, trigger(eye), update(), dispose() }
// eye: 0 — левый, 1 — правый. Реальное время (не сценовые часы): это интерфейсный эффект.
const SIZE = 2048;
const PLANE_M = 0.75; // сторона плашки на расстоянии DIST_M от глаз
const DIST_M = 0.1;
const HOLD_MS = 4200;
const FADE_MS = 800;
const HIT_RADIUS_M = 0.035;
const HIT_RANGE_M = 2;
const HALF_IPD_M = 0.032;

export function createCrackedGlasses({ THREE, camera, renderer, shared }) {
  const mkTex = (size) => {
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.generateMipmaps = false;
    texture.minFilter = THREE.LinearFilter;
    return { canvas, texture, g: canvas.getContext('2d') };
  };
  const hitTex = mkTex(SIZE), faintTex = mkTex(1024);
  let g = hitTex.g; // текущий контекст рисования
  const mkMesh = (name, layer, map) => {
    const material = new THREE.MeshBasicMaterial({ map, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, opacity: 0 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(PLANE_M, PLANE_M), material);
    mesh.name = name;
    mesh.position.set(0, 0, -DIST_M);
    mesh.renderOrder = 990;
    mesh.frustumCulled = false;
    mesh.visible = false;
    mesh.layers.set(layer); // 1 — левый глаз, 2 — правый (WebXRManager), 0 — обычный вид
    camera.add(mesh);
    return mesh;
  };
  const lens = [mkMesh('scene-cracked-glasses-L', 1, hitTex.texture), mkMesh('scene-cracked-glasses-R', 2, hitTex.texture)];
  const mono = mkMesh('scene-cracked-glasses', 0, hitTex.texture); // вне VR
  const meshes = [...lens, mono];

  const rnd = (a, b) => a + Math.random() * (b - a);

  // ---- рисование трещин
  const line = (pts, w, alpha) => {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i += 1) g.lineTo(pts[i][0], pts[i][1]);
    g.lineWidth = w + 1.2;
    g.strokeStyle = `rgba(20,25,35,${alpha * 0.55})`; // тёмная кромка снизу-справа
    g.save(); g.translate(1.2, 1.2); g.stroke(); g.restore();
    g.lineWidth = w;
    g.strokeStyle = `rgba(245,250,255,${alpha})`;
    g.stroke();
  };
  const crack = (x, y, ang, len, w, alpha, depth, rays) => {
    const pts = [[x, y]];
    let cx = x, cy = y, a = ang;
    const step = rnd(40, 80);
    for (let d = 0; d < len; d += step) {
      a += rnd(-0.18, 0.18);
      cx += Math.cos(a) * step; cy += Math.sin(a) * step;
      pts.push([cx, cy]);
      rays?.push([cx, cy, d]);
      if (depth < 3 && Math.random() < 0.32) {
        crack(cx, cy, a + (Math.random() < 0.5 ? -1 : 1) * rnd(0.4, 0.9), (len - d) * rnd(0.3, 0.6), Math.max(1, w * 0.7), alpha * 0.9, depth + 1, null);
      }
    }
    line(pts, w, alpha);
  };
  const star = (x, y, count, reach, w, alpha, ringsOn) => {
    const base = rnd(0, Math.PI * 2);
    const ring = [];
    for (let i = 0; i < count; i += 1) {
      const rays = [];
      crack(x, y, base + (i / count) * Math.PI * 2 + rnd(-0.12, 0.12), reach * rnd(0.55, 1), w, alpha, 0, rays);
      ring.push(rays);
    }
    if (!ringsOn) return;
    for (const r of [2, 4, 7]) { // несколько колец трещин между лучами
      const pts = [];
      for (const rays of ring) { const p = rays[Math.min(r, rays.length - 1)]; if (p) pts.push([p[0], p[1]]); }
      if (pts.length > 3) {
        const cut = Math.floor(rnd(0, pts.length * 0.4)); // кольцо не замкнуто целиком
        line(pts.slice(cut).concat(pts.slice(0, Math.max(0, cut - 1))).slice(0, Math.floor(pts.length * rnd(0.6, 0.9))), 1.2, alpha * 0.8);
      }
    }
  };
  const chips = (x, y, n, r) => {
    for (let i = 0; i < n; i += 1) {
      const a = rnd(0, Math.PI * 2), d = Math.abs(rnd(-1, 1)) * r;
      const cx = x + Math.cos(a) * d, cy = y + Math.sin(a) * d, s = rnd(5, 22);
      g.beginPath();
      const k = 3 + Math.floor(Math.random() * 3);
      for (let j = 0; j < k; j += 1) {
        const aa = (j / k) * Math.PI * 2 + rnd(-0.4, 0.4);
        g.lineTo(cx + Math.cos(aa) * s * rnd(0.5, 1), cy + Math.sin(aa) * s * rnd(0.5, 1));
      }
      g.closePath();
      g.fillStyle = `rgba(235,242,250,${rnd(0.12, 0.4)})`;
      g.fill();
    }
    const grad = g.createRadialGradient(x, y, 0, x, y, r * 0.9); // лёгкая молочность у удара
    grad.addColorStop(0, 'rgba(235,242,250,0.22)');
    grad.addColorStop(1, 'rgba(235,242,250,0)');
    g.fillStyle = grad;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  };

  const paint = (eye) => {
    const clear = (t) => { t.g.clearRect(0, 0, t.canvas.width, t.canvas.height); t.g.lineCap = 'round'; t.g.lineJoin = 'round'; };
    // линза пострадавшего глаза: удар у её центра
    g = hitTex.g; clear(hitTex);
    const c = SIZE / 2;
    const ix = c + rnd(-90, 90), iy = c + rnd(-90, 90);
    chips(ix, iy, 70, 150);
    star(ix, iy, 15, 1100, 1.8, 0.95, true);
    star(ix, iy, 6, 500, 1.2, 0.8, false);
    hitTex.texture.needsUpdate = true;
    // вторая линза: несколько слабых трещин
    g = faintTex.g; clear(faintTex);
    const ox = rnd(350, 650), oy = rnd(350, 650);
    star(ox, oy, 4, 380, 1, 0.4, false);
    faintTex.texture.needsUpdate = true;
    lens[eye].material.map = hitTex.texture;
    lens[1 - eye].material.map = faintTex.texture;
    mono.material.map = hitTex.texture;
    for (const m of meshes) m.material.needsUpdate = true;
  };

  // ---- звук: хруст стекла (щелчок + звон осколков)
  let noise = null;
  const sound = () => {
    const gr = shared.audioGraph;
    if (!gr?.context) return;
    const c = gr.context;
    if (c.state === 'suspended') c.resume();
    const t0 = c.currentTime;
    if (!noise) {
      noise = c.createBuffer(1, Math.floor(c.sampleRate * 0.4), c.sampleRate);
      const d = noise.getChannelData(0);
      for (let i = 0; i < d.length; i += 1) d[i] = Math.random() * 2 - 1;
    }
    const out = c.createGain();
    out.gain.value = 0.9;
    out.connect(gr.master ?? c.destination);
    const n = c.createBufferSource();
    n.buffer = noise;
    const hp = c.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 2500;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.9, t0);
    ng.gain.exponentialRampToValueAtTime(0.001, t0 + 0.12);
    n.connect(hp); hp.connect(ng); ng.connect(out);
    n.start(t0); n.stop(t0 + 0.2);
    for (let i = 0; i < 9; i += 1) { // звонкие осколки
      const t = t0 + (i === 0 ? 0 : rnd(0.01, 0.35));
      const o = c.createOscillator();
      o.type = 'sine';
      o.frequency.value = rnd(3200, 9000);
      const og = c.createGain();
      og.gain.setValueAtTime(0.0001, t);
      og.gain.exponentialRampToValueAtTime(rnd(0.12, 0.3), t + 0.003);
      og.gain.exponentialRampToValueAtTime(0.0001, t + rnd(0.08, 0.25));
      o.connect(og); og.connect(out);
      o.start(t); o.stop(t + 0.3);
    }
    setTimeout(() => out.disconnect(), 800);
  };

  // ---- состояние
  let startMs = -1;
  const setOpacity = (o) => { for (const m of meshes) m.material.opacity = o; };
  const place = () => { // линзы — прямо перед своим глазом; вне VR — один слой по центру
    const cams = renderer.xr.isPresenting ? renderer.xr.getCamera().cameras : null;
    const xr = !!cams && cams.length >= 2;
    mono.visible = !xr;
    for (let i = 0; i < 2; i += 1) {
      lens[i].visible = xr;
      if (xr) {
        camera.updateWorldMatrix(true, false);
        lens[i].position.copy(eyeP[i].setFromMatrixPosition(cams[i].matrixWorld));
        camera.worldToLocal(lens[i].position);
        lens[i].position.z -= DIST_M;
      }
    }
  };
  const trigger = (eye = 0) => {
    paint(eye);
    startMs = performance.now();
    setOpacity(1);
    place();
    try { sound(); } catch { /* без звука */ }
  };

  const wp = new THREE.Vector3(), rt = new THREE.Vector3(), eyeP = [new THREE.Vector3(), new THREE.Vector3()], rel = new THREE.Vector3();
  const eyes = () => {
    const cams = renderer.xr.isPresenting ? renderer.xr.getCamera().cameras : null;
    if (cams && cams.length >= 2) {
      eyeP[0].setFromMatrixPosition(cams[0].matrixWorld);
      eyeP[1].setFromMatrixPosition(cams[1].matrixWorld);
      return eyeP;
    }
    camera.updateWorldMatrix(true, false);
    wp.setFromMatrixPosition(camera.matrixWorld);
    rt.set(1, 0, 0).transformDirection(camera.matrixWorld);
    eyeP[0].copy(wp).addScaledVector(rt, -HALF_IPD_M);
    eyeP[1].copy(wp).addScaledVector(rt, HALF_IPD_M);
    return eyeP;
  };
  // луч выстрела проходит у центра глаза: 0 — левый, 1 — правый, -1 — мимо
  const test = (muzzle, dir) => {
    let best = -1, bestD = HIT_RADIUS_M;
    const e = eyes();
    for (let i = 0; i < 2; i += 1) {
      rel.copy(e[i]).sub(muzzle);
      const t = rel.dot(dir);
      if (t <= 0 || t > HIT_RANGE_M) continue;
      const d = rel.addScaledVector(dir, -t).length();
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  };

  const update = () => {
    if (startMs < 0) return;
    const age = performance.now() - startMs;
    if (age >= HOLD_MS + FADE_MS) { startMs = -1; for (const m of meshes) m.visible = false; setOpacity(0); return; }
    place();
    setOpacity(age < HOLD_MS ? 1 : 1 - (age - HOLD_MS) / FADE_MS);
  };

  return {
    test, trigger, update,
    dispose() {
      for (const m of meshes) { m.removeFromParent(); m.geometry.dispose(); m.material.dispose(); }
      hitTex.texture.dispose();
      faintTex.texture.dispose();
    },
  };
}
