// Текстура стальной мишени: красно-белые кольца краской по стали, краска потёрта, со сколами до
// серого металла, ржавыми подтёками вниз от сколов и грязью у нижнего края. Кольца рисуются на
// холсте (края чуть неровные), а пятна, царапины и сколы берутся из фотоскана крашеной стали «Blue
// Metal Plate» с Poly Haven (автор Rob Tuytel, лицензия CC0, https://polyhaven.com/a/blue_metal_plate),
// 1K: web/public/textures/metal/. Из него же — карта нормалей (царапины, вмятинки).
//
// Делается один раз на страницу и живёт в globalThis.__sceneState (переживает подмену сцены).
// Возвращает { map, roughnessMap, metalnessMap, normalMap }: у roughness/metalness одна текстура
// (G — шероховатость, B — металл), как принято в three.js.
//
// Раскладка UV (её задаёт targets.js): лицевая и задняя грань — круг, вписанный в текстуру (верх
// холста — верх мишени); боковой обод — угол текстуры, там голая серая сталь.

const SIZE = 512;
const URL_BASE = `${import.meta.env.BASE_URL}textures/metal/blue_metal_plate_`;
// Квадрат фотоскана без швов между листами (пиксели исходника 1024×1024).
const CROP = { x: 320, y: 100, size: 460 };
const RING_COLORS = ['#a8231c', '#e6e1d6', '#a8231c', '#e6e1d6', '#a8231c']; // снаружи внутрь
export const SIDE_UV = 0.03; // точка текстуры для бокового обода

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = src;
  });

// Поменял рисунок — подними версию: текстура пересоздастся при подмене сцены (без перезагрузки).
const VERSION = 4;

