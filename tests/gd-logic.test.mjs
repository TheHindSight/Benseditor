/**
 * Geometry Dash menu / progress / run logic, headless.
 *
 * The shared scripts and scene objects from `src/demo/gd/scripts` run on
 * MicroPython in Node against the real prelude, with fake sprites, a Map
 * standing in for localStorage, and stub `gd_levels` / `gd_store` /
 * `obj_player` / `obj_level` so the suite does not depend on the physics,
 * codec or store scripts. Frames are driven with the host's packed input
 * strings, so the menus are tested the way a player uses them.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const python = (name) => readFileSync(join(here, '..', 'src', 'python', name), 'utf8');
const script = (name) => readFileSync(join(here, '..', 'src', 'demo', 'gd', 'scripts', `${name}.py`), 'utf8');

const { loadMicroPython } = await import(pathToFileURL(join(here, '..', 'src', 'vendor', 'micropython.js')).href);

const RECORD_FLOATS = 12;
const CMD = { SPRITE: 0, RECT: 1, LINE: 2, CIRCLE: 3 };

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
    const detail = String(error.message ?? error).split('\n').slice(0, 12).join(' | ');
    console.log(`  FAIL ${name} threw -- ${detail}`);
  }
}

function decode(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const floats = new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4));
  const commands = [];
  for (let i = 0; i + RECORD_FLOATS <= floats.length; i += RECORD_FLOATS) {
    commands.push({ kind: floats[i], p: Array.from(floats.slice(i + 1, i + 7)), color: Array.from(floats.slice(i + 7, i + 11)) });
  }
  return commands;
}

function unpack(packed) {
  const fields = [];
  let from = 0;
  for (let i = 0; i < 7; i++) {
    const at = packed.indexOf(';', from);
    fields.push(packed.slice(from, at));
    from = at + 1;
  }
  return {
    count: Number(fields[0]),
    viewX: Number(fields[4]),
    viewY: Number(fields[5]),
    quit: fields[6] === '1',
    commands: decode(packed.slice(from)),
  };
}

// ---- interpreter ----------------------------------------------------------

const hostStore = new Map();
let dropWrites = false;
const values = new Map();

const mp = await loadMicroPython({ stdout: () => {}, stderr: (line) => console.error(line) });
mp.registerJsModule('__host', {
  store_get: (key) => hostStore.get(key) ?? '',
  store_set: (key, value) => {
    if (dropWrites) return;
    if (value === '') hostStore.delete(key);
    else hostStore.set(key, value);
  },
});
mp.registerJsModule('__test', { set: (key, value) => values.set(String(key), value) });

mp.runPython(python('roblox.py'));
mp.runPython(python('prelude.py'));
mp.runPython('import __test');

const g = (name) => {
  const fn = mp.globals.get(name);
  if (typeof fn !== 'function') throw new Error(`prelude did not define "${name}"`);
  return fn;
};
const frame = (input = '', dt = 1 / 60) => unpack(g('__frame_packed')(input, dt));
const roomCurrent = () => g('room_current')();
const NO_INPUT = '|||0,0,0,0,0,0';
const key = (name) => `|${name}||0,0,0,0,0,0`;
const click = (x, y) => `|||${x},${y},1,0,1,0`;

/** Evaluate a Python expression in the game namespace, JSON-encoded back. */
function evalPy(expr) {
  mp.runPython(`__test.set("v", HttpService.JSONEncode(eval(${JSON.stringify(expr)}, __ns)))`);
  return JSON.parse(values.get('v'));
}
/** Run Python statements in the same persistent namespace. */
function execPy(source) {
  mp.runPython(`exec(${JSON.stringify(source)}, __ns)`);
}

// ---- fixtures -------------------------------------------------------------

