// Частицы погоды: дождь, снег, дождь со снегом, град, брызги, «стена» дождя и снега вдали, пыль и
// песок, смог, снежная позёмка, летящие листья и разряд молнии.
//
// Состояние только читается: shared.atmosphere.now (scene/atmosphere.js, контракт —
// docs/agents/atmosphere.md). Здесь ничего в него не пишется.
//
// Как это устроено (и почему дёшево):
// - каждый вид осадков — ОДИН вызов отрисовки: InstancedBufferGeometry из квадов + свой шейдер;
// - частицы живут в коробке вокруг головы и «заворачиваются» в ней в вершинном шейдере: у частицы
//   есть узел в периодической решётке (aSeed), решётка едет на uTravel (путь ветра и падения,
//   копится на процессоре — три числа на вид), из всех периодических копий берётся ближайшая к
//   центру коробки. Решётка привязана к миру, а не к голове: при ходьбе и повороте головы капли
//   остаются на своих местах, меняется только то, какая копия видна. На процессоре работы по
//   частицам нет вовсе, памяти в кадре не выделяется;
// - сколько частиц рисуется — geometry.instanceCount по силе явления; при нуле mesh.visible = false
//   (ни одного вызова);
// - программы шейдеров создаются один раз при появлении сцены (первые кадры сетки видимы с нулём
//   частиц), смена погоды меняет только униформы;
// - геометрия и текстуры лежат в __sceneState.weatherFxCache и переживают подмену сцены.
//
// Отладка (npm run vr:eval): __sceneState.weatherFxDebug.set({ rain: 1, wind: 0.5 }) подменяет
// значения состояния (.clear() — вернуть настоящие), .strike({ distM: 400 }) — разряд молнии,
// .stats() — сколько чего рисуется.
import { groundHeight } from './car.js';

const MAX_CAP = 4000; // общий запас случайных узлов (aSeed, aRnd) на все виды
const RAIN_CAP = 4000; // штрихов дождя при ливне
const SNOW_CAP = 3000; // хлопьев в метель
const GRIT_CAP = 1400; // песчинок в пыльную бурю
const HAIL_CAP = 900; // градин (в воздухе в каждый момент — около трети)
const SPLASH_CAP = 480; // брызг (живых в каждый момент — половина)
const LEAF_CAP = 560; // листьев, лепестков
const LEAF_FALL = 0.3; // м/с: лёгкое снижение листа
const LEAF_SWAY_S = 5.5; // с: период медленного покачивания листа (у половины листьев — вдвое короче)
const LEAF_LIFT = 0.35; // м: на столько полный порыв ветра приподнимает листья
const PUFF_CAP = 96; // клубов на один вид (пыль, смог, позёмка, водяная пыль)
const PUFF_VR = 0.65; // доля клубов в шлеме
const BOLT_SEGS = 128; // отрезков на один разряд молнии
const BOLT_SLOTS = 2; // разрядов одновременно
const BOLT_LIFE = 0.3; // секунд живёт разряд
const PERIOD = 240; // с: круг времени для брызг и града (число циклов частицы за круг — целое)
const FOG_K = 3.9; // −ln 0,02: как в atmosphere-light.js
const FOG_CLEAR_M = 16000; // видимость обычной погоды: при ней тумана нет
const WIND_MS = 14; // м/с при wind = 1 (шторм); 0,3 — обычный ветер 4 м/с; 1,5 — ураган 21 м/с
const LAP = 16; // путь решётки заворачивается на LAP коробок; множители скорости частиц — n / LAP

const WALL_R = 10; // радиус «стены» дождя вокруг головы, м
const WALL_TILES = 12; // плиток текстуры по окружности
const WALL_TILE = (2 * Math.PI * WALL_R) / WALL_TILES; // размер плитки, м
const WALL_SLOPE = 1.6; // наибольший наклон рисунка стены: ветер / падение
const WALL_SEG = 48;
const KIND_NAMES = ['rain', 'snow', 'grit', 'hail', 'splash', 'dust', 'smog', 'snow-veil', 'rain-mist', 'leaves'];
const WALL_ROWS = 4;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const wrapTo = (v, m) => {
  const r = v % m;
  return r < 0 ? r + m : r;
};

// ---------------------------------------------------------------------------------- шейдеры

// Штрих или зерно: лента вдоль движения, лицом к глазу (дождь, снег, песок).
const STREAK_VS = /* glsl */ `
  attribute vec4 aSeed;  // узел решётки 0..1 (xyz) и случайное число
  attribute vec4 aRnd;   // множитель скорости (n/16) и три случайных числа
  uniform vec3 uCenter;  // центр коробки, мир
  uniform vec3 uBox;     // размеры коробки, м
  uniform vec3 uTravel;  // пройденный решёткой путь, м
  uniform vec3 uDir;     // куда летит (единичный)
  uniform vec4 uSize;    // полуширина, полудлина, колыхание (м), наименьшая полуширина (пиксели)
  uniform vec4 uLook;    // прозрачность, не видно ближе (м), полностью видно с (м), 1 / полувысота кадра
  uniform float uFogK;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vFog;
  void main() {
    vec3 q = fract(aSeed.xyz + uTravel * aRnd.x / uBox);
    vec3 rel = fract(q - uCenter / uBox + 0.5) - 0.5;
    vec3 P = uCenter + rel * uBox;
    // колыхание: по узлу решётки, целое число волн на коробку — без скачка на завороте
    float ph = 6.2831853 * (q.y * 3.0 + aRnd.z);
    float ph2 = 6.2831853 * (q.x * 2.0 + q.z * 2.0 + aRnd.w);
    P += uSize.z * vec3(sin(ph) + 0.5 * sin(ph2 * 2.0), 0.6 * sin(ph2), cos(ph + aRnd.w * 6.2831853));

    vec4 mv = viewMatrix * vec4(P, 1.0);
    float dist = length(mv.xyz);
    float wide = uSize.x * (0.7 + 0.6 * aRnd.y);
    // не тоньше пикселя: вдали штрих шире настоящего и во столько же раз прозрачнее
    float w = max(wide, uSize.w * dist * uLook.w / projectionMatrix[1][1]);
    float len = uSize.y * (0.7 + 0.6 * aRnd.w);
    vec3 axis = (viewMatrix * vec4(uDir, 0.0)).xyz;
    vec3 toEye = -mv.xyz / max(dist, 1e-4);
    vec3 side = cross(axis, toEye);
    float sl = length(side);
    side = sl > 1e-3 ? side / sl : vec3(1.0, 0.0, 0.0);
    vec3 fwd = cross(toEye, side); // вдоль движения в плоскости экрана: летящее в лицо не тоньше своей ширины
    // (расширенный до пикселя штрих бледнеет медленнее, чем расширяется: иначе мелкий дождь вдали пропадает совсем)
    float a = uLook.x * (0.55 + 0.45 * aSeed.w) * pow(wide / w, 0.5)
      * (1.0 - smoothstep(0.38, 0.5, abs(rel.x))) * (1.0 - smoothstep(0.38, 0.5, abs(rel.z)))
      * (1.0 - smoothstep(0.4, 0.5, abs(rel.y)))
      * smoothstep(uLook.y, uLook.z, dist);
    if (a < 0.004) { w = 0.0; len = 0.0; }
    mv.xyz += (axis * len + fwd * w) * position.y + side * (position.x * w);
    gl_Position = projectionMatrix * mv;
    vUv = position.xy;
    vAlpha = a;
    vFog = 1.0 - exp(-dist * uFogK);
  }
`;

// Общий фрагментный шейдер штрихов, хлопьев, песка и града: без текстур.
const GRAIN_FS = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uFogColor;
  uniform vec2 uShape;   // 0 — штрих с хвостом … 1 — круглое зерно; жёсткость края зерна 0..1
  varying vec2 vUv;
  varying float vAlpha;
  varying float vFog;
  void main() {
    float x2 = vUv.x * vUv.x;
    float streak = (1.0 - x2) * smoothstep(-1.0, 0.3, vUv.y) * (1.0 - smoothstep(0.75, 1.0, vUv.y));
    float grain = smoothstep(0.0, mix(0.7, 0.18, uShape.y), 1.0 - x2 - vUv.y * vUv.y);
    gl_FragColor = vec4(mix(uColor, uFogColor, vFog), mix(streak, grain, uShape.x) * vAlpha);
    #include <colorspace_fragment>
  }
