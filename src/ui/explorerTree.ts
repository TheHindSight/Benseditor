import {
  SERVICE_IDS,
  canDrop,
  childrenOf,
  kindsUnder,
  newFolderId,
  reconcileExplorer,
  removeFolder,
  serviceOf,
} from '../project/explorer';
import type { AssetKind, ProjectStore } from '../project/store';
import type { ExplorerNode } from '../project/types';
import type { AssetOps } from './assetOps';
import { clear, el } from './dom';

/**
 * The Roblox-style sidebar: services, folders and assets as one tree.
 *
 * This is a second *view* of the same project the flat `AssetTree` shows; the
 * two share `AssetOps` for every create/rename/delete, and differ only in how
 * assets are arranged. The arrangement itself is `config.explorer`, edited
 * here by drag-and-drop and the context menus.
 *
 * An object's script and sprite appear as derived rows beneath it, the way a
 * Roblox Part carries its Script: they are not nodes of the tree, so nothing
 * can drag them elsewhere, and they open the same editors.
 */

const ICONS: Record<AssetKind | 'folder' | 'service' | 'asset', string> = {
  asset: '',
  service: '◆',
  folder: '▸',
  sprite: '🎨',
  tileset: '▩',
  object: '⬢',
  room: '▦',
  script: '{}',
};

const KIND_LABEL: Record<AssetKind, string> = {
  sprite: 'sprite',
  tileset: 'tileset',
  object: 'object',
  room: 'room',
  script: 'script',
};

const PREFIX: Record<AssetKind, string> = {
  sprite: 'spr_',
  tileset: 'ts_',
  object: 'obj_',
  room: 'rm_',
  script: '',
};

const DRAG_TYPE = 'text/x-benseditor-node';

export class ExplorerTree {
  readonly element: HTMLElement;
  /**
   * Which nodes are open. Held on the instance rather than in the DOM, so a
   * full rebuild after a structural commit keeps every branch where it was.
   */
  private readonly expanded = new Set<string>();

  constructor(
    private readonly store: ProjectStore,
    private readonly ops: AssetOps,
    private readonly onOpen: (kind: AssetKind, name: string) => void,
  ) {
    this.element = el('div', { class: 'explorer-tree' });
    this.resetExpansion();
    this.refresh();
    store.on('structure', () => this.refresh());
  }

  /** Services open, everything else closed -- the state for a newly opened project. */
  resetExpansion(): void {
    this.expanded.clear();
    for (const id of Object.values(SERVICE_IDS)) this.expanded.add(id);
  }

  private get nodes(): ExplorerNode[] {
    // Reading through a stale or missing tree would show nothing; reconcile is
    // idempotent and cheap, but it is a mutation, so only fall back to it when
    // the tree is genuinely absent.
    return this.store.project.config.explorer ?? reconcileExplorer(this.store.project);
  }

  refresh(): void {
    clear(this.element);
    const nodes = this.nodes;
    for (const service of childrenOf(nodes, null)) {
      this.element.append(this.renderNode(nodes, service, 0));
    }
  }

  private renderNode(nodes: ExplorerNode[], node: ExplorerNode, depth: number): HTMLElement {
    const kids = childrenOf(nodes, node.id).sort(byKindThenName);
    const derived = node.asset?.kind === 'object' ? this.derivedRows(node.asset.name, depth + 1) : [];
    const expandable = kids.length > 0 || derived.length > 0;
    const open = this.expanded.has(node.id);
    const isStartRoom =
      node.asset?.kind === 'room' && this.store.project.config.startRoom === node.asset.name;

    const row = el(
      'div',
      {
        class: `explorer-row explorer-${node.kind}` + (node.asset ? ` explorer-${node.asset.kind}` : ''),
        style: `--depth:${depth}`,
        dataset: { node: node.id },
        draggable: node.kind !== 'service' ? 'true' : 'false',
        onclick: () => {
          if (node.asset) this.onOpen(node.asset.kind, node.asset.name);
          else this.toggle(node.id);
        },
        oncontextmenu: (event: MouseEvent) => {
          event.preventDefault();
          this.showMenu(node, event);
        },
      },
      el('span', {
        class: 'explorer-chevron' + (expandable ? '' : ' hidden'),
        text: open ? '▾' : '▸',
        onclick: (event: MouseEvent) => {
          event.stopPropagation();
          this.toggle(node.id);
        },
      }),
      el('span', { class: 'asset-icon', text: ICONS[node.asset?.kind ?? node.kind] }),
      el('span', { class: 'asset-name', text: node.name }),
      isStartRoom ? el('span', { class: 'badge', text: 'start' }) : null,
      node.kind !== 'asset' ? this.addButton(nodes, node) : null,
    );

    this.wireDrag(node, row);

    const box = el('div', { class: 'explorer-node' }, row);
    if (expandable && open) {
      const list = el('div', { class: 'explorer-children' });
      for (const child of kids) list.append(this.renderNode(nodes, child, depth + 1));
      for (const extra of derived) list.append(extra);
      box.append(list);
    }
    return box;
  }

  /** The "+" on a service or folder: a new asset of the domain's first kind. */
  private addButton(nodes: ExplorerNode[], node: ExplorerNode): HTMLElement {
    const service = serviceOf(nodes, node.id) ?? SERVICE_IDS.assets;
    const kind = kindsUnder(service)[0];
    return el('button', {
      class: 'mini',
      text: '+',
      title: `New ${KIND_LABEL[kind]} here`,
      onclick: (event: MouseEvent) => {
        event.stopPropagation();
        this.expanded.add(node.id);
        void this.ops.create(kind, PREFIX[kind], node.id);
      },
    });
  }

