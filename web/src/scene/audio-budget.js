// Общий бюджет звуков мира (псы, коптеры, артиллерия, рог): в большой битве сотня псов не должна
// делать сотню звуков, а свои выстрелы игрока должны звучать всегда и чисто.
//
// Правило приоритетов (docs/agents/effects-and-sound.md «Приоритеты»):
// - Звуки ИГРОКА (sound.js: выстрелы, попадания, мана, затвор, гильзы; arena-sound.js: ракета, рельса,
//   плазма и их разрывы; blackhole-sound.js; robodog-sound.js с own = true — звон от СВОЕЙ пули) бюджет
//   не спрашивают: у них свои пулы голосов, которые звуки мира не трогают, и они не пропускаются
//   (нет свободного голоса — гаснет старейший свой).
// - Звуки МИРА перед игрой спрашивают budget.admit(cat, p, loud, seconds, ref, rolloff): слышимость =
//   громкость × затухание панорамы на расстоянии до головы (та же формула 'inverse', что у паннера).
//   Неслышные (< MIN_AUDIBLE) не играют вовсе; у каждой категории — лимит одновременных и частота
//   (событий в секунду, «ведро жетонов»); общий лимит GLOBAL на все звуки мира. Сверх лимита — только
//   если звук заметно слышнее самого тихого из звучащих (ближний/громкий побеждает дальний), и не
//   больше HARD. Звук не останавливается чужим — лимит считает реально звучащие до их конца.
// - Звуки мира идут в общую шину npcBus (→ master); на свой выстрел игрока она коротко приглушается
//   (budget.duck(): ~−4 дБ, 15 мс вниз, назад за ~0,3 с) — свой выстрел не тонет в битве.
// Ничего не строится на звук: одна шина на страницу (audioGraph.npcBus), остальное — числа.
//
// С ПК: npm run vr:eval -- "__sceneState.audioBudget.stats()"
export const BUDGET_VERSION = 3; // 2: лимиты шире — в бою на Quest молчали ~40 % очередей и 44 % взрывов

const GLOBAL = 28; // одновременных звуков мира (разовых; петли гула не в счёт — их и так 4–6)
const HARD = 34; // сверх GLOBAL — только заметно более слышные, и не больше этого
const MIN_AUDIBLE = 0.025; // ниже — не слышно в битве (≈ −32 дБ): не играть
const LOUDER = 1.5; // во сколько раз слышнее самого тихого звучащего, чтобы пройти сверх лимита
// max — одновременных в категории; rate — событий в секунду (ведро на rate/2, не меньше 2)
export const CATEGORIES = {
  step: { max: 3, rate: 6 }, // шаги, шарниры, гул земли, скрежет, взмах лапы
  gun: { max: 8, rate: 14 }, // пулемёты псов и коптеров, наводка башенки
  hit: { max: 6, rate: 16 }, // звон металла, рикошет, удары
  zap: { max: 3, rate: 8 }, // разряды, треск
  boom: { max: 8, rate: 14 }, // разрывы коптеров, артиллерии, отключение пса: видимый взрыв должен звучать
  voice: { max: 2, rate: 3 }, // лай, шипение гидравлики
  far: { max: 3, rate: 4 }, // далёкое: выстрел батареи, свист снаряда, рог
};

// Выход звуков мира: npcBus (одна на страницу, создаётся лениво, к master). Модули мира подключают
// свои голоса сюда вместо master и пересобирают их, если шина сменилась.
// Шина мира → свой лимитер → master: громкий разрыв рядом больше не «прижимает» общий компрессор выхода
// (замер на Quest: −13,6 дБ на 0,4 с — свои выстрелы в это время почти не слышны). Мир упирается в свой
// потолок (≈ −5,5 дБ), а сжимается только он сам. Один DynamicsCompressor на страницу.
const NPC_BUS_VERSION = 2;
export const npcOut = (g) => {
  if (!g?.context || !g.master) return g?.master ?? null;
  if (!g.npcBus || g.npcBus.context !== g.context || g.npcBusVersion !== NPC_BUS_VERSION || g.npcBusMaster !== g.master) {
    try {
      g.npcBus?.disconnect();
      g.npcLimiter?.disconnect();
    } catch {
      // уже отключены
    }
    const bus = g.context.createGain();
    bus.gain.value = 1;
    const lim = g.context.createDynamicsCompressor();
    lim.threshold.value = -6;
    lim.knee.value = 4;
    lim.ratio.value = 12;
    lim.attack.value = 0.002;
    lim.release.value = 0.15;
    const makeup = g.context.createGain();
    // Chromium сам поднимает выход компрессора ((1/полный_диапазон)^0,6 ≈ ×1,46 при −6 дБ, 12:1) — снять его:
    // тихие звуки мира остаются как были, громкие упираются в ≈ −5,5 дБ
    makeup.gain.value = 0.68;
    bus.connect(lim).connect(makeup).connect(g.master);
    g.npcBus = bus;
    g.npcLimiter = lim;
    g.npcBusVersion = NPC_BUS_VERSION;
    g.npcBusMaster = g.master;
  }
  return g.npcBus;
};

