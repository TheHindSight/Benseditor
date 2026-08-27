import { newTileLayer } from '../project/create';
import type { ProjectStore } from '../project/store';
import { NAME_PATTERN, type RoomFile, type RoomInstance, type TileLayer } from '../project/types';
import { clear, el, modal, type Panel } from './dom';

/**
 * Visual room layout editor.
 *
 * Mirrors GameMaker's: pick an object on the left, click to place, drag to
 * move, right-click to remove. Depth ordering matches the runtime, so what you
 * see here is what the game draws.
 */
export class RoomEditor implements Panel {
  readonly element: HTMLElement;

  private zoom = 1;
  private panX = 20;
  private panY = 20;
  private snap = true;
  private showGrid = true;
  private placing: string | null = null;
  private selected: string | null = null;

  private drag: { instance: RoomInstance; offsetX: number; offsetY: number; moved: boolean } | null = null;
  private panning: { x: number; y: number } | null = null;
  private spaceDown = false;

  private mode: 'instances' | 'tiles' = 'instances';
  private layerId: string | null = null;
  private tileIndex = 0;
  private bucket = false;
  /** Which value the current tile drag is writing, so a sweep stays uniform. */
  private tileStroke: number | null = null;
  private tilesetImages = new Map<string, HTMLImageElement>();
  private sidePanels!: HTMLElement;
  private layerList!: HTMLElement;
  private palette!: HTMLElement;

  private view!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private objectList!: HTMLElement;
  private inspector!: HTMLElement;
  private posLabel!: HTMLElement;
  private zoomLabel!: HTMLElement;
  private countLabel!: HTMLElement;
  private fields: Record<string, HTMLInputElement> = {};

  private images = new Map<string, HTMLImageElement>();
  private resizeObserver?: ResizeObserver;
  private unsubscribe?: () => void;
  private fitted = false;

  constructor(
    private readonly store: ProjectStore,
    private readonly roomName: string,
  ) {
    this.element = this.build();
    this.unsubscribe = store.on('change', () => {
      this.loadImages();
      this.buildObjectList();
      this.syncInspector();
      this.render();
    });
    this.loadImages();
    this.buildObjectList();
    this.buildTilePanel();
    this.syncRoomFields();
  }

  private get room(): RoomFile {
    const found = this.store.room(this.roomName);
    if (!found) throw new Error(`Room ${this.roomName} no longer exists`);
    return found;
  }

  // -- construction ----------------------------------------------------

