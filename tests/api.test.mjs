/**
 * Per-function API audit.
 *
 * The other suites test behaviour; this one walks the whole scripting surface
 * and checks each function individually, so a function that exists but is
 * broken cannot hide behind the ones around it.
 *
 * Results come back through `__test_report`, a JS function registered into the
 * VM. That costs ~90us a call, which is irrelevant here and far simpler than
 * smuggling results out through the draw buffer.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuauState } from 'luau-web';

const here = dirname(fileURLToPath(import.meta.url));
const luau = (name) => readFileSync(join(here, '..', 'src', 'luau', name), 'utf8');

const RECORD_FLOATS = 12;
const CMD = { SPRITE: 0, RECT: 1, LINE: 2, CIRCLE: 3 };

const results = [];
const report = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail ?? '' });

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

const hostStore = new Map();

const state = await LuauState.createAsync({
  __host_store_get: (key) => hostStore.get(key) ?? '',
  __host_store_set: (key, value) => {
    if (value === '') hostStore.delete(key);
    else hostStore.set(key, value);
  },
  __test_report: (name, ok, detail) => report(String(name), ok, detail == null ? '' : String(detail)),
});

await state.loadstring(luau('roblox.luau'), 'roblox.luau', true)();
const api = (await state.loadstring(luau('prelude.luau'), 'prelude.luau', true)())[0];
const g = (name) => api.get(name);

// ---- fixtures -----------------------------------------------------------

await g('register_sprite')('spr_box', 0, 3, 16, 16, 8, 8, 15, 2, 2, 13, 13);
await g('register_tileset')('ts', 500, 16, 16, 2, 1, '10');
await g('register_font')(12, '65,900,7,6,9;66,901,7,6,9;48,902,7,6,9');

const addObject = async (name, source, def = {}) => {
  const module = (await state.loadstring(source, `${name}.luau`, true)())[0];
  await g('register_object')(
    name,
    module,
    def.sprite ?? null,
    def.depth ?? 0,
    def.visible ?? true,
    def.solid ?? false,
    def.persistent ?? false,
    def.parent ?? null,
  );
};

await addObject('obj_base', 'return {}', { sprite: 'spr_box' });
await addObject('obj_child', 'return {}', { sprite: 'spr_box', parent: 'obj_base' });
await addObject('obj_other', 'return {}', { sprite: 'spr_box' });

// Every event reports itself the first time it runs.
await addObject(
  'obj_events',
  `
  local obj = {}
  local seen = {}
  local function once(name)
      if not seen[name] then
          seen[name] = true
          __test_report("event " .. name, true, "")
      end
  end

  function obj.create(self)
      once("create")
      self.alarms[1] = 2
      self.image_speed = 0.5
  end
  function obj.room_start(self) once("room_start") end
  function obj.room_end(self) once("room_end") end
  function obj.alarm(self, index) once("alarm") end
  function obj.step_begin(self) once("step_begin") end
  function obj.step(self) once("step") end
  function obj.step_end(self) once("step_end") end
  function obj.collision(self, other) once("collision") end
  function obj.animation_end(self) once("animation_end") end
  function obj.destroy(self) once("destroy") end
  function obj.draw(self) once("draw") self:draw_self() end
  function obj.draw_gui(self) once("draw_gui") end

  return obj
  `,
  { sprite: 'spr_box' },
);

// Draws one of every command shape, so the buffer can be inspected.
await addObject(
  'obj_draw',
  `
  local obj = {}

  function obj.draw(self)
      draw_set_color(c_red)
      draw_set_alpha(0.5)
      __test_report("draw_get_color", draw_get_color() == c_red, tostring(draw_get_color()))

      draw_rectangle(10, 10, 20, 20, false)
      draw_rectangle(30, 10, 40, 20, true)
      draw_line(0, 50, 100, 50, 2)
      draw_circle(60, 60, 5, false)
      draw_set_alpha(1)
      draw_sprite("spr_box", 0, 100, 100)
      draw_sprite_ext("spr_box", 1, 120, 100, 2, 2, 45, c_blue, 0.5)
      draw_text(0, 0, "AB0", c_white)
  end

  return obj
  `,
);

await g('register_room')('rm_one', 320, 240, 0x102030, 16, 16, '');
await g('register_room')('rm_two', 640, 480, 0x000000, 32, 32, '');
await g('register_room_layer')('rm_one', 'floor', 'ts', 20, true, 4, 3, '0:1,-1:11');
await g('start')('rm_one');

// ---- pure functions, queries and instance methods -----------------------

const AUDIT = `
local function ok(name, condition, detail)
    __test_report(name, condition == true, detail or "")
end
local function near(a, b)
    return math.abs(a - b) < 0.001
end

-- maths ------------------------------------------------------------------
ok("point_distance", near(point_distance(0, 0, 3, 4), 5))
ok("point_direction", near(point_direction(0, 0, 1, 0), 0) and near(point_direction(0, 0, 0, -1), 90))
ok("lengthdir_x", near(lengthdir_x(10, 0), 10))
ok("lengthdir_y", near(lengthdir_y(10, 90), -10))
ok("clamp", clamp(5, 0, 3) == 3 and clamp(-1, 0, 3) == 0)
ok("lerp", near(lerp(0, 10, 0.5), 5))
ok("approach", approach(0, 10, 3) == 3 and approach(10, 0, 3) == 7 and approach(1, 2, 5) == 2)
ok("sign", sign(-5) == -1 and sign(0) == 0 and sign(2) == 1)
ok("choose", (function() local v = choose(7, 7, 7) return v == 7 end)())
ok("irandom", irandom(0) == 0 and irandom(5) >= 0 and irandom(5) <= 5)
ok("irandom_range", irandom_range(5, 5) == 5)
ok("random_range", near(random_range(2, 2), 2))
ok("angle_difference", near(angle_difference(10, 350), 20))
ok("wrap", near(wrap(370, 0, 360), 10) and near(wrap(-10, 0, 360), 350))

-- colours ----------------------------------------------------------------
ok("c_black", c_black == 0x000000)
ok("c_white", c_white == 0xFFFFFF)
ok("c_red", c_red == 0xFF004D)
ok("c_green", c_green == 0x00E436)
ok("c_blue", c_blue == 0x29ADFF)
ok("c_yellow", c_yellow == 0xFFEC27)
ok("c_orange", c_orange == 0xFFA300)
ok("c_purple", c_purple == 0x83769C)
ok("c_gray", c_gray == 0x5F574F)
ok("c_grey", c_grey == c_gray)

-- rooms ------------------------------------------------------------------
ok("room_current", room_current() == "rm_one", room_current())
ok("room_width", room_width() == 320, tostring(room_width()))
ok("room_height", room_height() == 240, tostring(room_height()))
ok("room_speed", room_speed() == 60, tostring(room_speed()))
view_set(12, 34)
local vx, vy = view_get()
ok("view_set", vx == 12 and vy == 34)
ok("view_get", vx == 12 and vy == 34, \`{vx},{vy}\`)
view_set(0, 0)

-- instances --------------------------------------------------------------
local a = instance_create(100, 100, "obj_base")
ok("instance_create", a ~= nil and a.x == 100 and a.y == 100)

local child = instance_create(300, 300, "obj_child")
ok("instance_exists", instance_exists("obj_base") == true and instance_exists("obj_missing") == false)
ok("instance_number", instance_number("obj_base") == 2, tostring(instance_number("obj_base")))
ok("instance_find", instance_find("obj_base") ~= nil and instance_find("obj_base", 5) == nil)
ok("instance_list", #instance_list("obj_base") == 2, tostring(#instance_list("obj_base")))
ok("instance_nearest", instance_nearest(101, 101, "obj_base") == a)
ok("collision_point", collision_point(100, 100, "obj_base") == a)

-- instance methods --------------------------------------------------------
ok("is_a", child:is_a("obj_child") and child:is_a("obj_base") and not child:is_a("obj_other"))

local l, t, r, b = a:bbox()
-- mask 2..13 with origin 8 gives -6..+6 around x
ok("bbox", near(l, 94) and near(t, 94) and near(r, 106) and near(b, 106), \`{l},{t},{r},{b}\`)

local overlap = instance_create(104, 100, "obj_other")
ok("place_meeting", a:place_meeting(104, 100, "obj_other") == true and a:place_meeting(300, 300, "obj_other") == false)
ok("instance_place", a:instance_place(104, 100, "obj_other") == overlap)
ok("instance_place_list", #a:instance_place_list(104, 100, "obj_other") == 1)
overlap:destroy()

ok("distance_to_point", near(a:distance_to_point(103, 104), 5))
local far = instance_create(100, 105, "obj_other")
ok("distance_to_object", near(a:distance_to_object(far), 5))
far:destroy()

a:move_towards_point(110, 100, 4)
ok("move_towards_point", near(a.hspeed, 4) and near(a.vspeed, 0), \`{a.hspeed},{a.vspeed}\`)
ok("speed", near(a:speed(), 4), tostring(a:speed()))
ok("direction", near(a:direction(), 0), tostring(a:direction()))
a:set_speed(2, 90)
ok("set_speed", near(a.vspeed, -2), tostring(a.vspeed))
a.hspeed, a.vspeed = 0, 0

ok("sprite_width", near(a:sprite_width(), 16), tostring(a:sprite_width()))
ok("sprite_height", near(a:sprite_height(), 16))
ok("image_number", a:image_number() == 3, tostring(a:image_number()))

local blocker = instance_create(140, 100, "obj_other")
a.x, a.y = 100, 100
a:move_contact("obj_other", 100, 0)
ok("move_contact", a.x > 100 and a.x < 140, \`stopped at {a.x}\`)
blocker:destroy()
a.x, a.y = 100, 100

-- instance fields ----------------------------------------------------------
ok("field x/y", a.x == 100 and a.y == 100)
ok("field xstart/ystart", a.xstart == 100 and a.ystart == 100)
ok("field yprevious", a.yprevious ~= nil)
ok("field alarms", #a.alarms == 12, tostring(#a.alarms))
ok("field sprite_index", a.sprite_index == "spr_box", tostring(a.sprite_index))
ok("field image_index", a.image_index == 0, tostring(a.image_index))
ok("field image_speed", a.image_speed > 0, tostring(a.image_speed))
ok("field image_alpha", a.image_alpha == 1)
ok("field solid", a.solid == false)
ok("field image_yscale", a.image_yscale == 1)
ok("field image_angle", a.image_angle == 0)
ok("Destroy alias", type(a.Destroy) == "function")
a.image_xscale, a.image_yscale, a.image_angle = 2, 2, 30
ok("field image_xscale", near(a:sprite_width(), 32), tostring(a:sprite_width()))
a.image_xscale, a.image_yscale, a.image_angle = 1, 1, 0
a.visible = false
ok("field visible", a.visible == false)
a.visible = true
a.depth = 5
ok("field depth", a.depth == 5)
a.image_blend = c_red
ok("field image_blend", a.image_blend == c_red)
a.image_blend = c_white

ok("instance_destroy", (function()
    local victim = instance_create(0, 0, "obj_other")
    instance_destroy(victim)
    return victim.destroyed ~= false
end)())

-- tiles ---------------------------------------------------------------------
ok("tilemap_layers", #tilemap_layers() == 1, tostring(#tilemap_layers()))
ok("tilemap_get", tilemap_get("floor", 0, 0) == 0 and tilemap_get("floor", 1, 0) == -1)
ok("tilemap_set", (function()
    tilemap_set("floor", 1, 0, 1)
    local v = tilemap_get("floor", 1, 0)
    tilemap_set("floor", 1, 0, -1)
    return v == 1
end)())
ok("tilemap_get_at", tilemap_get_at("floor", 8, 8) == 0, tostring(tilemap_get_at("floor", 8, 8)))
ok("tile_solid_at", tile_solid_at(8, 8) == true and tile_solid_at(200, 200) == false)
ok("place_meeting tiles", (function()
    local probe = instance_create(8, 8, "obj_other")
    local hit = probe:place_meeting(8, 8, "tiles")
    local miss = probe:place_meeting(250, 200, "tiles")
    probe:destroy()
    return hit == true and miss == false
end)())

-- text metrics ---------------------------------------------------------------
ok("string_width", string_width("AB") > 0, tostring(string_width("AB")))
ok("string_height", string_height("A\\nB") > string_height("A"), tostring(string_height("A")))

a:destroy()
child:destroy()
`;

await state.loadstring(AUDIT, 'audit.luau', true)();

// ---- drawing, events, input, movement over real frames -------------------

await g('register_room')('rm_draw', 320, 240, 0, 16, 16, 'obj_draw,0,0,1,1,0;obj_events,50,50,1,1,0;obj_other,54,54,1,1,0');
await g('start')('rm_draw');

const frame1 = decode((await g('frame')('a|a||10,20,1,1', 1 / 60))[0]);

const kinds = (kind) => frame1.filter((c) => c.kind === kind);
report('draw_rectangle', kinds(CMD.RECT).length >= 1, `${kinds(CMD.RECT).length} rect commands`);
report('draw_rectangle outline', kinds(CMD.RECT).some((c) => c.p[4] === 1), 'no outline variant');
report('draw_line', kinds(CMD.LINE).length >= 1, `${kinds(CMD.LINE).length}`);
report('draw_circle', kinds(CMD.CIRCLE).length >= 1, `${kinds(CMD.CIRCLE).length}`);
report('draw_set_alpha', kinds(CMD.RECT).some((c) => Math.abs(c.color[3] - 0.5) < 0.01), 'alpha not applied');
report('draw_set_color', kinds(CMD.RECT).some((c) => c.color[0] === 1 && c.color[2] > 0.29), 'colour not applied');

const sprites = kinds(CMD.SPRITE);
report('draw_sprite', sprites.some((c) => c.p[1] === 100 && c.p[2] === 100), 'no sprite at 100,100');
report(
  'draw_sprite_ext',
  sprites.some((c) => c.p[1] === 120 && Math.abs(c.p[6] ?? 0) >= 0 && c.p[3] === 2 && c.p[5] === 45),
  'no transformed sprite',
);
report('draw_text', sprites.filter((c) => c.p[0] >= 900 && c.p[0] < 903).length === 3, 'expected 3 glyphs');
report('draw_self', sprites.some((c) => c.p[0] >= 0 && c.p[0] < 3), 'no instance sprite drawn');

// Input reflects the frame we just pushed.
const INPUT_CHECK = `
local function ok(name, condition, detail)
    __test_report(name, condition == true, detail or "")
end
ok("keyboard_check", keyboard_check("a") == true and keyboard_check("z") == false)
ok("keyboard_check_pressed", keyboard_check_pressed("a") == true)
ok("keyboard_check_released", keyboard_check_released("a") == false)
ok("mouse_x", mouse_x() == 10, tostring(mouse_x()))
ok("mouse_y", mouse_y() == 20, tostring(mouse_y()))
ok("mouse_check_button", mouse_check_button("left") == true and mouse_check_button("right") == false)
ok("mouse_wheel", mouse_wheel() == 1, tostring(mouse_wheel()))
`;
await state.loadstring(INPUT_CHECK, 'input.luau', true)();

// Built-in movement fields, over a frame.
const MOVEMENT = `
local function ok(name, condition, detail)
    __test_report(name, condition == true, detail or "")
end
local m = instance_create(0, 0, "obj_other")
m.hspeed = 3
m.vspeed = 0
m.gravity = 1
m.gravity_direction = 270
m.friction = 0
__test_report("field hspeed/vspeed", true, "")
_G_TEST_MOVER = m
`;
await state.loadstring(MOVEMENT.replace('_G_TEST_MOVER = m', 'MOVER = m'), 'move.luau', true)();

await g('frame')('', 1 / 60);

await state.loadstring(
  `
  local function ok(name, condition, detail)
      __test_report(name, condition == true, detail or "")
  end
  local m = MOVER
  ok("field hspeed moves x", math.abs(m.x - 3) < 0.001, tostring(m.x))
  ok("field gravity", m.vspeed > 0.9 and m.vspeed < 1.1, tostring(m.vspeed))
  ok("field xprevious", math.abs(m.xprevious - 0) < 0.001, tostring(m.xprevious))
  m.friction = 0.5
  m.gravity = 0
  local before = math.sqrt(m.hspeed * m.hspeed + m.vspeed * m.vspeed)
  FRICTION_BEFORE = before
  `,
  'move2.luau',
  true,
)();

await g('frame')('', 1 / 60);
await state.loadstring(
  `
  local m = MOVER
  local after = math.sqrt(m.hspeed * m.hspeed + m.vspeed * m.vspeed)
  __test_report("field friction", after < FRICTION_BEFORE, \`{FRICTION_BEFORE} -> {after}\`)
  m:destroy()
  `,
  'move3.luau',
  true,
)();

// Alarms need a couple more steps; animation_end needs the sprite to wrap.
for (let i = 0; i < 12; i++) await g('frame')('', 1 / 60);

// The destroy event only runs on an explicit destroy; a room change discards
// instances without firing it, matching GameMaker.
await state.loadstring(
  'local e = instance_find("obj_events") if e then e:destroy() end',
  'destroyevent.luau',
  true,
)();

// room_goto / room_restart / game_end
await state.loadstring('room_goto("rm_one")', 'goto.luau', true)();
await g('frame')('', 1 / 60);
report('room_goto', (await g('room_current')())[0] === 'rm_one', (await g('room_current')())[0]);

await state.loadstring('room_restart()', 'restart.luau', true)();
await g('frame')('', 1 / 60);
report('room_restart', (await g('room_current')())[0] === 'rm_one');

await state.loadstring('game_end()', 'end.luau', true)();
const quitFrame = await g('frame')('', 1 / 60);
report('game_end', quitFrame[7] === true, `quit flag ${quitFrame[7]}`);

// ---- Roblox layer --------------------------------------------------------

// `reset` already disconnects every service signal and clears the task queue.
// Re-loading roblox.luau here would swap `__rbx` for a fresh table *after* the
// prelude wired its instance provider into the original, silently detaching
// Workspace and every frame signal.
await g('reset')();
await g('register_room')('rm_rbx', 320, 240, 0, 16, 16, '');
await addObject('obj_rbx', 'return {}');
await g('start')('rm_rbx');

const RBX = `
local function ok(name, condition, detail)
    __test_report(name, condition == true, detail or "")
end

-- Signal
local sig = Signal.new()
ok("Signal.new", sig ~= nil)
local hits = 0
local conn = sig:Connect(function(n) hits += n end)
sig:Fire(2)
ok("Signal:Connect", hits == 2, tostring(hits))
ok("Connection.Connected", conn.Connected == true)
local onceHits = 0
sig:Once(function() onceHits += 1 end)
sig:Fire(1)
sig:Fire(1)
ok("Signal:Once", onceHits == 1, tostring(onceHits))
conn:Disconnect()
local before = hits
sig:Fire(5)
ok("Connection:Disconnect", hits == before, tostring(hits))
local sig2 = Signal.new()
sig2:Connect(function() end)
sig2:DisconnectAll()
ok("Signal:DisconnectAll", #sig2._handlers == 0, tostring(#sig2._handlers))

-- snake_case aliases, since the rest of the engine uses them
ok("Signal:connect alias", type(sig.connect) == "function" and sig.connect == sig.Connect)
ok("Signal:fire alias", sig.fire == sig.Fire)
ok("Signal:once alias", sig.once == sig.Once)
ok("Signal:wait alias", sig.wait == sig.Wait)
ok("Connection:disconnect alias", type(conn.disconnect) == "function")
ok("wait global", type(wait) == "function")

-- task
local spawned = false
task.spawn(function() spawned = true end)
ok("task.spawn", spawned == true)

WAITED = false
task.spawn(function()
    task.wait(0.02)
    WAITED = true
end)
DELAYED = false
task.delay(0.02, function() DELAYED = true end)
DEFERRED = false
task.defer(function() DEFERRED = true end)
local cancelled = task.spawn(function() task.wait(10) end)
task.cancel(cancelled)
ok("task.cancel", true)

-- services
ok("game:GetService", game:GetService("RunService") ~= nil)
ok("game:FindService", game:FindService("Nope") == nil)
ok("game:GetServices", #game:GetServices() == 7, tostring(#game:GetServices()))

HEARTBEAT = 0
STEPPED = 0
RENDERED = 0
game:GetService("RunService").Heartbeat:Connect(function(dt) HEARTBEAT += 1 end)
game:GetService("RunService").Stepped:Connect(function() STEPPED += 1 end)
game:GetService("RunService").RenderStepped:Connect(function() RENDERED += 1 end)

INPUT_BEGAN = 0
INPUT_ENDED = 0
local uis = game:GetService("UserInputService")
uis.InputBegan:Connect(function(input) INPUT_BEGAN += 1 end)
uis.InputEnded:Connect(function() INPUT_ENDED += 1 end)
ok("UserInputService:IsKeyDown", uis:IsKeyDown("q") == false)
ok("UserInputService:GetMouseLocation", (function() local x, y = uis:GetMouseLocation() return x ~= nil end)())
ok("UserInputService:IsMouseButtonPressed", uis:IsMouseButtonPressed("left") == false)

local rs = game:GetService("ReplicatedStorage")
local changed = 0
rs.Changed:Connect(function() changed += 1 end)
rs:SetAttribute("k", 5)
ok("ReplicatedStorage:SetAttribute", rs:GetAttribute("k") == 5)
ok("ReplicatedStorage:GetAttribute default", rs:GetAttribute("nope", 9) == 9)
ok("ReplicatedStorage.Changed", changed == 1, tostring(changed))
rs:Set("j", 1)
ok("ReplicatedStorage:Set/Get", rs:Get("j") == 1)
ok("ReplicatedStorage:GetAttributes", rs:GetAttributes().k == 5)
rs:ClearAllAttributes()
ok("ReplicatedStorage:ClearAllAttributes", rs:GetAttribute("k") == nil)

local http = game:GetService("HttpService")
local encoded = http:JSONEncode({ a = 1, b = { 2, 3 }, c = "x" })
local round = http:JSONDecode(encoded)
ok("HttpService:JSONEncode", type(encoded) == "string")
ok("HttpService:JSONDecode", round.a == 1 and round.b[2] == 3 and round.c == "x")
ok("HttpService:GenerateGUID", #http:GenerateGUID() > 20)

local store = game:GetService("DataStoreService"):GetDataStore("audit")
ok("DataStoreService:GetDataStore", store ~= nil)
store:SetAsync("n", 41)
ok("DataStore:SetAsync", store:GetAsync("n") == 41)
ok("DataStore:GetAsync default", store:GetAsync("absent", 3) == 3)
ok("DataStore:IncrementAsync", store:IncrementAsync("n", 1) == 42)
ok("DataStore:UpdateAsync", store:UpdateAsync("n", function(v) return v + 8 end) == 50)
store:RemoveAsync("n")
ok("DataStore:RemoveAsync", store:GetAsync("n") == nil)

local ss = game:GetService("ScriptService")
ok("ScriptService:GetScripts", type(ss:GetScripts()) == "table")

ok("workspace:GetChildren", type(workspace:GetChildren()) == "table")
ok("workspace:CountOf", workspace:CountOf("obj_rbx") == 0, tostring(workspace:CountOf("obj_rbx")))
local w = instance_create(10, 10, "obj_rbx")
ok("workspace:FindFirstChild", workspace:FindFirstChild("obj_rbx") ~= nil)
ok("workspace:GetPartsInRegion", #workspace:GetPartsInRegion(0, 0, 40, 40) >= 1)
ok("workspace:GetDescendants", #workspace:GetDescendants() >= 1)
w:destroy()
`;
await state.loadstring(RBX, 'rbx.luau', true)();

// Frames so RunService signals fire and task timers elapse.
await g('frame')('b|b||0,0,0,0', 1 / 60);
await g('frame')('||b|0,0,0,0', 1 / 60);
for (let i = 0; i < 4; i++) await g('frame')('', 1 / 60);

await state.loadstring(
  `
  local function ok(name, condition, detail)
      __test_report(name, condition == true, detail or "")
  end
  ok("RunService.Heartbeat", HEARTBEAT >= 6, tostring(HEARTBEAT))
  ok("RunService.Stepped", STEPPED >= 6, tostring(STEPPED))
  ok("RunService.RenderStepped", RENDERED >= 6, tostring(RENDERED))
  ok("UserInputService.InputBegan", INPUT_BEGAN >= 1, tostring(INPUT_BEGAN))
  ok("UserInputService.InputEnded", INPUT_ENDED >= 1, tostring(INPUT_ENDED))
  ok("task.wait", WAITED == true)
  ok("task.delay", DELAYED == true)
  ok("task.defer", DEFERRED == true)
  ok("require", type(require) == "function")
  ok("Signal:Wait", (function()
      local s = Signal.new()
      local got = false
      task.spawn(function()
          s:Wait()
          got = true
      end)
      s:Fire()
      return got
  end)())
  `,
  'rbx2.luau',
  true,
)();

// ---- report --------------------------------------------------------------

const failures = results.filter((r) => !r.ok);
const byStatus = new Map();
for (const r of results) byStatus.set(r.name, r);

console.log(`\nChecked ${results.length} API entries\n`);

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) {
  if (r.ok) console.log(`  ok   ${r.name}`);
  else console.log(`  FAIL ${r.name.padEnd(width)}  ${r.detail}`);
}

console.log(`\n${results.length - failures.length} passed, ${failures.length} failed\n`);
if (failures.length) {
  console.log('Failing:', failures.map((f) => f.name).join(', '), '\n');
}
process.exit(failures.length === 0 ? 0 : 1);
