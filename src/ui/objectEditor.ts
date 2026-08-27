import { languageInfo, languageOf, scriptingOf } from '../project/languages';
import type { ProjectStore } from '../project/store';
import type { ScriptLanguage } from '../project/types';
import { BlockEditor } from './blockEditor';
import { clear, el, modal, type Panel } from './dom';
import { CodeEditor } from './codeEditor';
import { specFor } from './languageSpecs';

/**
 * Object editor: properties on the left, the event checklist and its script
 * on the right, in the project's language.
 *
 * The checklist is derived from the source itself rather than stored metadata,
 * so it can never drift out of sync with the code.
 */

export interface EventSpec {
  name: string;
  label: string;
  args: string;
  body: string;
}

export const EVENTS: EventSpec[] = [
  { name: 'create', label: 'Create', args: 'self', body: '' },
  { name: 'destroy', label: 'Destroy', args: 'self', body: '' },
  { name: 'room_start', label: 'Room Start', args: 'self', body: '' },
  { name: 'room_end', label: 'Room End', args: 'self', body: '' },
  { name: 'alarm', label: 'Alarm', args: 'self, index', body: '' },
  { name: 'step_begin', label: 'Begin Step', args: 'self', body: '' },
  { name: 'step', label: 'Step', args: 'self', body: '' },
  { name: 'step_end', label: 'End Step', args: 'self', body: '' },
  { name: 'collision', label: 'Collision', args: 'self, other', body: '' },
  { name: 'animation_end', label: 'Animation End', args: 'self', body: '' },
  { name: 'draw', label: 'Draw', args: 'self', body: '\tself:draw_self()' },
  { name: 'draw_gui', label: 'Draw GUI', args: 'self', body: '' },
];

/**
 * Luau: both `function obj.step(self)` and `obj.step = function(self)` count.
 * Python: a module-level `def step(`.
 */
export function definedEvents(source: string, language: ScriptLanguage = 'luau'): Set<string> {
  const found = new Set<string>();
  for (const event of EVENTS) {
    let defined: boolean;
    if (language === 'python') {
      defined = new RegExp(`^def\\s+${event.name}\\s*\\(`, 'm').test(source);
    } else {
      const declared = new RegExp(`function\\s+[A-Za-z_][\\w]*\\.${event.name}\\s*\\(`).test(source);
      const assigned = new RegExp(`\\.${event.name}\\s*=\\s*function\\s*\\(`).test(source);
      defined = declared || assigned;
    }
    if (defined) found.add(event.name);
  }
  return found;
}

/** The stub's signature as the user would type it, for tooltips. */
export function eventSignature(event: EventSpec, language: ScriptLanguage = 'luau'): string {
  return language === 'python'
    ? `def ${event.name}(${event.args}):`
    : `function obj.${event.name}(${event.args})`;
}

/**
 * Insert a stub: before the module's final `return` for Luau, or appended
 * (Python has no module table to return).
 */
export function insertEventStub(source: string, event: EventSpec, language: ScriptLanguage = 'luau'): string {
  if (language === 'python') {
    // The Luau bodies are one tab and a colon call; Python's are four spaces and a dot.
    const body = event.body ? event.body.replace(/^\t/, '    ').replace('self:', 'self.') : '    pass';
    const stub = `def ${event.name}(${event.args}):\n${body}\n`;
    const trimmed = source.trimEnd();
    return trimmed ? `${trimmed}\n\n\n${stub}` : stub;
  }
  const stub = `\nfunction obj.${event.name}(${event.args})\n${event.body || '\t'}\nend\n`;
  const match = /\n(return\s+[A-Za-z_][\w]*\s*)$/.exec(source.trimEnd() + '\n');
  if (match && match.index !== undefined) {
    const at = source.lastIndexOf(match[1]);
    return source.slice(0, at) + stub.trimStart() + '\n' + source.slice(at);
  }
  return source.trimEnd() + '\n' + stub;
}

