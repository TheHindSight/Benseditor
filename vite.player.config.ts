import { defineConfig } from 'vite';

/**
 * Builds the standalone player as a single classic script -- one per language.
 *
 *   vite build --config vite.player.config.ts                 → public/player.js     (Luau)
 *   vite build --config vite.player.config.ts --mode python   → public/player.py.js  (Python)
 *
 * `inlineDynamicImports` matters: luau-web picks its VM with a dynamic import,
 * and an exported game has to be one file with no network of its own. The
 * result lands in `public/` so the editor can fetch it in dev and in a build
 * alike, and so it ships inside the Electron package. Each entry imports only
 * its own engine, so neither file carries the other VM.
 */
export default defineConfig(({ mode }) => {
  const python = mode === 'python';
  return {
    configFile: false,
    assetsInclude: ['**/*.luau', '**/*.py'],
    build: {
      target: 'es2022',
      outDir: 'public',
      emptyOutDir: false,
      lib: {
        entry: python ? 'src/player/main-python.ts' : 'src/player/main.ts',
        // ES rather than IIFE: luau-web uses top-level await, which IIFE cannot
        // express. An *inline* module script still runs from file://, because
        // nothing has to be fetched — and inlineDynamicImports leaves no imports.
        formats: ['es'],
        fileName: () => (python ? 'player.py.js' : 'player.js'),
      },
      rollupOptions: {
        output: { inlineDynamicImports: true },
      },
      minify: true,
      sourcemap: false,
    },
  };
});
