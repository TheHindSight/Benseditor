/**
 * Playing a level: the HUD, jumping, dying, pausing and practice mode.
 *
 * Launches b1 "Stereo Steps" from the menu. The cube runs in the saved
 * colours near the left third of the view under a progress bar and an
 * attempt counter; holding Space makes it jump; with no input it dies on the
 * first spike and respawns (the attempt count lands in DataStore "gd").
 * Escape opens the pause overlay (the view darkens); Practice turns on (the
 * green PRACTICE badge appears), `z` drops a checkpoint (its green marker is
 * drawn), and the next death respawns at the checkpoint, not the start.
 * Exit leaves to the level list the run came from. The engine keeps its
 * frame budget and its sixty steps a second throughout.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test-output');
mkdirSync(outDir, { recursive: true });

const PORT = 4375;

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
  const viewPoint = async (vx, vy) => {
    const b = await page.locator('.game-canvas').boundingBox();
    return { x: b.x + (vx / 570) * b.width, y: b.y + (vy / 330) * b.height };
  };
  /**
   * Pixel census over a canvas rect (top-origin canvas coordinates). The
   * in-game cube is the icon's outline frame -- a pure-black 60x60 square at
   * 2x (~1000 black pixels; a spike's border is ~350) -- so `black` and its
   * bounds are the cube tracker, `green` sees badges and checkpoint markers,
   * `dark` the panels and the pause overlay, `white` the HUD text.
   */
  const scan = (x0, y0, x1, y1) =>
    page.evaluate(([x0, y0, x1, y1]) => {
      const canvas = document.querySelector('.game-canvas');
      const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ?? canvas.getContext('webgl2');
      const p = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
      let black = 0;
      let green = 0;
      let dark = 0;
      let white = 0;
      let minX = canvas.width;
      let maxX = 0;
      let minY = canvas.height;
      for (let ty = y0; ty < y1; ty++) {
        const y = canvas.height - 1 - ty;
        for (let x = x0; x < x1; x++) {
          const i = (y * canvas.width + x) * 4;
          const r = p[i];
          const g = p[i + 1];
          const b = p[i + 2];
          if (r + g + b < 30) {
            black++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (ty < minY) minY = ty;
          }
          if (g > 180 && r < 100 && b < 120) green++;
          if (r + g + b < 90) dark++;
          if (r > 220 && g > 220 && b > 220) white++;
        }
      }
      return { black, green, dark, white, minX, maxX, minY, width: maxX - minX };
    }, [x0, y0, x1, y1]);
  // The cube's whereabouts: the band the cube and its jumps live in, above
  // the floor tiles (whose outlines are black too) and left of where spikes
  // pile up. A sample is the lone cube when the black cluster is ~60 wide.
  const cube = () => scan(0, 300, 600, 538);
  const soloCube = (s) => s.black > 800 && s.width <= 90;
  const progress = () =>
    page.evaluate(() => {
      const raw = localStorage.getItem('benseditor.datastore.gd/progress');
      try {
        return raw ? JSON.parse(raw) : null;
      } catch {
        return null;
      }
    });

  console.log('\n=== launching b1 "Stereo Steps" ===');
  await page.evaluate(() => window.__benseditor.play());
  await page.waitForTimeout(1500);
  check('no error on play', await page.evaluate(() => document.querySelector('.game-error')?.hidden !== false),
    await page.locator('.game-error').textContent().catch(() => ''));
  check('the game starts in rm_menu', (await room()) === 'rm_menu', await room());
  const neutral = await viewPoint(5, 5);
  await page.mouse.click(neutral.x, neutral.y);
  await page.waitForTimeout(150);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(120);
  await page.keyboard.press('Enter');
  check('the level list opens', await waitRoom('rm_levels'));
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter'); // the first row: b1, verified
  check('Enter launches b1 into rm_play', await waitRoom('rm_play'));

  // The cube dies and respawns every couple of seconds with nobody at the
  // keys, so poll until a sample catches it settled at the camera's lead.
  let running = null;
  for (let i = 0; i < 60 && !running; i++) {
    const now = await cube();
    if (soloCube(now) && now.minX > 140 && now.maxX < 480) running = now;
    else await page.waitForTimeout(100);
  }
  check('the cube is on screen', !!running, JSON.stringify(running));
  check('near the left third of the view', !!running && running.minX > 140 && running.maxX < 480,
    running ? `x ${running.minX}-${running.maxX}` : 'not seen');

  console.log('\n=== the HUD ===');
  // The progress bar's dark back sits at view (135,8)-(435,18): canvas
  // (270,16)-(870,36); "Attempt 1" is white text at the top left.
  const bar = await scan(270, 16, 870, 36);
  check('the progress bar frame is drawn', bar.dark > 400, `${bar.dark} dark pixels`);
  const attempt = await scan(8, 8, 200, 44);
  check('the attempt counter is drawn', attempt.white > 30, `${attempt.white} white pixels`);
  const frameMs = await page.evaluate(() => window.__benseditor.game.frameMs);
  check('a frame stays well inside budget', frameMs < 12, `${frameMs.toFixed(2)}ms`);
  const stepsBefore = await page.evaluate(() => window.__benseditor.game.stepCount);
  await page.waitForTimeout(2000);
  const stepsDelta = (await page.evaluate(() => window.__benseditor.game.stepCount)) - stepsBefore;
  check('the game steps sixty times a second', stepsDelta >= 100 && stepsDelta <= 140, `${stepsDelta} steps in 2 s`);
  await page.screenshot({ path: join(outDir, 'gd-play-hud.png') });

  console.log('\n=== dying and respawning ===');
  // With no input the first spike ends every attempt; the death is recorded.
  const died = async (timeout = 6000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (((await progress())?.levels?.b1?.attempts ?? 0) > 0) return true;
      await page.waitForTimeout(150);
    }
    return false;
  };
  check('the death lands in the progress record', await died(), JSON.stringify(await progress()));

  console.log('\n=== holding Space jumps ===');
  // Wait for a fresh attempt (the cube reappears on the left), then hold.
  let base = null;
  for (let i = 0; i < 60 && !base; i++) {
    const now = await cube();
    if (soloCube(now) && now.minX < 260 && now.minY >= 470) base = now;
    else await page.waitForTimeout(80);
  }
  check('a fresh attempt begins on the left', !!base, 'cube never reappeared');
  await page.keyboard.down('Space');
  let highest = base ? base.minY : 0;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(50);
    const now = await cube();
    if (now.black > 700 && now.minY < highest) highest = now.minY;
  }
  await page.keyboard.up('Space');
  check('holding Space lifts the cube', base && highest < base.minY - 35, `top ${base?.minY} -> ${highest}`);
  await page.screenshot({ path: join(outDir, 'gd-play-jump.png') });

  console.log('\n=== pause and practice ===');
  // Escape is ignored while the death explosion plays, so retry until the
  // dark overlay actually covers the view.
  const fullDark = async () => (await scan(0, 60, 1140, 660)).dark;
  const plainDark = await fullDark();
  const pauseGame = async () => {
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      if ((await fullDark()) > plainDark + 1140 * 600 * 0.2) return true;
      await page.waitForTimeout(350);
    }
    return false;
  };
  const practice = await viewPoint(285, 157); // pause item 1: Practice
  check('Escape darkens the view with the pause overlay', await pauseGame(), `baseline ${plainDark}`);
  await page.screenshot({ path: join(outDir, 'gd-play-pause.png') });

  // Practice is the second pause item; click it, then resume with Escape.
  await page.mouse.click(practice.x, practice.y);
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape'); // resume
  await page.waitForTimeout(300);
  const badge = await scan(8, 40, 200, 90);
  check('the PRACTICE badge shows', badge.green > 40, `${badge.green} green pixels`);

  console.log('\n=== checkpoints ===');
  // Practice may already have dropped an automatic checkpoint somewhere, so
  // reset it: toggling practice OFF clears the checkpoints and restarts the
  // level from the beginning, toggling it back ON starts practice fresh.
  check('practice toggles off (the level restarts)', await pauseGame() && await (async () => {
    await page.mouse.click(practice.x, practice.y); // OFF: restart + resume
    await page.waitForTimeout(400);
    return pauseGame();
  })());
  await page.mouse.click(practice.x, practice.y); // ON again, no checkpoints
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape'); // resume
  await page.waitForTimeout(200);

  // Wait for a fresh attempt entering from the left, give it a beat to get
  // past the camera's 150 px lead, and press z EARLY in the attempt -- well
  // before the first spike kills at x ~530 -- so the checkpoint lands while
  // the cube is alive and past x 150.
  let cpSet = false;
  let cpDetail = 'never caught a fresh attempt in time';
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !cpSet) {
    const fresh = await cube();
    if (!(soloCube(fresh) && fresh.minX < 200)) {
      await page.waitForTimeout(60);
      continue;
    }
    await page.waitForTimeout(250);
    const now = await cube();
    if (!(soloCube(now) && now.minX >= 240 && now.maxX <= 470)) continue;
    await page.keyboard.press('z');
    await page.waitForTimeout(150);
    const after = (await cube()).green;
    cpSet = after > now.green + 40;
    cpDetail = `${now.green} -> ${after} green pixels`;
  }
  check('z drops a checkpoint marker', cpSet, cpDetail);
  await page.screenshot({ path: join(outDir, 'gd-play-practice.png') });

  // The next death respawns at the checkpoint: shortly after the restart the
  // cube is already out at the camera lead, not entering from the left edge.
  let reborn = null;
  if (cpSet) {
    const attempts0 = (await progress())?.levels?.b1?.attempts ?? 0;
    const until = Date.now() + 12000;
    while (Date.now() < until && ((await progress())?.levels?.b1?.attempts ?? 0) <= attempts0) {
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(750); // explosion + respawn; particles die out
    const rebornUntil = Date.now() + 3000;
    while (Date.now() < rebornUntil && !reborn) {
      const now = await cube();
      if (soloCube(now)) reborn = now;
      else await page.waitForTimeout(80);
    }
  }
  check('the practice respawn returns near the checkpoint', !!reborn && reborn.minX > 220,
    reborn ? `reappeared at x ${reborn.minX}` : 'no respawn seen');

  console.log('\n=== leaving through the pause menu ===');
  check('the pause overlay opens again', await pauseGame());
  const exit = await viewPoint(285, 221);
  await page.mouse.move(exit.x, exit.y);
  await page.waitForTimeout(120);
  await page.mouse.click(exit.x, exit.y);
  check('Exit returns to the level list the run came from', await waitRoom('rm_levels'));
  await page.keyboard.press('Escape');
  check('and Escape back to rm_menu', await waitRoom('rm_menu'));

  const record = await progress();
  check('the progress record kept the attempts', (record?.levels?.b1?.attempts ?? 0) >= 2, JSON.stringify(record));

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
