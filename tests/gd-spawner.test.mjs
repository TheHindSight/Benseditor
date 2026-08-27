/**
 * Geometry Dash spawner: `obj_level` streams a level's objects around the
 * view. A 900-object synthetic level is walked by a stub player (5 px/step,
 * the camera 150 px behind it) with stub hazard objects; the live set must
 * stay inside the streaming window, every object must be spawned exactly once
 * as the view scrolls, restarts and reset_window must rebuild correctly, and
 * the tile sync must be idempotent across room_restart.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');
const script = (name) => read('src', 'demo', 'gd', 'scripts', name);

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${label}`);
  } else {
    failed++;
    console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`);
  }
}
async function section(name, body) {
  console.log(`\n=== ${name} ===`);
  try {
    await body();
  } catch (error) {
    failed++;
    const detail = String(error?.stack ?? error?.message ?? error).split('\n').slice(0, 12).join(' | ');
    console.log(`  FAIL ${name} threw -- ${detail}`);
  }
}

async function loadModules(paths) {
  const server = await createServer({
    root, configFile: false, logLevel: 'error', server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const out = [];
    for (const path of paths) out.push(await server.ssrLoadModule(path));
    return out;
  } finally {
    await server.close();
  }
}
const [C, L] = await loadModules(['/src/demo/gd/constants.ts', '/src/demo/gd/levels.ts']);

const { loadMicroPython } = await import(pathToFileURL(join(root, 'src', 'vendor', 'micropython.js')).href);
const printed = [];
const mp = await loadMicroPython({ stdout: (line) => printed.push(line), stderr: (line) => console.error('  py:', line) });
const hostStore = new Map();
mp.registerJsModule('__host', {
  store_get: (key) => hostStore.get(key) ?? '',
  store_set: (key, value) => (value === '' ? hostStore.delete(key) : hostStore.set(key, value)),
});
mp.runPython(read('src', 'python', 'roblox.py'));
mp.runPython(read('src', 'python', 'prelude.py'));
const g = (name) => mp.globals.get(name);
const frame = () => g('__frame_packed')('', 1 / 60);
function py(expr) {
  printed.length = 0;
  mp.runPython(`print(HttpService.JSONEncode(${expr}))`);
  return JSON.parse(printed.pop());
}
const pyRun = (source) => mp.runPython(source);
const q = (text) => JSON.stringify(text);
/** JSON with sorted keys, so Python's dict order does not matter. */
const norm = (value) => JSON.stringify(value, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));

const STUB_OBJECTS = ['obj_spike', 'obj_pad', 'obj_orb', 'obj_portal_gravity', 'obj_portal_mode', 'obj_portal_speed', 'obj_portal_size', 'obj_coin', 'obj_finish'];

const PLAYER_STUB = `
_RS = game.GetService("ReplicatedStorage")

def create(self):
    self.max_live = 0
    self.min_live = 99999
    self.steps = 0

def step(self):
    self.x += 5
    self.steps += 1
    view_set(self.x - CAMERA_X, ROOM_H - VIEW_H)
    n = instance_number("obj_gdstub")
    if n > self.max_live:
        self.max_live = n
    c = col_at(self.x)
    if c >= 30 and c <= 440 and n < self.min_live:
        self.min_live = n
    _RS.Set("probe", {"max_live": self.max_live, "min_live": self.min_live, "x": self.x, "steps": self.steps})
`;

function addObject(name, source, def = {}) {
  g('__register_object')(name, source, def.sprite ?? null, def.depth ?? 0, def.visible ?? true, def.solid ?? false,
    def.persistent ?? false, def.parent ?? null, (def.blockedBy ?? []).join(','));
}

