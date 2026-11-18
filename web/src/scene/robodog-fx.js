// Робопёс: электрические эффекты — искры, дуги и вспышки. Один InstancedMesh (один вызов
// отрисовки) из вытянутых «чёрточек» с аддитивным смешением: искра — чёрточка вдоль скорости, дуга —
// ломаная из чёрточек (тонкая бело-голубая сердцевина + широкое синее свечение), вспышка — три
// скрещённые чёрточки. Состояние — в типизированных массивах, без выделений памяти в кадре.
//
// Концы дуг привязаны к шарнирам пса (anchors — Object3D): дуга бежит вместе с ним. Каждые 30–50 мс
// дуга заново «ломается» (случайные смещения точек) и иногда гаснет на миг — так она трещит.
//
// createZapFx({ THREE, root, anchors }) → { sparks(point, normal, n, opts), flash(point, size),
//   arc(anchorA, pointA, anchorB, pointB, life, amp), update(dt), clear(), dispose() }
const SPARK_CAP = 140; // большая битва: общий бюджет искр (новые вытесняют случайные старые)
const ARC_CAP = 14;
const SEG = 8; // отрезков в дуге
const FLASH_CAP = 10;
const BOLT_CAP = 48; // пули пулемётов на спинах псов: красно-оранжевые трассеры, летят прямо
const CAP = SPARK_CAP + ARC_CAP * SEG * 2 + FLASH_CAP * 3 + BOLT_CAP * 2;

