/**
 * Contents of a new Benseditor project.
 *
 * The starter game exercises the whole pipeline -- animated sprites, object
 * events, collisions, GUI drawing and room restarts -- so a new project is
 * something to modify rather than a blank page. Deliberately free of any
 * `vscode` import so it can be generated and tested outside the editor.
 */

import { frameFromAscii } from '../png';
import {
  DEFAULT_PALETTE,
  FORMAT_VERSION,
  ObjectFile,
  RoomFile,
  RoomInstance,
  SpriteFile,
  newProjectFile,
} from './assets';

const ROOM_WIDTH = 480;
const ROOM_HEIGHT = 288;
const TILE = 16;

const PLAYER_ART = [
  '................',
  '....kkkkkkkk....',
  '...kbbbbbbbbk...',
  '...kbwbbbbwbk...',
  '...kbbbbbbbbk...',
  '...kbbkkkkbbk...',
  '...kbbbbbbbbk...',
  '....kbbbbbbk....',
  '.....kkkkkk.....',
  '....kbbbbbbk....',
  '...kbbbbbbbbk...',
  '...kbbbbbbbbk...',
  '...kbb....bbk...',
  '....kk....kk....',
  '....kk....kk....',
  '...kkkk..kkkk...',
];

// The outline must not match the room background, or the sprite reads as
// disconnected fragments.
const PLAYER_PALETTE = { k: '#000000', b: '#29adff', w: '#fff1e8' };

const WALL_ART = [
  'GGGGGGGGGGGGGGGG',
  'GddddddGdddddddG',
  'GddddddGdddddddG',
  'GddddddGdddddddG',
  'GGGGGGGGGGGGGGGG',
  'GdddGddddddddddG',
  'GdddGddddddddddG',
  'GdddGddddddddddG',
  'GGGGGGGGGGGGGGGG',
  'GddddddGdddddddG',
  'GddddddGdddddddG',
  'GddddddGdddddddG',
  'GGGGGGGGGGGGGGGG',
  'GdddGddddddddddG',
  'GdddGddddddddddG',
  'GGGGGGGGGGGGGGGG',
];

const WALL_PALETTE = { G: '#5f574f', d: '#ab5236' };

const COIN_PALETTE = { y: '#ffa300', Y: '#ffec27', w: '#fff1e8' };

const COIN_FRAMES = [
  [
    '..yyyy..',
    '.yYYYYy.',
    'yYYwwYYy',
    'yYwwwwYy',
    'yYwwwwYy',
    'yYYwwYYy',
    '.yYYYYy.',
    '..yyyy..',
  ],
  [
    '...yy...',
    '..yYYy..',
    '..yYwy..',
    '..ywwy..',
    '..ywwy..',
    '..yYwy..',
    '..yYYy..',
    '...yy...',
  ],
  [
    '...y....',
    '...yy...',
    '...yy...',
    '...yy...',
    '...yy...',
    '...yy...',
    '...yy...',
    '...y....',
  ],
  [
    '...yy...',
    '..yYYy..',
    '..ywYy..',
    '..ywwy..',
    '..ywwy..',
    '..ywYy..',
    '..yYYy..',
    '...yy...',
  ],
];

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

  // Two interior blocks to bump into.
  for (let i = 0; i < 5; i++) {
    add('obj_wall', 7 * TILE + i * TILE, 6 * TILE);
    add('obj_wall', 18 * TILE + i * TILE, 11 * TILE);
  }
  for (let i = 0; i < 3; i++) {
    add('obj_wall', 7 * TILE, 7 * TILE + i * TILE);
    add('obj_wall', 22 * TILE, 8 * TILE + i * TILE);
  }

  const coinSpots: [number, number][] = [
    [4, 3],
    [12, 3],
    [25, 4],
    [3, 12],
    [10, 9],
    [16, 8],
    [26, 14],
    [20, 15],
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
  };
}

const PLAYER_SCRIPT = `"""The player: arrow keys or WASD to move, bump into walls, collect coins."""

from benseditor import GameObject, keyboard_check

SPEED = 2.0


class obj_player(GameObject):
    def create(self):
        self.score = 0

    def step(self):
        move_x = _axis("right", "d") - _axis("left", "a")
        move_y = _axis("down", "s") - _axis("up", "w")

        # Move one axis at a time so sliding along a wall still works.
        self._move_axis(move_x * SPEED, 0.0)
        self._move_axis(0.0, move_y * SPEED)

        if move_x:
            self.image_xscale = 1.0 if move_x > 0 else -1.0

    def collision(self, other):
        if other.is_a("obj_coin"):
            other.destroy()
            self.score += 1

    def _move_axis(self, dx, dy):
        if not dx and not dy:
            return
        if self.place_meeting(self.x + dx, self.y + dy, "obj_wall"):
            self.move_contact("obj_wall", dx, dy)
        else:
            self.x += dx
            self.y += dy


def _axis(*keys):
    return 1 if any(keyboard_check(key) for key in keys) else 0
`;

const WALL_SCRIPT = `"""A solid block. No behaviour -- it just sits there and gets collided with."""

from benseditor import GameObject


class obj_wall(GameObject):
    pass
`;