/** Register everything and start rm_play with the given run request. */
function boot(data, startCol = 0, placePlayer = false) {
  g('__reset')();
  g('__register_tileset')('ts_gd', 100, C.CELL, C.CELL, 2, 1, '11');
  g('__register_module')('gd_const', C.constantsPython());
  g('__register_module')('gd_codec', script('gd_codec.py'));
  g('__register_module')('gd_tiles', script('gd_tiles.py'));
  g('__register_module')('gd_level', script('gd_level.py'));
  addObject('obj_gdstub', '');
  for (const name of STUB_OBJECTS) addObject(name, '', { parent: 'obj_gdstub' });
  addObject('obj_player', PLAYER_STUB);
  addObject('obj_level', script('obj_level.py'));
  const placements = ['obj_level,0,0,1,1,0'];
  if (placePlayer) placements.push(`obj_player,${C.cellX(startCol)},${C.cellY(0)},1,1,0`);
  g('__register_room')('rm_play', C.ROOM_W, C.ROOM_H, 0x101828, C.CELL, C.CELL, placements.join(';'));
  // 30 empty rows, then two rows of ground tile (index 1).
  g('__register_room_layer')('rm_play', C.LAYER_PLAY, 'ts_gd', 10, true, C.MAX_COLUMNS, C.LAYER_ROWS,
    `-1:${C.MAX_COLUMNS * C.ROWS},1:${C.MAX_COLUMNS * C.FLOOR_ROWS}`);
  pyRun(`
_RS = game.GetService("ReplicatedStorage")
_RS.Set("gd.run", {"mode": "play", "source": "test", "level_id": "syn", "data": ${q(data)}, "start_col": ${startCol}, "return_to": "rm_menu"})
# Shared-script names are globals for object scripts; make them REPL globals too.
for _m in ("gd_const", "gd_codec", "gd_tiles", "gd_level"):
    for _k, _v in require(_m)._namespace.items():
        if not _k.startswith("_"):
            globals()[_k] = _v
`);
  g('__start')('rm_play', 60);
}

// The synthetic level: 900 objects (a spike and an orb in each of 450 columns)
// plus 100 blocks (tiles) and the finish at column 470.
const LEN = 470;
const objects = [];
for (let col = 8; col < 458; col++) {
  objects.push({ code: 'S', col, row: 0, param: '0' });
  objects.push({ code: 'O', col, row: 4, param: 'y' });
}
for (let col = 20; col < 120; col++) objects.push({ code: 'B', col, row: 7, param: '' });
const DATA = L.encodeLevel({ name: 'Synthetic', len: LEN }, objects);
const OBJECT_COUNT = 900;
const BLOCK_COUNT = 100;
// Columns inside the window: the view (19 or 20 columns) + look-ahead + behind.
const WINDOW_COLS = Math.ceil(C.VIEW_W / C.CELL) + 1 + C.SPAWN_AHEAD + C.SPAWN_BEHIND;
const MAX_LIVE = WINDOW_COLS * 2 + 1;

await section('a full walk through a 900-object level', async () => {
  boot(DATA, 0);
  check('the spawner created the player at the start column', py('instance_number("obj_player")') === 1 && py('instance_find("obj_player").x') === C.cellX(0));
  check('the view is 570x330 and starts behind the player', py('[view_width(), view_height(), view_get()[0]]').join() === `570,330,${C.cellX(0) - C.CAMERA_X}`);
  check('tiles were written where the blocks are', py(`tilemap_get("lay_play", 50, ${C.tileY(7)})`) === C.TILE_BLOCK
    && py(`tilemap_get("lay_play", 119, ${C.tileY(7)})`) === C.TILE_BLOCK && py(`tilemap_get("lay_play", 120, ${C.tileY(7)})`) === -1);
  check('blocks are solid to tile_solid_at and the floor is intact', py(`1 if tile_solid_at(${C.cellX(50)}, ${C.cellY(7)}) else 0`) === 1
    && py(`1 if tile_solid_at(${C.cellX(50)}, ${C.cellY(6)}) else 0`) === 0 && py('tilemap_get("lay_play", 50, 30)') === C.TILE_GROUND);
  check('the first sync wrote exactly the blocks', py('_RS.Get("gd.tiles_sync")').join() === `${BLOCK_COUNT},0`);
  const initialLive = py('instance_number("obj_gdstub")');
  check('the initial window holds the first columns only', initialLive > 0 && initialLive <= MAX_LIVE, `${initialLive}`);
  check('gd.level and gd.finish_x are published', py('_RS.Get("gd.level")["len"]') === LEN && py('_RS.Get("gd.finish_x")') === C.cellX(LEN));

  const steps = Math.ceil(((LEN + 25) * C.CELL) / 5);
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) frame();
  const ms = (performance.now() - t0) / steps;
  console.log(`       ${steps} steps, ${ms.toFixed(2)} ms per step`);
  const probe = py('_RS.Get("probe")');
  check(`live instances never exceeded the window bound (${MAX_LIVE})`, probe.max_live <= MAX_LIVE, `max ${probe.max_live}`);
  check('the window never ran dry mid-level', probe.min_live >= (Math.ceil(C.VIEW_W / C.CELL) + C.SPAWN_AHEAD) * 2, `min ${probe.min_live}`);
  const counts = py('list(instance_find("obj_level").spawned.values())');
  check('every object (and block and the finish) was spawned exactly once', counts.length === OBJECT_COUNT + BLOCK_COUNT + 1 && counts.every((n) => n === 1),
    `${counts.length} keys, ${counts.filter((n) => n !== 1).length} not once`);
  check('total instances created matches the objects plus the finish', py('instance_find("obj_level").total_spawned') === OBJECT_COUNT + 1);
  check('everything behind the view was destroyed', py('instance_number("obj_gdstub")') === 0, `${py('instance_number("obj_gdstub")')}`);
  check('the player walked past the finish', probe.x > C.cellX(LEN));
  check('a step costs under 8 ms', ms < 8, `${ms.toFixed(2)} ms`);
});

