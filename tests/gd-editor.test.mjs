/**
 * Geometry Dash editor: the document model (`gd_editor.py`) and the custom
 * level store (`gd_store.py`), headless.
 *
 * Runs the real Python scripts on MicroPython in Node with a Map standing in
 * for localStorage (the gd-codec harness idiom). Covers placing/erasing,
 * stroke grouping, undo/redo ordering, rotation cycles, set_length refusals,
 * clear as one action, the coin auto-index, the hand-rolled name field, the
 * save/read-back/verify rules and the simulated quota failure.
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

// ---- the TS constants (gd_const is generated from them) ---------------------

async function loadModules(paths) {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const out = [];
    for (const path of paths) out.push(await server.ssrLoadModule(path));
    return out;
  } finally {
    await server.close();
  }
}
const [C] = await loadModules(['/src/demo/gd/constants.ts']);

// ---- the Python side --------------------------------------------------------

const { loadMicroPython } = await import(pathToFileURL(join(root, 'src', 'vendor', 'micropython.js')).href);
const printed = [];
const mp = await loadMicroPython({ stdout: (line) => printed.push(line), stderr: (line) => console.error('  py:', line) });
const hostStore = new Map();
let dropWrites = false;
mp.registerJsModule('__host', {
  store_get: (key) => hostStore.get(key) ?? '',
  store_set: (key, value) => {
    if (dropWrites) return;
    if (value === '') hostStore.delete(key);
    else hostStore.set(key, value);
  },
});
mp.runPython(read('src', 'python', 'roblox.py'));
mp.runPython(read('src', 'python', 'prelude.py'));
const g = (name) => mp.globals.get(name);

g('__register_module')('gd_const', C.constantsPython());
g('__register_module')('gd_codec', script('gd_codec.py'));
g('__register_module')('gd_store', script('gd_store.py'));
g('__register_module')('gd_editor', script('gd_editor.py'));
mp.runPython(`
_E = require("gd_editor")
_S = require("gd_store")
_C = require("gd_codec")
def J(value):
    print(HttpService.JSONEncode(value))
`);

/** Evaluate a Python expression and return its JSON value. */
function py(expr) {
  printed.length = 0;
  mp.runPython(`J(${expr})`);
  return JSON.parse(printed.pop());
}
function pyRun(source) {
  mp.runPython(source);
}
const q = (text) => JSON.stringify(text);

// ---- the document model ----------------------------------------------------

await section('place and erase', async () => {
  pyRun('_d = _E.doc_new("Test Level")');
  check('a new doc has the header defaults and no objects', py('_d["name"]') === 'Test Level'
    && py('_d["len"]') === C.HEADER_DEFAULTS.len && py('len(_d["objects"])') === 0);
  check('a new doc is dirty and badged DRAFT*', py('_E.dirty(_d)') === true && py('_E.badge(_d)') === 'DRAFT*');
  check('place a block', py('_E.place(_d, 10, 0, "B", "")') === true && py('len(_d["objects"])') === 1);
  check('placing the same thing again reports no change', py('_E.place(_d, 10, 0, "B", "")') === false && py('len(_d["undo"])') === 1);
  check('replacing with a spike is a change', py('_E.place(_d, 10, 0, "S", "0")') === true);
  check('row above the grid is rejected', py(`_E.place(_d, 10, ${C.ROWS}, "B", "")`) === false);
  check('negative cells are rejected', py('_E.place(_d, -1, 0, "B", "")') === false && py('_E.place(_d, 10, -1, "B", "")') === false);
  check('a column at or past len is rejected', py('_E.place(_d, 100, 0, "B", "")') === false && py('_E.place(_d, 99, 0, "B", "")') === true);
  check('an unknown parameter is rejected', py('_E.place(_d, 20, 0, "P", "z")') === false);
  check('a missing parameter takes the default', py('_E.place(_d, 20, 0, "S", None)') === true
    && py('_d["objects"][_C.level_key(20, 0)][1]') === '0');
  check('erasing an empty cell reports no change', py('_E.erase(_d, 50, 5)') === false);
  check('erase removes the object', py('_E.erase(_d, 20, 0)') === true && py('_C.level_key(20, 0) in _d["objects"]') === false);
});

