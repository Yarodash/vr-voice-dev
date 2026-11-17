// The shell: everything that must survive while the scene is being rewritten.
// It owns the renderer, the VR session, the microphone, the controller and the terminal panel.
// A change to this file (or anything it imports except the scene) reloads the whole page.
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '@xterm/xterm/css/xterm.css';
import * as THREE from 'three';
import { createBridge } from './bridge-client.js';
import { createControls } from './controls.js';
import { extractDraft, isTranscribing } from './draft.js';
import { createMessagePanel } from './message-panel.js';
import { createPointer } from './pointer.js';
import { createRadialMenu } from './radial-menu.js';
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
// MSAA 4x is on (XR projection layer, antialias: true). The frame is rendered at the panel's own
// resolution: supersampling it 1.3x (1.7x the pixels) cost too much to hold 120 Hz on Quest 3S.
// Must be set before the session starts.
renderer.xr.setFramebufferScaleFactor(1.0);

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
const rig = new THREE.Group(); // the player: camera and controllers (see recenterHere)
scene.add(rig);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ---------- entering VR ----------
async function enterVR() {
  if (renderer.xr.isPresenting) return;
  const session = await navigator.xr.requestSession('immersive-vr', {
    optionalFeatures: ['local-floor', 'bounded-floor', 'hand-tracking'], // hand-tracking: so that Quest does not draw its own hands over the controller (the page draws none)
  });
  await renderer.xr.setSession(session);
}

// Makes the place and heading the player has now the origin of the scene, as if the site had
// just been opened here. The camera and the controllers live in `rig`; three.js applies its
// transform on top of the headset pose, so moving the rig moves the player through the scene.
const STANDING_EYE_M = 1.6;
function recenterHere() {
  if (!renderer.xr.isPresenting) return 'не в VR';
  const head = renderer.xr.getCamera(); // position/quaternion: the head in the reference space
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(head.quaternion);
  // Heading and pitch of the head (no roll): lying down and looking up, the view still becomes
  // "straight ahead and level", as when the site was first opened standing.
  const yaw = Math.atan2(-forward.x, -forward.z);
  const pitch = Math.asin(THREE.MathUtils.clamp(forward.y, -1, 1));
  const heading = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  const here = new THREE.Matrix4().compose(head.position, heading, new THREE.Vector3(1, 1, 1));
  // the head ends up at standing eye height above the origin, facing -Z, level
  here
    .invert()
    .premultiply(new THREE.Matrix4().makeTranslation(0, STANDING_EYE_M, 0))
    .decompose(rig.position, rig.quaternion, rig.scale);
  saveRig();
  return 'готово';
}

// The rig transform survives page reloads (localStorage 'vr.rig'), so the world stays where it was
// relative to the room. Recentering happens only on request (ctx.recenter, the menu item) and once
// on the very first session, when nothing has been saved yet.
const RIG_KEY = 'vr.rig';
function saveRig() {
  try {
    localStorage.setItem(RIG_KEY, JSON.stringify({ p: rig.position.toArray(), q: rig.quaternion.toArray() }));
  } catch {}
}
let rigRestored = false;
try {
  const saved = JSON.parse(localStorage.getItem(RIG_KEY));
  if (saved && saved.p?.length === 3 && saved.q?.length === 4) {
    rig.position.fromArray(saved.p);
    rig.quaternion.fromArray(saved.q);
    rigRestored = true;
  }
} catch {}

