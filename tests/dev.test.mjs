/**
 * Verifies `npm run dev` actually boots the app.
 *
 * The production build and the dev server go through different pipelines --
 * dev pre-bundles dependencies with esbuild -- so a working `npm run build`
 * does not prove `npm run dev` works. It did not, once.
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5199;

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

const output = [];
server.stdout.on('data', (c) => output.push(c.toString()));
server.stderr.on('data', (c) => output.push(c.toString()));

const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('vite did not start:\n' + output.join(''))), 40000);
  server.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('ready in')) {
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
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.addInitScript(() => localStorage.clear());
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });

  await page.waitForSelector('.asset-group', { timeout: 20000 });
  check('app mounts in dev mode', true);
  // Derived from the store rather than hard-coded, so adding a demo asset does
  // not break this test for the wrong reason.
  const expected = await page.evaluate(() => {
    const p = window.__benseditor.store.project;
    return p.sprites.length + p.tilesets.length + p.objects.length + p.rooms.length + p.scripts.length;
  });
  const shown = await page.locator('.asset-item').count();
  check('asset tree lists every asset', shown === expected, `${shown} shown, ${expected} in project`);

  await page.getByRole('button', { name: '▶ Play' }).click();
  await page.waitForFunction(() => (window.__benseditor?.game?.frameMs ?? 0) > 0, { timeout: 60000 });
  check('game runs in dev mode', true);
  check('no page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
} catch (error) {
  failed++;
  console.error('FAILED:', error.message?.slice(0, 500));
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
