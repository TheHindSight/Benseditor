// Imported rather than linked from index.html, so builds without an HTML entry
// (the single-file editor) still get the stylesheet.
import './style.css';
import { buildSnakeProject } from './demo/snake';
import { buildStarterProject } from './demo/starter';
import { buildBlankProject } from './project/create';
import { ProjectStore, type AssetKind } from './project/store';
import type { Project } from './project/types';
import {
  autosave,
  exportProject,
  importProject,
  loadAutosave,
  openProjectFolder,
  pickFolder,
  saveProjectToFolder,
  supportsFileSystemAccess,
} from './project/storage';
import { validateLoaded } from './project/validate';
import { desktop, isDesktop } from './project/desktop';
import { exportGame } from './project/exportGame';
import { AssetOps } from './ui/assetOps';
import { AssetTree } from './ui/assetTree';
import { ExplorerTree } from './ui/explorerTree';
import { loadedBlockly } from './ui/blockEditor';
import { languageChooser, paradigmChooser, paradigmOf, scriptingChooser, showProjectSettings } from './ui/projectSettings';
import { languageInfo, languageOf } from './project/languages';
import { specFor } from './ui/languageSpecs';
import { reconcileExplorer } from './project/explorer';
import { CodeEditor } from './ui/codeEditor';
import { DocsPanel } from './ui/docsPanel';
import { clear, el, modal, type Panel } from './ui/dom';
import { GamePanel } from './ui/gamePanel';
import { KEY_NAMES } from './ui/luauApi';
import { ObjectEditor } from './ui/objectEditor';
import { RoomEditor } from './ui/roomEditor';
import { SpriteEditor } from './ui/spriteEditor';
import { TilesetEditor } from './ui/tilesetEditor';

/** Names worth offering inside a string literal in game code. */
function completableNames(): string[] {
  return [
    ...store.names('object'),
    ...store.names('sprite'),
    ...store.names('tileset'),
    ...store.names('room'),
    ...KEY_NAMES,
  ];
}

/** App shell: asset tree on the left, tabbed editors in the middle. */

interface Tab {
  id: string;
  title: string;
  panel: Panel;
  closable: boolean;
}

const store = new ProjectStore(loadAutosave() ?? buildStarterProject());

const tabs: Tab[] = [];
let activeTabId: string | null = null;
let folderHandle: FileSystemDirectoryHandle | undefined;

const tabBar = el('div', { class: 'tab-bar' });
const panelHost = el('div', { class: 'panel-host' });
const projectLabel = el('span', { class: 'project-name' });
const dirtyDot = el('span', { class: 'dirty-dot', hidden: true, title: 'Unsaved changes' });

const gamePanel = new GamePanel(store);
// Built on first use: the manual is a fair amount of DOM for something many
// sessions never open.
let docsPanel: DocsPanel | undefined;

function openDocs(sectionId?: string): void {
  openTab('docs:manual', 'Docs', () => (docsPanel = new DocsPanel(languageOf(store.project.config))));
  docsPanel?.setLanguage(languageOf(store.project.config));
  if (sectionId) docsPanel?.show(sectionId);
}

// ---- tabs ---------------------------------------------------------------

function tabId(kind: AssetKind | 'game' | 'docs', name: string): string {
  return `${kind}:${name}`;
}

function openTab(id: string, title: string, make: () => Panel, closable = true): void {
  const existing = tabs.find((tab) => tab.id === id);
  if (existing) {
    activateTab(id);
    return;
  }
  tabs.push({ id, title, panel: make(), closable });
  activateTab(id);
}

function activateTab(id: string): void {
  if (activeTabId === id) return;
  const previous = tabs.find((tab) => tab.id === activeTabId);
  previous?.panel.deactivate?.();

  activeTabId = id;
  const tab = tabs.find((t) => t.id === id);
  clear(panelHost);
  if (tab) {
    panelHost.append(tab.panel.element);
    // Activate after layout so panels can measure their canvases.
    requestAnimationFrame(() => tab.panel.activate?.());
  }
  renderTabs();
}

function closeTab(id: string): void {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  const [tab] = tabs.splice(index, 1);
  tab.panel.dispose?.();

  if (activeTabId === id) {
    activeTabId = null;
    const next = tabs[index] ?? tabs[index - 1];
    if (next) activateTab(next.id);
    else clear(panelHost);
  }
  renderTabs();
}

