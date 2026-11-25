// Облик неба, облаков и света на земле по состоянию атмосферы (scene/atmosphere.js, `shared.atmosphere.now`).
// Здесь только расчёт на процессоре, раз в кадр и без выделений памяти: палитры стилей неба (pink / gold /
// blue / cosmic) как функция высоты солнца, смешивание стилей по весам, поправки на погоду (пелена,
// грозовые тучи, туман, вспышка молнии), сезонные цвета травы, ветер. world.js отдаёт готовые цвета в
// шейдеры uniform-ами (ни одной новой шейдерной программы при смене погоды). Правка этого файла мир не
// пересобирает (кэш мира — по тексту createWorld).
//
// createSkyLook(THREE) → { look, pub, update(now, dt) }
//   look — значения для uniform-ов (Color / Vector*, меняются на месте);
//   pub  — то же для соседей (shared.skyLook): { sunLight, skyLight, horizonSun, horizonFar, horizon,
//          horizonAt(x, z, out), sunFlat, veil, zenith, lightDir, night, shadow, snow }. Цвет горизонта —
//          фактический, какой рисует небо: палитра стиля по высоте солнца, пелена и грозовые тучи,
//          туман погоды, вспышка молнии.
// makeDefaultNow(THREE) — запасное состояние (сегодняшний закат), пока модуля атмосферы нет.

// ---- ключи палитры по высоте солнца (градусы): ночь, сумерки, закат, золотой час, день
export const KEY_ELEV = [-16, -5, 2.2, 11, 38];
const KEY_SWITCH_ELEV = -5.5; // ниже — светит луна (то же число — KEY_SWITCH_ELEV в atmosphere.js)
const COLORS = [
  'zenithFar', 'zenithSun', 'bandFar', 'bandSun', 'horizonFar', 'horizonSun',
  'glowWide', 'glowHalo', 'glowHorizon', 'sunDisc', 'sunBloom',
  'cloudLitFar', 'cloudLitMid', 'cloudLitSun', 'cloudShadeFar', 'cloudShadeSun', 'cloudRim',
  'sunLight', 'skyLight', 'glowTint',
];
const SCALARS = ['stars', 'starSide', 'mw', 'nebula', 'aurora'];
const N = COLORS.length * 3 + SCALARS.length;
const m = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const Z = [0, 0, 0];