export function audioBudget(shared) {
  // >=: модуль старой версии (его держит ещё не пересозданный объект) не откатывает новый бюджет
  if (shared.audioBudget?.version >= BUDGET_VERSION) return shared.audioBudget;
  const prevHead = shared.audioBudget?.head;
  const now = () => performance.now() / 1000;
  const cats = {};
  for (const [name, cfg] of Object.entries(CATEGORIES)) {
    const burst = Math.max(2, cfg.rate / 2);
    cats[name] = { ...cfg, burst, tokens: burst, at: now(), live: [], admitted: 0, culled: 0, rated: 0, capped: 0, over: 0 };
  }
  const counters = { admitted: 0, culled: 0, rated: 0, capped: 0, over: 0, own: 0, ducks: 0, peak: 0 };
  // голова слушателя: sound.js update() кладёт её сюда каждый кадр
  const head = prevHead ?? { x: 0, y: 1.6, z: 0, ok: false };
  let all = 0;

  const prune = (t) => {
    all = 0;
    for (const name in cats) {
      const c = cats[name];
      let n = 0;
      for (let i = 0; i < c.live.length; i += 1) if (c.live[i].end > t) c.live[n++] = c.live[i];
      c.live.length = n;
      all += n;
    }
  };
  const weakest = (list) => {
    let w = null;
    for (const e of list) if (!w || e.a < w.a) w = e;
    return w;
  };

  const api = {
    version: BUDGET_VERSION,
    head,
    setHead(x, y, z) {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      head.x = x;
      head.y = y;
      head.z = z;
      head.ok = true;
    },
    // Можно ли сыграть звук мира? cat — из CATEGORIES; p — мировая точка; loud — громкость звука
    // (gain голоса); seconds — сколько он звучит; ref/rolloff — как у паннера голоса.
    admit(cat, p, loud = 1, seconds = 0.5, ref = 1.5, rolloff = 0.5) {
      try {
        const c = cats[cat];
        if (!c || !p) return true;
        const t = now();
        // слышимость: 'inverse' как у PannerNode
        const dd = head.ok ? Math.hypot(p.x - head.x, (p.y ?? head.y) - head.y, p.z - head.z) : ref;
        const d = Number.isFinite(dd) ? dd : ref;
        const a = loud * (ref / (ref + rolloff * Math.max(0, d - ref)));
        if (!(a >= MIN_AUDIBLE)) {
          c.culled += 1;
          counters.culled += 1;
          return false;
        }
        c.tokens = Math.min(c.burst, c.tokens + (t - c.at) * c.rate);
        c.at = t;
        if (c.tokens < 1) {
          c.rated += 1;
          counters.rated += 1;
          return false;
        }
        prune(t);
        if (c.live.length >= c.max || all >= GLOBAL) {
          // сверх лимита: только заметно слышнее самого тихого (в категории, если полна она; иначе во всех)
          let w = null;
          if (c.live.length >= c.max) w = weakest(c.live);
          else for (const name in cats) {
            const x = weakest(cats[name].live);
            if (x && (!w || x.a < w.a)) w = x;
          }
          if (all >= HARD || c.live.length >= c.max + 1 || !w || a < w.a * LOUDER) {
            c.capped += 1;
            counters.capped += 1;
            return false;
          }
          c.over += 1;
          counters.over += 1;
        }
        c.tokens -= 1;
        c.live.push({ end: t + Math.min(4, Math.max(0.05, Number.isFinite(seconds) ? seconds : 0.5)), a });
        all += 1;
        if (all > counters.peak) counters.peak = all;
        c.admitted += 1;
        counters.admitted += 1;
        return true;
      } catch {
        return true; // бюджет не важнее звука
      }
    },
    // Свой выстрел игрока: коротко приглушить шину мира (k — множитель громкости на пике)
    duck(k = 0.62) {
      try {
        counters.own += 1;
        const g = shared.audioGraph;
        const bus = g?.npcBus;
        if (!bus || !Number.isFinite(k)) return;
        const t = g.context.currentTime;
        const gain = bus.gain;
        gain.cancelScheduledValues(t);
        gain.setValueAtTime(Math.min(1, Math.max(0, gain.value)), t);
        gain.linearRampToValueAtTime(Math.min(1, Math.max(0.2, k)), t + 0.015);
        gain.setTargetAtTime(1, t + 0.1, 0.09);
        counters.ducks += 1;
      } catch {
        // звук не важнее игры
      }
    },
    stats() {
      prune(now());
      const per = {};
      for (const [name, c] of Object.entries(cats)) per[name] = { live: c.live.length, max: c.max, ok: c.admitted, culled: c.culled, rated: c.rated, capped: c.capped, over: c.over };
      return { live: all, global: GLOBAL, hard: HARD, bus: +(shared.audioGraph?.npcBus?.gain.value ?? 1).toFixed(2), ...counters, cats: per };
    },
  };
  return (shared.audioBudget = api);
}
