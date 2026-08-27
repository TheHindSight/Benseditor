import { FORMAT_VERSION, type Project } from '../../project/types';
import { GD_SPRITES, GD_TILESET } from './art';
import { VIEW_H, VIEW_W } from './constants';
import { GD_OBJECTS, GD_ROOMS, GD_SCRIPTS, GD_START_ROOM } from './data';

/**
 * Geometry Dash: the full clone, written in Python on the engine.
 *
 * Eight gamemodes with GD's own physics constants, pads, orbs, portals,
 * practice mode with checkpoints, coins, a menu with level select and icon
 * colours, three built-in levels, and an in-game level editor whose custom
 * levels are saved in the browser and must be verified -- completed by their
 * author from the editor -- before the menu will play them. Everything lives
 * in `src/demo/gd/`: the scripts are real `.py` files, the levels are ASCII
 * maps in `levels.ts`, and `data.ts` keeps the project DOM-free so the Node
 * suites drive the same game the editor assembles.
 */
export function buildGeometryDashProject(name = 'Geometry Dash'): Project {
  return {
    config: {
      kind: 'project',
      version: FORMAT_VERSION,
      name,
      startRoom: GD_START_ROOM,
      fps: 60,
      window: { width: VIEW_W, height: VIEW_H, scale: 2, title: name },
      language: 'python',
    },
    sprites: GD_SPRITES,
    tilesets: [GD_TILESET],
    objects: GD_OBJECTS,
    rooms: GD_ROOMS,
    scripts: GD_SCRIPTS,
  };
}
