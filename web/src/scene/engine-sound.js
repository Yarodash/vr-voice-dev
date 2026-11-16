// Гул мотора машины, пока игрок за рулём: синтез (пила + синус октавой ниже через фильтр), тихо.
// Высота и громкость — от скорости и газа. Контекст и выход — общие, из sound.js
// (__sceneState.audioGraph). Нет контекста — молчит.
export function createEngineSound() {
  const graph = globalThis.__sceneState?.audioGraph;
  const c = graph?.context;
  if (!c || !graph.master) return { set() {}, stop() {} };
  if (c.state === 'suspended') c.resume().catch(() => {});
  const out = c.createGain();
  out.gain.value = 0;
  const filter = c.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 300;
  filter.Q.value = 0.8;
  const saw = c.createOscillator();
  saw.type = 'sawtooth';
  const sub = c.createOscillator();
  sub.type = 'sine';
  const sawGain = c.createGain();
  sawGain.gain.value = 0.45;
  const subGain = c.createGain();
  subGain.gain.value = 0.9;
  saw.connect(sawGain).connect(filter);
  sub.connect(subGain).connect(filter);
  filter.connect(out).connect(graph.master);
  saw.frequency.value = 36;
  sub.frequency.value = 18;
  saw.start();
  sub.start();
  out.gain.setTargetAtTime(0.03, c.currentTime, 0.3); // завёлся
  let stopped = false;
  let nextAt = 0;
  return {
    // speed — м/с (модуль), throttle — 0..1; не чаще раза в 50 мс
    set(speed, throttle) {
      if (stopped || c.currentTime < nextAt) return;
      nextAt = c.currentTime + 0.05;
      // «передачи»: обороты растут со скоростью и сбрасываются на переключении
      const gear = Math.min(4, Math.floor(speed / 7));
      const f = 34 + (speed - gear * 7) * 5 + gear * 6 + throttle * 14;
      const t = c.currentTime;
      saw.frequency.setTargetAtTime(f, t, 0.08);
      sub.frequency.setTargetAtTime(f / 2, t, 0.08);
      filter.frequency.setTargetAtTime(260 + throttle * 520 + speed * 12, t, 0.1);
      out.gain.setTargetAtTime(0.03 + throttle * 0.035 + Math.min(speed, 25) * 0.0008, t, 0.12);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      const t = c.currentTime;
      out.gain.cancelScheduledValues(t);
      out.gain.setTargetAtTime(0, t, 0.12);
      saw.stop(t + 0.8);
      sub.stop(t + 0.8);
      saw.onended = () => {
        try {
          out.disconnect();
        } catch {
          // уже отключён
        }
      };
    },
  };
}