// Цвета линейные (как в шейдере). «Far» — сторона неба напротив солнца, «Sun» — сторона солнца.
// sunLight / skyLight / glowTint — свет на траве и земле (ночью sunLight — свет луны).
// pink[2] (закат) — ровно прежние константы world.js: с ними картинка совпадает с той, что была.
const STYLES = {
  // розовое мультяшное
  pink: [
    { // ночь
      zenithFar: [0.004, 0.006, 0.028], zenithSun: [0.005, 0.007, 0.032], bandFar: [0.02, 0.013, 0.055], bandSun: [0.024, 0.014, 0.06],
      horizonFar: [0.055, 0.032, 0.1], horizonSun: [0.066, 0.034, 0.105],
      glowWide: Z, glowHalo: Z, glowHorizon: Z, sunDisc: [3, 2.16, 1.14], sunBloom: Z,
      cloudLitFar: [0.075, 0.065, 0.14], cloudLitMid: [0.085, 0.07, 0.15], cloudLitSun: [0.095, 0.075, 0.16],
      cloudShadeFar: [0.014, 0.014, 0.036], cloudShadeSun: [0.016, 0.014, 0.038], cloudRim: Z,
      sunLight: [0.26, 0.3, 0.52], skyLight: [0.1, 0.105, 0.2], glowTint: [0.07, 0.08, 0.13],
      stars: 1, starSide: 0, mw: 1, nebula: 0, aurora: 0,
    },
    { // сумерки
      zenithFar: [0.004, 0.007, 0.034], zenithSun: [0.012, 0.022, 0.095], bandFar: [0.028, 0.024, 0.08], bandSun: [0.26, 0.07, 0.17],
      horizonFar: [0.05, 0.048, 0.12], horizonSun: [0.6, 0.13, 0.07],
      glowWide: m([0.9, 0.25, 0.08], 0.3), glowHalo: Z, glowHorizon: m([1, 0.3, 0.08], 0.3), sunDisc: [3, 2.16, 1.14], sunBloom: Z,
      cloudLitFar: [0.13, 0.085, 0.19], cloudLitMid: [0.42, 0.14, 0.26], cloudLitSun: [0.9, 0.3, 0.22],
      cloudShadeFar: [0.02, 0.022, 0.05], cloudShadeSun: [0.09, 0.035, 0.07], cloudRim: m([1, 0.45, 0.28], 0.6),
      sunLight: [0.3, 0.2, 0.22], skyLight: [0.17, 0.18, 0.3], glowTint: [0.25, 0.17, 0.13],
      stars: 1, starSide: 0.6, mw: 1, nebula: 0, aurora: 0,
    },
    { // закат — как было
      zenithFar: [0.006, 0.01, 0.042], zenithSun: [0.028, 0.065, 0.21], bandFar: [0.07, 0.05, 0.13], bandSun: [0.62, 0.17, 0.17],
      horizonFar: [0.1, 0.1, 0.2], horizonSun: [0.85, 0.2, 0.045],
      glowWide: m([0.9, 0.3, 0.05], 0.4), glowHalo: m([1.0, 0.5, 0.14], 0.4), glowHorizon: m([1.0, 0.32, 0.05], 0.3),
      sunDisc: m([1.0, 0.72, 0.38], 3), sunBloom: m([1.0, 0.62, 0.3], 0.9),
      cloudLitFar: [0.42, 0.2, 0.32], cloudLitMid: [0.95, 0.36, 0.34], cloudLitSun: [1.0, 0.56, 0.18],
      cloudShadeFar: [0.04, 0.045, 0.09], cloudShadeSun: [0.2, 0.08, 0.1], cloudRim: m([1.0, 0.62, 0.28], 1.3),
      sunLight: [1.0, 0.58, 0.28], skyLight: [0.3, 0.34, 0.48], glowTint: [1.0, 0.8, 0.3],
      stars: 1, starSide: 1, mw: 1, nebula: 0, aurora: 0,
    },
    { // золотой час
      zenithFar: [0.03, 0.07, 0.26], zenithSun: [0.06, 0.13, 0.4], bandFar: [0.2, 0.19, 0.42], bandSun: [0.72, 0.36, 0.4],
      horizonFar: [0.36, 0.28, 0.44], horizonSun: [1.0, 0.48, 0.24],
      glowWide: m([1, 0.5, 0.15], 0.3), glowHalo: m([1, 0.7, 0.35], 0.45), glowHorizon: m([1, 0.5, 0.15], 0.2),
      sunDisc: m([1, 0.85, 0.6], 3.2), sunBloom: m([1, 0.8, 0.5], 1),
      cloudLitFar: [0.72, 0.5, 0.62], cloudLitMid: [1, 0.62, 0.56], cloudLitSun: [1, 0.8, 0.48],
      cloudShadeFar: [0.16, 0.14, 0.3], cloudShadeSun: [0.42, 0.21, 0.27], cloudRim: m([1, 0.8, 0.5], 1),
      sunLight: [1.12, 0.85, 0.52], skyLight: [0.42, 0.46, 0.66], glowTint: [1.15, 1.0, 0.46],
      stars: 0.25, starSide: 1, mw: 0, nebula: 0, aurora: 0,
    },
    { // день
      zenithFar: [0.07, 0.17, 0.6], zenithSun: [0.08, 0.19, 0.62], bandFar: [0.28, 0.36, 0.78], bandSun: [0.32, 0.38, 0.8],
      horizonFar: [0.7, 0.56, 0.8], horizonSun: [0.82, 0.62, 0.8],
      glowWide: Z, glowHalo: m([1, 0.9, 0.78], 0.45), glowHorizon: Z,
      sunDisc: m([1, 0.97, 0.9], 3.5), sunBloom: m([1, 0.95, 0.85], 1.2),
      cloudLitFar: [1, 0.93, 0.97], cloudLitMid: [1, 0.94, 0.96], cloudLitSun: [1, 0.96, 0.94],
      cloudShadeFar: [0.46, 0.4, 0.66], cloudShadeSun: [0.5, 0.42, 0.66], cloudRim: m([1, 1, 1], 0.5),
      sunLight: [1.3, 1.17, 0.96], skyLight: [0.62, 0.7, 0.98], glowTint: [1.5, 1.4, 0.75],
      stars: 0, starSide: 1, mw: 0, nebula: 0, aurora: 0,
    },
  ],
  // золотое
  gold: [
    { // ночь
      zenithFar: [0.005, 0.006, 0.02], zenithSun: [0.006, 0.007, 0.022], bandFar: [0.027, 0.02, 0.03], bandSun: [0.032, 0.022, 0.03],
      horizonFar: [0.075, 0.05, 0.04], horizonSun: [0.09, 0.058, 0.04],
      glowWide: Z, glowHalo: Z, glowHorizon: Z, sunDisc: [3, 2.5, 1.5], sunBloom: Z,
      cloudLitFar: [0.09, 0.075, 0.09], cloudLitMid: [0.1, 0.082, 0.09], cloudLitSun: [0.11, 0.09, 0.09],
      cloudShadeFar: [0.016, 0.014, 0.022], cloudShadeSun: [0.018, 0.015, 0.022], cloudRim: Z,
      sunLight: [0.36, 0.32, 0.36], skyLight: [0.11, 0.105, 0.15], glowTint: [0.09, 0.08, 0.08],
      stars: 0.9, starSide: 0, mw: 0.8, nebula: 0, aurora: 0,
    },
    { // сумерки
      zenithFar: [0.008, 0.012, 0.035], zenithSun: [0.03, 0.035, 0.07], bandFar: [0.04, 0.035, 0.06], bandSun: [0.4, 0.17, 0.06],
      horizonFar: [0.08, 0.06, 0.07], horizonSun: [0.85, 0.36, 0.05],
      glowWide: m([1, 0.5, 0.1], 0.35), glowHalo: Z, glowHorizon: m([1, 0.55, 0.1], 0.35), sunDisc: [3, 2.5, 1.5], sunBloom: Z,
      cloudLitFar: [0.16, 0.12, 0.12], cloudLitMid: [0.55, 0.28, 0.12], cloudLitSun: [1, 0.55, 0.16],
      cloudShadeFar: [0.03, 0.026, 0.04], cloudShadeSun: [0.13, 0.06, 0.035], cloudRim: m([1, 0.7, 0.3], 0.7),
      sunLight: [0.34, 0.26, 0.16], skyLight: [0.2, 0.18, 0.22], glowTint: [0.3, 0.24, 0.1],
      stars: 0.8, starSide: 0.7, mw: 0.6, nebula: 0, aurora: 0,
    },
    { // закат
      zenithFar: [0.02, 0.03, 0.075], zenithSun: [0.1, 0.11, 0.17], bandFar: [0.16, 0.115, 0.1], bandSun: [0.86, 0.43, 0.09],
      horizonFar: [0.3, 0.19, 0.11], horizonSun: [1.0, 0.56, 0.08],
      glowWide: m([1, 0.6, 0.1], 0.5), glowHalo: m([1, 0.75, 0.3], 0.5), glowHorizon: m([1, 0.6, 0.1], 0.35),
      sunDisc: m([1, 0.86, 0.5], 3.2), sunBloom: m([1, 0.8, 0.4], 1),
      cloudLitFar: [0.5, 0.33, 0.21], cloudLitMid: [1, 0.6, 0.22], cloudLitSun: [1, 0.82, 0.32],
      cloudShadeFar: [0.07, 0.052, 0.062], cloudShadeSun: [0.3, 0.15, 0.05], cloudRim: m([1, 0.85, 0.4], 1.4),
      sunLight: [1.0, 0.68, 0.26], skyLight: [0.4, 0.36, 0.34], glowTint: [1, 0.85, 0.3],
      stars: 0.4, starSide: 1, mw: 0.3, nebula: 0, aurora: 0,
    },
    { // золотой час
      zenithFar: [0.06, 0.12, 0.3], zenithSun: [0.16, 0.2, 0.34], bandFar: [0.34, 0.3, 0.3], bandSun: [0.95, 0.62, 0.2],
      horizonFar: [0.6, 0.44, 0.26], horizonSun: [1.0, 0.72, 0.2],
      glowWide: m([1, 0.7, 0.2], 0.4), glowHalo: m([1, 0.85, 0.45], 0.55), glowHorizon: m([1, 0.7, 0.2], 0.25),
      sunDisc: m([1, 0.92, 0.65], 3.3), sunBloom: m([1, 0.88, 0.55], 1.1),
      cloudLitFar: [0.85, 0.66, 0.42], cloudLitMid: [1, 0.78, 0.4], cloudLitSun: [1, 0.9, 0.5],
      cloudShadeFar: [0.24, 0.19, 0.2], cloudShadeSun: [0.5, 0.3, 0.13], cloudRim: m([1, 0.92, 0.6], 1.1),
      sunLight: [1.12, 0.9, 0.45], skyLight: [0.5, 0.48, 0.5], glowTint: [1.15, 1.04, 0.44],
      stars: 0, starSide: 1, mw: 0, nebula: 0, aurora: 0,
    },
    { // день
      zenithFar: [0.1, 0.27, 0.56], zenithSun: [0.12, 0.29, 0.56], bandFar: [0.42, 0.52, 0.62], bandSun: [0.5, 0.56, 0.6],
      horizonFar: [0.95, 0.78, 0.48], horizonSun: [1.0, 0.82, 0.46],
      glowWide: Z, glowHalo: m([1, 0.9, 0.6], 0.55), glowHorizon: Z,
      sunDisc: m([1, 0.96, 0.8], 3.5), sunBloom: m([1, 0.93, 0.7], 1.2),
      cloudLitFar: [1, 0.94, 0.8], cloudLitMid: [1, 0.95, 0.8], cloudLitSun: [1, 0.96, 0.82],
      cloudShadeFar: [0.56, 0.47, 0.4], cloudShadeSun: [0.6, 0.48, 0.38], cloudRim: m([1, 0.97, 0.85], 0.5),
      sunLight: [1.3, 1.14, 0.8], skyLight: [0.68, 0.7, 0.76], glowTint: [1.5, 1.38, 0.68],
      stars: 0, starSide: 1, mw: 0, nebula: 0, aurora: 0,
    },
  ],
  // обычное синее с белыми облаками
  blue: [
    { // ночь
      zenithFar: [0.002, 0.005, 0.02], zenithSun: [0.0025, 0.006, 0.022], bandFar: [0.006, 0.012, 0.035], bandSun: [0.007, 0.013, 0.037],
      horizonFar: [0.016, 0.026, 0.055], horizonSun: [0.018, 0.028, 0.058],
      glowWide: Z, glowHalo: Z, glowHorizon: Z, sunDisc: [3, 2.6, 2], sunBloom: Z,
      cloudLitFar: [0.055, 0.065, 0.1], cloudLitMid: [0.06, 0.07, 0.105], cloudLitSun: [0.065, 0.075, 0.11],
      cloudShadeFar: [0.01, 0.013, 0.026], cloudShadeSun: [0.011, 0.014, 0.027], cloudRim: Z,
      sunLight: [0.22, 0.3, 0.5], skyLight: [0.075, 0.1, 0.19], glowTint: [0.05, 0.07, 0.12],
      stars: 1, starSide: 0, mw: 1, nebula: 0, aurora: 0,
    },
    { // сумерки
      zenithFar: [0.006, 0.014, 0.06], zenithSun: [0.012, 0.03, 0.12], bandFar: [0.02, 0.035, 0.11], bandSun: [0.1, 0.1, 0.22],
      horizonFar: [0.045, 0.06, 0.14], horizonSun: [0.6, 0.27, 0.1],
      glowWide: m([0.9, 0.4, 0.15], 0.25), glowHalo: Z, glowHorizon: m([1, 0.45, 0.12], 0.3), sunDisc: [3, 2.6, 2], sunBloom: Z,
      cloudLitFar: [0.1, 0.11, 0.2], cloudLitMid: [0.3, 0.2, 0.26], cloudLitSun: [0.85, 0.38, 0.2],
      cloudShadeFar: [0.018, 0.024, 0.055], cloudShadeSun: [0.06, 0.045, 0.075], cloudRim: m([1, 0.55, 0.3], 0.5),
      sunLight: [0.28, 0.24, 0.26], skyLight: [0.15, 0.2, 0.36], glowTint: [0.22, 0.18, 0.14],
      stars: 0.8, starSide: 0.6, mw: 0.5, nebula: 0, aurora: 0,
    },
    { // закат
      zenithFar: [0.025, 0.07, 0.24], zenithSun: [0.05, 0.13, 0.38], bandFar: [0.2, 0.18, 0.36], bandSun: [0.7, 0.4, 0.28],
      horizonFar: [0.26, 0.3, 0.46], horizonSun: [1.0, 0.45, 0.1],
      glowWide: m([1, 0.5, 0.12], 0.4), glowHalo: m([1, 0.7, 0.3], 0.45), glowHorizon: m([1, 0.45, 0.08], 0.35),
      sunDisc: m([1, 0.8, 0.45], 3.2), sunBloom: m([1, 0.72, 0.35], 1),
      cloudLitFar: [0.42, 0.38, 0.5], cloudLitMid: [0.92, 0.5, 0.38], cloudLitSun: [1, 0.62, 0.22],
      cloudShadeFar: [0.07, 0.09, 0.17], cloudShadeSun: [0.24, 0.13, 0.14], cloudRim: m([1, 0.72, 0.35], 1.3),
      sunLight: [1.0, 0.64, 0.32], skyLight: [0.3, 0.38, 0.56], glowTint: [1, 0.82, 0.32],
      stars: 0.12, starSide: 1, mw: 0, nebula: 0, aurora: 0,
    },
    { // золотой час
      zenithFar: [0.04, 0.14, 0.5], zenithSun: [0.06, 0.18, 0.56], bandFar: [0.2, 0.34, 0.7], bandSun: [0.55, 0.52, 0.6],
      horizonFar: [0.46, 0.56, 0.76], horizonSun: [1.0, 0.76, 0.46],
      glowWide: m([1, 0.75, 0.4], 0.25), glowHalo: m([1, 0.85, 0.55], 0.5), glowHorizon: m([1, 0.7, 0.3], 0.15),
      sunDisc: m([1, 0.92, 0.72], 3.4), sunBloom: m([1, 0.9, 0.65], 1.1),
      cloudLitFar: [0.9, 0.86, 0.86], cloudLitMid: [1, 0.86, 0.72], cloudLitSun: [1, 0.9, 0.66],
      cloudShadeFar: [0.24, 0.3, 0.46], cloudShadeSun: [0.44, 0.34, 0.36], cloudRim: m([1, 0.92, 0.7], 1),
      sunLight: [1.12, 0.92, 0.63], skyLight: [0.42, 0.54, 0.78], glowTint: [1.15, 1.04, 0.48],
      stars: 0, starSide: 1, mw: 0, nebula: 0, aurora: 0,
    },
    { // день
      zenithFar: [0.045, 0.19, 0.66], zenithSun: [0.05, 0.2, 0.68], bandFar: [0.17, 0.4, 0.86], bandSun: [0.19, 0.42, 0.86],
      horizonFar: [0.5, 0.68, 0.9], horizonSun: [0.58, 0.73, 0.92],
      glowWide: Z, glowHalo: m([1, 0.97, 0.9], 0.45), glowHorizon: Z,
      sunDisc: m([1, 0.98, 0.94], 3.6), sunBloom: m([1, 0.97, 0.9], 1.2),
      cloudLitFar: [1, 1, 1], cloudLitMid: [1, 1, 1], cloudLitSun: [1, 1, 0.98],
      cloudShadeFar: [0.42, 0.5, 0.68], cloudShadeSun: [0.46, 0.52, 0.68], cloudRim: m([1, 1, 1], 0.5),
      sunLight: [1.3, 1.2, 1.04], skyLight: [0.58, 0.72, 1.02], glowTint: [1.5, 1.42, 0.75],
      stars: 0, starSide: 1, mw: 0, nebula: 0, aurora: 0,
    },
  ],
  // космическое: тёмно-бирюзовое и фиолетовое, туманность, ночью сияние
  cosmic: [
    { // ночь
      zenithFar: [0.001, 0.008, 0.016], zenithSun: [0.002, 0.009, 0.018], bandFar: [0.004, 0.022, 0.034], bandSun: [0.006, 0.024, 0.038],
      horizonFar: [0.012, 0.06, 0.075], horizonSun: [0.03, 0.05, 0.1],
      glowWide: Z, glowHalo: Z, glowHorizon: Z, sunDisc: [2.4, 3, 3], sunBloom: Z,
      cloudLitFar: [0.035, 0.1, 0.12], cloudLitMid: [0.06, 0.09, 0.15], cloudLitSun: [0.09, 0.08, 0.17],
      cloudShadeFar: [0.006, 0.018, 0.03], cloudShadeSun: [0.014, 0.014, 0.036], cloudRim: Z,
      sunLight: [0.16, 0.38, 0.44], skyLight: [0.06, 0.13, 0.19], glowTint: [0.04, 0.1, 0.11],
      stars: 1.25, starSide: 0, mw: 1.6, nebula: 0.7, aurora: 1,
    },
    { // сумерки
      zenithFar: [0.001, 0.014, 0.026], zenithSun: [0.01, 0.03, 0.07], bandFar: [0.008, 0.045, 0.065], bandSun: [0.16, 0.04, 0.26],
      horizonFar: [0.02, 0.1, 0.12], horizonSun: [0.6, 0.08, 0.36],
      glowWide: m([0.8, 0.12, 0.5], 0.3), glowHalo: Z, glowHorizon: m([1, 0.2, 0.5], 0.3), sunDisc: [2.4, 3, 3], sunBloom: Z,
      cloudLitFar: [0.05, 0.16, 0.19], cloudLitMid: [0.3, 0.1, 0.36], cloudLitSun: [0.85, 0.2, 0.5],
      cloudShadeFar: [0.008, 0.026, 0.045], cloudShadeSun: [0.06, 0.016, 0.1], cloudRim: m([1, 0.35, 0.7], 0.6),
      sunLight: [0.26, 0.18, 0.3], skyLight: [0.1, 0.2, 0.28], glowTint: [0.2, 0.12, 0.22],
      stars: 1.2, starSide: 0.5, mw: 1.4, nebula: 0.55, aurora: 0.4,
    },
    { // закат
      zenithFar: [0.002, 0.03, 0.05], zenithSun: [0.012, 0.085, 0.14], bandFar: [0.02, 0.11, 0.14], bandSun: [0.34, 0.08, 0.5],
      horizonFar: [0.04, 0.2, 0.24], horizonSun: [0.95, 0.15, 0.42],
      glowWide: m([0.9, 0.15, 0.5], 0.4), glowHalo: m([1, 0.5, 0.7], 0.45), glowHorizon: m([1, 0.2, 0.45], 0.3),
      sunDisc: m([1, 0.75, 0.85], 3.2), sunBloom: m([1, 0.6, 0.8], 1),
      cloudLitFar: [0.1, 0.3, 0.34], cloudLitMid: [0.62, 0.2, 0.62], cloudLitSun: [1, 0.4, 0.5],
      cloudShadeFar: [0.014, 0.04, 0.07], cloudShadeSun: [0.15, 0.03, 0.2], cloudRim: m([1, 0.55, 0.8], 1.3),
      sunLight: [0.95, 0.5, 0.62], skyLight: [0.2, 0.36, 0.46], glowTint: [0.9, 0.62, 0.5],
      stars: 1.1, starSide: 0.8, mw: 1.2, nebula: 0.4, aurora: 0,
    },
    { // золотой час
      zenithFar: [0.006, 0.07, 0.12], zenithSun: [0.02, 0.13, 0.2], bandFar: [0.03, 0.22, 0.28], bandSun: [0.36, 0.2, 0.6],
      horizonFar: [0.1, 0.36, 0.42], horizonSun: [0.9, 0.36, 0.62],
      glowWide: m([0.9, 0.3, 0.6], 0.3), glowHalo: m([1, 0.7, 0.85], 0.5), glowHorizon: m([1, 0.35, 0.6], 0.2),
      sunDisc: m([1, 0.88, 0.95], 3.3), sunBloom: m([1, 0.8, 0.92], 1.1),
      cloudLitFar: [0.4, 0.72, 0.74], cloudLitMid: [0.78, 0.6, 0.86], cloudLitSun: [1, 0.72, 0.8],
      cloudShadeFar: [0.04, 0.12, 0.2], cloudShadeSun: [0.24, 0.1, 0.36], cloudRim: m([1, 0.8, 0.95], 1),
      sunLight: [1.05, 0.8, 0.82], skyLight: [0.32, 0.52, 0.64], glowTint: [1.05, 0.94, 0.58],
      stars: 0.7, starSide: 0.9, mw: 0.8, nebula: 0.24, aurora: 0,
    },
    { // день
      zenithFar: [0.008, 0.1, 0.19], zenithSun: [0.01, 0.11, 0.2], bandFar: [0.04, 0.3, 0.4], bandSun: [0.06, 0.32, 0.42],
      horizonFar: [0.42, 0.3, 0.72], horizonSun: [0.52, 0.34, 0.74],
      glowWide: Z, glowHalo: m([0.8, 0.95, 1], 0.5), glowHorizon: Z,
      sunDisc: m([0.9, 1, 1], 3.5), sunBloom: m([0.85, 0.97, 1], 1.2),
      cloudLitFar: [0.8, 0.97, 0.96], cloudLitMid: [0.84, 0.96, 0.97], cloudLitSun: [0.9, 0.96, 1],
      cloudShadeFar: [0.2, 0.16, 0.5], cloudShadeSun: [0.26, 0.17, 0.52], cloudRim: m([0.9, 1, 1], 0.5),
      sunLight: [1.15, 1.2, 1.1], skyLight: [0.46, 0.7, 0.86], glowTint: [1.25, 1.42, 0.8],
      stars: 0.45, starSide: 1, mw: 0.5, nebula: 0.14, aurora: 0,
    },
  ],
};
const STYLE_IDS = Object.keys(STYLES);
// цвет луны и её ореола по стилю
const MOON = { pink: [1.0, 0.9, 0.96], gold: [1.0, 0.9, 0.72], blue: [0.92, 0.95, 1.0], cosmic: [0.68, 1.0, 0.93] };

