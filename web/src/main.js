// The shell: everything that must survive while the scene is being rewritten.
// It owns the renderer, the VR session, the microphone, the controller and the terminal panel.
// A change to this file (or anything it imports except the scene) reloads the whole page.
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@xterm/xterm/css/xterm.css';
import * as THREE from 'three';
import { createBridge } from './bridge-client.js';
import { createControls } from './controls.js';
import { extractDraft } from './draft.js';
import { createMessagePanel } from './message-panel.js';
import { createMessageQueue } from './message-queue.js';
import { createPointer } from './pointer.js';
import { createMic } from './mic.js';
import { createRemoteConsole } from './remote-console.js';
import { SceneHost } from './scene-host.js';
import { createScreenshotter } from './screenshot.js';
import { createTerminalPanel } from './terminal-panel.js';

const statusEl = document.getElementById('status');
const enterButton = document.getElementById('enter-vr');
const pairInput = document.getElementById('pair');
const setStatus = (text) => {
  statusEl.textContent = text;
};

// ---------- renderer and the fixed part of the world ----------
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('gl'), antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local-floor');
// No fixed foveation. three.js asks for the maximum by default: the edges of the view are then
// rendered at a lower resolution, and thin lines there look brighter, with a visible border.
renderer.xr.setFoveation(0);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(0, 1.6, 0);
scene.add(new THREE.HemisphereLight(0xffffff, 0x334155, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(1.5, 3, 1);
scene.add(sun);
scene.add(new THREE.GridHelper(20, 40, 0x334155, 0x1e293b));

const root = new THREE.Group(); // the scene module's sandbox
scene.add(root);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- entering VR ----------
async function enterVR() {
  if (renderer.xr.isPresenting) return;
  const session = await navigator.xr.requestSession('immersive-vr', {
    optionalFeatures: ['local-floor', 'bounded-floor'],
  });
  await renderer.xr.setSession(session);
}

// Quest Browser fires this when the page is reloaded from inside VR: we may re-enter without a
// click. The listener has to exist before anything asynchronous happens in this module.
navigator.xr?.addEventListener('sessiongranted', () => {
  enterVR().catch((err) => setStatus(`не удалось вернуться в VR: ${err.message}`));
});

// ---------- bridge, terminal panel, scene ----------
let panel = null;
let voiceState = 'idle';
let seenScreenVersion = -1;

// What the user has dictated and not sent yet. It is not shown: the user remembers it.
let draftText = '';
let draftChangedAt = 0;
let sendRequested = false; // "send" was pressed; wait until the recognition has finished
let triggerPressed = false;

// Problems the user has to know about (no link to the PC, scene error, no microphone).
let warning = '';
function setNote(text) {
  panel?.setNote(text);
  warning = text ?? '';
  showMessage();
}
let lastSceneStatus = null;

const bridge = createBridge({
  getCode: () => localStorage.getItem('pairCode') ?? '',
  onBinary: (bytes) => panel?.write(bytes),
  onMessage(message) {
    if (message.t === 'hello') panel?.reset(); // the bridge replays the screen right after this
    if (message.t === 'hello' || message.t === 'voice') {
      voiceState = message.voice ?? message.state;
      panel?.setVoiceState(voiceState);
    }
    if (message.t === 'voice-error') setNote(`диктовка не сработала: ${message.error}`);
    if (message.t === 'eval') remoteConsole.run(message);
    if (message.t === 'say') {
      messages.push({ id: message.id, text: message.text });
      showMessage();
    }
  },
  onStatus(state) {
    pairInput.hidden = state === 'connected' || state === 'disconnected';
    if (state === 'connected') {
      setStatus('связь с ПК есть');
      remoteConsole.flush();
      if (lastSceneStatus) bridge.send({ t: 'scene', ...lastSceneStatus });
      showSceneNote();
    } else {
      const text = { 'need-code': 'введите код сопряжения', refused: 'нет связи с ПК или неверный код' }[state]
        ?? 'связь с ПК потеряна';
      setStatus(text);
      setNote(text);
    }
  },
});

// `npm run vr:eval` on the PC runs code here; console output and uncaught errors go to
// logs/page-console.log on the PC. These are the variables that code can use.
const remoteConsole = createRemoteConsole({
  send: (message) => bridge.send(message),
  isConnected: () => bridge.connected,
  scope: () => ({
    THREE,
    scene,
    root,
    camera,
    renderer,
    session: renderer.xr.getSession(),
    ctx: sceneHost.ctx,
    sceneHost,
    sceneInstance: sceneHost.instance,
    panel,
    mic,
    controls,
    // screenshot({ eyes: 'both' | 'left' | 'right', width }) -> a picture of what the headset shows
    screenshot: (options) => screenshotter.request(options),
    draft: draftText,
    messages,
  }),
});
remoteConsole.hookConsole();

function showSceneNote() {
  setNote(lastSceneStatus && !lastSceneStatus.ok ? `ошибка сцены: ${lastSceneStatus.error}` : '');
}

function reportScene(status) {
  lastSceneStatus = status;
  bridge.send({ t: 'scene', ...status });
  if (bridge.connected) showSceneNote();
}

const controls = createControls({ renderer, scene, onPtt, onAction, hitTest: () => pointer.action });
const sceneHost = new SceneHost(
  { THREE, root, scene, camera, renderer, getLeftController: () => controls.leftGrip },
  reportScene,
);

const screenshotter = createScreenshotter({ renderer, scene, camera });

// Head-up display: fixed to the view, top right. A dot shows the trigger (grey — not pressed,
// green — pressed, speak); the answers from Claude pop up under it, one at a time.
const HUD = { x: 0.3, y: 0.2, distance: 0.8, messageWidth: 0.55 }; // metres, relative to the eyes
scene.add(camera); // so that things attached to the camera are drawn
const hud = new THREE.Group();
hud.position.set(HUD.x, HUD.y, -HUD.distance);
camera.add(hud);

const triggerDot = new THREE.Mesh(
  new THREE.CircleGeometry(0.014, 32),
  new THREE.MeshBasicMaterial({ color: 0x6b7280, toneMapped: false, depthTest: false }),
);
triggerDot.renderOrder = 1001;
triggerDot.position.set(HUD.messageWidth / 2 - 0.014, 0.12, 0);
hud.add(triggerDot);

// Grey — trigger up, green — trigger down. For a second after X it is yellow ("sent"),
// after Y red ("deleted"), so that the buttons give some feedback.
let flashColor = null;
let flashTimer = null;
function paintDot() {
  triggerDot.material.color.set(flashColor ?? (triggerPressed ? 0x22c55e : 0x6b7280));
}
function setTriggerPressed(pressed) {
  triggerPressed = pressed;
  paintDot();
}
function flashDot(color) {
  flashColor = color;
  paintDot();
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashColor = null;
    paintDot();
  }, 1000);
}

