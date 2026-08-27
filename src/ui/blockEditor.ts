import { languageInfo, languageOf } from '../project/languages';
import type { ProjectStore } from '../project/store';
import type { BlockWorkspace, ScriptLanguage } from '../project/types';
import { clear, el, modal, type Panel } from './dom';
import { highlightLuau } from './luauSyntax';
import { highlightPython } from './pythonSyntax';

/**
 * The Scratch-style block editor for one object.
 *
 * Blockly (with its Scratch-like "zelos" renderer) is loaded on first use, so
 * a project that never opens block mode never downloads it. The workspace is
 * the source of truth while it is open: every change is saved as the object's
 * `blocks` AND compiled into its script, so the engine, exports and error
 * reporting see ordinary Luau or Python. The generated code can be shown
 * beside the blocks, and an object can be converted to code for good.
 *
 * Nothing Blockly needs is fetched at runtime: no trashcan, no zoom controls,
 * no sounds, so no `media/` requests -- the single-file editor and the
 * desktop app run from `file://`.
 */

type BlocklyModule = typeof import('blockly');
type Generate = typeof import('../blocks/generate');
type Defs = typeof import('../blocks/blockDefs');

interface Loaded {
  Blockly: BlocklyModule;
  generate: Generate;
  defs: Defs;
}

let loading: Promise<Loaded> | undefined;
let loadedModule: Loaded | undefined;

/** Blockly, once a block editor has loaded it; for the browser tests. */
export function loadedBlockly(): BlocklyModule | undefined {
  return loadedModule?.Blockly;
}

/** Load Blockly and the engine's block definitions once per session. */
function load(): Promise<Loaded> {
  loading ??= (async () => {
    const [Blockly, generate, defs] = await Promise.all([
      import('blockly'),
      import('../blocks/generate'),
      import('../blocks/blockDefs'),
    ]);
    defs.installBlocks();
    loadedModule = { Blockly, generate, defs };
    return loadedModule;
  })();
  return loading;
}

/** Read the editor's own palette so blocks sit on the same dark ground. */
function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function makeTheme(Blockly: BlocklyModule) {
  const registered = Blockly.registry.getObject(Blockly.registry.Type.THEME, 'benseditor');
  if (registered) return registered;
  return Blockly.Theme.defineTheme('benseditor', {
    name: 'benseditor',
    base: Blockly.Themes.Zelos,
    componentStyles: {
      workspaceBackgroundColour: cssVar('--bg', '#14161c'),
      toolboxBackgroundColour: cssVar('--panel', '#1b1e26'),
      toolboxForegroundColour: cssVar('--text', '#dfe3ec'),
      flyoutBackgroundColour: cssVar('--panel-2', '#21252f'),
      flyoutForegroundColour: cssVar('--text', '#dfe3ec'),
      flyoutOpacity: 1,
      scrollbarColour: cssVar('--border', '#2b303c'),
      scrollbarOpacity: 0.6,
      insertionMarkerColour: cssVar('--accent', '#29adff'),
      insertionMarkerOpacity: 0.4,
      cursorColour: cssVar('--accent', '#29adff'),
      selectedGlowColour: cssVar('--accent', '#29adff'),
      selectedGlowOpacity: 0.4,
    },
    fontStyle: { family: 'ui-sans-serif, system-ui, sans-serif', weight: '500', size: 11 },
  });
}

export class BlockEditor implements Panel {
  readonly element: HTMLElement;