// Only when there is no saved rig yet (the very first session): recenter once and save it.
// The first frames of a session have no valid pose yet, so wait a few.
let recenterPending = false;
let framesSinceStart = 0;
renderer.xr.addEventListener('sessionstart', () => {
  if (rigRestored) return;
  recenterPending = true;
  framesSinceStart = 0;
});

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
let transcribing = false; // the hidden terminal shows `Transcribing…`: the draft is not final yet
let awaitingAnswer = false; // the last phrase was sent and Claude has not answered yet (orange dot)
let userMessageId = null; // the pop-up that shows the phrase the user has just sent
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
    if (message.t === 'cancelled') { // the bridge dropped the phrase: it is not shown as sent either
      cancelFlashUntil = performance.now() + 1000;
      awaitingAnswer = false; // nothing was sent, so there is nothing to wait for
      if (userMessageId !== null) closeMessage(userMessageId); // its window, if it is still shown
    }
    if (message.t === 'eval') remoteConsole.run(message);
    if (message.t === 'say') {
      awaitingAnswer = false;
      addMessage({ id: message.id, text: message.text });
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
    screenshot: (options) => {
      screenshotFlashUntil = performance.now() + 1000; // the dot flashes violet: a screenshot is being taken
      return screenshotter.request(options);
    },
    draft: draftText,
    recording: triggerPressed || releaseTimer !== null, // true while the user is dictating: do not touch the shell then
    messages: shown, // the messages shown now, newest first
    rig,
    recenter: recenterHere, // the current place and heading become the origin
    wheel, // the radial menu (open(menu), setStick(x, y), close()), and its test menu:
    menu: menuHolder, // menuHolder.menu: the menu the scene has set (setMenu)
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

const controls = createControls({
  renderer,
  scene: rig,
  onPtt,
  onAction,
  onStick: (x, y) => wheel.setStick(x, y),
  getMapper: () => mapperHolder.mapper,
  hitTest: () => pointer.action,
});
// The scene may point the ray that presses the on-screen buttons along its own object (its -Z
// axis from its position): `ctx.pointerAim.object = someObject3D`, null to go back to the
// controller's own ray. Used to make the ray follow the green axis drawn on the controller.
const pointerAim = { object: null };
// The radial menu is defined by the scene (`ctx.setMenu(menu)`, see scene/menu.js), so that adding
// or changing items hot-swaps the scene and does not reload the page. Empty until the scene sets it.
const menuHolder = { menu: { title: 'Меню', items: [] } };
// Which button does what is also set by the scene (`ctx.setMapper`). Until it does, and if the
// scene cannot be loaded, controls.js falls back on the built-in map (control-mapper.js).
const mapperHolder = { mapper: null };
const sceneHost = new SceneHost(
  {
    THREE, root, scene, camera, renderer, pointerAim,
    getLeftController: () => controls.leftGrip,
    // the scene hands over the menu for the radial wheel: { title, items: [{ label, children? }] }
    setMenu: (menu) => {
      menuHolder.menu = menu;
    },
    // the scene sets how the HUD looks (see applyHud): the message windows and the colours of the dot
    setHud: (config) => applyHud(config),
    // the scene says which button does what: an object with step(nowMs, { buttons }) -> [actions]
    // (see scene/controls-map.js); what the actions do ('record-start', 'wheel-toggle', ...) is
    // up to the page. What a swapped-out map knew about the buttons held down is carried over.
    setMapper: (mapper) => {
      if (mapperHolder.mapper?.previous) mapper.previous = [...mapperHolder.mapper.previous];
      mapperHolder.mapper = mapper;
    },
    // true while the radial menu is open: the grip then means "back", so the scene must not
    // let it grab things
    menuOpen: () => wheel.isOpen,
    // the current place and heading become the origin (and are remembered across reloads)
    recenter: () => recenterHere(),
  },
  reportScene,
);

const screenshotter = createScreenshotter({ renderer, scene, camera });

// Head-up display: fixed to the view, top right. A dot shows the trigger (grey — not pressed,
// green — pressed, speak); the answers from Claude pop up under it, one at a time.
const HUD = { x: 0.06, y: 0.2, distance: 0.8, messageWidth: 0.55 }; // metres, relative to the eyes
rig.add(camera); // so that things attached to the camera are drawn
const hud = new THREE.Group();
hud.position.set(HUD.x, HUD.y, -HUD.distance);
camera.add(hud);

// The radial menu (opens while Z, the stick click, is held): it hangs over the controller, tied to
// it, and turns to face the eyes (see placeWheel).
const WHEEL_WIDTH_M = 0.17; // the wheel lying on the controller (it is drawn 0.45 m wide)
const wheel = createRadialMenu({ renderer, widthM: 0.45, getMenu: () => menuHolder.menu });
wheel.mesh.scale.setScalar(WHEEL_WIDTH_M / 0.45);
scene.add(wheel.mesh);
const wheelAnchor = new THREE.Vector3();
const wheelQuat = new THREE.Quaternion();
const wheelScale = new THREE.Vector3();
const wheelEye = new THREE.Vector3();
const wheelDirection = new THREE.Vector3();
// The wheel's picture faces +Z with its top toward +Y; the controller's axes have blue (+Y) out of
// the face plate and green (-Z) forward. Laying the picture on the plate: -90 degrees about X
// makes its front look out along blue and its top point along green, so "stick forward" is the
// top sector.
// Then turned a further 45 degrees about the red axis (to the left: the positive direction), so
// the wheel tips toward the player: -90 + 45 = -45 degrees about X.
const WHEEL_FLAT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 4);
function placeWheel() {
  const anchor = pointerAim.object; // the axes sit in the middle of the face plate
  if (anchor) {
    anchor.updateWorldMatrix(true, false);
    anchor.matrixWorld.decompose(wheelAnchor, wheelQuat, wheelScale);
    wheel.mesh.position.copy(wheelAnchor);
    wheel.mesh.quaternion.copy(wheelQuat).multiply(WHEEL_FLAT); // tied to the controller: moves and turns with it
  } else {
    // no tracked controller: in front of the face, turned to the eyes
    camera.getWorldPosition(wheelEye);
    camera.getWorldDirection(wheelDirection);
    wheel.mesh.position.copy(wheelEye).addScaledVector(wheelDirection, 0.7);
    wheel.mesh.lookAt(wheelEye);
  }
}

