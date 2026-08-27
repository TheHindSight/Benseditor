import {
  DEFAULT_PALETTE,
  FORMAT_VERSION,
  type ObjectFile,
  type Project,
  type RoomFile,
  type RoomInstance,
  type SpriteFile,
} from '../project/types';
import {
  COIN_FRAMES,
  COIN_PALETTE,
  PLAYER_ART,
  PLAYER_PALETTE,
  TILESET_ART,
  TILESET_PALETTE,
  WALL_ART,
  WALL_PALETTE,
  frameFromAscii,
} from './art';
import { newTileLayer } from '../project/create';
import type { TilesetFile } from '../project/types';

/**
 * The starter project: a playable coin-collector.
 *
 * Exercises the whole pipeline -- animated sprites, wall collision, alarms,
 * HUD drawing and room restarts -- so a new project is something to modify
 * rather than a blank page.
 */

const ROOM_WIDTH = 480;
const ROOM_HEIGHT = 288;
const TILE = 16;

function sprite(
  name: string,
  size: number,
  originX: number,
  originY: number,
  fps: number,
  frames: string[],
  collision: { left: number; top: number; right: number; bottom: number },
): SpriteFile {
  return {
    kind: 'sprite',
    version: FORMAT_VERSION,
    name,
    width: size,
    height: size,
    originX,
    originY,
    fps,
    frames,
    palette: [...DEFAULT_PALETTE],
    collision: { mode: 'rect', ...collision },
  };
}

function object(name: string, spriteName: string | null, depth: number): ObjectFile {
  return {
    kind: 'object',
    version: FORMAT_VERSION,
    name,
    sprite: spriteName,
    depth,
    visible: true,
    solid: false,
    persistent: false,
    parent: null,
  };
}

const PLAYER_SCRIPT = `--!strict
-- The player: arrows or WASD to move, bump into walls, collect coins.

local obj = {}

local SPEED = 2

local function axis(a: string, b: string): number
	return if keyboard_check(a) or keyboard_check(b) then 1 else 0
end

-- One axis at a time, so sliding along a wall still works.
-- "tiles" tests the room's solid tiles, the same way an object name tests
-- instances, so the stone platform blocks movement without any objects.
local function blocked(self, x: number, y: number): boolean
	return self:place_meeting(x, y, "obj_wall") or self:place_meeting(x, y, "tiles")
end

local function move_axis(self, dx: number, dy: number)
	if dx == 0 and dy == 0 then
		return
	end
	if blocked(self, self.x + dx, self.y + dy) then
		-- Step up to whichever is closer.
		self:move_contact("obj_wall", dx, dy)
		if blocked(self, self.x + dx, self.y + dy) then
			self:move_contact("tiles", dx, dy)
		end
	else
		self.x += dx
		self.y += dy
	end
end

function obj.create(self)
	self.score = 0
end

function obj.step(self)
	local move_x = axis("right", "d") - axis("left", "a")
	local move_y = axis("down", "s") - axis("up", "w")

	move_axis(self, move_x * SPEED, 0)
	move_axis(self, 0, move_y * SPEED)

	if move_x ~= 0 then
		self.image_xscale = if move_x > 0 then 1 else -1
	end
end

function obj.collision(self, other)
	if other:is_a("obj_coin") then
		other:destroy()
		self.score += 1
	end
end

return obj
`;

const WALL_SCRIPT = `--!strict
-- A solid block. No behaviour -- it just sits there and gets collided with.

return {}
`;

const COIN_SCRIPT = `--!strict
-- A spinning coin that bobs in place.

local obj = {}

function obj.create(self)
	self.base_y = self.y
	-- Stagger the bob so a row of coins does not move in lockstep.
	self.timer = irandom(60)
end

function obj.step(self)
	self.timer += 1
	self.y = self.base_y + math.sin(self.timer * 0.08) * 3
end

return obj
`;

const CONTROLLER_SCRIPT = `--!strict
-- Draws the HUD, handles restarting, and remembers your best run.

local obj = {}

local DataStoreService = game:GetService("DataStoreService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")

local saves = DataStoreService:GetDataStore("demo")

function obj.create(self)
	-- Persisted across reloads by the host.
	self.best = saves:GetAsync("best")
	if self.best == nil then
		-- First run on this machine: create the save slot.
		self.best = 0
		saves:SetAsync("best", 0)
	end
	ReplicatedStorage:Set("coinsCollected", 0)

	-- Signals are an alternative to the step event.
	UserInputService.InputBegan:Connect(function(input)
		if input.KeyCode == "r" then
			room_restart()
		end
	end)

	-- Flash the banner for a moment when everything is collected.
	self.celebrating = false
end

function obj.step(self)
	local player = instance_find("obj_player")
	local score = if player then player.score else 0
	ReplicatedStorage:Set("coinsCollected", score)

	if score > self.best then
		self.best = score
		saves:SetAsync("best", score)
	end

	if not self.celebrating and instance_number("obj_coin") == 0 then
		self.celebrating = true
		task.delay(0.75, function()
			self.celebrating = false
		end)
	end
end

function obj.draw_gui(self)
	local player = instance_find("obj_player")
	local collected = if player then player.score else 0
	local remaining = instance_number("obj_coin")

	local top = \`Coins {collected} / {collected + remaining}   Best {self.best}\`
	local bottom = if remaining == 0
		then "All collected! Press R to play again."
		else "Arrows or WASD to move - R restarts"

	-- A dimmed panel keeps the HUD readable over the brickwork.
	local width = math.max(string_width(top), string_width(bottom)) + 12
	draw_set_color(c_black)
	draw_set_alpha(0.55)
	draw_rectangle(4, 4, 4 + width, 42, false)
	draw_set_alpha(1)

	draw_text(10, 8, top, c_white)
	draw_text(10, 24, bottom, if remaining == 0 then c_yellow else c_white)
end

return obj
`;

