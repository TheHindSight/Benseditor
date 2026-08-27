import type { ObjectFile, ScriptLanguage } from './types';

/**
 * Ready-made objects, offered when creating one.
 *
 * Each is a working behaviour, not a snippet: pick Player, drop it in a room
 * with some walls, and it moves and collides with nothing else written. The
 * scripts assume the conventional names (`obj_player`, `obj_wall`) and say so
 * in a comment where they do, since a template cannot know what things will
 * be called.
 *
 * Movement templates lean on the engine's declarative blocking (`blockedBy`)
 * rather than hand-written collision checks -- that is the whole point of it.
 *
 * Every template is written twice, once per scripting language, doing the
 * same thing: the Python one is the Luau one with the module table gone
 * (a Python module's namespace is the table) and methods called with a dot.
 */

export interface ObjectTemplate {
  id: string;
  label: string;
  /** One line under the label in the picker. */
  hint: string;
  /** Suggested name, used when the field still holds the plain prefix. */
  suggestedName: string;
  def: Partial<ObjectFile>;
  /** Per language; empty means "use the language's default new-object source". */
  source: Record<ScriptLanguage, string>;
}

const PLAYER_TOPDOWN_LUAU = `--!strict
-- Top-down player: arrows or WASD, engine handles the walls.
--
-- Blocked by obj_wall and solid tiles (see Collision in the object's panel),
-- so movement is just setting hspeed and vspeed.

local obj = {}

local SPEED = 2

local function axis(a: string, b: string): number
	return if keyboard_check(a) or keyboard_check(b) then 1 else 0
end

function obj.step(self)
	self.hspeed = (axis("right", "d") - axis("left", "a")) * SPEED
	self.vspeed = (axis("down", "s") - axis("up", "w")) * SPEED

	if self.hspeed ~= 0 then
		self.image_xscale = if self.hspeed > 0 then 1 else -1
	end
end

return obj
`;

const PLAYER_TOPDOWN_PYTHON = `# Top-down player: arrows or WASD, engine handles the walls.
#
# Blocked by obj_wall and solid tiles (see Collision in the object's panel),
# so movement is just setting hspeed and vspeed.

SPEED = 2


def axis(a, b):
    return 1 if keyboard_check(a) or keyboard_check(b) else 0


def step(self):
    self.hspeed = (axis("right", "d") - axis("left", "a")) * SPEED
    self.vspeed = (axis("down", "s") - axis("up", "w")) * SPEED

    if self.hspeed != 0:
        self.image_xscale = 1 if self.hspeed > 0 else -1
`;

const PLAYER_PLATFORMER_LUAU = `--!strict
-- Platformer player: run, gravity, jump.
--
-- Blocked by obj_wall and solid tiles, so landing and head-bumps come from
-- the engine; the script only decides what the speeds should be.

local obj = {}

local RUN = 2.4
local JUMP = 6.5
local GRAVITY = 0.35

local function held(a: string, b: string): boolean
	return keyboard_check(a) or keyboard_check(b)
end

local function on_ground(self): boolean
	return self:place_meeting(self.x, self.y + 1, "tiles")
		or self:place_meeting(self.x, self.y + 1, "obj_wall")
end

function obj.create(self)
	self.gravity = GRAVITY
end

function obj.step(self)
	local direction = (if held("right", "d") then 1 else 0) - (if held("left", "a") then 1 else 0)
	self.hspeed = direction * RUN
	if direction ~= 0 then
		self.image_xscale = direction
	end

	if on_ground(self) then
		if keyboard_check_pressed("up") or keyboard_check_pressed("space") or keyboard_check_pressed("w") then
			self.vspeed = -JUMP
		end
	end
end

return obj
`;

const PLAYER_PLATFORMER_PYTHON = `# Platformer player: run, gravity, jump.
#
# Blocked by obj_wall and solid tiles, so landing and head-bumps come from
# the engine; the script only decides what the speeds should be.

RUN = 2.4
JUMP = 6.5
GRAVITY = 0.35


def held(a, b):
    return keyboard_check(a) or keyboard_check(b)


def on_ground(self):
    return (self.place_meeting(self.x, self.y + 1, "tiles")
            or self.place_meeting(self.x, self.y + 1, "obj_wall"))


def create(self):
    self.gravity = GRAVITY


def step(self):
    direction = (1 if held("right", "d") else 0) - (1 if held("left", "a") else 0)
    self.hspeed = direction * RUN
    if direction != 0:
        self.image_xscale = direction

    if on_ground(self):
        if keyboard_check_pressed("up") or keyboard_check_pressed("space") or keyboard_check_pressed("w"):
            self.vspeed = -JUMP
`;