const SPRITES = [
  ['spr_title', 100, 1, 160, 24, 80, 12],
  ['spr_icon_0', 200, 4, 30, 30, 15, 15],
  ['spr_icon_1', 210, 4, 30, 30, 15, 15],
  ['spr_icon_2', 220, 4, 30, 30, 15, 15],
  ['spr_icon_3', 230, 4, 30, 30, 15, 15],
  ['spr_cube', 300, 4, 30, 30, 15, 15],
  ['spr_ship', 310, 4, 30, 30, 15, 15],
  ['spr_star', 400, 2, 8, 8, 4, 4],
  ['spr_coin', 410, 2, 22, 22, 11, 11],
  ['spr_checkpoint', 420, 1, 30, 30, 15, 15],
  ['spr_explosion', 430, 4, 30, 30, 15, 15],
];
const TITLE_ATLAS = 100;
for (const [name, first, frames, w, h, ox, oy] of SPRITES) {
  g('__register_sprite')(name, first, frames, w, h, ox, oy, 0, 0, 0, w - 1, h - 1);
}
const glyphs = [];
for (let code = 32; code < 127; code++) glyphs.push(`${code},${1000 + code},7,6,9`);
g('__register_font')(12, glyphs.join(';'));

// Stubs for the scripts other phases own.
g('__register_module')('gd_levels', `
BUILTIN = [
    {"id": "builtin_1", "name": "Stereo Madness", "difficulty": 1, "data": "GD1;name=Stereo Madness;len=120|"},
    {"id": "builtin_2", "name": "Back On Track", "difficulty": 2, "data": "GD1;name=Back On Track;len=200|"},
]
`);
g('__register_module')('gd_store', `
store_calls = []

def load_index():
    return {"seq": 2, "entries": [
        {"id": "c1", "name": "My Level", "author": "me", "difficulty": 4, "verified": True},
        {"id": "c2", "name": "Draft", "author": "me", "difficulty": 6, "verified": False},
    ]}

def load_level(level_id):
    return {"id": level_id, "data": "GD1;name=Custom;len=60|"}

def mark_verified(level_id, data, attempts):
    store_calls.append(["mark_verified", level_id, attempts])
    return True
`);
for (const name of ['ui', 'progress', 'run', 'icons', 'state', 'levels_menu']) {
  g('__register_module')(name, script(name));
}

const addObject = (name, source, def = {}) => {
  g('__register_object')(name, source, def.sprite ?? null, def.depth ?? 0, def.visible ?? true, false, def.persistent ?? false, null, '');
};
addObject('obj_game', script('obj_game'), { depth: -1000, visible: false, persistent: true });
addObject('obj_menu', script('obj_menu'));
addObject('obj_levels', script('obj_levels'));
addObject('obj_icon', script('obj_icon'));
addObject('obj_hud', script('obj_hud'), { depth: -900, visible: false });
addObject('obj_end', script('obj_end'));
addObject('obj_player', `
def create(self):
    self.on_ground = True
    self.mode = "cube"

def step(self):
    if run_input_locked():
        return
    self.x += 5
`, { sprite: 'spr_cube' });
addObject('obj_level', `
def create(self):
    self.last_reset = None
    self.reset_window = lambda col: _remember(self, col)

def _remember(self, col):
    self.last_reset = col
`, { visible: false });

const place = (object, x, y, name) => `${object},${x},${y},1,1,0,${name}`;
g('__register_room')('rm_menu', 570, 330, 0x1d2b53, 30, 30, place('obj_menu', 0, 0, 'menu'));
g('__register_room')('rm_levels', 570, 330, 0x1d2b53, 30, 30, place('obj_levels', 0, 0, 'levels'));
g('__register_room')('rm_icon', 570, 330, 0x1d2b53, 30, 30, place('obj_icon', 0, 0, 'icon'));
g('__register_room')('rm_end', 570, 330, 0x1d2b53, 30, 30, place('obj_end', 0, 0, 'end'));
g('__register_room')('rm_editor', 570, 330, 0x1d2b53, 30, 30, '');
g('__register_room')(
  'rm_play', 3000, 960, 0x1d2b53, 30, 30,
  [place('obj_hud', 0, 0, 'hud'), place('obj_player', 60, 885, 'player'), place('obj_level', 0, 0, 'level')].join(';'),
);

