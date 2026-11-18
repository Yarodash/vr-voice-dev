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
// показывает честную скорость («×7/64» — прожито ×7 из заказанных 64). Ручка: __sceneState.worldClock
// (n, sub, total, wanted, costMs, fast, last, step).
//
// Быстрый режим (×32 и ×64, просьба пользователя: «порежь FPS, но чтобы 64x по логике было»):
// - подшаг длиннее: FAST[x].step (0,1 / 0,2 с). Системы мира принимают dt до MAX_STEP_S (стая,
//   коптеры, пули, кукла — сама дробит на 1/120); мелкие (машина, гильзы, тарелки) main.js дробит
//   до STEP_S;
// - логика отдельно от картинки: state.last — последний подшаг кадра. На промежуточных подшагах
//   системы только считают (стая: походка/поза псов, буферы экземпляров; коптеры: рисовка, звук),
//   картинка — один раз на последнем;
// - бюджет мира на кадр FAST[x].budget мс (кадр ~45–60 мс, 15–20 к/с; голову держит компоновщик
//   шлема), экран FAST_HZ (main.js просит у шлема);
// - страховка от рывков: если подшаги вдруг дороже ожидаемого, cut() обрывает кадр после
//   HARD_MS и возвращает сценовым часам непрожитое (кадр не длиннее ~100 мс).
export const STEP_S = 0.05;
export const MAX_SUB = 8;
export const MAX_STEP_S = 0.2; // самый длинный подшаг, который получает система мира (быстрый режим)
const BUDGET_MS = 10; // Quest, бой стаи: подшаг ≈ 3,5 мс → 2 подшага (×7 при 75 к/с), пустое поле — все 8
export const FAST_FROM = 32;
export const FAST_HZ = 72;
const FAST = {
  32: { step: 0.1, budget: 30, maxSub: 24 },
  64: { step: 0.2, budget: 48, maxSub: 32 },
};
const HARD_MS = 80; // быстрый режим: дольше — кадр обрывается (непрожитое не засчитывается)

export function createWorldClock(shared) {
  const state = { n: 1, sub: 0, total: 0, wanted: 0, costMs: 0, fast: false, last: true, step: STEP_S };
  let fastCost = 0; // цена подшага в быстром режиме — своя (подшаг длиннее, картинка раз в кадр)
  let slowCost = 0;
  return {
    state,
    // в начале кадра: сколько подшагов какой длины; сценовые часы — сразу на всё прожитое за кадр
    begin(realDt) {
      const scale = shared.timeScale ?? 1;
      const wanted = Math.max(0, realDt) * scale;
      const fast = scale >= FAST_FROM ? FAST[scale >= 64 ? 64 : 32] : null;
      if (Boolean(fast) !== state.fast) state.costMs = fast ? fastCost : slowCost;
      state.fast = Boolean(fast);
      const step = fast ? fast.step : STEP_S;
      const maxSub = fast ? fast.maxSub : MAX_SUB;
      const budget = fast ? fast.budget : BUDGET_MS;
      const afford = state.costMs > 0 ? Math.max(1, Math.floor(budget / state.costMs)) : fast ? 4 : maxSub;
      const n = Math.max(1, Math.min(maxSub, afford, Math.ceil(wanted / step - 1e-6)));
      state.n = n;
      state.step = step;
      state.sub = Math.min(step, wanted / n);
      state.total = state.sub * n;
      state.wanted = wanted;
      state.last = true;
      shared.sceneNowMs += state.total * 1000;
      return state;
    },
    // быстрый режим: подшаги [done, n) не прожиты (кадр стал слишком долгим) — вернуть их часам
    cut(done) {
      if (done >= state.n) return;
      shared.sceneNowMs -= (state.n - done) * state.sub * 1000;
      state.n = done;
      state.total = done * state.sub;
    },
    hardMs: HARD_MS,
    // сколько мс заняли state.n подшагов мира в этом кадре (сглаженная цена одного подшага)
    measure(ms) {
      if (state.n <= 0) return;
      const per = ms / state.n;
      state.costMs = state.costMs > 0 ? state.costMs * 0.9 + per * 0.1 : per;
      if (state.fast) fastCost = state.costMs;
      else slowCost = state.costMs;
    },
  };
}
