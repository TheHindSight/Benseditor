/**
 * Plays the Snake template in a real browser.
 *
 * Snake is a good end-to-end exercise: a tile layer, three sprites drawn with
 * draw_sprite_ext, grid logic, input, a HUD, and a DataStore high score all
 * have to work together for it to be playable at all.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test-output');
mkdirSync(outDir, { recursive: true });

const PORT = 4319;

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

  console.log('\n=== creating the Snake project ===');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.waitForSelector('.modal-box');
  const discard = page.locator('.modal-box').getByRole('button', { name: 'Discard' });
  if (await discard.isVisible().catch(() => false)) {
    await discard.click();
    await page.waitForSelector('.modal-box select');
  }
  await page.locator('.modal-box select').selectOption('snake');
  await page.locator('.modal-box').getByRole('button', { name: 'Create' }).click();
  await page.waitForTimeout(400);

  const project = await page.evaluate(() => {
    const p = window.__benseditor.store.project;
    return {
      name: p.config.name,
      sprites: p.sprites.map((s) => s.name),
      tilesets: p.tilesets.map((t) => t.name),
      objects: p.objects.map((o) => o.def.name),
      rooms: p.rooms.map((r) => r.name),
      layerTiles: p.rooms[0].layers[0].tiles.filter((t) => t >= 0).length,
      startRoom: p.config.startRoom,
    };
  });
  check('template name follows the picker', project.name === 'Snake', project.name);
  check('three sprites', project.sprites.length === 3, project.sprites.join(','));
  check('field tileset', project.tilesets.join() === 'ts_field', project.tilesets.join());
  check('one object', project.objects.join() === 'obj_snake', project.objects.join());
  check('checkerboard filled', project.layerTiles === 30 * 18, String(project.layerTiles));
  check('start room set', project.startRoom === 'rm_snake', project.startRoom);

  console.log('\n=== playing ===');
  await page.getByRole('button', { name: '▶ Play' }).click();
  await page.waitForFunction(() => (window.__benseditor?.game?.frameMs ?? 0) > 0, { timeout: 60000 });
  await page.waitForTimeout(500);
  check('no error panel', await page.locator('.game-error').isHidden());

  /** Centroid and pixel count of a colour, in canvas space. */
  const findColour = (r, g, b) =>
    page.evaluate(
      ([tr, tg, tb]) => {
        const canvas = document.querySelector('.game-canvas');
        const gl = canvas.getContext('webgl2');
        const p = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
        let sx = 0;
        let sy = 0;
        let n = 0;
        for (let i = 0; i < p.length; i += 4) {
          if (p[i] === tr && p[i + 1] === tg && p[i + 2] === tb) {
            const px = (i / 4) % canvas.width;
            sx += px;
            sy += Math.floor(i / 4 / canvas.width);
            n++;
          }
        }
        return { x: n ? sx / n : -1, y: n ? sy / n : -1, count: n };
      },
      [r, g, b],
    );

  /**
   * Locate the snake by "greenish" rather than an exact colour: on death it is
   * drawn at half alpha, so the blended pixels no longer match #00e436 and an
   * exact search would report it missing.
   */
  const snakeGreen = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('.game-canvas');
      const gl = canvas.getContext('webgl2');
      const p = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let i = 0; i < p.length; i += 4) {
        if (p[i] < 90 && p[i + 1] > 90 && p[i + 2] < 110 && p[i + 1] - p[i] > 50) {
          sx += (i / 4) % canvas.width;
          sy += Math.floor(i / 4 / canvas.width);
          n++;
        }
      }
      return { x: n ? sx / n : -1, y: n ? sy / n : -1, count: n };
    });

  // Tolerant for the same reason as the snake: anything drawn under the HUD
  // panel or at reduced alpha is blended and will not match exactly.
  const foodRed = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('.game-canvas');
      const gl = canvas.getContext('webgl2');
      const p = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
      let n = 0;
      for (let i = 0; i < p.length; i += 4) {
        if (p[i] > 110 && p[i + 1] < 90 && p[i + 2] > 20 && p[i + 2] < 140) n++;
      }
      return { x: -1, y: -1, count: n };
    });

  /** Restart, so a run that already crashed does not poison the next check. */
  const restart = async () => {
    await page.locator('.game-canvas').click();
    await page.keyboard.press('r');
    await page.waitForTimeout(250);
  };

  const startSnake = await snakeGreen();
  check('snake is on screen', startSnake.count > 200, `${startSnake.count} green pixels`);
  const startFood = await foodRed();
  check('food is on screen', startFood.count > 30, `${startFood.count} red pixels`);
  const fieldTiles = await findColour(0x1a, 0x21, 0x30);
  check('checkerboard rendered', fieldTiles.count > 1000, `${fieldTiles.count} light tiles`);

  // Capture it alive, before the later sections deliberately crash it.
  await page.screenshot({ path: join(outDir, 'snake.png') });
  await page.locator('.game-canvas').screenshot({ path: join(outDir, 'snake-game.png') });

  // Reading a 960x576 framebuffer under software GL is slow enough that the
  // snake can reach a wall between checks; restart so each one starts fresh.
  await restart();

  // It starts moving right on its own.
  const beforeMove = await snakeGreen();
  await page.waitForTimeout(700);
  const moved = await snakeGreen();
  check('snake moves by itself', moved.x > beforeMove.x + 10,
    `${beforeMove.x.toFixed(0)} -> ${moved.x.toFixed(0)}`);

  // Steer it downward and confirm it turns. The snake only advances every
  // `delay` steps, so hold the key long enough for several moves — and measure
  // from *after* the key press, since a restart resets it to the middle.
  await restart();
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(200);
  const beforeTurn = await snakeGreen();
  await page.waitForTimeout(1200);
  const afterTurn = await snakeGreen();
  await page.keyboard.up('ArrowDown');

  // readPixels is bottom-up, so moving down the screen lowers this y.
  check('arrow keys steer it', afterTurn.y < beforeTurn.y - 10,
    `y ${beforeTurn.y.toFixed(0)} -> ${afterTurn.y.toFixed(0)}`);

  console.log('\n=== dying and restarting ===');
  // Drive into the bottom wall.
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(3000);

  const deadText = await page.evaluate(() => {
    const canvas = document.querySelector('.game-canvas');
    const gl = canvas.getContext('webgl2');
    const p = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
    // The game-over banner is drawn in red text over a dark panel.
    let red = 0;
    for (let i = 0; i < p.length; i += 4) {
      if (p[i] > 200 && p[i + 1] < 60 && p[i + 2] > 40 && p[i + 2] < 120) red++;
    }
    return red;
  });
  check('game over banner appeared', deadText > 200, `${deadText} banner pixels`);
  check('still no error panel', await page.locator('.game-error').isHidden());

  const best = await page.evaluate(() =>
    localStorage.getItem('benseditor.datastore.snake/best'),
  );
  check('high score persisted', best !== null, String(best));

  await page.screenshot({ path: join(outDir, 'snake-gameover.png') });

  await page.keyboard.press('r');
  await page.waitForTimeout(600);
  const restarted = await snakeGreen();
  check('R restarts the game', restarted.count > 200, `${restarted.count} green pixels`);

  const frameMs = await page.evaluate(() => window.__benseditor.game.frameMs);
  console.log(`   ${frameMs.toFixed(2)} ms/frame (software GL)`);
  check('runs within budget', frameMs < 16.6, `${frameMs.toFixed(2)} ms`);

  check('no console errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (error) {
  failed++;
  console.error('FAILED:', error.message?.slice(0, 400));
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