// A persistent namespace over the game API for the Python-side checks.
mp.runPython('__ns = dict(__API)\n__ns["_objects"] = _objects');

g('__start')('rm_menu');

// ---- pure toolkit helpers -------------------------------------------------

await section('ui toolkit pure functions', async () => {
  check('ui_nav wraps backwards', evalPy('ui_nav(0, 4, -1)') === 3);
  check('ui_nav wraps forwards', evalPy('ui_nav(3, 4, 1)') === 0);
  check('ui_nav clamps at the end', evalPy('ui_nav(3, 4, 1, False)') === 3);
  check('ui_nav clamps at the start', evalPy('ui_nav(0, 4, -5, False)') === 0);
  check('ui_nav on an empty list is 0', evalPy('ui_nav(2, 0, 1)') === 0);
  check('ui_list_window keeps a short list at 0', evalPy('ui_list_window(3, 5, 9, 4)') === 0);
  check('ui_list_window scrolls down to the selection', evalPy('ui_list_window(10, 20, 9, 0)') === 2);
  check('ui_list_window scrolls up to the selection', evalPy('ui_list_window(1, 20, 9, 5)') === 1);
  check('ui_list_window never passes the end', evalPy('ui_list_window(19, 20, 9, 0)') === 11);
  check('ui_list_window leaves a visible selection alone', evalPy('ui_list_window(6, 20, 9, 4)') === 4);
  check('ui_hit inside', evalPy('ui_hit(5, 5, 0, 0, 10, 10)') === true);
  check('ui_hit on the far edge is outside', evalPy('ui_hit(10, 5, 0, 0, 10, 10)') === false);
  check('ui_hit negative', evalPy('ui_hit(-1, 5, 0, 0, 10, 10)') === false);
  check('ui_hover_index second row', evalPy('ui_hover_index(50, 75, 8, 40, 554, 30, 9)') === 1);
  check('ui_hover_index beyond the rows', evalPy('ui_hover_index(50, 400, 8, 40, 554, 30, 9)') === -1);
  check('ui_hover_index left of the list', evalPy('ui_hover_index(2, 75, 8, 40, 554, 30, 9)') === -1);
  check('ui_mix halfway', evalPy('ui_mix(0x000000, 0xFFFFFF, 0.5)') === 0x7f7f7f);
});

// ---- progress ---------------------------------------------------------------

