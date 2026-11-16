// Screenshots of what the headset shows, taken on request from the PC
// (`npm run vr:shot`, or `screenshot()` inside `npm run vr:eval`).
//
// In VR the browser's own canvas is not what the user sees, so the scene is rendered once more
// into an off-screen target from each eye's camera, right after the normal frame.
import * as THREE from 'three';

const MAX_EYE_WIDTH = 2048;
const JPEG_QUALITY = 0.9;

// Linear -> sRGB lookup: an off-screen target is rendered in three's linear working space.
const SRGB = new Uint8Array(256);
for (let i = 0; i < 256; i += 1) {
  const c = i / 255;
  SRGB[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
}

// GPU read-back (rows bottom-up, linear colour) -> canvas pixels (rows top-down, sRGB, opaque).
export function toDisplayRows(pixels, width, height) {
  const out = new Uint8ClampedArray(width * height * 4);
  const stride = width * 4;
  for (let y = 0; y < height; y += 1) {
    let from = (height - 1 - y) * stride;
    let to = y * stride;
    for (let x = 0; x < width; x += 1, from += 4, to += 4) {
      out[to] = SRGB[pixels[from]];
      out[to + 1] = SRGB[pixels[from + 1]];
      out[to + 2] = SRGB[pixels[from + 2]];
      out[to + 3] = 255;
    }
  }
  return out;
}

// viewport: the eye's viewport as a THREE.Vector4 (z = width, w = height).
export function eyeSize(viewport, width) {
  const w = Math.max(16, Math.min(Math.round(width), MAX_EYE_WIDTH));
  return { width: w, height: Math.round((w * viewport.w) / viewport.z) };
}

async function toBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function createScreenshotter({ renderer, scene, camera }) {
  const shotCamera = new THREE.PerspectiveCamera();
  shotCamera.matrixAutoUpdate = false;
  shotCamera.matrixWorldAutoUpdate = false; // we copy the eye's matrices as they are
  let pending = [];

  function views(eyes, width) {
    const xrCameras = renderer.xr.isPresenting ? renderer.xr.getCamera().cameras : [];
    if (xrCameras.length < 2) {
      const size = renderer.getSize(new THREE.Vector2());
      return [{ name: 'экран', source: camera, ...eyeSize({ z: size.x, w: size.y }, width) }];
    }
    const wanted = eyes === 'left' ? [0] : eyes === 'right' ? [1] : [0, 1];
    return wanted.map((index) => ({
      name: index === 0 ? 'левый глаз' : 'правый глаз',
      source: xrCameras[index],
      ...eyeSize(xrCameras[index].viewport, width),
    }));
  }

  function renderView(view) {
    shotCamera.matrixWorld.copy(view.source.matrixWorld);
    shotCamera.matrixWorldInverse.copy(view.source.matrixWorld).invert();
    shotCamera.projectionMatrix.copy(view.source.projectionMatrix);
    shotCamera.projectionMatrixInverse.copy(view.source.projectionMatrix).invert();

    const target = new THREE.WebGLRenderTarget(view.width, view.height);
    const pixels = new Uint8Array(view.width * view.height * 4);
    const previousTarget = renderer.getRenderTarget();
    const xrWasEnabled = renderer.xr.enabled;
    try {
      // With XR "enabled" three ignores the camera and the target we pass and draws both eyes
      // into the headset; switching it off for one call makes this an ordinary off-screen render.
      renderer.xr.enabled = false;
      renderer.setRenderTarget(target);
      renderer.render(scene, shotCamera);
      renderer.readRenderTargetPixels(target, 0, 0, view.width, view.height, pixels);
    } finally {
      renderer.setRenderTarget(previousTarget);
      renderer.xr.enabled = xrWasEnabled;
      target.dispose();
    }
    return new ImageData(toDisplayRows(pixels, view.width, view.height), view.width, view.height);
  }

  async function capture({ eyes = 'both', width = 1024 } = {}) {
    const list = views(eyes, width);
    const canvas = document.createElement('canvas');
    canvas.width = list.reduce((sum, view) => sum + view.width, 0);
    canvas.height = Math.max(...list.map((view) => view.height));
    const g = canvas.getContext('2d');
    let x = 0;
    for (const view of list) {
      g.putImageData(renderView(view), x, 0);
      x += view.width;
    }
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    return {
      file: { ext: 'jpg', base64: await toBase64(blob) },
      note: `${list.map((view) => view.name).join(' + ')}, ${canvas.width}x${canvas.height}`,
    };
  }

  return {
    // options: { eyes: 'both' | 'left' | 'right', width: pixels per eye (default 1024) }
    // Resolves after the next rendered frame; never if the page is not rendering (headset asleep).
    request(options) {
      return new Promise((resolve, reject) => pending.push({ options, resolve, reject }));
    },

    // Call at the end of every frame, after the normal render.
    tick() {
      if (pending.length === 0) return;
      const requests = pending;
      pending = [];
      for (const { options, resolve, reject } of requests) capture(options).then(resolve, reject);
    },
  };
}
