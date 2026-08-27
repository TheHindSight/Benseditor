/**
 * Opens the single-file editor straight off disk.
 *
 * No server anywhere in this test: `benseditor.html` is loaded over `file://`,
 * driven like the real app, and asked to export a game — which is the one part
 * that used to depend on fetching a separate player bundle.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test-output');
mkdirSync(outDir, { recursive: true });

const single = join(root, 'dist-single', 'benseditor.html');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` -- ${detail}` : ''}`);
};

if (!existsSync(single)) {
  console.error('dist-single/benseditor.html missing — run `npm run build:single` first.');
  process.exit(1);
}

let browser;
try {
  console.log('\n=== the file itself ===');
  const html = readFileSync(single, 'utf8');
  console.log(`   ${(html.length / 1024 / 1024).toFixed(2)} MB`);

  check('is a single file with no external references',
    !/<script[^>]+src=/i.test(html) && !/<link[^>]+stylesheet/i.test(html),
    'found an external script or stylesheet');
  // Not a regex: `[\s\S]{2000,}` over a six-megabyte string overflows V8's
  // regex stack. The distance between the tags says the same thing.
  const styleAt = html.indexOf('<style>');
  const styleEnd = html.indexOf('</style>', styleAt);
  check('carries its stylesheet inline', styleAt >= 0 && styleEnd - styleAt > 2000);
  check('carries the Luau VM', html.includes('Asyncify') || html.includes('JSPI'));

  browser = await chromium.launch({
    args: ['--enable-features=WebAssemblyJavaScriptPromiseIntegration', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('\n=== opening it from file:// ===');
  await page.goto(pathToFileURL(single).href, { waitUntil: 'load' });
  await page.waitForSelector('.asset-group', { timeout: 30000 });
  check('editor mounted', await page.locator('.topbar').isVisible());
  check('styles applied', await page.evaluate(() => {
    const bar = document.querySelector('.topbar');
    return getComputedStyle(bar).height === '44px';
  }), 'topbar is not 44px tall, so the css did not load');
  check('demo project loaded', (await page.locator('.asset-item').count()) >= 9,
    String(await page.locator('.asset-item').count()));

  console.log('\n=== editing works ===');
  await page.evaluate(() => window.__benseditor.openAsset('sprite', 'spr_player'));
  await page.waitForSelector('.sprite-editor');
  check('sprite editor opens', await page.locator('.pixel-view').isVisible());

  await page.evaluate(() => window.__benseditor.openAsset('tileset', 'ts_stone'));
  await page.waitForSelector('.tileset-editor');
  check('tileset editor opens', await page.locator('.tileset-view').isVisible());

  console.log('\n=== the game runs ===');
  await page.getByRole('button', { name: '▶ Play' }).click();
  await page.waitForFunction(() => (window.__benseditor?.game?.frameMs ?? 0) > 0, { timeout: 60000 });
  await page.waitForTimeout(1200);

  check('no error panel', await page.locator('.game-error').isHidden());
  const colours = await page.evaluate(() => {
    const canvas = document.querySelector('.game-canvas');
    const gl = canvas.getContext('webgl2');
    const p = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
    const seen = new Set();
    for (let i = 0; i < p.length; i += 4) seen.add((p[i] << 16) | (p[i + 1] << 8) | p[i + 2]);
    return seen.size;
  });
  check('game rendered', colours > 5, `${colours} colours`);
  console.log(`   ${(await page.evaluate(() => window.__benseditor.game.frameMs)).toFixed(2)} ms/frame`);

  console.log('\n=== exporting from a file:// page ===');
  // This is the part that would break if the player still had to be fetched.
  const exported = await page.evaluate(async () => {
    const blobs = [];
    const original = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      blobs.push(blob);
      return original.call(URL, blob);
    };
    const clicked = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {};

    try {
      const button = [...document.querySelectorAll('button')].find(
        (b) => b.textContent.trim() === 'Export game',
      );
      button.click();
      // Give the export a moment to assemble.
      await new Promise((resolve) => setTimeout(resolve, 3000));
      if (blobs.length === 0) return { size: 0, head: '', hasProject: false, hasPlayer: false };
      const text = await blobs[0].text();
      return {
        size: text.length,
        head: text.slice(0, 120),
        // Checked in the page: the file is megabytes, so do not ship it back.
        hasProject: text.includes('__BENSEDITOR_PROJECT__'),
        hasPlayer: text.includes('Asyncify') || text.includes('JSPI'),
      };
    } finally {
      URL.createObjectURL = original;
      HTMLAnchorElement.prototype.click = clicked;
    }
  });

  console.log(`   export produced ${(exported.size / 1024 / 1024).toFixed(2)} MB`);
  check('export worked without a server', exported.size > 500_000, `${exported.size} bytes`);
  check('export carries the project data', exported.hasProject, exported.head);
  check('export carries the engine', exported.hasPlayer, exported.head);

  await page.screenshot({ path: join(outDir, 'single-file.png') });
  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (error) {
  failed++;
  console.error('FAILED:', error.message?.slice(0, 400));
} finally {
  await browser?.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
