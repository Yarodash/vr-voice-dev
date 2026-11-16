// Дешёвая карта окружения только для металла оружия (на сцену не вешается): закатный градиент
// + пятно солнца, один раз через PMREM, кэш в __sceneState.weaponEnv (при подмене сцены не освобождается).
export function ensureWeaponEnv(THREE, renderer) {
  const shared = (globalThis.__sceneState ??= {});
  if (shared.weaponEnv) return shared.weaponEnv;
  const geometry = new THREE.SphereGeometry(10, 32, 16);
  const pos = geometry.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const top = new THREE.Color(0x3a4a8c);
  const mid = new THREE.Color(0xff8a4a);
  const low = new THREE.Color(0x1a1620);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i) / 10;
    if (y >= 0) c.copy(mid).lerp(top, Math.min(1, y * 1.6));
    else c.copy(mid).lerp(low, Math.min(1, -y * 3));
    colors[i * 3] = c.r; colors[i * 3 + 1] = c.g; colors[i * 3 + 2] = c.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const sky = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide }));
  const sun = new THREE.Mesh(new THREE.SphereGeometry(1.6, 12, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xffd9a0).multiplyScalar(6) }));
  sun.position.set(6, 2.5, -6);
  const lamp = new THREE.Mesh(new THREE.BoxGeometry(3, 0.4, 3), new THREE.MeshBasicMaterial({ color: new THREE.Color(0xbfd0ff).multiplyScalar(3) }));
  lamp.position.set(-2, 8, 2);
  const envScene = new THREE.Scene();
  envScene.add(sky, sun, lamp);
  const pmrem = new THREE.PMREMGenerator(renderer);
  shared.weaponEnv = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();
  for (const o of [sky, sun, lamp]) { o.geometry.dispose(); o.material.dispose(); }
  return shared.weaponEnv;
}
