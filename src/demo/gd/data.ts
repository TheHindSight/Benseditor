import { newTileLayer } from '../../project/create';
import { FORMAT_VERSION, type ObjectFile, type RoomFile } from '../../project/types';
import {
  CELL,
  FLOOR_ROWS,
  LAYER_EDIT,
  LAYER_PLAY,
  LAYER_ROWS,
  MAX_COLUMNS,
  ROOM_H,
  ROOM_W,
  ROWS,
  TILE_GROUND,
  VIEW_H,
  VIEW_W,
  constantsPython,
} from './constants';
import { builtInPython } from './levels';

// Shared scripts, in registration order: each one's public names are globals
// for everything registered after it.
import gdCodec from './scripts/gd_codec.py?raw';
import gdTiles from './scripts/gd_tiles.py?raw';
import gdStore from './scripts/gd_store.py?raw';
import gdLevel from './scripts/gd_level.py?raw';
import gdEditor from './scripts/gd_editor.py?raw';
import gdphys from './scripts/gdphys.py?raw';
import ui from './scripts/ui.py?raw';
import progress from './scripts/progress.py?raw';
import run from './scripts/run.py?raw';
import icons from './scripts/icons.py?raw';
import state from './scripts/state.py?raw';
import levelsMenu from './scripts/levels_menu.py?raw';

// Objects.
import objGame from './scripts/obj_game.py?raw';
import objMenu from './scripts/obj_menu.py?raw';
import objLevels from './scripts/obj_levels.py?raw';
import objIcon from './scripts/obj_icon.py?raw';
import objHud from './scripts/obj_hud.py?raw';
import objEnd from './scripts/obj_end.py?raw';
import objEditor from './scripts/obj_editor.py?raw';
import objLevel from './scripts/obj_level.py?raw';
import objStart from './scripts/obj_start.py?raw';
import objPlayer from './scripts/obj_player.py?raw';
import objHazard from './scripts/obj_hazard.py?raw';
import objSpike from './scripts/obj_spike.py?raw';
import objPad from './scripts/obj_pad.py?raw';
import objOrb from './scripts/obj_orb.py?raw';
import objPortal from './scripts/obj_portal.py?raw';
import objPortalGravity from './scripts/obj_portal_gravity.py?raw';
import objPortalMode from './scripts/obj_portal_mode.py?raw';
import objPortalSpeed from './scripts/obj_portal_speed.py?raw';
import objPortalSize from './scripts/obj_portal_size.py?raw';
import objCoin from './scripts/obj_coin.py?raw';
import objFinish from './scripts/obj_finish.py?raw';
import objCheckpoint from './scripts/obj_checkpoint.py?raw';
import objExplosion from './scripts/obj_explosion.py?raw';

/**
 * The Geometry Dash project, minus the pixels.
 *
 * Everything here is DOM-free so the Node tests can load the same scripts,
 * objects and rooms the editor assembles; `index.ts` adds the sprites.
 */

export const GD_SCRIPTS: { name: string; source: string }[] = [
  { name: 'gd_const', source: constantsPython() },
  // gdphys before gd_level: gd_level.set_bounds calls gd_set_bounds, and a
  // shared script only sees the globals of the scripts registered before it.
  { name: 'gdphys', source: gdphys },
  { name: 'gd_codec', source: gdCodec },
  { name: 'gd_tiles', source: gdTiles },
  { name: 'gd_store', source: gdStore },
  { name: 'gd_level', source: gdLevel },
  { name: 'gd_levels', source: builtInPython() },
  { name: 'gd_editor', source: gdEditor },
  { name: 'ui', source: ui },
  { name: 'progress', source: progress },
  { name: 'run', source: run },
  { name: 'icons', source: icons },
  { name: 'state', source: state },
  { name: 'levels_menu', source: levelsMenu },
];

interface ObjectSpec {
  name: string;
  source: string;
  sprite?: string;
  depth?: number;
  visible?: boolean;
  persistent?: boolean;
  parent?: string;
}

function object(spec: ObjectSpec): { def: ObjectFile; source: string } {
  return {
    def: {
      kind: 'object',
      version: FORMAT_VERSION,
      name: spec.name,
      sprite: spec.sprite ?? null,
      depth: spec.depth ?? 0,
      visible: spec.visible ?? true,
      solid: false,
      persistent: spec.persistent ?? false,
      parent: spec.parent ?? null,
      blockedBy: [],
    },
    source: spec.source,
  };
}

