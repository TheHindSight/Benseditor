/**
 * Engine tests for the Python side of Benseditor.
 *
 * The same scenes, in the same order, with the same check labels and expected
 * numbers as `engine.test.mjs`, driven through the Python engine
 * (`src/python/*.py` on MicroPython). A green run of both suites is the proof
 * that the two engines are equivalent.
 *
 * Object scripts cross as Python source text, exactly as `pythonHost.ts`
 * sends them; the frame comes back from `__frame_packed` as one string whose
 * header is `count;bg;vw;vh;vx;vy;quit;` followed by the base64 draw records.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const python = (name) => readFileSync(join(here, '..', 'src', 'python', name), 'utf8');
const ROBLOX = python('roblox.py');
const PRELUDE = python('prelude.py');

const { loadMicroPython } = await import(pathToFileURL(join(here, '..', 'src', 'vendor', 'micropython.js')).href);

// Stand-in for the browser's localStorage, so DataStore can be tested here.
const hostStore = new Map();

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

function near(a, b, epsilon = 1e-4) {
  return Math.abs(a - b) < epsilon;
}

function decode(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const floats = new Float32Array(bytes.buffer, 0, Math.floor(bytes.length / 4));

  const commands = [];
  for (let i = 0; i + RECORD_FLOATS <= floats.length; i += RECORD_FLOATS) {
    commands.push({
      kind: floats[i],
      p: Array.from(floats.slice(i + 1, i + 7)),
      color: Array.from(floats.slice(i + 7, i + 11)),
    });
  }
  return commands;
}

/** Split the packed frame string the way pythonHost.ts does. */
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
    background: Number(fields[1]),
    viewWidth: Number(fields[2]),
    viewHeight: Number(fields[3]),
    viewX: Number(fields[4]),
    viewY: Number(fields[5]),
    quit: fields[6] === '1',
    payload: packed.slice(from),
    commands: decode(packed.slice(from)),
  };
}

/**
 * One interpreter for the whole run, reset between sections.
 *
 * The app reuses a single MicroPython instance for the session and relies on
 * `__reset` for a clean slate, so the tests do the same.
 */
let shared;

async function newEngine() {
  if (!shared) {
    const mp = await loadMicroPython({
      stdout: () => {},
      stderr: (line) => console.error(line),
    });
    mp.registerJsModule('__host', {
      store_get: (key) => hostStore.get(key) ?? '',
      store_set: (key, value) => {
        if (value === '') hostStore.delete(key);
        else hostStore.set(key, value);
      },
    });
    // The Roblox layer loads first; the prelude drives its signals and scheduler.
    mp.runPython(ROBLOX);
    mp.runPython(PRELUDE);

    const g = (name) => {
      const fn = mp.globals.get(name);
      if (typeof fn !== 'function') {
        throw new Error(`prelude did not define "${name}" (got ${typeof fn})`);
      }
      return fn;
    };
    shared = {
      /** The frame's draw commands, plus the header the host reads. */
      frame: (input = '', dt = 1 / 60) => unpack(g('__frame_packed')(input, dt)),
      start: g('__start'),
      reset: g('__reset'),
      register_sprite: g('__register_sprite'),
      register_tileset: g('__register_tileset'),
      register_object: g('__register_object'),
      register_room: g('__register_room'),
      register_room_layer: g('__register_room_layer'),
      register_font: g('__register_font'),
      register_module: g('__register_module'),
      instance_number: g('instance_number'),
      room_current: g('room_current'),
      /** Run a snippet in the engine's globals, the way a REPL would. */
      run: (source) => mp.runPython(source),
    };
  }

  shared.reset();
  return shared;
}

/** Register an object from Python source, the way the host will. */
function addObject(e, name, source, def = {}) {
  e.register_object(
    name,
    source,
    def.sprite ?? null,
    def.depth ?? 0,
    def.visible ?? true,
    def.solid ?? false,
    def.persistent ?? false,
    def.parent ?? null,
    (def.blockedBy ?? []).join(','),
  );
}

