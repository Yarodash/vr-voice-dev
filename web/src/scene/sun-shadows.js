// Тени от солнца на землю — каскадные карты силуэтов (как запечённые тени травы в world.js, но
// каждый кадр и двумя каскадами). Отбрасывают тень только зарегистрированные экземплярные меши
// (робопсы — robodog-instances.js, коптеры — drones.js), принимают земля и трава (их шейдеры в
// world.js читают uniforms отсюда: dogShade()).
//
// Почему не three/addons/csm/CSM.js: он подменяет общий ShaderChunk lights_fragment_begin и добавляет
// по DirectionalLight на каскад — перекомпиляция всех освещённых программ (рывок на Quest), другой
// свет у всего оружия, а земля и трава — свои ShaderMaterial без света, им CSM ничего не даст; ещё он
// делит пирамиду обзора камеры (у нас far = 5000, в шлеме — ArrayCamera двух глаз).
//
// Как устроено: ортокамера смотрит со стороны солнца (то же «солнце для теней», что у травы: справа,
// SHADOW_ELEVATION над горизонтом), каждый каскад — квадратная текстура R8, белая, силуэты отбрасывателей
// чёрные. Пиксель земли проецируется в каскад той же матрицей: чёрное — на луче к солнцу есть пёс, тень.
// Глубины нет — значит нет ни «прыщей» (shadow acne), ни bias, ни отрыва тени от лап (peter-panning):
// тень всегда начинается ровно под тем, что её отбрасывает. Самозатенения псов нет (и не нужно).
// Каскады: ближний (NEAR_R вокруг точки перед взглядом) и дальний (FAR_R, меньше разрешение и только
// крупные силуэты) — оба каждый кадр (раз в N кадров тени «шагали»), в одной текстуре-атласе одним
// renderer.render с ArrayCamera (две камеры со своими viewport): один проход в текстуру, а не два. Центр каскада сдвигается только на целый тексель вдоль осей карты (stable cascades) —
// тени не «плывут» и не мерцают, когда игрок поворачивает голову. На стыке каскадов — плавный переход.
//
// createSunShadows({ THREE, renderer, camera, shared }) →
//   { uniforms, setSun(dir), addCaster(mesh, { material, cascades }), removeCaster(mesh), enabled, update(), dispose() }
// cascades: 'both' | 'near' | 'far' — в каких каскадах рисуется силуэт (мелкие детали — только в ближнем,
// коптеры — только в дальнем: высоко, их тени ложатся далеко). Каждый силуэт — вызов отрисовки (~30 мкс CPU).
import { groundHeight } from './car.js';

// --- настройки (дешевле: меньше SIZE, меньше FAR_R; NEAR_R меньше — чётче вблизи)
export const SUN_SHADOW_SIZE = 1024; // пикселей у ближнего каскада
export const FAR_SHADOW_SIZE = 512; // у дальнего (тексель ≈ 31 см; меньше — меньше ряби вдали без мипмапов)
export const NEAR_R = 16; // м: полуширина ближнего каскада (тексель ≈ 3 см)
export const FAR_R = 80; // м: полуширина дальнего каскада (тексель ≈ 16 см); дальше теней нет
export const SHADOW_STRENGTH = 0.62; // насколько тень темнит землю (0 — нет, 1 — чёрная)
const STORE_KEY = 'scene.sunShadows'; // «Настройки ▸ Тени: вкл/выкл»; по умолчанию вкл
const PROGRAM_KEY = 'sun-silhouette-1';

