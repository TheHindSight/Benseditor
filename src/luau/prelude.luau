--!nocheck
--[[
	Benseditor runtime prelude.

	This file *is* the engine's game API. Everything a game script can call is
	defined here, in Luau, on purpose: a call from Luau out to JavaScript costs
	roughly 90-160 microseconds, so a 300-sprite draw event built from JS
	callbacks would blow the entire 16.6 ms frame budget several times over.

	Instead the boundary is crossed exactly once per frame. The host calls
	`__frame(dt, input)`; everything -- events, movement, collision, drawing --
	runs here, and the frame's draw commands come back as a single base64
	string. Base64 rather than raw bytes because the host string channel is
	UTF-8 decoded, which silently destroys any byte above 127.
]]

--=============================================================================
-- draw command protocol (must match src/engine/protocol.ts)
--=============================================================================

local CMD_SPRITE = 0
local CMD_RECT = 1
local CMD_LINE = 2
local CMD_CIRCLE = 3
local CMD_LAYER = 4

local RECORD_FLOATS = 12
local MAX_COMMANDS = 8192

local raw = buffer.create(MAX_COMMANDS * RECORD_FLOATS * 4)
local encoded = buffer.create(math.ceil(MAX_COMMANDS * RECORD_FLOATS * 4 / 3) * 4 + 4)
local B64 = buffer.fromstring("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")

local write_offset = 0
local command_count = 0

local function emit(kind, p1, p2, p3, p4, p5, p6, r, g, b, a)
	if command_count >= MAX_COMMANDS then
		return
	end
	local o = write_offset
	buffer.writef32(raw, o, kind)
	buffer.writef32(raw, o + 4, p1)
	buffer.writef32(raw, o + 8, p2)
	buffer.writef32(raw, o + 12, p3)
	buffer.writef32(raw, o + 16, p4)
	buffer.writef32(raw, o + 20, p5)
	buffer.writef32(raw, o + 24, p6)
	buffer.writef32(raw, o + 28, r)
	buffer.writef32(raw, o + 32, g)
	buffer.writef32(raw, o + 36, b)
	buffer.writef32(raw, o + 40, a)
	buffer.writef32(raw, o + 44, 0)
	write_offset = o + RECORD_FLOATS * 4
	command_count += 1
end

