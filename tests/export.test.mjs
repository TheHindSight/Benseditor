/**
 * Exports a game and plays the exported file.
 *
 * The point of the export is that it is one self-contained HTML that runs by
 * double-clicking, so this test loads the result over `file://` — no server —
 * and checks the game actually renders and responds.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'test-output');
mkdirSync(outDir, { recursive: true });

const PORT = 4321;

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` -- ${detail}` : ''}`);
};

if (!existsSync(join(root, 'public', 'player.js'))) {
  console.error('public/player.js missing — run `npm run build:player` first.');
  process.exit(1);
}

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

  // ---- produce the export from the editor -------------------------------
  const editor = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  await editor.addInitScript(() => localStorage.clear());
  await editor.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await editor.waitForSelector('.asset-group');

  console.log('\n=== exporting ===');
  const html = await editor.evaluate(async () => {
    const module = await import('/src/project/exportGame.ts').catch(() => null);
    // In a built preview the module is already bundled, so rebuild the file
    // here the same way the button does: fetch the player and inline it.
    const project = window.__benseditor.store.project;
    const player = await (await fetch('player.js')).text();
    return { playerBytes: player.length, project: JSON.stringify(project).length, module: !!module };
  });
  check('player bundle is reachable from the app', html.playerBytes > 100_000,
    `${html.playerBytes} bytes`);

  // Click the real button; in a browser it triggers a download.
  const downloadPromise = editor.waitForEvent('download', { timeout: 30000 });
  await editor.getByRole('button', { name: 'Export game' }).click();
  const download = await downloadPromise;
  const exported = join(outDir, 'exported-game.html');
  await download.saveAs(exported);

  const size = readFileSync(exported).length;
  console.log(`   exported ${(size / 1024 / 1024).toFixed(2)} MB to ${exported}`);
  check('export produced a file', size > 500_000, `${size} bytes`);
  check('export is one self-contained html', !readFileSync(exported, 'utf8').includes('src="'),
    'found an external script reference');

  // ---- play the exported file straight off disk --------------------------
  console.log('\n=== playing the exported file over file:// ===');
  const player = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors = [];
  player.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  player.on('pageerror', (e) => errors.push(String(e)));

  await player.goto(pathToFileURL(exported).href, { waitUntil: 'load' });
  await player.waitForSelector('#game', { timeout: 30000 });

  // Give the VM time to boot and draw.
  await player.waitForTimeout(4000);

  const stats = await player.evaluate(() => {
    const canvas = document.getElementById('game');
    const gl = canvas.getContext('webgl2');
    if (!gl) return { error: 'no webgl2' };
    const p = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
    const seen = new Set();
    for (let i = 0; i < p.length; i += 4) {
      seen.add((p[i] << 16) | (p[i + 1] << 8) | p[i + 2]);
    }
    return { width: canvas.width, height: canvas.height, colours: seen.size };
  });

  console.log(`   canvas ${stats.width}x${stats.height}, ${stats.colours} colours`);
  check('exported game created a canvas', stats.width > 0, JSON.stringify(stats));
  check('exported game rendered', (stats.colours ?? 0) > 5, `${stats.colours} colours`);
  check('no error box', (await player.locator('.player-error').count()) === 0,
    (await player.locator('.player-error').textContent().catch(() => '')) ?? '');

  await player.screenshot({ path: join(outDir, 'exported-game.png') });
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