  private build(): HTMLElement {
    this.view = el('canvas', { class: 'room-view' });
    this.ctx = this.view.getContext('2d')!;
    this.objectList = el('div', { class: 'object-list' });
    this.inspector = el('div', { class: 'inspector' });
    this.posLabel = el('span', { class: 'mono', text: '0, 0' });
    this.zoomLabel = el('span', { class: 'mono', text: '100%' });
    this.countLabel = el('strong', { text: '0' });

    const numberField = (key: string, label: string, step?: string) => {
      const input = el('input', {
        type: 'number',
        step: step ?? '1',
        onchange: () => this.applyRoomFields(),
      }) as HTMLInputElement;
      this.fields[key] = input;
      return el('label', { class: 'field' }, el('span', { text: label }), input);
    };

    const colour = el('input', {
      type: 'color',
      onchange: () => {
        this.store.commit('set room background', () => {
          this.room.backgroundColor = colour.value;
        });
        this.render();
      },
      oninput: () => this.render(),
    }) as HTMLInputElement;
    this.fields.background = colour;

    const checkbox = (label: string, checked: boolean, onchange: (v: boolean) => void) =>
      el('label', {}, el('input', {
        type: 'checkbox',
        checked,
        onchange: (e: Event) => onchange((e.target as HTMLInputElement).checked),
      }), label);

    const status = el(
      'div',
      { class: 'room-status' },
      this.posLabel,
      this.zoomLabel,
      el('span', { class: 'grow' }),
      checkbox('Snap', this.snap, (v) => { this.snap = v; }),
      checkbox('Grid', this.showGrid, (v) => { this.showGrid = v; this.render(); }),
      el('span', { class: 'muted', text: 'click place · drag move · right-click delete' }),
    );

    this.attachEvents();

    this.layerList = el('div', { class: 'layer-list' });
    this.palette = el('div', { class: 'tile-palette' });

    const modeButton = (mode: 'instances' | 'tiles', label: string) =>
      el('button', {
        class: 'mode-button' + (this.mode === mode ? ' active' : ''),
        text: label,
        dataset: { mode },
        onclick: () => this.setMode(mode),
      });

    this.sidePanels = el(
      'div',
      { class: 'room-panels' },
      el('div', { class: 'mode-switch' }, modeButton('instances', 'Instances'), modeButton('tiles', 'Tiles')),
      el('div', { class: 'panel-instances' }, el('h3', { text: 'Objects' }), this.objectList),
      el(
        'div',
        { class: 'panel-tiles', hidden: true },
        el(
          'div',
          { class: 'layer-header' },
          el('h3', { text: 'Layers' }),
          el('button', { class: 'mini', text: '+', title: 'New tile layer', onclick: () => void this.addLayer() }),
        ),
        this.layerList,
        el(
          'div',
          { class: 'palette-header' },
          el('h3', { text: 'Tiles' }),
          el('button', {
            class: 'mini bucket-toggle',
            text: '🪣',
            title: 'Bucket fill (otherwise paint)',
            onclick: () => {
              this.bucket = !this.bucket;
              this.buildTilePanel();
            },
          }),
        ),
        this.palette,
      ),
    );

    return el(
      'div',
      { class: 'room-editor' },
      el('aside', { class: 'room-objects' }, this.sidePanels),
      el('div', { class: 'room-stage' }, el('div', { class: 'room-canvas-wrap' }, this.view), status),
      el(
        'aside',
        { class: 'room-sidebar' },
        el(
          'section',
          {},
          el('h3', { text: 'Room' }),
          el('div', { class: 'field-row' }, numberField('width', 'W'), numberField('height', 'H')),
          el('div', { class: 'field-row' }, numberField('gridWidth', 'Grid'), numberField('gridHeight', '×')),
          el('label', { class: 'field' }, el('span', { text: 'BG' }), colour),
        ),
        el('section', {}, el('h3', { text: 'Instance' }), this.inspector),
        el(
          'section',
          {},
          el('h3', { text: 'Instances' }),
          el('div', { class: 'kv' }, el('span', { text: 'Placed' }), this.countLabel),
          el('button', { text: 'Remove all', onclick: () => this.clearRoom() }),
        ),
      ),
    );
  }

  activate(): void {
    this.resizeObserver ??= new ResizeObserver(() => this.resizeView());
    this.resizeObserver.observe(this.element.querySelector('.room-canvas-wrap')!);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    this.resizeView();
  }

  deactivate(): void {
    this.resizeObserver?.disconnect();
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
  }

  dispose(): void {
    this.deactivate();
    this.unsubscribe?.();
  }

  // -- object palette --------------------------------------------------

  private loadImages(): void {
    for (const sprite of this.store.project.sprites) {
      const existing = this.images.get(sprite.name);
      const source = 'data:image/png;base64,' + (sprite.frames[0] ?? '');
      if (existing?.src === source) continue;
      const image = new Image();
      image.onload = () => {
        this.render();
        this.buildObjectList();
      };
      image.src = source;
      this.images.set(sprite.name, image);
    }

    for (const tileset of this.store.project.tilesets) {
      const existing = this.tilesetImages.get(tileset.name);
      const source = 'data:image/png;base64,' + tileset.image;
      if (existing?.src === source) continue;
      const image = new Image();
      image.onload = () => {
        this.render();
        this.buildTilePanel();
      };
      image.src = source;
      this.tilesetImages.set(tileset.name, image);
    }
  }

  // -- tile layers -------------------------------------------------------