const triggerDot = new THREE.Mesh(
  new THREE.CircleGeometry(0.014, 32),
  new THREE.MeshBasicMaterial({ color: 0x6b7280, toneMapped: false, depthTest: false }),
);
triggerDot.renderOrder = 1001;
// the dot stays where it always was (top right, 0.3 m + half a window from the middle), whatever
// HUD.x the window itself is moved to
const DOT_X = 0.3 + HUD.messageWidth / 2 - 0.014 - HUD.x;
triggerDot.position.set(DOT_X, 0.12, 0);
hud.add(triggerDot);

// The dot: grey — nothing; white — recording right now; blue — something is recorded and not
// sent yet; green for a second — it has just been sent; red for a second — the phrase was
// cancelled with the word "отмена" and dropped.
const DOT = {
  idle: 0x6b7280, waiting: 0xf97316, recording: 0xffffff, pending: 0x3b82f6, ready: 0x67e8f9, sent: 0x22c55e,
  cancelled: 0xef4444, screenshot: 0xa855f7,
};
let screenshotFlashUntil = 0;
let sentFlashUntil = 0;
let cancelFlashUntil = 0;
// Light blue: everything that was said is already text, nothing is still being recognised, so it
// can be sent at once. Plain blue: there is text, but the recognition has not finished yet.
function draftIsFinal(time) {
  return voiceState === 'idle' && releaseTimer === null && !transcribing && time - draftChangedAt >= SETTLE_MS;
}
function paintDot(time) {
  const color = time < screenshotFlashUntil ? DOT.screenshot
    : time < cancelFlashUntil ? DOT.cancelled
    : time < sentFlashUntil ? DOT.sent
      : triggerPressed ? DOT.recording
        : !draftText ? (awaitingAnswer ? DOT.waiting : DOT.idle)
          : draftIsFinal(time) ? DOT.ready : DOT.pending;
  triggerDot.material.color.set(color);
}
const LONG_PRESS_MS = 300; // the same as TAP_MS in the button map: from here a press of Y is a phrase
let pressStartedAt = 0;
let recordingLong = false; // the press has already lasted LONG_PRESS_MS
let draftBeforePress = ''; // what was already dictated and unsent when the press of Y began
function setTriggerPressed(pressed) {
  triggerPressed = pressed;
  if (pressed) draftBeforePress = draftText;
  pressStartedAt = performance.now();
  recordingLong = false;
  showMessage(); // the preview says "…" while a phrase is being recorded (once the press is long)
}

