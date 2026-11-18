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

// Scene edits must never reload the page (the headset loses the world, the voice draft, the battle).
// Vite reloads the whole page when an update reaches a module that nobody imports (a "dead end").
// Such orphans appear when code run through `npm run vr:eval` imports a scene file directly, e.g.
// `await import('/src/scene/x.js?v=' + Date.now())`: that copy and everything it pulls in hang in
// the module graph without importers. Before each update, cut orphans under /src/scene/ out of the
// graph, so the update travels only the real chain up to scene/main.js (accepted by src/main.js).
// Scene edits as transactions (user request: a change that needs several edits must land at once,
// not half-applied). `npm run scene:tx -- begin <name>` creates .vr/scene-hold/<name>; while any hold
// file is fresh (< HOLD_MAX_MS old), changes under /src/scene/ are NOT sent to the page — they are
// remembered. `npm run scene:tx -- commit <name>` removes the file; when no holds are left, every
// remembered file is invalidated first and then re-announced to the watcher, so the page swaps the
// scene once with all files already on disk. A forgotten hold expires by itself.
const HOLD_DIR = new URL('./.vr/scene-hold/', import.meta.url);
const HOLD_MAX_MS = 180000;
function sceneTransactions() {
  const pending = new Set();
  // a hold file lists the files it holds (one absolute path per line); an empty one holds every scene file
  const holding = (file) => {
    try {
      const now = Date.now();
      const norm = (p) => p.split('\\').join('/').toLowerCase();
      const want = file ? norm(file) : null;
      return fs.readdirSync(HOLD_DIR).some((f) => {
        const url = new URL(f, HOLD_DIR);
        if (now - fs.statSync(url).mtimeMs >= HOLD_MAX_MS) return false;
        const files = fs.readFileSync(url, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[0-9]+$/.test(l));
        if (!files.length || !want) return true;
        return files.some((p) => norm(p) === want);
      });
    } catch {
      return false; // no folder — no holds
    }
  };
  return {
    name: 'scene-transactions',
    configureServer(server) {
      const timer = setInterval(() => {
        if (!pending.size || [...pending].some((p) => holding(p))) return;
        const files = [...pending];
        pending.clear();
        const env = server.environments?.client;
        const graph = env?.moduleGraph ?? server.moduleGraph;
        const seen = new Set();
        const ts = Date.now();
        for (const file of files) for (const mod of graph.getModulesByFile(file) ?? []) graph.invalidateModule(mod, seen, ts, true);
        server.config.logger.info(`[scene-tx] commit: ${files.length} file(s)`, { timestamp: true });
        for (const file of files) server.watcher.emit('change', file);
      }, 250);
      server.httpServer?.once('close', () => clearInterval(timer));
    },
    hotUpdate({ file, modules }) {
      if (this.environment.name !== 'client') return;
      if (!modules.some((m) => typeof m.url === 'string' && m.url.startsWith('/src/scene/'))) return;
      if (!holding(file)) return;
      pending.add(file);
      return []; // held: nothing goes to the page until commit
    },
  };
}

function sceneHmrGuard() {
  const isSceneUrl = (url) => typeof url === 'string' && url.startsWith('/src/scene/');
  return {
    name: 'scene-hmr-guard',
    hotUpdate({ modules }) {
      if (this.environment.name !== 'client') return;
      const seen = new Set();
      const orphans = [];
      const walk = (node) => {
        if (!node || seen.has(node)) return;
        seen.add(node);
        if (!node.importers.size && isSceneUrl(node.url) && !node.isSelfAccepting) orphans.push(node);
        for (const importer of node.importers) walk(importer);
      };
      for (const mod of modules) walk(mod);
      if (!orphans.length) return;
      for (const orphan of orphans) {
        for (const dep of orphan.importedModules) dep.importers.delete(orphan);
        this.environment.logger.info(`[scene-hmr-guard] orphan cut: ${orphan.url}`, { timestamp: true });
      }
      // a changed file that only an orphan used is not part of the scene: no update, no reload
      return modules.filter((mod) => !orphans.includes(mod));
    },
  };
}

export default defineConfig({
  root: 'web',
  plugins: [sceneTransactions(), sceneHmrGuard()],
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
