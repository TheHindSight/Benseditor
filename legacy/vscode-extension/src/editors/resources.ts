import { ObjectFile, SpriteFile } from '../project/assets';
import { Project } from '../project/project';

/** Sprite data trimmed to what an editor webview needs to draw an instance. */
export interface SpriteResource {
  width: number;
  height: number;
  originX: number;
  originY: number;
  /** First frame, base64 PNG. */
  thumb: string;
}

export interface ObjectResource {
  name: string;
  sprite: string | null;
  depth: number;
}

export interface ProjectResources {
  objects: ObjectResource[];
  sprites: Record<string, SpriteResource>;
}

/**
 * Collect every object and sprite in the project so room/object editors can
 * render real artwork. Re-read on demand rather than cached, so edits in one
 * editor show up in the others.
 */
export async function collectResources(project: Project): Promise<ProjectResources> {
  const objects: ObjectResource[] = [];
  const sprites: Record<string, SpriteResource> = {};

  for (const asset of await project.list('object')) {
    try {
      const object = await project.readJson<ObjectFile>(asset.uri);
      objects.push({ name: object.name, sprite: object.sprite, depth: object.depth ?? 0 });
    } catch {
      // Skip malformed definitions; the JSON editor will surface the error.
    }
  }

  for (const asset of await project.list('sprite')) {
    try {
      const sprite = await project.readJson<SpriteFile>(asset.uri);
      sprites[sprite.name] = {
        width: sprite.width,
        height: sprite.height,
        originX: sprite.originX,
        originY: sprite.originY,
        thumb: sprite.frames[0] ?? '',
      };
    } catch {
      // Skip.
    }
  }

  return { objects, sprites };
}