function renderTabs(): void {
  clear(tabBar);
  for (const tab of tabs) {
    tabBar.append(
      el(
        'div',
        {
          class: 'tab' + (tab.id === activeTabId ? ' active' : ''),
          onclick: () => activateTab(tab.id),
        },
        el('span', { text: tab.title }),
        tab.closable
          ? el('button', {
              class: 'tab-close',
              text: '×',
              title: 'Close',
              onclick: (event: MouseEvent) => {
                event.stopPropagation();
                closeTab(tab.id);
              },
            })
          : null,
      ),
    );
  }
}

function openAsset(kind: AssetKind, name: string): void {
  const id = tabId(kind, name);
  openTab(id, name, () => {
    switch (kind) {
      case 'sprite':
        return new SpriteEditor(store, name);
      case 'tileset':
        return new TilesetEditor(store, name);
      case 'room':
        return new RoomEditor(store, name);
      case 'object':
        return new ObjectEditor(store, name, completableNames);
      case 'script':
        return new CodeEditor(
          () => store.script(name)?.source ?? '',
          (source) =>
            store.commit('edit script', () => {
              const script = store.script(name);
              if (script) script.source = source;
            }),
          `${name}.${languageInfo(store.project.config).extension}`,
          completableNames,
          specFor(languageOf(store.project.config)),
        );
    }
  });
}

// ---- sidebar: the flat asset tree, or the Explorer ----------------------

const assetOps = new AssetOps(
  store,
  openAsset,
  (kind, from, to) => {
    // Reopen under the new name so the panel binds to the right asset.
    closeTab(tabId(kind, from));
    openAsset(kind, to);
  },
  (kind, name) => closeTab(tabId(kind, name)),
);

const tree = new AssetTree(store, assetOps, openAsset);
const explorer = new ExplorerTree(store, assetOps, openAsset);
const sidebar = el('aside', { class: 'sidebar' });

/** Show whichever view the project's paradigm asks for. */
function syncSidebar(): void {
  const wanted = paradigmOf(store) === 'roblox' ? explorer.element : tree.element;
  if (sidebar.firstChild === wanted) return;
  clear(sidebar);
  sidebar.append(wanted);
  sidebar.dataset.paradigm = paradigmOf(store);
}
syncSidebar();
store.on('structure', () => {
  syncSidebar();
  // The manual follows the project's language; the toggle can still override.
  docsPanel?.setLanguage(languageOf(store.project.config));
});

// ---- project actions ----------------------------------------------------

/** Swap in a different project, closing whatever was open. */
function adoptProject(project: Project, handle?: FileSystemDirectoryHandle): void {
  for (const tab of [...tabs]) if (tab.closable) closeTab(tab.id);
  folderHandle = handle;
  // A new project must not save over wherever the previous one lived.
  desktopRoot = undefined;
  store.replace(project);
  projectLabel.textContent = project.config.name;
  explorer.resetExpansion();
  tree.refresh();
  explorer.refresh();
  syncSidebar();

  const start = project.config.startRoom;
  if (store.room(start)) openAsset('room', start);
}