const HELPERS_SCRIPT = `--!strict
-- Shared helpers. Any module here runs before object scripts, so anything it
-- assigns as a global is visible to every object.

function grid_snap(value: number, size: number): number
	return math.floor(value / size) * size
end
`;

function buildTileset(): TilesetFile {
  return {
    kind: 'tileset',
    version: FORMAT_VERSION,
    name: 'ts_stone',
    tileWidth: TILE,
    tileHeight: TILE,
    columns: 4,
    rows: 1,
    image: frameFromAscii(TILESET_ART, TILESET_PALETTE),
    // The two stone tiles block movement; rubble and the grate do not.
    solid: [true, true, false, false],
  };
}

/**
 * A small solid platform, away from the border so it does not interfere with
 * the objects already in the room.
 */
function buildTileLayer(): ReturnType<typeof newTileLayer> {
  const columns = ROOM_WIDTH / TILE;
  const rows = ROOM_HEIGHT / TILE;
  const layer = newTileLayer('stone', 'ts_stone', columns, rows, 20);

  for (let row = 8; row <= 11; row++) {
    for (let column = 2; column <= 6; column++) {
      // Solid stone on top, plain stone below, rubble at the base.
      const tile = row === 8 ? 1 : row === 11 ? 2 : 0;
      layer.tiles[row * columns + column] = tile;
    }
  }

  return layer;
}

/** Border walls, a couple of obstacles, coins and the player. */
function buildRoom(): RoomFile {
  const instances: RoomInstance[] = [];
  let counter = 0;
  const add = (objectName: string, x: number, y: number) => {
    instances.push({
      id: `inst_${++counter}`,
      object: objectName,
      x,
      y,
      xscale: 1,
      yscale: 1,
      angle: 0,
    });
  };

  const columns = ROOM_WIDTH / TILE;
  const rows = ROOM_HEIGHT / TILE;

  for (let column = 0; column < columns; column++) {
    add('obj_wall', column * TILE, 0);
    add('obj_wall', column * TILE, (rows - 1) * TILE);
  }
  for (let row = 1; row < rows - 1; row++) {
    add('obj_wall', 0, row * TILE);
    add('obj_wall', (columns - 1) * TILE, row * TILE);
  }

  for (let i = 0; i < 5; i++) {
    add('obj_wall', 7 * TILE + i * TILE, 6 * TILE);
    add('obj_wall', 18 * TILE + i * TILE, 11 * TILE);
  }
  for (let i = 0; i < 3; i++) {
    add('obj_wall', 7 * TILE, 7 * TILE + i * TILE);
    add('obj_wall', 22 * TILE, 8 * TILE + i * TILE);
  }

  const coinSpots: [number, number][] = [
    [4, 3], [12, 3], [25, 4], [3, 12], [10, 9], [16, 8], [26, 14], [20, 15],
  ];
  for (const [column, row] of coinSpots) {
    add('obj_coin', column * TILE + TILE / 2, row * TILE + TILE / 2);
  }

  add('obj_player', 15 * TILE, 13 * TILE);
  add('obj_controller', 0, 0);

  return {
    kind: 'room',
    version: FORMAT_VERSION,
    name: 'rm_main',
    width: ROOM_WIDTH,
    height: ROOM_HEIGHT,
    backgroundColor: '#1d2b53',
    gridWidth: TILE,
    gridHeight: TILE,
    instances,
    layers: [buildTileLayer()],
  };
}

export function buildStarterProject(name = 'Demo Game'): Project {
  return {
    config: {
      kind: 'project',
      version: FORMAT_VERSION,
      name,
      startRoom: 'rm_main',
      fps: 60,
      window: { width: ROOM_WIDTH, height: ROOM_HEIGHT, scale: 2, title: name },
    },
    sprites: [
      sprite('spr_player', 16, 8, 8, 12, [frameFromAscii(PLAYER_ART, PLAYER_PALETTE)], {
        left: 3, top: 1, right: 12, bottom: 15,
      }),
      sprite('spr_wall', 16, 0, 0, 12, [frameFromAscii(WALL_ART, WALL_PALETTE)], {
        left: 0, top: 0, right: 15, bottom: 15,
      }),
      sprite(
        'spr_coin',
        8, 4, 4, 10,
        COIN_FRAMES.map((frame) => frameFromAscii(frame, COIN_PALETTE)),
        { left: 1, top: 1, right: 6, bottom: 6 },
      ),
    ],
    tilesets: [buildTileset()],
    objects: [
      { def: object('obj_player', 'spr_player', 0), source: PLAYER_SCRIPT },
      { def: object('obj_wall', 'spr_wall', 10), source: WALL_SCRIPT },
      { def: object('obj_coin', 'spr_coin', 5), source: COIN_SCRIPT },
      { def: object('obj_controller', null, -100), source: CONTROLLER_SCRIPT },
    ],
    rooms: [buildRoom()],
    scripts: [{ name: 'helpers', source: HELPERS_SCRIPT }],
  };
}
