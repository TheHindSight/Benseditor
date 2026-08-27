/**
 * The Roblox-style paradigm: the Explorer overlay and the switch.
 *
 * First the model in Node -- reconcile, domains, cycles, drops, the export
 * strip -- then the real editor in Chromium: switch a project to Roblox style
 * through Project settings, arrange it, play it, switch back, and switch
 * again with the folders intact.
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const PORT = 4331;
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

// ---- the model ------------------------------------------------------------

async function loadModule(path) {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    return await server.ssrLoadModule(path);
  } finally {
    await server.close();
  }
}

const ex = await loadModule('/src/project/explorer.ts');
const { buildBlankProject, newObject, newRoom, newScript } = await loadModule('/src/project/create.ts');
const { validate } = await loadModule('/src/project/validate.ts');

/** A small project with one of everything; sprites need no pixels here. */
function buildStarterProject(name) {
  const project = buildBlankProject(name);
  project.sprites.push({ kind: 'sprite', name: 'spr_a', frames: [] }, { kind: 'sprite', name: 'spr_b', frames: [] });
  project.tilesets.push({ name: 'ts_a', tiles: [] });
  project.objects.push(newObject('obj_a'), newObject('obj_b'));
  project.rooms.push(newRoom('rm_second'));
  project.scripts.push(newScript('helpers'));
  return project;
}

