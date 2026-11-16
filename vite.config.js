import fs from 'node:fs';
import { defineConfig } from 'vite';

const cfg = JSON.parse(fs.readFileSync(new URL('./config.json', import.meta.url), 'utf8'));

// The certificate is created once by `python -m bridge.cert` (npm prestart) and never regenerated:
// the Quest browser's "proceed anyway" exception is tied to the certificate fingerprint.
const certFile = new URL('./certs/dev.pem', import.meta.url);
const keyFile = new URL('./certs/dev-key.pem', import.meta.url);
const https =
  fs.existsSync(certFile) && fs.existsSync(keyFile)
    ? { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
    : undefined;

export default defineConfig({
  root: 'web',
  // The page must build its terminal with the same size the bridge gives the pseudo-terminal.
  define: { __TERMINAL__: JSON.stringify(cfg.terminal) },
  server: {
    // Only the home-LAN address: this PC also has VPN interfaces that must not see the page.
    host: cfg.lan_host,
    port: cfg.web_port,
    strictPort: true,
    // The error overlay is DOM and invisible in VR; errors go to the terminal panel instead.
    hmr: { overlay: false },
    // Serve only the page and its dependencies. By default Vite would hand out the whole
    // project folder under /@fs/, including the pairing code in .vr/.
    fs: { allow: ['.', '../node_modules'] },
    https,
    proxy: {
      '/bridge': { target: `ws://127.0.0.1:${cfg.bridge_port}`, ws: true },
    },
  },
  // three is served as the plain ES modules it ships. Pre-bundling it would re-bundle (and
  // reload the page) the first time the scene imports something from three/addons.
  optimizeDeps: { exclude: ['three'] },
  test: {
    include: ['tests/**/*.test.js'],
  },
});
