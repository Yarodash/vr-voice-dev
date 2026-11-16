// Лазерный прицел: тонкий красный луч от дула вдоль ствола и яркая точка там, где луч упирается.
// Два объекта, без аллокаций в кадре. update(muzzle, dir, hit|null): hit — точка попадания (или null:
// тогда луч бьёт в землю y=0, если смотрит вниз, иначе идёт на MAX_LENGTH).
const MAX_LENGTH = 60;
const BEAM_RADIUS = 0.00075; // толщина ~1,5 мм
const DOT_SIZE = 0.012; // видимый размер точки (доля высоты экрана, не зависит от расстояния)

export function createLaser({ THREE, root }) {
  // луч: цилиндр вдоль +Z от 0 до 1 (масштабом по Z — длина), яркость падает к концу (аддитивно: тёмный = прозрачный)
  const geometry = new THREE.CylinderGeometry(BEAM_RADIUS, BEAM_RADIUS, 1, 6, 1, true);
  geometry.rotateX(Math.PI / 2);
  geometry.translate(0, 0, 0.5);
  const position = geometry.attributes.position;
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) {
    const fade = 1 - position.getZ(i) * 0.85;
    colors[i * 3] = colors[i * 3 + 1] = colors[i * 3 + 2] = fade; // цвет задаёт material.color
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const beamMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const beam = new THREE.Mesh(geometry, beamMaterial);
  beam.frustumCulled = false;
  beam.renderOrder = 5;
  beam.visible = false;

  // точка: радиальный градиент, спрайт постоянного экранного размера
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const g = canvas.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.3, 'rgba(255,255,255,0.85)');
  grad.addColorStop(1, 'rgba(255,255,255,0)'); // цвет — material.color
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const dotMaterial = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: false,
  });
  const dot = new THREE.Sprite(dotMaterial);
  dot.scale.set(DOT_SIZE, DOT_SIZE, 1);
  dot.frustumCulled = false;
  dot.renderOrder = 6;
  dot.visible = false;

  root.add(beam, dot);
  let on = false;

  return {
    update(muzzle, dir, hit) {
      if (!on || !muzzle) {
        beam.visible = dot.visible = false;
        return;
      }
      let length = MAX_LENGTH;
      let landed = false;
      if (hit) {
        length = Math.min(MAX_LENGTH, muzzle.distanceTo(hit));
        landed = length < MAX_LENGTH;
      } else if (dir.y < -1e-3) {
        const toGround = -muzzle.y / dir.y;
        if (toGround > 0 && toGround < MAX_LENGTH) {
          length = toGround;
          landed = true;
        }
      }
      beam.position.copy(muzzle);
      beam.lookAt(muzzle.x + dir.x, muzzle.y + dir.y, muzzle.z + dir.z);
      beam.scale.set(1, 1, length);
      beam.visible = true;
      dot.visible = landed;
      if (landed) {
        const back = Math.max(0, length - 0.01); // чуть к стрелку, чтобы точка не тонула в поверхности
        dot.position.set(muzzle.x + dir.x * back, muzzle.y + dir.y * back, muzzle.z + dir.z * back);
      }
    },
    setColor(hex) {
      beamMaterial.color.setHex(hex);
      dotMaterial.color.setHex(hex);
    },
    setVisible(value) {
      on = Boolean(value);
      if (!on) beam.visible = dot.visible = false;
    },
    dispose() {
      root.remove(beam, dot);
      geometry.dispose();
      beamMaterial.dispose();
      dotMaterial.dispose();
      texture.dispose();
    },
  };
}