console.log('\n=== the explorer model ===');
{
  const project = buildStarterProject('Model');
  const assetCount =
    project.sprites.length + project.tilesets.length + project.objects.length +
    project.rooms.length + project.scripts.length;

  const nodes = ex.reconcileExplorer(project);
  check('reconcile creates the four services first', nodes.slice(0, 4).map((n) => n.name).join() === 'Workspace,StarterRooms,ReplicatedStorage,Assets');
  check('every asset gets exactly one node', nodes.filter((n) => n.kind === 'asset').length === assetCount, String(assetCount));
  check('objects land in Workspace', nodes.filter((n) => n.asset?.kind === 'object').every((n) => n.parentId === ex.SERVICE_IDS.workspace));
  check('rooms land in StarterRooms', nodes.filter((n) => n.asset?.kind === 'room').every((n) => n.parentId === ex.SERVICE_IDS.rooms));
  check('sprites land in Assets', nodes.filter((n) => n.asset?.kind === 'sprite').every((n) => n.parentId === ex.SERVICE_IDS.assets));
  const before = JSON.stringify(nodes);
  ex.reconcileExplorer(project);
  check('reconcile is idempotent', JSON.stringify(project.config.explorer) === before);

  // Arrange: a folder in Workspace holding one object. (Reconcile writes a
  // fresh array each time, so always edit the one on the project.)
  const arranged = project.config.explorer;
  const objectNode = arranged.find((n) => n.asset?.kind === 'object');
  arranged.push({ id: 'fld_a', kind: 'folder', name: 'Enemies', parentId: ex.SERVICE_IDS.workspace });
  objectNode.parentId = 'fld_a';
  ex.reconcileExplorer(project);
  check('folders and placements survive reconcile', project.config.explorer.find((n) => n.id === objectNode.id).parentId === 'fld_a');

  // Damage: a dangling parent, a cycle, an asset in the wrong domain, a
  // node for an asset that no longer exists, and a duplicate.
  const tree = project.config.explorer;
  tree.push({ id: 'fld_b', kind: 'folder', name: 'Lost', parentId: 'fld_missing' });
  tree.push({ id: 'fld_c', kind: 'folder', name: 'C', parentId: 'fld_d' });
  tree.push({ id: 'fld_d', kind: 'folder', name: 'D', parentId: 'fld_c' });
  const roomNode = tree.find((n) => n.asset?.kind === 'room');
  roomNode.parentId = 'fld_a';
  tree.push({ id: 'object:obj_ghost', kind: 'asset', name: 'obj_ghost', parentId: ex.SERVICE_IDS.workspace, asset: { kind: 'object', name: 'obj_ghost' } });
  tree.push({ ...objectNode, parentId: ex.SERVICE_IDS.workspace });
  ex.reconcileExplorer(project);
  const fixed = project.config.explorer;
  check('a folder with a missing parent moves to a service root', fixed.find((n) => n.id === 'fld_b').parentId !== 'fld_missing' && ex.serviceOf(fixed, 'fld_b') !== null);
  check('a cycle of folders is broken', ex.serviceOf(fixed, 'fld_c') !== null && ex.serviceOf(fixed, 'fld_d') !== null);
  check('an asset outside its domain returns to it', fixed.find((n) => n.id === roomNode.id).parentId === ex.SERVICE_IDS.rooms);
  check('a node for a deleted asset is dropped', !fixed.some((n) => n.id === 'object:obj_ghost'));
  check('duplicates collapse to one node, keeping the first', fixed.filter((n) => n.id === objectNode.id).length === 1 && fixed.find((n) => n.id === objectNode.id).parentId === 'fld_a');

  // Drops.
  check('an object may move into a Workspace folder', ex.canDrop(fixed, objectNode.id, 'fld_a'));
  check('an object may not move into StarterRooms', !ex.canDrop(fixed, objectNode.id, ex.SERVICE_IDS.rooms));
  check('a folder may not move into itself', !ex.canDrop(fixed, 'fld_a', 'fld_a'));
  fixed.push({ id: 'fld_inner', kind: 'folder', name: 'Inner', parentId: 'fld_a' });
  check('a folder may not move into its own descendant', !ex.canDrop(fixed, 'fld_a', 'fld_inner'));
  check('a folder may not cross services', !ex.canDrop(fixed, 'fld_a', ex.SERVICE_IDS.assets));
  check('nothing drops onto an asset', !ex.canDrop(fixed, 'fld_inner', objectNode.id));
  check('services never move', !ex.canDrop(fixed, ex.SERVICE_IDS.assets, ex.SERVICE_IDS.workspace));

  // Folder deletion lifts contents.
  ex.removeFolder(fixed, 'fld_a');
  check('deleting a folder lifts its contents to the parent', fixed.find((n) => n.id === objectNode.id).parentId === ex.SERVICE_IDS.workspace && fixed.find((n) => n.id === 'fld_inner').parentId === ex.SERVICE_IDS.workspace);
  check('the folder itself is gone', !fixed.some((n) => n.id === 'fld_a'));

  // Rename / delete fixups used by AssetOps.
  ex.renameAssetNode(fixed, 'object', objectNode.asset.name, 'obj_renamed');
  check('renaming rewrites the node id and name', fixed.some((n) => n.id === 'object:obj_renamed' && n.name === 'obj_renamed'));
  ex.removeAssetNode(fixed, 'object', 'obj_renamed');
  check('deleting removes the node', !fixed.some((n) => n.id === 'object:obj_renamed'));
  ex.addAssetNode(fixed, 'object', 'obj_new', ex.SERVICE_IDS.rooms);
  check('a new asset ignores a home outside its domain', fixed.find((n) => n.id === 'object:obj_new').parentId === ex.SERVICE_IDS.workspace);

  // validate() keeps a dormant tree honest and never invents one.
  const plain = buildStarterProject('Plain');
  validate(plain);
  check('a GameMaker project gets no tree from validate', plain.config.explorer === undefined);
  project.objects.pop();
  validate(project);
  check('validate reconciles an existing tree', !project.config.explorer.some((n) => n.asset?.kind === 'object' && !project.objects.some((o) => o.def.name === n.asset.name)));

  // Exports never carry layout.
  project.config.paradigm = 'roblox';
  project.config.scripting = 'blocks';
  project.objects[0].def.blocks = { blocks: { languageVersion: 0, blocks: [] } };
  const exported = ex.forPlayer(project);
  check('the player copy has no paradigm, explorer or scripting mode', !('paradigm' in exported.config) && !('explorer' in exported.config) && !('scripting' in exported.config));
  check('nor any object blocks', exported.objects.every((o) => !('blocks' in o.def)) && 'blocks' in project.objects[0].def);
  check('the editor copy is untouched', project.config.paradigm === 'roblox' && Array.isArray(project.config.explorer));
}

