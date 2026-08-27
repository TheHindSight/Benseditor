/**
 * Block mode: the same blocks must compile to Luau and to Python that
 * BEHAVE THE SAME.
 *
 * Each fixture workspace is generated in both languages, checked for the
 * expected shape (no `goto`, the right calls), then run on both engines --
 * luau-web for Luau, the vendored MicroPython for Python -- and the decoded
 * draw records after N frames have to match number for number.
 *
 * Run with: node --experimental-wasm-jspi tests/blocks.test.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import { LuauState } from 'luau-web';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` -- ${detail}` : ''}`);
};

async function section(name, body) {
  console.log(`\n=== ${name} ===`);
  try {
    await body();
  } catch (error) {
    failed++;
    const detail = String(error?.stack ?? error).split('\n').slice(0, 8).join(' | ');
    console.log(`  FAIL ${name} threw -- ${detail}`);
  }
}

// ---- load the TypeScript modules -------------------------------------------

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

const [gen, defs, api] = await loadModules(['/src/blocks/generate.ts', '/src/blocks/blockDefs.ts', '/src/ui/apiSurface.ts']);
const { generateSource, emptyWorkspace, definedEventsOf, addEventHat } = gen;

// ---- fixture builders --------------------------------------------------------

const num = (n) => ({ block: { type: 'math_number', fields: { NUM: n } } });
const numShadow = (n) => ({ shadow: { type: 'math_number', fields: { NUM: n } } });
const txt = (t) => ({ block: { type: 'text', fields: { TEXT: t } } });
const key = (k) => ({ shadow: { type: 'bs_key', fields: { KEY: k } } });
const colour = (c) => ({ shadow: { type: 'bs_colour', fields: { COLOUR: c } } });
const self = () => ({ shadow: { type: 'bs_self' } });
const other = () => ({ block: { type: 'bs_other' } });
const getVar = (id) => ({ block: { type: 'variables_get', fields: { VAR: { id } } } });
const field = (name) => ({ block: { type: 'bs_get_field', fields: { FIELD: name } } });
const value = (type, inputs = {}, fields = {}, extra = {}) => ({ block: { type, inputs, fields, ...extra } });
const bool = (v) => ({ block: { type: 'logic_boolean', fields: { BOOL: v ? 'TRUE' : 'FALSE' } } });
const compare = (op, a, b) => value('logic_compare', { A: a, B: b }, { OP: op });
const arith = (op, a, b) => value('math_arithmetic', { A: a, B: b }, { OP: op });

/** A statement block; `next` is filled in by `chain`. */
const stmt = (type, inputs = {}, fields = {}, extra = {}) => ({ type, inputs, fields, ...extra });
const setVar = (id, v) => stmt('variables_set', { VALUE: v }, { VAR: { id } });
const changeVar = (id, v) => stmt('math_change', { DELTA: v }, { VAR: { id } });
const changeField = (name, v) => stmt('bs_change_field', { VALUE: v }, { FIELD: name });
const ifThen = (cond, ...body) => stmt('controls_if', { IF0: cond, DO0: { block: chain(...body) } });
const flow = (which) => stmt('controls_flow_statements', {}, { FLOW: which });
const circle = (x, y, r = 1) => stmt('bs_draw_circle', { X: x, Y: y, RADIUS: numShadow(r), OUTLINE: bool(false) });
const rect = (x1, y1, x2, y2) => stmt('bs_draw_rectangle', { X1: x1, Y1: y1, X2: x2, Y2: y2, OUTLINE: bool(false) });

/** Link statements into one stack; returns the first block. */
function chain(...blocks) {
  const list = blocks.filter(Boolean);
  for (let i = list.length - 1; i > 0; i--) list[i - 1].next = { block: list[i] };
  return list[0];
}