export function createZapFx({ THREE, root, anchors }) {
  const geometry = new THREE.BoxGeometry(1, 1, 1);
  geometry.translate(0, 0.5, 0); // от основания вверх: чёрточка из точки по направлению
  const material = new THREE.MeshBasicMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, CAP);
  mesh.name = 'robodog-fx';
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.setColorAt(0, new THREE.Color());
  mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false; // шейдер собирается сразу, а не на первом попадании
  mesh.renderOrder = 3;
  root.add(mesh);

  // ---- искры
  const sp = {
    px: new Float32Array(SPARK_CAP), py: new Float32Array(SPARK_CAP), pz: new Float32Array(SPARK_CAP),
    vx: new Float32Array(SPARK_CAP), vy: new Float32Array(SPARK_CAP), vz: new Float32Array(SPARK_CAP),
    age: new Float32Array(SPARK_CAP), life: new Float32Array(SPARK_CAP),
    r: new Float32Array(SPARK_CAP), g: new Float32Array(SPARK_CAP), b: new Float32Array(SPARK_CAP),
    sz: new Float32Array(SPARK_CAP), // размер чёрточки (большие псы — крупнее)
  };
  let sparkCount = 0;
  // ---- дуги
  const arcs = {
    a: new Int16Array(ARC_CAP), b: new Int16Array(ARC_CAP), // индексы шарниров (16 псов × 9 > 127)
    la: new Float32Array(ARC_CAP * 3), lb: new Float32Array(ARC_CAP * 3),
    age: new Float32Array(ARC_CAP), life: new Float32Array(ARC_CAP), amp: new Float32Array(ARC_CAP),
    next: new Float32Array(ARC_CAP), on: new Uint8Array(ARC_CAP), w: new Float32Array(ARC_CAP),
    jit: new Float32Array(ARC_CAP * (SEG - 1) * 3),
  };
  let arcCount = 0;
  // ---- вспышки
  const fl = { x: new Float32Array(FLASH_CAP), y: new Float32Array(FLASH_CAP), z: new Float32Array(FLASH_CAP), size: new Float32Array(FLASH_CAP), age: new Float32Array(FLASH_CAP), life: new Float32Array(FLASH_CAP), turn: new Float32Array(FLASH_CAP) };
  let flashCount = 0;
  fl.hot = new Uint8Array(FLASH_CAP); // 1 — оранжевая (выстрел), 0 — голубая (разряд)
  // ---- трассеры пулемётов: голова x/y/z, направление, скорость, пройдено, всего
  const bo = { x: new Float32Array(BOLT_CAP), y: new Float32Array(BOLT_CAP), z: new Float32Array(BOLT_CAP), dx: new Float32Array(BOLT_CAP), dy: new Float32Array(BOLT_CAP), dz: new Float32Array(BOLT_CAP), v: new Float32Array(BOLT_CAP), s: new Float32Array(BOLT_CAP), len: new Float32Array(BOLT_CAP), ally: new Uint8Array(BOLT_CAP) };
  let boltCount = 0;

  const m = new THREE.Matrix4();
  const inv = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const d = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const A = new THREE.Vector3();
  const B = new THREE.Vector3();
  const P = new THREE.Vector3();
  const Q = new THREE.Vector3();
  const c = new THREE.Color();
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
  const rand = (a, b) => a + Math.random() * (b - a);
  let n = 0; // экземпляров в этом кадре
  let warm = 0;

  // чёрточка от from длиной len вдоль единичного dir, толщиной w
  const streak = (from, dir, len, w, r, g, b) => {
    if (n >= CAP || len < 1e-5) return;
    q.setFromUnitVectors(up, dir);
    m.compose(from, q, s.set(w, len, w));
    mesh.setMatrixAt(n, m);
    mesh.setColorAt(n, c.setRGB(r, g, b));
    n += 1;
  };
  const segment = (from, to, w, r, g, b) => {
    d.subVectors(to, from);
    const len = d.length();
    if (len < 1e-5) return;
    d.divideScalar(len);
    streak(from, d, len, w, r, g, b);
  };

  const toLocal = (anchor, point, out, offset) => {
    inv.copy(anchor.matrixWorld).invert();
    p.copy(point).applyMatrix4(inv);
    out[offset] = p.x;
    out[offset + 1] = p.y;
    out[offset + 2] = p.z;
  };
  const jag = (i) => {
    const amp = arcs.amp[i];
    for (let k = 0; k < SEG - 1; k += 1) {
      const j = (i * (SEG - 1) + k) * 3;
      const bulge = Math.sin((Math.PI * (k + 1)) / SEG);
      arcs.jit[j] = rand(-1, 1) * amp * bulge;
      arcs.jit[j + 1] = rand(-1, 1) * amp * bulge;
      arcs.jit[j + 2] = rand(-1, 1) * amp * bulge;
    }
    arcs.on[i] = Math.random() < 0.82 ? 1 : 0;
    arcs.next[i] = arcs.age[i] + rand(0.03, 0.05);
  };

  return {
    // n искр из точки, разлёт вокруг normal (единичный). opts: { speed: [a, b], spread, hot } —
    // hot: жёлто-белые (горячий металл), иначе бело-голубые (электричество)
    sparks(point, normal, count = 14, { speed = [1.5, 4], spread = 0.9, hot = false, size = 1 } = {}) {
      for (let k = 0; k < count; k += 1) {
        const i = sparkCount < SPARK_CAP ? sparkCount++ : Math.floor(Math.random() * SPARK_CAP);
        sp.px[i] = point.x;
        sp.py[i] = point.y;
        sp.pz[i] = point.z;
        p.set(normal.x + rand(-spread, spread), normal.y + rand(-spread, spread) + 0.3, normal.z + rand(-spread, spread)).normalize();
        const v = rand(speed[0], speed[1]);
        sp.vx[i] = p.x * v;
        sp.vy[i] = p.y * v;
        sp.vz[i] = p.z * v;
        sp.age[i] = 0;
        sp.life[i] = rand(0.2, 0.55);
        sp.sz[i] = size;
        const white = Math.random() < 0.35;
        if (hot) {
          sp.r[i] = 1;
          sp.g[i] = white ? 0.95 : 0.72;
          sp.b[i] = white ? 0.8 : 0.3;
        } else {
          sp.r[i] = white ? 0.95 : 0.55;
          sp.g[i] = white ? 0.97 : 0.8;
          sp.b[i] = 1;
        }
      }
    },
    // трассер пули пулемёта: из from по единичному dir со скоростью speed, гаснет через maxLen м
    bolt(from, dir, speed = 160, maxLen = 60, ally = false) {
      const i = boltCount < BOLT_CAP ? boltCount++ : Math.floor(Math.random() * BOLT_CAP);
      bo.ally[i] = ally ? 1 : 0; // союзные — зелёные, вражеские — красно-оранжевые
      bo.x[i] = from.x;
      bo.y[i] = from.y;
      bo.z[i] = from.z;
      bo.dx[i] = dir.x;
      bo.dy[i] = dir.y;
      bo.dz[i] = dir.z;
      bo.v[i] = speed;
      bo.s[i] = 0;
      bo.len[i] = maxLen;
    },
    flash(point, size = 0.1, hot = false) {
      const i = flashCount < FLASH_CAP ? flashCount++ : Math.floor(Math.random() * FLASH_CAP);
      fl.hot[i] = hot ? 1 : 0;
      fl.x[i] = point.x;
      fl.y[i] = point.y;
      fl.z[i] = point.z;
      fl.size[i] = size;
      fl.age[i] = 0;
      fl.life[i] = 0.09;
      fl.turn[i] = Math.random() * Math.PI;
    },
    // дуга между точками на шарнирах anchorA и anchorB (индексы в anchors); точки — мировые сейчас
    arc(anchorA, pointA, anchorB, pointB, life = 0.45, amp = 0.05, width = 1) {
      const i = arcCount < ARC_CAP ? arcCount++ : Math.floor(Math.random() * ARC_CAP);
      arcs.a[i] = anchorA;
      arcs.b[i] = anchorB;
      toLocal(anchors[anchorA], pointA, arcs.la, i * 3);
      toLocal(anchors[anchorB], pointB, arcs.lb, i * 3);
      arcs.age[i] = 0;
      arcs.life[i] = life;
      arcs.amp[i] = amp;
      arcs.w[i] = width;
      jag(i);
    },
    clear() {
      sparkCount = arcCount = flashCount = boltCount = 0;
    },
    get active() {
      return sparkCount + arcCount + flashCount + boltCount;
    },
    update(dt) {
      const h = Math.min(dt, 0.25); // ×32/×64: стая и коптеры зовут раз в кадр за всё накопленное (world-clock.js)
      n = 0;
      // искры: гравитация, сопротивление воздуха; чёрточка вдоль скорости
      for (let i = sparkCount - 1; i >= 0; i -= 1) {
        sp.age[i] += h;
        if (sp.age[i] >= sp.life[i]) {
          sparkCount -= 1;
          for (const key in sp) sp[key][i] = sp[key][sparkCount];
          continue;
        }
        const drag = 1 - 1.5 * h;
        sp.vx[i] *= drag;
        sp.vz[i] *= drag;
        sp.vy[i] = sp.vy[i] * drag - 9.8 * h;
        sp.px[i] += sp.vx[i] * h;
        sp.py[i] += sp.vy[i] * h;
        sp.pz[i] += sp.vz[i] * h;
      }
      for (let i = 0; i < sparkCount; i += 1) {
        const k = 1 - sp.age[i] / sp.life[i];
        d.set(-sp.vx[i], -sp.vy[i], -sp.vz[i]);
        const speed = d.length();
        if (speed < 1e-4) continue;
        d.divideScalar(speed);
        p.set(sp.px[i], sp.py[i], sp.pz[i]);
        const z = sp.sz[i];
        streak(p, d, Math.min(0.07, 0.008 + speed * 0.014) * z, (0.0016 + 0.0024 * k) * z, sp.r[i] * k, sp.g[i] * k, sp.b[i] * k);
      }
      // дуги
      for (let i = arcCount - 1; i >= 0; i -= 1) {
        arcs.age[i] += h;
        if (arcs.age[i] >= arcs.life[i]) {
          arcCount -= 1;
          arcs.a[i] = arcs.a[arcCount];
          arcs.b[i] = arcs.b[arcCount];
          for (let k = 0; k < 3; k += 1) {
            arcs.la[i * 3 + k] = arcs.la[arcCount * 3 + k];
            arcs.lb[i * 3 + k] = arcs.lb[arcCount * 3 + k];
          }
          arcs.age[i] = arcs.age[arcCount];
          arcs.life[i] = arcs.life[arcCount];
          arcs.amp[i] = arcs.amp[arcCount];
          arcs.w[i] = arcs.w[arcCount];
          arcs.next[i] = arcs.next[arcCount];
          arcs.on[i] = arcs.on[arcCount];
          arcs.jit.copyWithin(i * (SEG - 1) * 3, arcCount * (SEG - 1) * 3, (arcCount + 1) * (SEG - 1) * 3);
          continue;
        }
        if (arcs.age[i] >= arcs.next[i]) jag(i);
      }
      for (let i = 0; i < arcCount; i += 1) {
        if (!arcs.on[i]) continue;
        const fade = 1 - (arcs.age[i] / arcs.life[i]) ** 2;
        A.set(arcs.la[i * 3], arcs.la[i * 3 + 1], arcs.la[i * 3 + 2]).applyMatrix4(anchors[arcs.a[i]].matrixWorld);
        B.set(arcs.lb[i * 3], arcs.lb[i * 3 + 1], arcs.lb[i * 3 + 2]).applyMatrix4(anchors[arcs.b[i]].matrixWorld);
        P.copy(A);
        const bright = fade * rand(0.7, 1);
        const aw = arcs.w[i];
        for (let k = 1; k <= SEG; k += 1) {
          if (k < SEG) {
            const j = (i * (SEG - 1) + k - 1) * 3;
            Q.lerpVectors(A, B, k / SEG);
            Q.x += arcs.jit[j];
            Q.y += arcs.jit[j + 1];
            Q.z += arcs.jit[j + 2];
          } else Q.copy(B);
          segment(P, Q, 0.0035 * aw, 0.85 * bright, 0.93 * bright, bright); // сердцевина
          segment(P, Q, 0.016 * aw, 0.12 * bright, 0.28 * bright, 0.75 * bright); // свечение
          P.copy(Q);
        }
      }
      // вспышки: три скрещённые чёрточки, быстро гаснут
      for (let i = flashCount - 1; i >= 0; i -= 1) {
        fl.age[i] += h;
        if (fl.age[i] >= fl.life[i]) {
          flashCount -= 1;
          for (const key in fl) fl[key][i] = fl[key][flashCount];
        }
      }
      for (let i = 0; i < flashCount; i += 1) {
        const k = 1 - fl.age[i] / fl.life[i];
        const size = fl.size[i] * (0.6 + 0.4 * k);
        const hot = fl.hot[i];
        for (let a = 0; a < 3; a += 1) {
          d.copy(axes[a]).applyAxisAngle(axes[(a + 1) % 3], fl.turn[i]);
          p.set(fl.x[i], fl.y[i], fl.z[i]).addScaledVector(d, -size / 2);
          if (hot) streak(p, d, size, size * 0.22, k, 0.6 * k, 0.2 * k);
          else streak(p, d, size, size * 0.18, 0.6 * k, 0.8 * k, k);
        }
      }
      // трассеры: сердцевина и красное свечение, хвост 2,5 м за головой
      for (let i = boltCount - 1; i >= 0; i -= 1) {
        bo.s[i] += bo.v[i] * h;
        if (bo.s[i] >= bo.len[i] + 2.5) {
          boltCount -= 1;
          for (const key in bo) bo[key][i] = bo[key][boltCount];
        }
      }
      for (let i = 0; i < boltCount; i += 1) {
        const head = Math.min(bo.s[i], bo.len[i]);
        const tail = Math.max(0, bo.s[i] - 2.5);
        if (head - tail < 1e-3) continue;
        d.set(bo.dx[i], bo.dy[i], bo.dz[i]);
        p.set(bo.x[i], bo.y[i], bo.z[i]).addScaledVector(d, tail);
        if (bo.ally[i]) {
          streak(p, d, head - tail, 0.006, 0.6, 1, 0.65);
          streak(p, d, head - tail, 0.03, 0.08, 0.6, 0.2);
        } else {
          streak(p, d, head - tail, 0.006, 1, 0.75, 0.45);
          streak(p, d, head - tail, 0.03, 0.7, 0.12, 0.05);
        }
      }
      mesh.count = n;
      // первые кадры меш виден и пустой: шейдер собирается сразу, а не на первом попадании
      if (warm < 3) warm += 1;
      mesh.visible = n > 0 || warm < 3;
      if (n) {
        mesh.instanceMatrix.clearUpdateRanges();
        mesh.instanceMatrix.addUpdateRange(0, n * 16);
        mesh.instanceMatrix.needsUpdate = true;
        mesh.instanceColor.clearUpdateRanges();
        mesh.instanceColor.addUpdateRange(0, n * 3);
        mesh.instanceColor.needsUpdate = true;
      }
    },
    dispose() {
      mesh.removeFromParent();
      mesh.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}
