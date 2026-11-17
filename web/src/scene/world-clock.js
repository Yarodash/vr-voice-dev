// Часы мира: замедление и ускорение времени («Настройки ▸ Время», shared.timeScale ×0,25 … ×64).
//
// Мир (небо, трава, дым, пули, мишени, тарелки, гильзы, машина, робопсы, коптеры) живёт по сценовому
// времени: shared.sceneNowMs и масштабированный dt. Игрок — нет: рука, оружие в руке (темп стрельбы,
// отдача, затвор), HUD, меню и панели идут по реальному времени (performance.now(), реальный dt).
//
// Кадр шлема (реальный dt) × timeScale = сколько мира надо прожить. Это режется на равные подшаги не
// длиннее STEP_S (все системы мира ограничивают свой dt 0,05 с), не больше MAX_SUB за кадр и не дольше
// BUDGET_MS процессора на кадр (цена подшага меряется). Чего не успели — не догоняется: мир идёт
// медленнее заказанного, shared.sceneNowMs растёт ровно на прожитое, и счётчик под FPS (fps.js)
// показывает честную скорость («×7/64» — прожито ×7 из заказанных 64). Потолок: MAX_SUB · STEP_S =
// 0,4 с мира за кадр (×29 при 72 Гц), в тяжёлом бою — меньше (бюджет). Ручка: __sceneState.worldClock (n, sub, total, wanted, costMs).
export const STEP_S = 0.05;
export const MAX_SUB = 8;
const BUDGET_MS = 10; // Quest, бой стаи: подшаг ≈ 3,5 мс → 2 подшага (×7 при 75 к/с), пустое поле — все 8

export function createWorldClock(shared) {
  const state = { n: 1, sub: 0, total: 0, wanted: 0, costMs: 0 };
  return {
    state,
    // в начале кадра: сколько подшагов какой длины; сценовые часы — сразу на всё прожитое за кадр
    begin(realDt) {
      const wanted = Math.max(0, realDt) * (shared.timeScale ?? 1);
      const afford = state.costMs > 0 ? Math.max(1, Math.floor(BUDGET_MS / state.costMs)) : MAX_SUB;
      const n = Math.max(1, Math.min(MAX_SUB, afford, Math.ceil(wanted / STEP_S - 1e-6)));
      state.n = n;
      state.sub = Math.min(STEP_S, wanted / n);
      state.total = state.sub * n;
      state.wanted = wanted;
      shared.sceneNowMs += state.total * 1000;
      return state;
    },
    // сколько мс заняли state.n подшагов мира в этом кадре (сглаженная цена одного подшага)
    measure(ms) {
      const per = ms / state.n;
      state.costMs = state.costMs > 0 ? state.costMs * 0.9 + per * 0.1 : per;
    },
  };
}