// ---- сезоны: цвета травы (сизо-зелёная ↔ жёлто-зелёная), сухая, «глубина» под травой и доли
const SEASONS = {
  spring: { lushA: [0.026, 0.12, 0.022], lushB: [0.085, 0.185, 0.02], dry: [0.12, 0.16, 0.04], depthA: [0.024, 0.05, 0.012], depthB: [0.05, 0.076, 0.016], dryStep: 1.01, dryPatch: 0.3, flowers: 1, leaves: 0 },
  summer: { lushA: [0.03, 0.095, 0.02], lushB: [0.09, 0.14, 0.022], dry: [0.16, 0.13, 0.05], depthA: [0.022, 0.044, 0.012], depthB: [0.048, 0.068, 0.017], dryStep: 0.94, dryPatch: 1, flowers: 0, leaves: 0 },
  autumn: { lushA: [0.085, 0.085, 0.018], lushB: [0.23, 0.14, 0.02], dry: [0.21, 0.09, 0.025], depthA: [0.04, 0.036, 0.012], depthB: [0.072, 0.052, 0.016], dryStep: 0.58, dryPatch: 1.7, flowers: 0, leaves: 1 },
  winter: { lushA: [0.08, 0.078, 0.04], lushB: [0.15, 0.125, 0.055], dry: [0.13, 0.105, 0.06], depthA: [0.04, 0.036, 0.022], depthB: [0.06, 0.052, 0.028], dryStep: 0.42, dryPatch: 1.5, flowers: 0, leaves: 0.2 },
};
const SEASON_IDS = Object.keys(SEASONS);

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const DEG = 180 / Math.PI;
// один канал цвета неба у горизонта: сторона солнца, свечение, туман, мягкий потолок яркости — как в шейдере неба
const horizonChannel = (far, sunSide, k, glow, fog, veil) => {
  const sky = far + (sunSide - far) * k + glow;
  const veiled = sky + (fog - sky) * veil;
  return Math.min(veiled, 0.8) + 0.2 * (1 - Math.exp(-Math.max(veiled - 0.8, 0) * 5));
};
// Состояние по умолчанию (atmosphere.js: погода partlyCloudy) — при нём картинка ровно прежняя:
export const CLOUD_COVER_TODAY = 0.35; // cloudCover, при котором облака те же, что были
const CLOUD_DARK_TODAY = 0.05; // cloudDark, ниже которого облака не темнеют
const VISIBILITY_TODAY = 16000; // видимость, с которой тумана погоды нет (только прежняя дымка у горизонта)