await section('room_restart rebuilds the window and the tile sync is idempotent', async () => {
  boot(DATA, 0);
  for (let i = 0; i < 400; i++) frame();
  const before = py('instance_find("obj_player").x');
  check('walked some way in', before > 1500);
  pyRun('room_restart()');
  frame();
  check('the spawner and player were recreated', py('instance_number("obj_level")') === 1 && py('instance_number("obj_player")') === 1);
  check('the player is back at the start column', py('instance_find("obj_player").x') <= C.cellX(0) + 5);
  check('the second tile sync wrote and removed nothing', py('_RS.Get("gd.tiles_sync")').join() === '0,0');
  check('the tiles are still there after the restart', py(`tilemap_get("lay_play", 50, ${C.tileY(7)})`) === C.TILE_BLOCK);
  check('the live set is the start window again', py('instance_number("obj_gdstub")') > 0 && py('instance_number("obj_gdstub")') <= MAX_LIVE);
  check('spawn counts start fresh', py('max(instance_find("obj_level").spawned.values())') === 1);
  check('the spike at column 8 is live after the restart', py(`1 if collision_point(${C.cellX(8)}, ${C.cellY(0)}, "obj_spike") else 0`) === 1);
  check('column 40 is not spawned yet', py(`1 if collision_point(${C.cellX(40)}, ${C.cellY(0)}, "obj_spike") else 0`) === 0);

  // A restart from a checkpoint column.
  pyRun('_run = _RS.Get("gd.run"); _run["start_col"] = 200; _RS.Set("gd.run", _run); room_restart()');
  frame();
  check('the player spawns at the checkpoint column', Math.abs(py('instance_find("obj_player").x') - C.cellX(200)) <= 5);
  check('the window is built around the checkpoint', py(`1 if collision_point(${C.cellX(200)}, ${C.cellY(0)}, "obj_spike") else 0`) === 1
    && py(`1 if collision_point(${C.cellX(197)}, ${C.cellY(0)}, "obj_spike") else 0`) === 1
    && py(`1 if collision_point(${C.cellX(190)}, ${C.cellY(0)}, "obj_spike") else 0`) === 0
    && py(`1 if collision_point(${C.cellX(250)}, ${C.cellY(0)}, "obj_spike") else 0`) === 0);
  const lo = py('instance_find("obj_level").lo');
  const hi = py('instance_find("obj_level").hi');
  check('window bounds follow SPAWN_BEHIND / SPAWN_AHEAD', lo === 200 - 5 - C.SPAWN_BEHIND && hi >= 200 + 13 + C.SPAWN_AHEAD, `${lo}..${hi}`);
  check('tile sync stayed idempotent', py('_RS.Get("gd.tiles_sync")').join() === '0,0');
});

await section('reset_window after a practice respawn', async () => {
  boot(DATA, 0);
  for (let i = 0; i < 1200; i++) frame();
  const col = py('col_at(instance_find("obj_player").x)');
  check('walked to about column 200', col >= 195, `${col}`);
  // Teleport the player back (a practice checkpoint) and rebuild around it.
  pyRun(`
_p = instance_find("obj_player")
_p.x = cell_x(100)
view_set(_p.x - CAMERA_X, ROOM_H - VIEW_H)
_s = instance_find("obj_level")
_before = dict(_s.spawned)
reset_window(_s, 100)
`);
  const live = py('instance_number("obj_gdstub")');
  check('the live set was rebuilt within the bound', live > 0 && live <= MAX_LIVE, `${live}`);
  check('objects around the checkpoint are live', py(`1 if collision_point(${C.cellX(100)}, ${C.cellY(0)}, "obj_spike") else 0`) === 1
    && py(`1 if collision_point(${C.cellX(100)}, ${C.cellY(4)}, "obj_orb") else 0`) === 1);
  check('objects far ahead are not', py(`1 if collision_point(${C.cellX(150)}, ${C.cellY(0)}, "obj_spike") else 0`) === 0);
  check('objects behind the window are not', py(`1 if collision_point(${C.cellX(90)}, ${C.cellY(0)}, "obj_spike") else 0`) === 0);
  check('respawned objects count as a second spawn (rebuilt, not duplicated)', py(`_s.spawned[key(100, 0)]`) === 2 && py('instance_number("obj_spike")') === py('len([c for c in _s.live])'));
  for (let i = 0; i < 600; i++) frame();
  const probe = py('_RS.Get("probe")');
  check('streaming continues after the rebuild within the bound', probe.max_live <= MAX_LIVE, `${probe.max_live}`);
  check('no column was spawned twice after the rebuild', py('len([v for k, v in _s.spawned.items() if v > 2])') === 0);

  // The spawner also notices a view that jumped backwards on its own.
  pyRun('_p.x = cell_x(50); view_set(_p.x - CAMERA_X, ROOM_H - VIEW_H)');
  frame();
  check('a backwards view jump rebuilds the window', py(`1 if collision_point(${C.cellX(52)}, ${C.cellY(0)}, "obj_spike") else 0`) === 1
    && py('instance_number("obj_gdstub")') <= MAX_LIVE);
});

