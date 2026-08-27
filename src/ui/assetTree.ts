import type { AssetKind, ProjectStore } from '../project/store';
import type { AssetOps } from './assetOps';
import { clear, el } from './dom';

/** The asset sidebar: one collapsible group per kind, with create/rename/delete. */

const GROUPS: { kind: AssetKind; label: string; prefix: string }[] = [
  { kind: 'sprite', label: 'Sprites', prefix: 'spr_' },
  { kind: 'tileset', label: 'Tilesets', prefix: 'ts_' },
  { kind: 'object', label: 'Objects', prefix: 'obj_' },
  { kind: 'room', label: 'Rooms', prefix: 'rm_' },
  { kind: 'script', label: 'Scripts', prefix: '' },
];

const ICONS: Record<AssetKind, string> = {
  sprite: '🎨',
  tileset: '▩',
  object: '⬢',
  room: '▦',
  script: '{}',
};

export class AssetTree {
  readonly element: HTMLElement;

  constructor(
    private readonly store: ProjectStore,
    private readonly ops: AssetOps,
    private readonly onOpen: (kind: AssetKind, name: string) => void,
  ) {
    this.element = el('div', { class: 'asset-tree' });
    this.refresh();
    store.on('structure', () => this.refresh());
  }

  refresh(): void {
    clear(this.element);

    for (const group of GROUPS) {
      const list = el('div', { class: 'asset-list' });
      for (const name of this.store.names(group.kind)) {
        const isStartRoom =
          group.kind === 'room' && this.store.project.config.startRoom === name;

        list.append(
          el(
            'div',
            {
              class: 'asset-item',
              onclick: () => this.onOpen(group.kind, name),
              oncontextmenu: (event: MouseEvent) => {
                event.preventDefault();
                void this.showMenu(group.kind, name, event);
              },
            },
            el('span', { class: 'asset-icon', text: ICONS[group.kind] }),
            el('span', { class: 'asset-name', text: name }),
            isStartRoom ? el('span', { class: 'badge', text: 'start' }) : null,
          ),
        );
      }

      if (this.store.names(group.kind).length === 0) {
        list.append(el('p', { class: 'muted small empty', text: 'None yet' }));
      }

      const section = el(
        'section',
        { class: 'asset-group' },
        el(
          'header',
          {},
          el('h3', { text: group.label }),
          group.kind === 'sprite'
            ? el('button', {
                class: 'mini',
                text: '⭳',
                title: 'Import a sprite or sprite sheet from an image',
                onclick: (event: MouseEvent) => {
                  event.stopPropagation();
                  void this.ops.importSprites();
                },
              })
            : null,
          el('button', {
            class: 'mini',
            text: '+',
            title: `New ${group.kind}`,
            onclick: (event: MouseEvent) => {
              event.stopPropagation();
              void this.ops.create(group.kind, group.prefix);
            },
          }),
        ),
        list,
      );

      // Dropping image files on the Sprites group imports them.
      if (group.kind === 'sprite') {
        section.addEventListener('dragover', (event) => {
          event.preventDefault();
          section.classList.add('drop-target');
        });
        section.addEventListener('dragleave', () => section.classList.remove('drop-target'));
        section.addEventListener('drop', (event) => {
          event.preventDefault();
          section.classList.remove('drop-target');
          const files = [...(event.dataTransfer?.files ?? [])].filter((file) =>
            file.type.startsWith('image/'),
          );
          if (files.length) void this.ops.importSprites(files);
        });
      }

      this.element.append(section);
    }
  }

  private async showMenu(kind: AssetKind, name: string, event: MouseEvent): Promise<void> {
    const menu = el(
      'div',
      { class: 'context-menu', style: `left:${event.clientX}px; top:${event.clientY}px` },
      el('button', { text: 'Open', onclick: () => { close(); this.onOpen(kind, name); } }),
      kind === 'room'
        ? el('button', {
            text: 'Set as start room',
            onclick: () => {
              close();
              this.ops.setStartRoom(name);
            },
          })
        : null,
      el('button', { text: 'Rename…', onclick: () => { close(); void this.ops.rename(kind, name); } }),
      el('button', { class: 'danger', text: 'Delete', onclick: () => { close(); void this.ops.remove(kind, name); } }),
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
