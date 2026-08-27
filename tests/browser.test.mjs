/**
 * Browser smoke test.
 *
 * Drives the real app in Chromium: the editors, the asset tree, undo, and the
 * game itself. Reads pixels back out of the WebGL canvas, because "it rendered"
 * is the one claim the Node engine tests cannot make.
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

const PORT = 4317;
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

  // Start from a clean slate so a stale autosave cannot mask a regression.
  await page.addInitScript(() => localStorage.clear());
  await page.goto(URL, { waitUntil: 'load' });

  console.log('\n=== shell ===');
  check('title', (await page.title()) === 'Benseditor');

  // allTextContents() does not auto-wait, so make sure the app has mounted.
  await page.waitForSelector('.asset-group');
  const groups = await page.locator('.asset-group h3').allTextContents();
  check('asset groups present', ['Sprites', 'Objects', 'Rooms', 'Scripts'].every((g) => groups.includes(g)),
    groups.join(','));
  const spriteNames = await page.locator('.asset-group:nth-child(1) .asset-name').allTextContents();
  check('demo sprites listed', spriteNames.length === 3, spriteNames.join(','));
  check('start room badge shown', (await page.locator('.badge').first().textContent()) === 'start');
  check('room editor opened by default', await page.locator('.room-editor').isVisible());

  console.log('\n=== room editor ===');
  const objectEntries = await page.locator('.object-entry').allTextContents();
  check('object palette populated', objectEntries.length === 4, objectEntries.join(','));
  const roomPixels = await page.evaluate(() => {
    const canvas = document.querySelector('.room-view');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const seen = new Set();
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0) seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
    }
    return seen.size;
  });
  check('room canvas drew the layout', roomPixels > 4, `${roomPixels} colours`);

  const beforeInstances = await page.evaluate(
    () => window.__benseditor.store.room('rm_main').instances.length,
  );
  await page.locator('.object-entry').nth(1).click(); // obj_wall
  const box = await page.locator('.room-view').boundingBox();
  await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.6);
  const afterInstances = await page.evaluate(
    () => window.__benseditor.store.room('rm_main').instances.length,
  );
  check('clicking placed an instance', afterInstances === beforeInstances + 1,
    `${beforeInstances} -> ${afterInstances}`);

  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(
    () => window.__benseditor.store.room('rm_main').instances.length,
  );
  check('Ctrl+Z removed it again', undone === beforeInstances, `${undone}`);

  await page.screenshot({ path: join(outDir, 'room-editor.png') });

  console.log('\n=== sprite editor ===');
  await page.evaluate(() => window.__benseditor.openAsset('sprite', 'spr_player'));
  await page.waitForSelector('.sprite-editor');
  check('sprite editor mounted', await page.locator('.sprite-editor').isVisible());
  check('tool buttons present', (await page.locator('.tool-grid button').count()) === 12,
    String(await page.locator('.tool-grid button').count()));
  check('palette rendered', (await page.locator('.swatch').count()) === 16,
    String(await page.locator('.swatch').count()));
  check('frame strip has one frame', (await page.locator('.frame').count()) === 1);

  const beforePixels = await page.evaluate(
    () => window.__benseditor.store.sprite('spr_player').frames[0],
  );
  const view = await page.locator('.pixel-view').boundingBox();
  await page.mouse.move(view.x + view.width / 2, view.y + view.height / 2);
  await page.mouse.down();
  await page.mouse.move(view.x + view.width / 2 + 24, view.y + view.height / 2 + 24, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const afterPixels = await page.evaluate(
    () => window.__benseditor.store.sprite('spr_player').frames[0],
  );
  check('drawing changed the sprite', beforePixels !== afterPixels);

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  const restored = await page.evaluate(
    () => window.__benseditor.store.sprite('spr_player').frames[0],
  );
  check('undo restored the pixels', restored === beforePixels);

  // Add a frame, then confirm the strip and the stored data agree.
  await page.locator('.frame-actions button').first().click();
  await page.waitForTimeout(120);
  check('add-frame produced two frames',
    (await page.locator('.frame').count()) === 2 &&
      (await page.evaluate(() => window.__benseditor.store.sprite('spr_player').frames.length)) === 2);

  // Undo it: a second, blank frame would make the player animate in and out of
  // view and break the pixel checks further down.
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  check('undo removed the extra frame',
    (await page.evaluate(() => window.__benseditor.store.sprite('spr_player').frames.length)) === 1);

  await page.screenshot({ path: join(outDir, 'sprite-editor.png') });

  console.log('\n=== tileset editor ===');
  await page.evaluate(() => window.__benseditor.openAsset('tileset', 'ts_stone'));
  await page.waitForSelector('.tileset-editor');
  check('tileset editor mounted', await page.locator('.tileset-editor').isVisible());

  const solidBefore = await page.evaluate(
    () => window.__benseditor.store.tileset('ts_stone').solid.filter(Boolean).length,
  );
  check('demo tileset has solid tiles', solidBefore === 2, String(solidBefore));

  // Click the third tile (index 2, not solid) to make it solid.
  const sheet = await page.locator('.tileset-view').boundingBox();
  const tileSize = sheet.width / 4;
  await page.mouse.click(sheet.x + tileSize * 2.5, sheet.y + sheet.height / 2);
  await page.waitForTimeout(150);
  const solidAfter = await page.evaluate(
    () => window.__benseditor.store.tileset('ts_stone').solid,
  );
  check('clicking a tile toggles solid', solidAfter[2] === true, JSON.stringify(solidAfter));

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  check('undo restores solidity', await page.evaluate(
    () => window.__benseditor.store.tileset('ts_stone').solid[2] === false,
  ));

  await page.screenshot({ path: join(outDir, 'tileset-editor.png') });

  console.log('\n=== tile painting ===');
  await page.evaluate(() => window.__benseditor.openAsset('room', 'rm_main'));
  await page.waitForSelector('.room-editor');
  await page.getByRole('button', { name: 'Tiles', exact: true }).click();
  await page.waitForTimeout(150);
  check('tiles panel shown', await page.locator('.panel-tiles').isVisible());
  check('demo layer listed', (await page.locator('.layer-row').count()) === 1,
    String(await page.locator('.layer-row').count()));
  check('tile palette built', (await page.locator('.tile-swatch').count()) === 5,
    String(await page.locator('.tile-swatch').count()));

  const tilesBefore = await page.evaluate(
    () => window.__benseditor.store.room('rm_main').layers[0].tiles.filter((t) => t >= 0).length,
  );

  // Pick tile 0 and paint on an empty part of the room.
  await page.locator('.tile-swatch').nth(1).click();
  const roomBox = await page.locator('.room-view').boundingBox();
  await page.mouse.click(roomBox.x + roomBox.width * 0.7, roomBox.y + roomBox.height * 0.25);
  await page.waitForTimeout(150);

  const tilesAfter = await page.evaluate(
    () => window.__benseditor.store.room('rm_main').layers[0].tiles.filter((t) => t >= 0).length,
  );
  check('painting added a tile', tilesAfter === tilesBefore + 1, `${tilesBefore} -> ${tilesAfter}`);

  // Right-click erases it again.
  await page.mouse.click(roomBox.x + roomBox.width * 0.7, roomBox.y + roomBox.height * 0.25, {
    button: 'right',
  });
  await page.waitForTimeout(150);
  const tilesErased = await page.evaluate(
    () => window.__benseditor.store.room('rm_main').layers[0].tiles.filter((t) => t >= 0).length,
  );
  check('right-click erases a tile', tilesErased === tilesBefore, `${tilesErased}`);

  await page.screenshot({ path: join(outDir, 'tile-painting.png') });
  await page.getByRole('button', { name: 'Instances', exact: true }).click();

  console.log('\n=== object editor ===');
  await page.evaluate(() => window.__benseditor.openAsset('object', 'obj_player'));
  await page.waitForSelector('.object-editor');
  const defined = await page.locator('.event.defined span:nth-child(2)').allTextContents();
  check('events detected from Luau source',
    defined.includes('Create') && defined.includes('Step') && defined.includes('Collision'),
    defined.join(','));
  check('undefined events not marked', !defined.includes('Draw GUI'), defined.join(','));
  check('code editor highlights Luau', (await page.locator('.tok-keyword').count()) > 5,
    String(await page.locator('.tok-keyword').count()));

  const addedBefore = await page.evaluate(
    () => window.__benseditor.store.object('obj_player').source.includes('draw_gui'),
  );
  await page.locator('.event:not(.defined)').first().click();
  await page.waitForTimeout(150);
  const stubAdded = await page.evaluate(
    () => window.__benseditor.store.object('obj_player').source,
  );
  check('clicking an event added a stub', !addedBefore && /function obj\.\w+\(/.test(stubAdded));
  check('module still ends with return', /return\s+obj\s*$/.test(stubAdded.trim()),
    stubAdded.trim().slice(-40));

  await page.screenshot({ path: join(outDir, 'object-editor.png') });

  console.log('\n=== editing behaviour ===');
  const typeInto = async (text) => {
    await page.locator('.code-input').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type(text);
    await page.keyboard.press('Escape');
  };
  const tailLines = async (count) =>
    page.evaluate(
      (n) => document.querySelector('.code-input').value.split('\n').slice(-n),
      count,
    );

  await typeInto('if x then');
  await page.keyboard.press('Enter');
  await page.keyboard.type('y = 1');
  // Enter after `then` indents, and closes the block: the caret is on the
  // indented line with the new `end` below it.
  let lines = await tailLines(2);
  check('Enter after `then` indents one level', lines[0].startsWith('\ty = 1'),
    JSON.stringify(lines));
  check('and closes the block', lines[1] === 'end', JSON.stringify(lines));

  await page.keyboard.press('Enter');
  await page.keyboard.type('z = 2');
  lines = await tailLines(3);
  check('new line keeps the indentation', lines[1] === '\tz = 2', JSON.stringify(lines));
  check('the block still closes once', lines[2] === 'end', JSON.stringify(lines));

  await typeInto('local t = ');
  await page.keyboard.type('(');
  let tail = (await tailLines(1))[0];
  check('typing ( inserts the pair', tail.endsWith('()'), JSON.stringify(tail));

  await page.keyboard.type('1');
  await page.keyboard.type(')');
  tail = (await tailLines(1))[0];
  check('typing ) steps over the auto-inserted one', tail.endsWith('(1)'), JSON.stringify(tail));

  await typeInto('local s = ');
  await page.keyboard.type('"');
  tail = (await tailLines(1))[0];
  check('quotes auto-pair too', tail.endsWith('""'), JSON.stringify(tail));

  await typeInto('local u = ');
  await page.keyboard.type('[');
  await page.keyboard.press('Backspace');
  tail = (await tailLines(1))[0];
  check('Backspace removes an empty pair', tail.endsWith('local u = '), JSON.stringify(tail));

  await typeInto('local cfg = ');
  await page.keyboard.type('{');
  await page.keyboard.press('Enter');
  lines = await tailLines(3);
  check('Enter inside a pair puts the closer on its own line',
    lines[0].endsWith('{') && lines[1] === '\t' && lines[2] === '}',
    JSON.stringify(lines));

  console.log('\n=== autocomplete ===');
  // Put the caret on a fresh line inside the script and type a prefix.
  await page.locator('.code-input').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('keyb');
  await page.waitForSelector('.code-complete:not([hidden])', { timeout: 5000 });

  const suggestions = await page.locator('.complete-name').allTextContents();
  check('popup lists matching engine functions',
    suggestions.includes('keyboard_check') && suggestions.includes('keyboard_check_pressed'),
    suggestions.slice(0, 5).join(','));
  check('signatures shown', (await page.locator('.complete-sig').first().textContent()) === '(key)',
    await page.locator('.complete-sig').first().textContent());

  await page.keyboard.press('Enter');
  await page.waitForTimeout(120);
  const afterAccept = await page.evaluate(() => {
    const ta = document.querySelector('.code-input');
    return { value: ta.value, caret: ta.selectionStart };
  });
  check('accepting inserted the call', afterAccept.value.includes('keyboard_check()'),
    afterAccept.value.slice(-40));
  check('caret landed inside the parentheses',
    afterAccept.value.slice(afterAccept.caret, afterAccept.caret + 1) === ')',
    JSON.stringify(afterAccept.value.slice(afterAccept.caret - 3, afterAccept.caret + 2)));
  check('popup closed after accepting', await page.locator('.code-complete').isHidden());

  // Arrow keys move the selection.
  await page.keyboard.type('"');
  await page.waitForTimeout(100);
  await page.keyboard.type('obj_');
  await page.waitForSelector('.code-complete:not([hidden])', { timeout: 5000 });
  const assetSuggestions = await page.locator('.complete-name').allTextContents();
  check('string literals complete asset names',
    assetSuggestions.includes('obj_wall') && assetSuggestions.includes('obj_coin'),
    assetSuggestions.slice(0, 5).join(','));

  await page.keyboard.press('ArrowDown');
  const selected = await page.locator('.complete-item.selected .complete-name').textContent();
  check('ArrowDown moves the selection', selected === assetSuggestions[1], `${selected}`);
  await page.keyboard.press('Escape');
  check('Escape dismisses', await page.locator('.code-complete').isHidden());

  // Roblox namespaces resolve by receiver.
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('task.');
  await page.waitForSelector('.code-complete:not([hidden])', { timeout: 5000 });
  const taskMembers = await page.locator('.complete-name').allTextContents();
  check('task. completes the scheduler', taskMembers.includes('spawn') && taskMembers.includes('wait'),
    taskMembers.join(','));
  await page.keyboard.press('Escape');

  await page.keyboard.type('X');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('game:Get');
  await page.waitForSelector('.code-complete:not([hidden])', { timeout: 5000 });
  const gameMembers = await page.locator('.complete-name').allTextContents();
  check('game: completes GetService', gameMembers.includes('GetService'), gameMembers.join(','));
  await page.keyboard.press('Escape');

  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('RunService.');
  await page.waitForSelector('.code-complete:not([hidden])', { timeout: 5000 });
  const runMembers = await page.locator('.complete-name').allTextContents();
  check('RunService. completes its signals',
    runMembers.includes('Heartbeat') && runMembers.includes('RenderStepped'), runMembers.join(','));
  await page.keyboard.press('Escape');

  // Method completion after a colon.
  await page.keyboard.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('self:pl');
  await page.waitForSelector('.code-complete:not([hidden])', { timeout: 5000 });
  const methods = await page.locator('.complete-name').allTextContents();
  check('self: completes instance methods', methods.includes('place_meeting'), methods.join(','));

  // Capture the popup while it is still open.
  await page.screenshot({ path: join(outDir, 'autocomplete.png') });
  await page.locator('.code-complete').screenshot({ path: join(outDir, 'autocomplete-popup.png') });
  await page.keyboard.press('Escape');

  // The scratch edits above do not need undoing: the next section replaces the
  // whole project, and the section after that restores a fresh demo.

  console.log('\n=== new project ===');

  /** Open the New Project dialog, clearing the unsaved-changes prompt first. */
  const openNewProjectDialog = async () => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.waitForSelector('.modal-box');
    const discard = page.locator('.modal-box').getByRole('button', { name: 'Discard' });
    if (await discard.isVisible().catch(() => false)) {
      await discard.click();
      await page.waitForSelector('.modal-box input[type=text]');
    }
  };

  check('unsaved work prompts before discarding', await (async () => {
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await page.waitForSelector('.modal-box');
    const prompted = await page.locator('.modal-box').getByRole('button', { name: 'Discard' }).isVisible().catch(() => false);
    await page.locator('.modal-box').getByRole('button', { name: 'Cancel' }).click();
    await page.waitForTimeout(150);
    return prompted;
  })());
  check('cancelling kept the project', (await page.evaluate(
    () => window.__benseditor.store.project.objects.length,
  )) === 4);

  await openNewProjectDialog();
  await page.locator('.modal-box input[type=text]').fill('Blank Test');
  await page.locator('.modal-box').getByRole('button', { name: 'Create' }).click();
  await page.waitForTimeout(400);

  const blank = await page.evaluate(() => {
    const p = window.__benseditor.store.project;
    return {
      name: p.config.name,
      sprites: p.sprites.length,
      objects: p.objects.length,
      rooms: p.rooms.length,
      scripts: p.scripts.length,
      bg: p.rooms[0]?.backgroundColor,
      startRoom: p.config.startRoom,
    };
  });
  check('new project named correctly', blank.name === 'Blank Test', blank.name);
  check('project is empty', blank.sprites === 0 && blank.objects === 0 && blank.scripts === 0,
    JSON.stringify(blank));
  check('has one room, black', blank.rooms === 1 && blank.bg === '#000000', String(blank.bg));
  check('start room is valid', blank.startRoom === 'rm_main');
  check('asset tree shows the empty project', (await page.locator('.asset-item').count()) === 1,
    String(await page.locator('.asset-item').count()));

  // A blank project must still run rather than erroring.
  await page.getByRole('button', { name: '▶ Play' }).click();
  await page.waitForFunction(() => (window.__benseditor?.game?.frameMs ?? 0) > 0, { timeout: 60000 });
  await page.waitForTimeout(600);
  check('blank project runs', await page.locator('.game-error').isHidden());
  const blankPixel = await page.evaluate(() => {
    const canvas = document.querySelector('.game-canvas');
    const gl = canvas.getContext('webgl2');
    const p = new Uint8Array(4);
    gl.readPixels(canvas.width / 2, canvas.height / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
    return `${p[0]},${p[1]},${p[2]}`;
  });
  check('blank project renders black', blankPixel === '0,0,0', blankPixel);

  await page.screenshot({ path: join(outDir, 'new-project.png') });

  console.log('\n=== deleting the start room ===');
  // Regression: deleting the start room used to leave config.startRoom dangling,
  // which only surfaced on Play as "attempt to index nil with 'layers'".
  await page.evaluate(() => {
    const store = window.__benseditor.store;
    store.commit('add second room', () => {
      const room = JSON.parse(JSON.stringify(store.project.rooms[0]));
      room.name = 'rm_second';
      store.project.rooms.push(room);
    }, true);
  });
  await page.waitForTimeout(200);

  const startBefore = await page.evaluate(() => window.__benseditor.store.project.config.startRoom);
  check('start room is rm_main to begin with', startBefore === 'rm_main', startBefore);

  // Delete it through the UI, the way a user would.
  const roomItem = page.locator('.asset-item', { hasText: 'rm_main' }).first();
  await roomItem.click({ button: 'right' });
  await page.waitForSelector('.context-menu');
  await page.locator('.context-menu').getByRole('button', { name: 'Delete' }).click();
  await page.waitForSelector('.modal-box');
  await page.locator('.modal-box').getByRole('button', { name: 'Delete' }).click();
  await page.waitForTimeout(300);

  const startAfter = await page.evaluate(() => window.__benseditor.store.project.config.startRoom);
  check('start room moved to the surviving room', startAfter === 'rm_second', startAfter);

  // And it must still actually run.
  await page.evaluate(() => window.__benseditor.play());
  await page.waitForTimeout(1500);
  const brokeAfterDelete = !(await page.locator('.game-error').isHidden());
  check('game still runs after deleting the start room', !brokeAfterDelete,
    brokeAfterDelete ? (await page.locator('.game-error pre').textContent())?.slice(0, 160) : '');

  // Restore a clean demo through the same dialog, which also exercises the
  // "start from the demo" path.
  await openNewProjectDialog();
  await page.locator('.modal-box input[type=text]').fill('Demo Game');
  await page.locator('.modal-box select').selectOption('demo');
  await page.locator('.modal-box').getByRole('button', { name: 'Create' }).click();
  await page.waitForTimeout(400);
  check('demo template restores the starter project',
    (await page.evaluate(() => window.__benseditor.store.project.objects.length)) === 4);

  console.log('\n=== running the game ===');
  await page.getByRole('button', { name: '▶ Play' }).click();
  await page.waitForFunction(() => (window.__benseditor?.game?.frameMs ?? 0) > 0, { timeout: 60000 });
  await page.waitForTimeout(1500);

  check('no error panel', await page.locator('.game-error').isHidden());

  const stats = await page.evaluate(() => {
    const canvas = document.querySelector('.game-canvas');
    const gl = canvas.getContext('webgl2');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const seen = new Map();
    for (let i = 0; i < pixels.length; i += 4) {
      const key = (pixels[i] << 16) | (pixels[i + 1] << 8) | pixels[i + 2];
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    return {
      width: canvas.width,
      height: canvas.height,
      colours: seen.size,
      hasBrick: seen.has(0xab5236),
      hasPlayer: seen.has(0x29adff),
    };
  });
  console.log(`   canvas ${stats.width}x${stats.height}, ${stats.colours} colours`);
  check('canvas is room x scale', stats.width === 960 && stats.height === 576);
  check('walls rendered', stats.hasBrick);
  check('player rendered', stats.hasPlayer);

  const centroid = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('.game-canvas');
      const gl = canvas.getContext('webgl2');
      const p = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
      let sum = 0;
      let n = 0;
      for (let i = 0; i < p.length; i += 4) {
        if (p[i] === 0x29 && p[i + 1] === 0xad && p[i + 2] === 0xff) {
          sum += (i / 4) % canvas.width;
          n++;
        }
      }
      return n ? sum / n : -1;
    });

  await page.locator('.game-canvas').click();
  const before = await centroid();
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(900);
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(120);
  const after = await centroid();
  console.log(`   player centroid ${before.toFixed(0)} -> ${after.toFixed(0)}`);
  check('input moves the player', after > before + 20, `${before.toFixed(0)} -> ${after.toFixed(0)}`);

  // Tiles must be drawn by the engine, not just the editor.
  const stone = await page.evaluate(() => {
    const canvas = document.querySelector('.game-canvas');
    const gl = canvas.getContext('webgl2');
    const p = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
    let n = 0;
    for (let i = 0; i < p.length; i += 4) {
      if (p[i] === 0x7b && p[i + 1] === 0x72 && p[i + 2] === 0x68) n++;
    }
    return n;
  });
  check('tile layer rendered in the game', stone > 100, `${stone} stone pixels`);

  // The platform spans rows 8-11 (y 128-192) and columns 2-6 (x 32-112). Rise
  // into that band, then run left: solid tiles must stop the player at x~117
  // instead of letting it reach the border wall at x=21.
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(400);
  await page.keyboard.up('ArrowUp');
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(2600);
  await page.keyboard.up('ArrowLeft');
  await page.waitForTimeout(200);

  const stoppedAt = await centroid();
  console.log(`   player stopped at canvas x=${stoppedAt.toFixed(0)} (wall would be ~42)`);
  check('solid tiles block the player', stoppedAt > 180 && stoppedAt < 300,
    `centroid ${stoppedAt.toFixed(0)}`);

  const frameMs = await page.evaluate(() => window.__benseditor.game.frameMs);
  console.log(`   ${frameMs.toFixed(2)} ms/frame (software GL)`);
  check('within 60fps budget', frameMs < 16.6, `${frameMs.toFixed(2)} ms`);

  await page.screenshot({ path: join(outDir, 'game.png') });

  console.log('\n=== edits reach the running game ===');
  // Change the room background, replay, and confirm the clear colour follows.
  await page.evaluate(() => {
    const store = window.__benseditor.store;
    store.commit('test bg', () => {
      store.room('rm_main').backgroundColor = '#7e2553';
    });
  });
  const storedBg = await page.evaluate(
    () => window.__benseditor.store.room('rm_main').backgroundColor,
  );
  console.log('   store background is now', storedBg);

  const replay = await page.evaluate(async () => {
    const before = window.__benseditor.game.frameMs;
    try {
      await window.__benseditor.play();
      return { ok: true, before };
    } catch (error) {
      return { ok: false, before, message: String(error?.stack ?? error) };
    }
  });
  await page.waitForTimeout(1500);
  console.log('   play() resolved ok?', replay.ok, replay.message ?? '');
  console.log('   frameMs after replay:', await page.evaluate(() => window.__benseditor.game.frameMs));
  if (!(await page.locator('.game-error').isHidden())) {
    console.log('   FULL ERROR:\n' + (await page.locator('.game-error pre').textContent()));
  }
  const newBg = await page.evaluate(() => {
    const canvas = document.querySelector('.game-canvas');
    const gl = canvas.getContext('webgl2');
    const p = new Uint8Array(4);
    // Middle of the room, away from walls and the HUD.
    gl.readPixels(canvas.width / 2, canvas.height / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
    return '#' + [p[0], p[1], p[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  });
  check('editor change took effect on replay', newBg === '#7e2553', newBg);

  console.log('\n=== roblox layer in the running demo ===');
  // The demo controller persists a best score through DataStoreService.
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('benseditor.datastore.')) localStorage.removeItem(key);
    }
  });
  await page.evaluate(() => window.__benseditor.play());
  await page.waitForFunction(() => (window.__benseditor?.game?.frameMs ?? 0) > 0, { timeout: 60000 });

  await page.waitForTimeout(500);
  const saved = await page.evaluate(() =>
    localStorage.getItem('benseditor.datastore.demo/best'),
  );
  console.log('   persisted best score:', saved);
  check('DataStore wrote through to localStorage', saved === '0', String(saved));

  // Collect the coin at (328, 248). The player starts at (240, 208) and its
  // collision box is y-7..y+8, so it needs to sit around y=244 -- drop too far
  // and the boxes touch at exactly one pixel and never overlap.
  const goldPixels = () =>
    page.evaluate(() => {
      const canvas = document.querySelector('.game-canvas');
      const gl = canvas.getContext('webgl2');
      const p = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, p);
      let n = 0;
      for (let i = 0; i < p.length; i += 4) {
        if (p[i] === 0xff && p[i + 1] === 0xec && p[i + 2] === 0x27) n++;
      }
      return n;
    });

  const goldBefore = await goldPixels();

  await page.locator('.game-canvas').click();
  await page.keyboard.down('ArrowDown');
  await page.waitForTimeout(300);
  await page.keyboard.up('ArrowDown');
  await page.keyboard.down('ArrowRight');
  await page.waitForTimeout(1200);
  await page.keyboard.up('ArrowRight');
  await page.waitForTimeout(400);

  const goldAfter = await goldPixels();
  console.log(`   coin pixels: ${goldBefore} -> ${goldAfter}`);
  check('a coin was actually collected', goldAfter < goldBefore, `${goldBefore} -> ${goldAfter}`);

  const improved = await page.evaluate(() =>
    localStorage.getItem('benseditor.datastore.demo/best'),
  );
  console.log('   best after collecting:', improved);
  check('collecting a coin updated the save', Number(improved) >= 1, String(improved));

  const shared = await page.evaluate(() => window.__benseditor.game.frameMs > 0);
  check('game still running after storage writes', shared);
  check('no error panel from the roblox layer', await page.locator('.game-error').isHidden());

  await page.screenshot({ path: join(outDir, 'roblox-demo.png') });

  console.log('\n=== runtime errors point at the source ===');
  await page.evaluate(() => {
    const store = window.__benseditor.store;
    store.commit('break a script', () => {
      const entry = store.object('obj_controller');
      entry.source = [
        'local obj = {}',
        '',
        'function obj.step(self)',
        '\tlocal missing = instance_find("obj_nothing")',
        '\tself.x = missing.x',
        'end',
        '',
        'return obj',
      ].join('\n');
    });
  });
  await page.evaluate(() => window.__benseditor.play());
  await page.waitForTimeout(1500);

  check('a broken script stops the game', !(await page.locator('.game-error').isHidden()));
  const errText = (await page.locator('.game-error pre').textContent()) ?? '';
  check('error names the file and line', /obj_controller.*:5/.test(errText), errText.slice(0, 120));
  check('source excerpt shown', await page.locator('.error-source').isVisible());
  check('the offending line is the one highlighted',
    (await page.locator('.error-line.offending .error-code').textContent())?.includes('missing.x'),
    await page.locator('.error-line.offending .error-code').textContent());
  check('excerpt gives surrounding context',
    (await page.locator('.error-line').count()) >= 4,
    String(await page.locator('.error-line').count()));

  await page.screenshot({ path: join(outDir, 'script-error.png') });

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);

  console.log('\n=== the code editor scrolls in its own box ===');
  // A long script used to stretch the editor past the bottom of the window,
  // where `.panel-host` clipped it and there was nothing left to scroll.
  await page.evaluate(() => {
    const store = window.__benseditor.store;
    const lines = [];
    for (let i = 0; i < 400; i++) lines.push(`local padding_${i} = "${'x'.repeat(160)}"`);
    store.object('obj_coin').source = lines.join('\n');
    window.__benseditor.openAsset('object', 'obj_coin');
  });
  await page.waitForSelector('.code-editor');
  await page.waitForTimeout(300);

  const boxed = await page.evaluate(() => {
    const host = document.querySelector('.panel-host');
    const editor = document.querySelector('.code-editor');
    const area = document.querySelector('.code-input');
    return {
      pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      hostOverflow: host.scrollHeight - host.clientHeight,
      editorFits: Math.abs(editor.getBoundingClientRect().height - host.clientHeight) < 2,
      canScrollDown: area.scrollHeight > area.clientHeight,
      canScrollRight: area.scrollWidth > area.clientWidth,
    };
  });
  check('the window itself never scrolls', !boxed.pageScrolls);
  check('nothing overflows the panel', boxed.hostOverflow === 0, `${boxed.hostOverflow}px of overflow`);
  check('the editor is exactly the panel height', boxed.editorFits);
  check('the text area scrolls vertically', boxed.canScrollDown);
  check('the text area scrolls horizontally', boxed.canScrollRight);

  // The highlighting and the line numbers are moved to follow the textarea, so
  // they have to land in exactly the right place at the far end of the scroll.
  const aligned = await page.evaluate(() => {
    const area = document.querySelector('.code-input');
    const pre = document.querySelector('.code-highlight');
    const numbers = document.querySelector('.code-gutter-lines');
    const scroll = document.querySelector('.code-scroll');
    const gutter = document.querySelector('.code-gutter');

    area.scrollTop = 1e6;
    area.scrollLeft = 1e6;
    area.dispatchEvent(new Event('scroll'));

    // Only the visible lines are rendered, so the overlay begins at whatever
    // line the gutter begins at rather than at line 1.
    const rows = numbers.children;
    const lineHeight =
      rows[1].getBoundingClientRect().top - rows[0].getBoundingClientRect().top;
    const firstLine = Number(rows[0].textContent) - 1;
    const originY = firstLine * lineHeight - area.scrollTop;

    return {
      scrolled: area.scrollTop > 100 && area.scrollLeft > 100,
      firstLine,
      renderedRows: rows.length,
      driftX: Math.round(
        pre.getBoundingClientRect().left - (scroll.getBoundingClientRect().left - area.scrollLeft),
      ),
      driftY: Math.round(
        pre.getBoundingClientRect().top - (scroll.getBoundingClientRect().top + originY),
      ),
      gutterDrift: Math.round(
        numbers.getBoundingClientRect().top - (gutter.getBoundingClientRect().top + originY),
      ),
      lastLineVisible:
        rows[rows.length - 1].getBoundingClientRect().top < gutter.getBoundingClientRect().bottom,
    };
  });
  check('it really scrolled to the end', aligned.scrolled);
  check('only the lines on screen are rendered',
    aligned.firstLine > 0 && aligned.renderedRows < 400 / 2,
    `from line ${aligned.firstLine + 1}, ${aligned.renderedRows} rows of 400`);
  check('highlighting stays under the text', aligned.driftX === 0 && aligned.driftY === 0,
    `x ${aligned.driftX} y ${aligned.driftY}`);
  check('line numbers stay in step', aligned.gutterDrift === 0, `${aligned.gutterDrift}px`);
  check('the last line is reachable', aligned.lastLineVisible);

  await page.screenshot({ path: join(outDir, 'code-scroll.png') });

  // ---- editing commands ------------------------------------------------
  // Driven through the store so the object editor rebinds its code panel.
  // Written through the textarea rather than the store: `commit` skips the
  // change event when the value is already what it was, which would leave the
  // previous test's text sitting in the editor.
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
  const sourceNow = () => page.locator('.code-input').inputValue();

  console.log('\n=== the editor keeps the undo stack ===');
  // Auto-indent and auto-pairing used to assign to `value`, which wipes the
  // browser's undo history and made everything typed before them unrecoverable.
  await setSource('local x = 1\n');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('if x then');
  await page.keyboard.press('Enter');
  await page.keyboard.type('print(x');
  const typedOut = await sourceNow();
  check('auto-indent, auto-pairing and the closing end applied',
    typedOut === 'local x = 1\nif x then\n\tprint(x)\nend', JSON.stringify(typedOut));

  // Undo until the typing is gone. Counting presses would be brittle -- the
  // browser decides its own grouping -- so the claim is simply that it does get
  // back there, which before the rewrite it never could.
  let unwound = false;
  for (let i = 0; i < 30 && !unwound; i++) {
    await page.keyboard.press('Control+z');
    unwound = (await sourceNow()) === 'local x = 1\n';
  }
  check('undo unwinds all of it', unwound, JSON.stringify(await sourceNow()));

  console.log('\n=== indenting, commenting, moving lines ===');
  await setSource('local a = 1\nlocal b = 2\nlocal c = 3\n');
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Tab');
  check('Tab indents every selected line',
    (await sourceNow()) === '\tlocal a = 1\n\tlocal b = 2\n\tlocal c = 3\n',
    JSON.stringify(await sourceNow()));
  check('and keeps the selection', await page.evaluate(() => {
    const area = document.querySelector('.code-input');
    return area.selectionEnd - area.selectionStart > 30;
  }));

  await page.keyboard.press('Shift+Tab');
  check('Shift+Tab puts it back',
    (await sourceNow()) === 'local a = 1\nlocal b = 2\nlocal c = 3\n',
    JSON.stringify(await sourceNow()));

  await page.keyboard.press('Control+/');
  check('Ctrl+/ comments the selection',
    (await sourceNow()) === '-- local a = 1\n-- local b = 2\n-- local c = 3\n',
    JSON.stringify(await sourceNow()));
  await page.keyboard.press('Control+/');
  check('and toggles them back off',
    (await sourceNow()) === 'local a = 1\nlocal b = 2\nlocal c = 3\n',
    JSON.stringify(await sourceNow()));

  await setSource('one\ntwo\nthree\n');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('Alt+ArrowDown');
  check('Alt+Down moves the line', (await sourceNow()) === 'two\none\nthree\n',
    JSON.stringify(await sourceNow()));
  await page.keyboard.press('Shift+Alt+ArrowDown');
  check('Shift+Alt+Down duplicates it', (await sourceNow()) === 'two\none\none\nthree\n',
    JSON.stringify(await sourceNow()));
  await page.keyboard.press('Control+Shift+K');
  check('Ctrl+Shift+K deletes it', (await sourceNow()) === 'two\none\nthree\n',
    JSON.stringify(await sourceNow()));

  console.log('\n=== find and replace ===');
  await setSource('local a = 1\nlocal b = 2\nlocal c = 3\n');
  await page.keyboard.press('Control+f');
  await page.waitForSelector('.code-find:not([hidden])');
  await page.locator('.find-field').first().fill('local');
  await page.waitForTimeout(150);
  check('every match is counted',
    (await page.locator('.find-count').textContent()) === '1 of 3',
    await page.locator('.find-count').textContent());
  check('and highlighted in the text',
    (await page.evaluate(() => document.querySelectorAll('.ovl-match').length)) === 3);
  await page.keyboard.press('Enter');
  check('Enter steps to the next one',
    (await page.locator('.find-count').textContent()) === '2 of 3',
    await page.locator('.find-count').textContent());

  await page.locator('.find-field').nth(1).fill('const');
  await page.locator('.code-find').getByRole('button', { name: 'All' }).click();
  await page.waitForTimeout(200);
  check('Replace all rewrites them',
    (await sourceNow()) === 'const a = 1\nconst b = 2\nconst c = 3\n',
    JSON.stringify(await sourceNow()));
  await page.keyboard.press('Escape');
  check('Escape closes the bar', await page.locator('.code-find').isHidden());

  console.log('\n=== syntax and caret feedback ===');
  await setSource('local s = [==[ raw ]==]\n--[==[ block\ncomment ]==]\nfunction obj.step(self)\n\thelper(self.x)\nend\n');
  const marks = await page.evaluate(() => {
    const html = document.querySelector('.code-highlight').innerHTML;
    return {
      longString: /tok-string">\[==\[ raw \]==\]/.test(html),
      longComment: /tok-comment">--\[==\[ block\ncomment \]==\]/.test(html),
      declaration: /tok-fn">obj/.test(html) && /tok-fn">step/.test(html),
      call: /tok-call">helper/.test(html),
      self: /tok-self">self/.test(html),
    };
  });
  check('long strings are one token', marks.longString);
  check('long comments span lines', marks.longComment);
  check('a declared function name is marked', marks.declaration);
  check('so is a call', marks.call);
  check('and self', marks.self);

  await setSource('local t = (1 + (2 * 3))\n');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('End');
  await page.waitForTimeout(150);
  const caretUi = await page.evaluate(() => ({
    brackets: document.querySelectorAll('.ovl-bracket').length,
    activeLine: !document.querySelector('.code-active-line').hidden,
    gutter: !!document.querySelector('.code-gutter span.current'),
    status: document.querySelector('.code-status').textContent,
  }));
  check('the matching bracket pair is highlighted', caretUi.brackets === 2, String(caretUi.brackets));
  check('the caret line is marked', caretUi.activeLine && caretUi.gutter);
  check('the status bar reports the caret', /Ln 1, Col 24/.test(caretUi.status), caretUi.status);

  console.log('\n=== completions know where they are ===');
  await setSource('local obj = {}\n-- talk about instance_create here\nlocal y = 2\n');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  await page.keyboard.type(' inst');
  await page.waitForTimeout(250);
  check('nothing is offered inside a comment', await page.locator('.code-complete').isHidden());
  await page.keyboard.press('Escape');

  await setSource('local a = "spr\nlocal y = 2\n');
  await page.keyboard.press('Control+Home');
  await page.keyboard.press('End');
  await page.keyboard.press('Control+ ');
  await page.waitForTimeout(250);
  const inString = await page.evaluate(() =>
    [...document.querySelectorAll('.complete-name')].map((n) => n.textContent));
  check('asset names are offered inside a string',
    inString.length > 0 && inString.every((name) => name.startsWith('spr_')), inString.join(','));
  await page.keyboard.press('Escape');

  await setSource('local obj = {}\n\n');
  await page.keyboard.press('Control+End');
  await page.keyboard.type('insnum');
  await page.waitForTimeout(250);
  const fuzzy = await page.evaluate(() => ({
    names: [...document.querySelectorAll('.complete-name')].map((n) => n.textContent),
    doc: document.querySelector('.complete-doc').textContent,
  }));
  check('an abbreviation still finds the function',
    fuzzy.names[0] === 'instance_number', fuzzy.names.slice(0, 3).join(','));
  check('the manual describes it in the popup',
    fuzzy.doc === 'How many instances of the object are alive.', fuzzy.doc);
  await page.keyboard.press('Escape');
  await page.screenshot({ path: join(outDir, 'code-editor.png') });

  console.log('\n=== importing a sprite sheet ===');
  // A generated sheet with a margin and gaps, dropped on the Sprites group:
  // detection has real blank pixels to measure, so the dialog must arrive
  // pre-filled with the exact slicing.
  await page.evaluate(async () => {
    const sheet = document.createElement('canvas');
    sheet.width = 44; // 2px margin + 3 frames of 12 + 2 gaps of 3
    sheet.height = 16;
    const ctx = sheet.getContext('2d');
    for (const [i, colour] of ['#ff004d', '#00e436', '#29adff'].entries()) {
      ctx.fillStyle = colour;
      ctx.fillRect(2 + i * 15, 2, 12, 12);
    }
    const blob = await new Promise((resolve) => sheet.toBlob(resolve, 'image/png'));
    const dt = new DataTransfer();
    dt.items.add(new File([blob], 'hero-walk.png', { type: 'image/png' }));
    const target = document.querySelector('.asset-group');
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
  });
  await page.waitForSelector('.modal-box');
  check('dropping an image opens the import dialog',
    (await page.locator('.modal-box h2').textContent()) === 'Import sprite');
  check('the name comes from the file name',
    (await page.locator('.modal-box input[type=text]').inputValue()) === 'spr_hero_walk',
    await page.locator('.modal-box input[type=text]').inputValue());

  const sliceFields = page.locator('.modal-box input[type=number]');
  const slicing = [];
  for (let i = 0; i < 6; i++) slicing.push(await sliceFields.nth(i).inputValue());
  check('the grid was measured from the pixels',
    slicing.join(',') === '12,12,2,2,3,0', slicing.join(','));
  check('the readout counts the frames',
    /3 frames/.test(await page.locator('.modal-box .tile-readout').textContent()),
    await page.locator('.modal-box .tile-readout').textContent());

  await page.locator('.modal-box').getByRole('button', { name: 'Import' }).click();
  await page.waitForTimeout(300);
  const imported = await page.evaluate(() => {
    const sprite = window.__benseditor.store.sprite('spr_hero_walk');
    return sprite && {
      w: sprite.width, h: sprite.height,
      frames: sprite.frames.length,
      palette: sprite.palette.slice(0, 3),
    };
  });
  check('the sprite arrives cut into frames',
    imported && imported.w === 12 && imported.h === 12 && imported.frames === 3,
    JSON.stringify(imported));
  check('its palette comes from the art',
    imported && imported.palette.join() === '#ff004d,#00e436,#29adff',
    JSON.stringify(imported?.palette));

  console.log('\n=== object templates ===');
  await page.locator('.asset-group', { hasText: 'Objects' })
    .locator('button[title="New object"]').click();
  await page.waitForSelector('.modal-box select');
  const templates = await page.locator('.modal-box select option').allTextContents();
  check('a template picker is offered', templates.length >= 8, templates.join(','));

  await page.locator('.modal-box select').selectOption('player-topdown');
  // The demo project already has obj_player, so the suggestion must dedupe.
  check('the suggested name avoids a clash',
    (await page.locator('.modal-box input[type=text]').inputValue()) === 'obj_player2',
    await page.locator('.modal-box input[type=text]').inputValue());
  await page.locator('.modal-box').getByRole('button', { name: 'Create' }).click();
  await page.waitForTimeout(300);

  const templated = await page.evaluate(() => {
    const object = window.__benseditor.store.object('obj_player2');
    return object && { blockedBy: object.def.blockedBy, hasStep: object.source.includes('obj.step') };
  });
  check('the template arrives with movement code and blockers',
    templated && templated.hasStep && templated.blockedBy.join() === 'obj_wall,tiles',
    JSON.stringify(templated));

  console.log('\n=== the collision checklist ===');
  await page.waitForSelector('.object-editor');
  check('solid tiles and every other object are listed', await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.blocked-list .checkbox-row')];
    return rows.length >= 5 && rows[0].textContent.includes('Solid tiles');
  }));
  check('the template’s blockers arrive ticked', await page.evaluate(() => {
    const boxes = [...document.querySelectorAll('.blocked-list input')];
    const labels = [...document.querySelectorAll('.blocked-list .checkbox-row')].map((r) => r.textContent.trim());
    return boxes[0].checked && boxes[labels.indexOf('obj_wall')]?.checked;
  }));

  await page.locator('.blocked-list .checkbox-row').first().locator('input').click();
  await page.waitForTimeout(150);
  check('unticking writes through to the project', await page.evaluate(() => {
    const object = window.__benseditor.store.object('obj_player2');
    return object.def.blockedBy.join() === 'obj_wall';
  }));

  // obj_player2 and spr_hero_walk stay in the project: deleting them behind
  // their open editor tab would leave the tab pointing at nothing. They are
  // harmless — no instances, and every count-sensitive check already ran.

  console.log('\n=== blocks close themselves ===');
  const typeBlock = async (source, text) => {
    await setSource(source);
    await page.evaluate(() => {
      const area = document.querySelector('.code-input');
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    });
    await page.keyboard.type(text);
    await page.waitForTimeout(120);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(120);
    return sourceNow();
  };

  check('if ... then closes itself',
    (await typeBlock('', 'if x then')) === 'if x then\n\t\nend', JSON.stringify(await sourceNow()));
  check('for ... do closes itself',
    (await typeBlock('', 'for i = 1, 10 do')) === 'for i = 1, 10 do\n\t\nend',
    JSON.stringify(await sourceNow()));
  // The old rule matched `function …)` and so missed a return type entirely.
  check('a function with a return type closes itself',
    (await typeBlock('', 'local function axis(a: string): number')) ===
      'local function axis(a: string): number\n\t\nend',
    JSON.stringify(await sourceNow()));
  check('repeat closes with until',
    (await typeBlock('', 'repeat')) === 'repeat\n\t\nuntil ', JSON.stringify(await sourceNow()));

  // The half that matters: never leave a stray `end` behind.
  await setSource('if x then\n\t\nend\n');
  await page.evaluate(() => {
    const area = document.querySelector('.code-input');
    area.focus();
    area.setSelectionRange(11, 11);
  });
  await page.keyboard.type('if y then');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('a nested block adds exactly one end',
    (await sourceNow()) === 'if x then\n\tif y then\n\t\t\n\tend\nend\n',
    JSON.stringify(await sourceNow()));

  await setSource('function obj.step(self)\nend\n');
  await page.evaluate(() => {
    const area = document.querySelector('.code-input');
    area.focus();
    area.setSelectionRange(23, 23);
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('a block that already closes gains nothing',
    (await sourceNow()) === 'function obj.step(self)\n\t\nend\n', JSON.stringify(await sourceNow()));

  await setSource('-- if x then\n');
  await page.evaluate(() => {
    const area = document.querySelector('.code-input');
    area.focus();
    area.setSelectionRange(12, 12);
  });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('a keyword in a comment opens nothing',
    (await sourceNow()) === '-- if x then\n\n', JSON.stringify(await sourceNow()));

  console.log('\n=== bracket pairing ===');
  for (const [typed, expected] of [
    ['f(', 'f()'],
    ['t[', 't[]'],
    ['x = {', 'x = {}'],
  ]) {
    await setSource('');
    await page.keyboard.type(typed);
    await page.waitForTimeout(80);
    check(`${typed.slice(-1)} pairs`, (await sourceNow()) === expected,
      JSON.stringify(await sourceNow()));
  }

  await setSource('name\n');
  await page.evaluate(() => {
    const area = document.querySelector('.code-input');
    area.focus();
    area.setSelectionRange(0, 0);
  });
  await page.keyboard.type('(');
  check('typing ( in front of a word does not pair',
    (await sourceNow()) === '(name\n', JSON.stringify(await sourceNow()));

  // Enter must stay Enter when the suggestion is not what you are writing.
  await setSource('');
  await page.locator('.code-input').click();
  await page.keyboard.type('local n: number');
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('Enter does not accept a suggestion that only contains what you typed',
    (await sourceNow()) === 'local n: number\n', JSON.stringify(await sourceNow()));

  console.log('\n=== defects an adversarial review turned up ===');

  // A file whose first line is blank: lastIndexOf clamps a negative position to
  // zero and still inspects index 0, so line 1 used to report as line 2 and
  // every line command worked on the wrong line.
  await setSource('\nprint(1)');
  await page.evaluate(() => {
    const area = document.querySelector('.code-input');
    area.focus();
    area.setSelectionRange(4, 4);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.keyboard.press('Alt+ArrowUp');
  check('a leading blank line does not break line moves',
    (await sourceNow()) === 'print(1)\n', JSON.stringify(await sourceNow()));

  // Editing with the find bar open used to leave the recorded match offsets
  // pointing at the wrong characters, and Replace All spliced from them.
  await setSource('abc abc');
  await page.keyboard.press('Control+f');
  await page.locator('.find-field').first().fill('abc');
  await page.waitForTimeout(120);
  await page.locator('.code-input').click();
  await page.evaluate(() => {
    const area = document.querySelector('.code-input');
    area.focus();
    area.setSelectionRange(0, 0);
    document.execCommand('insertText', false, 'x');
  });
  await page.waitForTimeout(120);
  await page.locator('.find-field').nth(1).fill('Q');
  await page.locator('.code-find').getByRole('button', { name: 'All' }).click();
  await page.waitForTimeout(200);
  check('replace all follows edits made while the bar is open',
    (await sourceNow()) === 'xQ Q', JSON.stringify(await sourceNow()));

  // Ctrl+Z in a text field belongs to that field. The browser may still undo
  // the textarea's own last edit, which is fine; what must not happen is the
  // project-wide undo firing and rolling back an unrelated asset.
  await page.locator('.find-field').first().click();
  const projectUndo = await page.evaluate(() => {
    const store = window.__benseditor.store;
    window.__undoCalls = 0;
    const original = store.undo.bind(store);
    store.undo = function patched() {
      window.__undoCalls++;
      return original();
    };
    return store.object('obj_player').source;
  });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(150);
  const undoResult = await page.evaluate(() => ({
    calls: window.__undoCalls,
    source: window.__benseditor.store.object('obj_player').source,
  }));
  check('undo in the find box does not fire the project undo',
    undoResult.calls === 0 && undoResult.source === projectUndo, JSON.stringify(undoResult));
  await page.locator('.code-input').click();
  await page.keyboard.press('Escape');

  // Accepting a completion with the caret mid-word takes the whole word.
  await setSource('');
  await page.locator('.code-input').click();
  await page.keyboard.type('instance_cr');
  await page.waitForTimeout(250);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(150);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  check('completing mid-word does not leave a tail',
    (await sourceNow()) === 'instance_create()', JSON.stringify(await sourceNow()));

  // One stray backtick used to turn the rest of the file into a string.
  await setSource('local a = `\nlocal b = 2\nprint(b)\n');
  const afterBacktick = await page.evaluate(() => {
    const html = document.querySelector('.code-highlight').innerHTML;
    return {
      // Line 2's `local` must still read as a keyword, and line 3's `print` as
      // the builtin it is -- not as more of the string.
      keywordSurvives: html.split('tok-keyword">local').length - 1 >= 2,
      builtinSurvives: /tok-builtin">print/.test(html),
      strings: html.split('tok-string').length - 1,
    };
  });
  check('a stray backtick only swallows its own line',
    afterBacktick.keywordSurvives && afterBacktick.builtinSurvives, JSON.stringify(afterBacktick));

  // A caret sits between characters: just before a quote is still code.
  await setSource('print("hi")');
  await page.evaluate(() => {
    const area = document.querySelector('.code-input');
    area.focus();
    area.setSelectionRange(6, 6);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.keyboard.press('Control+ ');
  await page.waitForTimeout(250);
  const beforeQuote = await page.evaluate(() =>
    [...document.querySelectorAll('.complete-name')].map((n) => n.textContent));
  check('a caret before a string offers code, not asset names',
    beforeQuote.length > 0 && !beforeQuote.some((name) => name.startsWith('spr_')),
    beforeQuote.slice(0, 4).join(','));
  await page.keyboard.press('Escape');

  // A selection that stops at the start of a line does not include that line.
  await setSource('one\ntwo\n');
  await page.evaluate(() => {
    const area = document.querySelector('.code-input');
    area.focus();
    area.setSelectionRange(0, 4);
  });
  await page.keyboard.press('Tab');
  check('a selection ending at column 0 leaves the next line alone',
    (await sourceNow()) === '\tone\ntwo\n', JSON.stringify(await sourceNow()));

  // Tabs advance to the next tab stop rather than adding a fixed four.
  await setSource('ab\tx\n');
  await page.evaluate(() => {
    const area = document.querySelector('.code-input');
    area.focus();
    area.setSelectionRange(4, 4);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.waitForTimeout(150);
  check('a tab advances to the next tab stop',
    /Ln 1, Col 6/.test(await page.locator('.code-status').textContent()),
    await page.locator('.code-status').textContent());

  console.log('\n=== typing does not get slower as the file grows ===');
  /**
   * Cost of the editor's own work for one real keystroke.
   *
   * The document capture listener runs before the editor's handler and the
   * bubble listener after it, so the gap is exactly what the editor did.
   *
   * Reported as the fastest of fifteen samples. By this point the page holds a
   * dozen live panels and the median is dominated by whatever else the browser
   * is doing; the floor is the honest figure for the editor itself. The real
   * guarantee is the one below it -- that the number barely moves with the size
   * of the file, which is what the windowed overlay buys.
   */
  // Measured on a page of its own. By this point the shared page holds a dozen
  // panels and a long undo history, and the numbers say more about the test run
  // than about the editor.
  const perfPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await perfPage.goto(URL, { waitUntil: 'load' });
  await perfPage.waitForSelector('.asset-group');
  await perfPage.evaluate(() => window.__benseditor.openAsset('object', 'obj_coin'));
  await perfPage.waitForSelector('.code-input');

  const keystrokeCost = async (lines) => {
    await perfPage.locator('.code-input').click();
    await perfPage.evaluate((count) => {
      const area = document.querySelector('.code-input');
      area.focus();
      area.select();
      document.execCommand(
        'insertText',
        false,
        Array.from({ length: count }, (_, i) => `local value_${i} = math.floor(${i} / 3)`).join('\n'),
      );
    }, lines);
    await perfPage.waitForTimeout(150);

    return perfPage.evaluate(() => {
      const area = document.querySelector('.code-input');
      area.focus();
      let started = 0;
      const samples = [];
      const begin = () => { started = performance.now(); };
      const end = () => samples.push(performance.now() - started);
      document.addEventListener('input', begin, true);
      document.addEventListener('input', end, false);

      const at = Math.floor(area.value.length / 2);
      for (let i = 0; i < 15; i++) {
        area.setSelectionRange(at, at);
        document.execCommand('insertText', false, 'e');
      }
      document.removeEventListener('input', begin, true);
      document.removeEventListener('input', end, false);
      samples.sort((a, b) => a - b);
      return +samples[0].toFixed(1);
    });
  };

  const smallFile = await keystrokeCost(100);
  const bigFile = await keystrokeCost(1600);
  const growth = bigFile / Math.max(smallFile, 0.1);
  console.log(`   ${smallFile} ms at 100 lines, ${bigFile} ms at 1600 — ${growth.toFixed(1)}x`);

  /*
   * The claim worth asserting is the shape, not the wall clock.
   *
   * On an idle machine this is around 5 ms at 100 lines, but the same code has
   * measured anywhere from 5 to 25 ms depending on what else the suite is
   * doing, so a "within one frame" assertion would only be a coin toss. What
   * the windowed overlay actually guarantees is that the number barely moves
   * with the size of the file, and that survives any amount of load. The
   * absolute bound is left as a catastrophe guard: before this work the same
   * measurement was 220 ms.
   */
  check('a keystroke does not cost anything like a full repaint', smallFile < 60,
    `${smallFile} ms`);
  check('sixteen times the file does not cost sixteen times as much', growth < 5,
    `${growth.toFixed(1)}x`);
  check('only the visible lines are rendered', await perfPage.evaluate(() =>
    document.querySelectorAll('.code-highlight span').length < 400),
    String(await perfPage.evaluate(() => document.querySelectorAll('.code-highlight span').length)));
  await perfPage.close();

  await page.keyboard.press('Control+z');
  await page.waitForTimeout(200);

  console.log('\n=== docs ===');
  await page.keyboard.press('F1');
  await page.waitForSelector('.docs-panel');
  check('F1 opens the manual', await page.locator('.docs-panel').isVisible());

  const docCounts = await page.evaluate(() => ({
    chapters: document.querySelectorAll('.docs-nav-list h3').length,
    sections: document.querySelectorAll('.doc-section').length,
    entries: document.querySelectorAll('.doc-entry').length,
    samples: document.querySelectorAll('.doc-code').length,
    highlighted: document.querySelectorAll('.doc-code .tok-keyword').length,
  }));
  check('every chapter is listed', docCounts.chapters === 7, String(docCounts.chapters));
  check('sections rendered', docCounts.sections >= 20, String(docCounts.sections));
  check('entries rendered', docCounts.entries > 150, String(docCounts.entries));
  check('code samples are highlighted', docCounts.highlighted > 10, String(docCounts.highlighted));

  await page.locator('.docs-search').fill('place_meeting');
  await page.waitForTimeout(150);
  const searched = await page.evaluate(() => ({
    sections: document.querySelectorAll('.doc-section').length,
    names: [...document.querySelectorAll('.doc-name')].map((n) => n.textContent),
  }));
  check('search narrows the manual', searched.sections < docCounts.sections && searched.sections > 0,
    `${searched.sections} sections`);
  check('search finds the method', searched.names.includes('place_meeting'), searched.names.join(','));

  await page.locator('.docs-search').fill('zzzznothing');
  await page.waitForTimeout(150);
  check('a miss says so', await page.locator('.docs-empty').isVisible());

  await page.locator('.docs-search').fill('');
  await page.waitForTimeout(150);

  const docScroll = await page.evaluate(() => {
    const content = document.querySelector('.docs-content');
    content.scrollTop = 4000;
    return {
      scrolled: content.scrollTop > 0,
      pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      overflow: document.querySelector('.panel-host').scrollHeight -
        document.querySelector('.panel-host').clientHeight,
    };
  });
  check('the manual scrolls inside its own panel', docScroll.scrolled);
  check('and not the window', !docScroll.pageScrolls && docScroll.overflow === 0,
    `${docScroll.overflow}px of overflow`);

  await page.evaluate(() => (document.querySelector('.docs-content').scrollTop = 0));
  await page.screenshot({ path: join(outDir, 'docs.png') });

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  console.log('\n   screenshots -> test-output/');
} catch (error) {
  failed++;
  console.error('\nFAILED:', error);
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