await section('a different level clears the old blocks', async () => {
  boot(DATA, 0);
  const other = L.encodeLevel({ name: 'Other', len: 200 }, [
    { code: 'B', col: 130, row: 2, param: '' }, { code: 'B', col: 131, row: 2, param: '' }, { code: 'S', col: 20, row: 0, param: '0' },
  ]);
  pyRun(`_run = _RS.Get("gd.run"); _run["data"] = ${q(other)}; _RS.Set("gd.run", _run); room_restart()`);
  frame();
  check('old block tiles were cleared', py(`tilemap_get("lay_play", 50, ${C.tileY(7)})`) === -1);
  check('new block tiles were written', py(`tilemap_get("lay_play", 130, ${C.tileY(2)})`) === C.TILE_BLOCK);
  check('the sync reports the diff', py('_RS.Get("gd.tiles_sync")').join() === `2,${BLOCK_COUNT}`);
  check('the floor rows were never touched', py('tilemap_get("lay_play", 50, 30)') === C.TILE_GROUND && py('tilemap_get("lay_play", 50, 31)') === C.TILE_GROUND);
  check('layer_matches confirms the wanted set', py('1 if layer_matches("lay_play", level_tiles(_RS.Get("gd.level"))) else 0') === 1);
  check('sync_layer on an unknown layer is a no-op', py('sync_layer("lay_nope", {(1, 1): 0})').join() === '0,0');
});

await section('spawn_object fields and the flip rule', async () => {
  boot('GD1;name=Fields;len=40|', 0);
  pyRun(`
_tiles = {(20, tile_y(5)): 0}
_s = spawn_object("S", "1", 20, 3, _tiles)
_p = spawn_object("P", "y", 20, 4, _tiles)
_p2 = spawn_object("P", "r", 21, 0, _tiles)
_o = spawn_object("O", "k", 22, 2, _tiles)
_m = spawn_object("M", "4", 23, 1, _tiles)
_c = spawn_object("C", "2", 24, 0, _tiles)
_b = spawn_object("B", "", 25, 0, _tiles)
`);
  check('a down spike gets kind 1 and image_yscale -1', py('[_s.kind, _s.image_yscale, _s.col, _s.row]').join() === '1,-1,20,3');
  check('a pad under a block hangs (flipped)', py('[_p.kind, _p.image_yscale]').join() === 'y,-1');
  check('a pad on the ground is upright', py('[_p2.kind, _p2.image_yscale]').join() === 'r,1');
  check('an orb keeps its colour letter', py('_o.kind') === 'k' && py('_o.is_a("obj_orb")') === true);
  check('a mode portal gets an int kind', py('_m.kind') === 4 && py('_m.is_a("obj_portal_mode")') === true);
  check('a coin gets kind and index', py('[_c.kind, _c.index]').join() === '2,2');
  check('a block spawns nothing', py('_b') === null);
  check('positions use cell_x/cell_y', py('[_s.x, _s.y]').join() === `${C.cellX(20)},${C.cellY(3)}`);
  check('finish_x is the centre of column len', py('finish_x(_RS.Get("gd.level"))') === C.cellX(40));
  check('an unknown object name spawns None instead of raising', py('require("gd_level")._create(0, 0, "obj_missing")') === null);
});