export class ObjectEditor implements Panel {
  readonly element: HTMLElement;

  private eventList!: HTMLElement;
  private blockedList!: HTMLElement;
  private preview!: HTMLCanvasElement;
  private code: CodeEditor;
  /** Present while the object is edited as blocks. */
  private blocks?: BlockEditor;
  /** Holds whichever of the two editors is showing. */
  private scriptHost!: HTMLElement;
  private unsubscribe?: () => void;

  constructor(
    private readonly store: ProjectStore,
    private readonly objectName: string,
    assetNames: () => string[] = () => [],
  ) {
    this.code = new CodeEditor(
      // Tolerant, not `this.entry`: a rename or delete flushes the editor
      // before its tab is closed, when the object is already gone.
      () => this.store.object(this.objectName)?.source ?? '',
      (source) => {
        if (!this.store.object(this.objectName)) return;
        this.store.commit('edit script', () => {
          const entry = this.store.object(this.objectName);
          if (entry) entry.source = source;
        });
        this.buildEvents();
      },
      `${objectName}.${languageInfo(store.project.config).extension}`,
      assetNames,
      specFor(languageOf(store.project.config)),
    );

    this.element = this.build();
    this.syncMode();
    this.unsubscribe = store.on('change', () => {
      // A rename or delete lands here before the tab is closed for it; there
      // is nothing to show for an object that is gone.
      if (!store.object(this.objectName)) return;
      this.syncMode();
      this.code.refresh();
      this.buildEvents();
      this.buildBlockedList();
      this.drawPreview();
    });
  }

  private get entry() {
    const found = this.store.object(this.objectName);
    if (!found) throw new Error(`Object ${this.objectName} no longer exists`);
    return found;
  }

  private build(): HTMLElement {
    const def = this.entry.def;
    this.eventList = el('div', { class: 'event-grid' });
    this.preview = el('canvas', { class: 'object-preview', width: 96, height: 96 }) as HTMLCanvasElement;

    const spriteSelect = el('select', {
      onchange: (event: Event) => {
        const value = (event.target as HTMLSelectElement).value;
        this.store.commit('set object sprite', () => {
          this.entry.def.sprite = value || null;
        });
        this.drawPreview();
      },
    }) as HTMLSelectElement;

    const parentSelect = el('select', {
      onchange: (event: Event) => {
        const value = (event.target as HTMLSelectElement).value;
        this.store.commit('set object parent', () => {
          this.entry.def.parent = value || null;
        });
      },
    }) as HTMLSelectElement;

    const depth = el('input', {
      type: 'number',
      value: String(def.depth),
      onchange: (event: Event) => {
        const value = Number((event.target as HTMLInputElement).value) | 0;
        this.store.commit('set object depth', () => {
          this.entry.def.depth = value;
        });
      },
    }) as HTMLInputElement;

    const flag = (key: 'visible' | 'solid' | 'persistent', label: string) =>
      el('label', {}, el('input', {
        type: 'checkbox',
        checked: def[key],
        onchange: (event: Event) => {
          const checked = (event.target as HTMLInputElement).checked;
          this.store.commit(`set ${key}`, () => {
            this.entry.def[key] = checked;
          });
        },
      }), label);

    const refreshSelects = () => {
      clear(spriteSelect);
      spriteSelect.append(el('option', { value: '', text: '(no sprite)' }));
      for (const name of this.store.names('sprite')) {
        spriteSelect.append(el('option', { value: name, text: name }));
      }
      spriteSelect.value = this.entry.def.sprite ?? '';

      clear(parentSelect);
      parentSelect.append(el('option', { value: '', text: '(no parent)' }));
      for (const name of this.store.names('object')) {
        if (name === this.objectName) continue;
        parentSelect.append(el('option', { value: name, text: name }));
      }
      parentSelect.value = this.entry.def.parent ?? '';
    };
    refreshSelects();

    const left = el(
      'aside',
      { class: 'object-sidebar' },
      el(
        'section',
        {},
        el('h3', { text: 'Object' }),
        el('div', { class: 'kv' }, el('span', { text: 'Name' }), el('strong', { text: this.objectName })),
        el('label', { class: 'field' }, el('span', { text: 'Sprite' }), spriteSelect),
        el('label', { class: 'field', title: 'Type inheritance for is_a() and collision matching. Unrelated to the runtime instance tree (self.Parent).' },
          el('span', { text: 'Inherits' }), parentSelect),
        el('label', { class: 'field' }, el('span', { text: 'Depth' }), depth),
        el('div', { class: 'checks' }, flag('visible', 'Visible'), flag('solid', 'Solid'), flag('persistent', 'Persistent')),
      ),
      el('section', {}, el('h3', { text: 'Preview' }), el('div', { class: 'preview-wrap' }, this.preview)),
      el(
        'section',
        {},
        el('h3', { text: 'Collision' }),
        el('p', {
          class: 'muted small',
          text: 'Cannot walk into: the engine stops this object at anything ticked, no code needed.',
        }),
        (this.blockedList = el('div', { class: 'blocked-list' })),
      ),
      el(
        'section',
        {},
        el('h3', { text: 'Events' }),
        el('p', { class: 'muted small', text: 'Click an event to add it to the script.' }),
        this.eventList,
      ),
    );

    this.buildEvents();
    this.buildBlockedList();
    this.drawPreview();

    this.scriptHost = el('div', { class: 'object-script' });
    return el('div', { class: 'object-editor' }, left, this.scriptHost);
  }

