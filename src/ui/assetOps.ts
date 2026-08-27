import { newObject, newRoom, newScript, newSprite, newTileset } from '../project/create';
import { addAssetNode, removeAssetNode, renameAssetNode } from '../project/explorer';
import { languageOf, scriptingOf } from '../project/languages';
import { OBJECT_TEMPLATES } from '../project/objectTemplates';
import {
  decodeImageFile,
  pickImageFiles,
  spriteFromFrames,
} from '../project/importImage';
import type { AssetKind, ProjectStore } from '../project/store';
import { validateAssetName } from '../project/types';
import { el, modal } from './dom';
import { showImportDialog } from './importSprite';

/**
 * Asset create / rename / delete / import, shared by every sidebar view.
 *
 * The flat asset tree and the Roblox-style explorer differ only in how they
 * *show* assets; the dialogs, name validation, cross-reference fixups and
 * store commits are identical, so they live here once. Each operation is a
 * single undoable structural commit, which also keeps the Explorer tree (when
 * the project has one) in step: `parentId` is the folder or service a new
 * asset lands in, when the view knows one.
 */
export class AssetOps {
  constructor(
    private readonly store: ProjectStore,
    private readonly onOpen: (kind: AssetKind, name: string) => void,
    private readonly onRenamed: (kind: AssetKind, from: string, to: string) => void,
    private readonly onDeleted: (kind: AssetKind, name: string) => void,
  ) {}

  /**
   * Import image files as sprites, one dialog per file.
   *
   * `files` comes from a drop; without it the OS picker opens. Each image gets
   * the slice dialog, so a sheet can be cut into frames on the way in.
   */
  async importSprites(files?: File[], parentId?: string | null): Promise<void> {
    const picked = files ?? (await pickImageFiles());

    for (const file of picked) {
      const image = await decodeImageFile(file);
      if (!image) {
        await this.warn(`${file.name} could not be read as an image.`);
        continue;
      }

      const result = await showImportDialog({
        image,
        fileName: file.name,
        taken: (name) => this.store.exists('sprite', name),
      });
      if (!result) continue;

      this.store.commit(
        'import sprite',
        () => {
          this.store.project.sprites.push(
            spriteFromFrames(result.name, result.width, result.height, result.frames, result.palette),
          );
          this.placed('sprite', result.name, parentId);
        },
        true,
      );
      this.onOpen('sprite', result.name);
    }
  }

  async prompt(title: string, label: string, value: string): Promise<string | undefined> {
    const input = el('input', { type: 'text', value }) as HTMLInputElement;
    const error = el('p', { class: 'field-error' });
    const body = el('div', { class: 'modal-body' },
      el('label', { class: 'field' }, el('span', { text: label }), input), error);

    // Select the part after the prefix so typing replaces just the name.
    queueMicrotask(() => {
      input.focus();
      input.setSelectionRange(value.length, value.length);
    });

    if (!(await modal(title, body, 'OK'))) return undefined;
    return input.value.trim();
  }

  async create(kind: AssetKind, prefix: string, parentId?: string | null): Promise<void> {
    if (kind === 'object') return this.createObject(prefix, parentId);

    const name = await this.prompt(`New ${kind}`, 'Name', prefix);
    if (!name) return;

    const invalid = validateAssetName(name);
    if (invalid) return void this.warn(invalid);
    if (this.store.exists(kind, name)) return void this.warn(`A ${kind} called ${name} already exists.`);

    this.store.commit(
      `create ${kind}`,
      () => {
        const project = this.store.project;
        if (kind === 'sprite') project.sprites.push(newSprite(name));
        else if (kind === 'tileset') project.tilesets.push(newTileset(name));
        else if (kind === 'room') {
          project.rooms.push(newRoom(name));
          // Adopt the first room, or one added after the start room was lost.
          if (!project.rooms.some((r) => r.name === project.config.startRoom)) {
            project.config.startRoom = name;
          }
        } else project.scripts.push(newScript(name, languageOf(project.config)));
        this.placed(kind, name, parentId);
      },
      true,
    );

    this.onOpen(kind, name);
  }

  /**
   * Objects get a template picker: a working player, wall or enemy is a far
   * better starting point than an empty step event.
   */
  async createObject(prefix: string, parentId?: string | null): Promise<void> {
    const nameInput = el('input', { type: 'text', value: prefix }) as HTMLInputElement;
    const hint = el('p', { class: 'muted small' });
    const blockMode = scriptingOf(this.store.project.config) === 'blocks';
    const select = el(
      'select',
      { disabled: blockMode, title: blockMode ? 'Templates are code; in block mode every object starts as blocks.' : '' },
      ...OBJECT_TEMPLATES.map((template) =>
        el('option', { value: template.id, text: template.label }),
      ),
    ) as HTMLSelectElement;

    // The suggested name follows the template until the user types their own.
    let renamed = false;
    nameInput.addEventListener('input', () => {
      renamed = true;
    });
    const syncHint = () => {
      const template = OBJECT_TEMPLATES.find((t) => t.id === select.value)!;
      hint.textContent = template.hint;
      if (!renamed) {
        let candidate = template.suggestedName;
        // Never suggest a clash; obj_player2 beats an error after OK.
        for (let n = 2; this.store.exists('object', candidate); n++) {
          candidate = `${template.suggestedName}${n}`;
        }
        nameInput.value = candidate;
      }
    };
    select.addEventListener('change', syncHint);
    syncHint();
    renamed = false;

    const body = el(
      'div',
      { class: 'modal-body' },
      el('label', { class: 'field' }, el('span', { text: 'From' }), select),
      hint,
      el('label', { class: 'field' }, el('span', { text: 'Name' }), nameInput),
    );

    if (!(await modal('New object', body, 'Create'))) return;

    const name = nameInput.value.trim();
    const invalid = validateAssetName(name);
    if (invalid) return void this.warn(invalid);
    if (this.store.exists('object', name)) {
      return void this.warn(`An object called ${name} already exists.`);
    }

    const template = OBJECT_TEMPLATES.find((t) => t.id === select.value)!;
    const language = languageOf(this.store.project.config);

    // In block mode a new object starts as blocks -- a create and a step hat
    // -- and the templates, which are code, do not apply. Blockly is loaded
    // here rather than at import time so code-mode sessions never pay for it.
    let blocks: { state: import('../project/types').BlockWorkspace; source: string } | undefined;
    if (scriptingOf(this.store.project.config) === 'blocks') {
      const generate = await import('../blocks/generate');
      let state = generate.emptyWorkspace();
      for (const event of ['create', 'step']) state = generate.addEventHat(state, event);
      blocks = { state, source: generate.generateSource(state, language) };
    }

    this.store.commit(
      'create object',
      () => {
        const entry = newObject(name, language);
        Object.assign(entry.def, template.def);
        if (blocks) {
          entry.def.blocks = blocks.state;
          entry.source = blocks.source;
        } else {
          const source = template.source[language];
          if (source) entry.source = source;
        }
        this.store.project.objects.push(entry);
        this.placed('object', name, parentId);
      },
      true,
    );

    this.onOpen('object', name);
  }

