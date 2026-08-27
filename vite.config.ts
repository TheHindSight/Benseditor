import { defineConfig, type Plugin } from 'vite';

/**
 * Resolves `virtual:player-bundle`.
 *
 * The normal build leaves it empty so the 2 MB player stays out of the app and
 * is fetched only when someone exports. `tools/build-single.mjs` swaps in a
 * version that returns the real source.
 */
function emptyPlayerBundle(): Plugin {
  const id = 'virtual:player-bundle';
  return {
    name: 'benseditor:player-bundle',
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load: (resolved) => (resolved === `\0${id}` ? 'export default { luau: "", python: "" };' : null),
  };
}

export default defineConfig({
  // Relative asset paths, so the build works from `file://` inside Electron as
  // well as from a web server.
  base: './',
  plugins: [emptyPlayerBundle()],
  // Luau's prelude is authored as a real .luau file and inlined at build time,
  // so it stays syntax-highlightable and testable on its own.
  assetsInclude: ['**/*.luau', '**/*.py'],
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  optimizeDeps: {
    // luau-web picks its VM build with a top-level `await import`, which the
    // default pre-bundling target (chrome87) rejects. The production build
    // already targets es2022; dev needs telling separately.
    esbuildOptions: { target: 'es2022' },
  },
  server: {
    // Cross-origin isolation keeps the door open for SharedArrayBuffer later.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
});