const messages = createMessageQueue();
const messagePanel = createMessagePanel({ renderer, widthM: HUD.messageWidth });
hud.add(messagePanel.mesh);

// Answers from Claude first; a warning from the page itself only when there is nothing to read.
function showMessage() {
  if (messages.current) messagePanel.show(messages.current, messages.size - 1);
  else messagePanel.show(warning ? { text: warning, warning: true } : null);
}

function closeMessage() {
  const id = messages.close();
  if (id) bridge.send({ t: 'read', id }); // so that it is not shown again after a reload
  else warning = '';
  showMessage();
}

// The ray of the left controller presses the cross of the message window.
const pointer = createPointer({ scene, panels: [messagePanel] });

// "Send" may be pressed while the last words are still being recognised. The text is sent only
// once the trigger is up, the bridge has finished the dictation and the text has stopped changing.
const SETTLE_MS = 500;
function sendWhenReady(time) {
  if (!sendRequested || triggerPressed || releaseTimer !== null || voiceState !== 'idle') return;
  if (time - draftChangedAt < SETTLE_MS) return;
  sendRequested = false;
  if (draftText) bridge.send({ t: 'send', text: draftText }); // the bridge then empties the prompt
}

let lastFrame = 0;
renderer.setAnimationLoop((time) => {
  const dt = lastFrame ? Math.min((time - lastFrame) / 1000, 0.1) : 0;
  lastFrame = time;
  controls.tick(time);
  // the ray is only needed while there is a cross to press
  pointer.update(renderer.xr.isPresenting && messagePanel.mesh.visible ? controls.leftController : null);
  panel?.tick(time);
  if (panel && panel.version !== seenScreenVersion) {
    seenScreenVersion = panel.version;
    const text = extractDraft(panel.readScreen(), { cursor: panel.cursor });
    if (text !== draftText) {
      draftText = text;
      draftChangedAt = time;
    }
  }
  sendWhenReady(time);
  messagePanel.tick();
  sceneHost.update(dt);
  sceneHost.render(() => renderer.render(scene, camera));
  screenshotter.tick();
});

// Loaded dynamically so that a broken scene file cannot take the shell down with it: after a
// page reload the terminal and the voice input must still work, or the scene could not be fixed.
const SCENE_NOT_LOADED = 'сцена не загрузилась';
import('./scene/main.js').then(
  (module) => sceneHost.mount(module),
  (err) => reportScene({ ok: false, error: `${SCENE_NOT_LOADED}: ${err.message}` }),
);