async function doNewProject(): Promise<void> {
  if (store.isDirty) {
    const body = el('div', { class: 'modal-body' },
      el('p', { text: 'The current project has unsaved changes. Start a new one anyway?' }));
    if (!(await modal('Discard changes?', body, 'Discard'))) return;
  }

  const nameInput = el('input', { type: 'text', value: 'Untitled' }) as HTMLInputElement;
  const template = el(
    'select',
    {},
    el('option', { value: 'blank', text: 'Blank — one black room' }),
    el('option', { value: 'demo', text: 'Coin collector — the walkthrough demo' }),
    el('option', { value: 'snake', text: 'Snake — a complete little game' }),
  ) as HTMLSelectElement;
  const paradigm = paradigmChooser('gamemaker');
  const language = languageChooser('luau');
  const scripting = scriptingChooser('code');
  const languageNote = el('p', { class: 'muted small', hidden: true, text: 'The demo projects are written in Luau.' });
  // The demos are Luau; only a blank project can start in Python.
  const syncLanguage = () => {
    const blank = template.value === 'blank';
    for (const input of language.element.querySelectorAll('input')) {
      input.disabled = !blank;
      if (!blank && input.value === 'luau') input.checked = true;
    }
    for (const input of scripting.element.querySelectorAll('input')) {
      input.disabled = !blank;
      if (!blank && input.value === 'code') input.checked = true;
    }
    languageNote.hidden = blank;
  };
  template.addEventListener('change', syncLanguage);

  const body = el(
    'div',
    { class: 'modal-body' },
    el('label', { class: 'field' }, el('span', { text: 'Name' }), nameInput),
    el('label', { class: 'field' }, el('span', { text: 'From' }), template),
    el('div', { class: 'field' }, el('span', { text: 'Language' }), language.element),
    el('div', { class: 'field' }, el('span', { text: 'Scripting' }), scripting.element),
    languageNote,
    el('div', { class: 'field' }, el('span', { text: 'Style' }), paradigm.element),
  );

  // Name follows the template until the user types their own.
  let renamed = false;
  nameInput.addEventListener('input', () => {
    renamed = true;
  });
  template.addEventListener('change', () => {
    if (renamed) return;
    nameInput.value =
      template.value === 'snake' ? 'Snake' : template.value === 'demo' ? 'Demo Game' : 'Untitled';
  });

  if (!(await modal('New project', body, 'Create'))) return;

  const name = nameInput.value.trim() || 'Untitled';
  const build =
    template.value === 'snake'
      ? buildSnakeProject
      : template.value === 'demo'
        ? buildStarterProject
        : buildBlankProject;

  const project =
    build === buildBlankProject ? buildBlankProject(name, language.value()) : build(name);
  if (build === buildBlankProject && scripting.value() === 'blocks') project.config.scripting = 'blocks';
  if (paradigm.value() === 'roblox') {
    project.config.paradigm = 'roblox';
    reconcileExplorer(project);
  }

  // No folder handle: Save must ask where to put it, rather than overwriting
  // whatever project was open before.
  adoptProject(project);
}

/** Where the open project lives on disk, when running on the desktop. */
let desktopRoot: string | undefined;