`;

// Град: падает в точку на земле, отскакивает дважды и тает; всё — функция времени цикла.
const HAIL_VS = /* glsl */ `
  attribute vec4 aSeed;
  attribute vec4 aRnd;
  uniform vec3 uCenter;
  uniform vec3 uBox;
  uniform vec3 uGround;  // земля рядом с игроком — плоскость: высота = x + dot(yz, место)
  uniform vec4 uHail;    // время по кругу (с), скорость падения (м/с), сколько падает (с), полуразмер (м)
  uniform vec2 uWindV;   // снос ветром, м/с
  uniform vec4 uLook;    // прозрачность, наименьшая полуширина (пиксели), 1 / полувысота кадра, смаз (с)
  uniform float uFogK;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vFog;
  void main() {
    float n = 70.0 + floor(aRnd.y * 19.0); // циклов за круг времени: один цикл 2,7–3,4 с
    float cyc = uHail.x * n / ${PERIOD.toFixed(1)} + aRnd.z;
    float ci = mod(floor(cyc), n);
    float tau = fract(cyc) * ${PERIOD.toFixed(1)} / n;
    // куда упадёт в этом цикле
    vec2 h = fract(aSeed.xz + fract(sin(ci * vec2(12.9898, 39.3468) + aSeed.w * 6.2831853) * 43758.5453));
    vec2 rel = fract(h - uCenter.xz / uBox.xz + 0.5) - 0.5;
    vec2 L = uCenter.xz + rel * uBox.xz;
    float gy = uGround.x + dot(uGround.yz, L) + uHail.w;
    vec3 P;
    vec3 vel;
    float a = 1.0;
    if (tau < uHail.z) {
      float s = uHail.z - tau; // до удара
      P = vec3(L.x - uWindV.x * s, gy + uHail.y * s, L.y - uWindV.y * s);
      vel = vec3(uWindV.x, -uHail.y, uWindV.y);
      a = smoothstep(0.0, 0.12, tau);
    } else {
      float s = tau - uHail.z;
      float vb = uHail.y * (0.15 + 0.09 * aRnd.w); // отскок вверх, м/с
      float t1 = vb / 4.9;
      float ang = aSeed.y * 6.2831853;
      vec2 hv = vec2(cos(ang), sin(ang)) * (0.3 + 1.1 * aSeed.w) + uWindV * 0.25;
      if (s < t1) {
        P = vec3(L.x + hv.x * s, gy + vb * s - 4.9 * s * s, L.y + hv.y * s);
        vel = vec3(hv.x, vb - 9.8 * s, hv.y);
      } else {
        float s2 = s - t1;
        float vb2 = vb * 0.42;
        float t2 = vb2 / 4.9;
        float sy = min(s2, t2);
        float sx = t1 + sy * 0.6;
        P = vec3(L.x + hv.x * sx, gy + vb2 * sy - 4.9 * sy * sy, L.y + hv.y * sx);
        vel = s2 < t2 ? vec3(hv.x * 0.6, vb2 - 9.8 * s2, hv.y * 0.6) : vec3(0.0);
        a = 1.0 - smoothstep(t2 + 0.3, t2 + 0.9, s2); // полежала и растаяла
      }
    }
    vec4 mv = viewMatrix * vec4(P, 1.0);
    float dist = length(mv.xyz);
    float wide = uHail.w * (0.75 + 0.5 * aRnd.w);
    float w = max(wide, uLook.y * dist * uLook.z / projectionMatrix[1][1]);
    float speed = length(vel);
    vec3 axis = (viewMatrix * vec4(speed > 0.01 ? vel / speed : vec3(0.0, -1.0, 0.0), 0.0)).xyz;
    float len = speed * uLook.w;
    vec3 toEye = -mv.xyz / max(dist, 1e-4);
    vec3 side = cross(axis, toEye);
    float sl = length(side);
    side = sl > 1e-3 ? side / sl : vec3(1.0, 0.0, 0.0);
    vec3 fwd = cross(toEye, side);
    a *= uLook.x * (wide / w) * (1.0 - smoothstep(0.4, 0.5, abs(rel.x))) * (1.0 - smoothstep(0.4, 0.5, abs(rel.y)))
      * smoothstep(0.3, 0.9, dist);
    if (a < 0.004) { w = 0.0; len = 0.0; }
    mv.xyz += (axis * len + fwd * w) * position.y + side * (position.x * w);
    gl_Position = projectionMatrix * mv;
    vUv = position.xy;
    vAlpha = a;
    vFog = 1.0 - exp(-dist * uFogK);
  }