  /**
   * The "cannot walk into" checklist: solid tiles plus every other object.
   *
   * Ticking one adds it to `blockedBy`; the engine then resolves this object's
   * movement against it, axis by axis, so plain `hspeed`/`vspeed` movement
   * respects walls with no collision code at all.
   */
  private buildBlockedList(): void {
    clear(this.blockedList);
    const blocked = new Set(this.entry.def.blockedBy ?? []);

    const row = (value: string, label: string) =>
      el(
        'label',
        { class: 'checkbox-row' },
        el('input', {
          type: 'checkbox',
          checked: blocked.has(value),
          onchange: (event: Event) => {
            const on = (event.target as HTMLInputElement).checked;
            this.store.commit(`set collision vs ${value}`, () => {
              const def = this.entry.def;
              const list = new Set(def.blockedBy ?? []);
              if (on) list.add(value);
              else list.delete(value);
              def.blockedBy = [...list];
            });
          },
        }),
        label,
      );

    this.blockedList.append(row('tiles', 'Solid tiles'));
    for (const name of this.store.names('object')) {
      if (name !== this.objectName) this.blockedList.append(row(name, name));
    }
  }

  activate(): void {
    if (this.blocks) this.blocks.activate();
    else this.code.activate?.();
    this.drawPreview();
  }

  deactivate(): void {
    this.blocks?.deactivate();
    this.code.deactivate?.();
  }

  dispose(): void {
    this.blocks?.dispose();
    this.code.dispose?.();
    this.unsubscribe?.();
  }

  /** Blocks when the project is in block mode and this object has some. */
  private wantsBlocks(): boolean {
    const entry = this.store.object(this.objectName);
    return !!entry && scriptingOf(this.store.project.config) === 'blocks' && !!entry.def.blocks;
  }