  setStartRoom(name: string): void {
    this.store.commit('set start room', () => {
      this.store.project.config.startRoom = name;
    }, true);
  }

  async rename(kind: AssetKind, from: string): Promise<void> {
    const to = await this.prompt(`Rename ${kind}`, 'New name', from);
    if (!to || to === from) return;

    const invalid = validateAssetName(to);
    if (invalid) return void this.warn(invalid);
    if (this.store.exists(kind, to)) return void this.warn(`A ${kind} called ${to} already exists.`);

    this.store.commit(
      `rename ${kind}`,
      () => {
        const project = this.store.project;
        if (kind === 'sprite') {
          const sprite = project.sprites.find((s) => s.name === from)!;
          sprite.name = to;
          // Repoint every object that used it.
          for (const entry of project.objects) {
            if (entry.def.sprite === from) entry.def.sprite = to;
          }
        } else if (kind === 'tileset') {
          project.tilesets.find((t) => t.name === from)!.name = to;
          for (const room of project.rooms) {
            for (const layer of room.layers ?? []) {
              if (layer.tileset === from) layer.tileset = to;
            }
          }
        } else if (kind === 'object') {
          const entry = project.objects.find((o) => o.def.name === from)!;
          entry.def.name = to;
          for (const other of project.objects) {
            if (other.def.parent === from) other.def.parent = to;
            // Collision lists name objects too.
            other.def.blockedBy = other.def.blockedBy?.map((n) => (n === from ? to : n));
          }
          for (const room of project.rooms) {
            for (const instance of room.instances) {
              if (instance.object === from) instance.object = to;
            }
          }
        } else if (kind === 'room') {
          project.rooms.find((r) => r.name === from)!.name = to;
          if (project.config.startRoom === from) project.config.startRoom = to;
        } else {
          project.scripts.find((s) => s.name === from)!.name = to;
        }
        if (project.config.explorer) renameAssetNode(project.config.explorer, kind, from, to);
      },
      true,
    );

    this.onRenamed(kind, from, to);
  }

  async remove(kind: AssetKind, name: string): Promise<void> {
    const body = el('div', { class: 'modal-body' },
      el('p', { text: `Delete ${kind} “${name}”? This cannot be undone from disk until you save.` }));
    if (!(await modal('Delete asset', body, 'Delete'))) return;

    this.store.commit(
      `delete ${kind}`,
      () => {
        const project = this.store.project;
        if (kind === 'sprite') {
          project.sprites = project.sprites.filter((s) => s.name !== name);
          for (const entry of project.objects) {
            if (entry.def.sprite === name) entry.def.sprite = null;
          }
        } else if (kind === 'tileset') {
          project.tilesets = project.tilesets.filter((t) => t.name !== name);
          // Layers using it would render nothing, so drop them too.
          for (const room of project.rooms) {
            room.layers = (room.layers ?? []).filter((layer) => layer.tileset !== name);
          }
        } else if (kind === 'object') {
          project.objects = project.objects.filter((o) => o.def.name !== name);
          for (const other of project.objects) {
            if (other.def.parent === name) other.def.parent = null;
            other.def.blockedBy = other.def.blockedBy?.filter((n) => n !== name);
          }
          for (const room of project.rooms) {
            room.instances = room.instances.filter((i) => i.object !== name);
          }
        } else if (kind === 'room') {
          project.rooms = project.rooms.filter((r) => r.name !== name);
          // Deleting the start room would otherwise leave the project pointing
          // at a room that no longer exists, which only surfaces on Play.
          if (project.config.startRoom === name) {
            project.config.startRoom = project.rooms[0]?.name ?? '';
          }
        } else {
          project.scripts = project.scripts.filter((s) => s.name !== name);
        }
        if (project.config.explorer) removeAssetNode(project.config.explorer, kind, name);
      },
      true,
    );

    this.onDeleted(kind, name);
  }

  /** Inside a commit: give a new asset its Explorer node, when the project has a tree. */
  private placed(kind: AssetKind, name: string, parentId?: string | null): void {
    const explorer = this.store.project.config.explorer;
    if (explorer) addAssetNode(explorer, kind, name, parentId);
  }

  async warn(message: string): Promise<void> {
    await modal('Cannot do that', el('div', { class: 'modal-body' }, el('p', { text: message })), 'OK');
  }
}
