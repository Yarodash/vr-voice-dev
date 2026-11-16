// Счёт стрельбы (функция сцены «score», см. compositions.js; есть в тире — «Сцена 1»).
//
// Каждый выстрел (у калаша — каждый патрон): попал в мишень (стоящую или лежащую) или разбил
// тарелку — +очки: первое попадание 100, каждое следующее подряд на 20 % больше (100, 120, 144,
// 173, …, округлено); промах (земля, стойка, небо) — −20 и серия сначала. Меньше нуля счёт не бывает.
//
// Табличка висит в HUD (группа у камеры с кружком-индикатором) левее столбика сообщений:
// «Счёт: 1 240» и ниже «серия ×3 (+173)» — сколько даст следующее попадание. После выстрела над
// ней всплывает «+120» / «−20». Счёт и серия живут в shared.score (переживают подмену сцены), а
// между перезагрузками и сценами — в снимке сцены (compositions.js: score).
const BASE = 100;
const GROWTH = 1.2;
const MISS = 20;
const W = 0.18; // табличка, м в пространстве HUD
const H = 0.079;
const GAP = 0.02; // от левого края окон сообщений
const Y = 0.07; // на высоте самого нового (нижнего) окна сообщений
const POPUP_S = 0.9;

export const pointsFor = (streak) => Math.round(BASE * GROWTH ** streak);

export function createScore({ THREE, camera, shared }) {
  const state = (shared.score ??= { score: 0, streak: 0 });

  const makeLabel = (width, height, w, h) => {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false, depthTest: false }),
    );
    mesh.renderOrder = 1001;
    return { canvas, g: canvas.getContext('2d'), texture, mesh };
  };
  const panel = makeLabel(320, 140, W, H);
  panel.mesh.name = 'scene-score';
  const popup = makeLabel(160, 64, 0.075, 0.03);
  popup.mesh.name = 'scene-score-popup';
  popup.mesh.visible = false;

  const spaced = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const draw = () => {
    const { g, canvas } = panel;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.fillStyle = 'rgba(15,23,42,0.72)';
    g.beginPath();
    g.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 18);
    g.fill();
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = '#f8fafc';
    g.font = 'bold 50px system-ui, sans-serif';
    g.fillText(`Счёт: ${spaced(state.score)}`, canvas.width / 2, 48);
    g.font = 'bold 34px system-ui, sans-serif';
    g.fillStyle = state.streak > 0 ? '#facc15' : '#cbd5e1';
    g.fillText(`серия ×${state.streak} (+${pointsFor(state.streak)})`, canvas.width / 2, 104);
    panel.texture.needsUpdate = true;
  };
  let popupLeft = 0;
  const showPopup = (text, color) => {
    const { g, canvas } = popup;
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.font = 'bold 46px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 7;
    g.strokeStyle = 'rgba(0,0,0,0.8)';
    g.strokeText(text, canvas.width / 2, canvas.height / 2);
    g.fillStyle = color;
    g.fillText(text, canvas.width / 2, canvas.height / 2);
    popup.texture.needsUpdate = true;
    popupLeft = POPUP_S;
    popup.mesh.visible = true;
  };
  draw();

  // HUD: группа у камеры с кружком; табличка — левее самого левого окна сообщений (широкие плоскости)
  let hud = null;
  const place = () => {
    if (!hud || hud.parent !== camera) {
      hud = null;
      for (const group of camera.children) {
        if (group.children?.some((c) => c.geometry?.type === 'CircleGeometry')) {
          hud = group;
          break;
        }
      }
      if (!hud) return;
      // таблички прежней версии сцены, если та не убрала их за собой
      for (const old of hud.children.filter((c) => c.name.startsWith('scene-score') && c !== panel.mesh && c !== popup.mesh)) hud.remove(old);
      hud.add(panel.mesh, popup.mesh);
    }
    let left = Infinity;
    for (const child of hud.children) {
      const p = child.geometry?.parameters;
      if (child.geometry?.type !== 'PlaneGeometry' || !p || p.width < 0.3) continue;
      left = Math.min(left, child.position.x - p.width / 2);
    }
    if (!Number.isFinite(left)) left = -0.3;
    panel.mesh.position.set(left - GAP - W / 2, Y, 0);
  };

  let visible = true;
  return {
    state,
    // features.score у активной сцены
    setVisible(on) {
      visible = Boolean(on);
      panel.mesh.visible = visible;
      if (!visible) popup.mesh.visible = false;
    },
    // выстрел: hit — попал в мишень или тарелку
    shot(hit) {
      if (hit) {
        const points = pointsFor(state.streak);
        state.score += points;
        state.streak += 1;
        showPopup(`+${points}`, '#4ade80');
      } else {
        const lost = Math.min(MISS, state.score);
        state.score -= lost;
        state.streak = 0;
        showPopup(`−${MISS}`, '#f87171');
      }
      draw();
    },
    // бонус сверх выстрела (убит робопёс): +points, серия не меняется
    bonus(points) {
      state.score += Math.round(points);
      showPopup(`+${Math.round(points)}`, '#facc15');
      draw();
    },
    reset() {
      state.score = 0;
      state.streak = 0;
      draw();
    },
    get() {
      return { score: state.score, streak: state.streak };
    },
    set(saved) {
      state.score = Math.max(0, Math.round(saved?.score ?? 0));
      state.streak = Math.max(0, Math.round(saved?.streak ?? 0));
      draw();
    },
    update(dt) {
      place();
      if (popupLeft > 0) {
        popupLeft = Math.max(0, popupLeft - dt);
        const t = 1 - popupLeft / POPUP_S;
        popup.mesh.position.set(panel.mesh.position.x, panel.mesh.position.y + H / 2 + 0.02 + t * 0.03, 0);
        popup.mesh.material.opacity = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
        popup.mesh.visible = visible && popupLeft > 0;
      }
    },
    dispose() {
      for (const label of [panel, popup]) {
        label.mesh.removeFromParent();
        label.mesh.geometry.dispose();
        label.mesh.material.dispose();
        label.texture.dispose();
      }
    },
  };
}