// запасное состояние: то, как игра выглядела до погоды (закат справа, лето, розовое небо)
export function makeDefaultNow(THREE) {
  const now = {
    hour: 19.5,
    sunDir: new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 2.2), THREE.MathUtils.degToRad(90 - 8)),
    moonDir: new THREE.Vector3(-0.72, 0.5, 0.48).normalize(),
    sunElev: 2.2,
    day: 0.5,
    sunColor: new THREE.Color(1, 0.58, 0.28),
    ambientColor: new THREE.Color(0.3, 0.34, 0.48),
    sunPower: 1,
    ambientPower: 1,
    cloudCover: CLOUD_COVER_TODAY,
    cloudDark: CLOUD_DARK_TODAY,
    sunDirect: 1,
    fog: 0.03,
    visibilityM: VISIBILITY_TODAY,
    fogColor: new THREE.Color(0.5, 0.5, 0.55),
    wind: 0.3,
    windDir: new THREE.Vector2(1, 0.3).normalize(),
    gust: 0,
    rain: 0, snow: 0, hail: 0, sleet: 0, dust: 0, smoke: 0, leaves: 0,
    wet: 0, puddles: 0, snowCover: 0,
    lightning: 0, flash: 0, rainbow: 0,
    spring: 0, summer: 1, autumn: 0, winter: 0,
    sky: { pink: 1, gold: 0, blue: 0, cosmic: 0 },
    // для проверок из vr:eval: высота и азимут солнца в градусах (азимут: 0 — справа +X, плюс — к +Z)
    sun(elevDeg, azDeg = 8) {
      const e = elevDeg / DEG;
      const a = azDeg / DEG;
      now.sunDir.set(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a));
      now.sunElev = elevDeg;
      // луна напротив солнца, но не ниже 25° над горизонтом, когда солнце под ним
      const me = Math.max(-elevDeg, elevDeg < 0 ? 25 : -60) / DEG;
      now.moonDir.set(-Math.cos(me) * Math.cos(a + 0.5), Math.sin(me), -Math.cos(me) * Math.sin(a + 0.5));
      now.day = smooth(-8, 8, elevDeg);
      return now;
    },
  };
  return now;
}

