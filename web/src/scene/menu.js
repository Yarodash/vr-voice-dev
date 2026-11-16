// Радиальное меню на джойстике. Живёт в сцене, чтобы добавление и правка пунктов подхватывались
// на лету, без перезагрузки страницы (запись голоса и положение в мире не сбрасываются).
//
// Пункт: { label } или { label, children: [пункты] } (подменю). Что делает выбранный пункт,
// решает `onMenu(picked)` в main.js: picked = { path: ['Подменю', 'Пункт'], label: 'Пункт' }.
// Меню собирается заново, когда меняется состояние: что игрок держит (heldKind: 'pistol' | 'ak' |
// null), режим хвата.
export function buildMenu({ holdingPistol, heldKind = holdingPistol ? 'pistol' : null, gripMode, targetPhysics = true, aimOutline = true }) {
  const outlineItem = { label: aimOutline ? 'Обводка прицела: вкл' : 'Обводка прицела: выкл', keepOpen: true };
  const physicsItem = {
    label: 'Мишени',
    children: [{ label: targetPhysics ? 'Физика мишеней: вкл' : 'Физика мишеней: выкл', keepOpen: true }, outlineItem],
  };
  if (heldKind === 'plate') {
    // глиняная тарелка в руке: курок не стреляет, а взводит бросок (clays.js)
    return { title: 'Тарелка', items: [{ label: 'Удалить тарелку' }, physicsItem] };
  }
  if (heldKind) {
    // оружие в руке: перенастроить его посадку (оно замирает, джойстик переставляют, второй хват
    // приклеивает; у пистолета и калаша посадка своя) или убрать его совсем
    return { title: heldKind === 'ak' ? 'Калаш' : 'Пистолет', items: [{ label: 'Перенастроить оси' }, { label: 'Удалить оружие' }, physicsItem] };
  }
  // руки свободны: новое оружие (каждый раз ещё одно) и режим хвата (в подписи текущий режим)
  return {
    title: 'Меню',
    items: [
      { label: 'Заспавнить пистолет' },
      { label: 'Заспавнить калаш' },
      { label: 'Заспавнить тарелку' },
      { label: gripMode === 'hold' ? 'Хват: держать' : 'Хват: нажать' },
      physicsItem,
    ],
  };
}
