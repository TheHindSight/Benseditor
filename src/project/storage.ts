import type {
  ObjectFile,
  Project,
  ProjectFile,
  RoomFile,
  SpriteFile,
  TilesetFile,
} from './types';
import { LANGUAGES, languageInfo } from './languages';
import { validate } from './validate';

export { validate, validateLoaded } from './validate';

/**
 * Project persistence.
 *
 * The File System Access API gives real folders on disk with the same layout
 * the engine has always used, so a project is plain files under version
 * control. Browsers without it fall back to JSON import/export, and either way
 * the current project is mirrored to localStorage so a refresh never loses work.
 */

const AUTOSAVE_KEY = 'benseditor.autosave.v1';

export const supportsFileSystemAccess =
  typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const FOLDERS = {
  sprite: 'sprites',
  tileset: 'tilesets',
  object: 'objects',
  room: 'rooms',
  script: 'scripts',
} as const;

async function readText(handle: FileSystemFileHandle): Promise<string> {
  return (await handle.getFile()).text();
}

async function writeText(
  dir: FileSystemDirectoryHandle,
  name: string,
  contents: string,
): Promise<void> {
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(contents);
  await writable.close();
}

async function listFiles(
  root: FileSystemDirectoryHandle,
  folder: string,
  extension: string,
): Promise<{ name: string; handle: FileSystemFileHandle }[]> {
  const found: { name: string; handle: FileSystemFileHandle }[] = [];
  let dir: FileSystemDirectoryHandle;
  try {
    dir = await root.getDirectoryHandle(folder);
  } catch {
    return found;
  }
  for await (const [entryName, handle] of dir as unknown as AsyncIterable<
    [string, FileSystemHandle]
  >) {
    if (handle.kind === 'file' && entryName.endsWith(extension)) {
      found.push({
        name: entryName.slice(0, -extension.length),
        handle: handle as FileSystemFileHandle,
      });
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

export async function pickFolder(): Promise<FileSystemDirectoryHandle> {
  if (!window.showDirectoryPicker) {
    throw new Error('This browser cannot open folders. Use Import / Export instead.');
  }
  return window.showDirectoryPicker({ mode: 'readwrite' });
}

export async function openProjectFolder(): Promise<{
  project: Project;
  handle: FileSystemDirectoryHandle;
}> {
  const handle = await pickFolder();

  let config: ProjectFile;
  try {
    config = JSON.parse(await readText(await handle.getFileHandle('benseditor.json')));
  } catch {
    throw new Error('That folder has no benseditor.json — pick a Benseditor project folder.');
  }

  const sprites: SpriteFile[] = [];
  for (const { handle: file } of await listFiles(handle, FOLDERS.sprite, '.bsprite')) {
    sprites.push(JSON.parse(await readText(file)) as SpriteFile);
  }

  const tilesets: TilesetFile[] = [];
  for (const { handle: file } of await listFiles(handle, FOLDERS.tileset, '.btileset')) {
    tilesets.push(JSON.parse(await readText(file)) as TilesetFile);
  }

  // Scripts are `.luau` or `.py` by the project's language. A project whose
  // language was switched may still carry files in the other extension, so
  // those are read too rather than replaced by an empty script.
  const language = languageInfo(config);
  const extensions = [language.extension, ...Object.values(LANGUAGES).map((l) => l.extension)];
  const readScript = async (folder: string, name: string): Promise<string | undefined> => {
    const dir = await handle.getDirectoryHandle(folder);
    for (const extension of extensions) {
      try {
        return await readText(await dir.getFileHandle(`${name}.${extension}`));
      } catch {
        // Try the next extension.
      }
    }
    return undefined;
  };

  const objects: { def: ObjectFile; source: string }[] = [];
  for (const { name, handle: file } of await listFiles(handle, FOLDERS.object, '.bobject')) {
    const def = JSON.parse(await readText(file)) as ObjectFile;
    let source: string | undefined;
    try {
      source = await readScript(FOLDERS.object, name);
    } catch {
      source = undefined;
    }
    objects.push({ def, source: source ?? language.objectFallback });
  }

  const rooms: RoomFile[] = [];
  for (const { handle: file } of await listFiles(handle, FOLDERS.room, '.broom')) {
    rooms.push(JSON.parse(await readText(file)) as RoomFile);
  }

  const scripts: { name: string; source: string }[] = [];
  for (const { name, handle: file } of await listFiles(handle, FOLDERS.script, `.${language.extension}`)) {
    scripts.push({ name, source: await readText(file) });
  }

  return { project: validate({ config, sprites, tilesets, objects, rooms, scripts }), handle };
}

export async function saveProjectToFolder(
  handle: FileSystemDirectoryHandle,
  project: Project,
): Promise<void> {
  const json = (value: unknown) => JSON.stringify(value, null, 2) + '\n';

  await writeText(handle, 'benseditor.json', json(project.config));

  const dirs: Record<string, FileSystemDirectoryHandle> = {};
  for (const folder of Object.values(FOLDERS)) {
    dirs[folder] = await handle.getDirectoryHandle(folder, { create: true });
  }

  for (const sprite of project.sprites) {
    await writeText(dirs[FOLDERS.sprite], `${sprite.name}.bsprite`, json(sprite));
  }
  for (const tileset of project.tilesets) {
    await writeText(dirs[FOLDERS.tileset], `${tileset.name}.btileset`, json(tileset));
  }
  const extension = languageInfo(project.config).extension;
  for (const { def, source } of project.objects) {
    await writeText(dirs[FOLDERS.object], `${def.name}.bobject`, json(def));
    await writeText(dirs[FOLDERS.object], `${def.name}.${extension}`, source);
  }
  for (const room of project.rooms) {
    await writeText(dirs[FOLDERS.room], `${room.name}.broom`, json(room));
  }
  for (const script of project.scripts) {
    await writeText(dirs[FOLDERS.script], `${script.name}.${extension}`, script.source);
  }
}

/** Download the whole project as one JSON file. */
export function exportProject(project: Project): void {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${project.config.name.replace(/\s+/g, '-').toLowerCase()}.benseditor.json`;
  link.click();
  URL.revokeObjectURL(url);
}

export function importProject(): Promise<Project> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('No file chosen'));
      try {
        resolve(validate(JSON.parse(await file.text())));
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    input.click();
  });
}

export function autosave(project: Project): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(project));
  } catch {
    // Quota exceeded on a large project; explicit saves still work.
  }
}

export function loadAutosave(): Project | undefined {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? validate(JSON.parse(raw)) : undefined;
  } catch {
    return undefined;
  }
}

export function clearAutosave(): void {
  localStorage.removeItem(AUTOSAVE_KEY);
}