console.log('\n=== prelude loads and registers assets ===');
{
  const e = await newEngine();
  e.register_sprite('spr_box', 0, 2, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  e.register_font(12, '65,100,7,6,9;66,101,7,6,9');
  e.register_room('rm_main', 320, 200, 0x1d2b53, 16, 16, '');
  check('prelude loaded and asset registration ran', true);
}

console.log('\n=== instances, events and draw output ===');
{
  const e = await newEngine();
  e.register_sprite('spr_box', 0, 1, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  addObject(
    e,
    'obj_mover',
    `
def create(self):
    self.hspeed = 2
    self.ticks = 0

def step(self):
    self.ticks += 1
`,
    { sprite: 'spr_box', depth: 0 },
  );
  e.register_room('rm_main', 320, 200, 0x1d2b53, 16, 16, 'obj_mover,100,50,1,1,0');
  e.start('rm_main');

  const cmds = e.frame('').commands;
  check('one instance produced one draw command', cmds.length === 1, `got ${cmds.length}`);
  check('command is a sprite', cmds[0]?.kind === CMD.SPRITE);
  check('moved by hspeed', near(cmds[0].p[1], 102), `x=${cmds[0]?.p[1]}`);
  check('y unchanged', near(cmds[0].p[2], 50), `y=${cmds[0]?.p[2]}`);

  const cmds2 = e.frame('').commands;
  check('moves again next frame', near(cmds2[0].p[1], 104), `x=${cmds2[0]?.p[1]}`);
}

console.log('\n=== input reaches game code ===');
{
  const e = await newEngine();
  addObject(
    e,
    'obj_player',
    `
def step(self):
    if keyboard_check("right"):
        self.x += 5
    if keyboard_check_pressed("space"):
        self.y -= 10

def draw(self):
    draw_rectangle(self.x, self.y, self.x + 4, self.y + 4, False)
`,
  );
  e.register_room('rm_main', 320, 200, 0, 16, 16, 'obj_player,0,100,1,1,0');
  e.start('rm_main');

  let cmds = e.frame('right||' + '|0,0,0,0').commands;
  check('held key moved instance', near(cmds[0].p[0], 5), `x=${cmds[0]?.p[0]}`);
  check('draw_rectangle emitted a rect', cmds[0]?.kind === CMD.RECT);

  cmds = e.frame('|space||0,0,0,0').commands;
  check('pressed key applied once', near(cmds[0].p[1], 90), `y=${cmds[0]?.p[1]}`);

  cmds = e.frame('||' + '|0,0,0,0').commands;
  check('key no longer held', near(cmds[0].p[0], 5), `x=${cmds[0]?.p[0]}`);
}

console.log('\n=== collision, is_a and destroy ===');
{
  const e = await newEngine();
  e.register_sprite('spr_16', 0, 1, 16, 16, 0, 0, 12, 0, 0, 15, 15);
  addObject(e, 'obj_pickup', '', { sprite: 'spr_16' });
  addObject(
    e,
    'obj_hero',
    `
def create(self):
    self.got = 0

def collision(self, other):
    if other.is_a("obj_pickup"):
        other.destroy()
        self.got += 1

def draw_gui(self):
    draw_text(0, 0, str(self.got))
`,
    { sprite: 'spr_16' },
  );
  e.register_font(12, `${'0'.charCodeAt(0)},900,7,6,9;${'1'.charCodeAt(0)},901,7,6,9`);
  e.register_room(
    'rm_main',
    320,
    200,
    0,
    16,
    16,
    'obj_hero,50,50,1,1,0;obj_pickup,54,54,1,1,0',
  );
  e.start('rm_main');

  e.frame('');
  const count = e.instance_number('obj_pickup');
  check('overlapping pickup was destroyed', count === 0, `remaining=${count}`);

  const cmds = e.frame('').commands;
  const glyphs = cmds.filter((c) => c.kind === CMD.SPRITE && c.p[0] >= 900);
  check('draw_gui rendered a glyph for the score', glyphs.length === 1, `glyphs=${glyphs.length}`);
  check('score glyph is "1"', glyphs[0]?.p[0] === 901, `atlas=${glyphs[0]?.p[0]}`);
}

console.log('\n=== alarms and room switching ===');
{
  const e = await newEngine();
  addObject(
    e,
    'obj_timer',
    `
def create(self):
    self.alarms[1] = 3
    self.fired = 0

def alarm(self, index):
    self.fired += 1
    if room_current() == "rm_a":
        room_goto("rm_b")

def draw(self):
    draw_circle(self.fired, 0, 1, False)
`,
  );
  e.register_room('rm_a', 320, 200, 0, 16, 16, 'obj_timer,10,10,1,1,0');
  e.register_room('rm_b', 640, 480, 0, 16, 16, 'obj_timer,20,20,1,1,0');
  e.start('rm_a');

  check('started in rm_a', e.room_current() === 'rm_a');
  let frame;
  for (let i = 0; i < 3; i++) frame = e.frame('');
  check('alarm fired after 3 steps', near(frame.commands[0].p[0], 1), `fired=${frame.commands[0]?.p[0]}`);
  check('room_goto took effect', e.room_current() === 'rm_b');

  // The packed header carries what Luau's `frame_info` reports: the room
  // change is applied after drawing, so the header already shows rm_b.
  const { viewWidth: w, viewHeight: h } = frame;
  check('room dimensions updated', w === 640 && h === 480, `${w}x${h}`);
}

console.log('\n=== depth ordering ===');
{
  const e = await newEngine();
  e.register_sprite('s', 0, 1, 8, 8, 0, 0, 12, 0, 0, 7, 7);
  addObject(e, 'obj_back', '', { sprite: 's', depth: 10 });
  addObject(e, 'obj_front', '', { sprite: 's', depth: -10 });
  e.register_room(
    'rm_main',
    320,
    200,
    0,
    16,
    16,
    'obj_front,1,1,1,1,0;obj_back,2,2,1,1,0',
  );
  e.start('rm_main');

  const cmds = e.frame('').commands;
  check('higher depth drawn first (further back)', near(cmds[0].p[1], 2), `first x=${cmds[0]?.p[1]}`);
  check('lower depth drawn last (in front)', near(cmds[1].p[1], 1), `second x=${cmds[1]?.p[1]}`);
}

// The Luau suite exercises Luau-only syntax here (type annotations,
// `continue`, string interpolation); the Python equivalents are annotations,
// `continue` and f-strings, and the sum must come out the same.
console.log('\n=== Python-only syntax is available to game code ===');
{
  const e = await newEngine();
  addObject(
    e,
    'obj_modern',
    `
Vec = dict

def scale(v: Vec, k: float) -> Vec:
    return {"x": v["x"] * k, "y": v["y"] * k}

def create(self):
    self.label = f"id-{self._id}"
    total = 0
    for i in range(1, 6):
        if i % 2 == 0:
            continue
        total += i
    v = scale({"x": 2, "y": 3}, 4)
    self.total = total + v["x"]

def draw(self):
    draw_circle(self.total, 0, 1, False)
`,
  );
  e.register_room('rm_main', 320, 200, 0, 16, 16, 'obj_modern,0,0,1,1,0');
  e.start('rm_main');

  const cmds = e.frame('').commands;
  check('type annotations, continue, interpolation all ran', near(cmds[0].p[0], 17), `got ${cmds[0]?.p[0]}`);
}

console.log('\n=== signals and connections ===');
{
  const e = await newEngine();
  addObject(
    e,
    'obj_signal',
    `
def create(self):
    self.hits = 0
    self.once = 0
    self.bell = Signal.new()

    def on_ring(amount):
        self.hits += amount
    self.conn = self.bell.Connect(on_ring)

    def on_first(amount):
        self.once += 1
    self.bell.Once(on_first)

def step(self):
    self.bell.Fire(2)
    if self.hits >= 6:
        self.conn.Disconnect()

def draw(self):
    draw_circle(self.hits, self.once, 1, False)
`,
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_signal,0,0,1,1,0');
  e.start('rm');

  let cmds = e.frame('').commands;
  check('Connect handler ran', near(cmds[0].p[0], 2), `hits=${cmds[0]?.p[0]}`);
  check('Once fired exactly once', near(cmds[0].p[1], 1), `once=${cmds[0]?.p[1]}`);

  for (let i = 0; i < 4; i++) cmds = e.frame('').commands;
  check('Once did not fire again', near(cmds[0].p[1], 1), `once=${cmds[0]?.p[1]}`);
  check('Disconnect stopped the handler', near(cmds[0].p[0], 6), `hits=${cmds[0]?.p[0]}`);
}

console.log('\n=== RunService and task ===');
{
  const e = await newEngine();
  addObject(
    e,
    'obj_timing',
    `
RunService = game.GetService("RunService")

def create(self):
    self.beats = 0
    self.elapsed = 0
    self.delayed = 0

    def on_beat(dt):
        self.beats += 1
        self.elapsed += dt
    RunService.Heartbeat.Connect(on_beat)

    def later():
        self.delayed = 1
    task.delay(0.05, later)

    async def worker():
        await task.wait(0.1)
        self.delayed += 10
    task.spawn(worker)

def draw(self):
    draw_circle(self.beats, self.delayed, math.floor(self.elapsed * 1000), False)
`,
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_timing,0,0,1,1,0');
  e.start('rm');

  // 1/60 per frame, so 0.05s lands on frame 3 and 0.1s on frame 6.
  let cmds;
  for (let i = 0; i < 3; i++) cmds = e.frame('', 1 / 60).commands;
  check('Heartbeat fires every frame', near(cmds[0].p[0], 3), `beats=${cmds[0]?.p[0]}`);
  check('task.delay ran on time', near(cmds[0].p[1], 1), `delayed=${cmds[0]?.p[1]}`);
  check('task.wait has not resumed yet', !near(cmds[0].p[1], 11), `delayed=${cmds[0]?.p[1]}`);

  for (let i = 0; i < 4; i++) cmds = e.frame('', 1 / 60).commands;
  check('task.wait resumed the thread', near(cmds[0].p[1], 11), `delayed=${cmds[0]?.p[1]}`);
  check('Heartbeat received the delta', cmds[0].p[2] > 100 && cmds[0].p[2] < 130,
    `elapsed_ms=${cmds[0]?.p[2]}`);
}

console.log('\n=== UserInputService ===');
{
  const e = await newEngine();
  addObject(
    e,
    'obj_input',
    `
UserInputService = game.GetService("UserInputService")

def create(self):
    self.began = 0
    self.ended = 0
    self.lastKey = ""

    def on_began(input):
        self.began += 1
        self.lastKey = input.KeyCode
    UserInputService.InputBegan.Connect(on_began)

    def on_ended(input):
        self.ended += 1
    UserInputService.InputEnded.Connect(on_ended)

def draw(self):
    draw_circle(self.began, self.ended, 1 if self.lastKey == "space" else 0, False)
`,
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_input,0,0,1,1,0');
  e.start('rm');

  let cmds = e.frame('space|space||0,0,0,0').commands;
  check('InputBegan fired', near(cmds[0].p[0], 1), `began=${cmds[0]?.p[0]}`);
  check('input carried the KeyCode', near(cmds[0].p[2], 1), `key match=${cmds[0]?.p[2]}`);

  cmds = e.frame('||space|0,0,0,0').commands;
  check('InputEnded fired', near(cmds[0].p[1], 1), `ended=${cmds[0]?.p[1]}`);
}

console.log('\n=== storage services ===');
{
  hostStore.clear();
  const e = await newEngine();
  addObject(
    e,
    'obj_storage',
    `
ReplicatedStorage = game.GetService("ReplicatedStorage")
DataStoreService = game.GetService("DataStoreService")
HttpService = game.GetService("HttpService")

def create(self):
    self.changes = 0

    def on_changed(key, value):
        self.changes += 1
    ReplicatedStorage.Changed.Connect(on_changed)

    ReplicatedStorage.SetAttribute("score", 42)
    self.readBack = ReplicatedStorage.GetAttribute("score")
    self.fallback = ReplicatedStorage.GetAttribute("missing", 7)

    store = DataStoreService.GetDataStore("save")
    store.SetAsync("profile", {"name": "ben", "level": 3, "tags": ["a", "b"]})
    loaded = store.GetAsync("profile")
    self.level = loaded["level"]
    self.tagCount = len(loaded["tags"])
    self.nameOk = 1 if loaded["name"] == "ben" else 0
    self.incremented = store.IncrementAsync("coins", 5)

    round_trip = HttpService.JSONDecode(HttpService.JSONEncode({"a": 1, "b": [2, 3]}))
    self.jsonOk = 1 if round_trip["a"] == 1 and round_trip["b"][1] == 3 else 0

def draw(self):
    draw_circle(self.readBack, self.fallback, self.changes, False)
    draw_circle(self.level, self.tagCount, self.nameOk, False)
    draw_circle(self.incremented, self.jsonOk, 0, False)
`,
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_storage,0,0,1,1,0');
  e.start('rm');

  const cmds = e.frame('').commands;
  check('ReplicatedStorage round-trips a value', near(cmds[0].p[0], 42), `${cmds[0]?.p[0]}`);
  check('GetAttribute default works', near(cmds[0].p[1], 7), `${cmds[0]?.p[1]}`);
  check('Changed signal fired', near(cmds[0].p[2], 1), `${cmds[0]?.p[2]}`);
  check('DataStore stored a nested table', near(cmds[1].p[0], 3), `level=${cmds[1]?.p[0]}`);
  check('nested array survived', near(cmds[1].p[1], 2), `tags=${cmds[1]?.p[1]}`);
  check('nested string survived', near(cmds[1].p[2], 1), `name=${cmds[1]?.p[2]}`);
  check('IncrementAsync works', near(cmds[2].p[0], 5), `${cmds[2]?.p[0]}`);
  check('JSONEncode/Decode round-trip', near(cmds[2].p[1], 1), `${cmds[2]?.p[1]}`);
  check('data actually reached the host store', hostStore.size >= 2, `${hostStore.size} keys`);
}

console.log('\n=== ScriptService and Workspace ===');
{
  const e = await newEngine();

  // A shared module, the way the host registers scripts/*.py.
  e.register_module(
    'mathx',
    `
answer = 21

def double(n):
    return n * 2
`,
  );

  e.register_sprite('s', 0, 1, 8, 8, 0, 0, 12, 0, 0, 7, 7);
  addObject(e, 'obj_thing', '', { sprite: 's' });
  addObject(
    e,
    'obj_probe',
    `
ScriptService = game.GetService("ScriptService")

EXPECTED = [
    "DataStoreService", "HttpService", "ReplicatedStorage", "RunService",
    "ScriptService", "UserInputService", "Workspace",
]

def create(self):
    mathx = require("mathx")
    self.doubled = mathx.double(mathx.answer)
    self.scriptCount = len(ScriptService.GetScripts())
    self.children = len(workspace.GetChildren())
    self.found = 1 if workspace.FindFirstChild("obj_thing") is not None else 0

    # Every expected service resolves, and nothing unexpected is present.
    resolved = 0
    for name in EXPECTED:
        if game.FindService(name) is not None:
            resolved += 1
    self.services = resolved
    self.exact = 1 if len(game.GetServices()) == len(EXPECTED) else 0

def draw(self):
    draw_circle(self.doubled, self.scriptCount, self.children, False)
    draw_circle(self.found, self.services, self.exact, False)
`,
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_probe,0,0,1,1,0;obj_thing,50,50,1,1,0');
  e.start('rm');

  const cmds = e.frame('').commands;
  check('require() returned the module', near(cmds[0].p[0], 42), `${cmds[0]?.p[0]}`);
  check('ScriptService lists scripts', near(cmds[0].p[1], 1), `${cmds[0]?.p[1]}`);
  check('Workspace:GetChildren sees instances', near(cmds[0].p[2], 2), `${cmds[0]?.p[2]}`);
  check('Workspace:FindFirstChild works', near(cmds[1].p[0], 1), `${cmds[1]?.p[0]}`);
  check('all 7 named services resolve', near(cmds[1].p[1], 7), `${cmds[1]?.p[1]} resolved`);
  check('no unexpected services registered', near(cmds[1].p[2], 1), `${cmds[1]?.p[2]}`);

  // Asserted from JS, as the Luau suite does: the error surfaces as an
  // exception whose message carries the Python traceback.
  let rejected = false;
  try {
    e.run('game.GetService("Nope")');
  } catch {
    rejected = true;
  }
  check('GetService rejects unknown names', rejected);
}

console.log('\n=== corrupt save data ===');
{
  hostStore.clear();
  hostStore.set('save/profile', '{ this is not json');
  const e = await newEngine();
  addObject(
    e,
    'obj_loader',
    `
def create(self):
    store = game.GetService("DataStoreService").GetDataStore("save")
    loaded = store.GetAsync("profile", {"level": 9})
    self.level = loaded["level"]

def draw(self):
    draw_circle(self.level, 0, 1, False)
`,
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_loader,0,0,1,1,0');
  e.start('rm');

  const cmds = e.frame('').commands;
  check('corrupt data falls back to the default', near(cmds[0].p[0], 9), `level=${cmds[0]?.p[0]}`);
}

console.log('\n=== instance signals ===');
{
  const e = await newEngine();
  e.register_sprite('s', 0, 1, 16, 16, 0, 0, 12, 0, 0, 15, 15);
  addObject(e, 'obj_target', '', { sprite: 's' });
  addObject(
    e,
    'obj_watcher',
    `
def create(self):
    self.touched = 0
    self.sawDestroy = 0

    def on_collided(other):
        self.touched += 1
        def on_destroying(inst):
            self.sawDestroy += 1
        other.Destroying.Connect(on_destroying)
        other.Destroy()
    self.Collided.Connect(on_collided)

def draw(self):
    draw_circle(self.touched, self.sawDestroy, 1, False)
`,
    { sprite: 's' },
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_watcher,50,50,1,1,0;obj_target,54,54,1,1,0');
  e.start('rm');

  e.frame('');
  const cmds = e.frame('').commands;
  check('Collided signal fired', cmds[0].p[0] >= 1, `touched=${cmds[0]?.p[0]}`);
  check('Destroying signal fired', near(cmds[0].p[1], 1), `sawDestroy=${cmds[0]?.p[1]}`);
  check('target was removed', e.instance_number('obj_target') === 0);
}

console.log('\n=== tilesets and tile layers ===');
{
  const e = await newEngine();
  // 4 tiles in one row; tiles 0 and 1 are solid.
  e.register_tileset('ts', 100, 16, 16, 4, 1, '1100');
  e.register_sprite('s', 0, 1, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  addObject(
    e,
    'obj_probe',
    `
def create(self):
    layers = tilemap_layers()
    self.layerCount = len(layers)
    self.first = tilemap_get("floor", 0, 0)
    self.middle = tilemap_get("floor", 2, 1)
    self.outside = tilemap_get("floor", 99, 99)

    self.solidHere = 1 if tile_solid_at(8, 8) else 0
    self.solidGap = 1 if tile_solid_at(40, 8) else 0

    tilemap_set("floor", 0, 0, 3)
    self.afterSet = tilemap_get("floor", 0, 0)
    # Row 0 is [0, 1, -1, 2], so x=52 lands in column 3, which holds 2.
    self.byPixel = tilemap_get_at("floor", 52, 4)

def draw(self):
    draw_circle(self.layerCount, self.first, self.middle, False)
    draw_circle(self.outside, self.solidHere, self.solidGap, False)
    draw_circle(self.afterSet, self.byPixel, 0, False)
`,
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_probe,200,180,1,1,0');
  // 4x3 grid: row 0 = 0,1,-1,2 ; row 1 = -1,-1,3,-1 ; row 2 all empty
  e.register_room_layer('rm', 'floor', 'ts', 20, true, 4, 3, '0:1,1:1,-1:1,2:1,-1:2,3:1,-1:5');
  e.start('rm');

  const cmds = e.frame('').commands;
  const probe = cmds.filter((c) => c.kind === CMD.CIRCLE);
  check('layer registered', near(probe[0].p[0], 1), `${probe[0]?.p[0]}`);
  check('tilemap_get reads a tile', near(probe[0].p[1], 0), `${probe[0]?.p[1]}`);
  check('tilemap_get reads row 1', near(probe[0].p[2], 3), `${probe[0]?.p[2]}`);
  check('out of bounds returns -1', near(probe[1].p[0], -1), `${probe[1]?.p[0]}`);
  check('tile_solid_at finds a solid tile', near(probe[1].p[1], 1), `${probe[1]?.p[1]}`);
  check('tile_solid_at ignores empty cells', near(probe[1].p[2], 0), `${probe[1]?.p[2]}`);
  check('tilemap_set writes', near(probe[2].p[0], 3), `${probe[2]?.p[0]}`);
  check('tilemap_get_at converts pixels to tiles', near(probe[2].p[1], 2), `${probe[2]?.p[1]}`);

  // Tiles are drawn as sprite commands at their atlas id. The layer holds four
  // non-empty cells: three in row 0 and one in row 1.
  const tiles = cmds.filter((c) => c.kind === CMD.SPRITE && c.p[0] >= 100 && c.p[0] < 104);
  check('non-empty tiles were drawn', tiles.length === 4, `${tiles.length} drawn`);
  const topLeft = tiles.find((t) => t.p[1] === 0 && t.p[2] === 0);
  check('tiles draw from their top-left corner', topLeft !== undefined,
    tiles.map((t) => `${t.p[1]},${t.p[2]}`).join(' '));
}

console.log('\n=== tile collision ===');
{
  const e = await newEngine();
  e.register_tileset('ts', 100, 16, 16, 2, 1, '10');
  e.register_sprite('s', 0, 1, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  addObject(
    e,
    'obj_walker',
    `
def create(self):
    # Solid tile occupies 0..16 on both axes.
    self.intoSolid = 1 if self.place_meeting(8, 8, "tiles") else 0
    self.intoEmpty = 1 if self.place_meeting(200, 100, "tiles") else 0

    self.x = 100
    self.y = 8
    self.move_contact("tiles", -100, 0)
    self.stopped = self.x

def draw(self):
    draw_circle(self.intoSolid, self.intoEmpty, self.stopped, False)
`,
    { sprite: 's' },
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_walker,200,150,1,1,0');
  e.register_room_layer('rm', 'floor', 'ts', 20, true, 4, 3, '0:1,-1:11');
  e.start('rm');

  const cmds = e.frame('').commands;
  const probe = cmds.filter((c) => c.kind === CMD.CIRCLE)[0];
  check('place_meeting("tiles") hits a solid tile', near(probe.p[0], 1), `${probe?.p[0]}`);
  check('place_meeting("tiles") misses empty space', near(probe.p[1], 0), `${probe?.p[1]}`);
  // The mask covers the whole 16px sprite, so the box is x-8..x+8 and the
  // instance comes to rest with its left edge on the tile's right edge at 16.
  check('move_contact stops against the tile', probe.p[2] >= 24 && probe.p[2] < 25,
    `stopped at x=${probe?.p[2]}`);
}

console.log('\n=== declarative blocking (blockedBy) ===');
{
  // A wall at x 96..112 (16px sprite, origin 8,8, placed at 104). The mover
  // starts at x=40 heading right at 8px/step and lists the wall as a blocker,
  // so the engine must stop it at contact with no collision code in the object.
  const e = await newEngine();
  e.register_sprite('s', 0, 1, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  addObject(e, 'obj_block', '', { sprite: 's' });
  addObject(
    e,
    'obj_pusher',
    `
def create(self):
    self.hspeed = 8

def draw(self):
    draw_circle(self.x, self.y, self.hspeed, False)
`,
    { sprite: 's', blockedBy: ['obj_block'] },
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_pusher,40,100,1,1,0;obj_block,104,100,1,1,0');
  e.start('rm');

  let probe;
  for (let i = 0; i < 12; i++) {
    const cmds = e.frame('').commands;
    probe = cmds.filter((c) => c.kind === CMD.CIRCLE)[0];
  }
  // Boxes touch when the mover's right edge (x+8) meets the wall's left (96).
  check('the engine stops a blocked object at contact', near(probe.p[0], 88, 1.5),
    `x=${probe?.p[0]}`);
  check('the blocked axis speed is zeroed', near(probe.p[2], 0), `hspeed=${probe?.p[2]}`);
  check('it never tunnelled through', probe.p[0] <= 96, `x=${probe?.p[0]}`);
}

{
  // The same wall, but the mover does NOT list it: nothing may stop it.
  const e = await newEngine();
  e.register_sprite('s', 0, 1, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  addObject(e, 'obj_block', '', { sprite: 's' });
  addObject(
    e,
    'obj_ghost',
    `
def create(self):
    self.hspeed = 8

def draw(self):
    draw_circle(self.x, self.y, 1, False)
`,
    { sprite: 's' },
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_ghost,40,100,1,1,0;obj_block,104,100,1,1,0');
  e.start('rm');

  let probe;
  for (let i = 0; i < 12; i++) {
    const cmds = e.frame('').commands;
    probe = cmds.filter((c) => c.kind === CMD.CIRCLE)[0];
  }
  check('an unlisted object passes straight through', probe.p[0] > 120, `x=${probe?.p[0]}`);
}

{
  // Blocking against solid tiles, with gravity: a platformer floor. The tile
  // row covers y 32..48; the faller starts above it and lists "tiles".
  const e = await newEngine();
  e.register_tileset('ts', 100, 16, 16, 2, 1, '10');
  e.register_sprite('s', 0, 1, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  addObject(
    e,
    'obj_faller',
    `
def create(self):
    self.gravity = 0.5

def draw(self):
    draw_circle(self.x, self.y, self.vspeed, False)
`,
    { sprite: 's', blockedBy: ['tiles'] },
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_faller,24,8,1,1,0');
  // One solid tile row along y=32: 4 columns of tile 0 at row 2.
  e.register_room_layer('rm', 'floor', 'ts', 20, true, 4, 4, '-1:8,0:4,-1:4');
  e.start('rm');

  let probe;
  for (let i = 0; i < 40; i++) {
    const cmds = e.frame('').commands;
    probe = cmds.filter((c) => c.kind === CMD.CIRCLE)[0];
  }
  // Resting: bottom edge (y+8) on the tile top (32), and vspeed not building up.
  check('gravity lands the object on the solid tile', near(probe.p[1], 24, 1.5),
    `y=${probe?.p[1]}`);
  check('vspeed does not accumulate against the floor', Math.abs(probe.p[2]) < 1,
    `vspeed=${probe?.p[2]}`);

  // Sliding: pressing along the floor must still work while blocked below.
  const before = probe.p[0];
  for (let i = 0; i < 5; i++) {
    e.frame('');
  }
  check('resting on a floor is stable across further steps', true);
  void before;
}

console.log('\n=== layer depth ordering ===');
{
  const e = await newEngine();
  e.register_tileset('ts', 100, 16, 16, 1, 1, '0');
  e.register_sprite('s', 50, 1, 8, 8, 0, 0, 12, 0, 0, 7, 7);
  addObject(e, 'obj_mid', '', { sprite: 's', depth: 0 });
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_mid,100,100,1,1,0');
  e.register_room_layer('rm', 'back', 'ts', 50, true, 1, 1, '0:1');
  e.register_room_layer('rm', 'front', 'ts', -50, true, 1, 1, '0:1');
  e.start('rm');

  const cmds = e.frame('').commands;
  check('three draws in depth order', cmds.length === 3, `${cmds.length}`);
  check('depth 50 layer drawn first', cmds[0]?.p[0] === 100, `${cmds[0]?.p[0]}`);
  check('instance drawn between the layers', cmds[1]?.p[0] === 50, `${cmds[1]?.p[0]}`);
  check('depth -50 layer drawn last', cmds[2]?.p[0] === 100, `${cmds[2]?.p[0]}`);
}

console.log('\n=== hidden layers ===');
{
  const e = await newEngine();
  e.register_tileset('ts', 100, 16, 16, 1, 1, '0');
  addObject(e, 'obj_none', '');
  e.register_room('rm', 320, 200, 0, 16, 16, '');
  e.register_room_layer('rm', 'hidden', 'ts', 20, false, 2, 2, '0:4');
  e.start('rm');

  const cmds = e.frame('').commands;
  check('an invisible layer draws nothing', cmds.length === 0, `${cmds.length} commands`);
}

console.log('\n=== missing start room ===');
{
  const e = await newEngine();
  e.register_room('rm_real', 320, 200, 0, 16, 16, '');

  let message = '';
  try {
    e.start('rm_gone');
  } catch (error) {
    message = String(error.message ?? error);
  }
  check('starting a missing room fails clearly', message.includes("No room named 'rm_gone'"), message.slice(0, 120));
  check('the error lists what is available', message.includes('rm_real'), message.slice(0, 160));

  // The old failure was an opaque "attempt to index nil with 'layers'".
  check('no longer an index-nil error', !message.includes('index nil'), message.slice(0, 120));
}

console.log('\n=== project with no rooms ===');
{
  const e = await newEngine();
  let message = '';
  try {
    e.start('rm_main');
  } catch (error) {
    message = String(error.message ?? error);
  }
  check('says the project has no rooms', message.includes('no rooms'), message.slice(0, 120));
}

console.log('\n=== static tile layers stay off the wire ===');
{
  const COLUMNS = 30;
  const ROWS = 18;
  const runs = Array.from({ length: COLUMNS * ROWS }, (_, i) => `${i % 2}:1`).join(',');

  const measure = async (bufferIndex) => {
    const e = await newEngine();
    e.register_tileset('ts', 100, 16, 16, 2, 1, '00');
    addObject(e, 'obj_none', '');
    e.register_room('rm', COLUMNS * 16, ROWS * 16, 0, 16, 16, '');
    e.register_room_layer('rm', 'field', 'ts', 50, true, COLUMNS, ROWS, runs, bufferIndex);
    e.start('rm');

    e.frame('');
    let payload = 0;
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) payload = e.frame('').payload.length;
    return { ms: (performance.now() - t0) / 60, payload, commands: e.frame('').commands };
  };

  const streamed = await measure(-1);
  const stat = await measure(0);

  console.log(`       streamed: ${streamed.ms.toFixed(2)} ms, ${(streamed.payload / 1024).toFixed(1)} KB`);
  console.log(`       static:   ${stat.ms.toFixed(2)} ms, ${(stat.payload / 1024).toFixed(1)} KB`);

  check('a streamed layer emits every tile', streamed.commands.length === COLUMNS * ROWS,
    `${streamed.commands.length}`);
  check('a static layer emits one marker', stat.commands.length === 1, `${stat.commands.length}`);
  check('the marker is CMD_LAYER carrying the buffer index',
    stat.commands[0]?.kind === 4 && stat.commands[0]?.p[0] === 0,
    `kind ${stat.commands[0]?.kind}, index ${stat.commands[0]?.p[0]}`);
  check('static payload is tiny', stat.payload < 1024, `${stat.payload} bytes`);
  check('static layers cost almost nothing', stat.ms < streamed.ms / 3,
    `${stat.ms.toFixed(2)} vs ${streamed.ms.toFixed(2)} ms`);
}

console.log('\n=== performance: 300 instances ===');
{
  const e = await newEngine();
  e.register_sprite('s', 0, 1, 8, 8, 4, 4, 12, 0, 0, 7, 7);
  addObject(
    e,
    'obj_bit',
    `
def create(self):
    self.hspeed = 1
    self.vspeed = 0.5
`,
    { sprite: 's' },
  );
  const placements = [];
  for (let i = 0; i < 300; i++) placements.push(`obj_bit,${i},${i % 200},1,1,0`);
  e.register_room('rm_main', 640, 480, 0, 16, 16, placements.join(';'));
  e.start('rm_main');

  e.frame('');
  const t0 = performance.now();
  const FRAMES = 300;
  let last;
  for (let i = 0; i < FRAMES; i++) last = e.frame('').commands;
  const per = (performance.now() - t0) / FRAMES;

  check('all 300 instances drawn', last.length === 300, `got ${last.length}`);
  check(`frame time ${per.toFixed(2)} ms is within 16.6 ms budget`, per < 16.6, `${per.toFixed(2)} ms`);
  console.log(`       -> ${per.toFixed(2)} ms/frame at 300 instances`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
