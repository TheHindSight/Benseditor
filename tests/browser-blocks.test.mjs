/**
 * Block mode, end to end in Chromium.
 *
 * A new project in Blocks: objects open in the Scratch-style block editor
 * (Blockly, zelos renderer), blocks compile to the project's language on
 * every change, the event checklist adds hats, the generated code can be
 * viewed, Ctrl+Z inside the workspace undoes a block (not the project), an
 * object converts to code, the game runs on the generated script, the mode
 * round-trips through Settings, and nothing Blockly-shaped is ever fetched.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const outDir = join(root, 'test-output');
mkdirSync(outDir, { recursive: true });

const PORT = 4351;
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

/** A draw hat with a filled rectangle at the instance's position. */
const DRAW_WORKSPACE = {
  blocks: {
    languageVersion: 0,
    blocks: [
      {
        type: 'bs_event_step',
        x: 20,
        y: 20,
        inputs: {
          BODY: {
            block: {
              type: 'bs_change_field',
              fields: { FIELD: 'x' },
              inputs: { VALUE: { shadow: { type: 'math_number', fields: { NUM: 2 } } } },
            },
          },
        },
      },
      {
        type: 'bs_event_draw',
        x: 20,
        y: 200,
        inputs: {
          BODY: {
            block: {
              type: 'bs_draw_set_color',
              inputs: { COLOUR: { shadow: { type: 'bs_colour', fields: { COLOUR: 'c_green' } } } },
              next: {
                block: {
                  type: 'bs_draw_rectangle',
                  inputs: {
                    X1: { shadow: { type: 'bs_get_field', fields: { FIELD: 'x' } } },
                    Y1: { shadow: { type: 'bs_get_field', fields: { FIELD: 'y' } } },
                    X2: {
                      block: {
                        type: 'math_arithmetic',
                        fields: { OP: 'ADD' },
                        inputs: {
                          A: { shadow: { type: 'bs_get_field', fields: { FIELD: 'x' } } },
                          B: { shadow: { type: 'math_number', fields: { NUM: 40 } } },
                        },
                      },
                    },
                    Y2: {
                      block: {
                        type: 'math_arithmetic',
                        fields: { OP: 'ADD' },
                        inputs: {
                          A: { shadow: { type: 'bs_get_field', fields: { FIELD: 'y' } } },
                          B: { shadow: { type: 'math_number', fields: { NUM: 40 } } },
                        },
                      },
                    },
                    OUTLINE: { shadow: { type: 'logic_boolean', fields: { BOOL: 'FALSE' } } },
                  },
                },
              },
            },
          },
        },
      },
    ],
  },
};

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
  const requests = [];
  page.on('request', (request) => requests.push(request.url()));

  await page.addInitScript(() => localStorage.clear());
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('.asset-group');
  const requestsBefore = requests.length;

  console.log('\n=== a new project in block mode ===');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.waitForSelector('.modal-box');
  const discard = page.locator('.modal-box').getByRole('button', { name: 'Discard' });
  if (await discard.isVisible().catch(() => false)) {
    await discard.click();
    await page.waitForSelector('.modal-box input[type=text]');
  }
  check('the dialog offers a scripting mode', (await page.locator('.modal-box input[name=scripting]').count()) === 2);
  await page.locator('.modal-box input[name=scripting][value=blocks]').check();
  await page.locator('.modal-box input[type=text]').fill('Block Game');
  await page.locator('.modal-box').getByRole('button', { name: 'Create' }).click();
  await page.waitForTimeout(300);
  check('the project records block mode', await page.evaluate(() => window.__benseditor.store.project.config.scripting === 'blocks'));
  check('Blockly is not loaded until a block editor opens', !requests.slice(requestsBefore).some((url) => /blockly|zelos/i.test(url)));

  console.log('\n=== a new object opens as blocks ===');
  await page.locator('.asset-group', { hasText: 'Objects' }).locator('button.mini', { hasText: '+' }).click();
  await page.waitForSelector('.modal-box select');
  check('templates are disabled in block mode', await page.locator('.modal-box select').isDisabled());
  await page.locator('.modal-box input[type=text]').fill('obj_box');
  await page.locator('.modal-box').getByRole('button', { name: 'Create' }).click();
  await page.waitForSelector('.block-editor');
  await page.waitForSelector('.injectionDiv', { timeout: 30000, state: 'attached' });
  await page.waitForTimeout(300);
  const box = await page.locator('.injectionDiv').first().boundingBox();
  check('the block editor renders a Blockly workspace with real size', !!box && box.height > 100 && box.width > 300, JSON.stringify(box));
  check('with the zelos renderer', await page.evaluate(() => window.__benseditor.blockly?.getMainWorkspace()?.getRenderer()?.name === 'zelos'));
  const created = await page.evaluate(() => window.__benseditor.store.object('obj_box'));
  check('the object carries blocks with create and step hats', created.def.blocks?.blocks?.blocks?.length === 2, JSON.stringify(created.def.blocks).slice(0, 80));
  check('and its script is generated code', created.source.includes('function obj.step(self)') && created.source.includes('generated from blocks'), created.source.slice(0, 120));
  const defined = await page.locator('.event.defined span:nth-child(2)').allTextContents();
  check('the event checklist reads the generated code', defined.includes('Create') && defined.includes('Step'), defined.join(','));
  const external = requests.filter((url) => !url.startsWith(URL) && !url.startsWith('data:'));
  check('nothing was fetched from anywhere but the app', external.length === 0, external.join(','));
  check('no Blockly media was requested', !requests.some((url) => /\/media\//.test(url)), requests.filter((url) => /media/.test(url)).join(','));

  console.log('\n=== the checklist adds hats ===');
  await page.locator('.event:not(.defined)', { hasText: 'Draw' }).first().click();
  await page.waitForTimeout(400);
  const withDraw = await page.evaluate(() => window.__benseditor.store.object('obj_box'));
  check('a third hat appears in the workspace', withDraw.def.blocks.blocks.blocks.length === 3);
  check('and the draw event in the code', withDraw.source.includes('function obj.draw(self)'));
  check('the workspace shows three hats', await page.evaluate(() => window.__benseditor.blockly.getMainWorkspace().getTopBlocks(false).length === 3));

  console.log('\n=== editing the workspace regenerates the script ===');
  await page.evaluate((state) => {
    // Load a workspace the way a user would build it, through Blockly itself,
    // so the change listener sees a real edit.
    const Blockly = window.__benseditor.blockly;
    Blockly.serialization.workspaces.load(state, Blockly.getMainWorkspace());
  }, DRAW_WORKSPACE);
  await page.waitForTimeout(600);
  const edited = await page.evaluate(() => window.__benseditor.store.object('obj_box'));
  check('the new blocks were saved', edited.def.blocks.blocks.blocks.length === 2 && edited.def.blocks.blocks.blocks[1].type === 'bs_event_draw');
  check('the script compiled from them', edited.source.includes('draw_rectangle') && edited.source.includes('self.x += 2') || edited.source.includes('self.x = self.x + 2'), edited.source);
  check('the Luau has no goto', !edited.source.includes('goto'));

  await page.locator('.block-view-code').click();
  await page.waitForTimeout(150);
  check('View code shows the generated Luau', (await page.locator('.block-code').textContent()).includes('draw_rectangle'));
  check('highlighted', (await page.locator('.block-code .tok-engine').count()) > 0);

  console.log('\n=== undo inside the workspace is Blockly\'s ===');
  const beforeUndo = await page.evaluate(() => window.__benseditor.store.project.objects.length);
  await page.locator('.injectionDiv').first().click({ position: { x: 400, y: 300 } });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(400);
  check('Ctrl+Z in the workspace did not undo the project', (await page.evaluate(() => window.__benseditor.store.project.objects.length)) === beforeUndo && (await page.evaluate(() => window.__benseditor.store.project.config.scripting === 'blocks')));

  console.log('\n=== the game runs on the generated code ===');
  await page.evaluate((state) => {
    const Blockly = window.__benseditor.blockly;
    Blockly.serialization.workspaces.load(state, Blockly.getMainWorkspace());
  }, DRAW_WORKSPACE);
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const store = window.__benseditor.store;
    store.commit('place', () => {
      store.room('rm_main').instances.push({ id: 'inst_1', object: 'obj_box', x: 100, y: 100, xscale: 1, yscale: 1, angle: 0 });
    });
  });
  await page.evaluate(() => window.__benseditor.play());
  await page.waitForTimeout(2500);
  check('play shows no error', await page.evaluate(() => document.querySelector('.game-error')?.hidden !== false), await page.locator('.game-error').textContent().catch(() => ''));
  const green = await page.evaluate(() => {
    const canvas = document.querySelector('.game-canvas');
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ?? canvas.getContext('webgl2');
    const p = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
    let green = 0;
    for (let i = 0; i < p.length; i += 4) if (p[i + 1] > 150 && p[i] < 80) green++;
    return green;
  });
  check('the blocks drew their rectangle', green > 500, String(green));
  await page.evaluate(() => window.__benseditor.game.stop());

  console.log('\n=== convert to code ===');
  await page.evaluate(() => window.__benseditor.openAsset('object', 'obj_box'));
  await page.waitForSelector('.block-editor');
  await page.locator('.block-convert').click();
  await page.waitForSelector('.modal-box');
  await page.locator('.modal-actions .primary').click();
  await page.waitForSelector('.object-script .code-editor');
  const converted = await page.evaluate(() => window.__benseditor.store.object('obj_box'));
  check('the blocks are gone', !('blocks' in converted.def));
  check('the generated code stays', converted.source.includes('draw_rectangle'));
  check('the object now opens in the text editor', (await page.locator('.block-editor').count()) === 0);
  check('with an offer to start from blocks again', (await page.locator('.start-from-blocks').count()) === 1);
  await page.evaluate(() => window.__benseditor.store.undo());
  await page.waitForSelector('.block-editor');
  check('undoing the conversion brings the blocks back', (await page.locator('.block-editor').count()) === 1);

  console.log('\n=== switching modes in settings ===');
  await page.locator('button', { hasText: 'Settings' }).click();
  await page.waitForSelector('.modal-box');
  check('settings show Blocks selected', await page.locator('.modal-box input[name=scripting][value=blocks]').isChecked());
  await page.locator('.modal-box input[name=scripting][value=code]').check();
  await page.locator('.modal-actions .primary').click();
  await page.waitForTimeout(300);
  check('code mode shows the object as text', (await page.locator('.object-script .code-editor').count()) === 1 && (await page.locator('.block-editor').count()) === 0);
  check('the blocks are kept on the object', await page.evaluate(() => !!window.__benseditor.store.object('obj_box').def.blocks));
  await page.locator('button', { hasText: 'Settings' }).click();
  await page.waitForSelector('.modal-box');
  await page.locator('.modal-box input[name=scripting][value=blocks]').check();
  await page.locator('.modal-actions .primary').click();
  await page.waitForSelector('.block-editor');
  check('block mode reopens the object as blocks', (await page.locator('.block-editor').count()) === 1);

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