export const GD_OBJECTS: { def: ObjectFile; source: string }[] = [
  // State and scenes (invisible controllers; they draw through draw_gui).
  object({ name: 'obj_game', source: objGame, depth: -1000, visible: false, persistent: true }),
  object({ name: 'obj_menu', source: objMenu, depth: -500, visible: false }),
  object({ name: 'obj_levels', source: objLevels, depth: -500, visible: false }),
  object({ name: 'obj_icon', source: objIcon, depth: -500, visible: false }),
  object({ name: 'obj_hud', source: objHud, depth: -500, visible: false }),
  object({ name: 'obj_end', source: objEnd, depth: -500, visible: false }),
  object({ name: 'obj_editor', source: objEditor, depth: -500, visible: false }),
  object({ name: 'obj_level', source: objLevel, depth: -400, visible: false }),
  object({ name: 'obj_start', source: objStart, visible: false }),

  // The player and everything it touches. Parents come first.
  object({ name: 'obj_player', source: objPlayer, sprite: 'spr_cube', depth: -10 }),
  object({ name: 'obj_hazard', source: objHazard, visible: false }),
  object({ name: 'obj_spike', source: objSpike, sprite: 'spr_spike', parent: 'obj_hazard' }),
  object({ name: 'obj_pad', source: objPad, sprite: 'spr_pad', depth: 2 }),
  object({ name: 'obj_orb', source: objOrb, sprite: 'spr_orb', depth: 2 }),
  object({ name: 'obj_portal', source: objPortal, visible: false }),
  object({ name: 'obj_portal_gravity', source: objPortalGravity, sprite: 'spr_portal_gravity', depth: 5, parent: 'obj_portal' }),
  object({ name: 'obj_portal_mode', source: objPortalMode, sprite: 'spr_portal_mode', depth: 5, parent: 'obj_portal' }),
  object({ name: 'obj_portal_speed', source: objPortalSpeed, sprite: 'spr_portal_speed', depth: 5, parent: 'obj_portal' }),
  object({ name: 'obj_portal_size', source: objPortalSize, sprite: 'spr_portal_size', depth: 5, parent: 'obj_portal' }),
  object({ name: 'obj_coin', source: objCoin, sprite: 'spr_coin', depth: 1 }),
  object({ name: 'obj_finish', source: objFinish, sprite: 'spr_finish', depth: 5 }),
  object({ name: 'obj_checkpoint', source: objCheckpoint, sprite: 'spr_checkpoint', depth: 3 }),
  object({ name: 'obj_explosion', source: objExplosion, depth: -20, visible: false }),
];

function room(name: string, width: number, height: number, instances: RoomFile['instances'], layers: RoomFile['layers'] = []): RoomFile {
  return {
    kind: 'room',
    version: FORMAT_VERSION,
    name,
    width,
    height,
    backgroundColor: '#1d2b53',
    gridWidth: CELL,
    gridHeight: CELL,
    instances,
    layers,
  };
}

function place(id: string, object: string, x: number, y: number, name?: string): RoomFile['instances'][number] {
  return { id, object, x, y, xscale: 1, yscale: 1, angle: 0, ...(name ? { name } : {}) };
}

/** A level layer: the floor rows pre-filled, everything else empty. */
function levelLayer(id: string): NonNullable<RoomFile['layers']>[number] {
  const layer = newTileLayer(id, 'ts_gd', MAX_COLUMNS, LAYER_ROWS, 10);
  layer.id = id;
  for (let row = ROWS; row < ROWS + FLOOR_ROWS; row++) {
    for (let column = 0; column < MAX_COLUMNS; column++) layer.tiles[row * MAX_COLUMNS + column] = TILE_GROUND;
  }
  return layer;
}

export const GD_ROOMS: RoomFile[] = [
  room('rm_menu', VIEW_W, VIEW_H, [place('inst_menu', 'obj_menu', 0, 0, 'menu')]),
  room('rm_levels', VIEW_W, VIEW_H, [place('inst_levels', 'obj_levels', 0, 0, 'levels')]),
  room('rm_icon', VIEW_W, VIEW_H, [place('inst_icon', 'obj_icon', 0, 0, 'icon')]),
  room('rm_end', VIEW_W, VIEW_H, [place('inst_end', 'obj_end', 0, 0, 'end')]),
  room(
    'rm_play',
    ROOM_W,
    ROOM_H,
    [place('inst_hud', 'obj_hud', 0, 0, 'hud'), place('inst_level', 'obj_level', 0, 0, 'level')],
    [levelLayer(LAYER_PLAY)],
  ),
  room('rm_editor', ROOM_W, ROOM_H, [place('inst_editor', 'obj_editor', 0, 0, 'editor')], [levelLayer(LAYER_EDIT)]),
];

export const GD_START_ROOM = 'rm_menu';
