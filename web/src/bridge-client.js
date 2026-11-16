// WebSocket to the bridge on the PC (through Vite's proxy, so it shares the page's origin and certificate).
const RETRY_MS = 1000;

export function createBridge({ getCode, onBinary, onMessage, onStatus }) {
  let socket = null;
  let open = false;
  let retry = null;

  function connect() {
    clearTimeout(retry);
    socket?.close();
    const code = getCode();
    if (!code) {
      onStatus('need-code');
      return;
    }
    const ws = new WebSocket(`wss://${location.host}/bridge?code=${encodeURIComponent(code)}`);
    ws.binaryType = 'arraybuffer';
    socket = ws;
    let everOpened = false;

    ws.onopen = () => {
      open = true;
      everOpened = true;
      onStatus('connected');
    };
    ws.onmessage = (event) => {
      if (typeof event.data === 'string') onMessage(JSON.parse(event.data));
      else onBinary(new Uint8Array(event.data));
    };
    ws.onclose = () => {
      if (socket !== ws) return; // replaced by a newer connection
      open = false;
      // A wrong pairing code and a stopped bridge look the same from here: the handshake fails.
      onStatus(everOpened ? 'disconnected' : 'refused');
      retry = setTimeout(connect, RETRY_MS);
    };
  }

  return {
    connect,
    get connected() {
      return open;
    },
    send(message) {
      if (open) socket.send(JSON.stringify(message));
    },
    sendBinary(buffer) {
      if (open) socket.send(buffer);
    },
  };
}
