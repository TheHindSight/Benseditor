/**
 * The Geometry Dash in-game editor and its verification loop, in a real
 * browser: menu -> editor, placing a block by mouse, naming and saving the
 * level (localStorage index), a verify run the cube completes on its own,
 * VERIFIED in the store, an edit dropping it back to unverified, and the
 * level select refusing to launch the unverified level.
 *
 * Serves the app with the Vite dev server so the test always runs the current
 * sources (the preview server would replay a stale dist/).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test-output');
mkdirSync(outDir, { recursive: true });

const PORT = 4379;
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
  ['vite', '--port', String(PORT), '--strictPort'],
  { cwd: root, stdio: 'pipe', shell: process.platform === 'win32' },
);
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('vite dev server did not start')), 60000);
  server.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    if (text.includes('ready in') || text.includes('Local')) {
      clearTimeout(timer);
      setTimeout(resolve, 500);
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
  await page.waitForSelector('.asset-group', { timeout: 30000 });

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
  await page.waitForTimeout(400);
  check('the project has the editor room and object', await page.evaluate(() => {
    const p = window.__benseditor.store.project;
    const editor = p.rooms.find((r) => r.name === 'rm_editor');
    return Boolean(p.objects.find((o) => o.def.name === 'obj_editor'))
      && Boolean(editor) && editor.instances.some((i) => i.object === 'obj_editor');
  }));

  await page.evaluate(() => window.__benseditor.play());
  const room = () => page.evaluate(() => window.__benseditor.game?.room?.() ?? '');
  const waitRoom = async (name, timeout = 25000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if ((await room()) === name) return true;
      await page.waitForTimeout(120);
    }
    return false;
  };
  check('the game boots into the menu', await waitRoom('rm_menu'), await room());

  const box = await page.locator('.game-canvas').boundingBox();
  const at = (sx, sy) => [box.x + (sx * box.width) / VIEW_W, box.y + (sy * box.height) / VIEW_H];
  const key = async (name, delay = 70) => {
    await page.keyboard.press(name);
    await page.waitForTimeout(delay);
  };
  /** Count canvas pixels (top-left origin) inside a screen-space region that satisfy a colour rule. */
  const countPixels = (region, rule) => page.evaluate(([r, ruleSrc]) => {
    const canvas = document.querySelector('.game-canvas');
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ?? canvas.getContext('webgl2');
    const p = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
    const sx = canvas.width / 570;
    const sy = canvas.height / 330;
    const test = new Function('r', 'g', 'b', `return ${ruleSrc};`);
    let count = 0;
    for (let ty = Math.floor(r.y0 * sy); ty < Math.floor(r.y1 * sy); ty++) {
      const y = canvas.height - 1 - ty; // readPixels rows run bottom-up
      for (let x = Math.floor(r.x0 * sx); x < Math.floor(r.x1 * sx); x++) {
        const i = (y * canvas.width + x) * 4;
        if (test(p[i], p[i + 1], p[i + 2])) count++;
      }
    }
    return count;
  }, [region, rule]);
  const index = () => page.evaluate(() => JSON.parse(localStorage.getItem('benseditor.datastore.gd/index') ?? 'null'));

  console.log('\n=== into the editor ===');
  await key('ArrowDown');
  await key('ArrowDown');
  await key('Enter');
  check('ArrowDown x2 + Enter reaches rm_editor', await waitRoom('rm_editor'), await room());
  await page.waitForTimeout(300);

  console.log('\n=== placing a block ===');
  // The editor opens scrolled to the bottom-left: view (0, 630). Cell
  // (col 10, row 4) is at room (315, 765) -> screen (315, 135).
  const cell = { x0: 300, y0: 120, x1: 330, y1: 150 };
  const neutral = at(30, 320); // over the bar, away from the palette
  await page.mouse.move(...neutral);
  await page.waitForTimeout(150);
  const blue = 'g > 130 && b > 220 && r < 120'; // the block tile's bright border
  const emptyPixels = await countPixels(cell, blue);
  await page.mouse.move(...at(315, 135));
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.mouse.move(...neutral);
  await page.waitForTimeout(200);
  const blockPixels = await countPixels(cell, blue);
  check('left-clicking a cell draws the block tile there', blockPixels > emptyPixels + 300, `${emptyPixels} -> ${blockPixels}`);

  console.log('\n=== naming and saving ===');
  await key('n');
  for (let i = 0; i < 'Untitled'.length; i++) await key('Backspace', 40);
  for (const ch of 'my first') await key(ch === ' ' ? 'Space' : ch, 50);
  await key('Enter');
  // The end at column 16 (the minimum length): hover it, press e.
  await page.mouse.move(...at(495, 135));
  await page.waitForTimeout(120);
  await key('e');
  await key('s');
  await page.waitForTimeout(400);
  let idx = await index();
  let entry = idx ? Object.values(idx.entries)[0] : null;
  check('saving writes gd/index to localStorage', Boolean(entry), JSON.stringify(idx));
  check('the entry has the typed name, len 16 and verified:false',
    entry && entry.name === 'my first' && entry.len === 16 && entry.verified === false, JSON.stringify(entry));

  console.log('\n=== the verify run ===');
  await key('v');
  check('v starts the verify run in rm_play', await waitRoom('rm_play'), await room());
  check('the cube finishes the short level on its own', await waitRoom('rm_end', 30000), await room());
  await page.waitForTimeout(300);
  await key('ArrowRight');
  await key('Enter');
  check('the end screen returns to the editor', await waitRoom('rm_editor'), await room());
  await page.waitForTimeout(400);
  idx = await index();
  entry = idx ? Object.values(idx.entries)[0] : null;
  check('the index now says verified:true', entry && entry.verified === true, JSON.stringify(entry));
  const verifiedBadge = await countPixels({ x0: 490, y0: 285, x1: 568, y1: 310 }, 'g > 170 && r < 110 && b < 130');
  check('the editor bar shows the green VERIFIED badge', verifiedBadge > 300, String(verifiedBadge));
  await page.screenshot({ path: join(outDir, 'gd-editor-verified.png') });

  console.log('\n=== editing drops the verification ===');
  await key('2'); // the spike tool
  await page.mouse.move(...at(375, 255)); // col 12, row 0
  await page.waitForTimeout(100);
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.up();
  await key('s');
  await page.waitForTimeout(400);
  idx = await index();
  entry = idx ? Object.values(idx.entries)[0] : null;
  check('saving the changed level clears verified', entry && entry.verified === false, JSON.stringify(entry));

  console.log('\n=== the menu refuses the unverified level ===');
  await key('Escape');
  check('escape returns to the menu (nothing unsaved)', await waitRoom('rm_menu'), await room());
  await key('ArrowDown');
  await key('Enter');
  check('Play opens the level select', await waitRoom('rm_levels'), await room());
  await page.waitForTimeout(300);
  // Three built-ins, then the custom level.
  await key('ArrowDown');
  await key('ArrowDown');
  await key('ArrowDown');
  const badge = await countPixels({ x0: 440, y0: 130, x1: 566, y1: 160 }, 'r > 190 && g < 90 && b < 130');
  check('the custom row shows the red UNVERIFIED badge', badge > 200, String(badge));
  await key('Enter');
  await page.waitForTimeout(600);
  check('Enter refuses to launch it (still in rm_levels)', (await room()) === 'rm_levels', await room());
  await page.screenshot({ path: join(outDir, 'gd-editor-refused.png') });

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