await section('paint strokes group into one undo action', async () => {
  pyRun('_d = _E.doc_new("Strokes")');
  pyRun('_E.begin_stroke(_d)');
  check('three cells painted in one stroke', py('_E.place(_d, 10, 0, "B", "")') === true
    && py('_E.place(_d, 11, 0, "B", "")') === true && py('_E.place(_d, 12, 0, "B", "")') === true);
  check('the stroke is still open (nothing on the undo stack)', py('len(_d["undo"])') === 0);
  check('end_stroke records it as one action', py('_E.end_stroke(_d)') === true && py('len(_d["undo"])') === 1);
  check('an empty stroke records nothing', (pyRun('_E.begin_stroke(_d)'), py('_E.end_stroke(_d)') === false && py('len(_d["undo"])') === 1));
  check('undo removes all three cells at once', py('_E.undo(_d)') === true && py('len(_d["objects"])') === 0);
  check('redo restores all three', py('_E.redo(_d)') === true && py('len(_d["objects"])') === 3);
});

await section('undo and redo ordering', async () => {
  pyRun('_d = _E.doc_new("Undo")');
  pyRun('_E.place(_d, 10, 0, "B", ""); _E.place(_d, 11, 1, "S", "0")');
  check('two separate actions recorded', py('len(_d["undo"])') === 2);
  check('undo takes back the LAST action first', py('_E.undo(_d)') === true
    && py('_C.level_key(10, 0) in _d["objects"]') === true && py('_C.level_key(11, 1) in _d["objects"]') === false);
  check('a second undo empties the doc', py('_E.undo(_d)') === true && py('len(_d["objects"])') === 0);
  check('undo on an empty stack refuses', py('_E.undo(_d)') === false);
  check('redo replays in order', py('_E.redo(_d)') === true && py('_C.level_key(10, 0) in _d["objects"]') === true
    && py('_E.redo(_d)') === true && py('_C.level_key(11, 1) in _d["objects"]') === true);
  check('redo past the end refuses', py('_E.redo(_d)') === false);
  pyRun('_E.undo(_d)');
  check('a fresh action clears the redo stack', py('_E.place(_d, 30, 0, "B", "")') === true && py('len(_d["redo"])') === 0
    && py('_E.redo(_d)') === false);
  check('replace then undo restores what was under it', (pyRun('_x = _E.doc_new("X"); _E.place(_x, 10, 0, "B", ""); _E.place(_x, 10, 0, "S", "0"); _E.undo(_x)'),
    JSON.stringify(py('_x["objects"][_C.level_key(10, 0)]')) === JSON.stringify(['B', ''])));
});

await section('rotate cycles the parameter', async () => {
  pyRun('_d = _E.doc_new("Rotate")');
  pyRun('_E.place(_d, 10, 0, "S", "0"); _E.place(_d, 11, 0, "P", "y"); _E.place(_d, 12, 0, "B", "")');
  check('a spike flips up -> down -> up', (pyRun('_E.rotate(_d, 10, 0)'), py('_d["objects"][_C.level_key(10, 0)][1]') === '1')
    && (pyRun('_E.rotate(_d, 10, 0)'), py('_d["objects"][_C.level_key(10, 0)][1]') === '0'));
  check('a pad cycles its five colours back around', (pyRun('for _i in range(5):\n    _E.rotate(_d, 11, 0)'),
    py('_d["objects"][_C.level_key(11, 0)][1]') === 'y'));
  check('a block does not rotate', py('_E.rotate(_d, 12, 0)') === false);
  check('an empty cell does not rotate', py('_E.rotate(_d, 13, 0)') === false);
  check('rotation is undoable', (pyRun('_E.rotate(_d, 10, 0); _E.undo(_d)'), py('_d["objects"][_C.level_key(10, 0)][1]') === '0'));
});