  private setMode(mode: 'instances' | 'tiles'): void {
    this.mode = mode;
    for (const button of this.sidePanels.querySelectorAll<HTMLElement>('.mode-button')) {
      button.classList.toggle('active', button.dataset.mode === mode);
    }
    (this.sidePanels.querySelector('.panel-instances') as HTMLElement).hidden = mode !== 'instances';
    (this.sidePanels.querySelector('.panel-tiles') as HTMLElement).hidden = mode !== 'tiles';

    if (mode === 'tiles') {
      this.selected = null;
      this.syncInspector();
      this.buildTilePanel();
    } else {
      this.placing = null;
      this.buildObjectList();
    }
    this.render();
  }

  private get layers(): TileLayer[] {
    const room = this.store.room(this.roomName);
    if (!room) return [];
    room.layers ??= [];
    return room.layers;
  }

  private get activeLayer(): TileLayer | undefined {
    return this.layers.find((layer) => layer.id === this.layerId) ?? this.layers[0];
  }

  private async addLayer(): Promise<void> {
    const tilesets = this.store.names('tileset');
    if (tilesets.length === 0) {
      await modal(
        'No tilesets yet',
        el('div', { class: 'modal-body' },
          el('p', { text: 'Create a tileset first — use the + beside Tilesets in the sidebar.' })),
        'OK',
      );
      return;
    }

    const select = el('select', {},
      ...tilesets.map((name) => el('option', { value: name, text: name }))) as HTMLSelectElement;
    const nameInput = el('input', { type: 'text', value: `layer_${this.layers.length + 1}` }) as HTMLInputElement;
    const depthInput = el('input', { type: 'number', value: '20' }) as HTMLInputElement;

    const body = el('div', { class: 'modal-body' },
      el('label', { class: 'field' }, el('span', { text: 'Name' }), nameInput),
      el('label', { class: 'field' }, el('span', { text: 'Tileset' }), select),
      el('label', { class: 'field' }, el('span', { text: 'Depth' }), depthInput),
      el('p', { class: 'muted small', text: 'Higher depth draws further back, same as objects.' }));

    if (!(await modal('New tile layer', body, 'Create'))) return;

    const tileset = this.store.tileset(select.value);
    if (!tileset) return;

    const room = this.room;
    const columns = Math.ceil(room.width / tileset.tileWidth);
    const rows = Math.ceil(room.height / tileset.tileHeight);
    const layer = newTileLayer(
      nameInput.value.trim() || `layer_${this.layers.length + 1}`,
      select.value,
      columns,
      rows,
      Number(depthInput.value) | 0,
    );

    this.store.commit('add tile layer', () => {
      this.room.layers = [...this.layers, layer];
    });
    this.layerId = layer.id;
    this.buildTilePanel();
    this.render();
  }

