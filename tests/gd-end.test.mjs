/**
 * The end screen.
 *
 * A level with obstacles can only be cleared with frame-perfect input, and the
 * browser steps on a real-time clock that catches up in bursts, so a recorded
 * input schedule drifts and cannot be replayed reliably (the headless
 * `gd-levels` suite proves the built-ins completable in lockstep instead). The
 * end screen is reached deterministically the way a creator reaches it: make a
 * short empty level in the editor and verify it. With nothing to jump over the
 * cube runs straight to the finish whatever the timing, the game shows the
 * completion screen, and the level is recorded verified.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test-output');
mkdirSync(outDir, { recursive: true });

const PORT = 4377;
const VIEW_W = 570;
const VIEW_H = 330;

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` -- ${detail}` : ''}`);
};

const server = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vite', 'preview', '--port', String(PORT), '--strictPort'],
  { cwd: root, stdio: 'pipe', shell: process.platform === 'win32' },
);
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('preview server did not start')), 30000);
  server.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('Local')) { clearTimeout(timer); resolve(); }
  });
});

let browser;
try {
  await ready;
  browser = await chromium.launch({
    args: ['--enable-features=WebAssemblyJavaScriptPromiseIntegration', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.addInitScript(() => localStorage.clear());
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.waitForSelector('.asset-group');

  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.waitForSelector('.modal-box');
  const discard = page.locator('.modal-box').getByRole('button', { name: 'Discard' });
  if (await discard.isVisible().catch(() => false)) {
    await discard.click();
    await page.waitForSelector('.modal-box select');
  }
  await page.locator('.modal-box select').selectOption('gd');
  await page.locator('.modal-box').getByRole('button', { name: 'Create' }).click();
  await page.waitForTimeout(400);

  const room = () => page.evaluate(() => window.__benseditor.game.room());
  const waitRoom = async (name, ms = 25000) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if ((await room()) === name) return true;
      await page.waitForTimeout(120);
    }
    return false;
  };
  const key = async (name, delay = 70) => { await page.keyboard.press(name); await page.waitForTimeout(delay); };
  const index = () => page.evaluate(() => JSON.parse(localStorage.getItem('benseditor.datastore.gd/index') ?? 'null'));
  const anyEntry = (idx, pred) => !!idx && Object.values(idx.entries ?? idx.levels ?? {}).some(pred);

  console.log('\n=== into the editor ===');
  await page.evaluate(() => window.__benseditor.play());
  check('the game boots into the menu', await waitRoom('rm_menu'), await room());
  const box = await page.locator('.game-canvas').boundingBox();
  const at = (sx, sy) => [box.x + (sx * box.width) / VIEW_W, box.y + (sy * box.height) / VIEW_H];
  await key('ArrowDown');
  await key('ArrowDown');
  await key('Enter');
  check('the editor opens', await waitRoom('rm_editor'), await room());
  await page.waitForTimeout(300);

  console.log('\n=== a short empty level ===');
  await page.mouse.move(...at(495, 135));
  await page.waitForTimeout(120);
  await key('n');
  for (let i = 0; i < 'Untitled'.length; i++) await key('Backspace', 40);
  for (const ch of 'runway') await key(ch, 45);
  await key('Enter');
  await page.mouse.move(...at(495, 135));
  await page.waitForTimeout(120);
  await key('e');
  await key('s');
  await page.waitForTimeout(400);
  check('the level saved as unverified', anyEntry(await index(), (e) => e.verified === false), JSON.stringify(await index()));

  console.log('\n=== verify it: the cube runs the empty level ===');
  await key('v');
  check('the verify run starts', await waitRoom('rm_play'), await room());
  const reachedEnd = await waitRoom('rm_end', 30000);
  check('the cube reaches the finish on its own', reachedEnd, `room=${await room()}`);

  if (reachedEnd) {
    await page.waitForTimeout(600);
    const bright = await page.evaluate(() => {
      const c = document.querySelector('.game-canvas');
      const gl = c.getContext('webgl2', { preserveDrawingBuffer: true }) ?? c.getContext('webgl2');
      const p = new Uint8Array(c.width * c.height * 4);
      gl.readPixels(0, 0, c.width, c.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
      let n = 0;
      for (let i = 0; i < p.length; i += 4) if (p[i + 1] > 180 && p[i + 2] < 140) n++;
      return n;
    });
    check('the end screen draws its heading', bright > 400, bright + ' bright pixels');
    await page.screenshot({ path: join(outDir, 'gd-end.png') });
    check('the level is now verified in the store', anyEntry(await index(), (e) => e.verified === true), JSON.stringify(await index()));
    // Focus starts on Replay; move right to Menu/Editor, then activate it.
    await key('ArrowRight');
    await key('Enter');
    check('leaving the end screen returns to the editor or menu', (await waitRoom('rm_editor', 5000)) || (await room()) === 'rm_menu', await room());
  }

  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (error) {
  failed++;
  console.log('  FAIL crashed -- ' + (error?.stack ?? error));
} finally {
  await browser?.close();
  if (process.platform === 'win32' && server.pid) spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  else server.kill();
}

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed === 0 ? 0 : 1);