const COIN_SCRIPT = `"""A spinning coin that bobs in place."""

import math

from benseditor import GameObject, irandom


class obj_coin(GameObject):
    def create(self):
        self.base_y = self.y
        # Stagger the bob so a row of coins does not move in lockstep.
        self.timer = irandom(60)

    def step(self):
        self.timer += 1
        self.y = self.base_y + math.sin(self.timer * 0.08) * 3
`;

const CONTROLLER_SCRIPT = `"""Draws the HUD and handles restarting."""

from benseditor import (
    GameObject,
    c_white,
    c_yellow,
    draw_text,
    instance_exists,
    instance_find,
    instance_number,
    keyboard_check_pressed,
    room_restart,
)


class obj_controller(GameObject):
    def step(self):
        if keyboard_check_pressed("r"):
            room_restart()

    def draw_gui(self):
        player = instance_find("obj_player")
        collected = player.score if player else 0
        total = collected + instance_number("obj_coin")

        draw_text(8, 6, f"Coins {collected} / {total}", c_white)

        if not instance_exists("obj_coin"):
            draw_text(8, 26, "All collected! Press R to play again.", c_yellow)
        else:
            draw_text(8, 26, "Arrows or WASD to move - R restarts - Esc quits", c_white)
`;

const README = (name: string) => `# ${name}

A [Benseditor](https://github.com/) game project.

## Running

Press **F5**, click **Run Game** in the status bar, or use the play button at the
top of the Benseditor Assets panel.

## Layout

| Folder | Contents |
| --- | --- |
| \`sprites/\` | \`.bsprite\` files — open one to get the pixel art editor |
| \`objects/\` | \`.bobject\` definitions paired with a Python behaviour script |
| \`rooms/\` | \`.broom\` layouts — open one to place instances visually |
| \`scripts/\` | Plain Python modules, importable from any object script |

## Writing an object

Each object's \`.py\` file defines a class that subclasses \`GameObject\`. Define
only the events you need:

\`\`\`python
from benseditor import GameObject, keyboard_check

class obj_thing(GameObject):
    def create(self):
        self.hp = 3

    def step(self):
        if keyboard_check("space"):
            self.y -= 2

    def draw(self):
        self.draw_self()
\`\`\`

Available events: \`create\`, \`destroy\`, \`room_start\`, \`room_end\`,
\`alarm(index)\`, \`step_begin\`, \`step\`, \`step_end\`, \`collision(other)\`,
\`animation_end\`, \`draw\`, \`draw_gui\`.

Set an alarm with \`self.alarms[0] = 30\` (counted in steps); the \`alarm\`
event fires when it reaches zero.
`;

export const PROJECT_FOLDERS = ['sprites', 'objects', 'rooms', 'scripts'];

/**
 * Every file in a new project, as `relative path -> contents`.
 *
 * Kept free of any `vscode` dependency so the generated project can also be
 * produced (and tested) outside the editor.
 */
export function buildProjectFiles(name: string): Record<string, string> {
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

  const project = newProjectFile(name);
  project.window = { width: ROOM_WIDTH, height: ROOM_HEIGHT, scale: 2, title: name };

  return {
    'benseditor.json': json(project),

    'sprites/spr_player.bsprite': json(
      sprite('spr_player', 16, 8, 8, 12, [frameFromAscii(PLAYER_ART, PLAYER_PALETTE)], {
        left: 3,
        top: 1,
        right: 12,
        bottom: 15,
      }),
    ),
    'sprites/spr_wall.bsprite': json(
      sprite('spr_wall', 16, 0, 0, 12, [frameFromAscii(WALL_ART, WALL_PALETTE)], {
        left: 0,
        top: 0,
        right: 15,
        bottom: 15,
      }),
    ),
    'sprites/spr_coin.bsprite': json(
      sprite(
        'spr_coin',
        8,
        4,
        4,
        10,
        COIN_FRAMES.map((frame) => frameFromAscii(frame, COIN_PALETTE)),
        { left: 1, top: 1, right: 6, bottom: 6 },
      ),
    ),

    'objects/obj_player.bobject': json(object('obj_player', 'spr_player', 0)),
    'objects/obj_player.py': PLAYER_SCRIPT,
    'objects/obj_wall.bobject': json(object('obj_wall', 'spr_wall', 10)),
    'objects/obj_wall.py': WALL_SCRIPT,
    'objects/obj_coin.bobject': json(object('obj_coin', 'spr_coin', 5)),
    'objects/obj_coin.py': COIN_SCRIPT,
    'objects/obj_controller.bobject': json(object('obj_controller', null, -100)),
    'objects/obj_controller.py': CONTROLLER_SCRIPT,

    'rooms/rm_main.broom': json(buildRoom()),

    'scripts/helpers.py': `"""Shared helpers. Any module here is importable from object scripts."""


def grid_snap(value, size=16):
    """Round a coordinate down to the nearest grid cell."""
    return (value // size) * size
`,

    'README.md': README(name),
    '.gitignore': `__pycache__/
*.pyc
`,
  };
}