  /** An object's script and sprite, shown beneath it like a Part's children. */
  private derivedRows(objectName: string, depth: number): HTMLElement[] {
    const entry = this.store.object(objectName);
    if (!entry) return [];
    const rows = [
      el(
        'div',
        {
          class: 'explorer-row explorer-derived',
          style: `--depth:${depth}`,
          onclick: () => this.onOpen('object', objectName),
        },
        el('span', { class: 'explorer-chevron hidden' }),
        el('span', { class: 'asset-icon', text: ICONS.script }),
        el('span', { class: 'asset-name', text: 'Script' }),
        el('span', { class: 'muted small', text: `${objectName}.luau` }),
      ),
    ];
    if (entry.def.sprite) {
      const sprite = entry.def.sprite;
      rows.push(
        el(
          'div',
          {
            class: 'explorer-row explorer-derived',
            style: `--depth:${depth}`,
            onclick: () => this.onOpen('sprite', sprite),
          },
          el('span', { class: 'explorer-chevron hidden' }),
          el('span', { class: 'asset-icon', text: ICONS.sprite }),
          el('span', { class: 'asset-name', text: 'Sprite' }),
          el('span', { class: 'muted small', text: sprite }),
        ),
      );
    }
    return rows;
  }

  private toggle(id: string): void {
    if (this.expanded.has(id)) this.expanded.delete(id);
    else this.expanded.add(id);
    this.refresh();
  }

  // -- drag to reparent -------------------------------------------------

  private wireDrag(node: ExplorerNode, row: HTMLElement): void {
    if (node.kind !== 'service') {
      row.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData(DRAG_TYPE, node.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        row.classList.add('dragging');
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
    }
    if (node.kind === 'asset') return;

    row.addEventListener('dragover', (event) => {
      const dragged = event.dataTransfer?.types.includes(DRAG_TYPE);
      if (!dragged) return;
      event.preventDefault();
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (event) => {
      row.classList.remove('drop-target');
      const id = event.dataTransfer?.getData(DRAG_TYPE);
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      this.move(id, node.id);
    });
  }

  /** Reparent `id` under `targetId` when the tree allows it. Returns whether it did. */
  move(id: string, targetId: string): boolean {
    if (!canDrop(this.nodes, id, targetId)) return false;
    this.store.commit(
      'move in explorer',
      () => {
        const nodes = this.nodes;
        const node = nodes.find((n) => n.id === id);
        if (node && canDrop(nodes, id, targetId)) node.parentId = targetId;
      },
      true,
    );
    this.expanded.add(targetId);
    this.refresh();
    return true;
  }

  // -- folders ---------------------------------------------------------

  async newFolder(parentId: string): Promise<void> {
    const name = await this.ops.prompt('New folder', 'Name', 'Folder');
    if (!name) return;
    const id = newFolderId();
    this.store.commit(
      'new folder',
      () => {
        this.nodes.push({ id, kind: 'folder', name, parentId });
      },
      true,
    );
    this.expanded.add(parentId);
    this.expanded.add(id);
    this.refresh();
  }

  private async renameFolder(node: ExplorerNode): Promise<void> {
    const name = await this.ops.prompt('Rename folder', 'Name', node.name);
    if (!name || name === node.name) return;
    this.store.commit(
      'rename folder',
      () => {
        const live = this.nodes.find((n) => n.id === node.id);
        if (live) live.name = name;
      },
      true,
    );
  }

  /** Folders never take their contents with them: children move up a level. */
  private deleteFolder(node: ExplorerNode): void {
    this.store.commit('delete folder', () => removeFolder(this.nodes, node.id), true);
  }

  // -- context menu ----------------------------------------------------

  private showMenu(node: ExplorerNode, event: MouseEvent): void {
    const nodes = this.nodes;
    const items: HTMLElement[] = [];
    const item = (text: string, action: () => void, cls = '') =>
      items.push(el('button', { text, class: cls, onclick: () => { close(); action(); } }));

    if (node.asset) {
      const { kind, name } = node.asset;
      item('Open', () => this.onOpen(kind, name));
      if (kind === 'room') item('Set as start room', () => this.ops.setStartRoom(name));
      item('Rename…', () => void this.ops.rename(kind, name));
      item('Delete', () => void this.ops.remove(kind, name), 'danger');
    } else {
      const service = serviceOf(nodes, node.id) ?? SERVICE_IDS.assets;
      for (const kind of kindsUnder(service)) {
        item(`New ${KIND_LABEL[kind]}`, () => {
          this.expanded.add(node.id);
          void this.ops.create(kind, PREFIX[kind], node.id);
        });
      }
      if (service === SERVICE_IDS.assets) {
        item('Import sprite…', () => {
          this.expanded.add(node.id);
          void this.ops.importSprites(undefined, node.id);
        });
      }
      item('New folder', () => void this.newFolder(node.id));
      if (node.kind === 'folder') {
        item('Rename folder…', () => void this.renameFolder(node));
        item('Delete folder (keeps contents)', () => this.deleteFolder(node), 'danger');
      }
    }

    const menu = el(
      'div',
      { class: 'context-menu', style: `left:${event.clientX}px; top:${event.clientY}px` },
      ...items,
    );
    const close = () => {
      menu.remove();
      document.removeEventListener('pointerdown', onAway, true);
    };
    const onAway = (e: PointerEvent) => {
      if (!menu.contains(e.target as Node)) close();
    };
    document.body.append(menu);
    setTimeout(() => document.addEventListener('pointerdown', onAway, true), 0);
  }
}

/** Folders first, then assets, each alphabetically. */
function byKindThenName(a: ExplorerNode, b: ExplorerNode): number {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
  return a.name.localeCompare(b.name);
}