await section('progress schema, records and read-back', async () => {
  execPy('progress_reset()');
  const fresh = evalPy('progress_level("L1")');
  check('fresh level record defaults', fresh.best === 0 && fresh.practice_best === 0 && fresh.attempts === 0
    && fresh.completed === false && fresh.verified === false && JSON.stringify(fresh.coins) === '[false,false,false]', JSON.stringify(fresh));
  const settings = evalPy('progress_settings()');
  check('default settings', settings.primary === 10 && settings.secondary === 12 && settings.icon === 0 && settings.version === 1, JSON.stringify(settings));

  let entry = evalPy('progress_record_death("L1", 40)');
  check('death records best and one attempt', entry.best === 40 && entry.attempts === 1, JSON.stringify(entry));
  entry = evalPy('progress_record_death("L1", 20)');
  check('a worse death keeps the best and bumps attempts', entry.best === 40 && entry.attempts === 2, JSON.stringify(entry));
  entry = evalPy('progress_record_death("L1", 55, True)');
  check('practice death never writes best', entry.best === 40 && entry.practice_best === 55 && entry.attempts === 3, JSON.stringify(entry));
  entry = evalPy('progress_record_death("L1", 200)');
  check('percent is clamped', entry.best === 40, JSON.stringify(entry));

  entry = evalPy('progress_record_complete("L1", [True, False, False])');
  check('completion sets completed, best 100 and the coin', entry.completed === true && entry.best === 100
    && JSON.stringify(entry.coins) === '[true,false,false]' && entry.verified === false, JSON.stringify(entry));
  entry = evalPy('progress_record_complete("L1", [False, False, True])');
  check('coins OR across completions', JSON.stringify(entry.coins) === '[true,false,true]', JSON.stringify(entry));
  entry = evalPy('progress_record_complete("L1", [False, True, False], True)');
  check('practice completion records nothing but practice_best', JSON.stringify(entry.coins) === '[true,false,true]'
    && entry.practice_best === 100, JSON.stringify(entry));
  entry = evalPy('progress_record_complete("L1", [False, False, False], False, "verify")');
  check('verify completion marks verified', entry.verified === true, JSON.stringify(entry));

  const stored = JSON.parse(hostStore.get('gd/progress'));
  check('progress reached the store as JSON', stored.version === 1 && stored.levels.L1.best === 100
    && stored.levels.L1.attempts === 8, JSON.stringify(stored));
  const reloaded = evalPy('progress_load(True)["levels"]["L1"]');
  check('round trip through the store', reloaded.best === 100 && reloaded.verified === true
    && JSON.stringify(reloaded.coins) === '[true,false,true]', JSON.stringify(reloaded));
  check('save succeeded flag is clear', evalPy('progress_state["save_failed"]') === false);

  check('settings save returns True', evalPy('progress_save_settings(8, 3, 2)') === true);
  const savedSettings = JSON.parse(hostStore.get('gd/settings'));
  check('settings reached the store', savedSettings.primary === 8 && savedSettings.secondary === 3 && savedSettings.icon === 2, JSON.stringify(savedSettings));
  check('settings are validated', evalPy('progress_save_settings(99, None, -1)') === true
    && evalPy('progress_settings()["primary"]') === 8 && evalPy('progress_settings()["icon"]') === 2);

  dropWrites = true;
  execPy('progress_record_death("L2", 10)');
  check('a dropped write makes progress_save return False', evalPy('progress_save()') === false);
  check('and sets save_failed', evalPy('progress_state["save_failed"]') === true);
  dropWrites = false;
  check('a working store saves again', evalPy('progress_save()') === true && evalPy('progress_state["save_failed"]') === false);

  hostStore.set('gd/progress', '{not json');
  const corrupt = evalPy('progress_load(True)["levels"]');
  check('corrupt progress falls back to empty', JSON.stringify(corrupt) === '{}', JSON.stringify(corrupt));
  execPy('progress_reset()');
  execPy('progress_save_settings(10, 12, 0)');
});

// ---- menu state machines -----------------------------------------------------

await section('menu: title, keyboard and mouse', async () => {
  check('starts in rm_menu', roomCurrent() === 'rm_menu');
  const first = frame(NO_INPUT);
  check('obj_game was created on demand', evalPy('instance_number("obj_game")') === 1);
  const title = first.commands.find((c) => c.kind === CMD.SPRITE && c.p[0] === TITLE_ATLAS);
  check('the menu frame draws the title sprite', title !== undefined);
  check('title is drawn at 2x', title !== undefined && title.p[3] > 1.9 && title.p[3] < 2.1, JSON.stringify(title?.p));
  check('draw budget is sane', first.count > 20 && first.count < 2000, `${first.count}`);
  check('the view scrolls', first.viewX > 0, `${first.viewX}`);

  frame(key('down'));
  frame(key('enter'));
  check('Down + Enter goes to rm_levels', roomCurrent() === 'rm_levels', roomCurrent());
  frame(key('escape'));
  check('Escape returns to the menu', roomCurrent() === 'rm_menu', roomCurrent());

  const [bx, by, bw, bh] = evalPy('_objects["obj_menu"]["module"]["menu_button_rect"](0)');
  frame(NO_INPUT);
  frame(click(bx + bw / 2, by + bh / 2));
  check('a click on Play goes to rm_levels', roomCurrent() === 'rm_levels', roomCurrent());
  frame(key('escape'));

  frame(key('down'));
  frame(key('down'));
  frame(key('down'));
  frame(key('enter'));
  check('third button is the icon screen', roomCurrent() === 'rm_icon', roomCurrent());
});

