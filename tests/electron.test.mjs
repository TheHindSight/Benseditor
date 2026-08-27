/**
 * Launches the real Electron app.
 *
 * Checks the window loads the built app, the preload bridge is present and
 * narrow, and a game runs inside the desktop shell.
 */
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test-output');
mkdirSync(outDir, { recursive: true });

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` -- ${detail}` : ''}`);
};

if (!existsSync(join(root, 'dist', 'index.html'))) {
  console.error('dist/index.html missing — run `npm run build` first.');
  process.exit(1);
}

let app;
try {
  app = await electron.launch({
    args: ['.', '--enable-features=WebAssemblyJavaScriptPromiseIntegration', '--use-gl=swiftshader'],
    cwd: root,
  });

  const page = await app.firstWindow();
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.waitForSelector('.asset-group', { timeout: 60000 });

  console.log('\n=== window ===');
  check('app window opened', true);
  check('title is Benseditor', (await page.title()) === 'Benseditor', await page.title());
  check('editor mounted', await page.locator('.topbar').isVisible());

  console.log('\n=== desktop bridge ===');
  const bridge = await page.evaluate(() => {
    const api = window.benseditorDesktop;
    return api ? { keys: Object.keys(api).sort(), version: api.version } : null;
  });
  check('preload exposed the bridge', bridge !== null);
  console.log(`   electron ${bridge?.version}`);
  check('bridge has the file operations',
    ['openProjectDialog', 'readProject', 'writeProject', 'writeFile', 'saveFileDialog']
      .every((key) => bridge?.keys.includes(key)),
    bridge?.keys.join(','));

  // Context isolation must hold: no Node in the page.
  const leaked = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    module: typeof window.module,
  }));
  check('node is not exposed to the page',
    leaked.require === 'undefined' && leaked.process === 'undefined',
    JSON.stringify(leaked));

  console.log('\n=== running a game in the desktop app ===');
  check('Open folder is enabled on desktop',
    !(await page.getByRole('button', { name: 'Open folder' }).isDisabled()));

  await page.getByRole('button', { name: '▶ Play' }).click();
  await page.waitForFunction(() => (window.__benseditor?.game?.frameMs ?? 0) > 0, { timeout: 60000 });
  await page.waitForTimeout(1200);

  check('no error panel', await page.locator('.game-error').isHidden());
  const drew = await page.evaluate(() => {
    const canvas = document.querySelector('.game-canvas');
    const gl = canvas.getContext('webgl2');
    const p = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
    const seen = new Set();
    for (let i = 0; i < p.length; i += 4) seen.add((p[i] << 16) | (p[i + 1] << 8) | p[i + 2]);
    return seen.size;
  });
  check('game rendered in Electron', drew > 5, `${drew} colours`);

  const frameMs = await page.evaluate(() => window.__benseditor.game.frameMs);
  console.log(`   ${frameMs.toFixed(2)} ms/frame`);

  await page.screenshot({ path: join(outDir, 'electron.png') });
  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (error) {
  failed++;
  console.error('FAILED:', error.message?.slice(0, 400));
} finally {
  await app?.close().catch(() => {});
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