const WALL_LUAU = `--!strict
-- A solid block. No behaviour of its own: other objects list it under
-- Collision, and the engine keeps them out.

return {}
`;

const WALL_PYTHON = `# A solid block. No behaviour of its own: other objects list it under
# Collision, and the engine keeps them out.
`;

const COLLECTIBLE_LUAU = `--!strict
-- A pickup that bobs in place and counts itself when the player touches it.
-- Expects the player to be obj_player; edit the name below if yours differs.

local obj = {}

function obj.create(self)
	self.base_y = self.y
	self.timer = irandom(60)
end

function obj.step(self)
	self.timer += 1
	self.y = self.base_y + math.sin(self.timer * 0.08) * 3
end

function obj.collision(self, other)
	if other:is_a("obj_player") then
		local storage = game:GetService("ReplicatedStorage")
		storage:Set("score", storage:Get("score", 0) + 1)
		self:destroy()
	end
end

return obj
`;

const COLLECTIBLE_PYTHON = `# A pickup that bobs in place and counts itself when the player touches it.
# Expects the player to be obj_player; edit the name below if yours differs.

import math


def create(self):
    self.base_y = self.y
    self.timer = irandom(60)


def step(self):
    self.timer += 1
    self.y = self.base_y + math.sin(self.timer * 0.08) * 3


def collision(self, other):
    if other.is_a("obj_player"):
        storage = game.GetService("ReplicatedStorage")
        storage.Set("score", storage.Get("score", 0) + 1)
        self.destroy()
`;

const ENEMY_PATROL_LUAU = `--!strict
-- Walks back and forth, turning at walls and at ledges.
-- Blocked by obj_wall and solid tiles; expects gravity-style floors.

local obj = {}

local SPEED = 1

function obj.create(self)
	self.direction_x = 1
end

function obj.step(self)
	-- Turn at a wall...
	if self:place_meeting(self.x + self.direction_x * SPEED, self.y, "obj_wall")
		or self:place_meeting(self.x + self.direction_x * SPEED, self.y, "tiles")
	then
		self.direction_x = -self.direction_x
	end

	-- ...and at the edge of the floor, rather than walking off it.
	local ahead_x = self.x + self.direction_x * (self:sprite_width() / 2 + 1)
	local floor_below = self:place_meeting(ahead_x, self.y + 2, "tiles")
		or self:place_meeting(ahead_x, self.y + 2, "obj_wall")
	if not floor_below then
		self.direction_x = -self.direction_x
	end

	self.hspeed = self.direction_x * SPEED
	self.image_xscale = self.direction_x
end

return obj
`;

const ENEMY_PATROL_PYTHON = `# Walks back and forth, turning at walls and at ledges.
# Blocked by obj_wall and solid tiles; expects gravity-style floors.

SPEED = 1


def create(self):
    self.direction_x = 1


def step(self):
    # Turn at a wall...
    if (self.place_meeting(self.x + self.direction_x * SPEED, self.y, "obj_wall")
            or self.place_meeting(self.x + self.direction_x * SPEED, self.y, "tiles")):
        self.direction_x = -self.direction_x

    # ...and at the edge of the floor, rather than walking off it.
    ahead_x = self.x + self.direction_x * (self.sprite_width() / 2 + 1)
    floor_below = (self.place_meeting(ahead_x, self.y + 2, "tiles")
                   or self.place_meeting(ahead_x, self.y + 2, "obj_wall"))
    if not floor_below:
        self.direction_x = -self.direction_x

    self.hspeed = self.direction_x * SPEED
    self.image_xscale = self.direction_x
`;

const BULLET_LUAU = `--!strict
-- Flies in a straight line and disappears off the edge of the room.
-- Create one with instance_create, then aim it:
--
--   local b = instance_create(self.x, self.y, "obj_bullet")
--   b:set_speed(6, point_direction(self.x, self.y, mouse_x(), mouse_y()))

local obj = {}

function obj.step(self)
	if self.x < -32 or self.y < -32 or self.x > room_width() + 32 or self.y > room_height() + 32 then
		self:destroy()
	end
end

return obj
`;

const BULLET_PYTHON = `# Flies in a straight line and disappears off the edge of the room.
# Create one with instance_create, then aim it:
#
#   b = instance_create(self.x, self.y, "obj_bullet")
#   b.set_speed(6, point_direction(self.x, self.y, mouse_x(), mouse_y()))


def step(self):
    if self.x < -32 or self.y < -32 or self.x > room_width() + 32 or self.y > room_height() + 32:
        self.destroy()
`;