// ---- the editor -----------------------------------------------------------

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

  await page.addInitScript(() => localStorage.clear());
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForSelector('.asset-group');

  const snapshot = () =>
    page.evaluate(() => {
      const p = window.__benseditor.store.project;
      return JSON.stringify({
        sprites: p.sprites.map((s) => s.name),
        objects: p.objects.map((o) => [o.def.name, o.source.length]),
        rooms: p.rooms.map((r) => [r.name, r.instances.length]),
        scripts: p.scripts.map((s) => s.name),
        start: p.config.startRoom,
      });
    });
  const flatBefore = await snapshot();

  console.log('\n=== switching to Roblox style ===');
  check('starts as the flat asset tree', (await page.locator('.asset-tree').count()) === 1);
  await page.locator('button', { hasText: 'Settings' }).click();
  await page.waitForSelector('.modal-box');
  await page.locator('.modal-box input[name=paradigm][value=roblox]').check();
  await page.locator('.modal-actions .primary').click();
  await page.waitForSelector('.explorer-tree');
  check('the sidebar becomes the Explorer', (await page.locator('.asset-tree').count()) === 0);
  check('four services', (await page.locator('.explorer-service .asset-name').allTextContents()).join() === 'Workspace,StarterRooms,ReplicatedStorage,Assets');
  check('the project records the paradigm', await page.evaluate(() => window.__benseditor.store.project.config.paradigm === 'roblox'));
  const assetCount = await page.evaluate(() => {
    const p = window.__benseditor.store.project;
    return p.sprites.length + p.tilesets.length + p.objects.length + p.rooms.length + p.scripts.length;
  });
  check('every asset is listed under its service', (await page.locator('.explorer-asset').count()) === assetCount, `${await page.locator('.explorer-asset').count()} vs ${assetCount}`);
  check('the start room keeps its badge', (await page.locator('.explorer-room .badge').count()) === 1);
  check('nothing else changed', (await snapshot()) === flatBefore);

  console.log('\n=== expansion and derived rows ===');
  const firstObject = await page.evaluate(() => window.__benseditor.store.project.objects[0].def.name);
  const objectRow = page.locator(`.explorer-row[data-node="object:${firstObject}"]`);
  await objectRow.locator('.explorer-chevron').click();
  await page.waitForTimeout(100);
  check('an object opens to show its Script row', (await page.locator('.explorer-derived', { hasText: 'Script' }).count()) === 1);
  const hasSprite = await page.evaluate((name) => !!window.__benseditor.store.object(name).def.sprite, firstObject);
  check('and its Sprite row when it has one', (await page.locator('.explorer-derived', { hasText: 'Sprite' }).count()) === (hasSprite ? 1 : 0));

  // A structural commit rebuilds the DOM; the branch must stay open.
  await page.evaluate(() => {
    window.__benseditor.store.commit('new folder', () => {
      window.__benseditor.store.project.config.explorer.push({ id: 'fld_t', kind: 'folder', name: 'Enemies', parentId: 'svc_workspace' });
    }, true);
  });
  await page.waitForTimeout(100);
  check('a folder appears', (await page.locator('.explorer-folder .asset-name', { hasText: 'Enemies' }).count()) === 1);
  check('expansion survives a structural rebuild', (await page.locator('.explorer-derived', { hasText: 'Script' }).count()) === 1);

  console.log('\n=== arranging ===');
  const moved = await page.evaluate((name) => window.__benseditor.explorer.move(`object:${name}`, 'fld_t'), firstObject);
  check('an object moves into a folder', moved && (await page.evaluate((name) => window.__benseditor.store.project.config.explorer.find((n) => n.id === `object:${name}`).parentId === 'fld_t', firstObject)));
  check('the folder opened to show it', (await page.locator('.explorer-folder .explorer-chevron').first().textContent()) === '▾' || (await objectRow.count()) === 1);
  check('an object refuses StarterRooms', !(await page.evaluate((name) => window.__benseditor.explorer.move(`object:${name}`, 'svc_rooms'), firstObject)));
  check('a folder refuses itself', !(await page.evaluate(() => window.__benseditor.explorer.move('fld_t', 'fld_t'))));
  check('moves are undoable', await page.evaluate((name) => {
    window.__benseditor.store.undo();
    return window.__benseditor.store.project.config.explorer.find((n) => n.id === `object:${name}`).parentId === 'svc_workspace';
  }, firstObject));
  await page.evaluate(() => window.__benseditor.store.redo());
  await page.waitForTimeout(100);

  // Drag with the real DnD events, the way a user would.
  const secondObject = await page.evaluate(() => window.__benseditor.store.project.objects[1]?.def.name ?? null);
  if (secondObject) {
    await page.locator(`.explorer-row[data-node="object:${secondObject}"]`).dragTo(page.locator('.explorer-row[data-node="fld_t"]'));
    await page.waitForTimeout(150);
    check('drag and drop reparents', await page.evaluate((name) => window.__benseditor.store.project.config.explorer.find((n) => n.id === `object:${name}`).parentId === 'fld_t', secondObject));
  }

  // Creating from the tree lands in the folder that was asked.
  await page.evaluate(() => {
    const row = document.querySelector('.explorer-row[data-node="fld_t"]');
    row.querySelector('button.mini').click();
  });
  await page.waitForSelector('.modal-box select');
  await page.locator('.modal-box input[type=text]').fill('obj_in_folder');
  await page.locator('.modal-actions .primary').click();
  await page.waitForTimeout(200);
  check('a new object created from a folder lands in it', await page.evaluate(() => window.__benseditor.store.project.config.explorer.find((n) => n.id === 'object:obj_in_folder')?.parentId === 'fld_t'));
  check('and opens its editor', (await page.locator('.tab.active', { hasText: 'obj_in_folder' }).count()) === 1);

  console.log('\n=== renaming keeps an asset in place ===');
  await page.evaluate(() => {
    window.__benseditor.store.commit('rename', () => {
      const p = window.__benseditor.store.project;
      const entry = p.objects.find((o) => o.def.name === 'obj_in_folder');
      entry.def.name = 'obj_renamed';
      // Mirror what AssetOps.rename does, through the same helper.
      const node = p.config.explorer.find((n) => n.id === 'object:obj_in_folder');
      node.id = 'object:obj_renamed'; node.name = 'obj_renamed'; node.asset = { kind: 'object', name: 'obj_renamed' };
    }, true);
  });
  await page.waitForTimeout(100);
  check('a renamed asset keeps its place', (await page.locator('.explorer-row[data-node="object:obj_renamed"]').count()) === 1);

  console.log('\n=== the game still runs ===');
  await page.evaluate(() => window.__benseditor.play());
  await page.waitForTimeout(1500);
  check('play shows no error', await page.evaluate(() => document.querySelector('.game-error')?.hidden !== false));
  const lit = await page.evaluate(() => {
    const canvas = document.querySelector('.game-canvas');
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true }) ?? canvas.getContext('webgl2');
    if (!gl) return -1;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let count = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] + pixels[i + 1] + pixels[i + 2] > 0) count++;
    return count;
  });
  check('the game rendered', lit !== 0, String(lit));

  console.log('\n=== switching back, and back again ===');
  await page.locator('button', { hasText: 'Settings' }).click();
  await page.waitForSelector('.modal-box');
  check('the dialog shows the current style', await page.locator('.modal-box input[name=paradigm][value=roblox]').isChecked());
  await page.locator('.modal-box input[name=paradigm][value=gamemaker]').check();
  await page.locator('.modal-actions .primary').click();
  await page.waitForSelector('.asset-tree');
  check('the flat tree is back', (await page.locator('.explorer-tree').count()) === 0);
  check('the paradigm field is dropped, not set to gamemaker', await page.evaluate(() => !('paradigm' in window.__benseditor.store.project.config)));
  check('the tree is kept dormant', await page.evaluate(() => Array.isArray(window.__benseditor.store.project.config.explorer)));
  check('the flat view lists the renamed object', (await page.locator('.asset-item', { hasText: 'obj_renamed' }).count()) === 1);

  await page.locator('button', { hasText: 'Settings' }).click();
  await page.waitForSelector('.modal-box');
  await page.locator('.modal-box input[name=paradigm][value=roblox]').check();
  await page.locator('.modal-actions .primary').click();
  await page.waitForSelector('.explorer-tree');
  check('folders survive the round trip', (await page.locator('.explorer-folder .asset-name', { hasText: 'Enemies' }).count()) === 1);
  check('and so does what was in them', await page.evaluate(() => window.__benseditor.store.project.config.explorer.find((n) => n.id === 'object:obj_renamed')?.parentId === 'fld_t'));

  console.log('\n=== switching is one undo step ===');
  await page.evaluate(() => window.__benseditor.store.undo());
  await page.waitForTimeout(100);
  check('undo restores the previous style', (await page.locator('.asset-tree').count()) === 1);
  await page.evaluate(() => window.__benseditor.store.redo());
  await page.waitForTimeout(100);
  check('redo brings the Explorer back', (await page.locator('.explorer-tree').count()) === 1);

  console.log('\n=== a new project in Roblox style ===');
  await page.locator('button', { hasText: 'New' }).first().click();
  await page.waitForSelector('.modal-box');
  if ((await page.locator('.modal-box input[name=paradigm]').count()) === 0) {
    // The unsaved-changes prompt came first.
    await page.locator('.modal-actions .primary').click();
    await page.waitForSelector('.modal-box input[name=paradigm]');
  }
  await page.locator('.modal-box input[name=paradigm][value=roblox]').check();
  await page.locator('.modal-actions .primary').click();
  await page.waitForSelector('.explorer-tree');
  check('a blank Roblox-style project opens in the Explorer', (await page.locator('.explorer-service').count()) === 4);
  check('with its one room under StarterRooms', (await page.locator('.explorer-room .asset-name').allTextContents()).join() === 'rm_main');

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