// The last few messages (answers from Claude and the phrases the user has sent), each in its own
// window. The newest is the lowest, where the single window used to be; the older ones are
// stacked above it, and the oldest get fainter. They stay until pushed off by newer ones, and are
// shown again after a page reload. How many, how faint, where: hudConfig, which the scene sets
// (`ctx.setHud`, scene/hud.js), so that changing it does not reload the page.
const POOL = 8; // windows that exist; hudConfig.maxShown of them are used
const hudConfig = {
  maxShown: 4,
  opacity: [1, 1, 0.7, 0.45], // by age: the newest first
  windowTopM: 0.0756, // the top edge of the newest window, in the HUD's space
  sideShift: 1 / 14, // the fraction of a window's width the windows are pushed aside by
  distanceM: HUD.distance, // how far from the eyes the HUD hangs; it is scaled so it looks the same size
  messageTtlS: 15, // a message disappears this long after it appeared (0: never); it counts as read
  occluded: false, // true: things nearer than the HUD (the pistol in the hand) cover it
};
const STORE_KEY = 'vr.messages';
const shown = []; // newest first
const messagePanels = Array.from({ length: POOL }, () => {
  const messagePanel = createMessagePanel({ renderer, widthM: HUD.messageWidth });
  hud.add(messagePanel.mesh);
  return messagePanel;
});

function saveShown() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(shown));
  } catch {
    // without storage the messages just do not survive a reload
  }
}

// Messages first; a warning from the page itself only when there is nothing to read.
function showMessage() {
  const list = (shown.length ? shown : warning ? [{ id: 'warning', text: warning, warning: true }] : [])
    .slice(0, hudConfig.maxShown);
  const typing = typingMessage(); // the unsent preview is the lowest window, over the messages
  const all = typing ? [typing, ...list] : list;
  messagePanels.forEach((messagePanel, index) => {
    messagePanel.show(all[index] ?? null);
    const age = typing ? index - 1 : index; // the messages fade by their own age; the preview does not
    const faint = hudConfig.opacity;
    const base = age < 0 ? 1 : (faint[age] ?? faint[faint.length - 1] ?? 1);
    messagePanel.setOpacity(base * (age < 0 ? 1 : (fadeOf.get(all[index]?.id) ?? 1)));
  });
}

// What the user is dictating right now and has not sent: shown as a light green window. While a
// phrase is being recorded but nothing is recognised yet it says "…".
function typingMessage() {
  if (draftText) return { id: 'draft', text: draftText, from: 'draft' };
  // a short press of Y is the menu, not a phrase: the "…" appears only once the press is long
  if (triggerPressed && recordingLong) return { id: 'draft', text: '…', from: 'draft' };
  return null;
}

// The scene sets how the HUD looks: { maxShown, opacity: [...], windowTopM, sideShift, dot: { idle,
// waiting, recording, pending, ready, sent, cancelled } } (any of them). Applied at once, no reload.
function applyHud(config = {}) {
  const { dot, ...rest } = config;
  // dotShiftM: сдвиг кружка по горизонтали в пространстве HUD (минус — левее), задаётся сценой
  if (typeof rest.dotShiftM === 'number') triggerDot.position.x = DOT_X + rest.dotShiftM;
  Object.assign(hudConfig, rest);
  if (dot) Object.assign(DOT, dot);
  hudConfig.maxShown = Math.max(1, Math.min(hudConfig.maxShown, POOL));
  while (shown.length > hudConfig.maxShown) bridge.send({ t: 'read', id: shown.pop().id });
  for (const messagePanel of messagePanels) messagePanel.setSideShift(hudConfig.sideShift);
  const k = hudConfig.distanceM / HUD.distance;
  hud.position.set(HUD.x * k, HUD.y * k, -hudConfig.distanceM);
  hud.scale.setScalar(k);
  // occluded: the windows behave like real objects in the world — they write depth and are drawn
  // before every transparent thing (smoke, sparks), so whatever is nearer covers them and whatever
  // is behind is hidden by them; the transparent corners are cut out (alphaTest) so they hide nothing.
  const real = Boolean(hudConfig.occluded);
  triggerDot.material.depthTest = real;
  for (const { mesh } of messagePanels) {
    mesh.material.depthTest = real;
    mesh.material.depthWrite = real;
    mesh.material.alphaTest = real ? 0.02 : 0;
    mesh.material.needsUpdate = true;
    mesh.renderOrder = real ? -10 : 1000;
  }
  saveShown();
  showMessage();
}