await section('set_length', async () => {
  pyRun('_d = _E.doc_new("Length")');
  pyRun('_E.place(_d, 50, 3, "B", "")');
  check('shrinking past an object is refused', py('_E.set_length(_d, 40)[0]') === false
    && py('_E.set_length(_d, 40)[1]').includes('lie beyond') && py('_d["len"]') === 100);
  check('shrinking to just past it works', py('_E.set_length(_d, 51)[0]') === true && py('_d["len"]') === 51);
  check(`below MIN_LEN (${C.MIN_LEN}) is refused`, py(`_E.set_length(_d, ${C.MIN_LEN - 1})[0]`) === false);
  check(`above MAX_LEN (${C.MAX_LEN}) is refused`, py(`_E.set_length(_d, ${C.MAX_LEN + 1})[0]`) === false);
  check('the same length is a friendly no-op', py('_E.set_length(_d, 51)[0]') === true && py('len(_d["undo"])') === 2);
  check('the length change is undoable', py('_E.undo(_d)') === true && py('_d["len"]') === 100);
  check('and redoable', py('_E.redo(_d)') === true && py('_d["len"]') === 51);
});

await section('clear is one undoable action', async () => {
  pyRun('_d = _E.doc_new("Clear")');
  pyRun('_E.place(_d, 10, 0, "B", ""); _E.place(_d, 11, 0, "S", "0"); _E.place(_d, 12, 2, "O", "y")');
  const actionsBefore = py('len(_d["undo"])');
  check('clear empties the doc', py('_E.clear(_d)') === true && py('len(_d["objects"])') === 0);
  check('as exactly one action', py('len(_d["undo"])') === actionsBefore + 1);
  check('undo brings all three back', py('_E.undo(_d)') === true && py('len(_d["objects"])') === 3);
  check('clear on an empty doc refuses', (pyRun('_e2 = _E.doc_new("E")'), py('_E.clear(_e2)') === false));
});

await section('coins auto-index', async () => {
  pyRun('_d = _E.doc_new("Coins")');
  check('three coins take indices 0, 1, 2', py('_E.place(_d, 10, 1, "C", None)') === true
    && py('_E.place(_d, 20, 1, "C", None)') === true && py('_E.place(_d, 30, 1, "C", None)') === true
    && py('_d["objects"][_C.level_key(10, 1)][1]') === '0'
    && py('_d["objects"][_C.level_key(20, 1)][1]') === '1'
    && py('_d["objects"][_C.level_key(30, 1)][1]') === '2');
  check('a fourth coin is refused', py('_E.place(_d, 40, 1, "C", None)') === false && py('len(_d["objects"])') === 3);
  check('erasing the middle coin frees its index for the next', (pyRun('_E.erase(_d, 20, 1)'),
    py('_E.place(_d, 50, 1, "C", None)') === true && py('_d["objects"][_C.level_key(50, 1)][1]') === '1'));
  check('a coin placed onto itself is unchanged', py('_E.place(_d, 10, 1, "C", None)') === false);
  check('rotating a coin skips indices other coins hold', py('_E.rotate(_d, 10, 1)') === false, 'all three indices are taken');
  check('undoing the coin restores the free index', (pyRun('_E.undo(_d)'), py('_E.place(_d, 60, 1, "C", None)') === true
    && py('_d["objects"][_C.level_key(60, 1)][1]') === '1'));
});

await section('the name field', async () => {
  pyRun('_f = _E.field_new("")');
  pyRun('for _ch in "hi":\n    _E.field_key(_f, _ch, False)');
  check('typing lowercase letters', py('_f["text"]') === 'hi' && py('_f["caret"]') === 2);
  pyRun('_E.field_key(_f, "space", False); _E.field_key(_f, "g", True); _E.field_key(_f, "d", True)');
  check('shift makes capitals; space works', py('_f["text"]') === 'hi GD');
  pyRun('_E.field_key(_f, "3", False); _E.field_key(_f, "minus", False)');
  check('digits and minus', py('_f["text"]') === 'hi GD3-');
  pyRun('_E.field_key(_f, "backspace", False); _E.field_key(_f, "backspace", False)');
  check('backspace deletes before the caret', py('_f["text"]') === 'hi GD' && py('_f["caret"]') === 5);
  pyRun('_E.field_key(_f, "home", False); _E.field_key(_f, "right", False); _E.field_key(_f, "x", False)');
  check('the caret moves and inserts mid-string', py('_f["text"]') === 'hxi GD' && py('_f["caret"]') === 2);
  pyRun('_E.field_key(_f, "delete", False)');
  check('delete removes after the caret', py('_f["text"]') === 'hx GD');
  pyRun('_f2 = _E.field_new("x" * 20)');
  pyRun('_E.field_key(_f2, "a", False)');
  check(`the ${C.MAX_NAME}-character cap holds`, py('len(_f2["text"])') === C.MAX_NAME);
  check('enter marks the field done', py('_f["done"]') === false && (pyRun('_E.field_key(_f, "enter", False)'), py('_f["done"]') === true));
  check('unknown keys are ignored', (pyRun('_E.field_key(_f, "slash", False); _E.field_key(_f, "pageup", False)'), py('_f["text"]') === 'hx GD'));
});

