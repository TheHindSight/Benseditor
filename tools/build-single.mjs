/**
 * Builds the whole editor as one HTML file.
 *
 * Everything ends up inline — the UI, the engine, the Luau VM, and the
 * standalone player used by "Export game" — so `benseditor.html` is a complete
 * development environment you can open by double-clicking it.
 *
 *   node tools/build-single.mjs
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmpDir = join(root, '.single-build');
const outDir = join(root, 'dist-single');

const kb = (text) => `${(Buffer.byteLength(text) / 1024).toFixed(0)} KB`;

/** Serves the real player sources, one per language, to the app bundle. */
function playerBundlePlugin(sources) {
  const id = 'virtual:player-bundle';
  return {
    name: 'benseditor:player-bundle-embedded',
    resolveId: (request) => (request === id ? `\0${id}` : null),
    load: (resolved) =>
      resolved === `\0${id}` ? `export default ${JSON.stringify(sources)};` : null,
  };
}

/** One player build per language; each carries only its own VM. */
async function buildPlayer(entry, fileName) {
  await build({
    root,
    configFile: false,
    logLevel: 'warn',
    // outDir is public/, so the public-dir copy step has nothing to do.
    publicDir: false,
    assetsInclude: ['**/*.luau', '**/*.py'],
    build: {
      target: 'es2022',
      outDir: 'public',
      emptyOutDir: false,
      lib: { entry, formats: ['es'], fileName: () => fileName },
      rollupOptions: { output: { inlineDynamicImports: true } },
      minify: true,
    },
  });
  return readFile(join(root, 'public', fileName), 'utf8');
}

console.log('building the players…');
const playerSources = {
  luau: await buildPlayer('src/player/main.ts', 'player.js'),
  python: await buildPlayer('src/player/main-python.ts', 'player.py.js'),
};
console.log(`  luau player: ${kb(playerSources.luau)}`);
console.log(`  python player: ${kb(playerSources.python)}`);

console.log('building the editor…');
await rm(tmpDir, { recursive: true, force: true });
await build({
  root,
  configFile: false,
  logLevel: 'warn',
  plugins: [playerBundlePlugin(playerSources)],
  assetsInclude: ['**/*.luau', '**/*.py'],
  build: {
    target: 'es2022',
    outDir: '.single-build',
    emptyOutDir: true,
    // One chunk and one stylesheet, so there is nothing left to link to.
    cssCodeSplit: false,
    lib: {
      entry: 'src/main.ts',
      formats: ['es'],
      fileName: () => 'app.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
    minify: true,
  },
});

const emitted = await readdir(tmpDir);
const cssName = emitted.find((name) => name.endsWith('.css'));
const appSource = await readFile(join(tmpDir, 'app.js'), 'utf8');
const css = cssName ? await readFile(join(tmpDir, cssName), 'utf8') : '';
console.log(`  editor: ${kb(appSource)} + ${kb(css)} css`);

// `</script>` inside a string literal would close the tag early.
const safe = (text) => text.replace(/<\/script>/gi, '<\\/script>');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Benseditor</title>
<style>${css}</style>
</head>
<body>
<script type="module">${safe(appSource)}</script>
</body>
</html>
`;

await mkdir(outDir, { recursive: true });
const target = join(outDir, 'benseditor.html');
await writeFile(target, html, 'utf8');
await rm(tmpDir, { recursive: true, force: true });

console.log(`\nwrote ${target}`);
console.log(`total ${kb(html)} — open it in a browser, no server needed`);