  private readonly host: HTMLElement;
  private readonly codeView: HTMLElement;
  private readonly badge: HTMLElement;
  private workspace: import('blockly').WorkspaceSvg | undefined;
  private loaded: Loaded | undefined;
  private saveTimer = 0;
  /** JSON of the blocks last written to, or read from, the store. */
  private lastSerialized = '';
  /** Set while loading state into the workspace, so its events are not saves. */
  private restoring = false;
  private showingCode = false;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly store: ProjectStore,
    private readonly objectName: string,
    private readonly onConverted: () => void,
  ) {
    this.host = el('div', { class: 'block-workspace' });
    this.codeView = el('pre', { class: 'code-highlight block-code', hidden: true });
    this.badge = el('span', { class: 'muted small', text: 'Blocks' });
    const language = languageInfo(store.project.config);

    this.element = el(
      'div',
      { class: 'block-editor' },
      el(
        'div',
        { class: 'code-header' },
        el('strong', { text: `${objectName}.${language.extension}` }),
        this.badge,
        el('span', { class: 'grow' }),
        el('button', {
          class: 'mini block-view-code',
          text: 'View code',
          title: `Show the ${language.label} these blocks compile to`,
          onclick: () => this.toggleCode(),
        }),
        el('button', {
          class: 'mini block-convert',
          text: 'Convert to code',
          title: 'Keep the generated script and edit it as text from now on. The blocks are dropped.',
          onclick: () => void this.convert(),
        }),
      ),
      this.host,
      this.codeView,
    );

    this.unsubscribe = store.on('change', () => this.syncFromStore());
  }

  private get language(): ScriptLanguage {
    return languageOf(this.store.project.config);
  }

  private get blocks(): BlockWorkspace | undefined {
    return this.store.object(this.objectName)?.def.blocks;
  }

  activate(): void {
    // Injected on first show: Blockly measures its container, so it needs
    // real layout -- main.ts activates panels after they are in the DOM.
    if (!this.workspace) void this.inject();
    else this.loaded?.Blockly.svgResize(this.workspace);
  }

  deactivate(): void {
    this.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.flush();
    this.unsubscribe();
    this.workspace?.dispose();
    this.workspace = undefined;
  }

  private async inject(): Promise<void> {
    const loaded = await load();
    if (this.disposed || this.workspace) return;
    this.loaded = loaded;
    const { Blockly, defs } = loaded;

    const workspace = Blockly.inject(this.host, {
      renderer: 'zelos',
      theme: makeTheme(Blockly),
      // Blockly's default media path is its CDN, and its stylesheet points a
      // few cosmetic assets there (resize handles, a delete cursor) even with
      // the trashcan, zoom controls and sounds off. A `data:` prefix makes
      // those URLs inert -- nothing is fetched, from a CDN or from disk, which
      // is what file:// and the single-file editor need.
      media: 'data:,',
      toolbox: defs.TOOLBOX as unknown as import('blockly').utils.toolbox.ToolboxDefinition,
      trashcan: false,
      sounds: false,
      zoom: { controls: false, wheel: true, startScale: 0.75, minScale: 0.4, maxScale: 1.5 },
      move: { scrollbars: true, drag: true, wheel: false },
      grid: { spacing: 24, length: 3, colour: cssVar('--border', '#2b303c'), snap: true },
    });
    this.workspace = workspace;
    this.restore(this.blocks ?? loaded.generate.emptyWorkspace());

    workspace.addChangeListener((event) => {
      if (this.restoring || event.isUiEvent) return;
      this.scheduleSave();
    });
    if (this.showingCode) this.renderCode();
  }

  /** Put `state` into the workspace without treating it as an edit. */
  private restore(state: BlockWorkspace): void {
    if (!this.workspace || !this.loaded) return;
    this.restoring = true;
    try {
      this.loaded.Blockly.serialization.workspaces.load(state, this.workspace);
    } finally {
      this.restoring = false;
    }
    this.lastSerialized = JSON.stringify(state);
  }

  private scheduleSave(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), 250);
  }

  /** Save the workspace as the object's blocks and regenerate its script. */
  private flush(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    if (!this.workspace || !this.loaded) return;
    const { Blockly, generate } = this.loaded;
    const state = Blockly.serialization.workspaces.save(this.workspace) as BlockWorkspace;
    const serialized = JSON.stringify(state);
    if (serialized === this.lastSerialized) return;
    if (!this.store.object(this.objectName)) return;

    const source = generate.generateSource(state, this.language);
    this.lastSerialized = serialized;
    this.store.commit('edit blocks', () => {
      const entry = this.store.object(this.objectName);
      if (!entry) return;
      entry.def.blocks = state;
      entry.source = source;
    });
    if (this.showingCode) this.renderCode();
  }

  /** An undo, or another editor, changed the blocks underneath us. */
  private syncFromStore(): void {
    const blocks = this.blocks;
    if (!blocks || !this.workspace) return;
    const serialized = JSON.stringify(blocks);
    if (serialized === this.lastSerialized) return;
    clearTimeout(this.saveTimer);
    this.restore(blocks);
    if (this.showingCode) this.renderCode();
  }

  /** Add a hat for `event`, the way the checklist's stub button adds a function. */
  async addEvent(event: string): Promise<void> {
    const loaded = await load();
    const current = this.blocks ?? loaded.generate.emptyWorkspace();
    const next = loaded.generate.addEventHat(current, event);
    const source = loaded.generate.generateSource(next, this.language);
    this.lastSerialized = JSON.stringify(next);
    this.store.commit(`add ${event} event`, () => {
      const entry = this.store.object(this.objectName);
      if (!entry) return;
      entry.def.blocks = next;
      entry.source = source;
    });
    if (this.workspace) this.restore(next);
    if (this.showingCode) this.renderCode();
  }

  private toggleCode(): void {
    this.showingCode = !this.showingCode;
    this.element.classList.toggle('show-code', this.showingCode);
    this.codeView.hidden = !this.showingCode;
    if (this.showingCode) this.renderCode();
    if (this.workspace && this.loaded) {
      // The workspace just changed width.
      requestAnimationFrame(() => this.workspace && this.loaded?.Blockly.svgResize(this.workspace));
    }
  }

  private renderCode(): void {
    const source = this.store.object(this.objectName)?.source ?? '';
    clear(this.codeView);
    this.codeView.innerHTML =
      (this.language === 'python' ? highlightPython(source) : highlightLuau(source)) + '\n';
  }

  private async convert(): Promise<void> {
    const body = el(
      'div',
      { class: 'modal-body' },
      el('p', {
        text:
          `Keep ${this.objectName}'s generated ${languageInfo(this.store.project.config).label} and edit it as text? ` +
          'The blocks are removed from this object; the code is exactly what they compiled to.',
      }),
    );
    if (!(await modal('Convert to code', body, 'Convert'))) return;
    this.flush();
    this.store.commit('convert blocks to code', () => {
      const entry = this.store.object(this.objectName);
      if (entry) delete entry.def.blocks;
    });
    this.onConverted();
  }
}