await section('icon screen saves colours', async () => {
  frame(NO_INPUT);
  const [cx, cy, cw, ch] = evalPy('_objects["obj_icon"]["module"]["icon_cell_rect"](0, 8)');
  frame(click(cx + cw / 2, cy + ch / 2));
  check('clicking the red cell sets the primary colour', evalPy('progress_settings()["primary"]') === 8);
  check('and persists it', JSON.parse(hostStore.get('gd/settings')).primary === 8);
  frame(key('tab'));
  frame(key('right'));
  check('Tab + Right moves the secondary colour', evalPy('progress_settings()["secondary"]') === 13);
  frame(key('tab'));
  frame(key('right'));
  check('the shape row is the third section', evalPy('progress_settings()["icon"]') === 1);
  const drawn = frame(NO_INPUT);
  const preview = drawn.commands.filter((c) => c.kind === CMD.SPRITE && c.p[0] >= 210 && c.p[0] < 214);
  check('the preview draws the chosen shape', preview.length >= 3, `${preview.length}`);
  frame(key('escape'));
  check('Escape returns to the menu', roomCurrent() === 'rm_menu', roomCurrent());
  execPy('progress_save_settings(10, 12, 0)');
});

await section('level select launches only verified rows', async () => {
  frame(key('down'));
  frame(key('enter'));
  check('in rm_levels', roomCurrent() === 'rm_levels');
  const rows = evalPy('instance_find("obj_levels").rows');
  check('builtins and custom levels are merged', rows.length === 4 && rows[0].builtin === true && rows[2].id === 'c1'
    && rows[3].verified === false && rows[0].verified === true, JSON.stringify(rows.map((r) => r.id)));
  frame(key('down'));
  frame(key('down'));
  frame(key('down'));
  check('selection moved to the draft', evalPy('instance_find("obj_levels").selected') === 3);
  frame(key('enter'));
  check('an unverified level refuses to launch', roomCurrent() === 'rm_levels', roomCurrent());
  check('with the verify message', evalPy('instance_find("obj_levels").message') === 'Verify it in the editor first');
  frame(key('up'));
  frame(key('enter'));
  check('a verified custom level launches into rm_play', roomCurrent() === 'rm_play', roomCurrent());
  const handoff = evalPy('ReplicatedStorage.Get("gd.run")');
  check('gd.run carries the level', handoff.level_id === 'c1' && handoff.mode === 'play' && handoff.source === 'custom'
    && handoff.return_to === 'rm_levels' && handoff.data.startsWith('GD1'), JSON.stringify(handoff));
});

// ---- run state ---------------------------------------------------------------