let nextY = 0;
const hat = (event, ...body) => ({ type: `bs_event_${event}`, id: `hat_${event}_${nextY}`, x: 10, y: (nextY += 200), inputs: { BODY: { block: chain(...body) } } });
const workspace = (blocks, variables = []) => ({ variables, blocks: { languageVersion: 0, blocks } });
const vars = (...names) => names.map((name) => ({ name, id: `var_${name}` }));
const V = (name) => `var_${name}`;

// ---- fixtures ----------------------------------------------------------------
//
// Each fixture is a small game: object scripts (block workspaces or plain
// source for helpers), a room, a list of per-frame input strings, and the
// fragments the generated code must contain.

const FONT = (() => {
  const glyphs = [];
  let atlas = 900;
  for (const ch of 'score: 0123456789') glyphs.push(`${ch.charCodeAt(0)},${atlas++},7,6,9`);
  return glyphs.join(';');
})();

const FIXTURES = [
  {
    name: 'step hat: keyboard_check -> change x; draw hat: rectangle',
    objects: {
      obj_player: workspace([
        hat('step', ifThen(value('bs_keyboard_check', { KEY: key('right') }), changeField('x', num(5)))),
        hat('draw', rect(field('x'), field('y'), arith('ADD', field('x'), num(4)), arith('ADD', field('y'), num(4)))),
      ]),
    },
    room: 'obj_player,0,100,1,1,0',
    inputs: ['right|||0,0,0,0', 'right|||0,0,0,0', '|||0,0,0,0'],
    luau: ['function obj.step(self)', 'if keyboard_check("right") then', 'self.x += 5', 'function obj.draw(self)', 'draw_rectangle(self.x, self.y, self.x + 4, self.y + 4, false)'],
    python: ['def step(self):', 'if keyboard_check("right"):', 'self.x += 5', 'def draw(self):', 'draw_rectangle(self.x, self.y, self.x + 4, self.y + 4, False)'],
  },
  {
    name: 'create sets a variable and an alarm; alarm creates an instance and destroys self',
    objects: {
      obj_timer: workspace([
        hat('create',
          setVar(V('score'), num(7)),
          stmt('bs_set_alarm', { INDEX: numShadow(1), VALUE: numShadow(2) })),
        hat('alarm',
          ifThen(compare('EQ', value('bs_alarm_index'), num(1)),
            stmt('bs_instance_create_stmt', { X: numShadow(50), Y: numShadow(60) }, { OBJECT: 'obj_spawned' }),
            stmt('bs_destroy', { INST: self() }))),
        hat('draw', circle(getVar(V('score')), field('x'))),
      ], vars('score')),
      obj_spawned: workspace([
        hat('draw', rect(field('x'), field('y'), num(52), num(62))),
      ]),
    },
    room: 'obj_timer,10,20,1,1,0',
    inputs: ['', '', '', ''],
    luau: ['self.score = 7', 'self.alarms[1] = 2', 'function obj.alarm(self, index)', 'if index == 1 then', 'instance_create(50, 60, "obj_spawned")', 'self:destroy()'],
    python: ['self.score = 7', 'self.alarms[1] = 2', 'def alarm(self, index):', 'if index == 1:', 'instance_create(50, 60, "obj_spawned")', 'self.destroy()'],
  },
  {
    name: 'collision hat using other; draw_gui with text_join',
    objects: {
      obj_hero: workspace([
        hat('create', setVar(V('score'), num(0))),
        hat('collision',
          ifThen(value('bs_is_a', { INST: other() }, { OBJECT: 'obj_pickup' }),
            stmt('bs_destroy', { INST: other() }),
            changeVar(V('score'), num(1)))),
        hat('draw_gui',
          stmt('bs_draw_text', {
            X: numShadow(0), Y: numShadow(0),
            TEXT: value('text_join', { ADD0: txt('score: '), ADD1: getVar(V('score')) }, {}),
            COLOUR: colour('c_red'),
          })),
      ], vars('score')),
    },
    plain: { obj_pickup: { sprite: 'spr_16' } },
    sprites: [['spr_16', 0, 1, 16, 16, 0, 0, 12, 0, 0, 15, 15]],
    heroSprite: 'spr_16',
    room: 'obj_hero,50,50,1,1,0;obj_pickup,54,54,1,1,0',
    inputs: ['', ''],
    luau: ['function obj.collision(self, other)', 'other:is_a("obj_pickup")', 'other:destroy()', 'self.score += 1', 'draw_text(0, 0, ', 'c_red)'],
    python: ['def collision(self, other):', 'other.is_a("obj_pickup")', 'other.destroy()', 'self.score += 1', 'draw_text(0, 0, ', 'c_red)'],
  },
  {
    name: 'for loop with if/continue, while loop with break, repeat',
    objects: {
      obj_loops: workspace([
        hat('create',
          setVar(V('score'), num(0)),
          stmt('controls_for', {
            FROM: numShadow(1), TO: numShadow(5), BY: numShadow(1),
            DO: { block: chain(
              ifThen(compare('EQ', getVar(V('i')), num(3)), flow('CONTINUE')),
              changeVar(V('score'), getVar(V('i'))),
            ) },
          }, { VAR: { id: V('i') } }),
          stmt('controls_whileUntil', {
            BOOL: compare('LT', getVar(V('score')), num(100)),
            DO: { block: chain(
              changeVar(V('score'), num(3)),
              ifThen(compare('EQ', getVar(V('score')), num(18)), flow('BREAK')),
            ) },
          }, { MODE: 'WHILE' }),
          stmt('controls_repeat_ext', { TIMES: numShadow(2), DO: { block: changeVar(V('score'), num(1)) } }),
          setVar(V('total'), num(0)),
          stmt('controls_forEach', {
            LIST: value('lists_create_with', { ADD0: num(10), ADD1: num(20), ADD2: num(30) }, {}, { itemCount: 3 }),
            DO: { block: changeVar(V('total'), getVar(V('item'))) },
          }, { VAR: { id: V('item') } })),
        hat('draw', circle(getVar(V('score')), getVar(V('total'))), circle(getVar(V('i')), getVar(V('item')))),
      ], vars('score', 'i', 'total', 'item')),
    },
    room: 'obj_loops,0,0,1,1,0',
    inputs: [''],
    luau: ['for i_loop = 1, 5, 1 do', 'self.i = i_loop', 'continue', 'while self.score < 100 do', 'break', 'for count = 1, 2 do', 'in ipairs('],
    python: ['def create(self):', 'self.i = i_loop', 'continue', 'while self.score < 100:', 'break', 'for count in range(2):', 'for item_item in [10, 20, 30]:'],
  },
  {
    name: 'procedures with parameters called from a hat',
    objects: {
      obj_procs: workspace([
        {
          type: 'procedures_defnoreturn', id: 'def_bump', x: 10, y: 900,
          extraState: { params: [{ name: 'n', id: V('n') }] }, fields: { NAME: 'bump' },
          inputs: { STACK: { block: changeVar(V('score'), getVar(V('n'))) } },
        },
        {
          type: 'procedures_defreturn', id: 'def_twice', x: 10, y: 1100,
          extraState: { params: [{ name: 'n', id: V('n') }] }, fields: { NAME: 'twice' },
          inputs: { RETURN: arith('MULTIPLY', getVar(V('n')), num(2)) },
        },
        hat('create',
          setVar(V('score'), num(1)),
          stmt('procedures_callnoreturn', {
            ARG0: value('procedures_callreturn', { ARG0: num(5) }, {}, { extraState: { name: 'twice', params: ['n'] } }),
          }, {}, { extraState: { name: 'bump', params: ['n'] } })),
        hat('draw', circle(getVar(V('score')), num(0))),
      ], vars('score', 'n')),
    },
    room: 'obj_procs,0,0,1,1,0',
    inputs: [''],
    luau: ['local function bump(self, n)', 'self.score += n', 'local function twice(self, n)', 'return n * 2', 'bump(self, twice(self, 5))'],
    python: ['def bump(self, n):', 'self.score += n', 'def twice(self, n):', 'return n * 2', 'bump(self, twice(self, 5))'],
  },
  {
    name: 'tree: Instance.new, set Parent, set Name, find_first_child, get_children',
    objects: {
      obj_parent: workspace([
        hat('create',
          stmt('bs_instance_new_stmt', { PARENT: self() }, { OBJECT: 'obj_child' }),
          setVar(V('kid'), value('bs_instance_create', { X: numShadow(5), Y: numShadow(6) }, { OBJECT: 'obj_child' })),
          stmt('bs_set_parent', { INST: getVar(V('kid')), PARENT: self() }),
          stmt('bs_set_name', { INST: getVar(V('kid')), NAME: txt('kid') })),
        hat('draw',
          circle(value('lists_length', { VALUE: value('bs_get_children', { INST: self() }) }), num(0)),
          rect(
            value('bs_get_field_of', { INST: value('bs_find_first_child', { INST: self(), NAME: txt('kid') }) }, { FIELD: 'x' }),
            value('bs_get_field_of', { INST: value('bs_find_first_child', { INST: self(), NAME: txt('kid') }) }, { FIELD: 'y' }),
            num(9), num(9)),
          circle(value('bs_get_field_of', { INST: value('bs_get_parent', { INST: getVar(V('kid')) }) }, { FIELD: 'x' }), num(1))),
      ], vars('kid')),
    },
    plain: { obj_child: {} },
    room: 'obj_parent,30,40,1,1,0',
    inputs: ['', ''],
    luau: ['Instance.new("obj_child", self)', 'self.kid = instance_create(5, 6, "obj_child")', 'self.kid.Parent = self', "self.kid.Name = 'kid'", "self:find_first_child('kid').x", '#self:get_children()', 'self.kid.Parent.x'],
    python: ['Instance.new("obj_child", self)', 'self.kid = instance_create(5, 6, "obj_child")', 'self.kid.Parent = self', "self.kid.Name = 'kid'", "self.find_first_child('kid').x", 'len(self.get_children())', 'self.kid.Parent.x'],
  },
  {
    name: 'lists, text and maths',
    objects: {
      obj_data: workspace([
        hat('create',
          setVar(V('items'), value('lists_create_with', { ADD0: num(3), ADD1: num(1), ADD2: num(2) }, {}, { itemCount: 3 })),
          setVar(V('score'), arith('ADD',
            value('lists_length', { VALUE: getVar(V('items')) }),
            value('lists_getIndex', { VALUE: getVar(V('items')), AT: num(3) }, { MODE: 'GET', WHERE: 'FROM_START' }, { extraState: { isStatement: false } }))),
          setVar(V('label'), value('text_join', { ADD0: txt('ab'), ADD1: txt('cd') }, {}, { extraState: { itemCount: 2 } })),
          setVar(V('dist'), value('bs_clamp', {
            VALUE: value('bs_point_distance', { X1: numShadow(0), Y1: numShadow(0), X2: numShadow(3), Y2: numShadow(4) }),
            LOW: numShadow(0), HIGH: numShadow(10),
          })),
          stmt('bs_storage_set', { KEY: txt('best'), VALUE: value('bs_sign', { VALUE: num(-9) }) })),
        hat('draw',
          circle(getVar(V('score')), value('text_length', { VALUE: getVar(V('label')) })),
          circle(getVar(V('dist')), value('bs_storage_get', { KEY: txt('best'), DEFAULT: num(0) })),
          circle(value('bs_lengthdir_x', { LENGTH: numShadow(10), DIRECTION: numShadow(0) }), value('bs_room_width'))),
      ], vars('items', 'score', 'label', 'dist')),
    },
    room: 'obj_data,0,0,1,1,0',
    inputs: [''],
    luau: ['self.items = {3, 1, 2}', '#self.items', '(self.items)[3]', "ReplicatedStorage:Set('best', sign(-9))", "ReplicatedStorage:Get('best', 0)", 'clamp(point_distance(0, 0, 3, 4), 0, 10)', 'lengthdir_x(10, 0)', 'room_width()'],
    python: ['self.items = [3, 1, 2]', 'len(self.items)', 'self.items[2]', "ReplicatedStorage.Set('best', sign(-9))", "ReplicatedStorage.Get('best', 0)", 'clamp(point_distance(0, 0, 3, 4), 0, 10)', 'lengthdir_x(10, 0)', 'room_width()'],
  },
];