export function plateTextures(THREE, shared) {
  const cached = shared.plateTextures;
  if (cached?.version === VERSION) return cached.textures;
  if (cached) for (const texture of new Set(Object.values(cached.textures ?? cached))) texture.dispose?.();

  const colorCanvas = document.createElement('canvas');
  colorCanvas.width = colorCanvas.height = SIZE;
  const rmCanvas = document.createElement('canvas');
  rmCanvas.width = rmCanvas.height = SIZE;
  const color = colorCanvas.getContext('2d', { willReadFrequently: true });
  const rm = rmCanvas.getContext('2d');

  // ---- краска: кольца с чуть неровными краями (пока фото не загрузилось — только они)
  const paintRings = () => {
    color.fillStyle = '#5b5a57'; // сталь вне круга (обод)
    color.fillRect(0, 0, SIZE, SIZE);
    const c = SIZE / 2;
    color.filter = 'blur(0.7px)';
    RING_COLORS.forEach((fill, index) => {
      const radius = (c - 1) * (1 - index / RING_COLORS.length);
      color.beginPath();
      const seed = index * 17.3;
      for (let k = 0; k <= 180; k += 1) {
        const a = (k / 180) * Math.PI * 2;
        const wobble = Math.sin(a * 7 + seed) * 0.6 + Math.sin(a * 23 + seed * 2) * 0.4 + Math.sin(a * 61 + seed) * 0.3;
        const r = radius + (index ? wobble : -Math.abs(wobble) * 0.5);
        if (k) color.lineTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
        else color.moveTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
      }
      color.fillStyle = fill;
      color.fill();
    });
    color.filter = 'none';
  };
  paintRings();
  rm.fillStyle = 'rgb(0, 190, 0)'; // краска: шероховатая, не металл
  rm.fillRect(0, 0, SIZE, SIZE);

  const map = new THREE.CanvasTexture(colorCanvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = 8;
  const rmTexture = new THREE.CanvasTexture(rmCanvas);
  rmTexture.anisotropy = 8;
  const normalMap = new THREE.TextureLoader().load(`${URL_BASE}nor_gl_1k.jpg`);
  normalMap.offset.set(CROP.x / 1024, 1 - (CROP.y + CROP.size) / 1024);
  normalMap.repeat.set(CROP.size / 1024, CROP.size / 1024);
  normalMap.anisotropy = 8;

  // ---- потёртости из фотоскана
  Promise.all([loadImage(`${URL_BASE}diff_1k.jpg`), loadImage(`${URL_BASE}rough_1k.jpg`)])
    .then(([diffImage, roughImage]) => {
      const sample = (image, blur = 0) => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = SIZE;
        const g = canvas.getContext('2d', { willReadFrequently: true });
        if (blur) g.filter = `blur(${blur}px)`;
        g.drawImage(image, CROP.x, CROP.y, CROP.size, CROP.size, 0, 0, SIZE, SIZE);
        return g.getImageData(0, 0, SIZE, SIZE).data;
      };
      const photo = sample(diffImage);
      const photoLow = sample(diffImage, 10); // крупные пятна
      const rough = sample(roughImage);
      const paint = color.getImageData(0, 0, SIZE, SIZE);
      const rmData = rm.getImageData(0, 0, SIZE, SIZE);
      const px = paint.data;
      const out = rmData.data;

      const count = SIZE * SIZE;
      // Фото малоконтрастное (яркость 0.16…0.26): работаем с отклонением от среднего в сигмах.
      const normalize = (data) => {
        const values = new Float32Array(count);
        let mean = 0;
        for (let i = 0; i < count; i += 1) {
          const j = i * 4;
          values[i] = data[j] * 0.3 + data[j + 1] * 0.55 + data[j + 2] * 0.15;
          mean += values[i];
        }
        mean /= count;
        let variance = 0;
        for (let i = 0; i < count; i += 1) variance += (values[i] - mean) ** 2;
        const sigma = Math.sqrt(variance / count) || 1;
        for (let i = 0; i < count; i += 1) values[i] = (values[i] - mean) / sigma;
        return values;
      };
      const lum = normalize(photo);
      const lumLow = normalize(photoLow);
      const smooth = (a, b, x) => {
        const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
        return t * t * (3 - 2 * t);
      };
      const chips = [];
      const c = SIZE / 2;
      let seed = 7;
      const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      // сколы краски по всей мишени: россыпь неровных пятнышек, у края гуще
      const maskCanvas = document.createElement('canvas');
      maskCanvas.width = maskCanvas.height = SIZE;
      const mg = maskCanvas.getContext('2d', { willReadFrequently: true });
      mg.fillStyle = '#fff';
      for (let n = 0; n < 110; n += 1) {
        const r = c * Math.sqrt(0.15 + random() * 0.85) * (random() < 0.4 ? 0.97 : 1);
        const a = random() * Math.PI * 2;
        const x = c + Math.cos(a) * r * 0.95;
        const y = c + Math.sin(a) * r * 0.95;
        const size = 1 + random() ** 2 * 6;
        for (let k = 0; k < 4; k += 1) {
          mg.beginPath();
          mg.ellipse(x + (random() - 0.5) * size * 1.6, y + (random() - 0.5) * size * 1.6, size * (0.4 + random() * 0.6), size * (0.3 + random() * 0.5), random() * Math.PI, 0, Math.PI * 2);
          mg.fill();
        }
      }
      const mask = mg.getImageData(0, 0, SIZE, SIZE).data;
      // сколы по краю мишени: сюда чаще всего прилетает
      const rimChip = (x, y) => {
        const d = c - 2 - Math.hypot(x - c, y - c);
        if (d < 0 || d > 14) return 0;
        const a = Math.atan2(y - c, x - c);
        const depth = 3 + 9 * Math.max(0, Math.sin(a * 5 + 1) * Math.sin(a * 13 + 4) + Math.sin(a * 31) * 0.3);
        return d < depth ? 1 : 0;
      };
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const i = y * SIZE + x;
          const j = i * 4;
          const L = lum[i];
          // светлые царапины фото — сколы краски до металла; остальное — пятна и грязь на краске
          const chip = Math.max(smooth(1.9, 2.8, L), rimChip(x, y), mask[j] / 255);
          const dirt = 1 + L * 0.07 + lumLow[i] * 0.13; // мелкие и крупные пятна
          const low = smooth(c * 0.2, c * 1.05, y - c) * 0.25; // грязь и пыль снизу
          const shade = Math.max(0.5, dirt) * (1 - low);
          const metal = 120 + L * 10; // серая сталь в сколах
          for (let k = 0; k < 3; k += 1) {
            const painted = px[j + k] * shade;
            const tint = k === 0 ? 1.02 : k === 1 ? 1 : 0.96;
            px[j + k] = Math.max(0, Math.min(255, painted * (1 - chip) + metal * tint * chip));
          }
          const paintRough = 140 + (rough[j] - 128) * 0.6; // ~0.55, с разбросом из фото
          out[j] = 0;
          out[j + 1] = Math.max(60, Math.min(250, paintRough * (1 - chip) + 105 * chip));
          out[j + 2] = Math.round(chip * 150); // сталь не зеркальная: окружения в сцене нет, чистый металл чернеет
          if (chip > 0.6 && Math.hypot(x - c, y - c) < c - 4 && (x * 7 + y * 13) % 23 === 0) chips.push([x, y]);
        }
      }
      color.putImageData(paint, 0, 0);
      rm.putImageData(rmData, 0, 0);

      // ржавые подтёки вниз от части сколов
      color.globalCompositeOperation = 'multiply';
      chips
        .filter(() => random() < 0.25)
        .slice(0, 35)
        .forEach(([x, y]) => {
          const length = 12 + random() * 55;
          const width = 1.5 + random() * 3;
          const streak = color.createLinearGradient(0, y, 0, y + length);
          streak.addColorStop(0, 'rgba(175, 105, 60, 0.55)');
          streak.addColorStop(1, 'rgba(175, 105, 60, 0)');
          color.fillStyle = streak;
          color.fillRect(x - width / 2, y, width, length);
        });
      color.globalCompositeOperation = 'source-over';
      map.needsUpdate = true;
      rmTexture.needsUpdate = true;
    })
    .catch((error) => console.warn('[targets] текстура мишени не загрузилась', error));

  const textures = { map, roughnessMap: rmTexture, metalnessMap: rmTexture, normalMap };
  shared.plateTextures = { version: VERSION, textures };
  return textures;
}