await section('run: checkpoints, death, pause, finish', async () => {
  frame(NO_INPUT);
  check('run is active', evalPy('run_active()') === true);
  check('length parsed from the header', evalPy('run_state["length_px"]') === 1800);
  check('attempt 1', evalPy('run_attempt()') === 1);
  check('the HUD sized the view', evalPy('view_width()') === 570 && evalPy('view_height()') === 330);
  const [vx, vy] = evalPy('view_get()');
  check('camera sits on the floor', vx === 0 && vy === 960 - 330, `${vx},${vy}`);

  execPy(`
class _Stub:
    pass
stub = _Stub()
stub.x = 300
stub.y = 885
stub.on_ground = True
stub.mode = "cube"
stub.visible = True
stub.hspeed = 0
stub.vspeed = 0
stub.gravity = 0
`);
  check('practice toggles on', evalPy('run_toggle_practice()') === true);
  check('practice_used is remembered', evalPy('run_state["practice_used"]') === true);
  execPy('run_add_checkpoint(stub)');
  execPy('stub.x = 600');
  execPy('run_add_checkpoint(stub)');
  check('two checkpoints added', evalPy('len(run_checkpoints())') === 2);
  check('checkpoint stores the column', evalPy('run_checkpoints()[1]["col"]') === 20);
  check('remove pops the last', evalPy('run_remove_checkpoint()["x"]') === 600 && evalPy('len(run_checkpoints())') === 1);
  check('remove on empty is None', evalPy('run_remove_checkpoint() is not None') === true && evalPy('run_remove_checkpoint()') === null);

  execPy('run_state["auto_timer"] = 0\nfor _ in range(119):\n    run_tick(stub)');
  check('no automatic checkpoint before 120 steps', evalPy('len(run_checkpoints())') === 0);
  execPy('run_tick(stub)');
  check('automatic checkpoint at 120 grounded steps', evalPy('len(run_checkpoints())') === 1);
  execPy('stub.on_ground = False\nfor _ in range(130):\n    run_tick(stub)');
  check('airborne: no automatic checkpoint', evalPy('len(run_checkpoints())') === 1);
  execPy('stub.on_ground = True\nrun_tick(stub)');
  check('lands: the pending checkpoint is placed', evalPy('len(run_checkpoints())') === 2);

  check('leaving practice restarts', evalPy('run_toggle_practice()') === false && evalPy('len(run_checkpoints())') === 0);
  frame(NO_INPUT);
  check('attempt counter moved on with the restart', evalPy('run_attempt()') === 2);

  execPy('stub.x = 600; run_tick(stub)');
  check('percent follows x over the level length', evalPy('run_state["pct"]') === 33);
  check('coin touch counts once', evalPy('run_coin_touch(stub, 0)') === true && evalPy('run_coin_touch(stub, 0)') === false);
  check('coin is held for the attempt', JSON.stringify(evalPy('run_state["coins_run"]')) === '[true,false,false]');
  check('death', evalPy('run_die(stub)') === true);
  check('death hides the player and bursts particles', evalPy('stub.visible') === false && evalPy('len(run_state["particles"])') === 24);
  check('death reverts coins in normal mode', JSON.stringify(evalPy('run_state["coins_run"]')) === '[false,false,false]');
  check('death bumps the attempt', evalPy('run_attempt()') === 3);
  check('a second death is ignored', evalPy('run_die(stub)') === false);
  const record = evalPy('progress_level("c1")');
  check('progress recorded the attempt', record.attempts >= 1 && record.best === 33, JSON.stringify(record));
  check('the run remembers its best', evalPy('run_state["best_pct"]') === 33);
  for (let i = 0; i < 40; i++) frame(NO_INPUT);
  check('40 steps later the room restarted', evalPy('run_dead()') === false && evalPy('run_attempt()') === 3 && roomCurrent() === 'rm_play');
  check('particles cleared', evalPy('len(run_state["particles"])') === 0);

  frame(key('escape'));
  check('Escape pauses', evalPy('run_paused()') === true && evalPy('run_input_locked()') === true);
  const px = evalPy('instance_find("obj_player").x');
  frame(NO_INPUT);
  check('the player does not move while paused', evalPy('instance_find("obj_player").x') === px);
  const paused = frame(NO_INPUT);
  check('the pause overlay draws', paused.count > 30, `${paused.count}`);
  frame(key('escape'));
  check('Escape resumes with the input lock', evalPy('run_paused()') === false && evalPy('run_input_locked()') === true);
  // The resume step itself counts: the player sits still for ten steps.
  const before = evalPy('instance_find("obj_player").x');
  for (let i = 0; i < 9; i++) frame(NO_INPUT);
  check('lock still held on step 10', evalPy('run_input_locked()') === true);
  check('the player did not move under the lock', evalPy('instance_find("obj_player").x') === before);
  frame(NO_INPUT);
  check('lock releases on step 11', evalPy('run_input_locked()') === false);
  check('and the player moves again', evalPy('instance_find("obj_player").x') === before + 5);

  check('pause: practice toggle from the overlay', evalPy('run_pause()') === true && evalPy('run_toggle_practice()') === true);
  execPy('stub.visible = True\nstub.x = 900\nrun_resume()\nrun_add_checkpoint(stub)');
  execPy('run_die(stub)');
  for (let i = 0; i < 41; i++) frame(NO_INPUT);
  check('practice respawn restores the checkpoint position', evalPy('instance_find("obj_player").x') >= 900
    && evalPy('instance_find("obj_player").x') < 960, `${evalPy('instance_find("obj_player").x')}`);
  check('and told the spawner to reset its window', evalPy('instance_find("obj_level").last_reset') === 30);
  check('the checkpoint is drawn', frame(NO_INPUT).commands.some((c) => c.kind === CMD.SPRITE && c.p[0] === 420));

  execPy('run_toggle_practice()');
  frame(NO_INPUT);
  execPy('run_coin_touch(stub, 2)\nrun_jump()\nrun_jump()');
  check('finish', evalPy('run_finish(stub)') === true);
  const result = evalPy('run_result()');
  check('result payload', result.finished === true && result.level_id === 'c1' && result.practice_used === true
    && result.practice === false && JSON.stringify(result.coins) === '[false,false,true]' && result.best_pct === 100
    && result.jumps === 2 && result.verified === false && result.new_best === true, JSON.stringify(result));
  check('gd.result is set', evalPy('ReplicatedStorage.Get("gd.result")["finished"]') === true);
  const done = evalPy('progress_level("c1")');
  check('progress: completed, best 100, coin 3', done.completed === true && done.best === 100 && done.coins[2] === true, JSON.stringify(done));
  const flash = frame(NO_INPUT);
  check('LEVEL COMPLETE flashes', flash.count > 40 && roomCurrent() === 'rm_play');
  for (let i = 0; i < 60; i++) frame(NO_INPUT);
  check('then the end screen', roomCurrent() === 'rm_end', roomCurrent());
  const end = frame(NO_INPUT);
  check('the end screen draws', end.count > 40, `${end.count}`);
  frame(key('escape'));
  check('Escape leaves the end screen for the menu', roomCurrent() === 'rm_menu', roomCurrent());
});