`;

// Брызги дождя: маленькая «корона» в случайном месте у земли, растёт и опадает за долю секунды.
const SPLASH_VS = /* glsl */ `
  attribute vec4 aSeed;
  attribute vec4 aRnd;
  uniform vec3 uCenter;
  uniform vec3 uBox;
  uniform vec3 uGround;
  uniform vec4 uSplash;  // время по кругу (с), полуширина (м), высота (м), на какую высоту над землёй разбросаны (м)
  uniform vec2 uLook;    // прозрачность (y не используется)
  uniform float uFogK;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vFog;
  void main() {
    float n = 300.0 + floor(aRnd.y * 301.0); // циклов за круг времени: один цикл 0,4–0,8 с
    float cyc = uSplash.x * n / ${PERIOD.toFixed(1)} + aRnd.z;
    float ci = mod(floor(cyc), n);
    float life = fract(cyc) * 2.0; // брызг виден первую половину цикла
    vec2 h = fract(aSeed.xz + fract(sin(ci * vec2(12.9898, 39.3468) + aSeed.w * 6.2831853) * 43758.5453));
    vec2 rel = fract(h - uCenter.xz / uBox.xz + 0.5) - 0.5;
    vec2 L = uCenter.xz + rel * uBox.xz;
    float lift = uSplash.w * fract(aSeed.y + ci * 0.618034);
    vec3 P = vec3(L.x, uGround.x + dot(uGround.yz, L) + lift, L.y);
    vec4 mv = viewMatrix * vec4(P, 1.0);
    float dist = length(mv.xyz);
    float sz = 0.6 + 0.8 * aRnd.w;
    float grow = 1.0 - (1.0 - life) * (1.0 - life);
    float wHalf = uSplash.y * sz * (0.3 + 0.7 * grow);
    float hFull = uSplash.z * sz * (0.25 + 3.0 * life * (1.0 - life));
    float a = uLook.x * (1.0 - life) * (1.0 - smoothstep(0.38, 0.5, abs(rel.x))) * (1.0 - smoothstep(0.38, 0.5, abs(rel.y)))
      * smoothstep(0.4, 1.2, dist);
    if (life >= 1.0 || a < 0.004) { wHalf = 0.0; hFull = 0.0; }
    vec3 up = (viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz;
    vec3 side = cross(up, -mv.xyz / max(dist, 1e-4));
    float sl = length(side);
    side = sl > 1e-3 ? side / sl : vec3(1.0, 0.0, 0.0);
    mv.xyz += side * (position.x * wHalf) + up * ((position.y + 1.0) * 0.5 * hFull);
    gl_Position = projectionMatrix * mv;
    vUv = position.xy;
    vAlpha = a;
    vFog = 1.0 - exp(-dist * uFogK);
  }
`;

const SPLASH_FS = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uFogColor;
  varying vec2 vUv;
  varying float vAlpha;
  varying float vFog;
  void main() {
    float x = abs(vUv.x);
    float y = vUv.y * 0.5 + 0.5; // 0 у основания … 1 наверху
    float t = x / (0.22 + 0.78 * y); // 0 на оси … 1 на краю «чаши» брызг, раскрытой кверху
    float cup = step(t, 1.0) * (0.3 + 0.7 * smoothstep(0.35, 0.95, t)) * (1.0 - y) * (1.0 - smoothstep(0.85, 1.0, t));
    float core = clamp(1.0 - (x * x * 5.0 + y * y * 12.0), 0.0, 1.0); // плотное основание
    gl_FragColor = vec4(mix(uColor, uFogColor, vFog), max(cup, core) * vAlpha);
    #include <colorspace_fragment>
  }
`;

// «Стена» дождя и снега вдали: цилиндр вокруг головы с бегущей текстурой штрихов (R) и точек (G).
// Наклон по ветру — сдвигом текстуры: касательная к цилиндру составляющая ветра / скорость падения.
const WALL_VS = /* glsl */ `
  uniform vec3 uHead;
  uniform vec4 uWall;   // радиус, низ, верх (м от головы), размер плитки (м)
  uniform vec3 uFlow;   // xz — ветер / скорость падения, y — путь падения (м, по кругу)
  varying vec4 vMap;    // дуга (плитки), высота над головой (м), наклон, высота рисунка (плитки)
  varying float vFade;
  void main() {
    float th = position.x * 6.2831853;
    vec2 c = vec2(cos(th), sin(th));
    float yy = mix(uWall.y, uWall.z, position.y);
    vec3 P = uHead + vec3(c.x * uWall.x, yy, c.y * uWall.x);
    float k = dot(uFlow.xz, vec2(-c.y, c.x));
    float kAll = length(uFlow.xz);
    vMap = vec4(position.x * ${WALL_TILES.toFixed(1)}, yy, k, (P.y + uFlow.y) / uWall.w);
    // вдоль ветра (к нам и от нас) штрихи видны с торца и сходятся веером: там стена бледнее
    float alongWind = 1.0 - smoothstep(0.15, 0.6, abs(k) / max(kAll, 1e-3));
    vFade = smoothstep(0.0, 0.3, position.y) * (1.0 - smoothstep(0.45, 1.0, position.y))
      * (1.0 - 0.7 * alongWind * smoothstep(0.2, 0.6, kAll));
    gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
  }
`;

const WALL_FS = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec4 uWall;
  uniform vec3 uColor;
  uniform vec2 uMix;    // плотность штрихов дождя и точек снега
  varying vec4 vMap;
  varying float vFade;
  void main() {
    // сдвиг по дуге — как у прямого наклонного штриха, касающегося цилиндра (а не винтом вокруг него);
    // считается в каждой точке: по вершинам рисунок шёл бы волнами
    vec2 uv = vec2(vMap.x + uWall.x * atan(vMap.y * vMap.z / uWall.x) / uWall.w, vMap.w);
    // второй слой: мельче и медленнее — «дальше»
    float a = dot(texture2D(uTex, uv).rg, uMix) + 0.6 * dot(texture2D(uTex, uv * vec2(1.5, 0.75) + vec2(0.37, 0.11)).rg, uMix);
    gl_FragColor = vec4(uColor, a * vFade);
    #include <colorspace_fragment>
  }
`;

// Клубы: пыль, смог, снежная позёмка, водяная пыль ливня. Мягкие спрайты у земли, несутся с ветром.
const PUFF_VS = /* glsl */ `
  attribute vec4 aSeed;
  attribute vec4 aRnd;
  uniform vec3 uCenter;
  uniform vec3 uBox;
  uniform vec3 uTravel;
  uniform vec3 uGround;
  uniform vec4 uPuff;   // высота над землёй от и до, радиус от и до (м)
  uniform vec4 uLook;   // прозрачность, уровень 0..1 (сколько клубов), не видно ближе, полностью видно с (м)
  uniform float uFogK;
  varying vec2 vUv;
  varying vec2 vCorner;
  varying float vAlpha;
  varying float vFog;
  void main() {
    vec2 q = fract(aSeed.xz + uTravel.xz * aRnd.x / uBox.xz);
    vec2 rel = fract(q - uCenter.xz / uBox.xz + 0.5) - 0.5;
    vec2 L = uCenter.xz + rel * uBox.xz;
    float R = mix(uPuff.z, uPuff.w, aRnd.y);
    float along = q.x * 2.0 + q.y * 3.0;
    float hgt = mix(uPuff.x, uPuff.y, aSeed.y * aSeed.y) + 0.3 * R * sin(6.2831853 * (along + aRnd.z));
    vec3 P = vec3(L.x, uGround.x + dot(uGround.yz, L) + max(hgt, 0.0) + R * 0.55, L.y);
    vec4 mv = viewMatrix * vec4(P, 1.0);
    float dist = length(mv.xyz);
    float a = uLook.x * (0.6 + 0.4 * aRnd.w)
      * (1.0 - smoothstep(0.34, 0.5, abs(rel.x))) * (1.0 - smoothstep(0.34, 0.5, abs(rel.y)))
      * smoothstep(uLook.z, uLook.w, dist)
      * clamp((uLook.y - aSeed.w * 0.9) * 10.0, 0.0, 1.0);
    if (a < 0.003) R = 0.0; // невидимый клуб не занимает ни пикселя
    float rot = 6.2831853 * aRnd.w + 0.6 * sin(6.2831853 * (q.x + q.y));
    float cr = cos(rot);
    float sr = sin(rot);
    vec2 rc = vec2(cr * position.x - sr * position.y, sr * position.x + cr * position.y);
    mv.xy += rc * R;
    gl_Position = projectionMatrix * mv;
    float cell = floor(aRnd.z * 4.0);
    vUv = (position.xy * 0.5 + 0.5) * 0.5 + vec2(mod(cell, 2.0), floor(cell * 0.5)) * 0.5;
    vCorner = rc;
    vAlpha = a;
    vFog = 1.0 - exp(-dist * uFogK);
  }
`;

const PUFF_FS = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec3 uColor;
  uniform vec3 uFogColor;
  varying vec2 vUv;
  varying vec2 vCorner;
  varying float vAlpha;
  varying float vFog;
  void main() {
    vec4 t = texture2D(uTex, vUv);
    vec3 col = uColor * (0.72 + 0.4 * t.r) * (0.9 + 0.14 * vCorner.y);
    gl_FragColor = vec4(mix(col, uFogColor, vFog * 0.7), t.a * vAlpha);
    #include <colorspace_fragment>
  }
`;

// Листья и лепестки: настоящие маленькие плоскости, кувыркаются по пройденному пути. Непрозрачные
// (вырез формы — discard): пишут глубину, не смешиваются, правильно закрываются предметами.
const LEAF_VS = /* glsl */ `
  attribute vec4 aSeed;
  attribute vec4 aRnd;
  uniform vec3 uCenter;
  uniform vec3 uBox;
  uniform vec3 uTravel;
  uniform vec3 uGround;
  uniform vec4 uLeaf;   // полудлина листа (м), размах покачивания по высоте (м), уровень 0..1 (сколько листьев), доля лепестков
  uniform vec2 uSway;   // фаза медленного покачивания (рад, по кругу 2π), общий подъём в порыв ветра (м)
  uniform vec3 uColA;
  uniform vec3 uColB;
  uniform vec3 uColC;   // цвет лепестков
  uniform vec3 uLight;
  uniform float uFogK;
  varying vec2 vUv;
  varying vec3 vCol;
  varying float vFog;
  varying float vPetal;
  void main() {
    vec3 q = fract(aSeed.xyz + uTravel * aRnd.x / uBox);
    vec2 rel = fract(q.xz - uCenter.xz / uBox.xz + 0.5) - 0.5;
    vec2 L = uCenter.xz + rel * uBox.xz;
    float hgt = uBox.y * q.y * sqrt(q.y); // у земли гуще
    vec3 P = vec3(L.x, uGround.x + dot(uGround.yz, L) + 0.08 + hgt, L.y);
    // Лист летит по ветру ровно и понемногу снижается; сверху — только плавное медленное покачивание.
    // Оно идёт по времени (uSway.x), а не по пройденному пути: при сильном ветре лист не начинает скакать
    // по высоте. Период — один или половина круга фазы (целое n: без скачка, когда фаза заворачивается).
    float n = 1.0 + step(0.5, fract(aRnd.y * 5.3));
    float aloft = smoothstep(0.0, 0.15, q.y); // у самой земли не качается и не уходит под неё
    P.y += aloft * (uLeaf.y * sin(uSway.x * n + aRnd.z * 6.2831853) + uSway.y);
    P.xz += aloft * uLeaf.y * 1.6
      * vec2(cos(uSway.x * (3.0 - n) + aRnd.w * 6.2831853), sin(uSway.x * n + aRnd.y * 6.2831853));

    float petal = step(aRnd.w, uLeaf.w);
    float fade = (1.0 - smoothstep(0.4, 0.5, abs(rel.x))) * (1.0 - smoothstep(0.4, 0.5, abs(rel.y)))
      * smoothstep(0.0, 0.05, q.y) * (1.0 - smoothstep(0.9, 1.0, q.y))
      * clamp((uLeaf.z - aSeed.w * 0.9) * 10.0, 0.0, 1.0);
    float size = uLeaf.x * (0.7 + 0.6 * aRnd.y) * mix(1.0, 0.42, petal) * fade;
    // кувыркание вокруг своей случайной оси; угол — по узлу решётки (целое число оборотов на коробку)
    vec3 ax = normalize(aRnd.yzw - 0.5 + vec3(0.001));
    float ang = 6.2831853 * ((3.0 + floor(aSeed.w * 6.0)) * (q.x + q.y + q.z) + aRnd.z);
    float c = cos(ang);
    float s = sin(ang);
    vec3 o = vec3(position.x * mix(0.55, 0.8, petal), position.y, 0.0) * size;
    vec3 ro = o * c + cross(ax, o) * s + ax * (dot(ax, o) * (1.0 - c));
    float ny = (cross(ax, vec3(0.0, 0.0, 1.0)) * s + ax * (ax.z * (1.0 - c))).y; // нормаль листа, y
    vec4 mv = viewMatrix * vec4(P + ro, 1.0);
    gl_Position = projectionMatrix * mv;
    vec3 base = mix(uColA, uColB, smoothstep(0.2, 0.8, fract(aRnd.z * 7.31 + aRnd.y * 3.7)));
    vCol = mix(base, uColC, petal) * uLight * (0.55 + 0.45 * abs(ny)) * (0.8 + 0.4 * fract(aRnd.y * 13.7));
    vUv = position.xy;
    vPetal = petal;
    vFog = 1.0 - exp(-length(mv.xyz) * uFogK);
  }
`;

const LEAF_FS = /* glsl */ `
  uniform vec3 uFogColor;
  varying vec2 vUv;
  varying vec3 vCol;
  varying float vFog;
  varying float vPetal;
  void main() {
    float y2 = vUv.y * vUv.y;
    // лист заострён с обоих концов, лепесток — овал
    if (abs(vUv.x) > mix(1.0 - y2, sqrt(max(0.0, 1.0 - y2)), vPetal)) discard;
    vec3 col = vCol * (0.8 + 0.2 * smoothstep(0.0, 0.2, abs(vUv.x))); // тёмная жилка посередине
    gl_FragColor = vec4(mix(col, uFogColor, vFog), 1.0);
    #include <colorspace_fragment>
  }
`;

// Молния: отрезки-капсулы лицом к глазу, яркая сердцевина и широкое свечение; складывается со сценой.
const BOLT_VS = /* glsl */ `
  attribute vec4 aA;    // начало отрезка, полуширина свечения (м)
  attribute vec4 aB;    // конец отрезка, яркость
  attribute float aC;   // номер разряда + 2 × (1 — только свечение, без сердцевины)
  uniform vec2 uBolt;   // яркость разрядов 0 и 1 в этом кадре
  varying vec2 vP;
  varying vec3 vInfo;   // половина длины, полуширина, есть ли сердцевина
  varying float vBright;
  void main() {
    float glowOnly = step(1.5, aC);
    float slot = aC - 2.0 * glowOnly;
    float bright = aB.w * (slot < 0.5 ? uBolt.x : uBolt.y);
    vec3 a = (viewMatrix * vec4(aA.xyz, 1.0)).xyz;
    vec3 b = (viewMatrix * vec4(aB.xyz, 1.0)).xyz;
    vec3 ab = b - a;
    float len = length(ab);
    vec3 dir = len > 1e-3 ? ab / len : vec3(0.0, 1.0, 0.0);
    vec3 mid = (a + b) * 0.5;
    vec3 side = cross(dir, normalize(-mid));
    float sl = length(side);
    side = sl > 1e-3 ? side / sl : vec3(1.0, 0.0, 0.0);
    float w = bright > 0.002 ? aA.w : 0.0;
    float halfLen = bright > 0.002 ? len * 0.5 : 0.0;
    vP = vec2(position.x * w, position.y * (halfLen + w));
    vInfo = vec3(halfLen, max(w, 1e-4), 1.0 - glowOnly);
    vBright = bright;
    gl_Position = projectionMatrix * vec4(mid + dir * vP.y + side * vP.x, 1.0);
  }
`;

const BOLT_FS = /* glsl */ `
  uniform vec3 uGlow;
  varying vec2 vP;
  varying vec3 vInfo;
  varying float vBright;
  void main() {
    float d = length(vec2(vP.x, max(abs(vP.y) - vInfo.x, 0.0))) / vInfo.y; // до оси отрезка, 0..1
    float g = max(0.0, 1.0 - d);
    vec3 col = uGlow * (g * g * g * mix(0.6, 0.7, vInfo.z)) + vec3(1.0) * (smoothstep(0.2, 0.07, d) * vInfo.z);
    gl_FragColor = vec4(col * vBright, 1.0);
    #include <colorspace_fragment>
  }
`;

// ---------------------------------------------------------------------------------- текстуры и геометрия

function mulberry(seedValue) {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// R — штрихи дождя, G — точки снега; повторяется по обеим осям.
function makeWallTexture(THREE) {
  const S = 256;
  const rand = mulberry(0x51ab1e);
  const data = new Uint8Array(S * S * 4);
  const put = (x, y, ch, v) => {
    const i = ((y & 255) * S + (x & 255)) * 4 + ch;
    const b = Math.round(v * 255);
    if (b > data[i]) data[i] = b;
  };
  for (let k = 0; k < 560; k += 1) {
    const x = Math.floor(rand() * S);
    const y0 = Math.floor(rand() * S);
    const len = 12 + Math.floor(rand() * 70);
    const bright = 0.25 + 0.75 * rand() * rand();
    for (let j = 0; j < len; j += 1) {
      const v = bright * Math.sin((Math.PI * (j + 0.5)) / len) ** 0.6;
      put(x, y0 + j, 0, v);
      put(x - 1, y0 + j, 0, v * 0.3);
      put(x + 1, y0 + j, 0, v * 0.3);
    }
  }
  for (let k = 0; k < 380; k += 1) {
    const cx = rand() * S;
    const cy = rand() * S;
    const r = 0.7 + 1.9 * rand() * rand();
    const bright = 0.35 + 0.65 * rand();
    const x0 = Math.floor(cx - r - 1);
    const y0 = Math.floor(cy - r - 1);
    for (let y = y0; y <= y0 + 2 * r + 3; y += 1) {
      for (let x = x0; x <= x0 + 2 * r + 3; x += 1) {
        const d = Math.sqrt((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2);
        const v = bright * clamp01((r + 0.6 - d) / 1.2);
        if (v > 0) put(x, y, 1, v);
      }
    }
  }
  for (let i = 3; i < data.length; i += 4) data[i] = 255;
  const texture = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// 2×2 варианта мягкого клуба 64×64: плотность в альфе, «рельеф» в RGB.
function makePuffTexture(THREE) {
  const CELL = 64;
  const S = CELL * 2;
  const rand = mulberry(0xc10d5);
  const lattice = new Float32Array(32 * 32);
  for (let i = 0; i < lattice.length; i += 1) lattice[i] = rand();
  const at = (x, y) => lattice[(y & 31) * 32 + (x & 31)];
  const noise = (x, y) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const a = at(xi, yi);
    const b = at(xi + 1, yi);
    const c = at(xi, yi + 1);
    const d = at(xi + 1, yi + 1);
    return a + (b - a) * u + (c + (d - c) * u - (a + (b - a) * u)) * v;
  };
  const fbm = (x, y) => noise(x, y) * 0.55 + noise(x * 2.1 + 9.2, y * 2.1 + 3.4) * 0.3 + noise(x * 4.3 + 1.7, y * 4.3 + 6.1) * 0.15;
  const data = new Uint8Array(S * S * 4);
  for (let cell = 0; cell < 4; cell += 1) {
    const ox = (cell % 2) * CELL;
    const oy = Math.floor(cell / 2) * CELL;
    const sx = cell * 7.3 + 2.1;
    const sy = cell * 4.7 + 5.9;
    for (let y = 0; y < CELL; y += 1) {
      for (let x = 0; x < CELL; x += 1) {
        const u = ((x + 0.5) / CELL) * 2 - 1;
        const v = ((y + 0.5) / CELL) * 2 - 1;
        const r = Math.sqrt(u * u + v * v);
        const big = fbm(u * 1.5 + sx, v * 1.5 + sy);
        const mid = fbm(u * 3.1 + sx + 11.1, v * 3.1 + sy + 5.3);
        let a = 1 - smooth(0.1, 0.95, r + (big - 0.5) * 0.8);
        a *= (0.6 + 0.55 * mid) * (1 - smooth(0.8, 0.99, r));
        const i = ((oy + y) * S + ox + x) * 4;
        data[i] = data[i + 1] = data[i + 2] = Math.round(clamp01(0.5 + (mid - 0.5) * 1.8) * 255);
        data[i + 3] = Math.round(clamp01(a) * 255);
      }
    }
  }
  const texture = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

// Всё, что переживает подмену сцены: случайные узлы, геометрия каждого вида, текстуры.
function buildAssets(THREE) {
  const rand = mulberry(0x5eed1234);
  const seed = new Float32Array(MAX_CAP * 4);
  const rnd = new Float32Array(MAX_CAP * 4);
  for (let i = 0; i < MAX_CAP * 4; i += 4) {
    seed[i] = rand();
    seed[i + 1] = rand();
    seed[i + 2] = rand();
    seed[i + 3] = rand();
    rnd[i] = (12 + Math.floor(rand() * 9)) / LAP; // 0,75…1,25 шагами 1/16: путь решётки заворачивается без скачка
    rnd[i + 1] = rand();
    rnd[i + 2] = rand();
    rnd[i + 3] = rand();
  }
  const index = new THREE.Uint16BufferAttribute([0, 1, 2, 0, 2, 3], 1);
  const corners = new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3);
  const seedAttr = new THREE.InstancedBufferAttribute(seed, 4);
  const rndAttr = new THREE.InstancedBufferAttribute(rnd, 4);
  const all = [];
  // геометрия каждого вида — своя (свой instanceCount), а буферы у всех общие. Создаётся один раз здесь,
  // а не при каждой подмене сцены: освобождение одной такой геометрии удалило бы общие буферы у остальных
  const quads = {};
  for (const name of KIND_NAMES) {
    const g = new THREE.InstancedBufferGeometry();
    g.setIndex(index);
    g.setAttribute('position', corners);
    g.setAttribute('aSeed', seedAttr);
    g.setAttribute('aRnd', rndAttr);
    g.instanceCount = 0;
    all.push(g);
    quads[name] = g;
  }

  // цилиндр «стены»: x — доля окружности, y — доля высоты
  const wall = new THREE.BufferGeometry();
  const wallPos = [];
  const wallIndex = [];
  for (let j = 0; j <= WALL_ROWS; j += 1) for (let i = 0; i <= WALL_SEG; i += 1) wallPos.push(i / WALL_SEG, j / WALL_ROWS, 0);
  for (let j = 0; j < WALL_ROWS; j += 1) {
    for (let i = 0; i < WALL_SEG; i += 1) {
      const a = j * (WALL_SEG + 1) + i;
      const b = a + WALL_SEG + 1;
      wallIndex.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }
  wall.setIndex(wallIndex);
  wall.setAttribute('position', new THREE.Float32BufferAttribute(wallPos, 3));
  all.push(wall);

  // молния: отрезки пишутся в момент удара, памяти на это не выделяется
  const bolt = new THREE.InstancedBufferGeometry();
  const boltN = BOLT_SEGS * BOLT_SLOTS;
  const boltA = new THREE.InstancedBufferAttribute(new Float32Array(boltN * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const boltB = new THREE.InstancedBufferAttribute(new Float32Array(boltN * 4), 4).setUsage(THREE.DynamicDrawUsage);
  const boltC = new THREE.InstancedBufferAttribute(new Float32Array(boltN), 1).setUsage(THREE.DynamicDrawUsage);
  bolt.setIndex(index);
  bolt.setAttribute('position', corners);
  bolt.setAttribute('aA', boltA);
  bolt.setAttribute('aB', boltB);
  bolt.setAttribute('aC', boltC);
  bolt.instanceCount = 0;
  all.push(bolt);

  const wallTexture = makeWallTexture(THREE);
  const puffTexture = makePuffTexture(THREE);
  return {
    quads,
    wall,
    bolt,
    boltA,
    boltB,
    boltC,
    wallTexture,
    puffTexture,
    dispose() {
      for (const g of all) g.dispose();
      wallTexture.dispose();
      puffTexture.dispose();
    },
  };
}

// ---------------------------------------------------------------------------------- сам модуль

// что читается из atmosphere.now (числа) и чем заменяется, пока модуля состояния нет
const NUMBERS = {
  rain: 0, snow: 0, hail: 0, sleet: 0, dust: 0, smoke: 0, leaves: 0,
  wind: 0.3, gust: 0, flash: 0, day: 1,
  sunPower: 1, ambientPower: 1, sunDirect: 1, visibilityM: 20000,
  spring: 0, summer: 1, autumn: 0, winter: 0,
};
const NUMBER_KEYS = Object.keys(NUMBERS);

export function createWeatherFx(ctx) {
  const { THREE, root, camera, renderer } = ctx;
  const shared = (globalThis.__sceneState ??= {});

  const cacheKey = buildAssets.toString() + makeWallTexture.toString() + makePuffTexture.toString() + KIND_NAMES.join();
  if (shared.weatherFxCache?.key !== cacheKey) {
    shared.weatherFxCache?.assets?.dispose?.(); // во время подмены сцены оболочка придержит и выполнит сама
    shared.weatherFxCache = { key: cacheKey, assets: buildAssets(THREE) };
  }
  const assets = shared.weatherFxCache.assets;
  // путь решёток и время переживают подмену сцены: дождь не «перепрыгивает» при каждой правке
  const live = (shared.weatherFxLive ??= { time: 0, fall: 0, travel: {} });
  live.sway ??= 0; // фаза покачивания листьев
  live.lift ??= 0; // подъём листьев в порыв, м

  // ---- общие униформы
  const uFogColor = { value: new THREE.Color(0.7, 0.72, 0.78) };
  const uFogK = { value: 0 };
  const uGround = { value: new THREE.Vector3() };

  const BLEND = { transparent: true, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true, toneMapped: false };
  const meshes = [];
  const add = (name, geometry, material, order) => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.frustumCulled = false; // место считается в шейдере
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = order;
    root.add(mesh);
    meshes.push(mesh);
    return mesh;
  };
  const kind = (name, vertexShader, fragmentShader, box, order, uniforms, options = BLEND) => {
    const u = {
      uCenter: { value: new THREE.Vector3() },
      uBox: { value: new THREE.Vector3(box[0], box[1], box[2]) },
      uTravel: { value: new THREE.Vector3() },
      uColor: { value: new THREE.Color(1, 1, 1) },
      uFogColor,
      uFogK,
      uGround,
      ...uniforms,
    };
    const geometry = assets.quads[name];
    const material = new THREE.ShaderMaterial({ uniforms: u, vertexShader, fragmentShader, ...options });
    return { name, u, box, geometry, material, mesh: add(`weather-${name}`, geometry, material, order), travel: (live.travel[name] ??= [0, 0, 0]), n: 0 };
  };
  const v2 = () => ({ value: new THREE.Vector2() });
  const v3 = () => ({ value: new THREE.Vector3() });
  const v4 = () => ({ value: new THREE.Vector4() });
  const streak = (name, box, order) =>
    kind(name, STREAK_VS, GRAIN_FS, box, order, { uDir: { value: new THREE.Vector3(0, -1, 0) }, uSize: v4(), uLook: v4(), uShape: v2() });
  const puffs = (name, box) =>
    kind(name, PUFF_VS, PUFF_FS, box, 4, { uPuff: v4(), uLook: v4(), uTex: { value: assets.puffTexture } });

  // порядок отрисовки среди прозрачного: молния 1, стена 3, клубы 4, брызги 5, осадки 6–7
  const rain = streak('rain', [18, 12, 18], 6);
  const snow = streak('snow', [12, 8, 12], 6);
  const grit = streak('grit', [16, 6, 16], 6);
  const hail = kind('hail', HAIL_VS, GRAIN_FS, [16, 1, 16], 7, { uHail: v4(), uWindV: v2(), uLook: v4(), uShape: { value: new THREE.Vector2(1, 0.85) } });
  const splash = kind('splash', SPLASH_VS, SPLASH_FS, [14, 1, 14], 5, { uSplash: v4(), uLook: v2() });
  const dust = puffs('dust', [46, 1, 46]);
  const smog = puffs('smog', [56, 1, 56]);
  const veil = puffs('snow-veil', [38, 1, 38]);
  const mist = puffs('rain-mist', [38, 1, 38]);
  const leaves = kind(
    'leaves', LEAF_VS, LEAF_FS, [34, 9, 34], 0,
    { uLeaf: v4(), uSway: v2(), uColA: { value: new THREE.Color() }, uColB: { value: new THREE.Color() }, uColC: { value: new THREE.Color() }, uLight: v3() },
    { side: THREE.DoubleSide, toneMapped: false },
  );
  const kinds = [rain, snow, grit, hail, splash, dust, smog, veil, mist, leaves];
  for (const k of kinds) k.u.uTravel.value.fromArray(k.travel);

  const wallU = {
    uHead: v3(),
    uWall: { value: new THREE.Vector4(WALL_R, -4, 6, WALL_TILE) }, // полоса у горизонта: выше дождь рисуют ближние штрихи
    uFlow: v3(),
    uTex: { value: assets.wallTexture },
    uColor: { value: new THREE.Color(1, 1, 1) },
    uMix: v2(),
  };
  const wallMaterial = new THREE.ShaderMaterial({ uniforms: wallU, vertexShader: WALL_VS, fragmentShader: WALL_FS, ...BLEND });
  const wall = add('weather-wall', assets.wall, wallMaterial, 3);

  const boltU = { uBolt: v2(), uGlow: { value: new THREE.Color(0.62, 0.66, 1.0) } };
  const boltMaterial = new THREE.ShaderMaterial({
    uniforms: boltU, vertexShader: BOLT_VS, fragmentShader: BOLT_FS, ...BLEND, blending: THREE.AdditiveBlending,
  });
  const boltMesh = add('weather-lightning', assets.bolt, boltMaterial, 1);

  // ---- состояние кадра (без выделения памяти)
  const st = { ...NUMBERS, windX: 1, windZ: 0, ambR: 0.75, ambG: 0.8, ambB: 0.9, sunR: 1, sunG: 0.75, sunB: 0.55, fogR: 0.7, fogG: 0.72, fogB: 0.78 };
  const head = new THREE.Vector3();
  const look = new THREE.Vector3();
  const lightC = [1, 1, 1]; // свет на частицах, линейный
  let lum = 1;
  let warm = 0; // кадров после создания: первые три все сетки видимы (шейдеры собираются при появлении сцены)
  let cpuMs = 0;
  let drawn = 0;
  let debugFlash = 0;
  let strikes = 0; // сколько разрядов нарисовано с появления сцены

  // отладочная подмена значений: живёт в shared и переживает подмену сцены
  const debug = {
    values: shared.weatherFxDebug?.values ?? null,
    set(values) {
      debug.values = { ...(debug.values ?? {}), ...values };
      return debug.values;
    },
    clear() {
      debug.values = null;
    },
    strike(o = {}) {
      camera.getWorldPosition(head);
      camera.getWorldDirection(look);
      const d = o.distM ?? 400;
      const side = o.side ?? 0; // м вбок от линии взгляда
      const len = Math.hypot(look.x, look.z) || 1;
      const x = o.x ?? head.x + (look.x / len) * d - (look.z / len) * side;
      const z = o.z ?? head.z + (look.z / len) * d + (look.x / len) * side;
      strike({ x, y: o.y, z, distM: d, power: o.power ?? 1 });
      debugFlash = 1;
      return { x, z, distM: d };
    },
    stats: () => api.stats(),
  };
  shared.weatherFxDebug = debug;

  const colorTo = (value, prefix) => {
    if (value == null) return;
    if (typeof value === 'number') {
      scratchColor.setHex(value);
      st[`${prefix}R`] = scratchColor.r; st[`${prefix}G`] = scratchColor.g; st[`${prefix}B`] = scratchColor.b;
    } else if (value.isColor) {
      st[`${prefix}R`] = value.r; st[`${prefix}G`] = value.g; st[`${prefix}B`] = value.b;
    } else if (value.length >= 3) {
      st[`${prefix}R`] = value[0]; st[`${prefix}G`] = value[1]; st[`${prefix}B`] = value[2];
    }
  };
  const scratchColor = new THREE.Color();
  const AMB = ['ambR', 'ambG', 'ambB'];
  const SUN = ['sunR', 'sunG', 'sunB'];
  const FOG = ['fogR', 'fogG', 'fogB'];
  const copyColor = (color, keys) => {
    if (!color) return;
    st[keys[0]] = color.r; st[keys[1]] = color.g; st[keys[2]] = color.b;
  };

  function read(now, dbg) {
    for (let i = 0; i < NUMBER_KEYS.length; i += 1) {
      const key = NUMBER_KEYS[i];
      const v = dbg?.[key] ?? now?.[key];
      st[key] = typeof v === 'number' && v === v ? v : NUMBERS[key];
    }
    copyColor(now?.ambientColor, AMB);
    copyColor(now?.sunColor, SUN);
    copyColor(now?.fogColor, FOG);
    let wx = now?.windDir?.x ?? 1;
    let wz = now?.windDir?.y ?? 0;
    if (dbg) {
      colorTo(dbg.ambientColor, 'amb');
      colorTo(dbg.sunColor, 'sun');
      colorTo(dbg.fogColor, 'fog');
      if (dbg.windDir) {
        wx = dbg.windDir[0] ?? dbg.windDir.x ?? wx;
        wz = dbg.windDir[1] ?? dbg.windDir.y ?? wz;
      }
    }
    const wl = Math.hypot(wx, wz);
    st.windX = wl > 1e-4 ? wx / wl : 1;
    st.windZ = wl > 1e-4 ? wz / wl : 0;
    if (debugFlash > st.flash) st.flash = debugFlash;
  }

  const hide = (k) => {
    k.n = 0;
    k.geometry.instanceCount = 0;
    k.mesh.visible = warm < 3;
  };
  const show = (k, n) => {
    k.n = n;
    k.geometry.instanceCount = n;
    k.mesh.visible = true;
  };
  // решётка вида уехала на v·dt; центр коробки — перед головой
  const move = (k, vx, vy, vz, dt, ahead, up) => {
    const t = k.travel;
    t[0] = wrapTo(t[0] + vx * dt, k.box[0] * LAP);
    t[1] = wrapTo(t[1] + vy * dt, k.box[1] * LAP);
    t[2] = wrapTo(t[2] + vz * dt, k.box[2] * LAP);
    k.u.uTravel.value.set(t[0], t[1], t[2]);
    k.u.uCenter.value.set(head.x + look.x * ahead, head.y + up, head.z + look.z * ahead);
  };
  // Цвет дымки — клубов и «стены»: освещённый цвет (r, g, b), но не светлее дымки у горизонта в `cap` раз, и
  // наполовину её оттенка. Ночью без вспышки клубы выходят цвета тёмной дымки, а не светятся на тёмной сцене;
  // вспышка молнии уже есть и в свете, и в цвете дымки (uFogColor) — она их высвечивает.
  const haze = (target, r, g, b, cap) => {
    const f = uFogColor.value;
    const lit = r * 0.3 + g * 0.55 + b * 0.15;
    const most = cap * (f.r * 0.3 + f.g * 0.55 + f.b * 0.15);
    const s = lit > most ? most / lit : 1;
    const m = 0.5 * s;
    target.setRGB(Math.min(1, f.r * cap * (1 - m) + r * s * m), Math.min(1, f.g * cap * (1 - m) + g * s * m), Math.min(1, f.b * cap * (1 - m) + b * s * m));
  };
  const tint = (k, r, g, b, max = 1) => {
    k.u.uColor.value.setRGB(Math.min(max, lightC[0] * r), Math.min(max, lightC[1] * g), Math.min(max, lightC[2] * b));
  };

  // ---- молния
  const boltAge = [BOLT_LIFE, BOLT_LIFE];
  const boltPower = [0, 0];
  const BOLT_MAIN = 40;
  const walkU = new Float32Array(BOLT_MAIN + 1);
  const walkV = new Float32Array(BOLT_MAIN + 1);
  const pts = new Float32Array((BOLT_MAIN + 1) * 3);
  const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) * 1.15;
  const bA = assets.boltA.array;
  const bB = assets.boltB.array;
  const bC = assets.boltC.array;

  function strike(e) {
    if (!e) return;
    const slot = boltAge[0] >= BOLT_LIFE || (boltAge[1] < BOLT_LIFE && boltAge[0] > boltAge[1]) ? 0 : 1;
    const base = slot * BOLT_SEGS;
    let n = 0;
    const seg = (ax, ay, az, bx, by, bz, w, bright, glowOnly) => {
      if (n >= BOLT_SEGS) return;
      const i = (base + n) * 4;
      bA[i] = ax; bA[i + 1] = ay; bA[i + 2] = az; bA[i + 3] = w;
      bB[i] = bx; bB[i + 1] = by; bB[i + 2] = bz; bB[i + 3] = bright;
      bC[base + n] = slot + (glowOnly ? 2 : 0);
      n += 1;
    };
    camera.getWorldPosition(head);
    const ex = Number(e.x) || 0;
    const ez = Number(e.z) || 0;
    const ey = Math.max(groundHeight(ex, ez), typeof e.y === 'number' && e.y > 0 ? e.y : -1e9); // состояние даёт y = 0: земля там может быть выше или ниже
    const dist = Math.max(40, typeof e.distM === 'number' ? e.distM : Math.hypot(ex - head.x, ez - head.z));
    const power = Math.min(2, Math.max(0.3, typeof e.power === 'number' ? e.power : 1));
    const H = Math.min(900, Math.max(180, dist * 0.6)); // высота тучи над точкой удара
    const lean = Math.random() * Math.PI * 2;
    const off = H * (0.1 + 0.3 * Math.random());
    const tx = ex + Math.cos(lean) * off;
    const ty = ey + H;
    const tz = ez + Math.sin(lean) * off;
    // канал сверху вниз и два перпендикуляра к нему
    let dx = ex - tx, dy = ey - ty, dz = ez - tz;
    const dl = Math.hypot(dx, dy, dz);
    dx /= dl; dy /= dl; dz /= dl;
    let ux = -dz, uz = dx; // поперёк канала по горизонтали
    const ul = Math.hypot(ux, uz) || 1;
    ux /= ul; uz /= ul;
    const vx = dy * uz, vy = dz * ux - dx * uz, vz = -dy * ux; // d × u
    // блуждание поперёк канала, сведённое к нулю на обоих концах
    const sigma = H * 0.02;
    let ou = 0, ov = 0;
    walkU[0] = 0; walkV[0] = 0;
    for (let k = 1; k <= BOLT_MAIN; k += 1) {
      ou += gauss() * sigma;
      ov += gauss() * sigma;
      walkU[k] = ou;
      walkV[k] = ov;
    }
    const W = Math.max(0.6, dist * 0.016) * Math.sqrt(power); // полуширина свечения: ~0,9° на любом расстоянии
    for (let k = 0; k <= BOLT_MAIN; k += 1) {
      const f = k / BOLT_MAIN;
      const a = walkU[k] - ou * f;
      const b = walkV[k] - ov * f;
      pts[k * 3] = tx + (ex - tx) * f + ux * a + vx * b;
      pts[k * 3 + 1] = ty + (ey - ty) * f + vy * b;
      pts[k * 3 + 2] = tz + (ez - tz) * f + uz * a + vz * b;
      if (k > 0) {
        const j = (k - 1) * 3;
        seg(pts[j], pts[j + 1], pts[j + 2], pts[k * 3], pts[k * 3 + 1], pts[k * 3 + 2], W, Math.min(1, f / 0.12), false); // верх тает в туче
      }
    }
    // ветви: от случайных узлов канала вниз и в сторону, тоньше и тусклее к концу
    const branches = 4 + Math.floor(Math.random() * 4);
    const step = H / BOLT_MAIN;
    for (let b = 0; b < branches && n < BOLT_SEGS - 12; b += 1) {
      const k0 = 4 + Math.floor(Math.random() * (BOLT_MAIN - 12));
      const m = 5 + Math.floor(Math.random() * 10);
      const phi = Math.random() * Math.PI * 2;
      const out = 0.5 + 0.5 * Math.random();
      const down = 0.55 + 0.3 * Math.random();
      let bx = dx * down + (ux * Math.cos(phi) + vx * Math.sin(phi)) * out;
      let by = dy * down + vy * Math.sin(phi) * out;
      let bz = dz * down + (uz * Math.cos(phi) + vz * Math.sin(phi)) * out;
      const bl = Math.hypot(bx, by, bz) || 1;
      bx /= bl; by /= bl; bz /= bl;
      const st0 = step * (0.9 + 0.4 * Math.random());
      let px = pts[k0 * 3], py = pts[k0 * 3 + 1], pz = pts[k0 * 3 + 2];
      for (let j = 0; j < m && n < BOLT_SEGS - 2; j += 1) {
        const qx = px + bx * st0 + (ux * gauss() + vx * gauss()) * sigma * 0.8;
        const qy = py + by * st0 + vy * gauss() * sigma * 0.8;
        const qz = pz + bz * st0 + (uz * gauss() + vz * gauss()) * sigma * 0.8;
        const f = j / m;
        seg(px, py, pz, qx, qy, qz, W * (0.55 - 0.3 * f), 0.6 * (1 - f) + 0.06, false);
        px = qx; py = qy; pz = qz;
      }
    }
    seg(tx, ty, tz, tx, ty, tz, H * 0.24, 0.55, true); // зарево в туче
    seg(ex, ey + W, ez, ex, ey + W, ez, W * 5, 0.9, true); // вспышка у земли
    for (let k = n; k < BOLT_SEGS; k += 1) {
      const i = (base + k) * 4;
      bA[i + 3] = 0;
      bB[i + 3] = 0;
    }
    for (const attr of [assets.boltA, assets.boltB]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(base * 4, BOLT_SEGS * 4);
      attr.needsUpdate = true;
    }
    assets.boltC.clearUpdateRanges();
    assets.boltC.addUpdateRange(base, BOLT_SEGS);
    assets.boltC.needsUpdate = true;
    boltAge[slot] = 0;
    boltPower[slot] = 0.65 + 0.35 * power;
    strikes += 1;
  }

  // мерцание разряда: первый удар в полную силу, потом два-три повторных, затухая
  const boltLevel = (age) => {
    if (age >= BOLT_LIFE) return 0;
    const flicker = age < 0.045 ? 1 : 0.5 + 0.5 * Math.sin(age * 130 + 1.2);
    return (1 - smooth(BOLT_LIFE * 0.45, BOLT_LIFE, age)) * (0.3 + 0.7 * flicker);
  };

  let listening = null;
  let stopListening = null;
  const listen = () => {
    const atmo = shared.atmosphere;
    if (atmo === listening) return;
    stopListening?.();
    stopListening = null;
    listening = atmo;
    if (atmo?.on) stopListening = atmo.on('lightning', strike) ?? null;
  };

  // цвета листьев по временам года (sRGB → линейный)
  const hex = (h) => new THREE.Color(h);
  const SEASON_A = { spring: hex(0x7fbf4a), summer: hex(0x5f9a2e), autumn: hex(0xe0a81c), winter: hex(0x6b5a45) };
  const SEASON_B = { spring: hex(0xa9cc55), summer: hex(0x8aa83a), autumn: hex(0xc2461a), winter: hex(0x8f7d66) };
  const PETAL = hex(0xffd9e6);
  const seasonMix = (target, table) => {
    const s = st.spring + st.summer + st.autumn + st.winter || 1;
    target.setRGB(
      (table.spring.r * st.spring + table.summer.r * st.summer + table.autumn.r * st.autumn + table.winter.r * st.winter) / s,
      (table.spring.g * st.spring + table.summer.g * st.summer + table.autumn.g * st.autumn + table.winter.g * st.winter) / s,
      (table.spring.b * st.spring + table.summer.b * st.summer + table.autumn.b * st.autumn + table.winter.b * st.winter) / s,
    );
  };

  // клубы одного вида: сила 0..1 → сколько видно и насколько плотные
  const puffUpdate = (k, level, alpha, speedX, speedZ, dt, ahead, h0, h1, r0, r1, near0, near1, r, g, b, cap) => {
    if (level <= 0.003 || alpha <= 0.003) return hide(k);
    move(k, speedX, 0, speedZ, dt, ahead, 0);
    k.u.uPuff.value.set(h0, h1, r0, r1);
    k.u.uLook.value.set(alpha, level, near0, near1);
    haze(k.u.uColor.value, lightC[0] * r, lightC[1] * g, lightC[2] * b, cap);
    show(k, PUFF_CAP);
  };

  const api = {
    update(dtRaw) {
      const t0 = performance.now();
      const dt = Math.min(0.2, Math.max(0, dtRaw || 0));
      listen();
      const now = shared.atmosphere?.now;
      const dbg = debug.values;
      debugFlash = Math.max(0, debugFlash - dt * 5);

      // молния живёт и без осадков
      let boltOn = false;
      for (let s = 0; s < BOLT_SLOTS; s += 1) {
        if (boltAge[s] < BOLT_LIFE) {
          boltAge[s] += Math.min(dt, 0.05);
          boltOn = boltOn || boltAge[s] < BOLT_LIFE;
        }
      }
      const flashNow = Math.max(debugFlash, typeof now?.flash === 'number' ? now.flash : 0);
      const flashK = 0.5 + 0.5 * Math.min(1, flashNow * 1.5);
      boltU.uBolt.value.set(boltLevel(boltAge[0]) * boltPower[0] * flashK, boltLevel(boltAge[1]) * boltPower[1] * flashK);
      assets.bolt.instanceCount = boltOn ? BOLT_SEGS * BOLT_SLOTS : 0;
      boltMesh.visible = boltOn || warm < 3;

      if (!now && !dbg) {
        // состояния ещё нет: кадр пропускается
        for (const k of kinds) hide(k);
        wall.visible = warm < 3;
        if (warm < 3) warm += 1;
        drawn = boltOn ? 1 : 0;
        return;
      }
      read(now, dbg);
      live.time = (live.time + dt) % PERIOD;
      camera.getWorldPosition(head);
      camera.getWorldDirection(look);
      look.y = 0;
      const ll = Math.hypot(look.x, look.z);
      if (ll > 1e-4) look.multiplyScalar(1 / ll);
      else look.set(0, 0, -1);

      // земля рядом — плоскость по трём замерам (точная высота сетки земли, car.js)
      const g0 = groundHeight(head.x, head.z);
      const gx = (groundHeight(head.x + 4, head.z) - groundHeight(head.x - 4, head.z)) / 8;
      const gz = (groundHeight(head.x, head.z + 4) - groundHeight(head.x, head.z - 4)) / 8;
      uGround.value.set(g0 - gx * head.x - gz * head.z, gx, gz);

      // Свет на частицах (линейный, «готовый для экрана»: материалы без тональной компрессии) — тот же, что
      // world.js кладёт на землю и траву: shared.skyLook, свет неба + часть прямого (вспышка молнии уже в нём).
      // Свет предметов (now.ambientColor × ambientPower) рассчитан на тональную компрессию: ночью он втрое
      // ярче света земли, и частицы с ним светились бы на тёмной сцене. Им считается только запасной вариант
      // (мира ещё нет или свет подменён отладкой), с поправкой на ночь.
      const fl = Math.min(2, st.flash);
      const skyLook = shared.skyLook;
      const ownLight = dbg && (dbg.ambientColor != null || dbg.ambientPower != null || dbg.sunColor != null || dbg.sunPower != null || dbg.sunDirect != null || dbg.day != null);
      let lr;
      let lg;
      let lb;
      if (skyLook?.skyLight && skyLook.sunLight && !ownLight) {
        const extra = Math.max(0, fl - (typeof now?.flash === 'number' ? now.flash : 0)); // вспышка отладочного разряда
        lr = skyLook.skyLight.r + 0.35 * skyLook.sunLight.r + extra * 0.9;
        lg = skyLook.skyLight.g + 0.35 * skyLook.sunLight.g + extra * 0.95;
        lb = skyLook.skyLight.b + 0.35 * skyLook.sunLight.b + extra;
      } else {
        const nightK = lerp(0.42, 1, clamp01(st.day));
        const aP = st.ambientPower * 0.8 * nightK;
        const sP = st.sunPower * st.sunDirect * 0.3 * nightK;
        lr = st.ambR * aP + st.sunR * sP + fl * 0.9;
        lg = st.ambG * aP + st.sunG * sP + fl * 0.95;
        lb = st.ambB * aP + st.sunB * sP + fl;
      }
      lightC[0] = Math.min(1.3, Math.max(0.004, lr));
      lightC[1] = Math.min(1.3, Math.max(0.005, lg));
      lightC[2] = Math.min(1.3, Math.max(0.008, lb));
      lum = lightC[0] * 0.3 + lightC[1] * 0.55 + lightC[2] * 0.15;
      uFogColor.value.setRGB(Math.min(1, st.fogR + fl * 0.5), Math.min(1, st.fogG + fl * 0.5), Math.min(1, st.fogB + fl * 0.55));
      // туман на частицах — та же кривая и те же числа, что у предметов (atmosphere-light.js) и земли
      // (world.js): 1 − exp(−плотность · расстояние), на дальности видимости съедает 98 %, в ясную погоду — ноль
      uFogK.value = Math.max(0, FOG_K / Math.max(15, st.visibilityM) - FOG_K / FOG_CLEAR_M);

      const eye = renderer.xr.isPresenting ? renderer.xr.getCamera().cameras[0] : null;
      const invHalf = 2 / (eye ? eye.viewport.w : renderer.domElement.height || 800);
      const slow = Math.min(1, Math.max(0.15, shared.timeScale ?? 1)); // в замедлении штрихи короче: видны капли
      const windMs = st.wind * WIND_MS * (1 + 0.7 * st.gust);
      const wx = st.windX * windMs;
      const wz = st.windZ * windMs;

      // ---- дождь (и капли дождя со снегом)
      const rainEff = Math.max(st.rain, st.sleet * 0.55);
      let rainFall = 9;
      if (rainEff > 0.003) {
        const k = clamp01(rainEff);
        rainFall = lerp(3.2, 12, k ** 0.7);
        const vx = wx * 0.9;
        const vz = wz * 0.9;
        const speed = Math.hypot(vx, rainFall, vz);
        move(rain, vx, -rainFall, vz, dt, 3.5, 2.5);
        rain.u.uDir.value.set(vx / speed, -rainFall / speed, vz / speed);
        rain.u.uSize.value.set(lerp(0.002, 0.003, k), Math.min(0.36, speed * 0.02 * (0.35 + 0.65 * k) * slow) + 0.004, 0, 0.85);
        rain.u.uLook.value.set(lerp(0.46, 0.5, k) * smooth(0, 0.06, rainEff) * clamp01(0.3 + 0.8 * lum), 0.5, 1.3, invHalf);
        rain.u.uShape.value.set(0, 0);
        rain.u.uColor.value.setRGB(
          // чуть темнее и синее дымки: на светлом небе штрих темнее фона, на тёмной земле — светлее
          Math.min(1, (lightC[0] + st.fogR) * 0.5 * 0.8),
          Math.min(1, (lightC[1] + st.fogG) * 0.5 * 0.86),
          Math.min(1, (lightC[2] + st.fogB) * 0.5 * 0.98),
        );
        show(rain, Math.ceil(RAIN_CAP * (0.12 + 0.88 * k ** 1.4)));
      } else hide(rain);

      // ---- снег (и мокрые хлопья дождя со снегом)
      const snowEff = Math.max(st.snow, st.sleet * 0.5);
      let snowFall = 1.2;
      if (snowEff > 0.003) {
        const k = clamp01(snowEff);
        const wet = clamp01((st.sleet * 0.5) / Math.max(snowEff, 1e-3)) * clamp01(1.4 - st.snow / Math.max(snowEff, 1e-3) * 0.4);
        snowFall = lerp(1.0 + 0.5 * k, 4.2, wet);
        const speed = Math.hypot(wx, snowFall, wz);
        move(snow, wx, -snowFall, wz, dt, 2.5, 1.5);
        snow.u.uDir.value.set(wx / speed, -snowFall / speed, wz / speed);
        const flake = lerp(lerp(0.011, 0.007, k), 0.006, wet); // полуразмер хлопья, м
        // смаз по скорости, но не длиннее нескольких размеров: в метель — чёрточки, мокрый снег — почти круглый
        snow.u.uSize.value.set(flake, Math.min(speed * 0.0035 * slow, flake * lerp(4, 1.5, wet)), lerp(0.12, 0.05, k) * (1 - 0.6 * wet), 0.8);
        snow.u.uLook.value.set(lerp(0.92, 0.7, wet) * smooth(0, 0.06, snowEff) * clamp01(0.35 + 0.8 * lum), 0.4, 1.0, invHalf);
        snow.u.uShape.value.set(1, 0.25 + 0.3 * wet);
        tint(snow, 1.2, 1.2, 1.2);
        show(snow, Math.ceil(SNOW_CAP * (0.08 + 0.92 * k ** 1.3)));
      } else hide(snow);

      // ---- песок пыльной бури
      if (st.dust > 0.003) {
        const k = clamp01(st.dust);
        const speed = Math.hypot(wx, 0.4, wz);
        move(grit, wx, -0.4, wz, dt, 3, 0.5);
        grit.u.uDir.value.set(wx / speed, -0.4 / speed, wz / speed);
        grit.u.uSize.value.set(0.0025, Math.min(0.03, speed * 0.003 * slow) + 0.003, 0.05, 0.7);
        grit.u.uLook.value.set(0.55 * smooth(0, 0.1, st.dust) * clamp01(0.3 + 0.8 * lum), 0.4, 1.0, invHalf);
        grit.u.uShape.value.set(0.7, 0.3);
        tint(grit, 0.86, 0.66, 0.4);
        show(grit, Math.ceil(GRIT_CAP * k));
      } else hide(grit);

      // ---- град
      if (st.hail > 0.003) {
        const k = clamp01(st.hail);
        hail.u.uCenter.value.set(head.x + look.x * 3.5, head.y, head.z + look.z * 3.5);
        hail.u.uHail.value.set(live.time, 15, 0.9, lerp(0.009, 0.013, k));
        hail.u.uWindV.value.set(wx * 0.35, wz * 0.35);
        hail.u.uLook.value.set(0.95 * smooth(0, 0.06, st.hail) * clamp01(0.4 + 0.8 * lum), 0.9, invHalf, 0.002 * slow);
        tint(hail, 1.0, 1.02, 1.06);
        show(hail, Math.ceil(HAIL_CAP * k ** 0.8));
      } else hide(hail);

      // ---- брызги от земли при сильном дожде (трава высокая: всплески разбросаны по её высоте)
      const splashK = Math.max(smooth(0.25, 1, st.rain), 0.35 * smooth(0.3, 1, st.sleet));
      if (splashK > 0.003) {
        splash.u.uCenter.value.set(head.x + look.x * 3.5, head.y, head.z + look.z * 3.5);
        splash.u.uSplash.value.set(live.time, 0.035, 0.06, 0.45);
        splash.u.uLook.value.set(0.5 * clamp01(0.3 + 0.8 * lum), 0);
        tint(splash, 0.95, 1.0, 1.08);
        show(splash, Math.ceil(SPLASH_CAP * splashK));
      } else hide(splash);

      // ---- «стена» дождя и снега вдали: только при сильных осадках (в обычный дождь она почти не видна,
      // а закрашивает широкую полосу кадра)
      const wallRain = 0.3 * smooth(0.45, 1, rainEff) * clamp01(0.3 + 0.8 * lum);
      const wallSnow = 0.45 * smooth(0.35, 1, snowEff) * clamp01(0.35 + 0.8 * lum);
      if (wallRain + wallSnow > 0.012) {
        const wr = wallRain / (wallRain + wallSnow);
        // наклон не круче WALL_SLOPE (иначе текстура рвётся): при сильном ветре рисунок бежит быстрее,
        // так что вбок он летит со скоростью ветра
        const fall = Math.max(lerp(snowFall, rainFall, wr), Math.hypot(wx, wz) / WALL_SLOPE);
        live.fall = wrapTo(live.fall + fall * dt, WALL_TILE * 4);
        wallU.uHead.value.copy(head);
        wallU.uFlow.value.set(wx / fall, live.fall, wz / fall);
        wallU.uMix.value.set(wallRain, wallSnow);
        haze(
          wallU.uColor.value,
          lerp(lightC[0] * 1.05, (lightC[0] + st.fogR) * 0.5, wr),
          lerp(lightC[1] * 1.05, (lightC[1] + st.fogG) * 0.5, wr),
          lerp(lightC[2] * 1.08, (lightC[2] + st.fogB) * 0.52, wr),
          lerp(1.4, 1.6, wr),
        );
        wall.visible = true;
      } else wall.visible = warm < 3;

      // ---- клубы: пыль, смог, позёмка метели, водяная пыль ливня
      // в шлеме клубов меньше (PUFF_VR): большие полупрозрачные спрайты — самая дорогая часть для заливки
      const dim = clamp01(0.25 + 0.85 * lum);
      const few = renderer.xr.isPresenting ? PUFF_VR : 1;
      puffUpdate(dust, clamp01(st.dust * 1.1) * few, 0.4 * smooth(0, 0.25, st.dust) * dim, wx * 0.85, wz * 0.85, dt, 8, 0.2, 7, 1.8, 4, 3.5, 9, 0.95, 0.66, 0.36, 1.3);
      puffUpdate(smog, clamp01(st.smoke * 1.1) * few, 0.34 * smooth(0, 0.25, st.smoke) * dim, wx * 0.3 + st.windX * 0.25, wz * 0.3 + st.windZ * 0.25, dt, 8, 0.4, 9, 2.4, 5, 4, 10, 0.48, 0.38, 0.28, 0.9);
      const veilK = smooth(0.4, 1, st.snow) * smooth(0.2, 0.8, st.wind);
      puffUpdate(veil, veilK * few, 0.2 * veilK * dim, wx, wz, dt, 7, 0, 2, 1.2, 2.6, 3, 8, 1.05, 1.05, 1.08, 1.3);
      const mistK = smooth(0.55, 1, st.rain);
      puffUpdate(mist, mistK * few, 0.11 * mistK * dim, wx * 0.6 + st.windX * 0.3, wz * 0.6 + st.windZ * 0.3, dt, 7, 0, 0.9, 1.5, 3, 3, 8, 0.85, 0.9, 0.97, 1.3);

      // ---- листья, лепестки
      if (st.leaves > 0.003) {
        // по ветру, с лёгким снижением (LEAF_FALL); покачивание медленное (круг фазы — LEAF_SWAY_S секунд) и
        // небольшое; порыв ветра плавно приподнимает все листья разом (LEAF_LIFT), а не трясёт их
        move(leaves, wx * 0.9, -LEAF_FALL, wz * 0.9, dt, 5, 0);
        live.sway = wrapTo(live.sway + (dt * 2 * Math.PI) / LEAF_SWAY_S, 2 * Math.PI);
        live.lift += (LEAF_LIFT * clamp01(st.gust) - live.lift) * Math.min(1, dt * 1.2);
        leaves.u.uSway.value.set(live.sway, live.lift);
        leaves.u.uLeaf.value.set(0.055, 0.12 + 0.06 * clamp01(st.wind), clamp01(st.leaves) * 1.05, st.spring * 0.7);
        seasonMix(leaves.u.uColA.value, SEASON_A);
        seasonMix(leaves.u.uColB.value, SEASON_B);
        leaves.u.uColC.value.copy(PETAL);
        leaves.u.uLight.value.set(Math.min(1.1, lightC[0] * 1.1), Math.min(1.1, lightC[1] * 1.1), Math.min(1.1, lightC[2] * 1.1));
        show(leaves, LEAF_CAP);
      } else hide(leaves);

      if (warm < 3) warm += 1;
      drawn = 0;
      for (const mesh of meshes) if (mesh.visible) drawn += 1;
      cpuMs += (performance.now() - t0 - cpuMs) * 0.05;
    },

    // для отчётов и vr:eval: сколько чего рисуется сейчас
    stats() {
      const active = {};
      for (const k of kinds) if (k.n > 0) active[k.name] = k.n;
      return {
        draws: drawn,
        active,
        wall: wall.visible,
        bolt: assets.bolt.instanceCount > 0,
        strikes,
        cpuMs: +cpuMs.toFixed(3),
        caps: { rain: RAIN_CAP, snow: SNOW_CAP, grit: GRIT_CAP, hail: HAIL_CAP, splash: SPLASH_CAP, leaves: LEAF_CAP, puffs: PUFF_CAP },
        source: shared.atmosphere?.now ? (debug.values ? 'atmosphere + debug' : 'atmosphere') : debug.values ? 'debug' : 'нет состояния',
      };
    },

    dispose() {
      stopListening?.();
      stopListening = null;
      // сетки остаются в root: оболочка держит их на экране, пока готовится новая сцена (дождь не мигает),
      // и сама освобождает материалы; геометрия и текстуры — в shared.weatherFxCache
      if (shared.weatherFxDebug === debug) {
        debug.strike = () => null;
        debug.stats = () => null;
      }
    },
  };
  return api;
}
