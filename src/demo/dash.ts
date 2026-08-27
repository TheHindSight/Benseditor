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

/**
 * Dash: a Geometry Dash-style runner, written in Python.
 *
 * The cube runs right on its own; you only jump. Ground and platforms are a
 * tile layer (solid tiles block the cube, and a cube that stops moving has
 * hit a wall and dies); spikes and the finish are objects so the collision
 * event can catch them; a persistent controller follows with the camera and
 * draws the attempt counter and progress bar. Three objects, one level.
 */

const CELL = 16;
const COLUMNS = 200;
const ROWS = 18;
const ROOM_WIDTH = COLUMNS * CELL;
const ROOM_HEIGHT = ROWS * CELL;
const VIEW_WIDTH = 480;
/** Row of the top of the ground; everything stands on it. */
const GROUND_ROW = 16;

// ---- art ------------------------------------------------------------------

const CUBE_PALETTE = { k: '#000000', y: '#ffec27', o: '#ffa300', w: '#fff1e8' };
const CUBE_ART = [
  'kkkkkkkkkkkkkkkk',
  'kyyyyyyyyyyyyyyk',
  'kyooooooooooooyk',
  'kyokkkkkkkkkkoyk',
  'kyokwwkkkkwwkoyk',
  'kyokwwkkkkwwkoyk',
  'kyokkkkkkkkkkoyk',
  'kyokkkkkkkkkkoyk',
  'kyokkkkkkkkkkoyk',
  'kyokkkkkkkkkkoyk',
  'kyokkwwwwwwkkoyk',
  'kyokkkkkkkkkkoyk',
  'kyooooooooooooyk',
  'kyyyyyyyyyyyyyyk',
  'kkkkkkkkkkkkkkkk',
  '................',
];

const SPIKE_PALETTE = { k: '#000000', g: '#c2c3c7', w: '#fff1e8' };
const SPIKE_ART = [
  '................',
  '................',
  '................',
  '.......kk.......',
  '.......kk.......',
  '......kwwk......',
  '......kwwk......',
  '.....kwggwk.....',
  '.....kwggwk.....',
  '....kwggggwk....',
  '....kwggggwk....',
  '...kwggggggwk...',
  '...kwggggggwk...',
  '..kwggggggggwk..',
  '..kwggggggggwk..',
  '.kkkkkkkkkkkkkk.',
];

const FINISH_PALETTE = { k: '#000000', g: '#00e436', w: '#fff1e8' };
const FINISH_ART = [
  'kgwgwgwgwgwgwgwk',
  'kwgwgwgwgwgwgwgk',
  'kgwgwgwgwgwgwgwk',
  'kwgwgwgwgwgwgwgk',
  'kgwgwgwgwgwgwgwk',
  'kwgwgwgwgwgwgwgk',
  'kgwgwgwgwgwgwgwk',
  'kwgwgwgwgwgwgwgk',
  'kgwgwgwgwgwgwgwk',
  'kwgwgwgwgwgwgwgk',
  'kgwgwgwgwgwgwgwk',
  'kwgwgwgwgwgwgwgk',
  'kgwgwgwgwgwgwgwk',
  'kwgwgwgwgwgwgwgk',
  'kgwgwgwgwgwgwgwk',
  'kkkkkkkkkkkkkkkk',
];

