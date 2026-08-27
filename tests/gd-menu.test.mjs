/**
 * The Geometry Dash clone's menu, in a real browser.
 *
 * New -> "Geometry Dash" builds the full project (rooms, objects, Python);
 * play lands in rm_menu with the title on screen. The buttons work both ways:
 * ArrowDown+Enter opens the level list (Escape backs out), the mouse hovers
 * and clicks Play, the level list launches a built-in level into rm_play,
 * Icon opens by mouse, and Quit ends the run (the step counter freezes).
 * `game.room()` is the source of truth for every transition.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test-output');
mkdirSync(outDir, { recursive: true });

const PORT = 4371;

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

  const project = await page.evaluate(() => {
    const p = window.__benseditor.store.project;
    return {
      language: p.config.language,
      rooms: p.rooms.map((r) => r.name),
      objects: p.objects.map((o) => o.def.name),
    };
  });
  check('the project is in Python', project.language === 'python');
  check(
    'the scene rooms exist',
    ['rm_menu', 'rm_levels', 'rm_icon', 'rm_play', 'rm_end'].every((r) => project.rooms.includes(r)),
    project.rooms.join(','),
  );
  check(
    'the scene objects exist',
    ['obj_menu', 'obj_levels', 'obj_hud'].every((o) => project.objects.includes(o)),
    project.objects.join(','),
  );

  console.log('\n=== the title screen ===');
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
  /** Count pixels matching a predicate id inside a canvas rect (top-origin). */
  const scan = (x0, y0, x1, y1, filter) =>
    page.evaluate(([x0, y0, x1, y1, filter]) => {
      const canvas = document.querySelector('.game-canvas');
      const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ?? canvas.getContext('webgl2');
      const p = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
      const match = {
        cream: (r, g, b) => r > 225 && g > 215 && b > 185,
        hover: (r, g, b) => r > 18 && r < 48 && g > 42 && g < 78 && b > 100 && b < 145,
        any: () => true,
      }[filter];
      let count = 0;
      for (let ty = y0; ty < y1; ty++) {
        const y = canvas.height - 1 - ty; // readPixels rows run bottom-up
        for (let x = x0; x < x1; x++) {
          const i = (y * canvas.width + x) * 4;
          if (match(p[i], p[i + 1], p[i + 2])) count++;
        }
      }
      return count;
    }, [x0, y0, x1, y1, filter]);
  /** Page coordinates of a point given in view (570x330) coordinates. */
  const viewPoint = async (vx, vy) => {
    const b = await page.locator('.game-canvas').boundingBox();
    return { x: b.x + (vx / 570) * b.width, y: b.y + (vy / 330) * b.height };
  };

  await page.evaluate(() => window.__benseditor.play());
  await page.waitForTimeout(1500);
  check('no error on play', await page.evaluate(() => document.querySelector('.game-error')?.hidden !== false),
    await page.locator('.game-error').textContent().catch(() => ''));
  check('the game starts in rm_menu', (await room()) === 'rm_menu', await room());
  // The title sprite's cream block letters sit in the top half of the view.
  const title = await scan(200, 60, 940, 260, 'cream');
  check('the title is drawn', title > 300, `${title} cream pixels`);
  await page.screenshot({ path: join(outDir, 'gd-menu-title.png') });

  // Focus the game (a click in the top-left corner hits no button).
  const neutral = await viewPoint(5, 5);
  await page.mouse.click(neutral.x, neutral.y);
  await page.waitForTimeout(150);

  console.log('\n=== keyboard: ArrowDown + Enter opens the level list ===');
  await page.keyboard.press('ArrowDown'); // no focus -> Play
  await page.waitForTimeout(120);
  await page.keyboard.press('Enter');
  check('Play by keyboard goes to rm_levels', await waitRoom('rm_levels'));
  await page.keyboard.press('Escape');
  check('Escape returns to rm_menu', await waitRoom('rm_menu'));
  await page.waitForTimeout(200);

  console.log('\n=== mouse: hover and click Play ===');
  // Park the mouse away from the buttons, then measure the Play button
  // (view rect 205,150 160x28 -> canvas 410,300 to 730,356 at 2x).
  await page.mouse.move(neutral.x, neutral.y);
  await page.waitForTimeout(250);
  const plain = await scan(410, 300, 730, 356, 'hover');
  const playCenter = await viewPoint(285, 164);
  await page.mouse.move(playCenter.x, playCenter.y);
  await page.waitForTimeout(300);
  const hovered = await scan(410, 300, 730, 356, 'hover');
  check('hovering Play changes its pixels', hovered > plain + 800, `${plain} -> ${hovered} hover-fill pixels`);
  await page.mouse.click(playCenter.x, playCenter.y);
  check('clicking Play goes to rm_levels', await waitRoom('rm_levels'));
  await page.screenshot({ path: join(outDir, 'gd-menu-levels.png') });

  console.log('\n=== the level list launches a built-in level ===');
  await page.keyboard.press('ArrowDown'); // b1 -> b2 (both built-ins are verified)
  await page.waitForTimeout(120);
  await page.keyboard.press('Enter');
  check('Enter launches into rm_play', await waitRoom('rm_play'));
  await page.screenshot({ path: join(outDir, 'gd-menu-play.png') });

  // Leave through the pause menu: Escape pauses, Exit returns to the level
  // list (the run remembers where it came from), Escape again to the menu.
  // Escape is ignored during the death animation, so retry until it lands.
  let paused = false;
  for (let i = 0; i < 8 && !paused; i++) {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    // The overlay darkens everything; the PAUSED panel adds hover-blue pixels.
    paused = (await scan(342, 136, 750, 480, 'hover')) > 300;
    if (!paused) await page.waitForTimeout(350);
  }
  check('Escape opens the pause overlay', paused);
  const exitCenter = await viewPoint(285, 221); // pause button 3: Exit
  await page.mouse.move(exitCenter.x, exitCenter.y);
  await page.waitForTimeout(120);
  await page.mouse.click(exitCenter.x, exitCenter.y);
  check('pause Exit returns to rm_levels', await waitRoom('rm_levels'));
  await page.keyboard.press('Escape');
  check('and Escape back to rm_menu', await waitRoom('rm_menu'));
  await page.waitForTimeout(200);

  console.log('\n=== Icon opens by mouse ===');
  const iconCenter = await viewPoint(285, 236); // menu button 2: Icon
  await page.mouse.click(iconCenter.x, iconCenter.y);
  check('clicking Icon goes to rm_icon', await waitRoom('rm_icon'));
  await page.keyboard.press('Escape');
  check('Escape leaves the icon screen', await waitRoom('rm_menu'));
  await page.waitForTimeout(200);

  console.log('\n=== Quit ends the run ===');
  await page.keyboard.press('ArrowUp'); // no focus -> wraps to Quit
  await page.waitForTimeout(120);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const s1 = await page.evaluate(() => window.__benseditor.game.stepCount);
  await page.waitForTimeout(700);
  const s2 = await page.evaluate(() => window.__benseditor.game.stepCount);
  check('Quit stops the game loop', s1 === s2, `steps still advancing: ${s1} -> ${s2}`);

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
