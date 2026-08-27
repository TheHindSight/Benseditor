/**
 * Plays the Dash template -- the Python demo -- in a real browser.
 *
 * A Geometry Dash-style runner is a good end-to-end exercise for the Python
 * engine: a tile layer the cube is blocked by, gravity, a collision event
 * with spikes, a persistent controller driving the camera and a GUI, room
 * restarts, and ReplicatedStorage across them. The checks watch the cube's
 * yellow pixels: it runs, it dies on the first spike, it comes back for a
 * second attempt, and it jumps when asked.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test-output');
mkdirSync(outDir, { recursive: true });

const PORT = 4361;

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
    if (chunk.toString().includes('Local')) {
      clearTimeout(timer);
      resolve();
    }
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

  console.log('\n=== creating the Dash project ===');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.waitForSelector('.modal-box');
  const discard = page.locator('.modal-box').getByRole('button', { name: 'Discard' });
  if (await discard.isVisible().catch(() => false)) {
    await discard.click();
    await page.waitForSelector('.modal-box select');
  }
  await page.locator('.modal-box select').selectOption('dash');
  check('the dialog pins the demo to Python', await page.locator('.modal-box input[name=language][value=python]').isChecked() && await page.locator('.modal-box input[name=language][value=python]').isDisabled());
  await page.locator('.modal-box').getByRole('button', { name: 'Create' }).click();
  await page.waitForTimeout(400);

  const project = await page.evaluate(() => {
    const p = window.__benseditor.store.project;
    return {
      language: p.config.language,
      sprites: p.sprites.map((s) => s.name),
      objects: p.objects.map((o) => o.def.name),
      rooms: p.rooms.map((r) => r.name),
      solidTiles: p.rooms[0].layers[0].tiles.filter((t) => t >= 0).length,
      spikes: p.rooms[0].instances.filter((i) => i.object === 'obj_spike').length,
      named: p.rooms[0].instances.filter((i) => i.name).map((i) => i.name),
      python: p.objects.every((o) => !o.source.includes('local obj')),
    };
  });
  check('the project is in Python', project.language === 'python' && project.python);
  check('three sprites, four objects, one room', project.sprites.length === 3 && project.objects.length === 4 && project.rooms.length === 1, JSON.stringify(project));
  check('the level has ground and platforms', project.solidTiles > 300, String(project.solidTiles));
  check('and spikes', project.spikes >= 15, String(project.spikes));
  check('the cube and controller are named for FindFirstChild', project.named.includes('cube') && project.named.includes('controller'));
  check('the object editor opens a .py file', (await (async () => {
    await page.evaluate(() => window.__benseditor.openAsset('object', 'obj_cube'));
    await page.waitForSelector('.object-editor');
    return page.locator('.code-header strong').textContent();
  })()) === 'obj_cube.py');

  console.log('\n=== playing ===');
  /** Where the cube's yellow shell is on the canvas, if anywhere. */
  const cube = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('.game-canvas');
      const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ?? canvas.getContext('webgl2');
      const p = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
      let count = 0;
      let minX = canvas.width;
      let maxX = 0;
      let minY = canvas.height;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width; x++) {
          const i = (y * canvas.width + x) * 4;
          // #ffec27, the cube's shell.
          if (p[i] > 230 && p[i + 1] > 200 && p[i + 2] < 90) {
            count++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            // readPixels rows run bottom-up.
            const top = canvas.height - 1 - y;
            if (top < minY) minY = top;
          }
        }
      }
      return { count, minX, maxX, minY, width: canvas.width, height: canvas.height };
    });

  await page.evaluate(() => window.__benseditor.play());
  await page.waitForTimeout(1200);
  check('no error on play', await page.evaluate(() => document.querySelector('.game-error')?.hidden !== false),
    await page.locator('.game-error').textContent().catch(() => ''));

  const running = await cube();
  check('the cube is on screen', running.count > 100, JSON.stringify(running));
  // The camera leads the cube by 140 room px; the canvas is drawn at 2x.
  check('the camera follows, keeping the cube near the left third', running.minX > 200 && running.maxX < 420, `x ${running.minX}-${running.maxX}`);
  const frameMs = await page.evaluate(() => window.__benseditor.game.frameMs);
  check('a frame stays well inside budget', frameMs < 12, `${frameMs.toFixed(2)}ms`);
  // The fixed timestep: sixty steps a second whatever the display does.
  const stepsBefore = await page.evaluate(() => window.__benseditor.game.stepCount);
  await page.waitForTimeout(2000);
  const stepsDelta = (await page.evaluate(() => window.__benseditor.game.stepCount)) - stepsBefore;
  check('the game steps sixty times a second', stepsDelta >= 100 && stepsDelta <= 140, `${stepsDelta} steps in 2 s`);
  check('the runtime reports its room', (await page.evaluate(() => window.__benseditor.game.room())) === 'rm_level1');
  await page.screenshot({ path: join(outDir, 'dash-running.png') });

  // With nobody jumping, the first spike (column 24) ends the run within
  // about two seconds; a restart follows forty steps later.
  const seen = [];
  for (let i = 0; i < 45; i++) {
    await page.waitForTimeout(100);
    seen.push((await cube()).count > 100);
  }
  // It was alive a moment ago (checked above); the first spike takes it out
  // within these samples, and a restart brings it back.
  const firstGone = seen.indexOf(false);
  const back = firstGone >= 0 ? seen.indexOf(true, firstGone) : -1;
  const trace = seen.map((v) => (v ? '#' : '.')).join('');
  check('the cube dies on the first spike', firstGone >= 0, trace);
  check('and comes back for another attempt', back > firstGone, trace);
  check('and keeps dying there without input', seen.indexOf(false, back) > back, trace);

  console.log('\n=== jumping ===');
  await page.locator('.game-canvas').click();
  // Wait for a fresh attempt to be under way, then hold jump.
  await page.waitForTimeout(600);
  const grounded = await cube();
  await page.keyboard.down('Space');
  let highest = grounded.minY;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(50);
    const now = await cube();
    if (now.count > 100 && now.minY < highest) highest = now.minY;
  }
  await page.keyboard.up('Space');
  check('holding space makes the cube jump', grounded.count > 100 && highest < grounded.minY - 30, `top went from ${grounded.minY} to ${highest}`);
  await page.screenshot({ path: join(outDir, 'dash-jump.png') });

  console.log('\n=== the HUD ===');
  const hud = await page.evaluate(() => {
    const canvas = document.querySelector('.game-canvas');
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ?? canvas.getContext('webgl2');
    const p = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
    // The progress bar's black frame at the top of the view, y 6..14 at 2x.
    let dark = 0;
    for (let y = canvas.height - 28; y < canvas.height - 12; y++) {
      for (let x = 280; x < 680; x++) {
        const i = (y * canvas.width + x) * 4;
        if (p[i] + p[i + 1] + p[i + 2] < 30) dark++;
      }
    }
    return dark;
  });
  check('the progress bar is drawn in the GUI', hud > 500, String(hud));

  await page.evaluate(() => window.__benseditor.game.stop());
  check('no console errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (error) {
  failed++;
  console.log(`  FAIL crashed -- ${error?.stack ?? error}`);
} finally {
  await browser?.close();
  if (process.platform === 'win32' && server.pid) {
    spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    server.kill();
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
