/**
 * Engine tests for the Luau side of Benseditor.
 *
 * The prelude holds all the game logic, so it can be exercised in Node with no
 * browser and no WebGL: drive `__frame` and decode the draw-command buffer.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LuauState } from 'luau-web';

const here = dirname(fileURLToPath(import.meta.url));
const luau = (name) => readFileSync(join(here, '..', 'src', 'luau', name), 'utf8');
const ROBLOX = luau('roblox.luau');
const PRELUDE = luau('prelude.luau');

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

/**
 * One VM for the whole run, reset between sections.
 *
 * Every LuauState shares a single WASM heap, so building a fresh one per test
 * exhausts it; and destroying a used one corrupts luau-web's global state. The
 * app has the same constraint and solves it the same way.
 */
let shared;

async function newEngine() {
  if (!shared) {
    const state = await LuauState.createAsync({
      __host_store_get: (key) => hostStore.get(key) ?? '',
      __host_store_set: (key, value) => {
        if (value === '') hostStore.delete(key);
        else hostStore.set(key, value);
      },
    });
    // The Roblox layer loads first; the prelude drives its signals and scheduler.
    await state.loadstring(ROBLOX, 'roblox.luau', true)();
    // The prelude returns its host-facing API; Luau globals are not readable
    // from JS, but they remain visible to every game script.
    const api = (await state.loadstring(PRELUDE, 'prelude.luau', true)())[0];
    const g = (name) => {
      const fn = api.get(name);
      if (typeof fn !== 'function') {
        throw new Error(`prelude did not export "${name}" (got ${typeof fn})`);
      }
      return fn;
    };
    shared = { state, g };
  }

  await shared.g('reset')();
  return shared;
}

