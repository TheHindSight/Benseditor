/**
 * Smoke tests for the Python engine (`src/python/*.py` on MicroPython).
 *
 * The same idea as engine.test.mjs: the prelude holds all the game logic, so
 * it can be exercised in Node with no browser and no WebGL by driving
 * `__frame_packed` and decoding the draw-command buffer. Object scripts cross
 * as source text, exactly as `src/engine/pythonHost.ts` sends them.
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
const CMD = { SPRITE: 0, RECT: 1, LINE: 2, CIRCLE: 3, LAYER: 4 };

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

/** One scene. An exception fails the scene and the run carries on. */
async function section(name, body) {
  if (name) console.log(`\n=== ${name} ===`);
  try {
    await body();
  } catch (error) {
    failed++;
    const detail = String(error.message ?? error).split('\n').slice(0, 12).join(' | ');
    console.log(`  FAIL ${name || 'scene'} threw -- ${detail}`);
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

/** One interpreter for the whole run, reset between sections, like the app. */
let shared;

async function newEngine() {
  if (!shared) {
    const printed = [];
    const mp = await loadMicroPython({
      stdout: (line) => printed.push(line),
      stderr: (line) => console.error(line),
    });
    mp.registerJsModule('__host', {
      store_get: (key) => hostStore.get(key) ?? '',
      store_set: (key, value) => {
        if (value === '') hostStore.delete(key);
        else hostStore.set(key, value);
      },
    });
    mp.runPython(ROBLOX);
    mp.runPython(PRELUDE);

    const g = (name) => {
      const fn = mp.globals.get(name);
      if (typeof fn !== 'function') throw new Error(`prelude did not define "${name}" (got ${typeof fn})`);
      return fn;
    };
    const api = {
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
      printed,
    };
    shared = api;
  }
  shared.reset();
  shared.printed.length = 0;
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

await section("prelude loads and registers assets", async () => {
  const e = await newEngine();
  e.register_sprite('spr_box', 0, 2, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  e.register_font(12, '65,100,7,6,9;66,101,7,6,9');
  e.register_room('rm_main', 320, 200, 0x1d2b53, 16, 16, '');
  check('prelude loaded and asset registration ran', true);
});

await section("instances, events and draw output", async () => {
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

  const frame = e.frame('');
  const cmds = frame.commands;
  check('one instance produced one draw command', cmds.length === 1 && frame.count === 1, `got ${cmds.length}/${frame.count}`);
  check('command is a sprite', cmds[0]?.kind === CMD.SPRITE);
  check('moved by hspeed', near(cmds[0].p[1], 102), `x=${cmds[0]?.p[1]}`);
  check('y unchanged', near(cmds[0].p[2], 50), `y=${cmds[0]?.p[2]}`);
  check('frame header carries room, view and background', frame.viewWidth === 320 && frame.viewHeight === 200
    && frame.viewX === 0 && frame.viewY === 0 && frame.background === 0x1d2b53 && frame.quit === false,
    JSON.stringify({ ...frame, commands: undefined, payload: undefined }));

  const cmds2 = e.frame('').commands;
  check('moves again next frame', near(cmds2[0].p[1], 104), `x=${cmds2[0]?.p[1]}`);
});

await section("input reaches game code", async () => {
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
});

await section("collision, is_a and destroy", async () => {
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
  e.register_room('rm_main', 320, 200, 0, 16, 16, 'obj_hero,50,50,1,1,0;obj_pickup,54,54,1,1,0');
  e.start('rm_main');

  e.frame('');
  const count = e.instance_number('obj_pickup');
  check('overlapping pickup was destroyed', count === 0, `remaining=${count}`);

  const cmds = e.frame('').commands;
  const glyphs = cmds.filter((c) => c.kind === CMD.SPRITE && c.p[0] >= 900);
  check('draw_gui rendered a glyph for the score', glyphs.length === 1, `glyphs=${glyphs.length}`);
  check('score glyph is "1"', glyphs[0]?.p[0] === 901, `atlas=${glyphs[0]?.p[0]}`);
});

await section("alarms and room switching", async () => {
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
  check('room dimensions updated after the change', frame.viewWidth === 640 && frame.viewHeight === 480,
    `${frame.viewWidth}x${frame.viewHeight}`);
  check('alarm did not fire again early', near(e.frame('').commands[0].p[0], 0));
});

await section("depth ordering", async () => {
  const e = await newEngine();
  e.register_sprite('s', 0, 1, 8, 8, 0, 0, 12, 0, 0, 7, 7);
  addObject(e, 'obj_back', '', { sprite: 's', depth: 10 });
  addObject(e, 'obj_front', '', { sprite: 's', depth: -10 });
  e.register_room('rm_main', 320, 200, 0, 16, 16, 'obj_front,1,1,1,1,0;obj_back,2,2,1,1,0');
  e.start('rm_main');

  const cmds = e.frame('').commands;
  check('higher depth drawn first (further back)', near(cmds[0].p[1], 2), `first x=${cmds[0]?.p[1]}`);
  check('lower depth drawn last (in front)', near(cmds[1].p[1], 1), `second x=${cmds[1]?.p[1]}`);
});

await section("signals and connections", async () => {
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
});

await section("RunService and task", async () => {
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
    self.waited = -1

    def on_beat(dt):
        self.beats += 1
        self.elapsed += dt
    RunService.Heartbeat.Connect(on_beat)

    def later():
        self.delayed = 1
    task.delay(0.05, later)

    async def worker():
        self.waited = await task.wait(0.1)
        self.delayed += 10
    task.spawn(worker)

def draw(self):
    draw_circle(self.beats, self.delayed, math.floor(self.elapsed * 1000), False)
    draw_circle(self.waited, 0, 0, False)
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
  check('await task.wait resumed the coroutine', near(cmds[0].p[1], 11), `delayed=${cmds[0]?.p[1]}`);
  check('task.wait returned the frame delta', near(cmds[1].p[0], 1 / 60, 1e-3), `waited=${cmds[1]?.p[0]}`);
  check('Heartbeat received the delta', cmds[0].p[2] > 100 && cmds[0].p[2] < 130, `elapsed_ms=${cmds[0]?.p[2]}`);
});

await section("Signal.Wait, task.defer and task.cancel", async () => {
  const e = await newEngine();
  addObject(
    e,
    'obj_waiter',
    `
def create(self):
    self.got = 0
    self.deferred = 0
    self.cancelled = 0
    self.bell = Signal.new()

    async def waiter():
        value = await self.bell.Wait()
        self.got = value
    task.spawn(waiter)

    def deferred():
        self.deferred += 1
    task.defer(deferred)

    async def doomed():
        await task.wait(0.01)
        self.cancelled = 1
    task.cancel(task.spawn(doomed))

def step(self):
    if self.got == 0:
        self.bell.Fire(7)

def draw(self):
    draw_circle(self.got, self.deferred, self.cancelled, False)
`,
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_waiter,0,0,1,1,0');
  e.start('rm');
  let cmds;
  for (let i = 0; i < 3; i++) cmds = e.frame('').commands;
  check('await Signal.Wait received the fired value', near(cmds[0].p[0], 7), `got=${cmds[0]?.p[0]}`);
  check('task.defer ran once', near(cmds[0].p[1], 1), `deferred=${cmds[0]?.p[1]}`);
  check('task.cancel stopped the coroutine', near(cmds[0].p[2], 0), `cancelled=${cmds[0]?.p[2]}`);
});

await section("UserInputService", async () => {
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
    draw_circle(1 if UserInputService.IsKeyDown("space") else 0, mouse_x(), mouse_y(), False)
`,
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_input,0,0,1,1,0');
  e.start('rm');

  let cmds = e.frame('space|space||10.50,20.00,1,0').commands;
  check('InputBegan fired', near(cmds[0].p[0], 1), `began=${cmds[0]?.p[0]}`);
  check('input carried the KeyCode', near(cmds[0].p[2], 1), `key match=${cmds[0]?.p[2]}`);
  check('IsKeyDown and the mouse position', near(cmds[1].p[0], 1) && near(cmds[1].p[1], 10.5) && near(cmds[1].p[2], 20),
    `${cmds[1]?.p}`);

  cmds = e.frame('||space|0,0,0,0').commands;
  check('InputEnded fired', near(cmds[0].p[1], 1), `ended=${cmds[0]?.p[1]}`);
});

await section("storage services", async () => {
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
    self.fallback = ReplicatedStorage.Get("missing", 7)

    store = DataStoreService.GetDataStore("save")
    store.SetAsync("profile", {"name": "ben", "level": 3, "tags": ["a", "b"]})
    loaded = store.GetAsync("profile")
    self.level = loaded["level"]
    self.tagCount = len(loaded["tags"])
    self.nameOk = 1 if loaded["name"] == "ben" else 0
    self.incremented = store.IncrementAsync("coins", 5)

    round_trip = HttpService.JSONDecode(HttpService.JSONEncode({"a": 1, "b": [2, 3]}))
    self.jsonOk = 1 if round_trip["a"] == 1 and round_trip["b"][1] == 3 else 0
    self.nanRejected = 0
    try:
        HttpService.JSONEncode(float("nan"))
    except ValueError:
        self.nanRejected = 1

def draw(self):
    draw_circle(self.readBack, self.fallback, self.changes, False)
    draw_circle(self.level, self.tagCount, self.nameOk, False)
    draw_circle(self.incremented, self.jsonOk, self.nanRejected, False)
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
  check('JSONEncode rejects NaN', near(cmds[2].p[2], 1), `${cmds[2]?.p[2]}`);
  check('data actually reached the host store', hostStore.size >= 2, `${hostStore.size} keys`);
  check('stored JSON is compact and Luau-shaped', hostStore.get('save/coins') === '5', hostStore.get('save/coins'));
});

await section("ScriptService and Workspace", async () => {
  const e = await newEngine();

  // A shared module, the way the host registers scripts/*.py.
  e.register_module(
    'mathx',
    `
answer = 21

def double(n):
    return n * 2

def grid_snap(value, size):
    return math.floor(value / size) * size
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
    # A shared script's globals leak into every object loaded after it.
    self.snapped = grid_snap(37, 16)
    self.scriptCount = len(ScriptService.GetScripts())
    self.children = len(workspace.GetChildren())
    self.found = 1 if workspace.FindFirstChild("obj_thing") is not None else 0

    resolved = 0
    for name in EXPECTED:
        if game.FindService(name) is not None:
            resolved += 1
    self.services = resolved
    self.exact = 1 if len(game.GetServices()) == len(EXPECTED) else 0
    self.region = len(workspace.GetPartsInRegion(40, 40, 60, 60))

def draw(self):
    draw_circle(self.doubled, self.scriptCount, self.children, False)
    draw_circle(self.found, self.services, self.exact, False)
    draw_circle(self.snapped, self.region, 0, False)
`,
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_probe,0,0,1,1,0;obj_thing,50,50,1,1,0');
  e.start('rm');

  const cmds = e.frame('').commands;
  check('require() returned the module', near(cmds[0].p[0], 42), `${cmds[0]?.p[0]}`);
  check('ScriptService lists scripts', near(cmds[0].p[1], 1), `${cmds[0]?.p[1]}`);
  check('Workspace.GetChildren sees instances', near(cmds[0].p[2], 2), `${cmds[0]?.p[2]}`);
  check('Workspace.FindFirstChild works', near(cmds[1].p[0], 1), `${cmds[1]?.p[0]}`);
  check('all 7 named services resolve', near(cmds[1].p[1], 7), `${cmds[1]?.p[1]} resolved`);
  check('no unexpected services registered', near(cmds[1].p[2], 1), `${cmds[1]?.p[2]}`);
  check('shared script globals are visible to objects', near(cmds[2].p[0], 32), `${cmds[2]?.p[0]}`);
  check('Workspace.GetPartsInRegion finds the thing', near(cmds[2].p[1], 1), `${cmds[2]?.p[1]}`);

  let message = '';
  try {
    e.run('game.GetService("Nope")');
  } catch (error) {
    message = String(error.message ?? error);
  }
  check('GetService rejects unknown names', message.includes("no service named 'Nope'"), message.slice(0, 160));
});

await section("corrupt save data", async () => {
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
});

await section("instance signals", async () => {
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
});

await section("tilesets and tile layers", async () => {
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

  const tiles = cmds.filter((c) => c.kind === CMD.SPRITE && c.p[0] >= 100 && c.p[0] < 104);
  check('non-empty tiles were drawn', tiles.length === 4, `${tiles.length} drawn`);
  const topLeft = tiles.find((t) => t.p[1] === 0 && t.p[2] === 0);
  check('tiles draw from their top-left corner', topLeft !== undefined, tiles.map((t) => `${t.p[1]},${t.p[2]}`).join(' '));
});

await section("tile collision", async () => {
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
  check('move_contact stops against the tile', probe.p[2] >= 24 && probe.p[2] < 25, `stopped at x=${probe?.p[2]}`);
});

await section("declarative blocking (blockedBy)", async () => {
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
  for (let i = 0; i < 12; i++) probe = e.frame('').commands.filter((c) => c.kind === CMD.CIRCLE)[0];
  check('the engine stops a blocked object at contact', near(probe.p[0], 88, 1.5), `x=${probe?.p[0]}`);
  check('the blocked axis speed is zeroed', near(probe.p[2], 0), `hspeed=${probe?.p[2]}`);
  check('it never tunnelled through', probe.p[0] <= 96, `x=${probe?.p[0]}`);
});

await section("", async () => {
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
  for (let i = 0; i < 12; i++) probe = e.frame('').commands.filter((c) => c.kind === CMD.CIRCLE)[0];
  check('an unlisted object passes straight through', probe.p[0] > 120, `x=${probe?.p[0]}`);
});

await section("", async () => {
  const e = await newEngine();
  e.register_tileset('ts', 100, 16, 16, 2, 1, '10');
  e.register_sprite('s', 0, 1, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  addObject(
    e,
    'obj_faller',
    `
def create(self):
    self.gravity = 0.5

def step(self):
    if keyboard_check("right"):
        self.hspeed = 2

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
  for (let i = 0; i < 40; i++) probe = e.frame('').commands.filter((c) => c.kind === CMD.CIRCLE)[0];
  check('gravity lands the object on the solid tile', near(probe.p[1], 24, 1.5), `y=${probe?.p[1]}`);
  check('vspeed does not accumulate against the floor', Math.abs(probe.p[2]) < 1, `vspeed=${probe?.p[2]}`);

  const before = probe.p[0];
  for (let i = 0; i < 5; i++) probe = e.frame('right|||0,0,0,0').commands.filter((c) => c.kind === CMD.CIRCLE)[0];
  check('sliding along the floor still works while blocked below', probe.p[0] > before + 5 && near(probe.p[1], 24, 1.5),
    `x ${before} -> ${probe?.p[0]}, y=${probe?.p[1]}`);
});

await section("movement integration order", async () => {
  const e = await newEngine();
  addObject(
    e,
    'obj_mover',
    `
def create(self):
    self.hspeed = 3
    self.gravity = 1
    self.gravity_direction = 270
    self.friction = 0.5

def draw(self):
    draw_circle(self.x, self.y, self.xprevious, False)
    draw_circle(self.hspeed, self.vspeed, self.yprevious, False)
`,
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_mover,0,0,1,1,0');
  e.start('rm');
  const cmds = e.frame('').commands;
  // gravity first: (3, 1); then friction 0.5 off a speed of sqrt(10); then the move.
  const speed = Math.sqrt(10);
  const scale = (speed - 0.5) / speed;
  check('gravity, then friction, then the move', near(cmds[1].p[0], 3 * scale) && near(cmds[1].p[1], 1 * scale),
    `hspeed=${cmds[1]?.p[0]} vspeed=${cmds[1]?.p[1]}`);
  check('x/y advanced by the adjusted speed', near(cmds[0].p[0], 3 * scale) && near(cmds[0].p[1], 1 * scale),
    `x=${cmds[0]?.p[0]} y=${cmds[0]?.p[1]}`);
  check('xprevious/yprevious recorded before the move', near(cmds[0].p[2], 0) && near(cmds[1].p[2], 0));
});

await section("maths, queries and instance methods", async () => {
  const e = await newEngine();
  e.register_sprite('spr_box', 0, 3, 16, 16, 8, 8, 15, 2, 2, 13, 13);
  e.register_font(12, '65,900,7,6,9;66,901,7,6,9;48,902,7,6,9');
  addObject(e, 'obj_base', '', { sprite: 'spr_box' });
  addObject(e, 'obj_child', '', { sprite: 'spr_box', parent: 'obj_base' });
  addObject(e, 'obj_other', '', { sprite: 'spr_box' });
  e.register_room('rm_one', 320, 240, 0x102030, 16, 16, '');
  e.start('rm_one');

  e.run(`
_RESULTS = []
def ok(name, condition, detail=""):
    _RESULTS.append((name, bool(condition), str(detail)))
def near(a, b):
    return abs(a - b) < 0.001

ok("point_distance", near(point_distance(0, 0, 3, 4), 5))
ok("point_direction", near(point_direction(0, 0, 1, 0), 0) and near(point_direction(0, 0, 0, -1), 90) and near(point_direction(0, 0, 0, 1), 270))
ok("lengthdir_x", near(lengthdir_x(10, 0), 10))
ok("lengthdir_y", near(lengthdir_y(10, 90), -10))
ok("clamp", clamp(5, 0, 3) == 3 and clamp(-1, 0, 3) == 0)
ok("lerp", near(lerp(0, 10, 0.5), 5))
ok("approach", approach(0, 10, 3) == 3 and approach(10, 0, 3) == 7 and approach(1, 2, 5) == 2)
ok("sign", sign(-5) == -1 and sign(0) == 0 and sign(2) == 1)
ok("choose", choose(7, 7, 7) == 7)
ok("irandom", irandom(0) == 0 and 0 <= irandom(5) <= 5)
ok("irandom_range", irandom_range(5, 5) == 5)
ok("random_range", near(random_range(2, 2), 2))
ok("angle_difference", near(angle_difference(10, 350), 20))
ok("wrap", near(wrap(370, 0, 360), 10) and near(wrap(-10, 0, 360), 350))
ok("colours", c_red == 0xFF004D and c_grey == c_gray == 0x5F574F and c_white == 0xFFFFFF)

ok("room_current", room_current() == "rm_one", room_current())
ok("room_width/height", room_width() == 320 and room_height() == 240)
ok("room_speed", room_speed() == 60)
view_set(12, 34)
ok("view_set/view_get", view_get() == (12, 34), view_get())
view_set(0, 0)

a = instance_create(100, 100, "obj_base")
ok("instance_create", a is not None and a.x == 100 and a.y == 100)
child = instance_create(300, 300, "obj_child")
ok("instance_exists", instance_exists("obj_base") is True and instance_exists("obj_missing") is False)
ok("instance_number", instance_number("obj_base") == 2, instance_number("obj_base"))
ok("instance_find", instance_find("obj_base") is a and instance_find("obj_base", 1) is child and instance_find("obj_base", 5) is None)
ok("instance_list", len(instance_list("obj_base")) == 2)
ok("instance_nearest", instance_nearest(101, 101, "obj_base") is a)
ok("collision_point", collision_point(100, 100, "obj_base") is a)
ok("is_a", child.is_a("obj_child") and child.is_a("obj_base") and not child.is_a("obj_other"))

l, t, r, b = a.bbox()
ok("bbox", near(l, 94) and near(t, 94) and near(r, 106) and near(b, 106), (l, t, r, b))
a.image_xscale = 2
l, t, r, b = a.bbox()
ok("bbox scales with image_xscale", near(l, 88) and near(r, 112), (l, r))
a.image_xscale = 1

overlap = instance_create(104, 100, "obj_other")
ok("place_meeting", a.place_meeting(104, 100, "obj_other") is True and a.place_meeting(300, 300, "obj_other") is False)
ok("instance_place", a.instance_place(104, 100, "obj_other") is overlap)
ok("instance_place_list", len(a.instance_place_list(104, 100, "obj_other")) == 1)
overlap.destroy()
ok("destroyed instances stop matching", instance_number("obj_other") == 0)

ok("distance_to_point", near(a.distance_to_point(103, 104), 5))
far = instance_create(100, 105, "obj_other")
ok("distance_to_object", near(a.distance_to_object(far), 5))
far.destroy()

a.move_towards_point(110, 100, 4)
ok("move_towards_point", near(a.hspeed, 4) and near(a.vspeed, 0))
ok("speed", near(a.speed(), 4))
ok("direction", near(a.direction(), 0))
a.set_speed(2, 90)
ok("set_speed", near(a.vspeed, -2) and near(a.direction(), 90))
a.hspeed, a.vspeed = 0, 0

ok("sprite_width/height", near(a.sprite_width(), 16) and near(a.sprite_height(), 16))
ok("image_number", a.image_number() == 3)
ok("image_speed default", near(a.image_speed, 15 / 60), a.image_speed)

blocker = instance_create(140, 100, "obj_other")
a.x, a.y = 100, 100
a.move_contact("obj_other", 100, 0)
# The blocker's box starts at 134 and a's right edge is x + 6, so contact is x = 128.
ok("move_contact", a.x > 100 and a.x < 140 and near(a.x, 128), a.x)
blocker.destroy()
a.x, a.y = 100, 100

ok("alarms length", len(a.alarms) == 12 and a.alarms[1] == -1)
ok("Name aliases name", a.Name == "obj_base")
a.Name = "hero"
ok("Name assignment writes name", a.name == "hero")
ok("Parent of a root is the Workspace", a.Parent is workspace)
ok("Destroy alias", a.Destroy == a.destroy or callable(a.Destroy))
ok("string_width", string_width("AB") == 14 and string_width("A\\nAB") == 14, string_width("AB"))
ok("string_height", string_height("A\\nB") == 24 and string_height("A") == 12)
missing = 0
try:
    a.nothing_here
except AttributeError as error:
    missing = 1 if "nothing_here" in str(error) else 0
ok("missing field raises AttributeError", missing == 1)

a.destroy()
child.destroy()
ok("destroy is idempotent", a.destroy() is None and instance_number("obj_base") == 0)
`);
  e.run('print(repr(_RESULTS))');
  const raw = e.printed.pop();
  // Python repr of a list of tuples: parse it loosely.
  const entries = [...raw.matchAll(/\('([^']+)', (True|False), '((?:[^'\\]|\\.)*)'\)/g)];
  for (const [, name, okText, detail] of entries) check(name, okText === 'True', detail);
  check('audit produced results', entries.length >= 40, `${entries.length} entries`);
});

await section("drawing commands", async () => {
  const e = await newEngine();
  e.register_sprite('spr_box', 0, 3, 16, 16, 8, 8, 15, 2, 2, 13, 13);
  e.register_font(12, '65,900,7,6,9;66,901,7,6,9;48,902,7,6,9');
  addObject(
    e,
    'obj_draw',
    `
def draw(self):
    draw_set_color(c_red)
    draw_set_alpha(0.5)
    draw_rectangle(10, 10, 20, 20, False)
    draw_rectangle(30, 10, 40, 20, True)
    draw_line(0, 50, 100, 50, 2)
    draw_circle(60, 60, 5, False)
    draw_set_alpha(1)
    draw_sprite("spr_box", 0, 100, 100)
    draw_sprite_ext("spr_box", 4, 120, 100, 2, 2, 45, c_blue, 0.5)
    draw_text(0, 0, "AB\\n0", c_white)
`,
  );
  e.register_room('rm_draw', 320, 240, 0, 16, 16, 'obj_draw,0,0,1,1,0');
  e.start('rm_draw');
  const frame = e.frame('');
  const cmds = frame.commands;
  const kinds = (kind) => cmds.filter((c) => c.kind === kind);
  check('count matches the records', frame.count === cmds.length, `${frame.count} vs ${cmds.length}`);
  check('draw_rectangle', kinds(CMD.RECT).length === 2);
  check('draw_rectangle outline flag', kinds(CMD.RECT).some((c) => c.p[4] === 1) && kinds(CMD.RECT).some((c) => c.p[4] === 0));
  check('draw_line width', kinds(CMD.LINE).length === 1 && kinds(CMD.LINE)[0].p[4] === 2);
  check('draw_circle segments', kinds(CMD.CIRCLE).length === 1 && kinds(CMD.CIRCLE)[0].p[4] === 24);
  check('draw_set_alpha', kinds(CMD.RECT).every((c) => near(c.color[3], 0.5)));
  check('draw_set_color unpacks c_red', kinds(CMD.RECT).every((c) => near(c.color[0], 1) && near(c.color[1], 0) && near(c.color[2], 0x4d / 255)));
  const sprites = kinds(CMD.SPRITE);
  check('draw_sprite', sprites.some((c) => c.p[0] === 0 && c.p[1] === 100 && c.p[2] === 100 && c.p[3] === 1));
  check('draw_sprite_ext wraps the frame and scales', sprites.some((c) => c.p[0] === 1 && c.p[1] === 120 && c.p[3] === 2 && c.p[5] === 45 && near(c.color[3], 0.5)));
  const glyphs = sprites.filter((c) => c.p[0] >= 900 && c.p[0] < 903);
  check('draw_text emits one glyph per character', glyphs.length === 3, `${glyphs.length}`);
  check('draw_text advances and wraps lines', glyphs[1].p[1] === 7 && glyphs[2].p[1] === 0 && glyphs[2].p[2] === 12,
    glyphs.map((g) => `${g.p[1]},${g.p[2]}`).join(' '));
  check('last record is followed by nothing', frame.payload.length === cmds.length * 64);
});

await section("layer depth ordering and hidden layers", async () => {
  const e = await newEngine();
  e.register_tileset('ts', 100, 16, 16, 1, 1, '0');
  e.register_sprite('s', 50, 1, 8, 8, 0, 0, 12, 0, 0, 7, 7);
  addObject(e, 'obj_mid', '', { sprite: 's', depth: 0 });
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_mid,100,100,1,1,0');
  e.register_room_layer('rm', 'back', 'ts', 50, true, 1, 1, '0:1');
  e.register_room_layer('rm', 'front', 'ts', -50, true, 1, 1, '0:1', 3);
  e.register_room_layer('rm', 'hidden', 'ts', -60, false, 2, 2, '0:4');
  e.start('rm');

  const cmds = e.frame('').commands;
  check('three draws in depth order', cmds.length === 3, `${cmds.length}`);
  check('depth 50 layer streamed first', cmds[0]?.kind === CMD.SPRITE && cmds[0]?.p[0] === 100, `${cmds[0]?.p[0]}`);
  check('instance drawn between the layers', cmds[1]?.p[0] === 50, `${cmds[1]?.p[0]}`);
  check('static depth -50 layer is one CMD_LAYER marker', cmds[2]?.kind === CMD.LAYER && cmds[2]?.p[0] === 3, `${cmds[2]?.kind}/${cmds[2]?.p[0]}`);
});

await section("the instance tree", async () => {
  const e = await newEngine();
  // Shared scripts load before objects, so their globals are visible to them.
  e.register_module('order', 'ORDER = []\n');
  addObject(
    e,
    'obj_part',
    `
def create(self):
    self.gone = 0

def destroy(self):
    ORDER.append(self.name)
`,
  );
  addObject(
    e,
    'obj_ship',
    `
def create(self):
    self.turret = Instance.new("obj_part", self)
    self.turret.Name = "turret"
    self.turretParentOk = 1 if self.turret.Parent is self else 0
    self.turretAt = 1 if self.turret.x == self.x and self.turret.y == self.y else 0
    gun = instance_create(1, 2, "obj_part")
    gun.Parent = self.turret
    gun.Name = "gun"
    self.childCount = len(self.get_children())
    self.descendantCount = len(self.get_descendants())
    self.foundByName = 1 if self.find_first_child("turret") is self.turret else 0
    self.foundByObject = 1 if self.FindFirstChild("obj_part") is self.turret else 0
    self.rootCount = len(workspace.GetChildren())
    self.allCount = len(workspace.GetDescendants())
    self.cycleRejected = 0
    try:
        self.Parent = gun
    except ValueError as error:
        self.cycleRejected = 1 if "cycle" in str(error) else 0
    self.badParentRejected = 0
    try:
        gun.Parent = 5
    except TypeError:
        self.badParentRejected = 1
    gun.Parent = workspace
    self.rootsAfterUnparent = len(workspace.GetChildren())
    gun.Parent = self.turret

def step(self):
    self.ticks = getattr(self, "ticks", 0) + 1
    if self.ticks == 2:
        self.destroy()

def draw(self):
    draw_circle(self.turretParentOk, self.turretAt, self.childCount, False)
    draw_circle(self.descendantCount, self.foundByName, self.foundByObject, False)
    draw_circle(self.rootCount, self.allCount, self.cycleRejected, False)
    draw_circle(self.badParentRejected, self.rootsAfterUnparent, 0, False)
`,
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_ship,10,20,1,1,0');
  e.start('rm');
  let cmds = e.frame('').commands;
  const circles = cmds.filter((c) => c.kind === CMD.CIRCLE);
  check('Instance.new parents before create and copies the position', circles.length === 4 && near(circles[0].p[0], 1) && near(circles[0].p[1], 1),
    `${circles.length} circles ${circles[0]?.p}`);
  check('get_children counts direct children only', near(circles[0].p[2], 1), `${circles[0]?.p[2]}`);
  check('get_descendants walks the whole subtree', near(circles[1].p[0], 2), `${circles[1]?.p[0]}`);
  check('find_first_child by name and by object', near(circles[1].p[1], 1) && near(circles[1].p[2], 1));
  check('Workspace children are the roots only', near(circles[2].p[0], 1) && near(circles[2].p[1], 3), `${circles[2]?.p}`);
  check('Parent cycle is rejected', near(circles[2].p[2], 1));
  check('non-instance Parent is a TypeError', near(circles[3].p[0], 1));
  check('Parent = workspace makes a root again', near(circles[3].p[1], 2), `${circles[3]?.p[1]}`);

  // The ship destroys itself on its second step; the cascade runs parent
  // first, then children depth first.
  e.frame('');
  e.run('print(",".join(require("order").ORDER))');
  const order = e.printed.pop();
  check('destroying a parent cascades depth first', order === 'turret,gun', order);
  check('nothing is left alive', e.instance_number('obj_part') === 0 && e.instance_number('obj_ship') === 0);
});

await section("persistent instances across rooms", async () => {
  const e = await newEngine();
  addObject(
    e,
    'obj_keeper',
    `
def create(self):
    self.rooms = 0
    self.ended = 0

def room_start(self):
    self.rooms += 1

def room_end(self):
    self.ended += 1

def step(self):
    if room_current() == "rm_a":
        room_goto("rm_b")

def draw(self):
    draw_circle(self.rooms, self.ended, instance_number("obj_local"), False)
`,
    { persistent: true },
  );
  addObject(e, 'obj_local', '');
  e.register_room('rm_a', 320, 200, 0, 16, 16, 'obj_keeper,10,10,1,1,0;obj_local,1,1,1,1,0');
  e.register_room('rm_b', 320, 200, 0, 16, 16, 'obj_local,2,2,1,1,0;obj_local,3,3,1,1,0');
  e.start('rm_a');
  e.frame('');
  const cmds = e.frame('').commands;
  check('the persistent instance survived the room change', e.instance_number('obj_keeper') === 1);
  check('room_start ran again and room_end once', near(cmds[0].p[0], 2) && near(cmds[0].p[1], 1), `${cmds[0]?.p}`);
  check('non-persistent instances were replaced by the new room', near(cmds[0].p[2], 2), `${cmds[0]?.p[2]}`);
});

await section("animation", async () => {
  const e = await newEngine();
  e.register_sprite('spr_anim', 10, 3, 8, 8, 0, 0, 30, 0, 0, 7, 7);
  addObject(
    e,
    'obj_anim',
    `
def create(self):
    self.ends = 0

def animation_end(self):
    self.ends += 1

def draw(self):
    self.draw_self()
    draw_circle(self.image_index, self.ends, 0, False)
`,
    { sprite: 'spr_anim' },
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_anim,0,0,1,1,0');
  e.start('rm');
  let cmds;
  for (let i = 0; i < 5; i++) cmds = e.frame('').commands;
  // image_speed is 30/60 = 0.5 per step: 0.5, 1, 1.5, 2, 2.5 after five steps.
  check('image_index advances by fps/60', near(cmds[1].p[0], 2.5), `${cmds[1]?.p[0]}`);
  check('draw_self floors the frame', cmds[0].p[0] === 12, `${cmds[0]?.p[0]}`);
  cmds = e.frame('').commands;
  check('animation_end fires on the wrap and the index wraps', near(cmds[1].p[0], 0) && near(cmds[1].p[1], 1), `${cmds[1]?.p}`);
});

await section("errors carry the object file name", async () => {
  const e = await newEngine();
  addObject(
    e,
    'obj_x',
    `
def step(self):
    total = 1
    return total / 0
`,
  );
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_x,0,0,1,1,0');
  e.start('rm');
  let message = '';
  try {
    e.frame('');
  } catch (error) {
    message = String(error.message ?? error);
  }
  check('a step error reaches JS', message !== '');
  check('the traceback names the object file and line', /File "obj_x\.py", line 4/.test(message), message.slice(0, 200));
  check('the exception type is preserved', message.includes('ZeroDivisionError'), message.slice(-80));

  let syntax = '';
  try {
    addObject(e, 'obj_broken', 'def step(self)\n    pass\n');
  } catch (error) {
    syntax = String(error.message ?? error);
  }
  check('a syntax error names the object file', /File "obj_broken\.py", line 1/.test(syntax), syntax.slice(0, 200));

  let missing = '';
  try {
    e.start('rm_gone');
  } catch (error) {
    missing = String(error.message ?? error);
  }
  check('starting a missing room fails clearly', missing.includes("No room named 'rm_gone'") && missing.includes('rm'), missing.slice(0, 160));
});

await section("reset gives a clean slate", async () => {
  const e = await newEngine();
  e.register_module('leaky', 'LEAKED = 5\n');
  addObject(e, 'obj_old', 'def step(self):\n    self.x += LEAKED\n');
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_old,0,0,1,1,0');
  e.start('rm');
  e.frame('');

  e.reset();
  let leaked = false;
  try {
    addObject(e, 'obj_new', 'def create(self):\n    self.v = LEAKED\n');
    e.register_room('rm2', 100, 100, 7, 16, 16, 'obj_new,0,0,1,1,0');
    e.start('rm2');
  } catch (error) {
    leaked = /NameError/.test(String(error.message));
  }
  check('module globals do not leak past a reset', leaked);
  check('no rooms are left after reset', (() => {
    try { e.reset(); e.start('rm'); return false; } catch (error) { return /no rooms/.test(String(error.message)); }
  })());

  e.reset();
  e.register_sprite('spr_box', 0, 1, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  addObject(e, 'obj_fresh', 'def create(self):\n    self.hspeed = 2\n', { sprite: 'spr_box' });
  e.register_room('rm_main', 320, 200, 0x1d2b53, 16, 16, 'obj_fresh,100,50,1,1,0');
  e.start('rm_main');
  const frame = e.frame('');
  check('a fresh scene runs after reset', frame.commands.length === 1 && near(frame.commands[0].p[1], 102), `x=${frame.commands[0]?.p[1]}`);
  check('instance ids restart', (e.run('print(instance_find("obj_fresh")._id)'), e.printed.pop() === '1'));
});

await section("game_end and room_restart", async () => {
  const e = await newEngine();
  addObject(e, 'obj_ctl', `
ReplicatedStorage = game.GetService("ReplicatedStorage")

def step(self):
    n = ReplicatedStorage.Get("steps", 0) + 1
    ReplicatedStorage.Set("steps", n)
    if n == 1:
        room_restart()
    if n == 2:
        game_end()
`);
  e.register_room('rm', 320, 200, 0, 16, 16, 'obj_ctl,0,0,1,1,0');
  e.start('rm');
  let frame = e.frame('');
  check('room_restart keeps the room', e.room_current() === 'rm' && frame.quit === false);
  e.run('print(instance_find("obj_ctl")._id)');
  check('room_restart recreated the instance', e.printed.pop() === '2');
  frame = e.frame('');
  check('game_end sets the quit flag', frame.quit === true);
});

await section("performance: 100 instances", async () => {
  const e = await newEngine();
  e.register_sprite('spr_box', 0, 2, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  addObject(
    e,
    'obj_many',
    `
def create(self):
    self.hspeed = choose(-1, 1) * 0.5
    self.vspeed = 0.25
    self.alarms[1] = 30

def step(self):
    if self.x < 0 or self.x > room_width():
        self.hspeed = -self.hspeed
    if self.y > room_height():
        self.y = 0

def alarm(self, index):
    self.alarms[1] = 30
`,
    { sprite: 'spr_box' },
  );
  const placements = Array.from({ length: 100 }, (_, i) => `obj_many,${(i * 13) % 320},${(i * 7) % 200},1,1,0`).join(';');
  e.register_room('rm', 320, 200, 0, 16, 16, placements);
  e.start('rm');
  e.frame('');
  check('100 instances draw 100 sprites', e.frame('').count === 100);

  const t0 = performance.now();
  for (let i = 0; i < 60; i++) e.frame('right|||0,0,0,0');
  const ms = (performance.now() - t0) / 60;
  console.log(`       100 instances: ${ms.toFixed(2)} ms per frame`);
  check('a 100-instance frame runs in under 16 ms', ms < 16, `${ms.toFixed(2)} ms`);
});

await section("performance: walls, a blocked player and collision actors", async () => {
  // The expensive paths: per-axis blocking against 80 walls, and three
  // actors with collision events testing every instance each frame.
  const e = await newEngine();
  e.register_sprite('s', 0, 1, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  addObject(e, 'obj_wall', '', { sprite: 's' });
  addObject(e, 'obj_player', `
def step(self):
    self.hspeed = 2 if keyboard_check("right") else 0
`, { sprite: 's', blockedBy: ['obj_wall'] });
  addObject(e, 'obj_enemy', `
def create(self):
    self.hspeed = 1

def collision(self, other):
    if other.is_a("obj_wall"):
        self.hspeed = -self.hspeed
`, { sprite: 's' });
  const walls = Array.from({ length: 80 }, (_, i) => `obj_wall,${8 + (i % 20) * 16},${i < 20 ? 8 : i < 40 ? 192 : i < 60 ? 40 : 160},1,1,0`);
  const placements = [...walls, 'obj_player,100,100,1,1,0', 'obj_enemy,60,100,1,1,0', 'obj_enemy,200,100,1,1,0', 'obj_enemy,260,120,1,1,0'].join(';');
  e.register_room('rm', 320, 200, 0, 16, 16, placements);
  e.start('rm');
  e.frame('');
  const t0 = performance.now();
  for (let i = 0; i < 60; i++) e.frame('right|||0,0,0,0');
  const ms = (performance.now() - t0) / 60;
  console.log(`       84 instances, blocking + 3 actors: ${ms.toFixed(2)} ms per frame`);
  check('a blocking and collision heavy frame runs in under 16 ms', ms < 16, `${ms.toFixed(2)} ms`);
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
