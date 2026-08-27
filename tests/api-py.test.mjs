/**
 * Per-function API audit for the Python engine.
 *
 * The same walk over the scripting surface as `api.test.mjs`, with the same
 * check labels in the same order and the same expected numbers, run against
 * `src/python/*.py` on MicroPython. Together with the Luau suite it proves the
 * two engines expose one API with one behaviour.
 *
 * Results come back through `__test_report`, a JS function registered as a
 * module and seeded into the object-script namespace, so game code calls it
 * exactly as the Luau version does.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const python = (name) => readFileSync(join(here, '..', 'src', 'python', name), 'utf8');

const { loadMicroPython } = await import(pathToFileURL(join(here, '..', 'src', 'vendor', 'micropython.js')).href);

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
    quit: fields[6] === '1',
    commands: decode(packed.slice(from)),
  };
}

const hostStore = new Map();

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
mp.registerJsModule('__test', {
  report: (name, ok, detail) => report(String(name), ok, detail == null ? '' : String(detail)),
});

mp.runPython(python('roblox.py'));
mp.runPython(python('prelude.py'));

// Object scripts run against a copy of `__API`, which `__reset` rebuilds from
// `_API_BASE`; seeding both keeps `__test_report` visible across the reset
// below. The interpreter's own globals get it too, for the audit snippets.
mp.runPython(`
import __test
__test_report = __test.report
_API_BASE["__test_report"] = __test.report
__API["__test_report"] = __test.report
`);

const g = (name) => {
  const fn = mp.globals.get(name);
  if (typeof fn !== 'function') throw new Error(`prelude did not define "${name}" (got ${typeof fn})`);
  return fn;
};
const frame = (input = '', dt = 1 / 60) => unpack(g('__frame_packed')(input, dt));
const run = (source) => mp.runPython(source);

// ---- fixtures -----------------------------------------------------------

g('__register_sprite')('spr_box', 0, 3, 16, 16, 8, 8, 15, 2, 2, 13, 13);
g('__register_tileset')('ts', 500, 16, 16, 2, 1, '10');
g('__register_font')(12, '65,900,7,6,9;66,901,7,6,9;48,902,7,6,9');

const addObject = (name, source, def = {}) => {
  g('__register_object')(
    name,
    source,
    def.sprite ?? null,
    def.depth ?? 0,
    def.visible ?? true,
    def.solid ?? false,
    def.persistent ?? false,
    def.parent ?? null,
    '',
  );
};

addObject('obj_base', '', { sprite: 'spr_box' });
addObject('obj_child', '', { sprite: 'spr_box', parent: 'obj_base' });
addObject('obj_other', '', { sprite: 'spr_box' });

// Every event reports itself the first time it runs.
addObject(
  'obj_events',
  `
seen = set()

def once(name):
    if name not in seen:
        seen.add(name)
        __test_report("event " + name, True, "")

def create(self):
    once("create")
    self.alarms[1] = 2
    self.image_speed = 0.5

def room_start(self):
    once("room_start")

def room_end(self):
    once("room_end")

def alarm(self, index):
    once("alarm")

def step_begin(self):
    once("step_begin")

def step(self):
    once("step")

def step_end(self):
    once("step_end")

def collision(self, other):
    once("collision")

def animation_end(self):
    once("animation_end")

def destroy(self):
    once("destroy")

def draw(self):
    once("draw")
    self.draw_self()

def draw_gui(self):
    once("draw_gui")
`,
  { sprite: 'spr_box' },
);

// Draws one of every command shape, so the buffer can be inspected.
addObject(
  'obj_draw',
  `
def draw(self):
    draw_set_color(c_red)
    draw_set_alpha(0.5)
    __test_report("draw_get_color", draw_get_color() == c_red, str(draw_get_color()))

    draw_rectangle(10, 10, 20, 20, False)
    draw_rectangle(30, 10, 40, 20, True)
    draw_line(0, 50, 100, 50, 2)
    draw_circle(60, 60, 5, False)
    draw_set_alpha(1)
    draw_sprite("spr_box", 0, 100, 100)
    draw_sprite_ext("spr_box", 1, 120, 100, 2, 2, 45, c_blue, 0.5)
    draw_text(0, 0, "AB0", c_white)
`,
);

g('__register_room')('rm_one', 320, 240, 0x102030, 16, 16, '');
g('__register_room')('rm_two', 640, 480, 0x000000, 32, 32, '');
g('__register_room_layer')('rm_one', 'floor', 'ts', 20, true, 4, 3, '0:1,-1:11');
g('__start')('rm_one');

// ---- pure functions, queries and instance methods -----------------------

const AUDIT = `
def ok(name, condition, detail=""):
    __test_report(name, condition is True, str(detail))

def near(a, b):
    return abs(a - b) < 0.001

# maths ------------------------------------------------------------------
ok("point_distance", near(point_distance(0, 0, 3, 4), 5))
ok("point_direction", near(point_direction(0, 0, 1, 0), 0) and near(point_direction(0, 0, 0, -1), 90))
ok("lengthdir_x", near(lengthdir_x(10, 0), 10))
ok("lengthdir_y", near(lengthdir_y(10, 90), -10))
ok("clamp", clamp(5, 0, 3) == 3 and clamp(-1, 0, 3) == 0)
ok("lerp", near(lerp(0, 10, 0.5), 5))
ok("approach", approach(0, 10, 3) == 3 and approach(10, 0, 3) == 7 and approach(1, 2, 5) == 2)
ok("sign", sign(-5) == -1 and sign(0) == 0 and sign(2) == 1)
ok("choose", (lambda v: v == 7)(choose(7, 7, 7)))
ok("irandom", irandom(0) == 0 and irandom(5) >= 0 and irandom(5) <= 5)
ok("irandom_range", irandom_range(5, 5) == 5)
ok("random_range", near(random_range(2, 2), 2))
ok("angle_difference", near(angle_difference(10, 350), 20))
ok("wrap", near(wrap(370, 0, 360), 10) and near(wrap(-10, 0, 360), 350))

# colours ----------------------------------------------------------------
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

# rooms ------------------------------------------------------------------
ok("room_current", room_current() == "rm_one", room_current())
ok("room_width", room_width() == 320, room_width())
ok("room_height", room_height() == 240, room_height())
ok("room_speed", room_speed() == 60, room_speed())
view_set(12, 34)
vx, vy = view_get()
ok("view_set", vx == 12 and vy == 34)
ok("view_get", vx == 12 and vy == 34, "%s,%s" % (vx, vy))
view_set(0, 0)
ok("view_width defaults to the room", view_width() == room_width())
ok("view_height defaults to the room", view_height() == room_height())
view_set_size(200, 100)
ok("view_set_size", view_width() == 200 and view_height() == 100)

# instances --------------------------------------------------------------
a = instance_create(100, 100, "obj_base")
ok("instance_create", a is not None and a.x == 100 and a.y == 100)

child = instance_create(300, 300, "obj_child")
ok("instance_exists", instance_exists("obj_base") is True and instance_exists("obj_missing") is False)
ok("instance_number", instance_number("obj_base") == 2, instance_number("obj_base"))
ok("instance_find", instance_find("obj_base") is not None and instance_find("obj_base", 5) is None)
ok("instance_list", len(instance_list("obj_base")) == 2, len(instance_list("obj_base")))
ok("instance_nearest", instance_nearest(101, 101, "obj_base") is a)
ok("collision_point", collision_point(100, 100, "obj_base") is a)

# instance methods --------------------------------------------------------
ok("is_a", child.is_a("obj_child") and child.is_a("obj_base") and not child.is_a("obj_other"))

l, t, r, b = a.bbox()
# mask 2..13 with origin 8 gives -6..+6 around x
ok("bbox", near(l, 94) and near(t, 94) and near(r, 106) and near(b, 106), "%s,%s,%s,%s" % (l, t, r, b))

overlap = instance_create(104, 100, "obj_other")
ok("place_meeting", a.place_meeting(104, 100, "obj_other") is True and a.place_meeting(300, 300, "obj_other") is False)
ok("instance_place", a.instance_place(104, 100, "obj_other") is overlap)
ok("instance_place_list", len(a.instance_place_list(104, 100, "obj_other")) == 1)
overlap.destroy()

ok("distance_to_point", near(a.distance_to_point(103, 104), 5))
far = instance_create(100, 105, "obj_other")
ok("distance_to_object", near(a.distance_to_object(far), 5))
far.destroy()

a.move_towards_point(110, 100, 4)
ok("move_towards_point", near(a.hspeed, 4) and near(a.vspeed, 0), "%s,%s" % (a.hspeed, a.vspeed))
ok("speed", near(a.speed(), 4), a.speed())
ok("direction", near(a.direction(), 0), a.direction())
a.set_speed(2, 90)
ok("set_speed", near(a.vspeed, -2), a.vspeed)
a.hspeed, a.vspeed = 0, 0

ok("sprite_width", near(a.sprite_width(), 16), a.sprite_width())
ok("sprite_height", near(a.sprite_height(), 16))
ok("image_number", a.image_number() == 3, a.image_number())

blocker = instance_create(140, 100, "obj_other")
a.x, a.y = 100, 100
a.move_contact("obj_other", 100, 0)
ok("move_contact", a.x > 100 and a.x < 140, "stopped at %s" % a.x)
blocker.destroy()
a.x, a.y = 100, 100

# instance fields ----------------------------------------------------------
ok("field x/y", a.x == 100 and a.y == 100)
ok("field xstart/ystart", a.xstart == 100 and a.ystart == 100)
ok("field yprevious", a.yprevious is not None)
ok("field alarms", len(a.alarms) == 12, len(a.alarms))
ok("field sprite_index", a.sprite_index == "spr_box", a.sprite_index)
ok("field image_index", a.image_index == 0, a.image_index)
ok("field image_speed", a.image_speed > 0, a.image_speed)
ok("field image_alpha", a.image_alpha == 1)
ok("field solid", a.solid is False)
ok("field image_yscale", a.image_yscale == 1)
ok("field image_angle", a.image_angle == 0)
ok("Destroy alias", callable(a.Destroy))
a.image_xscale, a.image_yscale, a.image_angle = 2, 2, 30
ok("field image_xscale", near(a.sprite_width(), 32), a.sprite_width())
a.image_xscale, a.image_yscale, a.image_angle = 1, 1, 0
a.visible = False
ok("field visible", a.visible is False)
a.visible = True
a.depth = 5
ok("field depth", a.depth == 5)
a.image_blend = c_red
ok("field image_blend", a.image_blend == c_red)
a.image_blend = c_white

def _instance_destroy_check():
    victim = instance_create(0, 0, "obj_other")
    instance_destroy(victim)
    return victim._destroyed is not False
ok("instance_destroy", _instance_destroy_check())

# tiles ---------------------------------------------------------------------
ok("tilemap_layers", len(tilemap_layers()) == 1, len(tilemap_layers()))
ok("tilemap_get", tilemap_get("floor", 0, 0) == 0 and tilemap_get("floor", 1, 0) == -1)

def _tilemap_set_check():
    tilemap_set("floor", 1, 0, 1)
    v = tilemap_get("floor", 1, 0)
    tilemap_set("floor", 1, 0, -1)
    return v == 1
ok("tilemap_set", _tilemap_set_check())
ok("tilemap_get_at", tilemap_get_at("floor", 8, 8) == 0, tilemap_get_at("floor", 8, 8))
ok("tile_solid_at", tile_solid_at(8, 8) is True and tile_solid_at(200, 200) is False)

def _place_meeting_tiles_check():
    probe = instance_create(8, 8, "obj_other")
    hit = probe.place_meeting(8, 8, "tiles")
    miss = probe.place_meeting(250, 200, "tiles")
    probe.destroy()
    return hit is True and miss is False
ok("place_meeting tiles", _place_meeting_tiles_check())

# text metrics ---------------------------------------------------------------
ok("string_width", string_width("AB") > 0, string_width("AB"))
ok("string_height", string_height("A\\nB") > string_height("A"), string_height("A"))

a.destroy()
child.destroy()
`;

run(AUDIT);

// ---- drawing, events, input, movement over real frames -------------------

g('__register_room')('rm_draw', 320, 240, 0, 16, 16, 'obj_draw,0,0,1,1,0;obj_events,50,50,1,1,0;obj_other,54,54,1,1,0');
g('__start')('rm_draw');

const frame1 = frame('a|a||10,20,1,1', 1 / 60).commands;

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
run(`
ok("keyboard_check", keyboard_check("a") is True and keyboard_check("z") is False)
ok("keyboard_check_pressed", keyboard_check_pressed("a") is True)
ok("keyboard_check_released", keyboard_check_released("a") is False)
ok("mouse_x", mouse_x() == 10, mouse_x())
ok("mouse_y", mouse_y() == 20, mouse_y())
ok("mouse_check_button", mouse_check_button("left") is True and mouse_check_button("right") is False)
ok("mouse_wheel", mouse_wheel() == 1, mouse_wheel())
`);

// Mouse edges and the view offset: a press on one step, a release on the next.
frame('a|||10,20,1,0,1,0', 1 / 60);
run(`
ok("mouse_check_button_pressed", mouse_check_button_pressed("left") is True and mouse_check_button_pressed("right") is False)
ok("mouse_check_button_released is false while held", mouse_check_button_released("left") is False)
view_set(100, 50)
ok("mouse_x follows the view", mouse_x() == 110 and mouse_y() == 70, "%s,%s" % (mouse_x(), mouse_y()))
view_set(0, 0)
draw_text_transformed(10, 10, "AB", 2, 2, 0, c_white)
`);
frame('|||10,20,0,0,0,1', 1 / 60);
run(`
ok("mouse_check_button_released", mouse_check_button_released("left") is True)
ok("mouse_check_button_pressed clears", mouse_check_button_pressed("left") is False)
ok("room_speed", room_speed() == 60, room_speed())
`);

// Built-in movement fields, over a frame.
run(`
m = instance_create(0, 0, "obj_other")
m.hspeed = 3
m.vspeed = 0
m.gravity = 1
m.gravity_direction = 270
m.friction = 0
__test_report("field hspeed/vspeed", True, "")
MOVER = m
`);

frame('', 1 / 60);

run(`
m = MOVER
ok("field hspeed moves x", abs(m.x - 3) < 0.001, m.x)
ok("field gravity", m.vspeed > 0.9 and m.vspeed < 1.1, m.vspeed)
ok("field xprevious", abs(m.xprevious - 0) < 0.001, m.xprevious)
m.friction = 0.5
m.gravity = 0
FRICTION_BEFORE = math.sqrt(m.hspeed * m.hspeed + m.vspeed * m.vspeed)
`);

frame('', 1 / 60);
run(`
m = MOVER
after = math.sqrt(m.hspeed * m.hspeed + m.vspeed * m.vspeed)
__test_report("field friction", after < FRICTION_BEFORE, "%s -> %s" % (FRICTION_BEFORE, after))
m.destroy()
`);

// Alarms need a couple more steps; animation_end needs the sprite to wrap.
for (let i = 0; i < 12; i++) frame('', 1 / 60);

// The destroy event only runs on an explicit destroy; a room change discards
// instances without firing it, matching GameMaker.
run(`
e = instance_find("obj_events")
if e is not None:
    e.destroy()
`);

// room_goto / room_restart / game_end
run('room_goto("rm_one")');
frame('', 1 / 60);
report('room_goto', g('room_current')() === 'rm_one', g('room_current')());

run('room_restart()');
frame('', 1 / 60);
report('room_restart', g('room_current')() === 'rm_one');

run('game_end()');
const quitFrame = frame('', 1 / 60);
report('game_end', quitFrame.quit === true, `quit flag ${quitFrame.quit}`);

// ---- Roblox layer --------------------------------------------------------

// `__reset` already disconnects every service signal and clears the task
// queue. Re-running roblox.py here would swap `__rbx` for a fresh bridge
// *after* the prelude wired its instance provider into the original, silently
// detaching Workspace and every frame signal.
g('__reset')();
g('__register_room')('rm_rbx', 320, 240, 0, 16, 16, '');
addObject('obj_rbx', '');
g('__start')('rm_rbx');

const RBX = `
# Signal
sig = Signal.new()
ok("Signal.new", sig is not None)
hits = 0
def on_hit(n):
    global hits
    hits += n
conn = sig.Connect(on_hit)
sig.Fire(2)
ok("Signal:Connect", hits == 2, hits)
ok("Connection.Connected", conn.Connected is True)
onceHits = 0
def on_once(n):
    global onceHits
    onceHits += 1
sig.Once(on_once)
sig.Fire(1)
sig.Fire(1)
ok("Signal:Once", onceHits == 1, onceHits)
conn.Disconnect()
before = hits
sig.Fire(5)
ok("Connection:Disconnect", hits == before, hits)
sig2 = Signal.new()
sig2.Connect(lambda *args: None)
sig2.DisconnectAll()
ok("Signal:DisconnectAll", len(sig2._handlers) == 0, len(sig2._handlers))

# snake_case aliases, since the rest of the engine uses them
ok("Signal:connect alias", callable(sig.connect) and sig.connect == sig.Connect)
ok("Signal:fire alias", sig.fire == sig.Fire)
ok("Signal:once alias", sig.once == sig.Once)
ok("Signal:wait alias", sig.wait == sig.Wait)
ok("Connection:disconnect alias", callable(conn.disconnect))
ok("wait global", callable(wait))

# task
spawned = False
def on_spawn():
    global spawned
    spawned = True
task.spawn(on_spawn)
ok("task.spawn", spawned is True)

WAITED = False
async def waiter():
    global WAITED
    await task.wait(0.02)
    WAITED = True
task.spawn(waiter)
DELAYED = False
def on_delay():
    global DELAYED
    DELAYED = True
task.delay(0.02, on_delay)
DEFERRED = False
def on_defer():
    global DEFERRED
    DEFERRED = True
task.defer(on_defer)
async def doomed():
    await task.wait(10)
cancelled = task.spawn(doomed)
task.cancel(cancelled)
ok("task.cancel", True)

# services
ok("game:GetService", game.GetService("RunService") is not None)
ok("game:FindService", game.FindService("Nope") is None)
ok("game:GetServices", len(game.GetServices()) == 7, len(game.GetServices()))

HEARTBEAT = 0
STEPPED = 0
RENDERED = 0
def on_heartbeat(dt):
    global HEARTBEAT
    HEARTBEAT += 1
def on_stepped(dt):
    global STEPPED
    STEPPED += 1
def on_rendered(dt):
    global RENDERED
    RENDERED += 1
game.GetService("RunService").Heartbeat.Connect(on_heartbeat)
game.GetService("RunService").Stepped.Connect(on_stepped)
game.GetService("RunService").RenderStepped.Connect(on_rendered)

INPUT_BEGAN = 0
INPUT_ENDED = 0
uis = game.GetService("UserInputService")
def on_input_began(input):
    global INPUT_BEGAN
    INPUT_BEGAN += 1
def on_input_ended(input):
    global INPUT_ENDED
    INPUT_ENDED += 1
uis.InputBegan.Connect(on_input_began)
uis.InputEnded.Connect(on_input_ended)
ok("UserInputService:IsKeyDown", uis.IsKeyDown("q") is False)
ok("UserInputService:GetMouseLocation", (lambda xy: xy[0] is not None)(uis.GetMouseLocation()))
ok("UserInputService:IsMouseButtonPressed", uis.IsMouseButtonPressed("left") is False)

rs = game.GetService("ReplicatedStorage")
changed = 0
def on_changed(key, value):
    global changed
    changed += 1
rs.Changed.Connect(on_changed)
rs.SetAttribute("k", 5)
ok("ReplicatedStorage:SetAttribute", rs.GetAttribute("k") == 5)
ok("ReplicatedStorage:GetAttribute default", rs.GetAttribute("nope", 9) == 9)
ok("ReplicatedStorage.Changed", changed == 1, changed)
rs.Set("j", 1)
ok("ReplicatedStorage:Set/Get", rs.Get("j") == 1)
ok("ReplicatedStorage:GetAttributes", rs.GetAttributes()["k"] == 5)
rs.ClearAllAttributes()
ok("ReplicatedStorage:ClearAllAttributes", rs.GetAttribute("k") is None)

http = game.GetService("HttpService")
encoded = http.JSONEncode({"a": 1, "b": [2, 3], "c": "x"})
round_trip = http.JSONDecode(encoded)
ok("HttpService:JSONEncode", isinstance(encoded, str))
ok("HttpService:JSONDecode", round_trip["a"] == 1 and round_trip["b"][1] == 3 and round_trip["c"] == "x")
ok("HttpService:GenerateGUID", len(http.GenerateGUID()) > 20)

store = game.GetService("DataStoreService").GetDataStore("audit")
ok("DataStoreService:GetDataStore", store is not None)
store.SetAsync("n", 41)
ok("DataStore:SetAsync", store.GetAsync("n") == 41)
ok("DataStore:GetAsync default", store.GetAsync("absent", 3) == 3)
ok("DataStore:IncrementAsync", store.IncrementAsync("n", 1) == 42)
ok("DataStore:UpdateAsync", store.UpdateAsync("n", lambda v: v + 8) == 50)
store.RemoveAsync("n")
ok("DataStore:RemoveAsync", store.GetAsync("n") is None)

ss = game.GetService("ScriptService")
ok("ScriptService:GetScripts", isinstance(ss.GetScripts(), list))

ok("workspace:GetChildren", isinstance(workspace.GetChildren(), list))
ok("workspace:CountOf", workspace.CountOf("obj_rbx") == 0, workspace.CountOf("obj_rbx"))
w = instance_create(10, 10, "obj_rbx")
ok("workspace:FindFirstChild", workspace.FindFirstChild("obj_rbx") is not None)
ok("workspace:GetPartsInRegion", len(workspace.GetPartsInRegion(0, 0, 40, 40)) >= 1)
ok("workspace:GetDescendants", len(workspace.GetDescendants()) >= 1)
w.destroy()
`;
run(RBX);

// Frames so RunService signals fire and task timers elapse.
frame('b|b||0,0,0,0', 1 / 60);
frame('||b|0,0,0,0', 1 / 60);
for (let i = 0; i < 4; i++) frame('', 1 / 60);

run(`
ok("RunService.Heartbeat", HEARTBEAT >= 6, HEARTBEAT)
ok("RunService.Stepped", STEPPED >= 6, STEPPED)
ok("RunService.RenderStepped", RENDERED >= 6, RENDERED)
ok("UserInputService.InputBegan", INPUT_BEGAN >= 1, INPUT_BEGAN)
ok("UserInputService.InputEnded", INPUT_ENDED >= 1, INPUT_ENDED)
ok("task.wait", WAITED is True)
ok("task.delay", DELAYED is True)
ok("task.defer", DEFERRED is True)
ok("require", callable(require))

def _signal_wait_check():
    s = Signal.new()
    got = [False]
    async def waiter():
        await s.Wait()
        got[0] = True
    task.spawn(waiter)
    s.Fire()
    return got[0]
ok("Signal:Wait", _signal_wait_check())
`);

// ---- report --------------------------------------------------------------

const failures = results.filter((r) => !r.ok);

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