export function createSkyLook(THREE) {
  // палитры в плоские массивы: [стиль][ключ] → N чисел
  const packed = {};
  for (const id of STYLE_IDS) {
    const arr = new Float32Array(KEY_ELEV.length * N);
    STYLES[id].forEach((key, k) => {
      COLORS.forEach((name, i) => arr.set(key[name], k * N + i * 3));
      SCALARS.forEach((name, i) => { arr[k * N + COLORS.length * 3 + i] = key[name]; });
    });
    packed[id] = arr;
  }
  const mix = new Float32Array(N);
  const C = () => new THREE.Color();
  const look = {
    // --- небо
    sunDir: new THREE.Vector3(1, 0.04, -0.14).normalize(),
    sunFlat: new THREE.Vector2(1, 0),
    moonDir: new THREE.Vector3(-0.7, 0.5, 0.5).normalize(),
    moonColor: C(), moonGlow: C(),
    cloudSun: new THREE.Vector3(1, 0.35, 0).normalize(),
    cloudP: new THREE.Vector4(0, 0, 0.92, 0), // x — сдвиг толщины (меньше/больше облаков), y — доля шума-заполнения, z — насколько облако гасит солнце
    nightP: new THREE.Vector4(1, 1, 1, 0), // x — звёзды, y — «только на тёмной стороне», z — Млечный Путь, w — туманность
    mwColor: C(),
    veilColor: C(), // цвет тумана / пелены осадков
    veilP: new THREE.Vector4(0, 12, 0, 0), // x — сколько пелены у горизонта, y — спад с высотой, z — радуга, w — сияние
    flashP: new THREE.Vector4(0, 0.5, -0.85, 0), // xyz — где в небе вспышка, w — яркость
    cloudWind: new THREE.Vector2(0, 0), // сдвиг облаков за кадр, в высотах слоя
    // --- земля и трава
    hazeWarmG: C(), hazeCoolG: C(), // горизонт для земли (уже с туманом)
    lightDir: new THREE.Vector3(1, 0.04, 0.14).normalize(), // к светилу, которое сейчас светит: солнце, ночью луна
    grassSun: new THREE.Vector3(1, 0.18, 0).normalize(),
    hillSun: new THREE.Vector3(1, 0.45, 0).normalize(),
    lightP: new THREE.Vector4(0.9, 0.41, 0, 0), // x — сила света на склонах, y — доля света на ровном, z — блеск мокрой травы, w — сила запечённых теней травы
    hillAdd: C(),
    lushA: C(), lushB: C(), dryCol: C(), depthA: C(), depthB: C(),
    depthGain: new THREE.Color(1, 1, 1), // свет в глубине травы, в долях прежнего заката
    fogP: new THREE.Vector4(1 / 900, 0, 40, 0), // x — плотность закатной дымки, y — плотность тумана погоды, z — с какого расстояния дымка
    windDir: new THREE.Vector2(1, 0),
    windP: new THREE.Vector4(0, 0, 0, 0), // фазы: волна, её огибающая, трепет медленный и быстрый
    windA: new THREE.Vector4(0.06, 0.07, 0.1, 0), // наклон, трепет, волна, «прижатость» к земле
    wetP: new THREE.Vector4(0, 0, 0, 0), // x — мокро, y — лужи, z — дождь (рябь), w — снег на земле
    snowCol: C(), skyRefl: C(), glint: C(),
    seasonP: new THREE.Vector4(0, 0, 0, 1), // x — цветы, y — листва, z — искры снега, w — сухие пятна
    seasonQ: new THREE.Vector4(0.94, 0, 0, 0), // x — порог сухой травинки
    shadeP: new THREE.Vector4(0, 1, 0, 0), // тени облаков на земле: сила, порог, две фазы
  };
  for (const name of COLORS) look[name] = C();
  const pub = {
    sunLight: C(), skyLight: C(), horizonSun: C(), horizonFar: C(), zenith: C(),
    horizon: C(), // горизонт в среднем по кругу — один цвет для тумана на предметах
    sunFlat: new THREE.Vector2(1, 0), // сторона солнца по горизонту (у зенита и глубокой ночью — к нулю)
    veil: 0, // 0..1: сколько в цвете горизонта тумана погоды (now.fogColor)
    lightDir: new THREE.Vector3(1, 0.3, 0).normalize(),
    night: 0, shadow: 1, snow: 0,
    // Цвет неба у самого горизонта в сторону (x, z) — ровно то, что рисует шейдер неба при высоте 0:
    // сторона солнца или обратная, свечение у солнца, туман. В него должен уходить предмет, чтобы
    // исчезнуть на фоне неба. Цвет линейный, «готовый для экрана» (как now.fogColor).
    horizonAt(x, z, out) {
      const len = Math.hypot(x, z) || 1;
      const dx = x / len;
      const dz = z / len;
      const s = clamp01((dx * look.sunFlat.x + dz * look.sunFlat.y) * 0.5 + 0.5);
      const near = dx * look.sunDir.x + dz * look.sunDir.z - 1;
      const wide = Math.exp(near * 3.5);
      const low = Math.exp(near * 8);
      const halo = Math.exp(near * 45);
      const k = s * s * s;
      const v = look.veilP.x;
      const { horizonFar: far, horizonSun: sunSide, glowWide: a, glowHorizon: b, glowHalo: c, veilColor: fog } = look;
      return out.setRGB(
        horizonChannel(far.r, sunSide.r, k, a.r * wide + b.r * low + c.r * halo, fog.r, v),
        horizonChannel(far.g, sunSide.g, k, a.g * wide + b.g * low + c.g * halo, fog.g, v),
        horizonChannel(far.b, sunSide.b, k, a.b * wide + b.b * low + c.b * halo, fog.b, v),
      );
    },
  };
  const litRef = C();
  const grey = C();
  const tmp = C();
  const moonTint = C();
  const lum = (c) => c.r * 0.3 + c.g * 0.55 + c.b * 0.15;
  const TAU = Math.PI * 2;
  let windAngle = null; // сглаженное направление ветра, радианы (первый кадр — сразу как в состоянии)
  // списки заранее: в кадре — только обычные циклы, без новых массивов и замыканий
  const colorList = COLORS.map((name) => look[name]);
  const SCALAR_AT = COLORS.length * 3; // в mix: stars, starSide, mw, nebula, aurora
  const styleArrays = STYLE_IDS.map((id) => packed[id]);
  const styleWeights = new Float32Array(STYLE_IDS.length);
  const moonTints = STYLE_IDS.map((id) => MOON[id]);
  const seasonList = SEASON_IDS.map((id) => SEASONS[id]);
  const litSet = [look.cloudLitFar, look.cloudLitMid, look.cloudLitSun];
  const shadeSet = [look.cloudShadeFar, look.cloudShadeSun];
  const lowSky = [look.horizonFar, look.horizonSun, look.bandFar, look.bandSun];
  const highSky = [look.zenithFar, look.zenithSun];
  const glowSet = [look.glowWide, look.glowHalo, look.glowHorizon, look.cloudRim, look.sunBloom];
  const warmSet = [look.horizonSun, look.bandSun, look.glowWide, look.glowHorizon, look.cloudLitSun, look.cloudLitMid, look.cloudRim, look.sunLight];
  const grassSet = [look.lushA, look.lushB, look.dryCol, look.depthA, look.depthB];

  // палитра по высоте солнца и весам стилей → look.<цвета> и mix[SCALAR_AT…]
  const blend = (elev, sky) => {
    let k = 0;
    while (k < KEY_ELEV.length - 2 && elev > KEY_ELEV[k + 1]) k += 1;
    let t = clamp01((elev - KEY_ELEV[k]) / (KEY_ELEV[k + 1] - KEY_ELEV[k]));
    t = t * t * (3 - 2 * t);
    let total = 0;
    for (let s = 0; s < STYLE_IDS.length; s += 1) {
      styleWeights[s] = Math.max(0, sky?.[STYLE_IDS[s]] ?? 0);
      total += styleWeights[s];
    }
    if (total < 1e-4) {
      styleWeights.fill(0);
      styleWeights[0] = 1; // без весов — розовое
      total = 1;
    }
    mix.fill(0);
    const a = k * N;
    const b = a + N;
    for (let s = 0; s < STYLE_IDS.length; s += 1) {
      const w = styleWeights[s] / total;
      styleWeights[s] = w;
      if (w <= 0) continue;
      const arr = styleArrays[s];
      for (let i = 0; i < N; i += 1) mix[i] += w * (arr[a + i] + (arr[b + i] - arr[a + i]) * t);
    }
    for (let i = 0; i < colorList.length; i += 1) colorList[i].setRGB(mix[i * 3], mix[i * 3 + 1], mix[i * 3 + 2]);
  };

  return {
    look,
    pub,
    update(now, dt) {
      const sun = now.sunDir;
      const elev = Math.asin(Math.max(-1, Math.min(1, sun.y))) * DEG;
      blend(elev, now.sky);
      const stars = mix[SCALAR_AT];
      const starSide = mix[SCALAR_AT + 1];
      const milkyWay = mix[SCALAR_AT + 2];
      const nebula = mix[SCALAR_AT + 3];
      const aurora = mix[SCALAR_AT + 4];
      moonTint.setRGB(0, 0, 0);
      for (let s = 0; s < STYLE_IDS.length; s += 1) {
        const w = styleWeights[s];
        moonTint.r += moonTints[s][0] * w;
        moonTint.g += moonTints[s][1] * w;
        moonTint.b += moonTints[s][2] * w;
      }
      // утро: низкое солнце розовее и чище, чем на закате (рассвет — не закат задом наперёд)
      const hour = now.hour ?? 18;
      const morning = hour < 12 ? smooth(0, 2.5, hour) * (1 - smooth(9.5, 12, hour)) * (1 - smooth(10, 32, Math.abs(elev))) * 0.6 : 0;
      if (morning > 0.001) {
        for (let i = 0; i < warmSet.length; i += 1) {
          const c = warmSet[i];
          c.setRGB(c.r * (1 - 0.08 * morning), c.g * (1 - 0.03 * morning), c.b * (1 + 0.5 * morning) + 0.03 * morning * c.r);
        }
      }

      // ---------- светила
      look.sunDir.copy(sun);
      const flat = Math.hypot(sun.x, sun.z);
      // сторона солнца: единичная, пока солнце невысоко; к зениту и глубокой ночью сходит на нет (небо ровное)
      const side = (1 / Math.max(flat, 0.35)) * smooth(-40, -18, elev);
      look.sunFlat.set(sun.x * side, sun.z * side);
      const moon = now.moonDir;
      if (moon) look.moonDir.copy(moon);
      else look.moonDir.set(-sun.x, Math.max(0.3, -sun.y), -sun.z).normalize();
      const night = 1 - smooth(-12, -3, elev);
      const moonElev = Math.asin(Math.max(-1, Math.min(1, look.moonDir.y))) * DEG;
      const moonUp = smooth(-2, 6, moonElev);
      const phase = 0.5 * (1 - look.sunDir.dot(look.moonDir)); // 1 — полная (напротив солнца)
      const moonBright = 0.25 + 0.75 * phase;

      // ---------- погода в небе
      const cover = clamp01(now.cloudCover ?? CLOUD_COVER_TODAY);
      const dark = clamp01(((now.cloudDark ?? 0) - CLOUD_DARK_TODAY) / (1 - CLOUD_DARK_TODAY));
      const ov = smooth(0.5, 0.95, cover); // доля сплошной пелены
      const direct = clamp01(now.sunDirect ?? 1 - ov);
      if (cover <= CLOUD_COVER_TODAY) {
        // меньше обычного: облака карты тают
        look.cloudP.x = -(1 - cover / CLOUD_COVER_TODAY) * 1.05;
        look.cloudP.y = 0;
      } else {
        // больше обычного: между облаками карты шум дорисовывает пелену — сначала клочьями, потом сплошь
        const u = (cover - CLOUD_COVER_TODAY) / (1 - CLOUD_COVER_TODAY);
        const a = Math.min(1, u / 0.45);
        const b = clamp01((u - 0.45) / 0.55);
        look.cloudP.x = 0.26 * a + 0.6 * b;
        look.cloudP.y = 1.1 * a - 0.5 * b;
      }
      look.cloudP.z = 0.92 + 0.08 * Math.max(ov, dark);
      look.cloudP.w = 0.42 * ov + 0.2 * dark * ov;
      // пелена: облака сереют, с cloudDark — темнеют до грозовых; небо в просветах и у горизонта — туда же
      if (ov > 0 || dark > 0) {
        litRef.copy(look.cloudLitFar).lerp(look.cloudLitMid, 0.4);
        const l = lum(litRef);
        grey.setRGB(l * 0.96, l * 0.99, l * 1.08).lerp(litRef, 0.35).multiplyScalar(0.8 - 0.22 * ov); // светлая сторона пелены: сплошная — серее
        const keep = 1 - ov;
        const dim = 1 - 0.72 * dark;
        for (let i = 0; i < litSet.length; i += 1) litSet[i].lerp(grey, ov * 0.9).multiplyScalar(dim);
        tmp.copy(grey).multiplyScalar(0.42);
        for (let i = 0; i < shadeSet.length; i += 1) shadeSet[i].lerp(tmp, ov * 0.85).multiplyScalar(1 - 0.6 * dark);
        tmp.copy(grey).multiplyScalar(0.8 * dim);
        for (let i = 0; i < lowSky.length; i += 1) lowSky[i].lerp(tmp, ov * 0.85);
        for (let i = 0; i < highSky.length; i += 1) highSky[i].lerp(tmp, ov * 0.6);
        for (let i = 0; i < glowSet.length; i += 1) glowSet[i].multiplyScalar(keep * keep);
        look.sunDisc.multiplyScalar(keep);
      }
      // вспышка молнии: облака светятся изнутри
      const flash = Math.max(0, now.flash ?? 0);
      look.flashP.w = Math.min(flash, 2);

      // ---------- туман и пелена осадков
      const vis = Math.max(15, now.visibilityM ?? VISIBILITY_TODAY);
      const veil = vis >= VISIBILITY_TODAY ? 0 : clamp01(Math.log(VISIBILITY_TODAY / vis) / Math.log(VISIBILITY_TODAY / 250)) ** 0.85;
      if (now.fogColor) look.veilColor.copy(now.fogColor);
      else look.veilColor.copy(look.horizonFar).lerp(look.horizonSun, 0.3);
      if (flash > 0) {
        // пелена дождя вспыхивает вместе с облаками (иначе у горизонта молнию не видно)
        look.veilColor.r += 0.26 * flash;
        look.veilColor.g += 0.29 * flash;
        look.veilColor.b += 0.38 * flash;
      }
      look.veilP.x = veil;
      look.veilP.y = 13 * (1 - veil) ** 1.6 + 2.5 * dark * ov; // под грозовой тучей пелена дождя — внизу, над головой темно
      look.fogP.y = Math.max(0, 3.9 / vis - 3.9 / VISIBILITY_TODAY);
      look.hazeWarmG.copy(look.horizonSun).lerp(look.veilColor, veil);
      look.hazeCoolG.copy(look.horizonFar).lerp(look.veilColor, veil);
      // радуга — напротив солнца, пока оно невысоко; сияние — ночью в космическом небе, в просветах
      look.veilP.z = clamp01(now.rainbow ?? 0) * smooth(-1, 3, elev) * (1 - smooth(34, 42, elev));
      look.veilP.w = aurora * (1 - ov) * (1 - veil);

      // ---------- звёзды, Млечный Путь, туманность, луна
      const clearSky = (1 - ov) * (1 - veil * 0.85);
      look.nightP.set(stars * clearSky, starSide, milkyWay * clearSky, nebula * clearSky);
      look.mwColor.setRGB(0.032, 0.034, 0.05);
      look.moonColor.copy(moonTint).multiplyScalar((0.16 + 0.84 * night) * 1.7);
      look.moonGlow.copy(moonTint).multiplyScalar(night * moonBright * (1 - 0.8 * ov) * 0.22);

      // ---------- свет на траве и земле
      const useMoon = elev < KEY_SWITCH_ELEV;
      const light = useMoon ? look.moonDir : look.sunDir;
      const keyK = useMoon ? (1 - smooth(-10, -6, elev)) * moonUp * moonBright : smooth(-5, -1, elev); // к смене светила свет гаснет до нуля
      const directK = keyK * direct;
      // без прямого света небо отдаёт часть рассеянного; под грозовыми тучами темнее
      const l0 = lum(look.sunLight);
      const ls = lum(look.skyLight);
      grey.setRGB(ls * 0.97, ls, ls * 1.06);
      look.skyLight.lerp(grey, ov * 0.6).multiplyScalar((1 + 0.7 * (1 - direct) * (l0 / (l0 + ls + 1e-4))) * (1 - 0.5 * dark));
      look.sunLight.multiplyScalar(directK);
      look.glowTint.multiplyScalar((0.25 + 0.75 * direct) * keyK); // под облаками просвечивает слабее; у смены светила — ноль (направление меняется незаметно)
      if (flash > 0) {
        look.skyLight.r += 0.55 * flash;
        look.skyLight.g += 0.6 * flash;
        look.skyLight.b += 0.8 * flash;
      }
      look.lightDir.copy(light);
      look.grassSun.set(light.x, 0.18, light.z).normalize();
      look.hillSun.set(light.x, Math.max(light.y, 0.45), light.z).normalize();
      look.lightP.x = 0.9 * directK;
      look.lightP.y = look.hillSun.y;
      // тёплая добавка на склонах к солнцу и свет «глубины» под травой — в долях прежнего заката
      look.hillAdd.setRGB(look.sunLight.r * 0.03, look.sunLight.g * 0.0224, 0);
      look.depthGain.setRGB(
        (0.6 * look.skyLight.r + 0.25 * look.sunLight.r) / (0.6 * 0.3 + 0.25 * 1.0),
        (0.6 * look.skyLight.g + 0.25 * look.sunLight.g) / (0.6 * 0.34 + 0.25 * 0.58),
        (0.6 * look.skyLight.b + 0.25 * look.sunLight.b) / (0.6 * 0.48 + 0.25 * 0.28),
      );
      // небо над головой для луж и мокрой травы; блик светила
      const wet = clamp01(now.wet ?? 0);
      const puddles = clamp01(now.puddles ?? 0);
      const snow = clamp01(now.snowCover ?? 0);
      look.skyRefl.copy(look.zenithFar).lerp(look.zenithSun, 0.5).lerp(look.bandFar, 0.35);
      tmp.copy(look.cloudLitFar).lerp(look.cloudShadeFar, 0.45);
      look.skyRefl.lerp(tmp, Math.min(1, cover ** 0.7) * 0.85);
      look.wetP.set(wet, puddles, clamp01((now.rain ?? 0) + (now.sleet ?? 0) * 0.6 + (now.hail ?? 0) * 0.4), snow);
      look.lightP.z = wet;
      look.glint.copy(useMoon ? look.moonColor : look.sunDisc).multiplyScalar(0.3 * directK);
      // снег: белый под этим светом (не ярче почти белого — иначе теряется оттенок)
      tmp.setRGB(
        0.82 * (look.skyLight.r * 1.15 + look.sunLight.r * 0.55),
        0.86 * (look.skyLight.g * 1.15 + look.sunLight.g * 0.55),
        0.95 * (look.skyLight.b * 1.15 + look.sunLight.b * 0.55),
      );
      const top = Math.max(tmp.r, tmp.g, tmp.b);
      if (top > 0.9) tmp.multiplyScalar(0.9 / top);
      look.snowCol.copy(tmp);

      // ---------- сезоны
      let seasonTotal = 0;
      for (let i = 0; i < SEASON_IDS.length; i += 1) seasonTotal += Math.max(0, now[SEASON_IDS[i]] ?? 0);
      for (let i = 0; i < grassSet.length; i += 1) grassSet[i].setRGB(0, 0, 0);
      let dryStep = 0;
      let dryPatch = 0;
      let flowers = 0;
      let leaves = 0;
      for (let i = 0; i < SEASON_IDS.length; i += 1) {
        const w = seasonTotal > 1e-4 ? Math.max(0, now[SEASON_IDS[i]] ?? 0) / seasonTotal : SEASON_IDS[i] === 'summer' ? 1 : 0;
        if (w <= 0) continue;
        const s = seasonList[i];
        look.lushA.r += s.lushA[0] * w; look.lushA.g += s.lushA[1] * w; look.lushA.b += s.lushA[2] * w;
        look.lushB.r += s.lushB[0] * w; look.lushB.g += s.lushB[1] * w; look.lushB.b += s.lushB[2] * w;
        look.dryCol.r += s.dry[0] * w; look.dryCol.g += s.dry[1] * w; look.dryCol.b += s.dry[2] * w;
        look.depthA.r += s.depthA[0] * w; look.depthA.g += s.depthA[1] * w; look.depthA.b += s.depthA[2] * w;
        look.depthB.r += s.depthB[0] * w; look.depthB.g += s.depthB[1] * w; look.depthB.b += s.depthB[2] * w;
        dryStep += s.dryStep * w;
        dryPatch += s.dryPatch * w;
        flowers += s.flowers * w;
        leaves += s.leaves * w;
      }
      // мокрая трава темнее
      const wetDim = 1 - 0.26 * wet;
      for (let i = 0; i < grassSet.length; i += 1) grassSet[i].multiplyScalar(wetDim);
      look.seasonP.set(flowers * (1 - snow), leaves * (1 - snow * 0.9), snow * (0.25 + 0.75 * directK), dryPatch);
      look.seasonQ.x = dryStep;

      // ---------- ветер: облака, волны по полю, трава
      const wind = Math.max(0, now.wind ?? 0.3);
      const rel = wind / 0.3; // 1 — как было до погоды
      // Направление — сглаженное (за ~6 с, не быстрее 5°/с). now.windDir на порывах качается на ±12° за
      // секунду-две, а узоры поля (волны ветра, тени облаков) строятся в осях ветра и поворачиваются
      // вокруг центра мира: в 500 м такое качание — рывок полос на десятки метров. Сам наклон травы
      // идёт по тому же сглаженному направлению (сила порыва остаётся в размахе).
      const wd = now.windDir;
      if (wd && wd.x * wd.x + wd.y * wd.y > 1e-6) {
        const target = Math.atan2(wd.y, wd.x);
        if (windAngle === null) windAngle = target;
        else {
          const turn = ((((target - windAngle + Math.PI) % TAU) + TAU) % TAU) - Math.PI; // кратчайшей дорогой
          const cap = (5 / DEG) * dt;
          windAngle += Math.max(-cap, Math.min(cap, turn * (1 - Math.exp(-dt / 6))));
        }
        look.windDir.set(Math.cos(windAngle), Math.sin(windAngle));
      }
      // размах: порыв добавляет до 60 %; сильный ветер гнёт сильнее, но не растягивает травинку
      const push = rel * (1 + 0.6 * clamp01(now.gust ?? 0));
      const amp = Math.max(0.12, push <= 1 ? push : 1 + (Math.min(push, 6) - 1) * 0.5);
      look.windA.set(0.06 * amp ** 1.25, 0.07 * amp, 0.1 * amp, clamp01((amp - 1) / 2.5));
      // скорости — фазами (накапливаются), чтобы смена силы ветра не дёргала траву
      const waveRate = Math.min(3.2, 0.35 + 0.65 * rel);
      const flutter = Math.min(3, 0.5 + 0.5 * rel);
      look.windP.x = (look.windP.x + dt * waveRate) % TAU;
      look.windP.y = (look.windP.y + dt * 0.37 * waveRate) % TAU;
      look.windP.z = (look.windP.z + dt * 1.3 * flutter) % TAU;
      look.windP.w = (look.windP.w + dt * 2.9 * flutter) % TAU;
      // тени облаков на земле: в переменную облачность, при прямом солнце и не у самого горизонта
      // (на закате по умолчанию их нет — картинка прежняя); плывут по ветру ~8 м/с
      look.shadeP.x = 0.34 * direct * smooth(4, 25, elev) * smooth(0.1, 0.3, cover) * (1 - smooth(0.7, 1, cover));
      look.shadeP.y = 1.02 - cover * 0.85;
      look.shadeP.z = (look.shadeP.z + dt * 0.09 * Math.min(rel, 7)) % TAU;
      look.shadeP.w = (look.shadeP.w + dt * 0.021 * Math.min(rel, 7)) % TAU;
      const drift = 0.02 * Math.min(rel, 7) * dt;
      look.cloudWind.set(look.windDir.x * drift, look.windDir.y * drift);
      // облака освещены сбоку от низкого солнца, от высокого — сверху
      look.cloudSun.set(look.sunFlat.x, 0.35 + Math.max(0, sun.y - 0.1) * 1.6, look.sunFlat.y).normalize();

      // ---------- соседям
      pub.sunLight.copy(look.sunLight);
      pub.skyLight.copy(look.skyLight);
      pub.horizonSun.copy(look.hazeWarmG);
      pub.horizonFar.copy(look.hazeCoolG);
      pub.horizon.copy(look.hazeCoolG).lerp(look.hazeWarmG, 0.3125); // среднее по кругу от mix(far, sun, s³)
      pub.sunFlat.copy(look.sunFlat);
      pub.veil = veil;
      pub.zenith.copy(look.zenithFar).lerp(look.zenithSun, 0.5);
      pub.lightDir.copy(light);
      pub.night = night;
      pub.shadow = now.keyShadow ?? directK; // сила теней: та же, что у теней псов (atmosphere.js)
      pub.snow = snow;
    },
  };
}
