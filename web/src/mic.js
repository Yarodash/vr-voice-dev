// Headset microphone -> 20 ms frames of 16-bit mono PCM at 48 kHz.
import { floatToInt16 } from './pcm.js';

const SAMPLE_RATE = 48000;

export function createMic() {
  let context = null;
  let ready = false;
  let pending = null;
  let onFrame = null;

  async function open() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    context = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    await context.audioWorklet.addModule('/pcm-worklet.js');
    const capture = new AudioWorkletNode(context, 'pcm-capture', { channelCount: 1, channelCountMode: 'explicit' });
    capture.port.onmessage = (event) => onFrame?.(floatToInt16(event.data));
    // A node is only processed while it leads to the destination, so route it there through silence.
    const silence = new GainNode(context, { gain: 0 });
    context.createMediaStreamSource(stream).connect(capture).connect(silence).connect(context.destination);
    ready = true;
  }

  return {
    get ready() {
      return ready;
    },
    get sampleRate() {
      return context?.sampleRate ?? null;
    },

    // Call from the "Enter VR" click, before requestSession: inside VR the browser may be
    // unable to show the permission prompt.
    acquire() {
      pending ??= open().catch((err) => {
        pending = null;
        throw err;
      });
      return pending;
    },

    // After an automatic re-entry into VR there is no click; only take the mic if it won't prompt.
    async acquireIfGranted() {
      const permission = await navigator.permissions.query({ name: 'microphone' });
      return permission.state === 'granted' ? this.acquire().then(() => true) : false;
    },

    start(callback) {
      onFrame = callback;
      context?.resume(); // allowed here: the trigger press counts as a user gesture
    },

    stop() {
      onFrame = null;
    },
  };
}