  private buildTilePanel(): void {
    clear(this.layerList);
    const layers = this.layers;

    if (layers.length === 0) {
      this.layerList.append(el('p', { class: 'muted small', text: 'No layers yet.' }));
    }

    for (const layer of layers) {
      const isActive = this.activeLayer?.id === layer.id;
      this.layerList.append(
        el(
          'div',
          { class: 'layer-row' + (isActive ? ' selected' : '') },
          el('input', {
            type: 'checkbox',
            checked: layer.visible,
            title: 'Visible',
            onclick: (event: Event) => event.stopPropagation(),
            onchange: (event: Event) => {
              const checked = (event.target as HTMLInputElement).checked;
              this.store.commit('toggle layer', () => {
                const live = this.layers.find((l) => l.id === layer.id);
                if (live) live.visible = checked;
              });
              this.render();
            },
          }),
          el('button', {
            class: 'layer-name',
            text: layer.name,
            title: `${layer.tileset} · depth ${layer.depth}`,
            onclick: () => {
              this.layerId = layer.id;
              this.buildTilePanel();
            },
          }),
          el('button', {
            class: 'mini',
            text: '×',
            title: 'Delete layer',
            onclick: () => {
              this.store.commit('delete tile layer', () => {
                this.room.layers = this.layers.filter((l) => l.id !== layer.id);
              });
              if (this.layerId === layer.id) this.layerId = null;
              this.buildTilePanel();
              this.render();
            },
          }),
        ),
      );
    }

    (this.sidePanels.querySelector('.bucket-toggle') as HTMLElement)?.classList.toggle(
      'active',
      this.bucket,
    );

    clear(this.palette);
    const layer = this.activeLayer;
    const tileset = layer ? this.store.tileset(layer.tileset) : undefined;
    if (!tileset) {
      this.palette.append(el('p', { class: 'muted small', text: 'Select a layer to pick tiles.' }));
      return;
    }

    const image = this.tilesetImages.get(tileset.name);
    const scale = Math.max(1, Math.min(3, Math.floor(40 / Math.max(tileset.tileWidth, tileset.tileHeight))));

    // An explicit eraser reads better than "right-click also erases".
    this.palette.append(
      el('button', {
        class: 'tile-swatch eraser' + (this.tileIndex === -1 ? ' selected' : ''),
        title: 'Eraser',
        text: '⌫',
        onclick: () => {
          this.tileIndex = -1;
          this.buildTilePanel();
        },
      }),
    );

    for (let index = 0; index < tileset.columns * tileset.rows; index++) {
      const canvas = el('canvas', {
        width: tileset.tileWidth * scale,
        height: tileset.tileHeight * scale,
      }) as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      if (image?.complete && image.naturalWidth) {
        ctx.drawImage(
          image,
          (index % tileset.columns) * tileset.tileWidth,
          Math.floor(index / tileset.columns) * tileset.tileHeight,
          tileset.tileWidth,
          tileset.tileHeight,
          0,
          0,
          canvas.width,
          canvas.height,
        );
      }

      this.palette.append(
        el(
          'button',
          {
            class: 'tile-swatch' + (this.tileIndex === index ? ' selected' : ''),
            title: `Tile ${index}${tileset.solid[index] ? ' (solid)' : ''}`,
            onclick: () => {
              this.tileIndex = index;
              this.buildTilePanel();
            },
          },
          canvas,
          tileset.solid[index] ? el('span', { class: 'solid-dot' }) : null,
        ),
      );
    }
  }

  /** Write one tile, or flood fill from it when the bucket is on. */
  private paintTile(event: PointerEvent, value: number): void {
    const layer = this.activeLayer;
    if (!layer) return;
    const tileset = this.store.tileset(layer.tileset);
    if (!tileset) return;

    const point = this.screenToRoom(event);
    const x = Math.floor(point.x / tileset.tileWidth);
    const y = Math.floor(point.y / tileset.tileHeight);
    if (x < 0 || y < 0 || x >= layer.columns || y >= layer.rows) return;

    const at = y * layer.columns + x;
    if (layer.tiles[at] === value && !this.bucket) return;

    this.store.commit(this.bucket ? 'fill tiles' : 'paint tiles', () => {
      const live = this.layers.find((l) => l.id === layer.id);
      if (!live) return;
      if (this.bucket) {
        floodFillTiles(live, x, y, value);
      } else {
        live.tiles[at] = value;
      }
    });
    this.render();
  }

  private spriteFor(objectName: string) {
    const object = this.store.object(objectName);
    return object?.def.sprite ? this.store.sprite(object.def.sprite) : undefined;
  }

  private buildObjectList(): void {
    clear(this.objectList);
    const objects = this.store.project.objects;

    if (objects.length === 0) {
      this.objectList.append(el('p', { class: 'muted small', text: 'No objects yet.' }));
      return;
    }

    for (const { def } of objects) {
      const thumb = el('canvas', { width: 22, height: 22 }) as HTMLCanvasElement;
      const tctx = thumb.getContext('2d')!;
      tctx.imageSmoothingEnabled = false;
      const sprite = def.sprite ? this.store.sprite(def.sprite) : undefined;
      const image = def.sprite ? this.images.get(def.sprite) : undefined;
      if (sprite && image?.complete && image.naturalWidth) {
        const scale = Math.min(22 / sprite.width, 22 / sprite.height);
        const w = sprite.width * scale;
        const h = sprite.height * scale;
        tctx.drawImage(image, (22 - w) / 2, (22 - h) / 2, w, h);
      } else {
        tctx.fillStyle = 'rgba(255,119,168,0.4)';
        tctx.fillRect(4, 4, 14, 14);
      }

      this.objectList.append(
        el(
          'button',
          {
            class: 'object-entry' + (this.placing === def.name ? ' selected' : ''),
            title: def.sprite ? `${def.name} (${def.sprite})` : def.name,
            onclick: () => {
              this.placing = this.placing === def.name ? null : def.name;
              this.buildObjectList();
            },
          },
          thumb,
          el('span', { text: def.name }),
        ),
      );
    }
  }

