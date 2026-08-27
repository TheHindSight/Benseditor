import { blankFrame } from '../png';

/**
 * On-disk asset formats. Every file is JSON so that it diffs, merges and is
 * hand-editable; sprite pixels ride along as base64 PNG per frame.
 */

export const FORMAT_VERSION = 1;

export const DEFAULT_PALETTE = [
  '#000000', '#1d2b53', '#7e2553', '#008751', '#ab5236', '#5f574f', '#c2c3c7', '#fff1e8',
  '#ff004d', '#ffa300', '#ffec27', '#00e436', '#29adff', '#83769c', '#ff77a8', '#ffccaa',
];

export interface ProjectFile {
  kind: 'project';
  version: number;
  name: string;
  startRoom: string;
  fps: number;
  window: { width: number; height: number; scale: number; title: string };
}

export type CollisionMode = 'rect' | 'circle' | 'precise';

export interface SpriteFile {
  kind: 'sprite';
  version: number;
  name: string;
  width: number;
  height: number;
  originX: number;
  originY: number;
  fps: number;
  /** Base64-encoded PNG per frame, all `width` x `height`. */
  frames: string[];
  palette: string[];
  collision: { mode: CollisionMode; left: number; top: number; right: number; bottom: number };
}

export interface ObjectFile {
  kind: 'object';
  version: number;
  name: string;
  sprite: string | null;
  depth: number;
  visible: boolean;
  solid: boolean;
  persistent: boolean;
  parent: string | null;
}

export interface RoomInstance {
  id: string;
  object: string;
  x: number;
  y: number;
  xscale: number;
  yscale: number;
  angle: number;
}

export interface RoomFile {
  kind: 'room';
  version: number;
  name: string;
  width: number;
  height: number;
  backgroundColor: string;
  gridWidth: number;
  gridHeight: number;
  instances: RoomInstance[];
}

export function newProjectFile(name: string): ProjectFile {
  return {
    kind: 'project',
    version: FORMAT_VERSION,
    name,
    startRoom: 'rm_main',
    fps: 60,
    window: { width: 640, height: 360, scale: 2, title: name },
  };
}

export function newSpriteFile(name: string, width = 32, height = 32): SpriteFile {
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

export function newObjectFile(name: string, sprite: string | null = null): ObjectFile {
  return {
    kind: 'object',
    version: FORMAT_VERSION,
    name,
    sprite,
    depth: 0,
    visible: true,
    solid: false,
    persistent: false,
    parent: null,
  };
}

export function newRoomFile(name: string, width = 640, height = 360): RoomFile {
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
  };
}

/** Starter script body for a new object, mirroring the GameMaker event set. */
export function newObjectScript(name: string): string {
  return `from benseditor import GameObject


class ${name}(GameObject):
    """Runs once per instance when it is created."""

    def create(self):
        pass

    def step(self):
        pass

    def draw(self):
        self.draw_self()
`;
}

export function newScriptFile(name: string): string {
  return `"""${name} -- shared helpers for your game."""


def ${name}():
    pass
`;
}

export const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function validateAssetName(name: string): string | undefined {
  if (!name) {
    return 'Name cannot be empty.';
  }
  if (!NAME_PATTERN.test(name)) {
    return 'Use letters, digits and underscores only, starting with a letter or underscore.';
  }
  return undefined;
}