await section('gd_run accepts both hand-off shapes', async () => {
  boot('GD1;name=Shapes;len=40|S20.0', 0);
  check('flat gd.run key', py('gd_run()["level_id"]') === 'syn');
  pyRun('_RS.Set("gd.run", None); _RS.Set("gd", {"run": {"mode": "verify", "data": "GD1;len=40|", "start_col": 0}})');
  check('nested gd["run"]', py('gd_run()["mode"]') === 'verify');
  pyRun('_RS.Set("gd", None)');
  check('nothing requested gives None', py('gd_run()') === null);
  pyRun('gd_set_run("test", "GD1;len=40|", "custom", "abc", 12, "rm_editor")');
  check('gd_set_run writes the contract', norm(py('gd_run()')) === norm({ mode: 'test', source: 'custom', level_id: 'abc', data: 'GD1;len=40|', start_col: 12, return_to: 'rm_editor' }));
  pyRun('gd_set_result(True, 3, False, [True, False, True], 100)');
  check('gd_set_result writes gd.result', norm(py('gd_result()')) === norm({ finished: true, attempts: 3, practice_used: false, coins: [true, false, true], best_pct: 100 }));
  // A room entered with no run falls back to an empty level rather than failing.
  pyRun('_RS.Set("gd.run", None); room_restart()');
  frame();
  check('rm_play without a run request still boots', py('instance_number("obj_level")') === 1 && py('gd_run()["data"]').startsWith('GD1;'));
});

await section('gd_store saves with read-back', async () => {
  hostStore.clear();
  boot('GD1;name=Store;len=40|', 0);
  g('__register_module')('gd_store', script('gd_store.py'));
  pyRun('_ST = require("gd_store"); _lv = decode_level("GD1;name=Custom One;len=60|S20.0;B30.0*3")');
  const saved = py('list(_ST.save_level(_lv))');
  check('save_level returns (ok, message)', saved[0] === true && saved[1] === 'Saved', JSON.stringify(saved));
  check('the level got an id', typeof py('_lv["id"]') === 'string' && py('_lv["id"]').length > 10);
  check('the record is stored under gd/level/<id>', [...hostStore.keys()].some((k) => k.startsWith('gd/level/')));
  const listed = py('_ST.list_levels()');
  check('the index lists it as a draft', listed.length === 1 && listed[0].name === 'Custom One' && listed[0].verified === false && listed[0].len === 60);
  check('load_level returns the record', py('_ST.load_level(_lv["id"])["data"]') === 'GD1;name=Custom One;len=60|S20.0;B30.0*3');
  check('mark_verified with stale data is refused', py('list(_ST.mark_verified(_lv["id"], "GD1;name=Custom One;len=60|", 3))')[0] === false);
  check('mark_verified with the stored data succeeds', py('list(_ST.mark_verified(_lv["id"], _ST.load_level(_lv["id"])["data"], 3))')[0] === true
    && py('_ST.list_levels()[0]["verified"]') === true);
  pyRun('_lv["objects"][key(21, 0)] = ("S", "0")');
  check('saving changed data drops the verified flag', py('list(_ST.save_level(_lv))')[0] === true && py('_ST.load_level(_lv["id"])["verified"]') === false
    && py('_ST.list_levels()').length === 1);
  check('record_best keeps the higher value', py('list(_ST.record_best(_lv["id"], 40))')[0] === true && py('list(_ST.record_best(_lv["id"], 20))')[1] === 'unchanged'
    && py('_ST.load_level(_lv["id"])["best"]') === 40);
  check('record_completion counts and merges coins', py('list(_ST.record_completion(_lv["id"], [True, False, False]))')[0] === true
    && py('_ST.load_level(_lv["id"])["completions"]') === 1 && py('_ST.load_level(_lv["id"])["coins"]').join() === 'true,false,false');
  check('an invalid level is refused with its first problem', py('list(_ST.save_level("GD1;name=;len=60|"))')[1].startsWith('name must be'));
  check('storage_used counts bytes', py('_ST.storage_used()') > 100);
  // A quota failure: the host silently drops writes.
  const realSet = hostStore.set.bind(hostStore);
  hostStore.set = () => hostStore;
  const failed = py('list(_ST.save_level(decode_level("GD1;name=Second;len=60|S20.0")))');
  hostStore.set = realSet;
  check('a silent write failure is reported', failed[0] === false && failed[1].startsWith('SAVE FAILED'), JSON.stringify(failed));
  check('the index was left untouched by the failed save', py('_ST.list_levels()').length === 1);
  check('delete_level removes the record and the entry', py('list(_ST.delete_level(_lv["id"]))')[0] === true && py('_ST.list_levels()').length === 0
    && py('_ST.load_level(_lv["id"])') === null);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