/** Two tiles: a block, and a darker fill for the ground below the surface. */
const TILESET_PALETTE = { k: '#000000', b: '#29adff', B: '#1d2b53', d: '#83769c' };
const TILESET_ART = [
  'kkkkkkkkkkkkkkkkBBBBBBBBBBBBBBBB',
  'kbbbbbbbbbbbbbbkBBBBBBBBBBBBBBBB',
  'kbbbbbbbbbbbbbbkBBBBBBBBBBBBBBBB',
  'kbbkkkkkkkkkkbbkBBBBdBBBBBBBBBBB',
  'kbbkbbbbbbbbkbbkBBBBBBBBBBBBBBBB',
  'kbbkbbbbbbbbkbbkBBBBBBBBBBBBBBBB',
  'kbbkbbbbbbbbkbbkBBBBBBBBBBdBBBBB',
  'kbbkbbbbbbbbkbbkBBBBBBBBBBBBBBBB',
  'kbbkbbbbbbbbkbbkBBBBBBBBBBBBBBBB',
  'kbbkbbbbbbbbkbbkBBBBBBBBBBBBBBBB',
  'kbbkbbbbbbbbkbbkBBdBBBBBBBBBBBBB',
  'kbbkbbbbbbbbkbbkBBBBBBBBBBBBBBBB',
  'kbbkkkkkkkkkkbbkBBBBBBBBBBBBBBBB',
  'kbbbbbbbbbbbbbbkBBBBBBBBdBBBBBBB',
  'kbbbbbbbbbbbbbbkBBBBBBBBBBBBBBBB',
  'kkkkkkkkkkkkkkkkBBBBBBBBBBBBBBBB',
];

// ---- the level --------------------------------------------------------------

/**
 * The level as columns: `.` ground, `^` spike on the ground, `_` a pit,
 * `-` a platform three cells up (with ground below), `*` a platform with a
 * spike on it, `F` the finish.
 *
 * Tuned to the cube's numbers: at 4 px a step with a -9.5 jump under 0.7
 * gravity a jump covers about 108 px (6.8 cells) and rises 64 px (4 cells),
 * so triple spikes, four-cell pits and three-cell-high platforms are all
 * makeable, none of them lazily.
 */
const LEVEL =
  '........................^..........^^.........' +
  '---......^^^.......____........---......^.....' +
  '........^.^.^..........---**---.......^^^.....' +
  '....____.......^..............---.......^^....' +
  '.^.........^^.......---......____......F......';

function buildTiles(): number[] {
  const tiles = new Array(COLUMNS * ROWS).fill(-1);
  const set = (column: number, row: number, tile: number) => {
    if (column >= 0 && column < COLUMNS && row >= 0 && row < ROWS) tiles[row * COLUMNS + column] = tile;
  };
  for (let column = 0; column < COLUMNS; column++) {
    const symbol = LEVEL[column] ?? '.';
    if (symbol === '_') continue;
    set(column, GROUND_ROW, 0);
    for (let row = GROUND_ROW + 1; row < ROWS; row++) set(column, row, 1);
    if (symbol === '-' || symbol === '*') set(column, GROUND_ROW - 3, 0);
  }
  return tiles;
}

function placements(): RoomFile['instances'] {
  const instances: RoomFile['instances'] = [];
  let n = 1;
  const place = (object: string, column: number, row: number, name?: string) => {
    instances.push({
      id: `inst_${n++}`,
      object,
      x: column * CELL + CELL / 2,
      y: row * CELL + CELL / 2,
      xscale: 1,
      yscale: 1,
      angle: 0,
      ...(name ? { name } : {}),
    });
  };
  place('obj_controller', 0, 0, 'controller');
  place('obj_cube', 2, GROUND_ROW - 1, 'cube');
  for (let column = 0; column < COLUMNS; column++) {
    const symbol = LEVEL[column] ?? '.';
    if (symbol === '^') place('obj_spike', column, GROUND_ROW - 1);
    if (symbol === '*') place('obj_spike', column, GROUND_ROW - 4);
    if (symbol === 'F') for (let row = GROUND_ROW - 4; row < GROUND_ROW; row++) place('obj_finish', column, row, 'finish');
  }
  return instances;
}

// ---- scripts ------------------------------------------------------------------

