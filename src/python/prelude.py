"""
Benseditor runtime prelude.

This file *is* the engine's game API. Everything a game script can call is
defined here, in Python, on purpose: a call from Python out to JavaScript
costs around 20 microseconds, so a 300-sprite draw event built from JS
callbacks would eat a good part of the 16.6 ms frame budget.

Instead the boundary is crossed exactly once per frame. The host calls
`__frame_packed(input, dt)`; everything -- events, movement, collision,
drawing -- runs here, and the frame's draw commands come back inside a single
string, base64 encoded. Base64 rather than raw bytes because the host string
channel is UTF-8 decoded, which silently destroys any byte above 127.

This is a function-for-function mirror of `src/luau/prelude.luau`: the same
sections in the same order, the same names, the same numbers out. Where Luau
says `local function`, Python says `def _name`; where Luau builds a table
literal, Python builds a dict. Object scripts are plain modules whose events
are module-level functions -- `def step(self):` -- exec'd against `__API`,
the snapshot of this file's public globals made at the bottom.
"""

import math
import random

import struct as _struct
import ubinascii as _binascii

# `__rbx` is the bridge roblox.py exposes; the alias keeps it out of class
# bodies, where a double-underscore name would be mangled by CPython.
_rbx = __rbx

# =============================================================================
# draw command protocol (must match src/engine/protocol.ts)
# =============================================================================

_CMD_SPRITE = 0
_CMD_RECT = 1
_CMD_LINE = 2
_CMD_CIRCLE = 3
_CMD_LAYER = 4

_RECORD_FLOATS = 12
_MAX_COMMANDS = 8192

# Twelve little-endian f32s per record. Spelled out rather than "<12f": the
# repeat-count form costs almost twice as much to parse per call.
_RECORD_FORMAT = "<ffffffffffff"
_RECORD_BYTES = _RECORD_FLOATS * 4

_raw = bytearray(_MAX_COMMANDS * _RECORD_BYTES)
_pack_into = _struct.pack_into
_b2a_base64 = _binascii.b2a_base64

_write_offset = 0
_command_count = 0


def _emit(kind, p1, p2, p3, p4, p5, p6, r, g, b, a):
    global _write_offset, _command_count
    if _command_count >= _MAX_COMMANDS:
        return
    _pack_into(_RECORD_FORMAT, _raw, _write_offset, kind, p1, p2, p3, p4, p5, p6, r, g, b, a, 0)
    _write_offset += _RECORD_BYTES
    _command_count += 1


def _flush_base64():
    """Encodes the frame's commands as base64. Every output byte is ASCII, so
    the string survives the host's UTF-8 decode intact. Records are 48 bytes,
    a multiple of three, so the output never needs padding."""
    return str(_b2a_base64(memoryview(_raw)[:_write_offset], newline=False), "ascii")


# =============================================================================
# colours
# =============================================================================

c_black = 0x000000
c_white = 0xFFFFFF
c_red = 0xFF004D
c_green = 0x00E436
c_blue = 0x29ADFF
c_yellow = 0xFFEC27
c_orange = 0xFFA300
c_purple = 0x83769C
c_gray = 0x5F574F
c_grey = c_gray


