// Свет атмосферы на предметах сцены (псы, оружие, дроны — MeshStandardMaterial): каждый кадр ведёт по
// shared.atmosphere.now два светильника оболочки (HemisphereLight и DirectionalLight из web/src/main.js),
// туман сцены, экспозицию, силу теней псов и яркость отражений (карта окружения оружия).
//
// - Светильники оболочки не создаются заново, а находятся в scene; dispose возвращает их как были.
//   В состоянии по умолчанию (закат, розовое небо, лето, переменная облачность) цвет, сила и направление —
//   ровно прежние (белый 2,2; белый 1,5 из точки (1,5; 3; 1)). Направление идёт за светилом по азимуту
//   (утром слева, вечером справа, ночью со стороны луны), а по высоте не опускается ниже прежней (~59°):
//   предметы всегда освещены «сверху-сбоку», как раньше. Тени на земле — отдельно (keyDir, 22°).
// - scene.fog (FogExp2) включается ОДИН раз и остаётся в сцене и после dispose (включить/выключить —
//   перекомпиляция всех программ с туманом); дальше меняются только плотность и цвет. Туман — настоящая
//   экспонента 1 − exp(−плотность · расстояние), плотность 3,9 / visibilityM − 3,9 / 16000 (на расстоянии
//   видимости съедает 98 %, при погоде по умолчанию — ноль) — ТА ЖЕ кривая, что у тумана погоды на земле
//   и траве (sky-palettes.js, look.fogP.y): пёс и трава под ним тонут
//   одинаково. У three.js FogExp2 экспонента в квадрате (вблизи почти нет тумана, потом стена), поэтому
//   строка формулы в общем куске шейдера fog_fragment заменяется (один раз на страницу, до сборки
//   материалов сцены). Небо, земля, трава и эффекты на ShaderMaterial тумана сцены не видят (fog: false
//   по умолчанию): дымку земли рисует world.js, эффектам она дописывается ниже (FOG_BY_NAME).
//   Цвет тумана three.js подмешивает ПОСЛЕ тональной компрессии, так что now.fogColor виден как есть.
// - Экспозицию (renderer.toneMappingExposure) ведёт этот файл: база world.js (0,55) × вспышка молнии.
// - Карта окружения оружия (weapon-env.js) — закатная и запечена один раз; ночью и под тучами её
//   отражения гасятся через envMapIntensity материалов (uniform, без перекомпиляции). Материалы с этой
//   картой собираются обходом сцены раз в ENV_SCAN_S.
// - shared.objectLight { dir, sun, amb } — тот же свет для эффектов со своим шейдером (дым выстрела,
//   smoke.js): dir — К светилу (как есть, без подъёма), sun и amb — цвет × сила в долях прежнего заката
//   (по умолчанию 1, 1, 1). Объекты одни и те же всю жизнь страницы: шейдеры держат их в uniform-ах.
import { SHADOW_STRENGTH } from './sun-shadows.js';
import { KEY_SWITCH_ELEV, SUNSET_AZ } from './atmosphere.js';

const BASE_EXPOSURE = 0.55; // world.js
// плотность = FOG_K / видимость − FOG_K / VISIBILITY_CLEAR (не меньше 0): на расстоянии видимости туман
// съедает 98 %, а при видимости от 16 км (погода по умолчанию и «Ясно») его нет вовсе — предметы как
// раньше. Числа те же, что у земли в sky-palettes.js (look.fogP.y, VISIBILITY_TODAY) — менять вместе.
const FOG_K = 3.9;
const VISIBILITY_CLEAR = 16000;
// За пределом видимости предмет ИСЧЕЗАЕТ, а не висит бледным силуэтом (просьба пользователя: огромный
// пёс вдали закрывает небо разного цвета и читается, как ни подбирай цвет тумана). Пока доля тумана у
// пикселя идёт от VANISH_FROM до VANISH_TO, непрозрачное выбрасывает пиксели по шуму (discard, сетка по
// gl_FragCoord — как растворение трупов), прозрачное и светящееся гаснет; дальше не рисуется ничего.
// При плотности 0 доля тумана 0 — ничего не выбрасывается. Земля и трава уходят в туман по той же
// экспоненте (world.js), так что предмет исчезает там же, где уже не видно земли под ним.
const VANISH_FROM = 0.85;
const VANISH_TO = 0.97;
// Общий кусок шейдера three.js (r187) для тумана — заменяется целиком, один раз на страницу: ветка FogExp2
// — настоящая экспонента (у three.js она в квадрате) и исчезновение. Комментарии в GLSL — латиницей.
const FOG_MARK = 'atmo-fog-4';
const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
	#ifdef FOG_EXP2
		// ${FOG_MARK} (scene/atmosphere-light.js): true exponential fog; past the visibility range the object is gone
		float fogFactor = 1.0 - exp( - fogDensity * vFogDepth );
		float fogGone = smoothstep( ${VANISH_FROM}, ${VANISH_TO}, fogFactor );
		#ifdef OPAQUE
			if ( fogGone > 0.0 && fogGone >= fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) ) discard;
		#else
			gl_FragColor.a *= 1.0 - fogGone;
		#endif
	#else
		float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
	#endif
	gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif
`;
// Программы встроенных материалов three.js берёт из кэша по ключу, а текст общего куска в ключ не входит:
// без новой метки в ключе старые программы (без исчезновения) жили бы до перезагрузки страницы. Метку
// получают материалы с туманом под ctx.root (adopt() в конце setup — оболочка дособерёт их в фоне подмены).
const FOG_KEY = '|atmo-fog4';
const ENV_SCAN_S = 0.7;
const DEG = Math.PI / 180;

// Туман для того, что scene.fog сам не покрывает: эффекты на ShaderMaterial и светящиеся (сложение)
// материалы. Сетка находится по имени при обходе сцены (первый — до первого кадра новой сцены), в её
// материал один раз дописывается пара строк шейдера; плотность и цвет дальше подставляет сам three.js
// (material.fog = true). Способ — по тому, как материал смешивается с фоном:
//   fade    — светящееся (сложение): в тумане гаснет, а не красится в его цвет;
//   mix     — обычная прозрачность: цвет уходит в цвет тумана;
//   premult — предумноженная альфа: дым уходит в цвет тумана, огонь (альфа 0) гаснет;
//   glow    — как fade, но только если материал со сложением (у fx-particles бывают оба вида).
// Частицы погоды (weather-*.js) сюда не входят: у них своя дальность. Новый эффект со своим шейдером —
// впиши имя его сетки сюда (шейдер должен кончаться на #include <colorspace_fragment>).
const FOG_BY_NAME = {
  'bullet-tracers': 'fade',
  'impact-sparks': 'fade',
  'arena-beams': 'fade',
  'arena-sprites': 'fade',
  'mana-bolts': 'fade',
  'blackhole-parts': 'fade',
  'blackhole-charge-disc': 'fade',
  blackholes: 'premult',
  'artillery-fx': 'premult',
  'gun-smoke': 'mix',
  'drones-fire': 'glow',
  'drones-lights': 'glow',
  'robodog-fx': 'glow',
  'fx-particles': 'glow',
};
const FOG_NAMES = new Map(Object.entries(FOG_BY_NAME));
// atmoFog — доля тумана у пикселя, atmoKeep — что осталось до исчезновения (1 … 0 между VANISH_FROM и VANISH_TO).
// Светящееся (fade) гаснет раньше, между GLOW_FROM и GLOW_TO: яркая дуга или огонёк и при 7 % яркости виден
// лучше корпуса, а висеть в воздухе без него не должен.
const GLOW_FROM = 0.7;
const GLOW_TO = 0.9;
const FOG_GLSL = {
  fade: `gl_FragColor.rgb *= (1.0 - atmoFog) * (1.0 - smoothstep(${GLOW_FROM}, ${GLOW_TO}, atmoFog));`,
  mix: 'gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, atmoFog); gl_FragColor.a *= atmoKeep;',
  premult: 'gl_FragColor = vec4(mix(gl_FragColor.rgb, fogColor * gl_FragColor.a, atmoFog), gl_FragColor.a) * atmoKeep;',
};
// Свет атмосферы для дыма: он не светится сам, а освещён, поэтому в сумерках и ночью должен темнеть.
// ShaderMaterial — множитель в шейдере (выражение GLSL до перевода в цвет экрана; atmoLit — uniform, тот же
// объект shared.objectLight.lit); MeshBasic — цвет материала каждый кадр (без правки шейдера).
const LIT_GLSL = { 'artillery-fx': 'mix(atmoLit, vec3(1.0), vAdd)' }; // vAdd = 1 — огонь (сложение): его не трогает
const LIT_BASIC = new Set(['drones-smoke', 'fx-particles']); // у fx-particles — только не светящиеся (пыль, обломки)
// Свет на дыме = направленный (доля 1 − LIT_AMBIENT; ночью, от луны, — вчетверо слабее) + рассеянный, и
// рассеянный берётся по яркости НЕБА, а не по ambientPower: тот ночью и в грозу нарочно завышен, чтобы
// враги читались, а дым с ним светился бы на тёмном небе. На закате по умолчанию выходит ровно 1.
const LIT_AMBIENT = 0.3;
const LIT_MAX = 1.4;
const SKY_L_DEFAULT = 0.0984; // яркость неба низко над горизонтом в состоянии по умолчанию (readSky при SKY_WARM)
const SKY_WARM = 0.08; // доля стороны солнца в цвете неба: ближе к тёмной стороне — предмет не светлее неба ни с какой стороны
// Небо за дальними предметами: на какой высоте (sin угла) берётся его цвет и до какой высоты дальний
// предмет не должен на нём выделяться (см. readSky и derive в atmosphere.js)
const SKY_E = 0.08; // ≈ 4,5°
const SKY_E_TOP = 0.16; // ≈ 9°
const SKY_SAFE = 0.95; // оценка облачного неба берётся на 5 % темнее замера
const SKY_DOME = 'scene-sky-dome'; // сетка неба world.js; из её uniform-ов читается, что небо рисует на самом деле
const COLORSPACE = '#include <colorspace_fragment>';
// встроенные материалы (MeshBasic, Sprite): вместо подмешивания цвета тумана — гашение
const BUILTIN_FADE = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  gl_FragColor.rgb *= ( 1.0 - fogFactor ) * ( 1.0 - smoothstep( ${GLOW_FROM}, ${GLOW_TO}, fogFactor ) );
#endif
`;