if (import.meta.hot) {
  let viteErrorAt = 0;
  import.meta.hot.accept('./scene/main.js', (next) => {
    if (next) {
      sceneHost.swap(next);
    } else if (Date.now() - viteErrorAt > 2000) {
      // The browser could not load the new version (usually a syntax error); the old scene keeps
      // running. `npm run scene:check` adds the file and line. Keep the text in sync with it.
      reportScene({ ok: false, error: SCENE_NOT_LOADED });
    }
  });
  // Problems Vite itself finds, such as an import of a file that does not exist.
  import.meta.hot.on('vite:error', (payload) => {
    viteErrorAt = Date.now();
    reportScene({ ok: false, error: `${SCENE_NOT_LOADED}: ${payload?.err?.message ?? 'ошибка сборки'}` });
  });
}

// ---------- microphone and controller ----------
const mic = createMic();

// The last word is still travelling through the audio pipeline when the trigger is released.
const RELEASE_DELAY_MS = 150;
let releaseTimer = null;

function onPtt(down) {
  if (!down) {
    setTriggerPressed(false);
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      mic.stop();
      bridge.send({ t: 'ptt', down: false });
    }, RELEASE_DELAY_MS);
    return;
  }
  if (releaseTimer !== null) {
    clearTimeout(releaseTimer); // pressed again right away: it is still the same sentence
    releaseTimer = null;
    setTriggerPressed(true);
    return;
  }
  if (!mic.ready) {
    setNote('нет доступа к микрофону');
    mic.acquire().then(showSceneNote, () => {});
    return;
  }
  setTriggerPressed(true);
  bridge.send({ t: 'ptt', down: true });
  mic.start((frame) => bridge.sendBinary(frame.buffer));
}

// Actions come from the buttons of the controller ('enter' is X, 'esc' is Y, 'reload' is a long
// stick click) and from the ray pressing the cross of the message window ('close-message').
function onAction(action) {
  if (action === 'reload') {
    location.reload();
  } else if (action === 'enter') {
    sendRequested = true; // X: send what was dictated (see sendWhenReady) — and it is cleared
    // yellow only if there is something to send (or it is still being recognised)
    if (draftText || triggerPressed || releaseTimer !== null || voiceState !== 'idle') flashDot(0xfacc15);
  } else if (action === 'esc') {
    if (draftText) flashDot(0xef4444); // red only if there was something to delete
    // Y: throw away what was dictated; with nothing dictated it closes the message on screen
    sendRequested = false;
    if (draftText) bridge.send({ t: 'key', k: 'clear' });
    else closeMessage();
  } else if (action === 'close-message') {
    closeMessage();
  }
}

enterButton.addEventListener('click', async () => {
  try {
    await mic.acquire(); // first, while we are still in 2D and the permission prompt can be shown
  } catch (err) {
    setStatus(`микрофон недоступен: ${err.message}`);
  }
  try {
    await enterVR();
  } catch (err) {
    // Usually the click "expired" while the microphone prompt was open.
    setStatus(`нажмите «Войти в VR» ещё раз (${err.message})`);
  }
});

navigator.xr?.isSessionSupported('immersive-vr').then((supported) => {
  enterButton.disabled = !supported;
  if (!supported) enterButton.textContent = 'VR недоступен в этом браузере';
});
if (!navigator.xr) enterButton.textContent = 'VR недоступен в этом браузере';

// After an automatic return to VR there is no click to hang the microphone request on.
mic.acquireIfGranted().catch(() => {});

// ---------- pairing code ----------
function saveCode(code) {
  localStorage.setItem('pairCode', code.trim().toLowerCase());
  bridge.connect();
}
pairInput.addEventListener('input', () => {
  if (pairInput.value.trim().length === 8) saveCode(pairInput.value);
});
if (location.hash.length === 9) {
  // https://host:port/#code — handy on the PC; the code is kept and removed from the address bar
  localStorage.setItem('pairCode', location.hash.slice(1).toLowerCase());
  history.replaceState(null, '', location.pathname);
}

// ---------- terminal panel (needs fonts, so it arrives a moment later) ----------
// __TERMINAL__ is { cols, rows } from config.json, injected by vite.config.js.
panel = await createTerminalPanel({ ...__TERMINAL__, renderer, domParent: document.getElementById('term') });
// The terminal itself stays hidden: it is only read, the draft panel shows what matters.
// `panel.mesh.visible = true` (e.g. through vr:eval) brings it back for debugging.
panel.mesh.visible = false;
scene.add(panel.mesh);
bridge.connect();