const CUBE_SCRIPT = `# obj_cube: runs right on its own; you jump.

SPEED = 4
JUMP = -9.5
GRAVITY = 0.7
SPIN = 6            # degrees per step in the air


def _grounded(self):
    return self.place_meeting(self.x, self.y + 1, "tiles")


def _jump_pressed():
    return keyboard_check("space") or keyboard_check("up") or keyboard_check("w") or mouse_check_button("left")


def die(self):
    if self.dead:
        return
    self.dead = True
    self.visible = False
    self.hspeed = 0
    self.vspeed = 0
    self.gravity = 0
    ReplicatedStorage.Set("attempts", ReplicatedStorage.Get("attempts", 1) + 1)
    self.alarms[1] = 40  # restart after a moment


def create(self):
    self.hspeed = SPEED
    self.gravity = GRAVITY
    self.dead = False
    self.won = False
    self.spin = 0
    ReplicatedStorage.Set("progress", 0)


def step(self):
    if self.dead or self.won:
        return
    if _grounded(self):
        # Land square, the way the real thing snaps to the nearest face.
        self.image_angle = round(self.image_angle / 90) * 90
        if _jump_pressed():
            self.vspeed = JUMP
    else:
        self.image_angle -= SPIN
    # Progress for the controller's bar, and to keep the camera honest.
    ReplicatedStorage.Set("progress", self.x / room_width())


def step_end(self):
    if self.dead or self.won:
        return
    # Stopped moving forward: a wall. Fallen off the world: a pit.
    if self.x - self.xprevious < SPEED - 0.01:
        die(self)
    elif self.y > room_height() + 32:
        die(self)


def collision(self, other):
    if self.dead or self.won:
        return
    if other.is_a("obj_spike"):
        die(self)
    elif other.is_a("obj_finish"):
        self.won = True
        self.hspeed = 0
        self.vspeed = 0
        self.gravity = 0
        self.image_angle = 0
        ReplicatedStorage.Set("won", True)


def alarm(self, index):
    if index == 1:
        room_restart()
`;

const SPIKE_SCRIPT = `# obj_spike: deadly on touch. The cube's collision event does the work;
# this object only exists so it can be placed and seen.
`;

const FINISH_SCRIPT = `# obj_finish: the goal. Touching it ends the level.
`;

const CONTROLLER_SCRIPT = `# obj_controller: camera, attempt counter, progress bar. Persistent, so it
# survives every restart and keeps counting.

VIEW_WIDTH = ${VIEW_WIDTH}
LEAD = 140          # how far ahead of the cube the camera looks


def create(self):
    if ReplicatedStorage.Get("attempts", None) is None:
        ReplicatedStorage.Set("attempts", 1)
    ReplicatedStorage.Set("won", False)
    self.flash = 0


def room_start(self):
    # The room is ten screens wide; the view is one, and follows the cube.
    view_set_size(VIEW_WIDTH, room_height())
    ReplicatedStorage.Set("won", False)
    self.flash = 20  # a short "Attempt N" banner


def step_end(self):
    cube = workspace.FindFirstChild("cube")
    if cube is not None:
        x = clamp(cube.x - LEAD, 0, room_width() - VIEW_WIDTH)
        view_set(x, 0)
    if self.flash > 0:
        self.flash -= 1
    if keyboard_check_pressed("r"):
        room_restart()


def draw_gui(self):
    attempts = ReplicatedStorage.Get("attempts", 1)
    progress = clamp(ReplicatedStorage.Get("progress", 0), 0, 1)
    # Drawing is in room coordinates, so the HUD follows the view by hand.
    vx, vy = view_get()

    # Progress bar along the top.
    draw_set_color(c_black)
    draw_rectangle(vx + 140, vy + 6, vx + 340, vy + 14, False)
    draw_set_color(c_green)
    draw_rectangle(vx + 141, vy + 7, vx + 141 + 198 * progress, vy + 13, False)
    draw_text(vx + 346, vy + 4, f"{int(progress * 100)}%", c_white)

    draw_text(vx + 6, vy + 4, f"Attempt {attempts}", c_white)

    if ReplicatedStorage.Get("won", False):
        draw_text(vx + VIEW_WIDTH / 2 - string_width("LEVEL COMPLETE") / 2, vy + 120, "LEVEL COMPLETE", c_yellow)
        draw_text(vx + VIEW_WIDTH / 2 - string_width("press R to play again") / 2, vy + 140, "press R to play again", c_white)
    elif self.flash > 0:
        draw_text(vx + VIEW_WIDTH / 2 - string_width(f"Attempt {attempts}") / 2, vy + 120, f"Attempt {attempts}", c_yellow)
`;