// The newest window keeps its place; every older one sits right above the one below it.
function layoutMessages() {
  const top = hudConfig.windowTopM + messagePanels[0].windowOffsetM; // the top edge of the newest panel
  let rest = top; // where the next older panel rests
  messagePanels.forEach((messagePanel, index) => {
    if (!messagePanel.mesh.visible) return;
    const height = messagePanel.heightM;
    if (index === 0) {
      messagePanel.mesh.position.y = top - height / 2;
    } else {
      messagePanel.mesh.position.y = rest + height / 2;
      rest += height;
    }
  });
}

// A new message is added at the bottom; the oldest of those above falls off (it counts as read).
function addMessage(message) {
  if (shown.some((m) => m.id === message.id)) return; // the bridge re-sends unread ones after a reconnect
  message.at = Date.now();
  shown.unshift(message);
  while (shown.length > hudConfig.maxShown) bridge.send({ t: 'read', id: shown.pop().id });
  saveShown();
  showMessage();
}

// Auto-hide: every message (not the unsent preview) fades out messageTtlS after it appeared.
const FADE_S = 0.5;
const fadeOf = new Map(); // id -> alpha multiplier while fading
function expireMessages() {
  const ttl = hudConfig.messageTtlS;
  const now = Date.now();
  let changed = false;
  for (let i = shown.length - 1; i >= 0; i--) {
    const m = shown[i];
    if (!(ttl > 0)) { fadeOf.delete(m.id); continue; }
    if (typeof m.at !== 'number') m.at = now;
    const left = (m.at + ttl * 1000 - now) / 1000;
    if (left <= 0) {
      fadeOf.delete(m.id);
      bridge.send({ t: 'read', id: shown.splice(i, 1)[0].id });
      changed = true;
    } else if (left < FADE_S) {
      fadeOf.set(m.id, left / FADE_S);
      changed = true;
    }
  }
  if (changed) { saveShown(); showMessage(); }
}
setInterval(expireMessages, 100);

// Takes one message off the screen by its id (a phrase the bridge dropped, a page warning).
function closeMessage(id) {
  const index = shown.findIndex((m) => m.id === id);
  if (index >= 0) {
    bridge.send({ t: 'read', id: shown.splice(index, 1)[0].id }); // so that it is not shown again after a reload
    saveShown();
  } else if (id === 'warning') {
    warning = '';
  }
  showMessage();
}

// After a reload the messages that were on screen come back.
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
  if (Array.isArray(saved)) {
    shown.push(...saved.filter((m) => m && typeof m.id === 'string' && typeof m.text === 'string' && !(hudConfig.messageTtlS > 0 && typeof m.at === 'number' && Date.now() - m.at > hudConfig.messageTtlS * 1000)).slice(0, hudConfig.maxShown));
  }
} catch {
  // unreadable storage: start with none
}
showMessage();

// The ray of the left controller presses the cross of the unsent preview (the light green window).
const pointer = createPointer({ scene, panels: messagePanels, aim: pointerAim });

// "Send" may be pressed while the last words are still being recognised. The text is sent only
// once the trigger is up, the bridge has finished the dictation and the text has stopped changing.
const SETTLE_MS = 500;
function sendWhenReady(time) {
  if (!sendRequested || triggerPressed || releaseTimer !== null || voiceState !== 'idle' || transcribing) return;
  if (time - draftChangedAt < SETTLE_MS) return;
  sendRequested = false;
  if (draftText) {
    bridge.send({ t: 'send', text: draftText }); // the bridge then empties the prompt
    sentFlashUntil = time + 1000;
    awaitingAnswer = true;
    userMessageId = `u${Date.now()}`;
    addMessage({ id: userMessageId, text: draftText, from: 'user' }); // shown with the mark "You"
  }
}