// root — ctx.root сцены: материалам под ним ставится метка ключа программы (см. FOG_KEY)
export function createAtmosphereLight({ THREE, scene, root = null, renderer, shared, atmosphere, sunShadows = null }) {
  const now = atmosphere.now;
  const hemi = scene.children.find((c) => c.isHemisphereLight) ?? null;
  const sun = scene.children.find((c) => c.isDirectionalLight) ?? null;
  // какими светильники были у оболочки — запоминается один раз за жизнь страницы (первая сцена видит их
  // нетронутыми; при подмене сцены прежняя версия могла и не вернуть их, если упала)
  const saved = (shared.shellLights ??= {
    hemi: hemi && { color: hemi.color.clone(), ground: hemi.groundColor.clone(), intensity: hemi.intensity },
    sun: sun && { color: sun.color.clone(), intensity: sun.intensity, position: sun.position.clone() },
  });
  const ground0 = saved.hemi ? saved.hemi.ground.clone() : new THREE.Color(0x334155);
  const snowGround = new THREE.Color(0.62, 0.66, 0.74); // свет, отражённый снегом, — снизу светлее
  const flashTint = new THREE.Color(0.82, 0.88, 1.0);
  const dir = new THREE.Vector3();
  // «обычная сила» и прежнее направление светильников оболочки (web/src/main.js: 2,2 и 1,5 из (1,5; 3; 1))
  const HEMI_INTENSITY = saved.hemi?.intensity ?? 2.2;
  const SUN_INTENSITY = saved.sun?.intensity ?? 1.5;
  const legacy = (saved.sun?.position.clone() ?? new THREE.Vector3(1.5, 3, 1)).normalize();
  const LIGHT_MIN_ELEV = Math.asin(legacy.y); // радианы: ниже прежней высоты свет не опускается
  // прежний свет стоял чуть «позади» закатного солнца по азимуту — этот сдвиг сохраняется на весь день
  const AZIMUTH_SHIFT = Math.atan2(legacy.z, legacy.x) - SUNSET_AZ * DEG;
  const objectLight = (shared.objectLight ??= { dir: new THREE.Vector3(0.99, 0.04, 0.139).normalize(), sun: new THREE.Color(1, 1, 1), amb: new THREE.Color(1, 1, 1) });
  objectLight.lit ??= new THREE.Color(1, 1, 1); // свет на дыме: рассеянный + доля направленного, в долях прежнего заката
  const tune = (shared.atmoTune ??= {}); // подстройка чисел из vr:eval без подмены сцены (пусто — значения из кода)

  // ---- небо за дальними предметами: цвет, который шейдер неба рисует низко над горизонтом БЕЗ тумана
  // (градиент горизонт → полоса и облака в среднем), и доля пелены тумана на высоте SKY_E_TOP. Читается
  // из uniform-ов сетки неба — это ровно те числа, что на экране. Пишется в shared.atmoSkyRef, по ним
  // atmosphere.js подгоняет now.fogColor (а его берут и небо, и земля, и частицы, и туман предметов).
  const skyRef = (shared.atmoSkyRef ??= { r: 0, g: 0, b: 0, free: 1, ok: false });
  let skyDome = null;
  const readSky = () => {
    const u = skyDome && skyDome.parent ? skyDome.material.uniforms : null;
    if (!u || !u.hazeCool || !u.hazeWarm || !u.bandCool || !u.bandWarm || !u.cloudLitFar || !u.cloudShadeFar || !u.cloudP || !u.veilP) {
      skyRef.ok = false;
      return;
    }
    const hc = u.hazeCool.value;
    const hw = u.hazeWarm.value;
    const bc = u.bandCool.value;
    const bw = u.bandWarm.value;
    const lf = u.cloudLitFar.value;
    const sf = u.cloudShadeFar.value;
    // сторона солнца входит малой долей (в шейдере — куб и квадрат стороны)
    const warmH = tune.skyWarm ?? SKY_WARM;
    const warmB = warmH * 1.2;
    const band = 1 - Math.exp(-11 * SKY_E); // градиент горизонт → полоса на этой высоте
    const cover = now.cloudCover;
    const c0 = Math.min(1, Math.max(0, (cover - 0.35) / 0.55));
    const clouds = c0 * c0 * (3 - 2 * c0); // сколько низкого неба закрыто облаками
    // облако — как в шейдере для плоской пелены (сверено с замером world-sky-seasons по снимкам): доля света
    // по высоте «солнца облаков», толща пелены темнит; SKY_SAFE — чуть темнее замера, чтобы туман не вышел
    // светлее неба
    const sunY = u.cloudSun ? u.cloudSun.value.y : 0.35;
    const d0 = Math.min(1, Math.max(0, sunY * 0.6 + 0.42));
    const litK = tune.cloudLit ?? d0 * d0 * (3 - 2 * d0);
    const thick = (1 - (tune.cloudThick ?? 0.415) * u.cloudP.value.w) * SKY_SAFE;
    const far = tune.cloudFar ?? 0.23; // дальние облака уходят в цвет горизонта
    for (let i = 0; i < 3; i += 1) {
      const key = i === 0 ? 'r' : i === 1 ? 'g' : 'b';
      const horizon = hc[key] + (hw[key] - hc[key]) * warmH;
      const sky = horizon + (bc[key] + (bw[key] - bc[key]) * warmB - horizon) * band;
      const cloud = (sf[key] + (lf[key] - sf[key]) * litK) * thick;
      skyRef[key] = sky + (cloud + (horizon - cloud) * far - sky) * clouds;
    }
    skyRef.free = u.veilP.value.x * Math.exp(-SKY_E_TOP * u.veilP.value.y);
    skyRef.ok = true;
  };
  // дым на MeshBasic: цвет материала × свет
  const litMats = new Set();
  const noteLit = (m) => {
    if (!m || Array.isArray(m) || !m.isMeshBasicMaterial || m.blending === THREE.AdditiveBlending || litMats.has(m)) return;
    m.userData.atmoLitBase ??= m.color.clone();
    litMats.add(m);
  };

  // туман сцены: один раз, дальше только плотность и цвет
  if (!THREE.ShaderChunk.fog_fragment.includes(FOG_MARK)) {
    if (!THREE.ShaderChunk.fog_fragment.includes('fogFactor')) console.warn('[atmo] кусок fog_fragment в three.js изменился: проверь замену в atmosphere-light.js');
    THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;
  }
  if (!scene.fog?.isFogExp2) scene.fog = new THREE.FogExp2(0x000000, 0);
  const fog = scene.fog;

  // материалы с картой окружения оружия: { base — их собственная яркость отражений, applied — что записали мы }
  const envMats = new Set();
  let envScanIn = 0;
  let envK = -1;
  const noteMaterial = (m) => {
    if (!m || !m.isMeshStandardMaterial || !m.envMap || m.envMap !== shared.weaponEnv) return;
    if (envMats.has(m)) return;
    const u = m.userData;
    // материал мог остаться от прежней версии сцены с уже приглушённой яркостью
    if (u.atmoEnv && u.atmoEnv.applied === m.envMapIntensity) u.atmoEnv.applied = -1;
    else u.atmoEnv = { base: m.envMapIntensity, applied: -1 };
    envMats.add(m);
  };
  // туман эффекту по имени сетки (FOG_BY_NAME): дописать в шейдер его материала, один раз
  const adoptFog = (object, kind) => {
    const m = object.material;
    if (!m || Array.isArray(m) || m.userData.atmoFog) return;
    const mode = kind === 'glow' ? (m.blending === THREE.AdditiveBlending ? 'fade' : null) : kind;
    m.userData.atmoFog = mode ?? 'none';
    if (!mode) return;
    const prevCompile = m.onBeforeCompile;
    const prevKey = m.customProgramCacheKey();
    const litExpr = m.isShaderMaterial ? LIT_GLSL[object.name] ?? null : null;
    if (m.isShaderMaterial) {
      if (!m.fragmentShader.includes(COLORSPACE) || !m.fragmentShader.includes('void main')) {
        console.warn(`[atmo] туман не добавлен: у шейдера «${object.name}» нет ${COLORSPACE}`);
        return;
      }
      // расстояние до пикселя — из gl_FragCoord.w (вершинный шейдер не трогаем); значения uniform-ов ставит three.js
      m.uniforms.fogColor ??= { value: new THREE.Color() };
      m.uniforms.fogDensity ??= { value: 0 };
      // свет атмосферы на дыме: множитель до перевода в цвет экрана (линейный цвет)
      if (litExpr) m.uniforms.atmoLit = { value: objectLight.lit };
      m.onBeforeCompile = (shader, r) => {
        prevCompile.call(m, shader, r);
        const src = shader.fragmentShader;
        const mainAt = src.indexOf('void main');
        const at = src.lastIndexOf(COLORSPACE);
        if (mainAt < 0 || at < mainAt) return;
        const end = at + COLORSPACE.length;
        const decl = `uniform vec3 fogColor;\nuniform float fogDensity;\n${litExpr ? 'uniform vec3 atmoLit;\n' : ''}`;
        const light = litExpr ? `gl_FragColor.rgb *= ${litExpr};\n` : '';
        shader.fragmentShader = `${src.slice(0, mainAt)}${decl}${src.slice(mainAt, at)}${light}${COLORSPACE}\n{ float atmoDepth = 1.0 / gl_FragCoord.w; float atmoFog = 1.0 - exp(-fogDensity * atmoDepth); float atmoKeep = 1.0 - smoothstep(${VANISH_FROM}, ${VANISH_TO}, atmoFog); ${FOG_GLSL[mode]} }\n${src.slice(end)}`;
      };
    } else {
      m.onBeforeCompile = (shader, r) => {
        prevCompile.call(m, shader, r);
        shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', BUILTIN_FADE);
      };
    }
    m.customProgramCacheKey = () => `${prevKey}${FOG_KEY}-${mode}${mode === 'fade' ? '2' : ''}${litExpr ? '-lit' : ''}`; // fade2: гаснет раньше (GLOW_*)
    m.fog = true;
    m.needsUpdate = true;
  };
  const scanEnv = (object) => {
    const kind = object.name ? FOG_NAMES.get(object.name) : undefined;
    if (kind) adoptFog(object, kind);
    if (object.name === SKY_DOME) skyDome = object;
    else if (LIT_BASIC.has(object.name)) noteLit(object.material);
    const m = object.material;
    if (!m) return;
    if (Array.isArray(m)) for (let i = 0; i < m.length; i += 1) noteMaterial(m[i]);
    else noteMaterial(m);
  };
  const applyEnv = (k) => {
    for (const m of envMats) {
      const e = m.userData.atmoEnv;
      if (e.applied >= 0 && m.envMapIntensity !== e.applied) e.base = m.envMapIntensity; // кто-то задал свою — она новая база
      e.applied = e.base * k;
      m.envMapIntensity = e.applied;
    }
  };
  // метка ключа программы встроенному материалу с туманом (см. FOG_KEY): его программа соберётся заново, с
  // нынешним общим куском тумана. Прежний ключ зовётся каждый раз (у кого-то он меняется на ходу); если
  // хозяин материала потом поставил свой ключ заново — метка ставится снова.
  const keyFog = (m) => {
    if (!m || m.fog !== true || m.isShaderMaterial) return;
    if (m.userData.atmoFog && m.userData.atmoFog !== 'none') return; // дописанные по имени — со своим ключом
    if (m.userData.atmoFogKey && m.customProgramCacheKey === m.userData.atmoFogKey) return;
    const prev = m.customProgramCacheKey;
    const keyed = function () {
      return `${prev.call(this)}${FOG_KEY}`;
    };
    m.customProgramCacheKey = keyed;
    m.userData.atmoFogKey = keyed;
    m.needsUpdate = true;
  };
  const scanKeys = (object) => {
    const m = object.material;
    if (!m) return;
    if (Array.isArray(m)) for (let i = 0; i < m.length; i += 1) keyFog(m[i]);
    else keyFog(m);
  };
  const scan = () => {
    const before = envMats.size;
    scene.traverse(scanEnv);
    if (root) root.traverse(scanKeys);
    if (envMats.size !== before) envK = -1; // новые материалы — применить заново
  };

  return {
    // В КОНЦЕ setup, когда всё создано: туман и свет эффектам, метки ключей материалам — до того, как
    // оболочка в фоне подмены соберёт новые программы (иначе они собирались бы рывком в первом кадре)
    adopt() {
      scan();
      envScanIn = ENV_SCAN_S;
    },
    // после atmosphere.update этого кадра
    update(realDt) {
      // обход сцены раз в ENV_SCAN_S: материалы с картой окружения, эффекты для тумана и света, сетка
      // неба, метки ключей — для того, что появилось позже
      envScanIn -= realDt;
      if (envScanIn <= 0) {
        envScanIn = ENV_SCAN_S;
        scan();
      }
      const flash = now.flash;
      if (hemi) {
        hemi.color.copy(now.ambientColor).lerp(flashTint, Math.min(1, flash * 0.8));
        hemi.groundColor.copy(ground0).lerp(snowGround, now.snowCover * 0.8).multiply(now.ambientColor);
        hemi.intensity = HEMI_INTENSITY * (now.ambientPower + flash * 1.6);
      }
      if (sun) {
        sun.color.copy(now.sunColor);
        sun.intensity = SUN_INTENSITY * now.sunPower;
        // направление: азимут главного света (солнце / луна) + прежний сдвиг, высота не ниже прежней
        const key = now.keyDir;
        const azimuth = Math.atan2(key.z, key.x) + AZIMUTH_SHIFT;
        const elev = Math.max(Math.asin(Math.max(-1, Math.min(1, key.y))), LIGHT_MIN_ELEV);
        const c = Math.cos(elev);
        dir.set(Math.cos(azimuth) * c, Math.sin(elev), Math.sin(azimuth) * c);
        sun.position.copy(dir).multiplyScalar(saved.sun.position.length());
      }
      // свет для эффектов со своим шейдером (дым): то же светило, цвет × сила
      objectLight.dir.copy(now.sunElev < KEY_SWITCH_ELEV ? now.moonDir : now.sunDir);
      objectLight.sun.copy(now.sunColor).multiplyScalar(now.sunPower);
      objectLight.amb.copy(now.ambientColor).multiplyScalar(now.ambientPower + flash * 1.2);
      // небо за дальними предметами → shared.atmoSkyRef (по нему atmosphere.js подгонит now.fogColor следующего кадра)
      readSky();
      // свет на дыме (см. LIT_AMBIENT); дым на MeshBasic получает его цветом материала
      const litAmb = tune.litAmbient ?? LIT_AMBIENT;
      const skyL = skyRef.ok ? 0.2126 * skyRef.r + 0.7152 * skyRef.g + 0.0722 * skyRef.b : SKY_L_DEFAULT * now.ambientPower;
      const ambK = litAmb * Math.min(3, skyL / SKY_L_DEFAULT) + flash;
      const sunK = (1 - litAmb) * now.sunPower * Math.min(1, (0.25 + 0.75 * now.day) / 0.97);
      const lit = objectLight.lit;
      lit.setRGB(
        Math.min(LIT_MAX, now.sunColor.r * sunK + now.ambientColor.r * ambK),
        Math.min(LIT_MAX, now.sunColor.g * sunK + now.ambientColor.g * ambK),
        Math.min(LIT_MAX, now.sunColor.b * sunK + now.ambientColor.b * ambK),
      );
      for (const m of litMats) m.color.copy(m.userData.atmoLitBase).multiply(lit);
      // туман: плотность по видимости; цвет — now.fogColor, вспышка молнии подсвечивает его так же, как
      // пелену неба (sky-palettes.js: veilColor += (0.26, 0.29, 0.38) · flash)
      fog.density = Math.max(0, FOG_K / Math.max(15, now.visibilityM) - FOG_K / VISIBILITY_CLEAR);
      fog.color.copy(now.fogColor);
      if (flash > 0) {
        fog.color.r += 0.26 * flash;
        fog.color.g += 0.29 * flash;
        fog.color.b += 0.38 * flash;
      }
      renderer.toneMappingExposure = BASE_EXPOSURE * (1 + 0.35 * flash);
      // тени псов и коптеров: слабее без прямого солнца и ночью (лунные), пропадают, пока свет меняется
      if (sunShadows) sunShadows.uniforms.dogShadowStrength.value = SHADOW_STRENGTH * now.keyShadow;
      // отражения карты окружения: по яркости рассеянного света (по умолчанию ×1)
      const amb = now.ambientColor;
      const k = Math.min(1.6, now.ambientPower * (0.2126 * amb.r + 0.7152 * amb.g + 0.0722 * amb.b) + flash * 0.8);
      if (Math.abs(k - envK) > 0.004) {
        envK = k;
        applyEnv(k);
      }
    },
    dispose() {
      if (hemi && saved.hemi) {
        hemi.color.copy(saved.hemi.color);
        hemi.groundColor.copy(saved.hemi.ground);
        hemi.intensity = saved.hemi.intensity;
      }
      if (sun && saved.sun) {
        sun.color.copy(saved.sun.color);
        sun.intensity = saved.sun.intensity;
        sun.position.copy(saved.sun.position);
      }
      for (const m of envMats) {
        const e = m.userData.atmoEnv;
        if (e && m.envMapIntensity === e.applied) m.envMapIntensity = e.base;
        delete m.userData.atmoEnv;
      }
      envMats.clear();
      for (const m of litMats) m.color.copy(m.userData.atmoLitBase);
      litMats.clear();
      // skyRef не сбрасывается: новая версия сцены первый кадр живёт по прежнему цвету неба (без вспышки светлого тумана)
      objectLight.dir.set(0.99, 0.04, 0.139).normalize();
      objectLight.sun.setRGB(1, 1, 1);
      objectLight.amb.setRGB(1, 1, 1);
      objectLight.lit.setRGB(1, 1, 1);
      if (sunShadows) sunShadows.uniforms.dogShadowStrength.value = SHADOW_STRENGTH;
      // scene.fog остаётся (следующая версия сцены его переиспользует); экспозицию возвращает world.dispose
    },
  };
}
