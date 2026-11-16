// «Относительно схватить» — хват, при котором предмет НЕ прыгает в руку.
//
// Для сравнения: «Абсолютно схватить» (так берётся пистолет в main.js) сажает предмет в руку в
// заранее заданное положение. Здесь же в момент хвата запоминается, где предмет находится
// относительно контроллера (offset = inverse(руки) × предмет), и дальше каждый кадр
// предмет = рука × offset: он двигается и поворачивается ровно как рука с момента хвата
// (потянул руку к себе — предмет приблизился, сохраняя расстояние и угол). Отпустил — предмет
// висит там, где оказался.
//
// Использование:
//   const grab = createRelativeGrab({ THREE, object });
//   grab.grab(hand.matrixWorld);      // в момент хвата
//   grab.update(hand.matrixWorld);    // каждый кадр (пока не держат — ничего не делает)
//   grab.release();                   // отпустить
export function createRelativeGrab({ THREE, object }) {
  const offset = new THREE.Matrix4(); // положение предмета в системе руки
  const world = new THREE.Matrix4();
  const parentInverse = new THREE.Matrix4();
  let held = false;

  return {
    get held() {
      return held;
    },
    // handMatrixWorld: мировая матрица контроллера в момент хвата
    grab(handMatrixWorld) {
      object.updateWorldMatrix(true, false);
      offset.copy(handMatrixWorld).invert().multiply(object.matrixWorld);
      held = true;
    },
    // ставит предмет: рука × offset (в системе родителя предмета)
    update(handMatrixWorld) {
      if (!held) return;
      world.multiplyMatrices(handMatrixWorld, offset);
      if (object.parent) {
        object.parent.updateWorldMatrix(true, false);
        world.premultiply(parentInverse.copy(object.parent.matrixWorld).invert());
      }
      world.decompose(object.position, object.quaternion, object.scale);
    },
    release() {
      held = false;
    },
  };
}