let lastFrame = 0;
renderer.setAnimationLoop((time) => {
  const dt = lastFrame ? Math.min((time - lastFrame) / 1000, 0.1) : 0;
  lastFrame = time;
  if (triggerPressed && !recordingLong && performance.now() - pressStartedAt >= LONG_PRESS_MS) {
    recordingLong = true;
    showMessage(); // a long press: it is a phrase, show the preview
  }
  if (recenterPending && renderer.xr.isPresenting && ++framesSinceStart > 10) {
    recenterPending = false;
    recenterHere();
    rigRestored = true;
  }
  controls.tick(time);
  // the ray is only needed while the unsent preview, with the cross that cancels it, is on screen
  const previewShown = typingMessage() !== null;
  // the ray goes along the controller's own pointing direction (not the scene's axes: aiming along
  // them needed the controller raised too high); pointerAim is still where the wheel sits
  const aim = controls.leftController;
  aim?.updateWorldMatrix(true, false);
  pointer.update(renderer.xr.isPresenting ? aim : null, previewShown);
  messagePanels[0].setHover(previewShown ? pointer.action : null); // the button under the ray lights up
  panel?.tick(time);
  if (panel && panel.version !== seenScreenVersion) {
    seenScreenVersion = panel.version;
    const rows = panel.readScreen();
    const text = extractDraft(rows, { cursor: panel.cursor });
    const nowTranscribing = isTranscribing(rows);
    if (nowTranscribing !== transcribing) {
      transcribing = nowTranscribing;
      if (!transcribing) draftChangedAt = time; // the settle time counts from the end of recognition
    }
    if (text !== draftText) {
      draftText = text;
      draftChangedAt = time;
      showMessage();
    }
  }
  sendWhenReady(time);
  paintDot(time);
  // at most one window repainted per frame: each repaint uploads a 1600×640 texture (~10 ms on
  // Quest), and repainting all of them in one frame used to stall it for ~100 ms
  for (const messagePanel of messagePanels) if (messagePanel.tick()) break;
  layoutMessages();
  if (wheel.isOpen) placeWheel();
  wheel.tick();
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
    sendRequested = true; // letting go of Y sends what was said, once the recognition has finished
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

// Actions come from the buttons of the controller ('send' is X, 'delete' is the grip, 'reload'
// is a long stick click; holding Y records, see controls.js) and from the ray pressing the
// cross of the message window ('close-message').
function onAction(action) {
  if (action === 'reload') {
    location.reload();
  } else if (action === 'send') {
    sendRequested = true; // sent once the recognition has finished (see sendWhenReady)
  } else if (action === 'delete') {
    // throw away what was recorded; with nothing recorded it does nothing (the grip is also used
    // to grab things in the scene, so it must not close the message; the cross does that)
    sendRequested = false;
    if (draftText) bridge.send({ t: 'key', k: 'clear' });
  } else if (action === 'record-cancel') {
    // A short press of "=" was a tap for the menu, not speech: drop the recording that had
    // started and anything it left in the hidden prompt (the stray text can arrive a moment later).
    sendRequested = false;
    // Only what the press itself recorded is thrown away. If a phrase was already waiting (dictated
    // earlier, not sent), it must survive opening the menu: nothing is cleared then.
    if (!draftBeforePress) {
      bridge.send({ t: 'key', k: 'clear' });
      setTimeout(() => bridge.send({ t: 'key', k: 'clear' }), 700);
    }
  } else if (action === 'send-draft') {
    // the button next to the unsent preview: send what is there as it is (after a reload the phrase
    // may already be waiting, and there is nothing left to say)
    sendRequested = true;
  } else if (action === 'cancel-draft') {
    // the cross next to the unsent preview: forget what was dictated
    sendRequested = false;
    bridge.send({ t: 'key', k: 'clear' });
  } else if (action === 'grip') {
    // the grip with the menu open closes it completely, from any submenu level (the scene ignores
    // that same press: it remembers the menu was open this frame)
    if (wheel.isOpen) wheel.close();
  } else if (action === 'wheel-toggle') {
    // A short press of Y: opens the menu; with the menu open it applies the chosen sector (a
    // submenu opens, an ordinary sector is picked; with nothing chosen the menu just closes).
    // The grip is "back", and closes the menu at the top level. The trigger does nothing here.
    if (!wheel.isOpen) {
      wheel.open(menuHolder.menu);
    } else {
      const picked = wheel.confirm();
      if (picked) {
        console.log(`[wheel] выбрано: ${picked.path.join(' > ')}`); // lands in logs/page-console.log
        sceneHost.instance?.onMenu?.(picked); // the scene does what the item means
      }
    }
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
