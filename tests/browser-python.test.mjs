/**
 * Python mode, end to end in Chromium.
 *
 * A new project in Python: `.py` tab titles, Python highlighting, an editor
 * that indents after a colon and never writes `end`, `#` comments, dot-only
 * completions, Python templates and event stubs -- and then the game itself:
 * a Python object runs on MicroPython, draws to the WebGL canvas, and an
 * error in it is reported as `obj_x.py line N`. Finally the project exports
 * and the exported file plays from `file://`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'test-output');
mkdirSync(outDir, { recursive: true });

const PORT = 4341;
const URL = `http://localhost:${PORT}/`;

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
};

const server = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vite', 'preview', '--port', String(PORT), '--strictPort'],
  { cwd: root, stdio: 'pipe', shell: process.platform === 'win32' },
);

const serverReady = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('preview server did not start')), 30000);
  server.stdout.on('data', (chunk) => {
    if (chunk.toString().includes('Local')) {
      clearTimeout(timer);
      resolve();
    }
  });
});

const PLAYER = `SPEED = 3


def create(self):
    self.ticks = 0


def step(self):
    self.ticks += 1
    if keyboard_check("right"):
        self.x += SPEED


def draw(self):
    draw_set_color(c_green)
    draw_rectangle(self.x, self.y, self.x + 40, self.y + 40, False)
    draw_text(self.x, self.y - 14, f"ticks {self.ticks}", c_white)
`;

let browser;
try {
  await serverReady;

  browser = await chromium.launch({
    args: ['--enable-features=WebAssemblyJavaScriptPromiseIntegration', '--use-gl=swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const consoleErrors = [];
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  await page.addInitScript(() => localStorage.clear());
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('.asset-group');

  const sourceNow = () => page.locator('.code-input').inputValue();
  const setSource = async (source) => {
    await page.locator('.code-input').click();
    await page.evaluate((text) => {
      const area = document.querySelector('.code-input');
      area.focus();
      area.select();
      if (text === '') document.execCommand('delete');
      else document.execCommand('insertText', false, text);
      area.setSelectionRange(area.value.length, area.value.length);
    }, source);
    await page.waitForTimeout(120);
  };
  const caretToEnd = () =>
    page.evaluate(() => {
      const area = document.querySelector('.code-input');
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    });

  console.log('\n=== a new project in Python ===');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.waitForSelector('.modal-box');
  const discard = page.locator('.modal-box').getByRole('button', { name: 'Discard' });
  if (await discard.isVisible().catch(() => false)) {
    await discard.click();
    await page.waitForSelector('.modal-box input[type=text]');
  }
  check('the dialog offers a language', (await page.locator('.modal-box input[name=language]').count()) === 2);
  await page.locator('.modal-box select').selectOption('demo');
  check('the demos are Luau only', await page.locator('.modal-box input[name=language][value=python]').isDisabled());
  await page.locator('.modal-box select').selectOption('blank');
  await page.locator('.modal-box input[name=language][value=python]').check();
  await page.locator('.modal-box input[type=text]').fill('Py Game');
  await page.locator('.modal-box').getByRole('button', { name: 'Create' }).click();
  await page.waitForTimeout(300);
  check('the project records its language', await page.evaluate(() => window.__benseditor.store.project.config.language === 'python'));

  console.log('\n=== a Python object from a template ===');
  await page.locator('.asset-group', { hasText: 'Objects' }).locator('button.mini', { hasText: '+' }).click();
  await page.waitForSelector('.modal-box select');
  await page.locator('.modal-box select').selectOption('player-topdown');
  await page.locator('.modal-box input[type=text]').fill('obj_player');
  await page.locator('.modal-box').getByRole('button', { name: 'Create' }).click();
  await page.waitForSelector('.object-editor');
  const templateSource = await page.evaluate(() => window.__benseditor.store.object('obj_player').source);
  check('the template arrives in Python', templateSource.includes('def step(self):') && !templateSource.includes('local obj'), templateSource.slice(0, 80));
  check('the tab is named .py', (await page.locator('.code-header strong').textContent()) === 'obj_player.py');
  check('the header says Python', (await page.locator('.code-header .muted').first().textContent()) === 'Python');
  const definedEvents = await page.locator('.event.defined span:nth-child(2)').allTextContents();
  check('the event checklist reads Python defs', definedEvents.includes('Step'), definedEvents.join(','));
  await page.locator('.event:not(.defined)', { hasText: 'Draw' }).first().click();
  await page.waitForTimeout(150);
  const withStub = await page.evaluate(() => window.__benseditor.store.object('obj_player').source);
  check('an event stub is a Python def', /def draw\(self\):\n {4}self\.draw_self\(\)/.test(withStub), withStub.slice(-60));

  console.log('\n=== Python highlighting ===');
  await setSource('# a comment\ndef step(self):\n    self.x = keyboard_check("right")\n');
  await page.waitForTimeout(150);
  const classes = await page.evaluate(() =>
    [...document.querySelectorAll('.code-highlight span')].map((s) => [s.className, s.textContent]),
  );
  const has = (cls, text) => classes.some(([c, t]) => c === cls && t === text);
  check('# comments are comments', has('tok-comment', '# a comment'), JSON.stringify(classes.slice(0, 4)));
  check('def is a keyword', has('tok-keyword', 'def'));
  check('self is self', has('tok-self', 'self'));
  check('engine functions are engine', has('tok-engine', 'keyboard_check'));
  check('no Luau class leaks in', !classes.some(([c]) => c.includes('undefined')));

  console.log('\n=== the editor speaks Python ===');
  await setSource('');
  await page.keyboard.type('def step(self):');
  await page.keyboard.press('Enter');
  await page.keyboard.type('x = 1');
  await page.waitForTimeout(120);
  check('Enter after a colon indents four spaces', (await sourceNow()) === 'def step(self):\n    x = 1', JSON.stringify(await sourceNow()));
  check('and writes no end', !(await sourceNow()).includes('end'));

  await page.keyboard.press('Enter');
  await page.keyboard.type('return');
  await page.keyboard.press('Enter');
  await page.keyboard.type('y = 2');
  await page.waitForTimeout(120);
  check('a bare return dedents the next line', (await sourceNow()).endsWith('\n    return\ny = 2'), JSON.stringify(await sourceNow()));

  await setSource('if x:\n    y = 1\n    ');
  await caretToEnd();
  await page.keyboard.type('else');
  await page.waitForTimeout(120);
  check('else pulls back a level as typed', (await sourceNow()) === 'if x:\n    y = 1\nelse', JSON.stringify(await sourceNow()));

  await setSource('a = 1\nb = 2\n');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+End');
  await page.keyboard.press('Control+/');
  check('Ctrl+/ comments with #', (await sourceNow()) === '# a = 1\n# b = 2\n', JSON.stringify(await sourceNow()));
  await page.keyboard.press('Control+/');
  check('and toggles it back', (await sourceNow()) === 'a = 1\nb = 2\n', JSON.stringify(await sourceNow()));

  await setSource('def step(self):\n    self.pl');
  await caretToEnd();
  await page.keyboard.press('Control+ ');
  await page.waitForSelector('.code-complete:not([hidden])', { timeout: 5000 });
  const members = await page.locator('.complete-name').allTextContents();
  check('self. completes instance methods', members.includes('place_meeting'), members.join(','));
  await page.keyboard.press('Escape');

  await setSource('def step(self):\n    self:pl');
  await caretToEnd();
  await page.keyboard.press('Control+ ');
  await page.waitForTimeout(250);
  const afterColon = await page.locator('.complete-name').allTextContents();
  check('a colon is not a member accessor in Python', !afterColon.includes('place_meeting'), afterColon.join(','));
  await page.keyboard.press('Escape');

  await setSource('def create(self):\n    svc = game.GetService("Ru');
  await caretToEnd();
  await page.keyboard.press('Control+ ');
  await page.waitForSelector('.code-complete:not([hidden])', { timeout: 5000 });
  const services = await page.locator('.complete-name').allTextContents();
  check('GetService offers the services', services.includes('RunService'), services.join(','));
  await page.keyboard.press('Escape');

  console.log('\n=== the game runs on MicroPython ===');
  await setSource(PLAYER);
  // Let the editor's debounced save land before the store is touched, or the
  // change event would refresh the editor back to the older source.
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const store = window.__benseditor.store;
    store.commit('place', () => {
      store.room('rm_main').instances.push({ id: 'inst_1', object: 'obj_player', x: 100, y: 100, xscale: 1, yscale: 1, angle: 0 });
    });
  });
  await page.evaluate(() => window.__benseditor.play());
  await page.waitForTimeout(2500);
  const errorShown = await page.evaluate(() => document.querySelector('.game-error')?.hidden === false);
  check('play shows no error', !errorShown, await page.locator('.game-error').textContent().catch(() => ''));
  const readGreen = () => page.evaluate(() => {
    const canvas = document.querySelector('.game-canvas');
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ?? canvas.getContext('webgl2');
    if (!gl) return { lit: -1 };
    const p = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
    let lit = 0;
    let green = 0;
    for (let i = 0; i < p.length; i += 4) {
      if (p[i] + p[i + 1] + p[i + 2] > 0) lit++;
      if (p[i + 1] > 150 && p[i] < 80) green++;
    }
    return { lit, green, source: window.__benseditor.store.object('obj_player').source.slice(0, 40) };
  });
  let pixels = await readGreen();
  for (let attempt = 0; attempt < 10 && pixels.green === 0; attempt++) {
    await page.waitForTimeout(300);
    pixels = await readGreen();
  }
  check('the Python object drew its rectangle', pixels.green > 500, JSON.stringify(pixels));
  const frameMs = await page.evaluate(() => window.__benseditor.game.frameMs);
  check('a frame stays well inside budget', frameMs < 16, `${frameMs.toFixed(2)}ms`);
  await page.locator('.game-canvas').click();
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(400);
  await page.keyboard.up('ArrowRight');
  const moved = await page.evaluate(() => {
    const canvas = document.querySelector('.game-canvas');
    const gl = canvas.getContext('webgl2');
    const p = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
    let firstGreen = canvas.width;
    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < firstGreen; x++) {
        const i = (y * canvas.width + x) * 4;
        if (p[i + 1] > 150 && p[i] < 80) firstGreen = x;
      }
    }
    return firstGreen;
  });
  check('input reaches Python game code', moved > 100 * 2, `left edge at ${moved}`);
  await page.screenshot({ path: join(outDir, 'python-game.png') });

  console.log('\n=== errors point at the Python line ===');
  await page.evaluate(() => window.__benseditor.game.stop());
  await page.evaluate(() => window.__benseditor.openAsset('object', 'obj_player'));
  await page.waitForSelector('.object-editor');
  await setSource('def create(self):\n    pass\n\n\ndef step(self):\n    self.x = 1 / 0\n');
  await page.evaluate(() => window.__benseditor.play());
  await page.waitForTimeout(2500);
  const errorText = await page.locator('.game-error').textContent();
  check('the error box appears', await page.evaluate(() => document.querySelector('.game-error')?.hidden === false));
  check('it names the Python file and line', errorText.includes('obj_player.py line 6'), errorText.slice(0, 200));
  check('it shows the offending line', errorText.includes('1 / 0'));

  console.log('\n=== switching language in settings ===');
  await page.evaluate(() => window.__benseditor.game.stop());
  await page.locator('button', { hasText: 'Settings' }).click();
  await page.waitForSelector('.modal-box');
  check('settings show Python selected', await page.locator('.modal-box input[name=language][value=python]').isChecked());
  check('and warn that scripts are not translated', (await page.locator('.modal-box').textContent()).includes('not translated'));
  await page.locator('.modal-box input[name=language][value=luau]').check();
  await page.locator('.modal-actions .primary').click();
  await page.waitForTimeout(200);
  check('the switch is recorded', await page.evaluate(() => !('language' in window.__benseditor.store.project.config)));
  await page.evaluate(() => window.__benseditor.store.undo());
  await page.waitForTimeout(200);
  check('and undoable', await page.evaluate(() => window.__benseditor.store.project.config.language === 'python'));

  console.log('\n=== exporting a Python game ===');
  await page.evaluate(() => window.__benseditor.openAsset('object', 'obj_player'));
  await page.waitForSelector('.object-editor');
  await setSource(PLAYER);
  const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
  await page.getByRole('button', { name: 'Export game' }).click();
  const download = await downloadPromise;
  const exported = join(outDir, 'exported-python-game.html');
  await download.saveAs(exported);
  const html = readFileSync(exported, 'utf8');
  check('the export is self-contained', !html.includes('src="'));
  check('the export carries the Python player, not the Luau VM', html.includes('__frame_packed') && !html.includes('roblox.luau'), `${(html.length / 1024).toFixed(0)} KB`);
  console.log(`   exported ${(html.length / 1024 / 1024).toFixed(2)} MB`);

  const player = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const playerErrors = [];
  player.on('console', (m) => m.type() === 'error' && playerErrors.push(m.text()));
  player.on('pageerror', (e) => playerErrors.push(String(e)));
  await player.goto(pathToFileURL(exported).href, { waitUntil: 'load' });
  await player.waitForSelector('#game', { timeout: 30000 });
  await player.waitForTimeout(4000);
  const stats = await player.evaluate(() => {
    const canvas = document.getElementById('game');
    const gl = canvas.getContext('webgl2');
    if (!gl) return { error: 'no webgl2' };
    const p = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
    let green = 0;
    for (let i = 0; i < p.length; i += 4) if (p[i + 1] > 150 && p[i] < 80) green++;
    return { width: canvas.width, green };
  });
  check('the exported Python game renders from file://', (stats.green ?? 0) > 500, JSON.stringify(stats));
  check('no player error box', (await player.locator('.player-error').count()) === 0, (await player.locator('.player-error').textContent().catch(() => '')) ?? '');
  check('no player console errors', playerErrors.length === 0, playerErrors.slice(0, 2).join(' | '));

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
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