await section('verify run: no practice, marks verified, returns to the editor', async () => {
  execPy('run_start({"id": "c2", "name": "Draft", "data": "GD1;name=Draft;len=40|"}, "verify")');
  frame(NO_INPUT);
  check('in rm_play in verify mode', roomCurrent() === 'rm_play' && evalPy('run_mode()') === 'verify');
  check('practice is refused', evalPy('run_toggle_practice()') === false && evalPy('run_practice()') === false);
  check('run_input_locked is False while playing', evalPy('run_input_locked()') === false);
  execPy('run_finish(instance_find("obj_player"))');
  const result = evalPy('run_result()');
  check('verified result', result.verified === true && result.mode === 'verify', JSON.stringify(result));
  check('gd_store.mark_verified was called', JSON.stringify(evalPy('store_calls')) === '[["mark_verified","c2",1]]', JSON.stringify(evalPy('store_calls')));
  check('progress marks it verified', evalPy('progress_level("c2")["verified"]') === true);
  for (let i = 0; i < 61; i++) frame(NO_INPUT);
  check('end screen', roomCurrent() === 'rm_end', roomCurrent());
  frame(key('escape'));
  check('Escape returns to the editor after a verify run', roomCurrent() === 'rm_editor', roomCurrent());
});

await section('exit from the pause menu', async () => {
  execPy('run_start({"id": "builtin_1", "name": "Stereo Madness", "data": "GD1;len=120|", "builtin": True}, "play")');
  frame(NO_INPUT);
  frame(key('escape'));
  check('paused', evalPy('run_paused()') === true);
  const [x, y, w, h] = evalPy('_objects["obj_hud"]["module"]["pause_button_rect"](3)');
  const [vx, vy] = evalPy('view_get()');
  check('camera follows the player', vx === 0 && vy === 630, `${vx},${vy}`);
  frame(click(x + w / 2, y + h / 2));
  check('Exit returns to the level list', roomCurrent() === 'rm_levels', roomCurrent());
  const result = evalPy('ReplicatedStorage.Get("gd.result")');
  check('unfinished result written', result.finished === false && result.level_id === 'builtin_1', JSON.stringify(result));
  check('run inactive', evalPy('run_active()') === false);
  frame(key('escape'));
  check('back at the menu', roomCurrent() === 'rm_menu');
  frame(key('up'));
  check('Up from nothing focuses Quit, and Enter ends the game', frame(key('enter')).quit === true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