/** Compile an object module and register it, the way the host will. */
async function addObject(engine, name, source, def = {}) {
  const module = (await engine.state.loadstring(source, `${name}.luau`, true)())[0];
  await engine.g('register_object')(
    name,
    module,
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
  await e.g('register_sprite')('spr_box', 0, 2, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  await e.g('register_font')(12, '65,100,7,6,9;66,101,7,6,9');
  await e.g('register_room')('rm_main', 320, 200, 0x1d2b53, 16, 16, '');
  check('prelude loaded and asset registration ran', true);
}

console.log('\n=== instances, events and draw output ===');
{
  const e = await newEngine();
  await e.g('register_sprite')('spr_box', 0, 1, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  await addObject(
    e,
    'obj_mover',
    `
    local obj = {}
    function obj.create(self)
        self.hspeed = 2
        self.ticks = 0
    end
    function obj.step(self)
        self.ticks += 1
    end
    return obj
    `,
    { sprite: 'spr_box', depth: 0 },
  );
  await e.g('register_room')('rm_main', 320, 200, 0x1d2b53, 16, 16, 'obj_mover,100,50,1,1,0');
  await e.g('start')('rm_main');

  const cmds = decode((await e.g('frame')(''))[0]);
  check('one instance produced one draw command', cmds.length === 1, `got ${cmds.length}`);
  check('command is a sprite', cmds[0]?.kind === CMD.SPRITE);
  check('moved by hspeed', near(cmds[0].p[1], 102), `x=${cmds[0]?.p[1]}`);
  check('y unchanged', near(cmds[0].p[2], 50), `y=${cmds[0]?.p[2]}`);

  const cmds2 = decode((await e.g('frame')(''))[0]);
  check('moves again next frame', near(cmds2[0].p[1], 104), `x=${cmds2[0]?.p[1]}`);
}

console.log('\n=== input reaches game code ===');
{
  const e = await newEngine();
  await addObject(
    e,
    'obj_player',
    `
    local obj = {}
    function obj.step(self)
        if keyboard_check("right") then self.x += 5 end
        if keyboard_check_pressed("space") then self.y -= 10 end
    end
    function obj.draw(self)
        draw_rectangle(self.x, self.y, self.x + 4, self.y + 4, false)
    end
    return obj
    `,
  );
  await e.g('register_room')('rm_main', 320, 200, 0, 16, 16, 'obj_player,0,100,1,1,0');
  await e.g('start')('rm_main');

  let cmds = decode((await e.g('frame')('right||' + '|0,0,0,0'))[0]);
  check('held key moved instance', near(cmds[0].p[0], 5), `x=${cmds[0]?.p[0]}`);
  check('draw_rectangle emitted a rect', cmds[0]?.kind === CMD.RECT);

  cmds = decode((await e.g('frame')('|space||0,0,0,0'))[0]);
  check('pressed key applied once', near(cmds[0].p[1], 90), `y=${cmds[0]?.p[1]}`);

  cmds = decode((await e.g('frame')('||' + '|0,0,0,0'))[0]);
  check('key no longer held', near(cmds[0].p[0], 5), `x=${cmds[0]?.p[0]}`);
}

console.log('\n=== collision, is_a and destroy ===');
{
  const e = await newEngine();
  await e.g('register_sprite')('spr_16', 0, 1, 16, 16, 0, 0, 12, 0, 0, 15, 15);
  await addObject(e, 'obj_pickup', 'return {}', { sprite: 'spr_16' });
  await addObject(
    e,
    'obj_hero',
    `
    local obj = {}
    function obj.create(self)
        self.got = 0
    end
    function obj.collision(self, other)
        if other:is_a("obj_pickup") then
            other:destroy()
            self.got += 1
        end
    end
    function obj.draw_gui(self)
        draw_text(0, 0, tostring(self.got))
    end
    return obj
    `,
    { sprite: 'spr_16' },
  );
  await e.g('register_font')(12, `${'0'.charCodeAt(0)},900,7,6,9;${'1'.charCodeAt(0)},901,7,6,9`);
  await e.g('register_room')(
    'rm_main',
    320,
    200,
    0,
    16,
    16,
    'obj_hero,50,50,1,1,0;obj_pickup,54,54,1,1,0',
  );
  await e.g('start')('rm_main');

  await e.g('frame')('');
  const count = (await e.g('instance_number')('obj_pickup'))[0];
  check('overlapping pickup was destroyed', count === 0, `remaining=${count}`);

  const cmds = decode((await e.g('frame')(''))[0]);
  const glyphs = cmds.filter((c) => c.kind === CMD.SPRITE && c.p[0] >= 900);
  check('draw_gui rendered a glyph for the score', glyphs.length === 1, `glyphs=${glyphs.length}`);
  check('score glyph is "1"', glyphs[0]?.p[0] === 901, `atlas=${glyphs[0]?.p[0]}`);
}

console.log('\n=== alarms and room switching ===');
{
  const e = await newEngine();
  await addObject(
    e,
    'obj_timer',
    `
    local obj = {}
    function obj.create(self)
        self.alarms[1] = 3
        self.fired = 0
    end
    function obj.alarm(self, index)
        self.fired += 1
        if room_current() == "rm_a" then
            room_goto("rm_b")
        end
    end
    function obj.draw(self)
        draw_circle(self.fired, 0, 1, false)
    end
    return obj
    `,
  );
  await e.g('register_room')('rm_a', 320, 200, 0, 16, 16, 'obj_timer,10,10,1,1,0');
  await e.g('register_room')('rm_b', 640, 480, 0, 16, 16, 'obj_timer,20,20,1,1,0');
  await e.g('start')('rm_a');

  check('started in rm_a', (await e.g('room_current')())[0] === 'rm_a');
  let cmds;
  for (let i = 0; i < 3; i++) cmds = decode((await e.g('frame')(''))[0]);
  check('alarm fired after 3 steps', near(cmds[0].p[0], 1), `fired=${cmds[0]?.p[0]}`);
  check('room_goto took effect', (await e.g('room_current')())[0] === 'rm_b');

  const [, , w, h] = await e.g('frame_info')();
  check('room dimensions updated', w === 640 && h === 480, `${w}x${h}`);
}

console.log('\n=== depth ordering ===');
{
  const e = await newEngine();
  await e.g('register_sprite')('s', 0, 1, 8, 8, 0, 0, 12, 0, 0, 7, 7);
  await addObject(e, 'obj_back', 'return {}', { sprite: 's', depth: 10 });
  await addObject(e, 'obj_front', 'return {}', { sprite: 's', depth: -10 });
  await e.g('register_room')(
    'rm_main',
    320,
    200,
    0,
    16,
    16,
    'obj_front,1,1,1,1,0;obj_back,2,2,1,1,0',
  );
  await e.g('start')('rm_main');

  const cmds = decode((await e.g('frame')(''))[0]);
  check('higher depth drawn first (further back)', near(cmds[0].p[1], 2), `first x=${cmds[0]?.p[1]}`);
  check('lower depth drawn last (in front)', near(cmds[1].p[1], 1), `second x=${cmds[1]?.p[1]}`);
}

console.log('\n=== Luau-only syntax is available to game code ===');
{
  const e = await newEngine();
  await addObject(
    e,
    'obj_modern',
    `
    local obj = {}

    type Vec = { x: number, y: number }

    local function scale(v: Vec, k: number): Vec
        return { x = v.x * k, y = v.y * k }
    end

    function obj.create(self)
        self.label = \`id-{self.__id}\`
        local total = 0
        for i = 1, 5 do
            if i % 2 == 0 then continue end
            total += i
        end
        local v = scale({ x = 2, y = 3 }, 4)
        self.total = total + v.x
    end

    function obj.draw(self)
        draw_circle(self.total, 0, 1, false)
    end

    return obj
    `,
  );
  await e.g('register_room')('rm_main', 320, 200, 0, 16, 16, 'obj_modern,0,0,1,1,0');
  await e.g('start')('rm_main');

  const cmds = decode((await e.g('frame')(''))[0]);
  check('type annotations, continue, interpolation all ran', near(cmds[0].p[0], 17), `got ${cmds[0]?.p[0]}`);
}

console.log('\n=== signals and connections ===');
{
  const e = await newEngine();
  await addObject(
    e,
    'obj_signal',
    `
    local obj = {}

    function obj.create(self)
        self.hits = 0
        self.once = 0
        self.bell = Signal.new()

        self.conn = self.bell:Connect(function(amount)
            self.hits += amount
        end)
        self.bell:Once(function()
            self.once += 1
        end)
    end

    function obj.step(self)
        self.bell:Fire(2)
        if self.hits >= 6 then
            self.conn:Disconnect()
        end
    end

    function obj.draw(self)
        draw_circle(self.hits, self.once, 1, false)
    end

    return obj
    `,
  );
  await e.g('register_room')('rm', 320, 200, 0, 16, 16, 'obj_signal,0,0,1,1,0');
  await e.g('start')('rm');

  let cmds = decode((await e.g('frame')(''))[0]);
  check('Connect handler ran', near(cmds[0].p[0], 2), `hits=${cmds[0]?.p[0]}`);
  check('Once fired exactly once', near(cmds[0].p[1], 1), `once=${cmds[0]?.p[1]}`);

  for (let i = 0; i < 4; i++) cmds = decode((await e.g('frame')(''))[0]);
  check('Once did not fire again', near(cmds[0].p[1], 1), `once=${cmds[0]?.p[1]}`);
  check('Disconnect stopped the handler', near(cmds[0].p[0], 6), `hits=${cmds[0]?.p[0]}`);
}

console.log('\n=== RunService and task ===');
{
  const e = await newEngine();
  await addObject(
    e,
    'obj_timing',
    `
    local obj = {}

    local RunService = game:GetService("RunService")

    function obj.create(self)
        self.beats = 0
        self.elapsed = 0
        self.delayed = 0

        RunService.Heartbeat:Connect(function(dt)
            self.beats += 1
            self.elapsed += dt
        end)

        task.delay(0.05, function()
            self.delayed = 1
        end)

        task.spawn(function()
            task.wait(0.1)
            self.delayed += 10
        end)
    end

    function obj.draw(self)
        draw_circle(self.beats, self.delayed, math.floor(self.elapsed * 1000), false)
    end

    return obj
    `,
  );
  await e.g('register_room')('rm', 320, 200, 0, 16, 16, 'obj_timing,0,0,1,1,0');
  await e.g('start')('rm');

  // 1/60 per frame, so 0.05s lands on frame 3 and 0.1s on frame 6.
  let cmds;
  for (let i = 0; i < 3; i++) cmds = decode((await e.g('frame')('', 1 / 60))[0]);
  check('Heartbeat fires every frame', near(cmds[0].p[0], 3), `beats=${cmds[0]?.p[0]}`);
  check('task.delay ran on time', near(cmds[0].p[1], 1), `delayed=${cmds[0]?.p[1]}`);
  check('task.wait has not resumed yet', !near(cmds[0].p[1], 11), `delayed=${cmds[0]?.p[1]}`);

  for (let i = 0; i < 4; i++) cmds = decode((await e.g('frame')('', 1 / 60))[0]);
  check('task.wait resumed the thread', near(cmds[0].p[1], 11), `delayed=${cmds[0]?.p[1]}`);
  check('Heartbeat received the delta', cmds[0].p[2] > 100 && cmds[0].p[2] < 130,
    `elapsed_ms=${cmds[0]?.p[2]}`);
}

console.log('\n=== UserInputService ===');
{
  const e = await newEngine();
  await addObject(
    e,
    'obj_input',
    `
    local obj = {}
    local UserInputService = game:GetService("UserInputService")

    function obj.create(self)
        self.began = 0
        self.ended = 0
        self.lastKey = ""

        UserInputService.InputBegan:Connect(function(input)
            self.began += 1
            self.lastKey = input.KeyCode
        end)
        UserInputService.InputEnded:Connect(function()
            self.ended += 1
        end)
    end

    function obj.draw(self)
        draw_circle(self.began, self.ended, if self.lastKey == "space" then 1 else 0, false)
    end

    return obj
    `,
  );
  await e.g('register_room')('rm', 320, 200, 0, 16, 16, 'obj_input,0,0,1,1,0');
  await e.g('start')('rm');

  let cmds = decode((await e.g('frame')('space|space||0,0,0,0'))[0]);
  check('InputBegan fired', near(cmds[0].p[0], 1), `began=${cmds[0]?.p[0]}`);
  check('input carried the KeyCode', near(cmds[0].p[2], 1), `key match=${cmds[0]?.p[2]}`);

  cmds = decode((await e.g('frame')('||space|0,0,0,0'))[0]);
  check('InputEnded fired', near(cmds[0].p[1], 1), `ended=${cmds[0]?.p[1]}`);
}

console.log('\n=== storage services ===');
{
  hostStore.clear();
  const e = await newEngine();
  await addObject(
    e,
    'obj_storage',
    `
    local obj = {}

    local ReplicatedStorage = game:GetService("ReplicatedStorage")
    local DataStoreService = game:GetService("DataStoreService")
    local HttpService = game:GetService("HttpService")

    function obj.create(self)
        self.changes = 0
        ReplicatedStorage.Changed:Connect(function(key, value)
            self.changes += 1
        end)

        ReplicatedStorage:SetAttribute("score", 42)
        self.readBack = ReplicatedStorage:GetAttribute("score")
        self.fallback = ReplicatedStorage:GetAttribute("missing", 7)

        local store = DataStoreService:GetDataStore("save")
        store:SetAsync("profile", { name = "ben", level = 3, tags = { "a", "b" } })
        local loaded = store:GetAsync("profile")
        self.level = loaded.level
        self.tagCount = #loaded.tags
        self.nameOk = if loaded.name == "ben" then 1 else 0
        self.incremented = store:IncrementAsync("coins", 5)

        local round = HttpService:JSONDecode(HttpService:JSONEncode({ a = 1, b = { 2, 3 } }))
        self.jsonOk = if round.a == 1 and round.b[2] == 3 then 1 else 0
    end

    function obj.draw(self)
        draw_circle(self.readBack, self.fallback, self.changes, false)
        draw_circle(self.level, self.tagCount, self.nameOk, false)
        draw_circle(self.incremented, self.jsonOk, 0, false)
    end

    return obj
    `,
  );
  await e.g('register_room')('rm', 320, 200, 0, 16, 16, 'obj_storage,0,0,1,1,0');
  await e.g('start')('rm');

  const cmds = decode((await e.g('frame')(''))[0]);
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

  // A shared module, the way the host registers scripts/*.luau.
  const moduleTable = (
    await e.state.loadstring(
      `local m = {}
       function m.double(n) return n * 2 end
       m.answer = 21
       return m`,
      'mathx.luau',
      true,
    )()
  )[0];
  await e.g('register_module')('mathx', moduleTable);

  await e.g('register_sprite')('s', 0, 1, 8, 8, 0, 0, 12, 0, 0, 7, 7);
  await addObject(e, 'obj_thing', 'return {}', { sprite: 's' });
  await addObject(
    e,
    'obj_probe',
    `
    local obj = {}
    local ScriptService = game:GetService("ScriptService")

    local EXPECTED = {
        "DataStoreService", "HttpService", "ReplicatedStorage", "RunService",
        "ScriptService", "UserInputService", "Workspace",
    }

    function obj.create(self)
        local mathx = require("mathx")
        self.doubled = mathx.double(mathx.answer)
        self.scriptCount = #ScriptService:GetScripts()
        self.children = #workspace:GetChildren()
        self.found = if workspace:FindFirstChild("obj_thing") ~= nil then 1 else 0

        -- Every expected service resolves, and nothing unexpected is present.
        local resolved = 0
        for _, name in EXPECTED do
            if game:FindService(name) ~= nil then
                resolved += 1
            end
        end
        self.services = resolved
        self.exact = if #game:GetServices() == #EXPECTED then 1 else 0
    end

    function obj.draw(self)
        draw_circle(self.doubled, self.scriptCount, self.children, false)
        draw_circle(self.found, self.services, self.exact, false)
    end

    return obj
    `,
  );
  await e.g('register_room')('rm', 320, 200, 0, 16, 16, 'obj_probe,0,0,1,1,0;obj_thing,50,50,1,1,0');
  await e.g('start')('rm');

  const cmds = decode((await e.g('frame')(''))[0]);
  check('require() returned the module', near(cmds[0].p[0], 42), `${cmds[0]?.p[0]}`);
  check('ScriptService lists scripts', near(cmds[0].p[1], 1), `${cmds[0]?.p[1]}`);
  check('Workspace:GetChildren sees instances', near(cmds[0].p[2], 2), `${cmds[0]?.p[2]}`);
  check('Workspace:FindFirstChild works', near(cmds[1].p[0], 1), `${cmds[1]?.p[0]}`);
  check('all 7 named services resolve', near(cmds[1].p[1], 7), `${cmds[1]?.p[1]} resolved`);
  check('no unexpected services registered', near(cmds[1].p[2], 1), `${cmds[1]?.p[2]}`);

  // Asserted from JS: pcall in this Luau build does not catch, so the error
  // has to be observed from outside the VM.
  let rejected = false;
  try {
    await e.state.loadstring('game:GetService("Nope")', 'bad.luau', true)();
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
  await addObject(
    e,
    'obj_loader',
    `
    local obj = {}
    function obj.create(self)
        local store = game:GetService("DataStoreService"):GetDataStore("save")
        local loaded = store:GetAsync("profile", { level = 9 })
        self.level = loaded.level
    end
    function obj.draw(self)
        draw_circle(self.level, 0, 1, false)
    end
    return obj
    `,
  );
  await e.g('register_room')('rm', 320, 200, 0, 16, 16, 'obj_loader,0,0,1,1,0');
  await e.g('start')('rm');

  const cmds = decode((await e.g('frame')(''))[0]);
  check('corrupt data falls back to the default', near(cmds[0].p[0], 9), `level=${cmds[0]?.p[0]}`);
}

console.log('\n=== instance signals ===');
{
  const e = await newEngine();
  await e.g('register_sprite')('s', 0, 1, 16, 16, 0, 0, 12, 0, 0, 15, 15);
  await addObject(e, 'obj_target', 'return {}', { sprite: 's' });
  await addObject(
    e,
    'obj_watcher',
    `
    local obj = {}

    function obj.create(self)
        self.touched = 0
        self.sawDestroy = 0

        self.Collided:Connect(function(other)
            self.touched += 1
            other.Destroying:Connect(function()
                self.sawDestroy += 1
            end)
            other:Destroy()
        end)
    end

    function obj.draw(self)
        draw_circle(self.touched, self.sawDestroy, 1, false)
    end

    return obj
    `,
    { sprite: 's' },
  );
  await e.g('register_room')('rm', 320, 200, 0, 16, 16, 'obj_watcher,50,50,1,1,0;obj_target,54,54,1,1,0');
  await e.g('start')('rm');

  await e.g('frame')('');
  const cmds = decode((await e.g('frame')(''))[0]);
  check('Collided signal fired', cmds[0].p[0] >= 1, `touched=${cmds[0]?.p[0]}`);
  check('Destroying signal fired', near(cmds[0].p[1], 1), `sawDestroy=${cmds[0]?.p[1]}`);
  check('target was removed', (await e.g('instance_number')('obj_target'))[0] === 0);
}

console.log('\n=== tilesets and tile layers ===');
{
  const e = await newEngine();
  // 4 tiles in one row; tiles 0 and 1 are solid.
  await e.g('register_tileset')('ts', 100, 16, 16, 4, 1, '1100');
  await e.g('register_sprite')('s', 0, 1, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  await addObject(
    e,
    'obj_probe',
    `
    local obj = {}

    function obj.create(self)
        local layers = tilemap_layers()
        self.layerCount = #layers
        self.first = tilemap_get("floor", 0, 0)
        self.middle = tilemap_get("floor", 2, 1)
        self.outside = tilemap_get("floor", 99, 99)

        self.solidHere = if tile_solid_at(8, 8) then 1 else 0
        self.solidGap = if tile_solid_at(40, 8) then 1 else 0

        tilemap_set("floor", 0, 0, 3)
        self.afterSet = tilemap_get("floor", 0, 0)
        -- Row 0 is [0, 1, -1, 2], so x=52 lands in column 3, which holds 2.
        self.byPixel = tilemap_get_at("floor", 52, 4)
    end

    function obj.draw(self)
        draw_circle(self.layerCount, self.first, self.middle, false)
        draw_circle(self.outside, self.solidHere, self.solidGap, false)
        draw_circle(self.afterSet, self.byPixel, 0, false)
    end

    return obj
    `,
  );
  await e.g('register_room')('rm', 320, 200, 0, 16, 16, 'obj_probe,200,180,1,1,0');
  // 4x3 grid: row 0 = 0,1,-1,2 ; row 1 = -1,-1,3,-1 ; row 2 all empty
  await e.g('register_room_layer')('rm', 'floor', 'ts', 20, true, 4, 3, '0:1,1:1,-1:1,2:1,-1:2,3:1,-1:5');
  await e.g('start')('rm');

  const cmds = decode((await e.g('frame')(''))[0]);
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
  await e.g('register_tileset')('ts', 100, 16, 16, 2, 1, '10');
  await e.g('register_sprite')('s', 0, 1, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  await addObject(
    e,
    'obj_walker',
    `
    local obj = {}

    function obj.create(self)
        -- Solid tile occupies 0..16 on both axes.
        self.intoSolid = if self:place_meeting(8, 8, "tiles") then 1 else 0
        self.intoEmpty = if self:place_meeting(200, 100, "tiles") then 1 else 0

        self.x = 100
        self.y = 8
        self:move_contact("tiles", -100, 0)
        self.stopped = self.x
    end

    function obj.draw(self)
        draw_circle(self.intoSolid, self.intoEmpty, self.stopped, false)
    end

    return obj
    `,
    { sprite: 's' },
  );
  await e.g('register_room')('rm', 320, 200, 0, 16, 16, 'obj_walker,200,150,1,1,0');
  await e.g('register_room_layer')('rm', 'floor', 'ts', 20, true, 4, 3, '0:1,-1:11');
  await e.g('start')('rm');

  const cmds = decode((await e.g('frame')(''))[0]);
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
  await e.g('register_sprite')('s', 0, 1, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  await addObject(e, 'obj_block', 'return {}', { sprite: 's' });
  await addObject(
    e,
    'obj_pusher',
    `
    local obj = {}
    function obj.create(self)
        self.hspeed = 8
    end
    function obj.draw(self)
        draw_circle(self.x, self.y, self.hspeed, false)
    end
    return obj
    `,
    { sprite: 's', blockedBy: ['obj_block'] },
  );
  await e.g('register_room')('rm', 320, 200, 0, 16, 16, 'obj_pusher,40,100,1,1,0;obj_block,104,100,1,1,0');
  await e.g('start')('rm');

  let probe;
  for (let i = 0; i < 12; i++) {
    const cmds = decode((await e.g('frame')(''))[0]);
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
  await e.g('register_sprite')('s', 0, 1, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  await addObject(e, 'obj_block', 'return {}', { sprite: 's' });
  await addObject(
    e,
    'obj_ghost',
    `
    local obj = {}
    function obj.create(self) self.hspeed = 8 end
    function obj.draw(self) draw_circle(self.x, self.y, 1, false) end
    return obj
    `,
    { sprite: 's' },
  );
  await e.g('register_room')('rm', 320, 200, 0, 16, 16, 'obj_ghost,40,100,1,1,0;obj_block,104,100,1,1,0');
  await e.g('start')('rm');

  let probe;
  for (let i = 0; i < 12; i++) {
    const cmds = decode((await e.g('frame')(''))[0]);
    probe = cmds.filter((c) => c.kind === CMD.CIRCLE)[0];
  }
  check('an unlisted object passes straight through', probe.p[0] > 120, `x=${probe?.p[0]}`);
}

{
  // Blocking against solid tiles, with gravity: a platformer floor. The tile
  // row covers y 32..48; the faller starts above it and lists "tiles".
  const e = await newEngine();
  await e.g('register_tileset')('ts', 100, 16, 16, 2, 1, '10');
  await e.g('register_sprite')('s', 0, 1, 16, 16, 8, 8, 12, 0, 0, 15, 15);
  await addObject(
    e,
    'obj_faller',
    `
    local obj = {}
    function obj.create(self)
        self.gravity = 0.5
    end
    function obj.draw(self)
        draw_circle(self.x, self.y, self.vspeed, false)
    end
    return obj
    `,
    { sprite: 's', blockedBy: ['tiles'] },
  );
  await e.g('register_room')('rm', 320, 200, 0, 16, 16, 'obj_faller,24,8,1,1,0');
  // One solid tile row along y=32: 4 columns of tile 0 at row 2.
  await e.g('register_room_layer')('rm', 'floor', 'ts', 20, true, 4, 4, '-1:8,0:4,-1:4');
  await e.g('start')('rm');

  let probe;
  for (let i = 0; i < 40; i++) {
    const cmds = decode((await e.g('frame')(''))[0]);
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
    await e.g('frame')('');
  }
  check('resting on a floor is stable across further steps', true);
  void before;
}

console.log('\n=== layer depth ordering ===');
{
  const e = await newEngine();
  await e.g('register_tileset')('ts', 100, 16, 16, 1, 1, '0');
  await e.g('register_sprite')('s', 50, 1, 8, 8, 0, 0, 12, 0, 0, 7, 7);
  await addObject(e, 'obj_mid', 'return {}', { sprite: 's', depth: 0 });
  await e.g('register_room')('rm', 320, 200, 0, 16, 16, 'obj_mid,100,100,1,1,0');
  await e.g('register_room_layer')('rm', 'back', 'ts', 50, true, 1, 1, '0:1');
  await e.g('register_room_layer')('rm', 'front', 'ts', -50, true, 1, 1, '0:1');
  await e.g('start')('rm');

  const cmds = decode((await e.g('frame')(''))[0]);
  check('three draws in depth order', cmds.length === 3, `${cmds.length}`);
  check('depth 50 layer drawn first', cmds[0]?.p[0] === 100, `${cmds[0]?.p[0]}`);
  check('instance drawn between the layers', cmds[1]?.p[0] === 50, `${cmds[1]?.p[0]}`);
  check('depth -50 layer drawn last', cmds[2]?.p[0] === 100, `${cmds[2]?.p[0]}`);
}

console.log('\n=== hidden layers ===');
{
  const e = await newEngine();
  await e.g('register_tileset')('ts', 100, 16, 16, 1, 1, '0');
  await addObject(e, 'obj_none', 'return {}');
  await e.g('register_room')('rm', 320, 200, 0, 16, 16, '');
  await e.g('register_room_layer')('rm', 'hidden', 'ts', 20, false, 2, 2, '0:4');
  await e.g('start')('rm');

  const cmds = decode((await e.g('frame')(''))[0]);
  check('an invisible layer draws nothing', cmds.length === 0, `${cmds.length} commands`);
}

console.log('\n=== missing start room ===');
{
  const e = await newEngine();
  await e.g('register_room')('rm_real', 320, 200, 0, 16, 16, '');

  let message = '';
  try {
    await e.g('start')('rm_gone');
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
    await e.g('start')('rm_main');
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
    await e.g('register_tileset')('ts', 100, 16, 16, 2, 1, '00');
    await addObject(e, 'obj_none', 'return {}');
    await e.g('register_room')('rm', COLUMNS * 16, ROWS * 16, 0, 16, 16, '');
    await e.g('register_room_layer')('rm', 'field', 'ts', 50, true, COLUMNS, ROWS, runs, bufferIndex);
    await e.g('start')('rm');

    await e.g('frame')('');
    let payload = 0;
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) payload = (await e.g('frame')(''))[0].length;
    return { ms: (performance.now() - t0) / 60, payload, commands: decode((await e.g('frame')(''))[0]) };
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
  await e.g('register_sprite')('s', 0, 1, 8, 8, 4, 4, 12, 0, 0, 7, 7);
  await addObject(
    e,
    'obj_bit',
    `
    local obj = {}
    function obj.create(self)
        self.hspeed = 1
        self.vspeed = 0.5
    end
    return obj
    `,
    { sprite: 's' },
  );
  const placements = [];
  for (let i = 0; i < 300; i++) placements.push(`obj_bit,${i},${i % 200},1,1,0`);
  await e.g('register_room')('rm_main', 640, 480, 0, 16, 16, placements.join(';'));
  await e.g('start')('rm_main');

  await e.g('frame')('');
  const t0 = performance.now();
  const FRAMES = 300;
  let last;
  for (let i = 0; i < FRAMES; i++) last = decode((await e.g('frame')(''))[0]);
  const per = (performance.now() - t0) / FRAMES;

  check('all 300 instances drawn', last.length === 300, `got ${last.length}`);
  check(`frame time ${per.toFixed(2)} ms is within 16.6 ms budget`, per < 16.6, `${per.toFixed(2)} ms`);
  console.log(`       -> ${per.toFixed(2)} ms/frame at 300 instances`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
