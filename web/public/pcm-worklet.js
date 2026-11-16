// Runs on the audio thread: collects microphone samples into 20 ms frames (960 samples at 48 kHz)
// and posts them to the page. Kept in /public so it is served as-is.
const FRAME = 960;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Float32Array(FRAME);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      let offset = 0;
      while (offset < channel.length) {
        const take = Math.min(channel.length - offset, FRAME - this.filled);
        this.frame.set(channel.subarray(offset, offset + take), this.filled);
        this.filled += take;
        offset += take;
        if (this.filled === FRAME) {
          this.port.postMessage(this.frame.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