  /**
   * Show the block editor or the text editor, whichever the object calls
   * for, rebuilding only when the answer changes (a switch in settings, a
   * conversion, an undo of either).
   */
  private syncMode(): void {
    const wantBlocks = this.wantsBlocks();
    if (wantBlocks && !this.blocks) {
      this.code.deactivate?.();
      this.blocks = new BlockEditor(this.store, this.objectName, () => this.syncMode());
      clear(this.scriptHost);
      this.scriptHost.append(this.blocks.element);
      // Only inject once laid out; the panel may not be on screen yet.
      requestAnimationFrame(() => this.blocks?.activate());
      return;
    }
    if (!wantBlocks && this.blocks) {
      this.blocks.dispose();
      this.blocks = undefined;
    }
    if (!wantBlocks && this.scriptHost.firstChild !== this.code.element) {
      clear(this.scriptHost);
      if (scriptingOf(this.store.project.config) === 'blocks') this.scriptHost.append(this.startFromBlocksBar());
      this.scriptHost.append(this.code.element);
      this.code.refresh();
      this.code.activate?.();
    } else if (!wantBlocks) {
      // The mode is unchanged, but the project may have left or entered block
      // mode, which shows or hides the offer to start from blocks.
      const bar = this.scriptHost.querySelector('.start-from-blocks');
      const wantBar = scriptingOf(this.store.project.config) === 'blocks';
      if (wantBar && !bar) this.scriptHost.prepend(this.startFromBlocksBar());
      if (!wantBar && bar) bar.remove();
    }
  }

  /** In block mode, a hand-written object can be restarted as blocks. */
  private startFromBlocksBar(): HTMLElement {
    return el(
      'div',
      { class: 'start-from-blocks' },
      el('span', { class: 'muted small', text: 'This project uses blocks; this object is written as code.' }),
      el('button', {
        class: 'mini',
        text: 'Start from blocks',
        onclick: () => void this.startFromBlocks(),
      }),
    );
  }

  private async startFromBlocks(): Promise<void> {
    const body = el('div', { class: 'modal-body' },
      el('p', { text: `Replace ${this.objectName}'s code with an empty block workspace? The current script is discarded (undo brings it back).` }));
    if (!(await modal('Start from blocks', body, 'Start'))) return;
    const generate = await import('../blocks/generate');
    let state = generate.emptyWorkspace();
    for (const event of ['create', 'step']) state = generate.addEventHat(state, event);
    const source = generate.generateSource(state, languageOf(this.store.project.config));
    this.store.commit('start from blocks', () => {
      const entry = this.store.object(this.objectName);
      if (!entry) return;
      entry.def.blocks = state;
      entry.source = source;
    });
    this.syncMode();
  }

  private buildEvents(): void {
    clear(this.eventList);
    const language = languageOf(this.store.project.config);
    const defined = definedEvents(this.entry.source, language);

    for (const event of EVENTS) {
      const isDefined = defined.has(event.name);
      this.eventList.append(
        el(
          'button',
          {
            class: 'event' + (isDefined ? ' defined' : ''),
            title: isDefined
              ? `${event.name}() is defined`
              : `Add ${eventSignature(event, language)} to the script`,
            onclick: () => {
              if (isDefined) return;
              if (this.blocks) {
                void this.blocks.addEvent(event.name);
                return;
              }
              this.store.commit(`add ${event.name} event`, () => {
                this.entry.source = insertEventStub(this.entry.source, event, language);
              });
              this.code.refresh();
              this.buildEvents();
            },
          },
          el('span', { class: 'dot' }),
          el('span', { text: event.label }),
        ),
      );
    }
  }

  private drawPreview(): void {
    const ctx = this.preview.getContext('2d')!;
    ctx.clearRect(0, 0, 96, 96);
    const spriteName = this.store.object(this.objectName)?.def.sprite;
    const sprite = spriteName ? this.store.sprite(spriteName) : undefined;
    if (!sprite?.frames[0]) return;

    const image = new Image();
    image.onload = () => {
      ctx.imageSmoothingEnabled = false;
      const scale = Math.max(1, Math.floor(Math.min(96 / sprite.width, 96 / sprite.height))) || 1;
      const w = sprite.width * scale;
      const h = sprite.height * scale;
      ctx.clearRect(0, 0, 96, 96);
      ctx.drawImage(image, (96 - w) / 2, (96 - h) / 2, w, h);
    };
    image.src = 'data:image/png;base64,' + sprite.frames[0];
  }
}
