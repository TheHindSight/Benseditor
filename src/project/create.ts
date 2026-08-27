import {
  type ScriptLanguage,
  DEFAULT_PALETTE,
  FORMAT_VERSION,
  type ObjectFile,
  type Project,
  type RoomFile,
  type SpriteFile,
  type TileLayer,
  type TilesetFile,
} from './types';
import { LANGUAGES } from './languages';

/** Factories for new assets. */

export function blankFrame(width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas.toDataURL('image/png').split(',')[1];
}

export function newSprite(name: string, width = 32, height = 32): SpriteFile {
  return {
    kind: 'sprite',
    version: FORMAT_VERSION,
    name,
    width,
    height,
    originX: Math.floor(width / 2),
    originY: Math.floor(height / 2),
    fps: 12,
    frames: [blankFrame(width, height)],
    palette: [...DEFAULT_PALETTE],
    collision: { mode: 'rect', left: 0, top: 0, right: width - 1, bottom: height - 1 },
  };
}

export function newObject(
  name: string,
  language: ScriptLanguage = 'luau',
): { def: ObjectFile; source: string } {
  return {
    def: {
      kind: 'object',
      version: FORMAT_VERSION,
      name,
      sprite: null,
      depth: 0,
      visible: true,
      solid: false,
      persistent: false,
      parent: null,
    },
    source: LANGUAGES[language].newObjectSource(name),
  };
}

export function newRoom(name: string, width = 480, height = 288): RoomFile {
  return {
    kind: 'room',
    version: FORMAT_VERSION,
    name,
    width,
    height,
    backgroundColor: '#1d2b53',
    gridWidth: 16,
    gridHeight: 16,
    instances: [],
    layers: [],
  };
}

/** A placeholder sheet: numbered checker tiles, so a new tileset is usable. */
function placeholderSheet(tileWidth: number, tileHeight: number, columns: number, rows: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = columns * tileWidth;
  canvas.height = rows * tileHeight;
  const ctx = canvas.getContext('2d')!;

  const shades = ['#5f574f', '#7e2553', '#008751', '#ab5236', '#1d2b53', '#83769c'];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column;
      ctx.fillStyle = shades[index % shades.length];
      ctx.fillRect(column * tileWidth, row * tileHeight, tileWidth, tileHeight);
      ctx.fillStyle = 'rgba(255,255,255,0.18)';
      ctx.fillRect(column * tileWidth, row * tileHeight, tileWidth, 1);
      ctx.fillRect(column * tileWidth, row * tileHeight, 1, tileHeight);
    }
  }

  return canvas.toDataURL('image/png').split(',')[1];
}

export function newTileset(name: string, tileWidth = 16, tileHeight = 16): TilesetFile {
  const columns = 4;
  const rows = 3;
  return {
    kind: 'tileset',
    version: FORMAT_VERSION,
    name,
    tileWidth,
    tileHeight,
    offsetX: 0,
    offsetY: 0,
    spacingX: 0,
    spacingY: 0,
    columns,
    rows,
    image: placeholderSheet(tileWidth, tileHeight, columns, rows),
    solid: new Array(columns * rows).fill(false),
  };
}

export function newTileLayer(
  name: string,
  tileset: string,
  columns: number,
  rows: number,
  depth = 20,
): TileLayer {
  return {
    id: `layer_${Math.random().toString(36).slice(2, 8)}`,
    name,
    tileset,
    depth,
    visible: true,
    columns,
    rows,
    tiles: new Array(columns * rows).fill(-1),
  };
}

/**
 * An empty project: one black room and nothing else.
 *
 * Still runnable immediately -- the engine needs a start room, so there is one,
 * and it draws as a black screen until you put something in it.
 */
export function buildBlankProject(name = 'Untitled', language: ScriptLanguage = 'luau'): Project {
  const room = newRoom('rm_main');
  room.backgroundColor = '#000000';

  return {
    config: {
      kind: 'project',
      version: FORMAT_VERSION,
      name,
      startRoom: 'rm_main',
      fps: 60,
      window: { width: room.width, height: room.height, scale: 2, title: name },
      // Luau is the default and is not written out, so older files stay identical.
      ...(language === 'luau' ? {} : { language }),
    },
    sprites: [],
    tilesets: [],
    objects: [],
    rooms: [room],
    scripts: [],
  };
}

export function newScript(
  name: string,
  language: ScriptLanguage = 'luau',
): { name: string; source: string } {
  return { name, source: LANGUAGES[language].newScriptSource(name) };
}