await section('palette hit-testing and cell_at', async () => {
  const rect = py('_E.palette_rect(0)');
  check('palette_rect(0) sits at the left of the bar', JSON.stringify(rect) === JSON.stringify([5, 272, 16, 16]), JSON.stringify(rect));
  check('hit_palette finds an entry by its centre', py('_E.hit_palette(5 + 3 * 16 + 8, 280)') === 3);
  check('hit_palette misses above the row', py('_E.hit_palette(60, 260)') === -1);
  check('hit_palette misses past the last entry', py(`_E.hit_palette(5 + ${C.PALETTE.length} * 16 + 8, 280)`) === -1);
  check('cell_at maps a room point to its cell', JSON.stringify(py('_E.cell_at(315, 880, 0, 0)')) === '[10,0]');
  check('cell_at applies the scroll', JSON.stringify(py('_E.cell_at(15, 250, 300, 630)')) === '[10,0]');
  check('doc_tiles mirrors the blocks onto the tile grid', (pyRun('_d = _E.doc_new("T"); _E.place(_d, 9, 0, "B", ""); _E.place(_d, 9, 1, "S", "0")'),
    JSON.stringify(py('[[k[0], k[1], v] for k, v in _E.doc_tiles(_d).items()]')) === JSON.stringify([[9, C.ROWS - 1, C.TILE_BLOCK]])));
});

await section('settings', async () => {
  pyRun('_d = _E.doc_new("Set")');
  check('mode wraps 0..7', JSON.stringify(py('_E.adjust_setting(_d, 0, -1)')) === JSON.stringify(['mode', 7])
    && JSON.stringify(py('_E.adjust_setting(_d, 0, 1)')) === JSON.stringify(['mode', 0]));
  check('speed wraps 0..4', JSON.stringify(py('_E.adjust_setting(_d, 1, 4)')) === JSON.stringify(['speed', 0]));
  check('diff wraps 1..10', JSON.stringify(py('_E.adjust_setting(_d, 3, -1)')) === JSON.stringify(['diff', 10]));
  check('beat clamps and steps by 5', JSON.stringify(py('_E.adjust_setting(_d, 4, 1)')) === JSON.stringify(['beat', 35])
    && JSON.stringify(py('_E.adjust_setting(_d, 4, -100)')) === JSON.stringify(['beat', 10]));
  check('setting_label names the mode', py('_E.setting_label(_d, 0)') === 'mode cube');
});

// ---- the store -------------------------------------------------------------

const indexRaw = () => hostStore.get('gd/index') ?? '';
const index = () => JSON.parse(indexRaw() || '{}');

await section('save_level writes the index and the level, with read-back', async () => {
  hostStore.clear();
  pyRun('_d = _E.doc_new("My First")');
  pyRun('_d["len"] = 40; _E.place(_d, 10, 0, "S", "0"); _E.place(_d, 12, 1, "B", "")');
  const saved = py('_S.save_level(_d)');
  check('save succeeds', saved[0] === true && saved[1] === 'Saved', JSON.stringify(saved));
  check('the doc received its id', typeof py('_d["id"]') === 'string' && py('_d["id"]').length > 0);
  pyRun('_id = _d["id"]');
  check('gd/index is in the store', hostStore.has('gd/index'));
  const entry = index().entries[py('_id')];
  check('the index entry has the name, unverified', entry && entry.name === 'My First' && entry.verified === false && entry.len === 40, indexRaw());
  const record = JSON.parse(hostStore.get(`gd/level/${py('_id')}`) ?? '{}');
  check('gd/level/<id> holds the canonical data', record.data === py('_C.encode_level(_d)') && record.verified === false);
  check('an invalid doc refuses to save', (pyRun('_bad = _E.doc_new("")'), py('_S.save_level(_bad)')[0] === false));
  check('load_level round-trips', py('_S.load_level(_id)["data"]') === py('_C.encode_level(_d)'));
});