const CONTROLLER_LUAU = `--!strict
-- Game controller: draws the score, follows the player with the camera,
-- and restarts on R. One per room, usually invisible.

local obj = {}

local storage = game:GetService("ReplicatedStorage")

function obj.create(self)
	storage:Set("score", storage:Get("score", 0))
end

function obj.step(self)
	if keyboard_check_pressed("r") then
		storage:Set("score", 0)
		room_restart()
	end

	-- Centre the view on the player when the room is bigger than the screen.
	local player = instance_find("obj_player")
	if player then
		view_set(
			clamp(player.x - room_width() / 2, 0, room_width()),
			clamp(player.y - room_height() / 2, 0, room_height())
		)
	end
end

function obj.draw_gui(self)
	local view_x, view_y = view_get()
	local text = \`Score {storage:Get("score", 0)}\`
	draw_set_color(c_black)
	draw_set_alpha(0.55)
	draw_rectangle(view_x + 4, view_y + 4, view_x + 16 + string_width(text), view_y + 22, false)
	draw_set_alpha(1)
	draw_text(view_x + 10, view_y + 8, text, c_white)
end

return obj
`;

const CONTROLLER_PYTHON = `# Game controller: draws the score, follows the player with the camera,
# and restarts on R. One per room, usually invisible.

storage = game.GetService("ReplicatedStorage")


def create(self):
    storage.Set("score", storage.Get("score", 0))


def step(self):
    if keyboard_check_pressed("r"):
        storage.Set("score", 0)
        room_restart()

    # Centre the view on the player when the room is bigger than the screen.
    player = instance_find("obj_player")
    if player:
        view_set(
            clamp(player.x - room_width() / 2, 0, room_width()),
            clamp(player.y - room_height() / 2, 0, room_height()),
        )


def draw_gui(self):
    view_x, view_y = view_get()
    score = storage.Get("score", 0)
    text = f"Score {score}"
    draw_set_color(c_black)
    draw_set_alpha(0.55)
    draw_rectangle(view_x + 4, view_y + 4, view_x + 16 + string_width(text), view_y + 22, False)
    draw_set_alpha(1)
    draw_text(view_x + 10, view_y + 8, text, c_white)
`;

export const OBJECT_TEMPLATES: ObjectTemplate[] = [
  {
    id: 'blank',
    label: 'Blank',
    hint: 'An empty object with create and step stubs.',
    suggestedName: 'obj_thing',
    def: {},
    source: { luau: '', python: '' }, // Filled in by newObject's default.
  },
  {
    id: 'player-topdown',
    label: 'Player — top-down',
    hint: 'Arrows or WASD. Walls and solid tiles block it.',
    suggestedName: 'obj_player',
    def: { blockedBy: ['obj_wall', 'tiles'] },
    source: { luau: PLAYER_TOPDOWN_LUAU, python: PLAYER_TOPDOWN_PYTHON },
  },
  {
    id: 'player-platformer',
    label: 'Player — platformer',
    hint: 'Run and jump, with gravity. Walls and solid tiles block it.',
    suggestedName: 'obj_player',
    def: { blockedBy: ['obj_wall', 'tiles'] },
    source: { luau: PLAYER_PLATFORMER_LUAU, python: PLAYER_PLATFORMER_PYTHON },
  },
  {
    id: 'wall',
    label: 'Wall',
    hint: 'A solid block for others to collide with.',
    suggestedName: 'obj_wall',
    def: { solid: true, depth: 10 },
    source: { luau: WALL_LUAU, python: WALL_PYTHON },
  },
  {
    id: 'collectible',
    label: 'Collectible',
    hint: 'Bobs in place; the player picks it up for a point.',
    suggestedName: 'obj_coin',
    def: { depth: 5 },
    source: { luau: COLLECTIBLE_LUAU, python: COLLECTIBLE_PYTHON },
  },
  {
    id: 'enemy-patrol',
    label: 'Enemy — patrol',
    hint: 'Paces back and forth, turning at walls and ledges.',
    suggestedName: 'obj_enemy',
    def: { blockedBy: ['obj_wall', 'tiles'] },
    source: { luau: ENEMY_PATROL_LUAU, python: ENEMY_PATROL_PYTHON },
  },
  {
    id: 'bullet',
    label: 'Bullet',
    hint: 'Flies straight and vanishes off-screen.',
    suggestedName: 'obj_bullet',
    def: {},
    source: { luau: BULLET_LUAU, python: BULLET_PYTHON },
  },
  {
    id: 'controller',
    label: 'Controller',
    hint: 'Score HUD, camera follow, R to restart.',
    suggestedName: 'obj_controller',
    def: { visible: false, depth: -100 },
    source: { luau: CONTROLLER_LUAU, python: CONTROLLER_PYTHON },
  },
];
