import type { AssetKind, ObjectFile, Project, RoomFile, SpriteFile, TilesetFile } from './types';

export type { AssetKind };

/**
 * The open project, plus change notification and undo.
 *
 * Editors mutate through the store rather than holding their own copies, so the
 * room editor sees a sprite edit immediately and the game always runs the same
 * data the editors show. VS Code used to provide undo via the text document;
 * here it is a snapshot stack, which is cheap because assets are small.
 */

export interface AssetRef {
  kind: AssetKind;
  name: string;
}

export type StoreEvent = 'change' | 'structure';

interface UndoEntry {
  label: string;
  before: string;
  after: string;
}

const UNDO_LIMIT = 200;

export class ProjectStore {
  private listeners = new Map<StoreEvent, Set<() => void>>();
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];
  private dirty = false;

  constructor(private current: Project) {}

  get project(): Project {
    return this.current;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  markClean(): void {
    this.dirty = false;
    this.emit('change');
  }

  on(event: StoreEvent, handler: () => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(handler);
    this.listeners.set(event, set);
    return () => set.delete(handler);
  }

  private emit(event: StoreEvent): void {
    for (const handler of this.listeners.get(event) ?? []) handler();
  }

  // -- lookups ---------------------------------------------------------

  sprite(name: string): SpriteFile | undefined {
    return this.current.sprites.find((s) => s.name === name);
  }

  tileset(name: string): TilesetFile | undefined {
    return this.current.tilesets.find((t) => t.name === name);
  }

  object(name: string): { def: ObjectFile; source: string } | undefined {
    return this.current.objects.find((o) => o.def.name === name);
  }

  room(name: string): RoomFile | undefined {
    return this.current.rooms.find((r) => r.name === name);
  }

  script(name: string): { name: string; source: string } | undefined {
    return this.current.scripts.find((s) => s.name === name);
  }

  names(kind: AssetKind): string[] {
    switch (kind) {
      case 'sprite':
        return this.current.sprites.map((s) => s.name).sort();
      case 'tileset':
        return this.current.tilesets.map((t) => t.name).sort();
      case 'object':
        return this.current.objects.map((o) => o.def.name).sort();
      case 'room':
        return this.current.rooms.map((r) => r.name).sort();
      case 'script':
        return this.current.scripts.map((s) => s.name).sort();
    }
  }

  exists(kind: AssetKind, name: string): boolean {
    return this.names(kind).includes(name);
  }

  // -- mutation --------------------------------------------------------

  /**
   * Apply `mutate` and record one undo entry.
   *
   * `structural` marks changes that add or remove assets, so the tree
   * refreshes rather than just the open editor.
   */
  commit(label: string, mutate: () => void, structural = false): void {
    const before = JSON.stringify(this.current);
    mutate();
    const after = JSON.stringify(this.current);
    if (before === after) return;

    this.undoStack.push({ label, before, after });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;

    this.dirty = true;
    this.emit('change');
    if (structural) this.emit('structure');
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.redoStack.push(entry);
    this.current = JSON.parse(entry.before) as Project;
    this.dirty = true;
    this.emit('change');
    this.emit('structure');
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.undoStack.push(entry);
    this.current = JSON.parse(entry.after) as Project;
    this.dirty = true;
    this.emit('change');
    this.emit('structure');
  }

  /** Replace the whole project, e.g. after opening a folder. */
  replace(project: Project): void {
    this.current = project;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.dirty = false;
    this.emit('change');
    this.emit('structure');
  }
}