await section('verified rules: unchanged data keeps it, changed clears it', async () => {
  pyRun('_data = _C.encode_level(_d)');
  const marked = py('_S.mark_verified(_id, _data, 7)');
  check('mark_verified with matching data succeeds', marked[0] === true, JSON.stringify(marked));
  check('the index now says verified with the attempts stored', index().entries[py('_id')].verified === true
    && JSON.parse(hostStore.get(`gd/level/${py('_id')}`)).verify_attempts === 7);
  check('saving UNCHANGED data keeps verified', py('_S.save_level(_d)')[0] === true
    && index().entries[py('_id')].verified === true);
  pyRun('_E.place(_d, 20, 0, "S", "0")');
  check('saving CHANGED data clears verified', py('_S.save_level(_d)')[0] === true
    && index().entries[py('_id')].verified === false
    && JSON.parse(hostStore.get(`gd/level/${py('_id')}`)).verify_attempts === 0);
});

await section('a stale mark_verified is ignored', async () => {
  const stale = py(`_S.mark_verified(_id, ${q('GD1;name=Old;len=40|S9.0')}, 3)`);
  check('data from before the edit is refused', stale[0] === false && stale[1].includes('changed since'), JSON.stringify(stale));
  check('the level stays unverified', index().entries[py('_id')].verified === false);
  const missing = py(`_S.mark_verified(${q('no-such-id')}, ${q('GD1;len=40|')}, 1)`);
  check('an unknown id is refused', missing[0] === false);
});

await section('a quota failure returns (False, ...) and leaves the index alone', async () => {
  const before = indexRaw();
  const levelBefore = hostStore.get(`gd/level/${py('_id')}`);
  dropWrites = true;
  pyRun('_E.place(_d, 25, 0, "B", "")');
  const result = py('_S.save_level(_d)');
  dropWrites = false;
  check('the save reports failure', result[0] === false && result[1].includes('SAVE FAILED'), JSON.stringify(result));
  check('the index is untouched', indexRaw() === before);
  check('the stored level is untouched', hostStore.get(`gd/level/${py('_id')}`) === levelBefore);
  check('a NEW level under quota failure stores nothing', (() => {
    dropWrites = true;
    pyRun('_n = _E.doc_new("Fresh"); _n["len"] = 40');
    const r = py('_S.save_level(_n)');
    dropWrites = false;
    return r[0] === false && indexRaw() === before;
  })());
});

await section('doc round trip and badges over the store', async () => {
  pyRun('_S.save_level(_d)');
  pyRun('_rec = _S.load_level(_d["id"])');
  pyRun('_back = _E.doc_from_level(_C.decode_level(_rec["data"]), _d["id"], _rec["verified"], _rec["data"])');
  check('doc_from_level reproduces the doc', py('_C.encode_level(_back)') === py('_C.encode_level(_d)')
    && py('_back["id"]') === py('_d["id"]'));
  check('a freshly loaded doc is clean and badged UNVERIFIED', py('_E.dirty(_back)') === false && py('_E.badge(_back)') === 'UNVERIFIED');
  pyRun('_back["saved_verified"] = True');
  check('the badge follows the verified flag', py('_E.badge(_back)') === 'VERIFIED');
  pyRun('_E.place(_back, 26, 0, "B", "")');
  check('an edit turns the badge into DRAFT*', py('_E.dirty(_back)') === true && py('_E.badge(_back)') === 'DRAFT*');
  pyRun('_E.undo(_back)');
  check('undoing the edit makes it clean again', py('_E.dirty(_back)') === false && py('_E.badge(_back)') === 'VERIFIED');
  check('doc_to_level strips the editor fields', py('sorted(_E.doc_to_level(_back).keys())').join(',') === 'author,beat,bg,diff,extra,id,len,mode,name,objects,size,speed');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
