// Какая кнопка левого контроллера что делает. Живёт в сцене, чтобы перенос кнопок подхватывался
// на лету, без перезагрузки страницы (запись голоса и положение в мире не сбрасываются).
// Названия действий ('record-start', 'wheel-toggle', 'grip', ...) страница уже умеет; новые действия
// требуют правки страницы (оболочки). Если сцена не загрузилась, страница пользуется встроенной
// копией этой же карты (web/src/control-mapper.js).
//
// Left Touch controller (xr-standard gamepad) -> actions.
//   Y   pressed:                          'record-start' at once (the voice recording begins without waiting)
//       let go after a long press (>= TAP_MS):  'record-stop'
//       let go after a short press (< TAP_MS):  'record-cancel' (the recording is thrown away) and
//                                         'wheel-toggle' (the radial menu opens, or closes if open)
//       three quick presses (within 1 s):  'reload' (the first two were taps: the menu opened and closed)
//   grip                  'grip': "back" in the radial menu while it is open (the scene uses the
//                         grip to grab things the rest of the time, and leaves it alone then)
// X spawns a clay plate (read directly in main.js); "=" and Z (the stick click) are free. The trigger is not here: it clicks on-screen buttons
// through WebXR select events (and confirms a sector in the radial menu). A phrase is thrown
// away by ending it with "отмена".
const TAP_MS = 300; // a press of Y shorter than this is a tap: the menu, not a recording
const TRIPLE_PRESS_MS = 1000; // the three presses of Y must fit into this time (from the first)
const GRIP = 1;
const Y = 5;

export class ControlMap {
  // menuOpen(): открыто ли радиальное меню сейчас. Перезагрузка — только на жест «закрыто → открыто →
  // закрыто» (первые два нажатия открыли и закрыли меню). Иначе пункты-переключатели (keepOpen, например
  // «Время»), которые жмут Y несколько раз подряд при открытом меню, перезагружали страницу.
  constructor(menuOpen = () => false) {
    this.menuOpen = menuOpen;
    this.previous = [];
    this.yPressedAt = null;
    this.yPresses = [];
    this.yMenuAt = []; // было ли меню открыто в момент каждого из yPresses
    this.yIsReload = false; // the press that completed three: its release does nothing
  }

  step(nowMs, { buttons }) {
    const actions = [];
    const pressed = (index) => Boolean(buttons[index]);
    const rising = (index) => pressed(index) && !this.previous[index];
    const falling = (index) => !pressed(index) && Boolean(this.previous[index]);

    if (rising(Y)) {
      const keep = this.yPresses.map((at) => nowMs - at <= TRIPLE_PRESS_MS);
      this.yPresses = this.yPresses.filter((_, i) => keep[i]);
      this.yMenuAt = this.yMenuAt.filter((_, i) => keep[i]);
      this.yPresses.push(nowMs);
      this.yMenuAt.push(Boolean(this.menuOpen()));
      const m = this.yMenuAt;
      const gesture = m.length >= 3 && !m[m.length - 3] && m[m.length - 2] && !m[m.length - 1];
      if (gesture) {
        this.yPresses = [];
        this.yMenuAt = [];
        this.yIsReload = true;
        actions.push('reload');
      } else {
        this.yPressedAt = nowMs;
        actions.push('record-start');
      }
    }
    if (falling(Y)) {
      if (this.yIsReload) {
        this.yIsReload = false;
      } else {
        const heldMs = this.yPressedAt === null ? Infinity : nowMs - this.yPressedAt;
        if (heldMs < TAP_MS) actions.push('record-cancel', 'wheel-toggle');
        else actions.push('record-stop');
      }
      this.yPressedAt = null;
    }

    if (rising(GRIP)) actions.push('grip');

    this.previous = [...buttons];
    return actions;
  }
}