// ---- assembly -------------------------------------------------------------------

function sprite(name: string, rows: string[], palette: Record<string, string>, collision: SpriteFile['collision']): SpriteFile {
  return {
    kind: 'sprite',
    version: FORMAT_VERSION,
    name,
    width: CELL,
    height: CELL,
    originX: CELL / 2,
    originY: CELL / 2,
    fps: 0,
    frames: [frameFromAscii(rows, palette)],
    palette: [...DEFAULT_PALETTE],
    collision,
  };
}

function object(name: string, spriteName: string, extra: Partial<ObjectFile> = {}): ObjectFile {
  return {
    kind: 'object',
    version: FORMAT_VERSION,
    name,
    sprite: spriteName,
    depth: 0,
    visible: true,
    solid: false,
    persistent: false,
    parent: null,
    ...extra,
  };
}

export function buildDashProject(name = 'Dash'): Project {
  const tileset: TilesetFile = {
    kind: 'tileset',
    version: FORMAT_VERSION,
    name: 'ts_blocks',
    tileWidth: CELL,
    tileHeight: CELL,
    offsetX: 0,
    offsetY: 0,
    spacingX: 0,
    spacingY: 0,
    columns: 2,
    rows: 1,
    image: frameFromAscii(TILESET_ART, TILESET_PALETTE),
    solid: [true, true],
  };

  const layer = newTileLayer('ground', 'ts_blocks', COLUMNS, ROWS, 10);
  layer.tiles = buildTiles();

  const room: RoomFile = {
    kind: 'room',
    version: FORMAT_VERSION,
    name: 'rm_level1',
    width: ROOM_WIDTH,
    height: ROOM_HEIGHT,
    backgroundColor: '#1d2b53',
    gridWidth: CELL,
    gridHeight: CELL,
    instances: placements(),
    layers: [layer],
  };

  return {
    config: {
      kind: 'project',
      version: FORMAT_VERSION,
      name,
      startRoom: 'rm_level1',
      fps: 60,
      window: { width: VIEW_WIDTH, height: ROOM_HEIGHT, scale: 2, title: name },
      language: 'python',
    },
    sprites: [
      sprite('spr_cube', CUBE_ART, CUBE_PALETTE, { mode: 'rect', left: 0, top: 0, right: 15, bottom: 14 }),
      // A spike's deadly part is narrower than its tile, so grazing one is forgiven.
      sprite('spr_spike', SPIKE_ART, SPIKE_PALETTE, { mode: 'rect', left: 5, top: 6, right: 10, bottom: 15 }),
      sprite('spr_finish', FINISH_ART, FINISH_PALETTE, { mode: 'rect', left: 0, top: 0, right: 15, bottom: 15 }),
    ],
    tilesets: [tileset],
    objects: [
      { def: object('obj_cube', 'spr_cube', { blockedBy: ['tiles'] }), source: CUBE_SCRIPT },
      { def: object('obj_spike', 'spr_spike', { blockedBy: [] }), source: SPIKE_SCRIPT },
      { def: object('obj_finish', 'spr_finish', { blockedBy: [] }), source: FINISH_SCRIPT },
      {
        def: object('obj_controller', 'spr_cube', { depth: -100, visible: false, persistent: true, blockedBy: [] }),
        source: CONTROLLER_SCRIPT,
      },
    ],
    rooms: [room],
    scripts: [],
  };
}