def _unpack_color(color):
    return (color // 65536) % 256 / 255, (color // 256) % 256 / 255, color % 256 / 255


# =============================================================================
# asset registry, populated by the host at load time
# =============================================================================

_sprites = {}
_tilesets = {}
_objects = {}
_rooms = {}
_glyphs = {}

_font_line_height = 12

# The twelve events an object script can define, as module-level functions.
_EVENTS = (
    "create", "destroy", "room_start", "room_end", "alarm",
    "step_begin", "step", "step_end", "collision", "animation_end", "draw", "draw_gui",
)

# Every event at least one registered object defines. A frame phase whose
# event nobody defines skips its loop over the instances entirely.
_defined_events = set()


def _tonumber(text):
    """Luau's tonumber for packed fields: an int when the text is one, else a
    float, else None."""
    try:
        return int(text)
    except ValueError:
        try:
            return float(text)
        except ValueError:
            return None


def _field(fields, index, default):
    """Numeric field `index` of a packed entry, or `default` if absent or unparsable."""
    if index >= len(fields):
        return default
    value = _tonumber(fields[index])
    return default if value is None else value


def _optional_name(value):
    """A host-side string that may arrive as null or undefined."""
    return value if isinstance(value, str) else None


def __register_sprite(
    name, first_atlas_id, frame_count, width, height,
    origin_x, origin_y, fps, col_left, col_top, col_right, col_bottom
):
    """Registered once per sprite. `first_atlas_id` + frame index addresses a frame."""
    _sprites[name] = {
        "name": name,
        "first": first_atlas_id,
        "frames": frame_count,
        "width": width,
        "height": height,
        "origin_x": origin_x,
        "origin_y": origin_y,
        "fps": fps,
        "col_left": col_left,
        "col_top": col_top,
        "col_right": col_right,
        "col_bottom": col_bottom,
    }


def __register_tileset(name, first_atlas_id, tile_width, tile_height, columns, rows, solid_packed):
    """`solid_packed` is a string of 0/1, one per tile, row-major."""
    count = columns * rows
    solid = [False] * count
    for index in range(min(len(solid_packed), count)):
        solid[index] = solid_packed[index] == "1"

    _tilesets[name] = {
        "name": name,
        "first": first_atlas_id,
        "tile_width": tile_width,
        "tile_height": tile_height,
        "columns": columns,
        "rows": rows,
        "count": count,
        "solid": solid,
    }


def _decode_tiles(packed, length):
    """Expand `index:count,index:count,...` back into a flat tile list."""
    tiles = [-1] * length
    if packed == "":
        return tiles

    at = 0
    for run in packed.split(","):
        parts = run.split(":")
        value = _field(parts, 0, -1)
        count = _field(parts, 1, 0)
        for _ in range(int(count)):
            if at >= length:
                break
            tiles[at] = value
            at += 1

    return tiles


def __register_room_layer(room_name, id, tileset_name, depth, visible, columns, rows, packed, buffer_index=None):
    """Tile layers belong to a room and are registered after it.
    `buffer_index` addresses the host's pre-built GPU geometry for this layer,
    or -1 if the layer is too large to keep static and must be streamed."""
    room = _rooms.get(room_name)
    if room is None:
        return

    room["layers"].append({
        "id": id,
        "tileset": tileset_name,
        "depth": depth,
        "visible": visible,
        "columns": columns,
        "rows": rows,
        "tiles": _decode_tiles(packed, columns * rows),
        # Absent means "no static geometry", so the layer streams its tiles.
        "buffer": buffer_index if isinstance(buffer_index, int) else -1,
        # Set by tilemap_set: once edited, the host's copy is stale and the
        # layer goes back to being sent tile by tile.
        "dirty": False,
    })


def __register_object(name, source, sprite_name, depth, visible, solid, persistent, parent, blocked_packed):
    """`source` is the object's script. It is compiled here under its own file
    name, so a traceback reads `File "obj_player.py", line 12`, and exec'd
    against a copy of the engine API; its module-level functions are the
    events. `blocked_packed` is a comma-joined list of object names this object
    cannot move into; the special entry "tiles" means solid tiles."""
    module = dict(__API)
    exec(compile(source, name + ".py", "exec"), module)

    # The events are the functions the script itself defined -- a `draw`
    # leaked in from a shared script is not this object's draw event, just as
    # a Luau script global is not a field of the object's returned table.
    events = {}
    for event in _EVENTS:
        handler = module.get(event)
        if handler is not None and not (event in __API and __API[event] is handler):
            events[event] = handler
            _defined_events.add(event)

    blocked_by = None
    if isinstance(blocked_packed, str) and blocked_packed != "":
        blocked_by = [target for target in blocked_packed.split(",") if target != ""]

    _objects[name] = {
        "name": name,
        "module": module,
        "events": events,
        "sprite": _optional_name(sprite_name),
        "depth": depth,
        "visible": visible,
        "solid": solid,
        "persistent": persistent,
        "parent": _optional_name(parent),
        "blocked_by": blocked_by,
        # Object names this one is_a, built on first query -- a parent may be
        # registered after its child, so it cannot be built here.
        "ancestors": None,
    }
    for other in _objects.values():
        other["ancestors"] = None


def __register_room(name, width, height, background, grid_w, grid_h, packed):
    """Instances arrive as one packed string so a big room costs one crossing:
    `object,x,y,xscale,yscale,angle,name;object,x,y,...`
    The seventh field, the instance's name, is optional: rooms written before
    it existed pack six."""
    placements = []

    if packed != "":
        for entry in packed.split(";"):
            if entry != "":
                f = entry.split(",")
                placements.append({
                    "object": f[0],
                    "x": _field(f, 1, 0),
                    "y": _field(f, 2, 0),
                    "xscale": _field(f, 3, 1),
                    "yscale": _field(f, 4, 1),
                    "angle": _field(f, 5, 0),
                    "name": f[6] if len(f) > 6 and f[6] != "" else None,
                })

    _rooms[name] = {
        "name": name,
        "width": width,
        "height": height,
        "background": background,
        "grid_w": grid_w,
        "grid_h": grid_h,
        "placements": placements,
        "layers": [],
    }


def __register_font(line_height, packed):
    """Font metrics, packed as `charCode,atlasId,advance,width,height;...`
    Each glyph is stored as (atlas, advance, width, height)."""
    global _font_line_height
    _font_line_height = line_height
    for entry in packed.split(";"):
        if entry != "":
            f = entry.split(",")
            _glyphs[int(f[0])] = (_tonumber(f[1]), _tonumber(f[2]), _tonumber(f[3]), _tonumber(f[4]))


# =============================================================================
# input, refreshed once per frame from the host
# =============================================================================

_held = set()
_pressed = set()
_released = set()

_mouse_state = {
    "x": 0,
    "y": 0,
    "left": False,
    "right": False,
    "middle": False,
    "wheel": 0,
    # Buttons that went down / came up this step, as bit masks.
    "pressed_mask": 0,
    "released_mask": 0,
}
_BUTTON_BITS = {"left": 1, "right": 2, "middle": 4}


def _parse_key_set(text, into):
    into.clear()
    if text == "":
        return
    for key in text.split(","):
        if key != "":
            into.add(key)


def _apply_input(input):
    """`held|pressed|released|mouseX,mouseY,buttonMask,wheel,pressedMask,releasedMask`
    (the last two are optional; older hosts send four mouse fields)"""
    parts = input.split("|")
    count = len(parts)
    _parse_key_set(parts[0] if count > 0 else "", _held)
    _parse_key_set(parts[1] if count > 1 else "", _pressed)
    _parse_key_set(parts[2] if count > 2 else "", _released)

    m = (parts[3] if count > 3 else "").split(",")
    mouse = _mouse_state
    mouse["x"] = _field(m, 0, 0)
    mouse["y"] = _field(m, 1, 0)
    mask = _field(m, 2, 0)
    mouse["left"] = mask % 2 >= 1
    mouse["right"] = (mask // 2) % 2 >= 1
    mouse["middle"] = (mask // 4) % 2 >= 1
    mouse["wheel"] = _field(m, 3, 0)
    mouse["pressed_mask"] = _field(m, 4, 0)
    mouse["released_mask"] = _field(m, 5, 0)


def keyboard_check(key):
    return key in _held


def keyboard_check_pressed(key):
    return key in _pressed


def keyboard_check_released(key):
    return key in _released


def mouse_check_button(button=None):
    return _mouse_state.get(button or "left") is True


def _button_in_mask(mask, button):
    bit = _BUTTON_BITS.get(button or "left")
    if not bit:
        return False
    return (int(mask) // bit) % 2 >= 1


def mouse_check_button_pressed(button=None):
    return _button_in_mask(_mouse_state["pressed_mask"], button)


def mouse_check_button_released(button=None):
    return _button_in_mask(_mouse_state["released_mask"], button)


# Room coordinates: the host measures the mouse against the view, and the
# view's offset is added here, so the value compares with instance x/y.
def mouse_x():
    return _mouse_state["x"] + _view_x


def mouse_y():
    return _mouse_state["y"] + _view_y


def mouse_wheel():
    return _mouse_state["wheel"]


# =============================================================================
# maths helpers
# =============================================================================


def point_distance(x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    return math.sqrt(dx * dx + dy * dy)


def point_direction(x1, y1, x2, y2):
    """Degrees counter-clockwise, 0 = right, matching GameMaker."""
    return math.degrees(math.atan2(-(y2 - y1), x2 - x1)) % 360


def lengthdir_x(length, direction):
    return math.cos(math.radians(direction)) * length


def lengthdir_y(length, direction):
    return -math.sin(math.radians(direction)) * length


def clamp(value, low, high):
    return max(low, min(high, value))


def lerp(a, b, amount):
    return a + (b - a) * amount


def approach(value, target, amount):
    if value < target:
        return min(value + amount, target)
    return max(value - amount, target)


def sign(value):
    if value > 0:
        return 1
    elif value < 0:
        return -1
    return 0


def choose(*options):
    return random.choice(options)


def irandom(maximum):
    return random.randint(0, maximum)


def irandom_range(low, high):
    return random.randint(low, high)


def random_range(low, high):
    return low + random.random() * (high - low)


def angle_difference(a, b):
    return (a - b + 180) % 360 - 180


def wrap(value, low, high):
    span = high - low
    if span <= 0:
        return low
    return low + (value - low) % span


# =============================================================================
# instances
# =============================================================================

_ALARM_COUNT = 12

# Live instances in creation order, which is also id order. Destroyed
# instances stay in the list, flagged, until the next collect point.
_instances = []
_ordered = []
_order_dirty = True
_next_id = 1
_pending_destroy = []

_current_room = None
_room_width_value = 0
_room_height_value = 0
_view_x, _view_y = 0, 0
# The visible area's size; the room's size unless a game asks for a window.
_view_width_value, _view_height_value = 0, 0
_room_change_request = None
_quit_requested = False

# Signals every instance can expose, created on first access.
#
# Allocating a Signal per instance up front would cost more than the whole
# step loop for a room full of walls, so `__getattr__` -- reached only when
# the attribute is missing -- makes them lazily and caches the result on the
# instance itself.
SIGNAL_FIELDS = ("Destroying", "Collided")

# Roblox-style properties resolved by the class rather than stored under that
# name: `Parent` reads and writes the tree, `Name` aliases `name`.
PROPERTY_FIELDS = ("Parent", "Name", "depth")


class _Alarms:
    """The twelve alarm slots, 1-based as the manual says: `self.alarms[2] = 60`.
    Index 0 is unused. Tracks whether any slot is set so the frame can skip
    the instances -- nearly all of them -- with nothing counting down."""

    def __init__(self):
        self._slots = [-1] * (_ALARM_COUNT + 1)
        self._active = False

    def __getitem__(self, index):
        return self._slots[index]

    def __setitem__(self, index, value):
        self._slots[index] = value
        if value >= 0:
            self._active = True

    def __len__(self):
        return _ALARM_COUNT


def _object_is_a(object_name, wanted):
    def_ = _objects.get(object_name)
    if def_ is None:
        return object_name == wanted
    ancestors = def_["ancestors"]
    if ancestors is None:
        ancestors = _ancestors(def_)
    return wanted in ancestors


def _ancestors(def_):
    """The object's own name and every parent up the chain -- the names
    `object_is_a` would accept -- walked with the same 32-hop guard."""
    names = set()
    current = def_["name"]
    guard = 0
    while current is not None and guard < 32:
        names.add(current)
        parent = _objects.get(current)
        current = parent["parent"] if parent else None
        guard += 1
    def_["ancestors"] = names
    return names


def _box_at(inst, x, y):
    """The instance's collision box if it stood at (x, y), without moving it."""
    sprite = _sprites.get(inst.sprite_index)
    if sprite is None:
        return x - 1, y - 1, x + 1, y + 1

    xscale = inst.image_xscale
    yscale = inst.image_yscale
    x1 = x + (sprite["col_left"] - sprite["origin_x"]) * xscale
    x2 = x + (sprite["col_right"] + 1 - sprite["origin_x"]) * xscale
    y1 = y + (sprite["col_top"] - sprite["origin_y"]) * yscale
    y2 = y + (sprite["col_bottom"] + 1 - sprite["origin_y"]) * yscale

    return min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2)


def _boxes_overlap(al, at, ar, ab, bl, bt, br, bb):
    return al < br and bl < ar and at < bb and bt < ab


class Instance:
    """A live instance. The Luau version is a table with a metatable; here the
    built-in fields are set in `__init__`, the methods are ordinary methods,
    and the same lazy signals and tree properties hang off the class."""

    def __init__(self, def_, id, x, y, name=None):
        sprite = _sprites.get(def_["sprite"]) if def_["sprite"] else None

        self._id = id
        self._object = def_["name"]
        self._def = def_
        self._events = def_["events"]
        self._destroyed = False
        self._parent = None
        self._children = None
        # The lazily created signals, mirrored here so the frame can test for
        # them without creating them (Luau's rawget).
        self._destroying = None
        self._collided = None

        self.name = name if name is not None else def_["name"]
        self.x = x
        self.y = y
        self.xstart = x
        self.ystart = y
        self.xprevious = x
        self.yprevious = y

        self.hspeed = 0
        self.vspeed = 0
        self.gravity = 0
        self.gravity_direction = 270
        self.friction = 0

        self.sprite_index = def_["sprite"]
        self.image_index = 0
        # Default to the sprite's authored frame rate.
        self.image_speed = sprite["fps"] / 60 if sprite else 0
        self.image_xscale = 1
        self.image_yscale = 1
        self.image_angle = 0
        self.image_alpha = 1
        self.image_blend = 0xFFFFFF

        self.visible = def_["visible"]
        self.solid = def_["solid"]
        self._depth = def_["depth"]
        self.alarms = _Alarms()

    # Only keys missing from the instance reach here: the built-in fields are
    # all present from construction, so `self.x` never pays for this.
    def __getattr__(self, key):
        if key in SIGNAL_FIELDS:
            signal = _rbx.newSignal()
            setattr(self, key, signal)
            if key == "Destroying":
                self._destroying = signal
            else:
                self._collided = signal
            return signal
        if key.startswith("_"):
            raise AttributeError(key)
        raise AttributeError("'%s' instance has no attribute '%s'" % (self._object, key))

    def _get_parent(self):
        # A root instance's parent is the Workspace, as in Roblox.
        parent = self._parent
        return parent if parent is not None else Workspace

    def _set_parent_property(self, value):
        _set_parent(self, value)

    def _get_name(self):
        return self.name

    def _set_name(self, value):
        self.name = value

    Parent = property(_get_parent, _set_parent_property)
    Name = property(_get_name, _set_name)

    def _get_depth(self):
        return self._depth

    def _set_depth(self, value):
        # Assigning depth re-sorts the draw order before the next frame.
        global _order_dirty
        if value != self._depth:
            self._depth = value
            _order_dirty = True

    depth = property(_get_depth, _set_depth)

    def is_a(self, name):
        return _object_is_a(self._object, name)

    def destroy(self):
        if self._destroyed:
            return
        self._destroyed = True
        _pending_destroy.append(self)

        # Only fire if something ever connected; the shadow field avoids
        # creating the signal.
        destroying = self._destroying
        if destroying is not None:
            destroying.Fire(self)

        handler = self._events.get("destroy")
        if handler is not None:
            handler(self)

        # Children go with their parent, as in Roblox: the parent's own event and
        # signal run first, then each child's, depth first.
        children = self._children
        if children:
            for child in list(children):
                child.destroy()
        parent = self._parent
        if parent is not None:
            siblings = parent._children
            if siblings and self in siblings:
                siblings.remove(self)
            self._parent = None

    Destroy = destroy

    # -- the instance tree (see the section below) ---------------------------

    def get_children(self):
        """Live children of this instance, oldest first."""
        found = []
        children = self._children
        if children:
            for child in children:
                if not child._destroyed:
                    found.append(child)
        found.sort(key=_by_id)
        return found

    def get_descendants(self):
        """Every live instance below this one, parents before their children."""
        found = []

        def walk(node):
            for child in node.get_children():
                found.append(child)
                walk(child)

        walk(self)
        return found

    def find_first_child(self, name):
        """The first live child called `name`, or failing that the first child
        whose object is (or descends from) an object called `name`."""
        children = self.get_children()
        for child in children:
            if child.name == name:
                return child
        for child in children:
            if _object_is_a(child._object, name):
                return child
        return None

    GetChildren = get_children
    GetDescendants = get_descendants
    FindFirstChild = find_first_child

    def sprite_width(self):
        sprite = _sprites.get(self.sprite_index)
        return sprite["width"] * self.image_xscale if sprite else 0

    def sprite_height(self):
        sprite = _sprites.get(self.sprite_index)
        return sprite["height"] * self.image_yscale if sprite else 0

    def image_number(self):
        sprite = _sprites.get(self.sprite_index)
        return sprite["frames"] if sprite else 0

    def bbox(self):
        """Collision rectangle in room space: left, top, right, bottom."""
        return _box_at(self, self.x, self.y)

    def instance_place(self, x, y, target):
        al, at, ar, ab = _box_at(self, x, y)

        sprites = _sprites
        for other in _instances:
            if other is self or other._destroyed:
                continue
            ancestors = other._def["ancestors"]
            if ancestors is None:
                ancestors = _ancestors(other._def)
            if target not in ancestors:
                continue
            bl, bt, br, bb = _box_at(other, other.x, other.y)
            if al < br and bl < ar and at < bb and bt < ab:
                return other
        return None

    def instance_place_list(self, x, y, target):
        """Every instance of `target` overlapping this one when moved to (x, y)."""
        al, at, ar, ab = _box_at(self, x, y)

        found = []
        for other in _instances:
            if other is self or other._destroyed:
                continue
            ancestors = other._def["ancestors"]
            if ancestors is None:
                ancestors = _ancestors(other._def)
            if target not in ancestors:
                continue
            bl, bt, br, bb = _box_at(other, other.x, other.y)
            if al < br and bl < ar and at < bb and bt < ab:
                found.append(other)
        return found

    def place_meeting(self, x, y, target):
        """`target` is an object name, or the string "tiles" for solid tile collision."""
        if target == "tiles":
            return _tiles_meeting(self, x, y)
        return self.instance_place(x, y, target) is not None

    def move_contact(self, target, dx, dy):
        """Step towards (dx, dy) a unit at a time, stopping just before a collision."""
        length = math.sqrt(dx * dx + dy * dy)
        if length == 0:
            return
        step_x, step_y = dx / length, dy / length
        for _ in range(math.ceil(length)):
            if self.place_meeting(self.x + step_x, self.y + step_y, target):
                return
            self.x += step_x
            self.y += step_y

    def move_towards_point(self, x, y, speed):
        angle = math.atan2(-(y - self.y), x - self.x)
        self.hspeed = math.cos(angle) * speed
        self.vspeed = -math.sin(angle) * speed

    def distance_to_point(self, x, y):
        return point_distance(self.x, self.y, x, y)

    def distance_to_object(self, other):
        return point_distance(self.x, self.y, other.x, other.y)

    def speed(self):
        return math.sqrt(self.hspeed * self.hspeed + self.vspeed * self.vspeed)

    def direction(self):
        if self.hspeed == 0 and self.vspeed == 0:
            return 0
        return math.degrees(math.atan2(-self.vspeed, self.hspeed)) % 360

    def set_speed(self, magnitude, direction):
        radians = math.radians(direction)
        self.hspeed = math.cos(radians) * magnitude
        self.vspeed = -math.sin(radians) * magnitude

    # -- drawing (see the section below) ---------------------------------------

    def draw_self(self):
        sprite = _sprites.get(self.sprite_index)
        if sprite is None:
            return
        frame = math.floor(self.image_index) % sprite["frames"]
        r, g, b = _unpack_color(self.image_blend)
        _emit(
            _CMD_SPRITE,
            sprite["first"] + frame,
            self.x,
            self.y,
            self.image_xscale,
            self.image_yscale,
            self.image_angle,
            r,
            g,
            b,
            self.image_alpha,
        )

    # -- instance lifecycle (see the section below) ----------------------------

    @staticmethod
    def new(object_name, parent=None):
        """The Roblox spelling of instance_create: `Instance.new("obj_coin", self)`.
        The parent is set before the create event runs, so `self.Parent` is
        already right inside it. Position defaults to the parent's, or 0,0."""
        x, y = 0, 0
        if _is_instance(parent):
            x, y = parent.x, parent.y
        inst = _make_instance(object_name, x, y)
        if parent is not None:
            _set_parent(inst, parent)
        _dispatch(inst, "create")
        return inst


# =============================================================================
# the instance tree
# =============================================================================
#
# Every instance is a root until game code parents it: `child.Parent = self`
# or `Instance.new("obj_x", self)`. Parenting is purely a naming and
# ownership structure -- it never moves anything -- so a world that never
# uses it is exactly the flat GameMaker world it always was. A parent takes
# its children with it when destroyed.


def _is_instance(value):
    return isinstance(value, Instance)


def _by_id(inst):
    return inst._id


def _set_parent(inst, parent):
    """Move `inst` under `parent`. None or the Workspace makes it a root again."""
    if parent is Workspace or parent is None:
        parent = None
    elif not _is_instance(parent):
        raise TypeError("Parent must be an instance or workspace, got " + type(parent).__name__)
    elif parent._destroyed:
        raise ValueError("Cannot parent to a destroyed instance")
    elif parent is inst:
        raise ValueError("An instance cannot be its own parent")
    else:
        # Walk up from the new parent; reaching `inst` would close a loop.
        node = parent
        guard = 0
        while node is not None and guard < 64:
            if node is inst:
                raise ValueError("Setting Parent would create a cycle")
            node = node._parent
            guard += 1

    previous = inst._parent
    if previous is parent:
        return
    if previous is not None:
        siblings = previous._children
        if siblings and inst in siblings:
            siblings.remove(inst)
    inst._parent = parent
    if parent is not None:
        children = parent._children
        if children is None:
            children = []
            parent._children = children
        children.append(inst)


# =============================================================================
# drawing
# =============================================================================

_draw_color = 0xFFFFFF
_draw_alpha = 1.0


def draw_set_color(color):
    global _draw_color
    _draw_color = color


def draw_get_color():
    return _draw_color


def draw_set_alpha(alpha):
    global _draw_alpha
    _draw_alpha = alpha


def draw_sprite_ext(sprite_name, index, x, y, xscale=None, yscale=None, angle=None, color=None, alpha=None):
    sprite = _sprites.get(sprite_name)
    if sprite is None:
        return
    frame = math.floor(index) % sprite["frames"]
    r, g, b = _unpack_color(0xFFFFFF if color is None else color)
    _emit(
        _CMD_SPRITE, sprite["first"] + frame, x, y,
        1 if xscale is None else xscale, 1 if yscale is None else yscale, 0 if angle is None else angle,
        r, g, b, 1 if alpha is None else alpha,
    )


def draw_sprite(sprite_name, index, x, y):
    draw_sprite_ext(sprite_name, index, x, y, 1, 1, 0, 0xFFFFFF, 1)


# `draw_self` lives on the Instance class above.


def draw_rectangle(x1, y1, x2, y2, outline=False):
    r, g, b = _unpack_color(_draw_color)
    _emit(_CMD_RECT, x1, y1, x2, y2, 1 if outline else 0, 1, r, g, b, _draw_alpha)


def draw_line(x1, y1, x2, y2, width=None):
    r, g, b = _unpack_color(_draw_color)
    _emit(_CMD_LINE, x1, y1, x2, y2, 1 if width is None else width, 0, r, g, b, _draw_alpha)


def draw_circle(x, y, radius, outline=False):
    r, g, b = _unpack_color(_draw_color)
    _emit(_CMD_CIRCLE, x, y, radius, 1 if outline else 0, 24, 0, r, g, b, _draw_alpha)


def draw_text(x, y, text, color=None):
    r, g, b = _unpack_color(_draw_color if color is None else color)
    alpha = _draw_alpha
    glyphs = _glyphs
    line_height = _font_line_height
    pen_x, pen_y = x, y

    # Bytes, as Luau's string.byte walks them.
    for code in str(text).encode("utf-8"):
        if code == 10:
            pen_x = x
            pen_y += line_height
            continue

        glyph = glyphs.get(code)
        if glyph is not None:
            _emit(_CMD_SPRITE, glyph[0], pen_x, pen_y, 1, 1, 0, r, g, b, alpha)
            pen_x += glyph[1]
        else:
            pen_x += line_height * 0.5


def draw_text_transformed(x, y, text, xscale=1, yscale=1, angle=0, color=None):
    """draw_text with scale and rotation: glyphs are sprites, so this costs the
    same as draw_text. NEAREST filtering keeps 2x-4x text crisp."""
    r, g, b = _unpack_color(_draw_color if color is None else color)
    alpha = _draw_alpha
    glyphs = _glyphs
    line_height = _font_line_height
    rad = math.radians(angle)
    cos_a, sin_a = math.cos(rad), math.sin(rad)
    pen_x = 0.0
    pen_y = 0.0

    for code in str(text).encode("utf-8"):
        if code == 10:
            pen_x = 0.0
            pen_y += line_height * yscale
            continue

        glyph = glyphs.get(code)
        if glyph is not None:
            # Rotate the pen offset the way the renderer rotates sprites (y down).
            gx = x + pen_x * cos_a + pen_y * sin_a
            gy = y - pen_x * sin_a + pen_y * cos_a
            _emit(_CMD_SPRITE, glyph[0], gx, gy, xscale, yscale, angle, r, g, b, alpha)
            pen_x += glyph[1] * xscale
        else:
            pen_x += line_height * 0.5 * xscale


def string_width(text):
    width, longest = 0, 0
    for code in str(text).encode("utf-8"):
        if code == 10:
            longest = max(longest, width)
            width = 0
        else:
            glyph = _glyphs.get(code)
            width += glyph[1] if glyph is not None else _font_line_height * 0.5
    return max(longest, width)


def string_height(text):
    return _font_line_height * len(str(text).split("\n"))


# =============================================================================
# instance lifecycle and queries
# =============================================================================


def _make_instance(object_name, x, y, name=None):
    global _next_id, _order_dirty
    def_ = _objects.get(object_name)
    if def_ is None:
        raise ValueError("instance_create: no object named '%s'" % object_name)

    inst = Instance(def_, _next_id, x, y, name)
    _next_id += 1

    _instances.append(inst)
    _order_dirty = True
    return inst


def _dispatch(inst, event):
    handler = inst._events.get(event)
    if handler is not None:
        handler(inst)


def _dispatch_with(inst, event, arg):
    handler = inst._events.get(event)
    if handler is not None:
        handler(inst, arg)


def instance_create(x, y, object_name):
    inst = _make_instance(object_name, x, y)
    _dispatch(inst, "create")
    return inst


# `Instance.new` lives on the Instance class above.


def instance_destroy(inst):
    inst.destroy()


def instance_exists(object_name):
    for inst in _instances:
        if not inst._destroyed and _object_is_a(inst._object, object_name):
            return True
    return False


def instance_number(object_name):
    count = 0
    for inst in _instances:
        if not inst._destroyed and _object_is_a(inst._object, object_name):
            count += 1
    return count


def instance_list(object_name):
    found = []
    for inst in _instances:
        if not inst._destroyed and _object_is_a(inst._object, object_name):
            found.append(inst)
    return found


def instance_find(object_name, index=None):
    found = instance_list(object_name)
    index = index or 0
    if 0 <= index < len(found):
        return found[index]
    return None


def instance_nearest(x, y, object_name):
    best, best_distance = None, math.inf
    for inst in _instances:
        if not inst._destroyed and _object_is_a(inst._object, object_name):
            distance = point_distance(x, y, inst.x, inst.y)
            if distance < best_distance:
                best, best_distance = inst, distance
    return best


def collision_point(x, y, object_name):
    for inst in _instances:
        if not inst._destroyed and _object_is_a(inst._object, object_name):
            l, t, r, b = inst.bbox()
            if x >= l and x <= r and y >= t and y <= b:
                return inst
    return None


# =============================================================================
# rooms
# =============================================================================


def room_current():
    return _current_room["name"] if _current_room else ""


def room_width():
    return _room_width_value


def room_height():
    return _room_height_value


_room_speed_value = 60


def room_speed():
    return _room_speed_value


def room_goto(name):
    global _room_change_request
    if name not in _rooms:
        raise ValueError("room_goto: no room named '%s'" % name)
    _room_change_request = name


def room_restart():
    global _room_change_request
    if _current_room:
        _room_change_request = _current_room["name"]


def game_end():
    global _quit_requested
    _quit_requested = True


def view_set(x, y):
    global _view_x, _view_y
    _view_x, _view_y = x, y


def view_get():
    return _view_x, _view_y


def view_set_size(width, height):
    """The size of the visible area. It resets to the room's size on entering a
    room, so a scrolling game sets it in room_start."""
    global _view_width_value, _view_height_value
    _view_width_value = max(1, int(math.floor(width)))
    _view_height_value = max(1, int(math.floor(height)))


def view_width():
    return _view_width_value


def view_height():
    return _view_height_value


def _enter_room(name):
    global _instances, _current_room, _room_width_value, _room_height_value
    global _view_x, _view_y, _view_width_value, _view_height_value, _order_dirty

    if _current_room:
        for inst in _instances:
            if not inst._destroyed:
                _dispatch(inst, "room_end")

    # Persistent instances survive the transition, as in GameMaker.
    survivors = []
    survivor_ids = set()
    for inst in _instances:
        if not inst._destroyed and inst._def["persistent"]:
            survivors.append(inst)
            survivor_ids.add(inst._id)
    # A survivor whose parent did not make it becomes a root, and drops any
    # children that did not either.
    for inst in survivors:
        parent = inst._parent
        if parent is not None and parent._id not in survivor_ids:
            inst._parent = None
        children = inst._children
        if children:
            for index in range(len(children) - 1, -1, -1):
                if children[index]._id not in survivor_ids:
                    del children[index]
    _instances = survivors
    _pending_destroy.clear()

    room = _rooms.get(name)
    if room is None:
        available = sorted(_rooms)
        if not available:
            raise RuntimeError("This project has no rooms. Create one before running.")
        raise ValueError(
            "No room named '%s'. The project's start room may have been renamed or deleted. "
            "Available rooms: %s" % (name, ", ".join(available))
        )

    _current_room = room
    # Descending depth, matching the instance order they are merged with.
    room["layers"].sort(key=_layer_depth_descending)
    _room_width_value = room["width"]
    _room_height_value = room["height"]
    _view_width_value = room["width"]
    _view_height_value = room["height"]
    _view_x, _view_y = 0, 0
    _order_dirty = True

    created = []
    for placement in room["placements"]:
        if placement["object"] in _objects:
            inst = _make_instance(placement["object"], placement["x"], placement["y"], placement["name"])
            inst.image_xscale = placement["xscale"]
            inst.image_yscale = placement["yscale"]
            inst.image_angle = placement["angle"]
            created.append(inst)

    for inst in created:
        _dispatch(inst, "create")
    for inst in _instances:
        if not inst._destroyed:
            _dispatch(inst, "room_start")


def _layer_depth_descending(layer):
    return -layer["depth"]


def __start(room_name, fps=60):
    """`fps` is the fixed step rate the host runs at; `room_speed()` reports it."""
    global _room_speed_value
    _room_speed_value = fps if fps else 60
    _enter_room(room_name)


class _Module:
    """What `require(name)` returns for a shared script: its globals, read
    live, so a function that reassigns one of them is seen by everyone."""

    def __init__(self, namespace):
        self._namespace = namespace

    def __getattr__(self, key):
        try:
            return self._namespace[key]
        except KeyError:
            raise AttributeError("module has no attribute '%s'" % key)


def __register_module(name, source):
    """Compile a shared `scripts/` module so `require(name)` can find it.

    Its public names also become globals for every object script loaded
    afterwards, the way a Luau script's globals leak into the shared
    environment."""
    namespace = dict(__API)
    exec(compile(source, name + ".py", "exec"), namespace)
    for key, value in namespace.items():
        if key.startswith("_"):
            continue
        if key in __API and __API[key] is value:
            continue
        __API[key] = value
    _rbx.registerModule(name, _Module(namespace))


def _live_instances(roots_only):
    """The Workspace reads through to the live instances: its children are the
    roots of the tree, its descendants everything alive. Already in id order."""
    live = []
    for inst in _instances:
        if not inst._destroyed and (not roots_only or inst._parent is None):
            live.append(inst)
    return live


class _InstanceProvider:
    def all(self):
        return _live_instances(False)

    def roots(self):
        return _live_instances(True)

    # By name first, then the original meaning: any instance of that object.
    def findFirst(self, name):
        for inst in _live_instances(True):
            if inst.name == name:
                return inst
        return instance_find(name)


_rbx.setInstanceProvider(_InstanceProvider())


def __reset():
    """Wipe every registered asset and all live state.

    The host reuses one interpreter for the whole session rather than building
    a new one per run, so this is what makes a re-run a clean slate."""
    global _instances, _next_id, _order_dirty
    global _current_room, _room_width_value, _room_height_value, _view_x, _view_y
    global _view_width_value, _view_height_value, _room_speed_value
    global _room_change_request, _quit_requested
    global _write_offset, _command_count, _draw_color, _draw_alpha
    global __API

    _rbx.reset()

    _sprites.clear()
    _tilesets.clear()
    _objects.clear()
    _rooms.clear()
    _glyphs.clear()
    _defined_events.clear()

    _instances = []
    _ordered.clear()
    _pending_destroy.clear()
    _next_id = 1
    _order_dirty = True

    _current_room = None
    _room_width_value = 0
    _room_height_value = 0
    _view_width_value, _view_height_value = 0, 0
    _view_x, _view_y = 0, 0
    _room_speed_value = 60
    _room_change_request = None
    _quit_requested = False

    _write_offset = 0
    _command_count = 0
    _draw_color = 0xFFFFFF
    _draw_alpha = 1.0

    _held.clear()
    _pressed.clear()
    _released.clear()

    # Shared scripts add their globals to the API; a fresh run starts clean.
    __API = dict(_API_BASE)


# =============================================================================
# tiles
# =============================================================================


def _find_layer(layer_id):
    if not _current_room:
        return None
    for layer in _current_room["layers"]:
        if layer["id"] == layer_id:
            return layer
    return None


def tilemap_get(layer_id, tile_x, tile_y):
    """Tile index at a tile coordinate, or -1 for empty / out of bounds."""
    layer = _find_layer(layer_id)
    if not layer or tile_x < 0 or tile_y < 0 or tile_x >= layer["columns"] or tile_y >= layer["rows"]:
        return -1
    return layer["tiles"][int(tile_y) * layer["columns"] + int(tile_x)]


def tilemap_set(layer_id, tile_x, tile_y, index):
    layer = _find_layer(layer_id)
    if not layer or tile_x < 0 or tile_y < 0 or tile_x >= layer["columns"] or tile_y >= layer["rows"]:
        return False
    layer["tiles"][int(tile_y) * layer["columns"] + int(tile_x)] = index
    # The host's static copy no longer matches, so stream this layer from now on.
    layer["dirty"] = True
    return True


def tilemap_get_at(layer_id, x, y):
    """Tile index at a room position, rather than a tile coordinate."""
    layer = _find_layer(layer_id)
    if not layer:
        return -1
    tileset = _tilesets.get(layer["tileset"])
    if not tileset:
        return -1
    return tilemap_get(layer_id, math.floor(x / tileset["tile_width"]), math.floor(y / tileset["tile_height"]))


def tilemap_layers():
    ids = []
    if _current_room:
        for layer in _current_room["layers"]:
            ids.append(layer["id"])
    return ids


def tile_solid_at(x, y):
    """True if any layer has a solid tile covering this point."""
    if not _current_room:
        return False
    for layer in _current_room["layers"]:
        tileset = _tilesets.get(layer["tileset"])
        if tileset:
            tx = math.floor(x / tileset["tile_width"])
            ty = math.floor(y / tileset["tile_height"])
            if tx >= 0 and ty >= 0 and tx < layer["columns"] and ty < layer["rows"]:
                index = layer["tiles"][ty * layer["columns"] + tx]
                if index >= 0 and index < tileset["count"] and tileset["solid"][index]:
                    return True
    return False


def _tiles_meeting(inst, x, y):
    """Whether an instance's collision box would overlap a solid tile at (x, y)."""
    room = _current_room
    if not room or not room["layers"]:
        return False

    left, top, right, bottom = _box_at(inst, x, y)
    floor = math.floor

    for layer in room["layers"]:
        tileset = _tilesets.get(layer["tileset"])
        if tileset:
            tile_width = tileset["tile_width"]
            tile_height = tileset["tile_height"]
            columns = layer["columns"]
            # The box is half-open, so nudge the far edge back inside it.
            x0 = max(0, floor(left / tile_width))
            x1 = min(columns - 1, floor((right - 0.0001) / tile_width))
            y0 = max(0, floor(top / tile_height))
            y1 = min(layer["rows"] - 1, floor((bottom - 0.0001) / tile_height))

            tiles = layer["tiles"]
            solid = tileset["solid"]
            count = tileset["count"]
            for ty in range(y0, y1 + 1):
                row = ty * columns
                for tx in range(x0, x1 + 1):
                    index = tiles[row + tx]
                    if index >= 0 and index < count and solid[index]:
                        return True

    return False


def _draw_layer(layer):
    """Draw one layer.

    An untouched layer is already on the GPU, so it costs a single marker
    command. Once `tilemap_set` edits it the host's copy is stale, and the tiles
    are streamed individually again, culled to the visible area."""
    if not layer["visible"]:
        return
    tileset = _tilesets.get(layer["tileset"])
    if not tileset:
        return

    if layer["buffer"] >= 0 and not layer["dirty"]:
        _emit(_CMD_LAYER, layer["buffer"], 0, 0, 0, 0, 0, 1, 1, 1, 1)
        return

    tw, th = tileset["tile_width"], tileset["tile_height"]
    columns = layer["columns"]
    floor = math.floor
    x0 = max(0, floor(_view_x / tw))
    y0 = max(0, floor(_view_y / th))
    x1 = min(columns - 1, floor((_view_x + _view_width_value - 1) / tw))
    y1 = min(layer["rows"] - 1, floor((_view_y + _view_height_value - 1) / th))

    tiles = layer["tiles"]
    first = tileset["first"]
    count = tileset["count"]
    emit = _emit
    for ty in range(y0, y1 + 1):
        row = ty * columns
        for tx in range(x0, x1 + 1):
            index = tiles[row + tx]
            if index >= 0 and index < count:
                emit(_CMD_SPRITE, first + index, tx * tw, ty * th, 1, 1, 0, 1, 1, 1, 1)


# =============================================================================
# the frame
# =============================================================================


def _collect_destroyed():
    global _instances, _order_dirty
    if not _pending_destroy:
        return
    _instances = [inst for inst in _instances if not inst._destroyed]
    _pending_destroy.clear()
    _order_dirty = True


def _for_each_live(event):
    if event in _defined_events:
        for inst in _instances:
            if not inst._destroyed:
                handler = inst._events.get(event)
                if handler is not None:
                    handler(inst)
    _collect_destroyed()


def _run_alarms():
    for inst in _instances:
        if inst._destroyed:
            continue
        alarms = inst.alarms
        if not alarms._active:
            continue
        # Cleared here and set again by any slot still counting, or by a handler
        # setting a new one while the loop runs.
        alarms._active = False
        slots = alarms._slots
        for index in range(1, _ALARM_COUNT + 1):
            value = slots[index]
            if value >= 0:
                value -= 1
                if value == 0:
                    slots[index] = -1
                    _dispatch_with(inst, "alarm", index)
                else:
                    slots[index] = value
                    alarms._active = True
    _collect_destroyed()


def _blocked_at(inst, x, y, blockers):
    """Would this instance overlap any of its blockers if it stood at (x, y)?"""
    for target in blockers:
        if target == "tiles":
            if _tiles_meeting(inst, x, y):
                return True
        elif inst.instance_place(x, y, target) is not None:
            return True
    return False


def _slide_to_contact(inst, blockers, dx, dy):
    """Slide one axis to contact with whatever blocks it. Mirrors move_contact,
    but against the whole blocker list at once."""
    length = abs(dx + dy)
    if length == 0:
        return
    step_x = dx / length
    step_y = dy / length
    for _ in range(math.ceil(length)):
        if _blocked_at(inst, inst.x + step_x, inst.y + step_y, blockers):
            return
        inst.x += step_x
        inst.y += step_y


def _apply_movement():
    cos = math.cos
    sin = math.sin
    sqrt = math.sqrt
    radians_of = math.radians

    for inst in _instances:
        if inst._destroyed:
            continue

        x = inst.x
        y = inst.y
        inst.xprevious = x
        inst.yprevious = y

        gravity = inst.gravity
        if gravity != 0:
            radians = radians_of(inst.gravity_direction)
            inst.hspeed += cos(radians) * gravity
            inst.vspeed -= sin(radians) * gravity

        friction = inst.friction
        if friction != 0:
            hspeed = inst.hspeed
            vspeed = inst.vspeed
            speed = sqrt(hspeed * hspeed + vspeed * vspeed)
            if speed > 0:
                scale = max(0, speed - friction) / speed
                inst.hspeed = hspeed * scale
                inst.vspeed = vspeed * scale

        blockers = inst._def["blocked_by"]

        if blockers is None:
            inst.x = x + inst.hspeed
            inst.y = y + inst.vspeed
            continue

        # One axis at a time, so pressing into a wall still slides along it.
        # A blocked axis walks to contact and stops; gravity would otherwise
        # accumulate vspeed forever against a floor.
        hspeed = inst.hspeed
        if hspeed != 0:
            if _blocked_at(inst, x + hspeed, y, blockers):
                _slide_to_contact(inst, blockers, hspeed, 0)
                inst.hspeed = 0
            else:
                inst.x = x + hspeed

        vspeed = inst.vspeed
        if vspeed != 0:
            x = inst.x
            if _blocked_at(inst, x, y + vspeed, blockers):
                _slide_to_contact(inst, blockers, 0, vspeed)
                inst.vspeed = 0
            else:
                inst.y = y + vspeed


def _run_collisions():
    # Only instances that actually handle collisions are tested -- either with a
    # `collision` event or a connection to their `Collided` signal.
    has_event = "collision" in _defined_events
    actors = []
    for inst in _instances:
        if inst._destroyed:
            continue
        if (has_event and inst._events.get("collision") is not None) or inst._collided is not None:
            actors.append(inst)
    if not actors:
        return

    for actor in actors:
        if actor._destroyed:
            continue
        al, at, ar, ab = _box_at(actor, actor.x, actor.y)
        for other in _instances:
            if other is actor or other._destroyed or actor._destroyed:
                continue
            bl, bt, br, bb = _box_at(other, other.x, other.y)
            if al < br and bl < ar and at < bb and bt < ab:
                handler = actor._events.get("collision")
                if handler is not None:
                    handler(actor, other)
                collided = actor._collided
                if collided is not None:
                    collided.Fire(other)
    _collect_destroyed()


def _advance_animation():
    sprites = _sprites
    for inst in _instances:
        if inst._destroyed or inst.image_speed == 0:
            continue
        sprite = sprites.get(inst.sprite_index)
        if not sprite or sprite["frames"] <= 1:
            continue

        index = inst.image_index + inst.image_speed
        frames = sprite["frames"]
        if index >= frames or index < 0:
            inst.image_index = index % frames
            _dispatch(inst, "animation_end")
        else:
            inst.image_index = index
    _collect_destroyed()


def _rebuild_order():
    """Larger depth draws further back; equal depths keep creation order.

    Bucketed by depth rather than sorted with a key: `_instances` is already
    in id order, and a keyed sort of a hundred instances costs milliseconds."""
    global _order_dirty
    groups = {}
    for inst in _instances:
        depth = inst._depth
        group = groups.get(depth)
        if group is None:
            groups[depth] = [inst]
        else:
            group.append(inst)
    _ordered.clear()
    for depth in sorted(groups, reverse=True):
        _ordered.extend(groups[depth])
    _order_dirty = False


def __frame_packed(input, dt=None):
    """Runs one whole game step and returns everything the host needs for it,
    as one string: `count;background;width;height;viewX;viewY;quit;payload`
    with the draw commands base64 encoded in the payload.

    This is the *only* call the host makes per frame. One string rather than a
    tuple, so the crossing creates no proxy objects."""
    global _write_offset, _command_count, _draw_color, _draw_alpha, _room_change_request

    delta = 1 / 60 if dt is None else dt
    _apply_input(input)

    # UserInputService mirrors this frame's key transitions.
    for key in _pressed:
        _rbx.fireInputBegan(key)
    for key in _released:
        _rbx.fireInputEnded(key)

    _rbx.stepScheduler(delta)
    _rbx.fireStepped(delta)

    _for_each_live("step_begin")
    _run_alarms()
    _for_each_live("step")
    _apply_movement()
    _run_collisions()
    _for_each_live("step_end")
    _advance_animation()

    _rbx.fireHeartbeat(delta)
    _collect_destroyed()

    if _order_dirty:
        _rebuild_order()

    _write_offset = 0
    _command_count = 0
    _draw_color = 0xFFFFFF
    _draw_alpha = 1.0

    _rbx.fireRenderStepped(delta)

    # Layers and instances are both sorted by descending depth, so walking them
    # together interleaves tiles and objects correctly without building a
    # combined list every frame.
    layers = _current_room["layers"] if _current_room else []
    layer_count = len(layers)
    next_layer = 0

    for inst in _ordered:
        if inst._destroyed:
            continue
        while next_layer < layer_count and layers[next_layer]["depth"] > inst._depth:
            _draw_layer(layers[next_layer])
            next_layer += 1

        handler = inst._events.get("draw")
        if handler is not None:
            handler(inst)
        elif inst.visible:
            inst.draw_self()

    while next_layer < layer_count:
        _draw_layer(layers[next_layer])
        next_layer += 1

    if "draw_gui" in _defined_events:
        for inst in _ordered:
            if inst._destroyed:
                continue
            handler = inst._events.get("draw_gui")
            if handler is not None:
                handler(inst)

    payload = _flush_base64()
    drawn = _command_count
    background = _current_room["background"] if _current_room else 0

    # Applied after drawing so the frame just rendered stays consistent.
    if _room_change_request is not None:
        target = _room_change_request
        _room_change_request = None
        _enter_room(target)

    return "%d;%s;%s;%s;%s;%s;%d;%s" % (
        drawn, background, _view_width_value, _view_height_value, _view_x, _view_y,
        1 if _quit_requested else 0, payload,
    )


def __frame_info():
    """Frame metadata the host needs but that does not belong in the draw buffer."""
    background = _current_room["background"] if _current_room else 0
    return _command_count, background, _view_width_value, _view_height_value, _view_x, _view_y, _quit_requested


# =============================================================================
# host handle
# =============================================================================

# Everything above is a real global in the interpreter's `__main__`, which is
# where the host runs this file, so it reads the `__` entry points straight
# back out of `globals`. Game scripts do not run there: each object and shared
# script is exec'd against its own copy of `__API`, the public surface of
# both engine files -- everything not starting with an underscore, including
# the `math` and `random` modules imported at the top.


def _build_api():
    api = {}
    for key, value in globals().items():
        if not key.startswith("_"):
            api[key] = value
    return api


_API_BASE = _build_api()
__API = dict(_API_BASE)
