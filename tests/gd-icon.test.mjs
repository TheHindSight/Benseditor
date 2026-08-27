/**
 * The icon customisation screen, in a real browser.
 *
 * Open Icon from the menu, click the red cell of the primary palette: the
 * spinning preview turns red and the settings land in DataStore "gd"
 * (localStorage `benseditor.datastore.gd/settings`) at once. Escape saves
 * and returns; stopping the game and playing again finds the same red --
 * the choice persisted. Picking another shape updates `settings.icon` too.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test-output');
mkdirSync(outDir, { recursive: true });

const PORT = 4373;

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

  console.log('\n=== creating the Geometry Dash project ===');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.waitForSelector('.modal-box');
  const discard = page.locator('.modal-box').getByRole('button', { name: 'Discard' });
  if (await discard.isVisible().catch(() => false)) {
    await discard.click();
    await page.waitForSelector('.modal-box select');
  }
  await page.locator('.modal-box select').selectOption('gd');
  await page.locator('.modal-box').getByRole('button', { name: 'Create' }).click();
  await page.waitForTimeout(500);

  const room = () => page.evaluate(() => window.__benseditor.game.room());
  const waitRoom = async (name, timeout = 5000) => {
    const until = Date.now() + timeout;
    let now = '';
    while (Date.now() < until) {
      now = await room();
      if (now === name) return true;
      await page.waitForTimeout(80);
    }
    check(`reached ${name}`, false, `still in "${now}"`);
    return false;
  };
  const settings = () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('benseditor.datastore.gd/settings');
      try {
        return raw ? JSON.parse(raw) : null;
      } catch {
        return { corrupt: raw };
      }
    });
  /** Red pixels inside a canvas rect given in top-origin canvas coordinates. */
  const redIn = (x0, y0, x1, y1) =>
    page.evaluate(([x0, y0, x1, y1]) => {
      const canvas = document.querySelector('.game-canvas');
      const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ?? canvas.getContext('webgl2');
      const p = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
      let count = 0;
      for (let ty = y0; ty < y1; ty++) {
        const y = canvas.height - 1 - ty;
        for (let x = x0; x < x1; x++) {
          const i = (y * canvas.width + x) * 4;
          // The PICO-8 red 0xFF004D the palette cell carries.
          if (p[i] > 200 && p[i + 1] < 80 && p[i + 2] < 120) count++;
        }
      }
      return count;
    }, [x0, y0, x1, y1]);
  const viewPoint = async (vx, vy) => {
    const b = await page.locator('.game-canvas').boundingBox();
    return { x: b.x + (vx / 570) * b.width, y: b.y + (vy / 330) * b.height };
  };
  const openIcon = async () => {
    const neutral = await viewPoint(5, 5);
    await page.mouse.click(neutral.x, neutral.y);
    await page.waitForTimeout(150);
    const icon = await viewPoint(285, 236); // menu button 2: Icon
    await page.mouse.click(icon.x, icon.y);
    return waitRoom('rm_icon');
  };

  console.log('\n=== opening the icon screen ===');
  await page.evaluate(() => window.__benseditor.play());
  await page.waitForTimeout(1500);
  check('no error on play', await page.evaluate(() => document.querySelector('.game-error')?.hidden !== false),
    await page.locator('.game-error').textContent().catch(() => ''));
  check('the game starts in rm_menu', (await room()) === 'rm_menu', await room());
  check('Icon opens by mouse', await openIcon());
  await page.waitForTimeout(300);

  console.log('\n=== picking a red primary colour ===');
  const before = await settings();
  check('the defaults are saved as yellow/blue cube', !before || (before.primary === 10 && before.secondary === 12),
    JSON.stringify(before));
  // Primary grid cell 8 (row 2, column 0) is the PICO-8 red: view rect
  // (40, 148) 22x22 -> click its centre.
  const redCell = await viewPoint(51, 159);
  await page.mouse.click(redCell.x, redCell.y);
  await page.waitForTimeout(300);
  const after = await settings();
  check('the settings JSON records primary = red', after && after.primary === 8, JSON.stringify(after));
  check('and keeps the other fields', after && after.secondary === 12 && after.icon === 0, JSON.stringify(after));
  // The big spinning preview at view (470, 190) picks the colour up: canvas
  // region (850, 280)-(1030, 480) at 2x, minus the palette on the far left.
  const preview = await redIn(850, 280, 1030, 480);
  check('the preview turns red', preview > 300, `${preview} red pixels`);
  await page.screenshot({ path: join(outDir, 'gd-icon-red.png') });

  await page.keyboard.press('Escape');
  check('Escape saves and returns to the menu', await waitRoom('rm_menu'));
  check('the settings survive leaving the screen', (await settings())?.primary === 8, JSON.stringify(await settings()));

  console.log('\n=== the colour persists across a fresh run ===');
  await page.evaluate(() => window.__benseditor.game.stop());
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__benseditor.play());
  await page.waitForTimeout(1500);
  check('the game replays into rm_menu', await waitRoom('rm_menu'));
  check('Icon opens again', await openIcon());
  await page.waitForTimeout(300);
  check('the saved primary is still red', (await settings())?.primary === 8, JSON.stringify(await settings()));
  const stillRed = await redIn(850, 280, 1030, 480);
  check('the preview shows the persisted red', stillRed > 300, `${stillRed} red pixels`);

  console.log('\n=== picking another shape ===');
  const shape = await viewPoint(390, 110); // shape 2, "Cross"
  await page.mouse.click(shape.x, shape.y);
  await page.waitForTimeout(300);
  const reshaped = await settings();
  check('the settings JSON records the new shape', reshaped && reshaped.icon === 2, JSON.stringify(reshaped));
  check('with the red primary untouched', reshaped && reshaped.primary === 8, JSON.stringify(reshaped));
  await page.screenshot({ path: join(outDir, 'gd-icon-shape.png') });
  await page.keyboard.press('Escape');
  check('Escape returns to the menu', await waitRoom('rm_menu'));

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
