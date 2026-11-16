// A ray from the left controller for pressing the on-screen buttons.
import * as THREE from 'three';

const RAY_LENGTH_M = 3;

// panels: [{ mesh, actionAt(uv) }]
export function createPointer({ scene, panels }) {
  const raycaster = new THREE.Raycaster();
  const origin = new THREE.Vector3();
  const direction = new THREE.Vector3();

  const line = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(0, 0, -1)]),
    new THREE.LineBasicMaterial({ color: 0x93c5fd, transparent: true, opacity: 0.45 }),
  );
  line.frustumCulled = false;
  const dot = new THREE.Mesh(new THREE.SphereGeometry(0.012, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff }));
  line.visible = false;
  dot.visible = false;
  scene.add(line, dot);

  let hover = null;

  return {
    // The action under the ray right now ('send', 'clear', 'close-message') or null.
    get action() {
      return hover;
    },

    // controller: the left controller's ray object, or null when it is not tracked.
    update(controller) {
      hover = null;
      line.visible = false; // the beam itself is not drawn; only the dot where it hits a window
      dot.visible = false;
      if (!controller) return;

      origin.setFromMatrixPosition(controller.matrixWorld);
      direction.set(0, 0, -1).transformDirection(controller.matrixWorld);
      raycaster.set(origin, direction);

      let distance = RAY_LENGTH_M;
      const visible = panels.filter((panel) => panel.mesh.visible);
      const hit = raycaster.intersectObjects(visible.map((panel) => panel.mesh), false)[0];
      if (hit) {
        distance = hit.distance;
        hover = visible.find((panel) => panel.mesh === hit.object).actionAt(hit.uv);
        dot.position.copy(hit.point);
        dot.material.color.set(hover ? 0x22c55e : 0xffffff);
        dot.visible = true;
      }
      const positions = line.geometry.attributes.position;
      positions.setXYZ(0, origin.x, origin.y, origin.z);
      positions.setXYZ(1, origin.x + direction.x * distance, origin.y + direction.y * distance, origin.z + direction.z * distance);
      positions.needsUpdate = true;
    },
  };
}