-- Encodes the frame's commands as base64. Every output byte is ASCII, so the
-- string survives the host's UTF-8 decode intact.
local function flush_base64(): string
	local n = write_offset
	local i, j = 0, 0

	while i < n do
		local b1 = buffer.readu8(raw, i)
		local b2 = if i + 1 < n then buffer.readu8(raw, i + 1) else 0
		local b3 = if i + 2 < n then buffer.readu8(raw, i + 2) else 0
		local triple = b1 * 65536 + b2 * 256 + b3

		buffer.writeu8(encoded, j, buffer.readu8(B64, (triple // 262144) % 64))
		buffer.writeu8(encoded, j + 1, buffer.readu8(B64, (triple // 4096) % 64))
		buffer.writeu8(encoded, j + 2, buffer.readu8(B64, (triple // 64) % 64))
		buffer.writeu8(encoded, j + 3, buffer.readu8(B64, triple % 64))

		i += 3
		j += 4
	end

	return buffer.readstring(encoded, 0, j)
end

--=============================================================================
-- colours
--=============================================================================

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

local function unpack_color(color: number): (number, number, number)
	return (color // 65536) % 256 / 255, (color // 256) % 256 / 255, color % 256 / 255
end

--=============================================================================
-- asset registry, populated by the host at load time
--=============================================================================

local sprites: { [string]: any } = {}
local tilesets: { [string]: any } = {}
local objects: { [string]: any } = {}
local rooms: { [string]: any } = {}
local glyphs: { [number]: any } = {}

local font_line_height = 12

--- Registered once per sprite. `first_atlas_id` + frame index addresses a frame.
function __register_sprite(
	name, first_atlas_id, frame_count, width, height,
	origin_x, origin_y, fps, col_left, col_top, col_right, col_bottom
)
	sprites[name] = {
		name = name,
		first = first_atlas_id,
		frames = frame_count,
		width = width,
		height = height,
		origin_x = origin_x,
		origin_y = origin_y,
		fps = fps,
		col_left = col_left,
		col_top = col_top,
		col_right = col_right,
		col_bottom = col_bottom,
	}
end

--- `solid_packed` is a string of 0/1, one per tile, row-major.
function __register_tileset(
	name, first_atlas_id, tile_width, tile_height, columns, rows, solid_packed
)
	local solid = table.create(columns * rows, false)
	for index = 1, math.min(#solid_packed, columns * rows) do
		solid[index] = string.sub(solid_packed, index, index) == "1"
	end

	tilesets[name] = {
		name = name,
		first = first_atlas_id,
		tile_width = tile_width,
		tile_height = tile_height,
		columns = columns,
		rows = rows,
		count = columns * rows,
		solid = solid,
	}
end

--- Expand `index:count,index:count,...` back into a flat tile array.
local function decode_tiles(packed: string, length: number): { number }
	local tiles = table.create(length, -1)
	if packed == "" then
		return tiles
	end

	local at = 1
	for _, run in string.split(packed, ",") do
		local parts = string.split(run, ":")
		local value = tonumber(parts[1]) or -1
		local count = tonumber(parts[2]) or 0
		for _ = 1, count do
			if at > length then
				break
			end
			tiles[at] = value
			at += 1
		end
	end

	return tiles
end

--- Tile layers belong to a room and are registered after it.
--- `buffer_index` addresses the host's pre-built GPU geometry for this layer,
--- or -1 if the layer is too large to keep static and must be streamed.
function __register_room_layer(
	room_name, id, tileset_name, depth, visible, columns, rows, packed, buffer_index
)
	local room = rooms[room_name]
	if not room then
		return
	end

	table.insert(room.layers, {
		id = id,
		tileset = tileset_name,
		depth = depth,
		visible = visible,
		columns = columns,
		rows = rows,
		tiles = decode_tiles(packed, columns * rows),
		-- Absent means "no static geometry", so the layer streams its tiles.
		buffer = buffer_index or -1,
		-- Set by tilemap_set: once edited, the host's copy is stale and the
		-- layer goes back to being sent tile by tile.
		dirty = false,
	})
end

--- `module` is the table returned by the object's own .luau chunk.
--- `blocked_packed` is a comma-joined list of object names this object cannot
--- move into; the special entry "tiles" means solid tiles.
function __register_object(name, module, sprite_name, depth, visible, solid, persistent, parent, blocked_packed)
	local blocked_by = nil
	if blocked_packed and blocked_packed ~= "" then
		blocked_by = {}
		for _, target in string.split(blocked_packed, ",") do
			if target ~= "" then
				table.insert(blocked_by, target)
			end
		end
	end

	objects[name] = {
		name = name,
		module = module,
		sprite = sprite_name,
		depth = depth,
		visible = visible,
		solid = solid,
		persistent = persistent,
		parent = parent,
		blocked_by = blocked_by,
	}
end

--- Instances arrive as one packed string so a big room costs one crossing:
--- `object,x,y,xscale,yscale,angle,name;object,x,y,...`
--- The seventh field, the instance's name, is optional: rooms written before
--- it existed pack six.
function __register_room(name, width, height, background, grid_w, grid_h, packed)
	local placements = {}

	if packed ~= "" then
		for _, entry in string.split(packed, ";") do
			if entry ~= "" then
				local f = string.split(entry, ",")
				table.insert(placements, {
					object = f[1],
					x = tonumber(f[2]) or 0,
					y = tonumber(f[3]) or 0,
					xscale = tonumber(f[4]) or 1,
					yscale = tonumber(f[5]) or 1,
					angle = tonumber(f[6]) or 0,
					name = if f[7] ~= nil and f[7] ~= "" then f[7] else nil,
				})
			end
		end
	end

	rooms[name] = {
		name = name,
		width = width,
		height = height,
		background = background,
		grid_w = grid_w,
		grid_h = grid_h,
		placements = placements,
		layers = {},
	}
end

--- Font metrics, packed as `charCode,atlasId,advance,width,height;...`
function __register_font(line_height, packed)
	font_line_height = line_height
	for _, entry in string.split(packed, ";") do
		if entry ~= "" then
			local f = string.split(entry, ",")
			glyphs[tonumber(f[1])] = {
				atlas = tonumber(f[2]),
				advance = tonumber(f[3]),
				width = tonumber(f[4]),
				height = tonumber(f[5]),
			}
		end
	end
end

--=============================================================================
-- input, refreshed once per frame from the host
--=============================================================================

local held: { [string]: boolean } = {}
local pressed: { [string]: boolean } = {}
local released: { [string]: boolean } = {}

local mouse_state = { x = 0, y = 0, left = false, right = false, middle = false, wheel = 0 }

local function parse_key_set(text: string, into: { [string]: boolean })
	table.clear(into)
	if text == "" then
		return
	end
	for _, key in string.split(text, ",") do
		if key ~= "" then
			into[key] = true
		end
	end
end

--- `held|pressed|released|mouseX,mouseY,buttonMask,wheel`
local function apply_input(input: string)
	local parts = string.split(input, "|")
	parse_key_set(parts[1] or "", held)
	parse_key_set(parts[2] or "", pressed)
	parse_key_set(parts[3] or "", released)

	local m = string.split(parts[4] or "", ",")
	mouse_state.x = tonumber(m[1]) or 0
	mouse_state.y = tonumber(m[2]) or 0
	local mask = tonumber(m[3]) or 0
	mouse_state.left = mask % 2 >= 1
	mouse_state.right = (mask // 2) % 2 >= 1
	mouse_state.middle = (mask // 4) % 2 >= 1
	mouse_state.wheel = tonumber(m[4]) or 0
end

function keyboard_check(key: string): boolean
	return held[key] == true
end

function keyboard_check_pressed(key: string): boolean
	return pressed[key] == true
end

function keyboard_check_released(key: string): boolean
	return released[key] == true
end

function mouse_check_button(button: string?): boolean
	return mouse_state[button or "left"] == true
end

function mouse_x(): number
	return mouse_state.x
end

function mouse_y(): number
	return mouse_state.y
end

function mouse_wheel(): number
	return mouse_state.wheel
end

--=============================================================================
-- maths helpers
--=============================================================================

function point_distance(x1, y1, x2, y2)
	local dx, dy = x2 - x1, y2 - y1
	return math.sqrt(dx * dx + dy * dy)
end

--- Degrees counter-clockwise, 0 = right, matching GameMaker.
function point_direction(x1, y1, x2, y2)
	return math.deg(math.atan2(-(y2 - y1), x2 - x1)) % 360
end

function lengthdir_x(length, direction)
	return math.cos(math.rad(direction)) * length
end

function lengthdir_y(length, direction)
	return -math.sin(math.rad(direction)) * length
end

function clamp(value, low, high)
	return math.max(low, math.min(high, value))
end

function lerp(a, b, amount)
	return a + (b - a) * amount
end

function approach(value, target, amount)
	if value < target then
		return math.min(value + amount, target)
	end
	return math.max(value - amount, target)
end

function sign(value)
	if value > 0 then
		return 1
	elseif value < 0 then
		return -1
	end
	return 0
end

function choose(...)
	local options = { ... }
	return options[math.random(#options)]
end

function irandom(maximum)
	return math.random(0, maximum)
end

function irandom_range(low, high)
	return math.random(low, high)
end

function random_range(low, high)
	return low + math.random() * (high - low)
end

function angle_difference(a, b)
	return (a - b + 180) % 360 - 180
end

function wrap(value, low, high)
	local span = high - low
	if span <= 0 then
		return low
	end
	return low + (value - low) % span
end

--=============================================================================
-- instances
--=============================================================================

local ALARM_COUNT = 12

local instances: { [number]: any } = {}
local ordered: { any } = {}
local order_dirty = true
local next_id = 1
local pending_destroy: { any } = {}

local current_room = nil
local room_width_value = 0
local room_height_value = 0
local view_x, view_y = 0, 0
-- The visible area's size; the room's size unless a game asks for a window.
local view_width_value, view_height_value = 0, 0
local room_change_request = nil
local quit_requested = false

local InstanceMethods = {}
-- The instance metatable. Not called `Instance`: that name is the global
-- `Instance.new` namespace game code uses, defined further down.
local InstanceMeta = {}

--- Signals every instance can expose, created on first access.
---
--- Allocating a Signal per instance up front would cost more than the whole
--- step loop for a room full of walls, so `__index` makes them lazily and
--- caches the result on the instance itself.
local SIGNAL_FIELDS = { Destroying = true, Collided = true }

--- Roblox-style properties resolved by the metatable rather than stored under
--- that name: `Parent` reads and writes the tree, `Name` aliases `name`.
local PROPERTY_FIELDS = { Parent = true, Name = true }

local set_parent -- defined with the tree functions below

InstanceMeta.__index = function(self, key)
	local method = InstanceMethods[key]
	if method ~= nil then
		return method
	end
	if PROPERTY_FIELDS[key] then
		if key == "Parent" then
			local parent = rawget(self, "__parent")
			-- A root instance's parent is the Workspace, as in Roblox.
			return if parent ~= nil then parent else Workspace
		end
		return rawget(self, "name")
	end
	if SIGNAL_FIELDS[key] then
		local signal = __rbx.newSignal()
		rawset(self, key, signal)
		return signal
	end
	return nil
end

-- Only keys missing from the instance reach here: the built-in fields are all
-- present from construction, so `self.x = ...` never pays for this.
InstanceMeta.__newindex = function(self, key, value)
	if key == "Parent" then
		set_parent(self, value)
	elseif key == "Name" then
		rawset(self, "name", value)
	else
		rawset(self, key, value)
	end
end

local function object_is_a(object_name: string?, wanted: string): boolean
	local current = object_name
	local guard = 0
	while current and guard < 32 do
		if current == wanted then
			return true
		end
		local def = objects[current]
		current = if def then def.parent else nil
		guard += 1
	end
	return false
end

function InstanceMethods.is_a(self, name: string): boolean
	return object_is_a(self.__object, name)
end

function InstanceMethods.destroy(self)
	if self.__destroyed then
		return
	end
	self.__destroyed = true
	table.insert(pending_destroy, self)

	-- Only fire if something ever connected; rawget avoids creating the signal.
	local destroying = rawget(self, "Destroying")
	if destroying then
		destroying:Fire(self)
	end

	local def = objects[self.__object]
	local handler = if def and def.module then def.module.destroy else nil
	if handler then
		handler(self)
	end

	-- Children go with their parent, as in Roblox: the parent's own event and
	-- signal run first, then each child's, depth first.
	local children = rawget(self, "__children")
	if children then
		for _, child in table.clone(children) do
			child:destroy()
		end
	end
	local parent = rawget(self, "__parent")
	if parent then
		local siblings = rawget(parent, "__children")
		if siblings then
			local index = table.find(siblings, self)
			if index then
				table.remove(siblings, index)
			end
		end
		rawset(self, "__parent", nil)
	end
end

InstanceMethods.Destroy = InstanceMethods.destroy

--=============================================================================
-- the instance tree
--=============================================================================
--
-- Every instance is a root until game code parents it: `child.Parent = self`
-- or `Instance.new("obj_x", self)`. Parenting is purely a naming and
-- ownership structure -- it never moves anything -- so a world that never
-- uses it is exactly the flat GameMaker world it always was. A parent takes
-- its children with it when destroyed.

local function is_instance(value): boolean
	return type(value) == "table" and getmetatable(value) == InstanceMeta
end

local function by_id(a, b): boolean
	return a.__id < b.__id
end

--- Live children of `inst`, oldest first.
function InstanceMethods.get_children(self)
	local found = {}
	local children = rawget(self, "__children")
	if children then
		for _, child in children do
			if not child.__destroyed then
				table.insert(found, child)
			end
		end
	end
	table.sort(found, by_id)
	return found
end

--- Every live instance below `inst`, parents before their children.
function InstanceMethods.get_descendants(self)
	local found = {}
	local function walk(node)
		for _, child in node:get_children() do
			table.insert(found, child)
			walk(child)
		end
	end
	walk(self)
	return found
end

--- The first live child called `name`, or failing that the first child whose
--- object is (or descends from) an object called `name`.
function InstanceMethods.find_first_child(self, name: string)
	local children = self:get_children()
	for _, child in children do
		if rawget(child, "name") == name then
			return child
		end
	end
	for _, child in children do
		if object_is_a(child.__object, name) then
			return child
		end
	end
	return nil
end

InstanceMethods.GetChildren = InstanceMethods.get_children
InstanceMethods.GetDescendants = InstanceMethods.get_descendants
InstanceMethods.FindFirstChild = InstanceMethods.find_first_child

--- Move `inst` under `parent`. `nil` or the Workspace makes it a root again.
set_parent = function(inst, parent)
	if parent == Workspace or parent == nil then
		parent = nil
	elseif not is_instance(parent) then
		error(`Parent must be an instance or workspace, got {typeof(parent)}`, 3)
	elseif parent.__destroyed then
		error("Cannot parent to a destroyed instance", 3)
	elseif parent == inst then
		error("An instance cannot be its own parent", 3)
	else
		-- Walk up from the new parent; reaching `inst` would close a loop.
		local node = parent
		local guard = 0
		while node ~= nil and guard < 64 do
			if node == inst then
				error("Setting Parent would create a cycle", 3)
			end
			node = rawget(node, "__parent")
			guard += 1
		end
	end

	local previous = rawget(inst, "__parent")
	if previous == parent then
		return
	end
	if previous then
		local siblings = rawget(previous, "__children")
		local index = if siblings then table.find(siblings, inst) else nil
		if index then
			table.remove(siblings, index)
		end
	end
	rawset(inst, "__parent", parent)
	if parent then
		local children = rawget(parent, "__children")
		if not children then
			children = {}
			rawset(parent, "__children", children)
		end
		table.insert(children, inst)
	end
end

function InstanceMethods.sprite_width(self): number
	local sprite = sprites[self.sprite_index]
	return if sprite then sprite.width * self.image_xscale else 0
end

function InstanceMethods.sprite_height(self): number
	local sprite = sprites[self.sprite_index]
	return if sprite then sprite.height * self.image_yscale else 0
end

function InstanceMethods.image_number(self): number
	local sprite = sprites[self.sprite_index]
	return if sprite then sprite.frames else 0
end

--- Collision rectangle in room space: left, top, right, bottom.
function InstanceMethods.bbox(self): (number, number, number, number)
	local sprite = sprites[self.sprite_index]
	if not sprite then
		return self.x - 1, self.y - 1, self.x + 1, self.y + 1
	end

	local x1 = self.x + (sprite.col_left - sprite.origin_x) * self.image_xscale
	local x2 = self.x + (sprite.col_right + 1 - sprite.origin_x) * self.image_xscale
	local y1 = self.y + (sprite.col_top - sprite.origin_y) * self.image_yscale
	local y2 = self.y + (sprite.col_bottom + 1 - sprite.origin_y) * self.image_yscale

	return math.min(x1, x2), math.min(y1, y2), math.max(x1, x2), math.max(y1, y2)
end

local function boxes_overlap(al, at, ar, ab, bl, bt, br, bb): boolean
	return al < br and bl < ar and at < bb and bt < ab
end

function InstanceMethods.instance_place(self, x: number, y: number, target: string)
	local old_x, old_y = self.x, self.y
	self.x, self.y = x, y
	local al, at, ar, ab = self:bbox()
	self.x, self.y = old_x, old_y

	for _, other in instances do
		if other ~= self and not other.__destroyed and object_is_a(other.__object, target) then
			local bl, bt, br, bb = other:bbox()
			if boxes_overlap(al, at, ar, ab, bl, bt, br, bb) then
				return other
			end
		end
	end
	return nil
end

--- Every instance of `target` overlapping this one when moved to (x, y).
function InstanceMethods.instance_place_list(self, x: number, y: number, target: string)
	local old_x, old_y = self.x, self.y
	self.x, self.y = x, y
	local al, at, ar, ab = self:bbox()
	self.x, self.y = old_x, old_y

	local found = {}
	for _, other in instances do
		if other ~= self and not other.__destroyed and object_is_a(other.__object, target) then
			local bl, bt, br, bb = other:bbox()
			if boxes_overlap(al, at, ar, ab, bl, bt, br, bb) then
				table.insert(found, other)
			end
		end
	end
	return found
end

--- `target` is an object name, or the string "tiles" for solid tile collision.
function InstanceMethods.place_meeting(self, x: number, y: number, target: string): boolean
	if target == "tiles" then
		return __tiles_meeting(self, x, y)
	end
	return self:instance_place(x, y, target) ~= nil
end

--- Step towards (dx, dy) a unit at a time, stopping just before a collision.
function InstanceMethods.move_contact(self, target: string, dx: number, dy: number)
	local length = math.sqrt(dx * dx + dy * dy)
	if length == 0 then
		return
	end
	local step_x, step_y = dx / length, dy / length
	for _ = 1, math.ceil(length) do
		if self:place_meeting(self.x + step_x, self.y + step_y, target) then
			return
		end
		self.x += step_x
		self.y += step_y
	end
end

function InstanceMethods.move_towards_point(self, x: number, y: number, speed: number)
	local angle = math.atan2(-(y - self.y), x - self.x)
	self.hspeed = math.cos(angle) * speed
	self.vspeed = -math.sin(angle) * speed
end

function InstanceMethods.distance_to_point(self, x: number, y: number): number
	return point_distance(self.x, self.y, x, y)
end

function InstanceMethods.distance_to_object(self, other): number
	return point_distance(self.x, self.y, other.x, other.y)
end

function InstanceMethods.speed(self): number
	return math.sqrt(self.hspeed * self.hspeed + self.vspeed * self.vspeed)
end

function InstanceMethods.direction(self): number
	if self.hspeed == 0 and self.vspeed == 0 then
		return 0
	end
	return math.deg(math.atan2(-self.vspeed, self.hspeed)) % 360
end

function InstanceMethods.set_speed(self, magnitude: number, direction: number)
	local radians = math.rad(direction)
	self.hspeed = math.cos(radians) * magnitude
	self.vspeed = -math.sin(radians) * magnitude
end

--=============================================================================
-- drawing
--=============================================================================

local draw_color = 0xFFFFFF
local draw_alpha = 1.0

function draw_set_color(color: number)
	draw_color = color
end

function draw_get_color(): number
	return draw_color
end

function draw_set_alpha(alpha: number)
	draw_alpha = alpha
end

function draw_sprite_ext(sprite_name, index, x, y, xscale, yscale, angle, color, alpha)
	local sprite = sprites[sprite_name]
	if not sprite then
		return
	end
	local frame = math.floor(index) % sprite.frames
	local r, g, b = unpack_color(color or 0xFFFFFF)
	emit(CMD_SPRITE, sprite.first + frame, x, y, xscale or 1, yscale or 1, angle or 0, r, g, b, alpha or 1)
end

function draw_sprite(sprite_name, index, x, y)
	draw_sprite_ext(sprite_name, index, x, y, 1, 1, 0, 0xFFFFFF, 1)
end

function InstanceMethods.draw_self(self)
	local sprite = sprites[self.sprite_index]
	if not sprite then
		return
	end
	local frame = math.floor(self.image_index) % sprite.frames
	local r, g, b = unpack_color(self.image_blend)
	emit(
		CMD_SPRITE,
		sprite.first + frame,
		self.x,
		self.y,
		self.image_xscale,
		self.image_yscale,
		self.image_angle,
		r,
		g,
		b,
		self.image_alpha
	)
end

function draw_rectangle(x1, y1, x2, y2, outline)
	local r, g, b = unpack_color(draw_color)
	emit(CMD_RECT, x1, y1, x2, y2, if outline then 1 else 0, 1, r, g, b, draw_alpha)
end

function draw_line(x1, y1, x2, y2, width)
	local r, g, b = unpack_color(draw_color)
	emit(CMD_LINE, x1, y1, x2, y2, width or 1, 0, r, g, b, draw_alpha)
end

function draw_circle(x, y, radius, outline)
	local r, g, b = unpack_color(draw_color)
	emit(CMD_CIRCLE, x, y, radius, if outline then 1 else 0, 24, 0, r, g, b, draw_alpha)
end

function draw_text(x, y, text, color)
	local r, g, b = unpack_color(color or draw_color)
	local pen_x, pen_y = x, y

	for index = 1, #text do
		local code = string.byte(text, index)
		if code == 10 then
			pen_x = x
			pen_y += font_line_height
			continue
		end

		local glyph = glyphs[code]
		if glyph then
			emit(CMD_SPRITE, glyph.atlas, pen_x, pen_y, 1, 1, 0, r, g, b, draw_alpha)
			pen_x += glyph.advance
		else
			pen_x += font_line_height * 0.5
		end
	end
end

function string_width(text: string): number
	local width, longest = 0, 0
	for index = 1, #text do
		local code = string.byte(text, index)
		if code == 10 then
			longest = math.max(longest, width)
			width = 0
		else
			local glyph = glyphs[code]
			width += if glyph then glyph.advance else font_line_height * 0.5
		end
	end
	return math.max(longest, width)
end

function string_height(text: string): number
	return font_line_height * (#string.split(text, "\n"))
end

--=============================================================================
-- instance lifecycle and queries
--=============================================================================

local function make_instance(object_name: string, x: number, y: number, name: string?)
	local def = objects[object_name]
	if not def then
		error(`instance_create: no object named '{object_name}'`)
	end

	local sprite = if def.sprite then sprites[def.sprite] else nil
	local id = next_id
	next_id += 1

	local inst = setmetatable({
		__id = id,
		__object = object_name,
		__destroyed = false,

		name = name or object_name,
		x = x,
		y = y,
		xstart = x,
		ystart = y,
		xprevious = x,
		yprevious = y,

		hspeed = 0,
		vspeed = 0,
		gravity = 0,
		gravity_direction = 270,
		friction = 0,

		sprite_index = def.sprite,
		image_index = 0,
		-- Default to the sprite's authored frame rate.
		image_speed = if sprite then sprite.fps / 60 else 0,
		image_xscale = 1,
		image_yscale = 1,
		image_angle = 0,
		image_alpha = 1,
		image_blend = 0xFFFFFF,

		visible = def.visible,
		solid = def.solid,
		depth = def.depth,
		alarms = table.create(ALARM_COUNT, -1),
	}, InstanceMeta)

	instances[id] = inst
	order_dirty = true
	return inst
end

local function dispatch(inst, event: string, arg: any?)
	local def = objects[inst.__object]
	local module = if def then def.module else nil
	local handler = if module then module[event] else nil
	if handler then
		handler(inst, arg)
	end
end

function instance_create(x: number, y: number, object_name: string)
	local inst = make_instance(object_name, x, y)
	dispatch(inst, "create")
	return inst
end

--- The Roblox spelling of instance_create: `Instance.new("obj_coin", self)`.
--- The parent is set before the create event runs, so `self.Parent` is
--- already right inside it. Position defaults to the parent's, or 0,0.
Instance = {}

function Instance.new(object_name: string, parent)
	local x, y = 0, 0
	if is_instance(parent) then
		x, y = parent.x, parent.y
	end
	local inst = make_instance(object_name, x, y)
	if parent ~= nil then
		set_parent(inst, parent)
	end
	dispatch(inst, "create")
	return inst
end

function instance_destroy(inst)
	inst:destroy()
end

function instance_exists(object_name: string): boolean
	for _, inst in instances do
		if not inst.__destroyed and object_is_a(inst.__object, object_name) then
			return true
		end
	end
	return false
end

function instance_number(object_name: string): number
	local count = 0
	for _, inst in instances do
		if not inst.__destroyed and object_is_a(inst.__object, object_name) then
			count += 1
		end
	end
	return count
end

function instance_list(object_name: string)
	local found = {}
	for _, inst in instances do
		if not inst.__destroyed and object_is_a(inst.__object, object_name) then
			table.insert(found, inst)
		end
	end
	return found
end

function instance_find(object_name: string, index: number?)
	local found = instance_list(object_name)
	return found[(index or 0) + 1]
end

function instance_nearest(x: number, y: number, object_name: string)
	local best, best_distance = nil, math.huge
	for _, inst in instances do
		if not inst.__destroyed and object_is_a(inst.__object, object_name) then
			local distance = point_distance(x, y, inst.x, inst.y)
			if distance < best_distance then
				best, best_distance = inst, distance
			end
		end
	end
	return best
end

function collision_point(x: number, y: number, object_name: string)
	for _, inst in instances do
		if not inst.__destroyed and object_is_a(inst.__object, object_name) then
			local l, t, r, b = inst:bbox()
			if x >= l and x <= r and y >= t and y <= b then
				return inst
			end
		end
	end
	return nil
end

--=============================================================================
-- rooms
--=============================================================================

function room_current(): string
	return if current_room then current_room.name else ""
end

function room_width(): number
	return room_width_value
end

function room_height(): number
	return room_height_value
end

function room_speed(): number
	return 60
end

function room_goto(name: string)
	if not rooms[name] then
		error(`room_goto: no room named '{name}'`)
	end
	room_change_request = name
end

function room_restart()
	if current_room then
		room_change_request = current_room.name
	end
end

function game_end()
	quit_requested = true
end

function view_set(x: number, y: number)
	view_x, view_y = x, y
end

function view_get(): (number, number)
	return view_x, view_y
end

--- The size of the visible area. It resets to the room's size on entering a
--- room, so a scrolling game sets it in room_start.
function view_set_size(width: number, height: number)
	view_width_value = math.max(1, math.floor(width))
	view_height_value = math.max(1, math.floor(height))
end

function view_width(): number
	return view_width_value
end

function view_height(): number
	return view_height_value
end

local function enter_room(name: string)
	if current_room then
		for _, inst in instances do
			if not inst.__destroyed then
				dispatch(inst, "room_end")
			end
		end
	end

	-- Persistent instances survive the transition, as in GameMaker.
	local survivors = {}
	for id, inst in instances do
		local def = objects[inst.__object]
		if not inst.__destroyed and def and def.persistent then
			survivors[id] = inst
		end
	end
	-- A survivor whose parent did not make it becomes a root, and drops any
	-- children that did not either.
	for _, inst in survivors do
		local parent = rawget(inst, "__parent")
		if parent and not survivors[parent.__id] then
			rawset(inst, "__parent", nil)
		end
		local children = rawget(inst, "__children")
		if children then
			for index = #children, 1, -1 do
				if not survivors[children[index].__id] then
					table.remove(children, index)
				end
			end
		end
	end
	instances = survivors
	table.clear(pending_destroy)

	local room = rooms[name]
	if not room then
		local available = {}
		for key in rooms do
			table.insert(available, key)
		end
		table.sort(available)
		if #available == 0 then
			error("This project has no rooms. Create one before running.", 0)
		end
		error(
			`No room named '{name}'. The project's start room may have been renamed or deleted. `
				.. `Available rooms: {table.concat(available, ", ")}`,
			0
		)
	end

	current_room = room
	-- Descending depth, matching the instance order they are merged with.
	table.sort(room.layers, function(a, b)
		return a.depth > b.depth
	end)
	room_width_value = room.width
	room_height_value = room.height
	view_width_value = room.width
	view_height_value = room.height
	view_x, view_y = 0, 0
	order_dirty = true

	local created = {}
	for _, placement in room.placements do
		if objects[placement.object] then
			local inst = make_instance(placement.object, placement.x, placement.y, placement.name)
			inst.image_xscale = placement.xscale
			inst.image_yscale = placement.yscale
			inst.image_angle = placement.angle
			table.insert(created, inst)
		end
	end

	for _, inst in created do
		dispatch(inst, "create")
	end
	for _, inst in instances do
		if not inst.__destroyed then
			dispatch(inst, "room_start")
		end
	end
end

function __start(room_name: string)
	enter_room(room_name)
end

--- Store a shared `scripts/` module so `require(name)` can find it.
function __register_module(name: string, value)
	__rbx.registerModule(name, value)
end

-- The Workspace reads through to the live instances: its children are the
-- roots of the tree, its descendants everything alive.
local function live_instances(roots_only: boolean)
	local live = {}
	for _, inst in instances do
		if not inst.__destroyed and (not roots_only or rawget(inst, "__parent") == nil) then
			table.insert(live, inst)
		end
	end
	table.sort(live, by_id)
	return live
end

__rbx.setInstanceProvider({
	all = function()
		return live_instances(false)
	end,
	roots = function()
		return live_instances(true)
	end,
	-- By name first, then the original meaning: any instance of that object.
	findFirst = function(name: string)
		for _, inst in live_instances(true) do
			if rawget(inst, "name") == name then
				return inst
			end
		end
		return instance_find(name)
	end,
})

--- Wipe every registered asset and all live state.
---
--- The host reuses one VM for the whole session rather than building a new one
--- per run, so this is what makes a re-run a clean slate.
function __reset()
	__rbx.reset()

	table.clear(sprites)
	table.clear(tilesets)
	table.clear(objects)
	table.clear(rooms)
	table.clear(glyphs)

	instances = {}
	table.clear(ordered)
	table.clear(pending_destroy)
	next_id = 1
	order_dirty = true

	current_room = nil
	room_width_value = 0
	room_height_value = 0
	view_width_value, view_height_value = 0, 0
	view_x, view_y = 0, 0
	room_change_request = nil
	quit_requested = false

	write_offset = 0
	command_count = 0
	draw_color = 0xFFFFFF
	draw_alpha = 1.0

	table.clear(held)
	table.clear(pressed)
	table.clear(released)
end

--=============================================================================
-- tiles
--=============================================================================

local function find_layer(layer_id: string)
	if not current_room then
		return nil
	end
	for _, layer in current_room.layers do
		if layer.id == layer_id then
			return layer
		end
	end
	return nil
end

--- Tile index at a tile coordinate, or -1 for empty / out of bounds.
function tilemap_get(layer_id: string, tile_x: number, tile_y: number): number
	local layer = find_layer(layer_id)
	if not layer or tile_x < 0 or tile_y < 0 or tile_x >= layer.columns or tile_y >= layer.rows then
		return -1
	end
	return layer.tiles[tile_y * layer.columns + tile_x + 1]
end

function tilemap_set(layer_id: string, tile_x: number, tile_y: number, index: number): boolean
	local layer = find_layer(layer_id)
	if not layer or tile_x < 0 or tile_y < 0 or tile_x >= layer.columns or tile_y >= layer.rows then
		return false
	end
	layer.tiles[tile_y * layer.columns + tile_x + 1] = index
	-- The host's static copy no longer matches, so stream this layer from now on.
	layer.dirty = true
	return true
end

--- Tile index at a room position, rather than a tile coordinate.
function tilemap_get_at(layer_id: string, x: number, y: number): number
	local layer = find_layer(layer_id)
	if not layer then
		return -1
	end
	local set = tilesets[layer.tileset]
	if not set then
		return -1
	end
	return tilemap_get(layer_id, math.floor(x / set.tile_width), math.floor(y / set.tile_height))
end

function tilemap_layers(): { string }
	local ids = {}
	if current_room then
		for _, layer in current_room.layers do
			table.insert(ids, layer.id)
		end
	end
	return ids
end

--- True if any layer has a solid tile covering this point.
function tile_solid_at(x: number, y: number): boolean
	if not current_room then
		return false
	end
	for _, layer in current_room.layers do
		local set = tilesets[layer.tileset]
		if set then
			local tx = math.floor(x / set.tile_width)
			local ty = math.floor(y / set.tile_height)
			if tx >= 0 and ty >= 0 and tx < layer.columns and ty < layer.rows then
				local index = layer.tiles[ty * layer.columns + tx + 1]
				if index >= 0 and set.solid[index + 1] then
					return true
				end
			end
		end
	end
	return false
end

--- Whether an instance's collision box would overlap a solid tile at (x, y).
---
--- A global because `place_meeting` is defined further up the file, before the
--- tile section exists.
function __tiles_meeting(inst, x: number, y: number): boolean
	if not current_room or #current_room.layers == 0 then
		return false
	end

	local old_x, old_y = inst.x, inst.y
	inst.x, inst.y = x, y
	local left, top, right, bottom = inst:bbox()
	inst.x, inst.y = old_x, old_y

	for _, layer in current_room.layers do
		local set = tilesets[layer.tileset]
		if set then
			-- The box is half-open, so nudge the far edge back inside it.
			local x0 = math.max(0, math.floor(left / set.tile_width))
			local x1 = math.min(layer.columns - 1, math.floor((right - 0.0001) / set.tile_width))
			local y0 = math.max(0, math.floor(top / set.tile_height))
			local y1 = math.min(layer.rows - 1, math.floor((bottom - 0.0001) / set.tile_height))

			for ty = y0, y1 do
				local row = ty * layer.columns
				for tx = x0, x1 do
					local index = layer.tiles[row + tx + 1]
					if index >= 0 and set.solid[index + 1] then
						return true
					end
				end
			end
		end
	end

	return false
end

--- Draw one layer.
---
--- An untouched layer is already on the GPU, so it costs a single marker
--- command. Once `tilemap_set` edits it the host's copy is stale, and the tiles
--- are streamed individually again, culled to the visible area.
local function draw_layer(layer)
	if not layer.visible then
		return
	end
	local set = tilesets[layer.tileset]
	if not set then
		return
	end

	if layer.buffer >= 0 and not layer.dirty then
		emit(CMD_LAYER, layer.buffer, 0, 0, 0, 0, 0, 1, 1, 1, 1)
		return
	end

	local tw, th = set.tile_width, set.tile_height
	local x0 = math.max(0, math.floor(view_x / tw))
	local y0 = math.max(0, math.floor(view_y / th))
	local x1 = math.min(layer.columns - 1, math.floor((view_x + view_width_value - 1) / tw))
	local y1 = math.min(layer.rows - 1, math.floor((view_y + view_height_value - 1) / th))

	for ty = y0, y1 do
		local row = ty * layer.columns
		for tx = x0, x1 do
			local index = layer.tiles[row + tx + 1]
			if index >= 0 and index < set.count then
				emit(CMD_SPRITE, set.first + index, tx * tw, ty * th, 1, 1, 0, 1, 1, 1, 1)
			end
		end
	end
end

--=============================================================================
-- the frame
--=============================================================================

local function collect_destroyed()
	if #pending_destroy == 0 then
		return
	end
	for _, inst in pending_destroy do
		instances[inst.__id] = nil
	end
	table.clear(pending_destroy)
	order_dirty = true
end

local function for_each_live(event: string)
	for _, inst in instances do
		if not inst.__destroyed then
			dispatch(inst, event)
		end
	end
	collect_destroyed()
end

local function run_alarms()
	for _, inst in instances do
		if inst.__destroyed then
			continue
		end
		local alarms = inst.alarms
		for index = 1, ALARM_COUNT do
			local value = alarms[index]
			if value >= 0 then
				value -= 1
				if value == 0 then
					alarms[index] = -1
					dispatch(inst, "alarm", index)
				else
					alarms[index] = value
				end
			end
		end
	end
	collect_destroyed()
end

--- Would this instance overlap any of its blockers if it stood at (x, y)?
local function blocked_at(inst, x: number, y: number, blockers): boolean
	for _, target in blockers do
		if target == "tiles" then
			if __tiles_meeting(inst, x, y) then
				return true
			end
		elseif inst:instance_place(x, y, target) ~= nil then
			return true
		end
	end
	return false
end

--- Slide one axis to contact with whatever blocks it. Mirrors move_contact,
--- but against the whole blocker list at once.
local function slide_to_contact(inst, blockers, dx: number, dy: number)
	local length = math.abs(dx + dy)
	if length == 0 then
		return
	end
	local step_x = dx / length
	local step_y = dy / length
	for _ = 1, math.ceil(length) do
		if blocked_at(inst, inst.x + step_x, inst.y + step_y, blockers) then
			return
		end
		inst.x += step_x
		inst.y += step_y
	end
end

local function apply_movement()
	for _, inst in instances do
		if inst.__destroyed then
			continue
		end

		inst.xprevious = inst.x
		inst.yprevious = inst.y

		if inst.gravity ~= 0 then
			local radians = math.rad(inst.gravity_direction)
			inst.hspeed += math.cos(radians) * inst.gravity
			inst.vspeed -= math.sin(radians) * inst.gravity
		end

		if inst.friction ~= 0 then
			local speed = math.sqrt(inst.hspeed * inst.hspeed + inst.vspeed * inst.vspeed)
			if speed > 0 then
				local scale = math.max(0, speed - inst.friction) / speed
				inst.hspeed *= scale
				inst.vspeed *= scale
			end
		end

		local def = objects[inst.__object]
		local blockers = if def then def.blocked_by else nil

		if not blockers then
			inst.x += inst.hspeed
			inst.y += inst.vspeed
			continue
		end

		-- One axis at a time, so pressing into a wall still slides along it.
		-- A blocked axis walks to contact and stops; gravity would otherwise
		-- accumulate vspeed forever against a floor.
		if inst.hspeed ~= 0 then
			if blocked_at(inst, inst.x + inst.hspeed, inst.y, blockers) then
				slide_to_contact(inst, blockers, inst.hspeed, 0)
				inst.hspeed = 0
			else
				inst.x += inst.hspeed
			end
		end

		if inst.vspeed ~= 0 then
			if blocked_at(inst, inst.x, inst.y + inst.vspeed, blockers) then
				slide_to_contact(inst, blockers, 0, inst.vspeed)
				inst.vspeed = 0
			else
				inst.y += inst.vspeed
			end
		end
	end
end

local function run_collisions()
	-- Only instances that actually handle collisions are tested -- either with a
	-- `collision` event or a connection to their `Collided` signal.
	local actors = {}
	for _, inst in instances do
		local def = objects[inst.__object]
		local module = if def then def.module else nil
		local handled = (module and module.collision) or rawget(inst, "Collided")
		if not inst.__destroyed and handled then
			table.insert(actors, inst)
		end
	end
	if #actors == 0 then
		return
	end

	for _, actor in actors do
		if actor.__destroyed then
			continue
		end
		local al, at, ar, ab = actor:bbox()
		for _, other in instances do
			if other == actor or other.__destroyed or actor.__destroyed then
				continue
			end
			local bl, bt, br, bb = other:bbox()
			if boxes_overlap(al, at, ar, ab, bl, bt, br, bb) then
				dispatch(actor, "collision", other)
				local collided = rawget(actor, "Collided")
				if collided then
					collided:Fire(other)
				end
			end
		end
	end
	collect_destroyed()
end

local function advance_animation()
	for _, inst in instances do
		if inst.__destroyed or inst.image_speed == 0 then
			continue
		end
		local sprite = sprites[inst.sprite_index]
		if not sprite or sprite.frames <= 1 then
			continue
		end

		local index = inst.image_index + inst.image_speed
		if index >= sprite.frames or index < 0 then
			inst.image_index = index % sprite.frames
			dispatch(inst, "animation_end")
		else
			inst.image_index = index
		end
	end
	collect_destroyed()
end

local function rebuild_order()
	table.clear(ordered)
	for _, inst in instances do
		table.insert(ordered, inst)
	end
	-- Larger depth draws further back.
	table.sort(ordered, function(a, b)
		if a.depth == b.depth then
			return a.__id < b.__id
		end
		return a.depth > b.depth
	end)
	order_dirty = false
end

--- Runs one whole game step and returns everything the host needs for it:
--- the draw commands as base64, followed by the frame's metadata.
---
--- This is the *only* call the host makes per frame. Splitting it would double
--- the boundary crossings for no benefit.
function __frame(input: string, dt: number?): (string, number, number, number, number, number, number, boolean)
	local delta = dt or 1 / 60
	apply_input(input)

	-- UserInputService mirrors this frame's key transitions.
	for key in pressed do
		__rbx.fireInputBegan(key)
	end
	for key in released do
		__rbx.fireInputEnded(key)
	end

	__rbx.stepScheduler(delta)
	__rbx.fireStepped(delta)

	for_each_live("step_begin")
	run_alarms()
	for_each_live("step")
	apply_movement()
	run_collisions()
	for_each_live("step_end")
	advance_animation()

	__rbx.fireHeartbeat(delta)
	collect_destroyed()

	if order_dirty then
		rebuild_order()
	end

	write_offset = 0
	command_count = 0
	draw_color = 0xFFFFFF
	draw_alpha = 1.0

	__rbx.fireRenderStepped(delta)

	-- Layers and instances are both sorted by descending depth, so walking them
	-- together interleaves tiles and objects correctly without building a
	-- combined list every frame.
	local layers = if current_room then current_room.layers else {}
	local next_layer = 1

	for _, inst in ordered do
		if inst.__destroyed then
			continue
		end
		while next_layer <= #layers and layers[next_layer].depth > inst.depth do
			draw_layer(layers[next_layer])
			next_layer += 1
		end

		local def = objects[inst.__object]
		local module = if def then def.module else nil
		local handler = if module then module.draw else nil
		if handler then
			handler(inst)
		elseif inst.visible then
			inst:draw_self()
		end
	end

	while next_layer <= #layers do
		draw_layer(layers[next_layer])
		next_layer += 1
	end

	for _, inst in ordered do
		if inst.__destroyed then
			continue
		end
		local def = objects[inst.__object]
		local module = if def then def.module else nil
		if module and module.draw_gui then
			module.draw_gui(inst)
		end
	end

	local payload = flush_base64()
	local drawn = command_count
	local background = if current_room then current_room.background else 0

	-- Applied after drawing so the frame just rendered stays consistent.
	if room_change_request then
		local target = room_change_request
		room_change_request = nil
		enter_room(target)
	end

	return payload, drawn, background, view_width_value, view_height_value, view_x, view_y, quit_requested
end

--- Frame metadata the host needs but that does not belong in the draw buffer.
function __frame_info(): (number, number, number, number, number, number, boolean)
	local background = if current_room then current_room.background else 0
	return command_count, background, view_width_value, view_height_value, view_x, view_y, quit_requested
end

--=============================================================================
-- host handle
--=============================================================================

--[[
	Everything above is a real global, so game scripts can call `keyboard_check`
	and friends directly. The host, however, cannot read Luau globals back out
	of the state, so the functions it needs are returned here instead. The host
	resolves each one once at startup and keeps the reference.
]]
return {
	frame = __frame,
	frame_info = __frame_info,
	start = __start,
	reset = __reset,
	register_sprite = __register_sprite,
	register_tileset = __register_tileset,
	register_object = __register_object,
	register_room = __register_room,
	register_room_layer = __register_room_layer,
	register_font = __register_font,
	register_module = __register_module,

	-- Useful to the host and to tests for inspecting a running game.
	instance_number = instance_number,
	instance_exists = instance_exists,
	room_current = room_current,
}