// ---- static checks -----------------------------------------------------------

await section('block language covers only documented engine names', async () => {
  const documented = new Set([
    ...api.ENGINE_FUNCTIONS.map((e) => e.name),
    ...api.INSTANCE_METHODS.map((e) => e.name),
    ...api.INSTANCE_FIELDS.map((e) => e.name),
    ...api.COLOURS,
    ...Object.entries(api.NAMESPACE_MEMBERS).flatMap(([owner, entries]) => entries.map((e) => `${owner}.${e.name}`)),
  ]);
  const missing = defs.ENGINE_BLOCK_NAMES.filter((name) => !documented.has(name));
  check(`every engine name a block uses is in apiSurface (${defs.ENGINE_BLOCK_NAMES.length} names)`, missing.length === 0, missing.join(', '));
  check('the block language reaches a good chunk of the API', defs.ENGINE_BLOCK_NAMES.length > 70, String(defs.ENGINE_BLOCK_NAMES.length));
});

await section('events match the code editor', async () => {
  const source = read('src', 'ui', 'objectEditor.ts');
  const events = [...source.matchAll(/\{ name: '([a-z_]+)', label: '[^']*', args: '([^']*)'/g)].map((m) => ({ name: m[1], args: m[2].split(',').map((s) => s.trim()) }));
  check('found EVENTS in objectEditor.ts', events.length === 12, String(events.length));
  const same = events.length === defs.BLOCK_EVENTS.length && events.every((e, i) => e.name === defs.BLOCK_EVENTS[i].name && e.args.join() === defs.BLOCK_EVENTS[i].args.join());
  check('BLOCK_EVENTS has the same names, order and args as EVENTS', same, JSON.stringify(defs.BLOCK_EVENTS.map((e) => [e.name, e.args])));
});

await section('every block in the toolbox has a definition and both generators', async () => {
  defs.installBlocks();
  defs.installBlocks(); // idempotent
  const Blockly = (await import('blockly'));
  const { luaGenerator } = await import('blockly/lua');
  const { pythonGenerator } = await import('blockly/python');
  const types = [];
  const walk = (items) => {
    for (const item of items) {
      if (item.kind === 'block') types.push(item.type);
      if (item.contents) walk(item.contents);
    }
  };
  walk(defs.TOOLBOX.contents);
  const undefinedBlocks = types.filter((t) => !Blockly.Blocks[t]);
  check(`toolbox blocks are all defined (${types.length})`, undefinedBlocks.length === 0, undefinedBlocks.join(', '));
  const noLua = [...new Set([...types, ...defs.CUSTOM_BLOCK_TYPES])].filter((t) => !luaGenerator.forBlock[t]);
  const noPy = [...new Set([...types, ...defs.CUSTOM_BLOCK_TYPES])].filter((t) => !pythonGenerator.forBlock[t]);
  check('every block has a Luau generator', noLua.length === 0, noLua.join(', '));
  check('every block has a Python generator', noPy.length === 0, noPy.join(', '));
  check('indentation matches the project style', luaGenerator.INDENT === '\t' && pythonGenerator.INDENT === '    ');
  check('custom block types are all prefixed bs_', defs.CUSTOM_BLOCK_TYPES.every((t) => t.startsWith('bs_')));
});

await section('workspace helpers', async () => {
  const empty = emptyWorkspace();
  check('empty workspace defines no events', definedEventsOf(empty).length === 0);
  check('empty workspace generates a valid empty Luau module', generateSource(empty, 'luau') === '--!strict\n-- generated from blocks; edit the blocks, not this file\n\nlocal obj = {}\n\nreturn obj\n', JSON.stringify(generateSource(empty, 'luau')));
  check('empty workspace generates an empty Python module', generateSource(empty, 'python') === '# generated from blocks; edit the blocks, not this file\n\n', JSON.stringify(generateSource(empty, 'python')));

  const withStep = addEventHat(empty, 'step');
  const withBoth = addEventHat(withStep, 'create');
  check('addEventHat does not mutate its input', definedEventsOf(empty).length === 0 && definedEventsOf(withStep).join() === 'step');
  check('definedEventsOf lists hats in engine order', definedEventsOf(withBoth).join() === 'create,step');
  const [a, b] = withBoth.blocks.blocks;
  check('new hats stack downwards', b.y > a.y, `${a.y} -> ${b.y}`);
  check('hats get unique ids', a.id && b.id && a.id !== b.id);
  const luau = generateSource(withBoth, 'luau');
  const python = generateSource(withBoth, 'python');
  check('empty hats generate empty handlers in Luau', luau.includes('function obj.create(self)\nend') && luau.includes('function obj.step(self)\nend'), luau);
  check('empty hats generate pass in Python', python.includes('def create(self):\n    pass') && python.includes('def step(self):\n    pass'), python);
  check('procedures and hats precede return obj', luau.trimEnd().endsWith('return obj'));
  const bad = (() => { try { addEventHat(empty, 'nope'); return false; } catch { return true; } })();
  check('addEventHat rejects unknown events', bad);
});

// ---- generation --------------------------------------------------------------

const generated = new Map();

await section('generated code has the expected shape', async () => {
  for (const fixture of FIXTURES) {
    const out = {};
    for (const [name, state] of Object.entries(fixture.objects)) {
      const luau = generateSource(state, 'luau');
      const python = generateSource(state, 'python');
      out[name] = { luau, python };
      check(`${fixture.name}: ${name} Luau is deterministic`, generateSource(state, 'luau') === luau);
      check(`${fixture.name}: ${name} Python is deterministic`, generateSource(state, 'python') === python);
      check(`${fixture.name}: ${name} Luau has no goto`, !/\bgoto\b|::\w+::/.test(luau), luau);
      check(`${fixture.name}: ${name} Luau is a module`, luau.startsWith('--!strict\n') && luau.endsWith('return obj\n'));
      check(`${fixture.name}: ${name} Python has no module globals for variables`, !/^\w+ = None$/m.test(python), python);
    }
    const first = out[Object.keys(fixture.objects)[0]];
    for (const fragment of fixture.luau) check(`${fixture.name}: Luau contains ${JSON.stringify(fragment)}`, first.luau.includes(fragment), first.luau);
    for (const fragment of fixture.python) check(`${fixture.name}: Python contains ${JSON.stringify(fragment)}`, first.python.includes(fragment), first.python);
    generated.set(fixture, out);
  }
});

// ---- the engines -------------------------------------------------------------

const RECORD_FLOATS = 12;

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

const luauStore = new Map();
const pyStore = new Map();
let luauShared;
let pyShared;

async function luauEngine() {
  if (!luauShared) {
    const state = await LuauState.createAsync({
      __host_store_get: (key) => luauStore.get(key) ?? '',
      __host_store_set: (key, value) => (value === '' ? luauStore.delete(key) : luauStore.set(key, value)),
    });
    await state.loadstring(read('src', 'luau', 'roblox.luau'), 'roblox.luau', true)();
    const api = (await state.loadstring(read('src', 'luau', 'prelude.luau'), 'prelude.luau', true)())[0];
    const g = (name) => {
      const fn = api.get(name);
      if (typeof fn !== 'function') throw new Error(`prelude did not export "${name}"`);
      return fn;
    };
    luauShared = {
      reset: () => g('reset')(),
      register_sprite: (...a) => g('register_sprite')(...a),
      register_font: (...a) => g('register_font')(...a),
      register_room: (...a) => g('register_room')(...a),
      start: (name) => g('start')(name),
      frame: async (input) => decode((await g('frame')(input))[0]),
      addObject: async (name, source, def = {}) => {
        const module = (await state.loadstring(source, `${name}.luau`, true)())[0];
        await g('register_object')(name, module, def.sprite ?? null, def.depth ?? 0, def.visible ?? true, def.solid ?? false, def.persistent ?? false, def.parent ?? null, '');
      },
    };
  }
  await luauShared.reset();
  return luauShared;
}

async function pythonEngine() {
  if (!pyShared) {
    const { loadMicroPython } = await import(pathToFileURL(join(root, 'src', 'vendor', 'micropython.js')).href);
    const mp = await loadMicroPython({ stdout: () => {}, stderr: (line) => console.error(line) });
    mp.registerJsModule('__host', {
      store_get: (key) => pyStore.get(key) ?? '',
      store_set: (key, value) => (value === '' ? pyStore.delete(key) : pyStore.set(key, value)),
    });
    mp.runPython(read('src', 'python', 'roblox.py'));
    mp.runPython(read('src', 'python', 'prelude.py'));
    const g = (name) => {
      const fn = mp.globals.get(name);
      if (typeof fn !== 'function') throw new Error(`prelude did not define "${name}"`);
      return fn;
    };
    const unpack = (packed) => {
      let from = 0;
      for (let i = 0; i < 7; i++) from = packed.indexOf(';', from) + 1;
      return decode(packed.slice(from));
    };
    pyShared = {
      reset: () => g('__reset')(),
      register_sprite: (...a) => g('__register_sprite')(...a),
      register_font: (...a) => g('__register_font')(...a),
      register_room: (...a) => g('__register_room')(...a),
      start: (name) => g('__start')(name),
      frame: async (input) => unpack(g('__frame_packed')(input, 1 / 60)),
      addObject: async (name, source, def = {}) => {
        g('__register_object')(name, source, def.sprite ?? null, def.depth ?? 0, def.visible ?? true, def.solid ?? false, def.persistent ?? false, def.parent ?? null, '');
      },
    };
  }
  pyShared.reset();
  return pyShared;
}

/** Run one fixture on one engine and return the decoded records per frame. */
async function runFixture(fixture, language) {
  const e = language === 'luau' ? await luauEngine() : await pythonEngine();
  const sources = generated.get(fixture);
  for (const sprite of fixture.sprites ?? []) await e.register_sprite(...sprite);
  await e.register_font(12, FONT);
  for (const [name, def] of Object.entries(fixture.plain ?? {})) {
    await e.addObject(name, language === 'luau' ? 'return {}' : '', def);
  }
  for (const name of Object.keys(fixture.objects)) {
    const def = name === Object.keys(fixture.objects)[0] && fixture.heroSprite ? { sprite: fixture.heroSprite } : {};
    await e.addObject(name, sources[name][language], def);
  }
  await e.register_room('rm_main', 320, 200, 0, 16, 16, fixture.room);
  await e.start('rm_main');
  const frames = [];
  for (const input of fixture.inputs) frames.push(await e.frame(input));
  return frames;
}

const near = (a, b) => Math.abs(a - b) < 1e-3;

function sameRecords(a, b) {
  if (a.length !== b.length) return `frame count ${a.length} vs ${b.length}`;
  for (let f = 0; f < a.length; f++) {
    if (a[f].length !== b[f].length) return `frame ${f}: ${a[f].length} vs ${b[f].length} records`;
    for (let i = 0; i < a[f].length; i++) {
      const x = a[f][i];
      const y = b[f][i];
      if (x.kind !== y.kind) return `frame ${f} record ${i}: kind ${x.kind} vs ${y.kind}`;
      for (let k = 0; k < 6; k++) if (!near(x.p[k], y.p[k])) return `frame ${f} record ${i}: p[${k}] ${x.p[k]} vs ${y.p[k]}`;
      for (let k = 0; k < 4; k++) if (!near(x.color[k], y.color[k])) return `frame ${f} record ${i}: color[${k}] ${x.color[k]} vs ${y.color[k]}`;
    }
  }
  return '';
}

const summary = (frames) => frames.map((f) => f.map((r) => `${r.kind}@${r.p.slice(0, 2).map((v) => +v.toFixed(2)).join(',')}`).join(' ') || '(none)').join(' | ');

await section('generated Luau and Python behave identically on both engines', async () => {
  for (const fixture of FIXTURES) {
    let luau;
    let python;
    try {
      luau = await runFixture(fixture, 'luau');
    } catch (error) {
      check(`${fixture.name}: Luau ran`, false, String(error?.message ?? error).split('\n').slice(0, 6).join(' | '));
      continue;
    }
    try {
      python = await runFixture(fixture, 'python');
    } catch (error) {
      check(`${fixture.name}: Python ran`, false, String(error?.message ?? error).split('\n').slice(0, 6).join(' | '));
      continue;
    }
    const total = luau.reduce((n, f) => n + f.length, 0);
    check(`${fixture.name}: produced draw records`, total > 0, summary(luau));
    const diff = sameRecords(luau, python);
    check(`${fixture.name}: identical records on both engines`, diff === '', `${diff}\n    luau:   ${summary(luau)}\n    python: ${summary(python)}`);
    console.log(`       ${summary(luau)}`);
  }
});

// A few behaviours are pinned to concrete numbers, so a fixture that is
// identically wrong on both engines cannot pass silently.
await section('expected values', async () => {
  const frames = await runFixture(FIXTURES[0], 'luau');
  check('held key moved x by 5 per frame, then stopped', near(frames[0][0].p[0], 5) && near(frames[1][0].p[0], 10) && near(frames[2][0].p[0], 10), summary(frames));

  const loops = await runFixture(FIXTURES[3], 'python');
  const [scoreTotal, iItem] = loops[0];
  check('for/continue, while/break and repeat summed to 20', near(scoreTotal.p[0], 20), summary(loops));
  check('forEach summed the list to 60', near(scoreTotal.p[1], 60), summary(loops));
  check('loop variables kept their last value', near(iItem.p[0], 5) && near(iItem.p[1], 30), summary(loops));

  const procs = await runFixture(FIXTURES[4], 'luau');
  check('bump(twice(5)) took score from 1 to 11', near(procs[0][0].p[0], 11), summary(procs));

  const tree = await runFixture(FIXTURES[5], 'python');
  check('parent has two children, kid found at (5,6), parent x read back', near(tree[0][0].p[0], 2) && near(tree[0][1].p[0], 5) && near(tree[0][1].p[1], 6) && near(tree[0][2].p[0], 30), summary(tree));

  const data = await runFixture(FIXTURES[6], 'luau');
  check('list length + third item = 5, text length 4', near(data[0][0].p[0], 5) && near(data[0][0].p[1], 4), summary(data));
  check('clamp(point_distance) = 5 and shared storage round-trips sign(-9)', near(data[0][1].p[0], 5) && near(data[0][1].p[1], -1), summary(data));

  const alarm = await runFixture(FIXTURES[1], 'luau');
  check('timer drew until its alarm, then the spawned instance took over', alarm[0].length === 1 && alarm[0][0].kind === 3 && alarm[3].length === 1 && alarm[3][0].kind === 1, summary(alarm));

  const hero = await runFixture(FIXTURES[2], 'python');
  const glyphs = hero[1].filter((r) => r.kind === 0 && r.p[0] >= 900);
  check('draw_gui drew "score: 1" after the pickup was collected', glyphs.length === 8 && glyphs[7].p[0] === 900 + 'score: 0123456789'.indexOf('1'), summary(hero));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