async function doOpenFolder(): Promise<void> {
  if (desktop) {
    try {
      const root = await desktop.openProjectDialog();
      if (!root) return;
      const project = await desktop.readProject(root);
      adoptProject(validateLoaded(project));
      desktopRoot = root;
      projectLabel.textContent = `${project.config.name} — ${root}`;
    } catch (error) {
      await warn(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  try {
    const { project, handle } = await openProjectFolder();
    adoptProject(project, handle);
  } catch (error) {
    if ((error as DOMException)?.name === 'AbortError') return;
    await warn(error instanceof Error ? error.message : String(error));
  }
}

async function doSave(): Promise<void> {
  if (desktop) {
    try {
      desktopRoot ??= (await desktop.chooseFolder('Choose a folder for this project')) ?? undefined;
      if (!desktopRoot) return;
      await desktop.writeProject(desktopRoot, store.project);
      store.markClean();
      projectLabel.textContent = `${store.project.config.name} — ${desktopRoot}`;
    } catch (error) {
      await warn(error instanceof Error ? error.message : String(error));
    }
    return;
  }

  if (!folderHandle) {
    if (!supportsFileSystemAccess) return void exportProject(store.project);
    try {
      folderHandle = await pickFolder();
    } catch {
      return; // picker dismissed
    }
  }

  const handle = folderHandle;
  try {
    await saveProjectToFolder(handle, store.project);
    store.markClean();
  } catch (error) {
    await warn(error instanceof Error ? error.message : String(error));
  }
}

async function warn(message: string): Promise<void> {
  await modal('Something went wrong', el('div', { class: 'modal-body' }, el('p', { text: message })), 'OK');
}

// ---- shell --------------------------------------------------------------

const canOpenFolders = isDesktop || supportsFileSystemAccess;

const openButton = el('button', {
  text: 'Open folder',
  title: canOpenFolders
    ? 'Open a project folder from disk'
    : 'This browser cannot open folders; use Import instead',
  disabled: !canOpenFolders,
  onclick: () => void doOpenFolder(),
});

const app = el(
  'div',
  { class: 'app' },
  el(
    'header',
    { class: 'topbar' },
    el(
      'div',
      { class: 'brand' },
      el('span', {
        class: 'brand-mark',
        html:
          '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">' +
          '<path d="M3 4h4v4H3V4zm6 0h4v4H9V4zm6 0h4v4h-4V4zM3 10h4v4H3v-4zm12 0h4v4h-4v-4zM3 16h4v4H3v-4zm6 0h4v4H9v-4zm6 0h4v4h-4v-4z" opacity="0.45"/>' +
          '<path d="M9 10h4v4H9v-4z"/></svg>',
      }),
      el('span', { text: 'Benseditor' }),
    ),
    projectLabel,
    dirtyDot,
    el('span', { class: 'grow' }),
    el('button', { text: '▶ Play', class: 'primary', onclick: () => void playGame() }),
    el('button', {
      text: 'Docs',
      title: 'The manual: the whole Luau API, with examples (F1)',
      onclick: () => openDocs(),
    }),
    el('button', { text: 'New', title: 'Start a new project', onclick: () => void doNewProject() }),
    openButton,
    el('button', {
      text: 'Settings',
      title: 'Project settings: GameMaker or Roblox style',
      onclick: () => void showProjectSettings(store),
    }),
    el('button', { text: 'Save', onclick: () => void doSave() }),
    el('button', {
      class: 'primary',
      text: 'Export game',
      title: 'Write a single playable HTML file',
      onclick: async () => {
        try {
          const target = await exportGame(store.project);
          if (target && desktop) {
            await desktop.showItemInFolder(target);
          }
        } catch (error) {
          await warn(error instanceof Error ? error.message : String(error));
        }
      },
    }),
    el('button', {
      text: 'Export project',
      title: 'Download the project as one JSON file',
      onclick: () => exportProject(store.project),
    }),
    el('button', {
      text: 'Import',
      onclick: async () => {
        try {
          adoptProject(await importProject());
        } catch (error) {
          await warn(error instanceof Error ? error.message : String(error));
        }
      },
    }),
  ),
  el(
    'main',
    { class: 'body' },
    sidebar,
    el('section', { class: 'editor-area' }, tabBar, panelHost),
  ),
);

document.body.append(app);

async function playGame(): Promise<void> {
  openTab('game:play', '▶ Game', () => gamePanel, false);
  await gamePanel.run();
}

// ---- global wiring ------------------------------------------------------

projectLabel.textContent = store.project.config.name;

store.on('change', () => {
  dirtyDot.hidden = !store.isDirty;
});

// Autosave, coalesced so a paint stroke does not write on every pixel.
let autosaveTimer = 0;
store.on('change', () => {
  clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => autosave(store.project), 800);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'F1') {
    event.preventDefault();
    openDocs();
    return;
  }
  if (!(event.ctrlKey || event.metaKey)) return;
  const key = event.key.toLowerCase();

  // Let a text field handle its own undo when it has focus -- inputs as well as
  // textareas, or Ctrl+Z in the find box would roll back the whole project.
  // The block editor keeps its own undo stack too.
  const target = event.target as HTMLElement | null;
  const tag = target?.tagName;
  const editing =
    tag === 'TEXTAREA' || tag === 'INPUT' || !!target?.closest?.('.injectionDiv, .block-editor');

  if (key === 'z' && !event.shiftKey) {
    if (editing) return;
    event.preventDefault();
    store.undo();
  } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
    if (editing) return;
    event.preventDefault();
    store.redo();
  } else if (key === 's') {
    event.preventDefault();
    void doSave();
  }
});

window.addEventListener('beforeunload', (event) => {
  if (store.isDirty) {
    event.preventDefault();
    event.returnValue = '';
  }
});

// Open something useful on first load.
const startRoom = store.project.config.startRoom;
if (store.room(startRoom)) openAsset('room', startRoom);

// Exposed for the browser smoke test.

// Exposed for the browser smoke test.
declare global {
  interface Window {
    __benseditor?: {
      store: ProjectStore;
      play: () => Promise<void>;
      openAsset: (kind: AssetKind, name: string) => void;
      openDocs: (sectionId?: string) => void;
      readonly game: GamePanel;
      readonly explorer: ExplorerTree;
      /** Blockly, once block mode has loaded it. */
      readonly blockly: ReturnType<typeof loadedBlockly>;
    };
  }
}
window.__benseditor = {
  store,
  play: playGame,
  openAsset,
  openDocs,
  get game() {
    return gamePanel;
  },
  get explorer() {
    return explorer;
  },
  get blockly() {
    return loadedBlockly();
  },
};