  // -- geometry --------------------------------------------------------

  private screenToRoom(event: PointerEvent): { x: number; y: number } {
    const rect = this.view.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left - this.panX) / this.zoom,
      y: (event.clientY - rect.top - this.panY) / this.zoom,
    };
  }

  private snapPoint(x: number, y: number): { x: number; y: number } {
    if (!this.snap) return { x: Math.round(x), y: Math.round(y) };
    const gw = Math.max(1, this.room.gridWidth || 16);
    const gh = Math.max(1, this.room.gridHeight || 16);
    return { x: Math.round(x / gw) * gw, y: Math.round(y / gh) * gh };
  }

  private bounds(instance: RoomInstance) {
    const sprite = this.spriteFor(instance.object);
    if (!sprite) {
      return { left: instance.x - 8, top: instance.y - 8, right: instance.x + 8, bottom: instance.y + 8 };
    }
    const left = instance.x - sprite.originX * instance.xscale;
    const top = instance.y - sprite.originY * instance.yscale;
    return {
      left,
      top,
      right: left + sprite.width * instance.xscale,
      bottom: top + sprite.height * instance.yscale,
    };
  }

  private depthOf(instance: RoomInstance): number {
    return this.store.object(instance.object)?.def.depth ?? 0;
  }

  private instanceAt(x: number, y: number): RoomInstance | undefined {
    const list = this.room.instances;
    // Topmost first: lowest depth wins, then most recently placed.
    return [...list]
      .sort((a, b) => this.depthOf(a) - this.depthOf(b) || list.indexOf(b) - list.indexOf(a))
      .find((instance) => {
        const b = this.bounds(instance);
        return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
      });
  }

  // -- rendering -------------------------------------------------------

  private resizeView(): void {
    const rect = this.view.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.view.width = Math.max(1, Math.round(rect.width * dpr));
    this.view.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!this.fitted && rect.width > 2) {
      this.fitView();
      this.fitted = true;
    }
    this.render();
  }

  private fitView(): void {
    const rect = this.view.getBoundingClientRect();
    const room = this.room;
    this.zoom = Math.max(0.1, Math.min(8,
      Math.min((rect.width - 40) / room.width, (rect.height - 40) / room.height)));
    this.panX = Math.round((rect.width - room.width * this.zoom) / 2);
    this.panY = Math.round((rect.height - room.height * this.zoom) / 2);
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  private render(): void {
    const room = this.store.room(this.roomName);
    if (!room) return;

    const rect = this.view.getBoundingClientRect();
    const ctx = this.ctx;
    const z = this.zoom;

    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.imageSmoothingEnabled = false;

    ctx.fillStyle = this.fields.background.value || room.backgroundColor;
    ctx.fillRect(this.panX, this.panY, room.width * z, room.height * z);

    if (this.showGrid) {
      const gw = Math.max(1, room.gridWidth || 16) * z;
      const gh = Math.max(1, room.gridHeight || 16) * z;
      if (gw >= 4 && gh >= 4) {
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let x = 0; x <= room.width * z; x += gw) {
          ctx.moveTo(this.panX + x + 0.5, this.panY);
          ctx.lineTo(this.panX + x + 0.5, this.panY + room.height * z);
        }
        for (let y = 0; y <= room.height * z; y += gh) {
          ctx.moveTo(this.panX, this.panY + y + 0.5);
          ctx.lineTo(this.panX + room.width * z, this.panY + y + 0.5);
        }
        ctx.stroke();
      }
    }

    // Painter's order: larger depth is further back. Tile layers and instances
    // share one ordering, so the preview matches what the engine draws.
    const items: { depth: number; instance?: RoomInstance; layer?: TileLayer }[] = [
      ...room.instances.map((instance) => ({ depth: this.depthOf(instance), instance })),
      ...(room.layers ?? []).map((layer) => ({ depth: layer.depth, layer })),
    ].sort((a, b) => b.depth - a.depth);

    for (const item of items) {
      if (item.layer) this.drawLayer(item.layer);
      else if (item.instance) this.drawInstance(item.instance);
    }

    if (this.selected) {
      const instance = room.instances.find((i) => i.id === this.selected);
      if (instance) {
        const b = this.bounds(instance);
        ctx.strokeStyle = '#29adff';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeRect(
          this.panX + b.left * z - 0.5,
          this.panY + b.top * z - 0.5,
          (b.right - b.left) * z + 1,
          (b.bottom - b.top) * z + 1,
        );
        ctx.setLineDash([]);
      }
    }

    ctx.strokeStyle = 'rgba(200,200,200,0.9)';
    ctx.lineWidth = 1;
    ctx.strokeRect(this.panX - 0.5, this.panY - 0.5, room.width * z + 1, room.height * z + 1);
  }

  private drawLayer(layer: TileLayer): void {
    if (!layer.visible) return;
    const tileset = this.store.tileset(layer.tileset);
    const image = tileset ? this.tilesetImages.get(tileset.name) : undefined;
    if (!tileset || !image?.complete || !image.naturalWidth) return;

    const z = this.zoom;
    const ctx = this.ctx;
    const tw = tileset.tileWidth;
    const th = tileset.tileHeight;

    for (let row = 0; row < layer.rows; row++) {
      for (let column = 0; column < layer.columns; column++) {
        const index = layer.tiles[row * layer.columns + column];
        if (index < 0) continue;
        ctx.drawImage(
          image,
          (index % tileset.columns) * tw,
          Math.floor(index / tileset.columns) * th,
          tw,
          th,
          this.panX + column * tw * z,
          this.panY + row * th * z,
          tw * z,
          th * z,
        );
      }
    }

    // Outline the layer being painted so it is obvious what a click affects.
    if (this.mode === 'tiles' && this.activeLayer?.id === layer.id) {
      ctx.strokeStyle = 'rgba(41,173,255,0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(
        this.panX - 0.5,
        this.panY - 0.5,
        layer.columns * tw * z + 1,
        layer.rows * th * z + 1,
      );
    }
  }

  private drawInstance(instance: RoomInstance): void {
    const ctx = this.ctx;
    const z = this.zoom;
    const sprite = this.spriteFor(instance.object);
    const spriteName = this.store.object(instance.object)?.def.sprite ?? undefined;
    const image = spriteName ? this.images.get(spriteName) : undefined;

    ctx.save();
    ctx.translate(this.panX + instance.x * z, this.panY + instance.y * z);
    ctx.rotate((-(instance.angle || 0) * Math.PI) / 180);
    ctx.scale(instance.xscale * z, instance.yscale * z);

    if (sprite && image?.complete && image.naturalWidth) {
      ctx.drawImage(image, -sprite.originX, -sprite.originY);
    } else {
      // Objects with no sprite still need a visible, clickable footprint.
      ctx.fillStyle = 'rgba(255,119,168,0.35)';
      ctx.fillRect(-8, -8, 16, 16);
      ctx.strokeStyle = '#ff77a8';
      ctx.lineWidth = 1 / (instance.xscale * z || 1);
      ctx.strokeRect(-8, -8, 16, 16);
    }
    ctx.restore();
  }

  // -- inspector -------------------------------------------------------

  private syncRoomFields(): void {
    const room = this.room;
    this.fields.width.value = String(room.width);
    this.fields.height.value = String(room.height);
    this.fields.gridWidth.value = String(room.gridWidth);
    this.fields.gridHeight.value = String(room.gridHeight);
    this.fields.background.value = room.backgroundColor;
    this.countLabel.textContent = String(room.instances.length);
    this.syncInspector();
  }

  private applyRoomFields(): void {
    this.store.commit('edit room', () => {
      const room = this.room;
      room.width = Math.max(1, Number(this.fields.width.value) | 0);
      room.height = Math.max(1, Number(this.fields.height.value) | 0);
      room.gridWidth = Math.max(1, Number(this.fields.gridWidth.value) | 0);
      room.gridHeight = Math.max(1, Number(this.fields.gridHeight.value) | 0);
    });
    this.syncRoomFields();
    this.render();
  }

  private syncInspector(): void {
    clear(this.inspector);
    const room = this.store.room(this.roomName);
    const instance = room?.instances.find((i) => i.id === this.selected);
    this.countLabel.textContent = String(room?.instances.length ?? 0);

    if (!instance) {
      this.inspector.append(el('p', { class: 'muted small', text: 'Nothing selected.' }));
      return;
    }

    const field = (key: keyof RoomInstance, label: string, step = '1') => {
      const input = el('input', {
        type: 'number',
        step,
        value: String(instance[key]),
        onchange: (event: Event) => {
          const value = Number((event.target as HTMLInputElement).value);
          if (!Number.isFinite(value)) return;
          this.store.commit('edit instance', () => {
            const live = this.room.instances.find((i) => i.id === instance.id);
            if (live) (live[key] as number) = value;
          });
          this.render();
        },
      });
      return el('label', { class: 'field' }, el('span', { text: label }), input);
    };

    // The runtime name: what `workspace:FindFirstChild` and `.Name` see.
    const nameInput = el('input', {
      type: 'text',
      class: 'instance-name',
      placeholder: instance.object,
      value: instance.name ?? '',
      onchange: (event: Event) => {
        const input = event.target as HTMLInputElement;
        const value = input.value.trim();
        if (value && !NAME_PATTERN.test(value)) {
          input.value = instance.name ?? '';
          return;
        }
        this.store.commit('name instance', () => {
          const live = this.room.instances.find((i) => i.id === instance.id);
          if (!live) return;
          if (value) live.name = value;
          else delete live.name;
        });
      },
    }) as HTMLInputElement;

    this.inspector.append(
      el('div', { class: 'kv' }, el('span', { text: 'Object' }), el('strong', { text: instance.object })),
      el('label', { class: 'field' }, el('span', { text: 'Name' }), nameInput),
      el('div', { class: 'field-row' }, field('x', 'X'), field('y', 'Y')),
      el('div', { class: 'field-row' }, field('xscale', 'SX', '0.1'), field('yscale', 'SY', '0.1')),
      el('div', { class: 'field-row' }, field('angle', 'Angle')),
      el('button', { text: 'Delete', onclick: () => this.deleteSelected() }),
    );
  }

  // -- editing ---------------------------------------------------------

  private nextInstanceId(): string {
    let max = 0;
    for (const instance of this.room.instances) {
      const match = /^inst_(\d+)$/.exec(instance.id ?? '');
      if (match) max = Math.max(max, Number(match[1]));
    }
    return `inst_${max + 1}`;
  }

  private deleteSelected(): void {
    if (!this.selected) return;
    const id = this.selected;
    this.store.commit('delete instance', () => {
      const room = this.room;
      room.instances = room.instances.filter((i) => i.id !== id);
    });
    this.selected = null;
    this.syncInspector();
    this.render();
  }

  private clearRoom(): void {
    if (this.room.instances.length === 0) return;
    this.store.commit('remove all instances', () => {
      this.room.instances = [];
    });
    this.selected = null;
    this.syncInspector();
    this.render();
  }

  private attachEvents(): void {
    this.view.addEventListener('pointerdown', (event) => {
      this.view.setPointerCapture(event.pointerId);

      if (event.button === 1 || this.spaceDown) {
        this.panning = { x: event.clientX - this.panX, y: event.clientY - this.panY };
        event.preventDefault();
        return;
      }

      if (this.mode === 'tiles') {
        // Right-click always erases, whatever tile is selected.
        this.tileStroke = event.button === 2 ? -1 : this.tileIndex;
        this.paintTile(event, this.tileStroke);
        return;
      }

      const point = this.screenToRoom(event);
      const hit = this.instanceAt(point.x, point.y);

      if (event.button === 2) {
        if (hit) {
          this.store.commit('delete instance', () => {
            const room = this.room;
            room.instances = room.instances.filter((i) => i.id !== hit.id);
          });
          if (this.selected === hit.id) this.selected = null;
          this.syncInspector();
          this.render();
        }
        return;
      }

      if (hit) {
        this.selected = hit.id;
        this.drag = { instance: hit, offsetX: point.x - hit.x, offsetY: point.y - hit.y, moved: false };
        this.syncInspector();
        this.render();
        return;
      }

      if (this.placing) {
        const { x, y } = this.snapPoint(point.x, point.y);
        const created: RoomInstance = {
          id: this.nextInstanceId(),
          object: this.placing,
          x, y, xscale: 1, yscale: 1, angle: 0,
        };
        this.store.commit('place instance', () => this.room.instances.push(created));
        this.selected = created.id;
        const live = this.room.instances.find((i) => i.id === created.id)!;
        this.drag = { instance: live, offsetX: 0, offsetY: 0, moved: false };
        this.syncInspector();
        this.render();
        return;
      }

      this.selected = null;
      this.syncInspector();
      this.render();
    });

    this.view.addEventListener('pointermove', (event) => {
      if (this.panning) {
        this.panX = event.clientX - this.panning.x;
        this.panY = event.clientY - this.panning.y;
        this.render();
        return;
      }

      const point = this.screenToRoom(event);
      this.posLabel.textContent = `${Math.round(point.x)}, ${Math.round(point.y)}`;

      if (this.tileStroke !== null) {
        // Bucket fill is a single action, not something to repeat on drag.
        if (!this.bucket) this.paintTile(event, this.tileStroke);
        return;
      }

      if (this.drag) {
        const { x, y } = this.snapPoint(point.x - this.drag.offsetX, point.y - this.drag.offsetY);
        if (x !== this.drag.instance.x || y !== this.drag.instance.y) {
          this.drag.instance.x = x;
          this.drag.instance.y = y;
          this.drag.moved = true;
          this.syncInspector();
          this.render();
        }
      }
    });

    const release = () => {
      this.panning = null;
      this.tileStroke = null;
      if (this.drag?.moved) {
        const { id, x, y } = this.drag.instance;
        this.store.commit('move instance', () => {
          const live = this.room.instances.find((i) => i.id === id);
          if (live) {
            live.x = x;
            live.y = y;
          }
        });
      }
      this.drag = null;
    };
    this.view.addEventListener('pointerup', release);
    this.view.addEventListener('pointercancel', release);
    this.view.addEventListener('contextmenu', (event) => event.preventDefault());

    this.view.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        const rect = this.view.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const next = Math.max(0.1, Math.min(16, this.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
        this.panX = px - ((px - this.panX) / this.zoom) * next;
        this.panY = py - ((py - this.panY) / this.zoom) * next;
        this.zoom = next;
        this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
        this.render();
      },
      { passive: false },
    );
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && /INPUT|SELECT|TEXTAREA/.test(target.tagName)) return;
    if (event.ctrlKey || event.metaKey) return;

    if (event.key === ' ') {
      this.spaceDown = true;
      this.view.style.cursor = 'grab';
      event.preventDefault();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      this.deleteSelected();
    } else if (event.key === 'Escape') {
      this.placing = null;
      this.selected = null;
      this.buildObjectList();
      this.syncInspector();
      this.render();
    } else if (event.key === '0') {
      this.fitView();
      this.render();
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === ' ') {
      this.spaceDown = false;
      this.view.style.cursor = 'default';
    }
  };
}

/** Four-way flood fill over a tile layer, used by the bucket tool. */
function floodFillTiles(layer: TileLayer, x: number, y: number, value: number): void {
  const target = layer.tiles[y * layer.columns + x];
  if (target === value) return;

  const stack: [number, number][] = [[x, y]];
  const seen = new Uint8Array(layer.columns * layer.rows);

  while (stack.length) {
    const [tx, ty] = stack.pop()!;
    if (tx < 0 || ty < 0 || tx >= layer.columns || ty >= layer.rows) continue;
    const at = ty * layer.columns + tx;
    if (seen[at] || layer.tiles[at] !== target) continue;
    seen[at] = 1;
    layer.tiles[at] = value;
    stack.push([tx + 1, ty], [tx - 1, ty], [tx, ty + 1], [tx, ty - 1]);
  }
}