export function createSunShadows({ THREE, renderer, camera, shared }) {
  let enabled = true;
  try {
    enabled = localStorage.getItem(STORE_KEY) !== 'off';
  } catch {
    // без хранилища — по умолчанию
  }
  // цели рендера — в __sceneState: переживают подмену сцены (без новой заливки и выделения)
  const cache = (shared.sunShadowCache ??= {});
  // атлас: слева ближний N×N, справа внизу дальний F×F
  const ATLAS_W = SUN_SHADOW_SIZE + FAR_SHADOW_SIZE;
  const ATLAS_H = Math.max(SUN_SHADOW_SIZE, FAR_SHADOW_SIZE);
  const SIZE_KEY = `atlas ${SUN_SHADOW_SIZE}/${FAR_SHADOW_SIZE}`;
  if (cache.size !== SIZE_KEY) {
    for (const t of [cache.near, cache.far, cache.atlas]) t?.dispose();
    cache.near = cache.far = null;
    const make = (w, h) => {
      const t = new THREE.WebGLRenderTarget(w, h, {
        format: THREE.RedFormat,
        type: THREE.UnsignedByteType,
        depthBuffer: false,
        stencilBuffer: false,
        generateMipmaps: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      t.texture.name = 'sun-shadow';
      return t;
    };
    cache.atlas = make(ATLAS_W, ATLAS_H);
    cache.size = SIZE_KEY;
    cache.fresh = true;
  }

  const uniforms = {
    dogShadowOn: { value: 0 },
    dogShadowNear: { value: cache.atlas.texture },
    dogShadowFar: { value: cache.atlas.texture },
    // каскад в атласе: xy — масштаб, zw — сдвиг uv
    dogShadowNearA: { value: new THREE.Vector4(SUN_SHADOW_SIZE / ATLAS_W, SUN_SHADOW_SIZE / ATLAS_H, 0, 0) },
    dogShadowFarA: { value: new THREE.Vector4(FAR_SHADOW_SIZE / ATLAS_W, FAR_SHADOW_SIZE / ATLAS_H, SUN_SHADOW_SIZE / ATLAS_W, 0) },
    dogShadowNearM: { value: new THREE.Matrix4() },
    dogShadowFarM: { value: new THREE.Matrix4() },
    dogShadowStrength: { value: SHADOW_STRENGTH },
  };

  const casterScene = new THREE.Scene();
  casterScene.background = new THREE.Color(1, 1, 1); // освещено
  casterScene.matrixWorldAutoUpdate = true;
  const plainMaterial = new THREE.MeshBasicMaterial({ color: 0x000000, depthTest: false, depthWrite: false });
  plainMaterial.customProgramCacheKey = () => PROGRAM_KEY;
  const casters = new Map(); // исходный InstancedMesh → его силуэт

  const sun = new THREE.Vector3(1, 0.4, 0).normalize(); // к солнцу; задаёт world.shadowSun
  const cascades = [
    { r: NEAR_R, size: SUN_SHADOW_SIZE, ahead: 0.55, matrix: uniforms.dogShadowNearM.value, cam: new THREE.OrthographicCamera() },
    { r: FAR_R, size: FAR_SHADOW_SIZE, ahead: 0.5, matrix: uniforms.dogShadowFarM.value, cam: new THREE.OrthographicCamera() },
  ];
  cascades[0].cam.viewport = new THREE.Vector4(0, 0, SUN_SHADOW_SIZE, SUN_SHADOW_SIZE);
  cascades[1].cam.viewport = new THREE.Vector4(SUN_SHADOW_SIZE, 0, FAR_SHADOW_SIZE, FAR_SHADOW_SIZE);
  const atlasCamera = new THREE.ArrayCamera([cascades[0].cam, cascades[1].cam]);
  atlasCamera.layers.enableAll(); // отбор силуэтов — по слоям камер каскадов
  // слои силуэтов: 1 — только ближний, 2 — только дальний, 3 — оба
  const LAYER = { near: 1, far: 2, both: 3 };
  cascades[0].cam.layers.set(1);
  cascades[0].cam.layers.enable(3);
  cascades[1].cam.layers.set(2);
  cascades[1].cam.layers.enable(3);
  const DIST = 400; // м: камера каскада от центра к солнцу (коптеры высоко — тоже внутри)
  const right = new THREE.Vector3();
  const up = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const setSun = (dir) => {
    sun.copy(dir).normalize();
    fwd.copy(sun).negate(); // взгляд камеры каскада
    right.crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
    up.crossVectors(right, fwd).normalize();
    const elevation = Math.max(0.05, Math.asin(Math.min(1, sun.y)));
    for (const c of cascades) {
      // поперёк солнца ±r; вдоль — земля ±r видна солнцем под углом: по высоте карты r·sin(угла)
      c.halfW = c.r;
      c.halfH = c.r * Math.sin(elevation);
      c.cam.left = -c.halfW;
      c.cam.right = c.halfW;
      c.cam.top = c.halfH;
      c.cam.bottom = -c.halfH;
      c.cam.near = 1;
      c.cam.far = DIST * 2;
      c.cam.updateProjectionMatrix();
      c.cam.up.copy(up);
    }
  };
  setSun(sun);

  const head = new THREE.Vector3();
  const look = new THREE.Vector3();
  const center = new THREE.Vector3();
  // центр каскада на целый тексель в осях карты: при сдвиге головы силуэты не переливаются
  const place = (c) => {
    const tx = (2 * c.halfW) / c.size;
    const ty = (2 * c.halfH) / c.size;
    center.set(head.x + look.x * c.r * c.ahead, 0, head.z + look.z * c.r * c.ahead);
    center.y = groundHeight(center.x, center.z);
    const x = Math.round(center.dot(right) / tx) * tx;
    const y = Math.round(center.dot(up) / ty) * ty;
    const d = center.dot(fwd);
    c.cam.position.set(0, 0, 0).addScaledVector(right, x).addScaledVector(up, y).addScaledVector(fwd, d - DIST);
    c.cam.lookAt(c.cam.position.x + fwd.x, c.cam.position.y + fwd.y, c.cam.position.z + fwd.z);
    c.cam.updateMatrixWorld(true);
  };


  const sync = () => {
    let any = false;
    for (const [src, sil] of casters) {
      sil.count = src.count;
      // первые кадры силуэт виден и пустой: программа собирается сразу, а не с первым псом
      const warmUp = sil.userData.warm > 0;
      if (warmUp) sil.userData.warm -= 1;
      sil.visible = Boolean(src.parent) && (warmUp || (src.visible && src.count > 0));
      if (!sil.visible) continue;
      any = true;
      sil.matrix.copy(src.matrixWorld);
      sil.matrixWorldNeedsUpdate = true;
    }
    return any;
  };

  let wasAny = true; // пустые карты чистятся один раз, потом не рисуются
  return {
    uniforms,
    setSun,
    get enabled() {
      return enabled;
    },
    set enabled(on) {
      enabled = Boolean(on);
      try {
        localStorage.setItem(STORE_KEY, enabled ? 'on' : 'off');
      } catch {
        // без хранилища не переживёт перезагрузку
      }
      wasAny = true;
    },
    // отбрасыватель: InstancedMesh; силуэт делит с ним геометрию и буфер матриц экземпляров (без копий)
    // geometry — своя геометрия силуэта (упрощённая; псы: LOD больших), матрицы — те же
    addCaster(mesh, { material = plainMaterial, cascades: which = 'both', geometry = null } = {}) {
      if (casters.has(mesh)) return;
      const sil = new THREE.InstancedMesh(geometry ?? mesh.geometry, material, 0);
      sil.instanceMatrix = mesh.instanceMatrix;
      sil.matrixAutoUpdate = false;
      sil.frustumCulled = false;
      sil.name = `${mesh.name}-silhouette`;
      sil.userData.warm = 3;
      sil.layers.set(LAYER[which] ?? 3);
      casterScene.add(sil);
      casters.set(mesh, sil);
    },
    removeCaster(mesh) {
      const sil = casters.get(mesh);
      if (!sil) return;
      casterScene.remove(sil);
      casters.delete(mesh);
    },
    // раз в кадр, после того как псы и коптеры записали свои матрицы
    update() {
      // sunShadowsPaused — для замеров из vr:eval (не сохраняется): true — всё выкл, 'sample' — без
      // выборок в земле и траве, 'render' — без перерисовки карт
      const dbg = shared.sunShadowsPaused;
      const on = enabled && dbg !== true;
      uniforms.dogShadowOn.value = on && dbg !== 'sample' ? 1 : 0;
      if (!on || dbg === 'render') return;
      const any = sync();
      if (!any && !wasAny) return; // ни одного отбрасывателя: карты уже белые
      wasAny = any;
      camera.getWorldPosition(head);
      camera.getWorldDirection(look);
      look.y = 0;
      if (look.lengthSq() < 1e-6) look.set(0, 0, -1);
      look.normalize();
      const xrEnabled = renderer.xr.enabled;
      const previous = renderer.getRenderTarget();
      renderer.xr.enabled = false; // в текстуру, а не в шлем
      try {
        for (const c of cascades) {
          place(c);
          c.matrix.multiplyMatrices(c.cam.projectionMatrix, c.cam.matrixWorldInverse);
        }
        renderer.setRenderTarget(cache.atlas);
        renderer.render(casterScene, atlasCamera); // фон чистит весь атлас, каждый каскад — в свой viewport
      } finally {
        renderer.setRenderTarget(previous);
        renderer.xr.enabled = xrEnabled;
      }
    },
    dispose() {
      uniforms.dogShadowOn.value = 0;
      casterScene.clear();
      casters.clear();
      plainMaterial.dispose();
      // цели рендера — в кэше (shared.sunShadowCache), не освобождать
    },
  };
}
