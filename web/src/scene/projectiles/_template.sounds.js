// [П3] ЗВУКИ снаряда — этот файл правит ТОЛЬКО агент звука (параллельно с логикой и видом).
// Ключ — событие, которое логика (<имя>.js) уже вызывает; нет ключа — событие молчит:
//   launch    — выстрел (у дула; шина мира коротко приглушается — выстрел игрока)
//   land      — снаряд упал и лежит (длинный звук = «горит/шипит», пусть сам затухает к fuse)
//   preStrike — за `lead` с до эффекта (свист падающего снаряда и т. п.)
//   strike    — в момент эффекта (артиллерийский разрыв уже со своим взрывом — это добавка)
//   expire    — погас в воздухе
// Рецепт: { seconds, variants = 1, render(d, sr), vol = 1, ref = 2 (м, громкость падает дальше), lead (только preStrike) }.
// render пишет моно-сэмплы в Float32Array d — считается ОДИН раз (запекается; правила — шапка
// ../sound-bank.js и «PRIORITY RULE» в docs/agents/effects-and-sound.md: запечённые буферы, постоянные голоса,
// на звук один BufferSource); правка render перепекает банк сам. Без узлов Web Audio, только числа.
// Проверка: npm run vr:eval -- "__sceneState.projectileDebug.<имя>.stats().sound" → baked: { launch: 2, … }, played растёт.
import { normalize, fadeTail } from '../sound-bank.js';

export const SOUNDS = {
  // выстрел: глухой толчок (синус 120→40 Гц) + щелчок шума
  launch: { seconds: 0.35, variants: 2, vol: 1.1, render(d, sr) {
    let ph = 0;
    for (let i = 0; i < d.length; i += 1) {
      const t = i / sr;
      ph += (2 * Math.PI * (40 + 80 * Math.exp(-t / 0.04))) / sr;
      d[i] = Math.sin(ph) * Math.exp(-t / 0.09) + (Math.random() * 2 - 1) * Math.exp(-t / 0.01) * 0.5;
    }
    fadeTail(d, sr);
    normalize(d, 0.9);
  } },
  // упал: короткий писк 1,6 кГц
  land: { seconds: 0.12, vol: 0.8, render(d, sr) {
    for (let i = 0; i < d.length; i += 1) d[i] = Math.sin((2 * Math.PI * 1600 * i) / sr) * Math.exp(-i / sr / 0.04);
    fadeTail(d, sr, 0.02);
    normalize(d, 0.6);
  } },
};
