import { newTileLayer } from '../project/create';
import {
  DEFAULT_PALETTE,
  FORMAT_VERSION,
  type ObjectFile,
  type Project,
  type RoomFile,
  type SpriteFile,
  type TilesetFile,
} from '../project/types';
import { frameFromAscii } from './art';
import {
  BODY_ART,
  FIELD_ART,
  FIELD_PALETTE,
  FOOD_ART,
  FOOD_PALETTE,
  HEAD_ART,
  SNAKE_PALETTE,
} from './snakeArt';

/**
 * The Snake template.
 *
 * A whole game in one object: the snake keeps its body as an array of grid
 * cells and draws it with `draw_sprite_ext`, rather than spawning an instance
 * per segment. That is both the natural way to write Snake and a good showcase
 * of the drawing API.
 */

const CELL = 16;
const COLUMNS = 30;
const ROWS = 18;
const ROOM_WIDTH = COLUMNS * CELL;
const ROOM_HEIGHT = ROWS * CELL;

function sprite(name: string, frames: string[], fps = 10): SpriteFile {
  return {
    kind: 'sprite',
    version: FORMAT_VERSION,
    name,
    width: CELL,
    height: CELL,
    originX: CELL / 2,
    originY: CELL / 2,
    fps,
    frames,
    palette: [...DEFAULT_PALETTE],
    collision: { mode: 'rect', left: 0, top: 0, right: CELL - 1, bottom: CELL - 1 },
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

const SNAKE_SCRIPT = `--!strict
-- Snake. The whole game lives here.

local obj = {}

local CELL = ${CELL}
local COLUMNS = ${COLUMNS}
local ROWS = ${ROWS}

local START_LENGTH = 4
local START_DELAY = 10  -- steps between moves; lower is faster
local MIN_DELAY = 3

local DataStoreService = game:GetService("DataStoreService")
local saves = DataStoreService:GetDataStore("snake")

-- Screen position of the centre of a grid cell.
local function cell_centre(cx: number, cy: number): (number, number)
	return cx * CELL + CELL / 2, cy * CELL + CELL / 2
end

local function same_cell(a, b): boolean
	return a.x == b.x and a.y == b.y
end

local function occupied(self, cx: number, cy: number): boolean
	for _, part in self.body do
		if part.x == cx and part.y == cy then
			return true
		end
	end
	return false
end

local function place_food(self)
	-- Reject-sample rather than building the free list; the board is never
	-- full enough for this to matter. Row 0 sits under the HUD panel, so food
	-- there would be half hidden.
	for _ = 1, 500 do
		local cx = irandom(COLUMNS - 1)
		local cy = irandom_range(1, ROWS - 1)
		if not occupied(self, cx, cy) then
			self.food = { x = cx, y = cy }
			return
		end
	end
end

local function reset(self)
	self.body = {}
	local start_x = COLUMNS // 2
	local start_y = ROWS // 2
	for index = 0, START_LENGTH - 1 do
		table.insert(self.body, { x = start_x - index, y = start_y })
	end

	self.direction = { x = 1, y = 0 }
	self.queued = { x = 1, y = 0 }
	self.delay = START_DELAY
	self.timer = 0
	self.score = 0
	self.dead = false
	place_food(self)
end

function obj.create(self)
	self.best = saves:GetAsync("best")
	if self.best == nil then
		self.best = 0
		saves:SetAsync("best", 0)
	end
	reset(self)
end

local function read_direction(self)
	local dx, dy = 0, 0
	if keyboard_check("left") or keyboard_check("a") then
		dx = -1
	elseif keyboard_check("right") or keyboard_check("d") then
		dx = 1
	elseif keyboard_check("up") or keyboard_check("w") then
		dy = -1
	elseif keyboard_check("down") or keyboard_check("s") then
		dy = 1
	end

	if dx == 0 and dy == 0 then
		return
	end

	-- Reversing straight into your own neck is always a mistake, so ignore it.
	if dx == -self.direction.x and dy == -self.direction.y then
		return
	end

	self.queued = { x = dx, y = dy }
end

local function advance(self)
	self.direction = self.queued

	local head = self.body[1]
	local next_cell = { x = head.x + self.direction.x, y = head.y + self.direction.y }

	if
		next_cell.x < 0
		or next_cell.y < 0
		or next_cell.x >= COLUMNS
		or next_cell.y >= ROWS
		or occupied(self, next_cell.x, next_cell.y)
	then
		self.dead = true
		if self.score > self.best then
			self.best = self.score
			saves:SetAsync("best", self.score)
		end
		return
	end

	table.insert(self.body, 1, next_cell)

	if same_cell(next_cell, self.food) then
		self.score += 1
		self.delay = math.max(MIN_DELAY, START_DELAY - self.score // 3)
		place_food(self)
	else
		-- Only grow when eating; otherwise drop the tail.
		table.remove(self.body)
	end
end

function obj.step(self)
	if self.dead then
		if keyboard_check_pressed("r") then
			reset(self)
		end
		return
	end

	read_direction(self)

	self.timer += 1
	if self.timer >= self.delay then
		self.timer = 0
		advance(self)
	end
end

function obj.draw(self)
	local fx, fy = cell_centre(self.food.x, self.food.y)
	draw_sprite("spr_food", 0, fx, fy)

	-- Tinting is multiplicative, so colouring a green snake red would turn it
	-- black. Fade it out on death instead.
	local alpha = if self.dead then 0.5 else 1

	-- Tail first so the head overlaps it.
	for index = #self.body, 1, -1 do
		local part = self.body[index]
		local x, y = cell_centre(part.x, part.y)

		if index == 1 then
			local angle = point_direction(0, 0, self.direction.x, self.direction.y)
			draw_sprite_ext("spr_head", 0, x, y, 1, 1, angle, c_white, alpha)
		else
			-- Taper gently towards the tail; too much and it looks broken up.
			local taper = 1 - (index / #self.body) * 0.15
			draw_sprite_ext("spr_body", 0, x, y, taper, taper, 0, c_white, alpha)
		end
	end
end

function obj.draw_gui(self)
	draw_set_color(c_black)
	draw_set_alpha(0.55)
	draw_rectangle(0, 0, ${ROOM_WIDTH}, 22, false)
	draw_set_alpha(1)

	draw_text(8, 5, \`Score {self.score}\`, c_white)
	draw_text(120, 5, \`Best {self.best}\`, c_yellow)
	draw_text(240, 5, \`Length {#self.body}\`, c_white)

	if self.dead then
		local message = "Game over - press R"
		local width = string_width(message)
		draw_set_color(c_black)
		draw_set_alpha(0.75)
		draw_rectangle(
			${ROOM_WIDTH} / 2 - width / 2 - 10,
			${ROOM_HEIGHT} / 2 - 16,
			${ROOM_WIDTH} / 2 + width / 2 + 10,
			${ROOM_HEIGHT} / 2 + 16,
			false
		)
		draw_set_alpha(1)
		draw_text(${ROOM_WIDTH} / 2 - width / 2, ${ROOM_HEIGHT} / 2 - 6, message, c_red)
	end
end

return obj
`;

function buildField(): TilesetFile {
  return {
    kind: 'tileset',
    version: FORMAT_VERSION,
    name: 'ts_field',
    tileWidth: CELL,
    tileHeight: CELL,
    columns: 2,
    rows: 1,
    image: frameFromAscii(FIELD_ART, FIELD_PALETTE),
    // Nothing is solid: the snake checks the grid itself.
    solid: [false, false],
  };
}

function buildRoom(): RoomFile {
  const layer = newTileLayer('field', 'ts_field', COLUMNS, ROWS, 50);
  for (let row = 0; row < ROWS; row++) {
    for (let column = 0; column < COLUMNS; column++) {
      layer.tiles[row * COLUMNS + column] = (row + column) % 2;
    }
  }

  return {
    kind: 'room',
    version: FORMAT_VERSION,
    name: 'rm_snake',
    width: ROOM_WIDTH,
    height: ROOM_HEIGHT,
    backgroundColor: '#0d1018',
    gridWidth: CELL,
    gridHeight: CELL,
    instances: [
      { id: 'inst_1', object: 'obj_snake', x: 0, y: 0, xscale: 1, yscale: 1, angle: 0 },
    ],
    layers: [layer],
  };
}

export function buildSnakeProject(name = 'Snake'): Project {
  return {
    config: {
      kind: 'project',
      version: FORMAT_VERSION,
      name,
      startRoom: 'rm_snake',
      fps: 60,
      window: { width: ROOM_WIDTH, height: ROOM_HEIGHT, scale: 2, title: name },
    },
    sprites: [
      sprite('spr_head', [frameFromAscii(HEAD_ART, SNAKE_PALETTE)]),
      sprite('spr_body', [frameFromAscii(BODY_ART, SNAKE_PALETTE)]),
      sprite('spr_food', [frameFromAscii(FOOD_ART, FOOD_PALETTE)]),
    ],
    tilesets: [buildField()],
    objects: [{ def: object('obj_snake', null, 0), source: SNAKE_SCRIPT }],
    rooms: [buildRoom()],
    scripts: [],
  };
}
