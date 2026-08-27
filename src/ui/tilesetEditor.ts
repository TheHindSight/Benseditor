import { detectGridFromImage } from '../project/detectGrid';
import type { ProjectStore } from '../project/store';
import { tilePixel, tilesetGrid, type TilesetFile } from '../project/types';
import { el, type Panel } from './dom';

/**
 * Tileset editor.
 *
 * Shows the sheet with a tile grid over it. Clicking a tile toggles whether it
 * is solid, which is what `place_meeting(x, y, "tiles")` tests against — so the
 * collision map is authored right on top of the artwork.
 */
export class TilesetEditor implements Panel {
  readonly element: HTMLElement;

  private view!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private sheet?: HTMLImageElement;
  private zoom = 3;
  private showSolid = true;
  private painting: boolean | null = null;

  private fields: Record<string, HTMLInputElement> = {};
  private summary!: HTMLElement;
  private readout!: HTMLElement;
  private hovered = -1;
  private unsubscribe?: () => void;
  private resizeObserver?: ResizeObserver;

  constructor(
    private readonly store: ProjectStore,
    private readonly tilesetName: string,
  ) {
    this.element = this.build();
    this.unsubscribe = store.on('change', () => {
      this.syncFields();
      void this.loadSheet();
    });
    void this.loadSheet();
  }

  private get tileset(): TilesetFile {
    const found = this.store.tileset(this.tilesetName);
    if (!found) throw new Error(`Tileset ${this.tilesetName} no longer exists`);
    return found;
  }

  private build(): HTMLElement {
    this.view = el('canvas', { class: 'tileset-view' });
    this.ctx = this.view.getContext('2d')!;
    this.summary = el('div', { class: 'kv' });
    this.readout = el('div', { class: 'tile-readout mono' });

    const number = (key: string, label: string, onchange: () => void, min = 1) => {
      const input = el('input', {
        type: 'number',
        min: String(min),
        max: '512',
        onchange,
      }) as HTMLInputElement;
      this.fields[key] = input;
      return el('label', { class: 'field' }, el('span', { text: label }), input);
    };

    this.attachEvents();

    const sidebar = el(
      'aside',
      { class: 'tileset-sidebar' },
      el(
        'section',
        {},
        el('h3', { text: 'Tileset' }),
        el('div', { class: 'kv' }, el('span', { text: 'Name' }), el('strong', { text: this.tilesetName })),
        this.summary,
        el(
          'div',
          { class: 'field-row' },
          number('tileWidth', 'W', () => this.applyTileSize()),
          number('tileHeight', 'H', () => this.applyTileSize()),
        ),
        el('button', { text: 'Import image…', onclick: () => this.importImage() }),
      ),
      el(
        'section',
        {},
        el('h3', { text: 'Slicing' }),
        el('p', {
          class: 'muted small',
          text: 'Margin is the blank border before the first tile; spacing is the gap between tiles.',
        }),
        el(
          'div',
          { class: 'field-row' },
          number('offsetX', 'Left', () => this.applyTileSize(), 0),
          number('offsetY', 'Top', () => this.applyTileSize(), 0),
        ),
        el(
          'div',
          { class: 'field-row' },
          number('spacingX', 'Gap X', () => this.applyTileSize(), 0),
          number('spacingY', 'Gap Y', () => this.applyTileSize(), 0),
        ),
        el('button', {
          text: 'Detect grid',
          title: 'Measure tile size, margin and spacing from the blank pixels between tiles',
          onclick: () => this.detectSlicing(),
        }),
        this.readout,
      ),
      el(
        'section',
        {},
        el('h3', { text: 'Collision' }),
        el('p', { class: 'muted small', text: 'Click tiles to mark them solid. Drag to paint.' }),
        el('label', {}, el('input', {
          type: 'checkbox',
          checked: this.showSolid,
          onchange: (event: Event) => {
            this.showSolid = (event.target as HTMLInputElement).checked;
            this.render();
          },
        }), ' Show solid overlay'),
        el(
          'div',
          { class: 'button-row' },
          el('button', { text: 'All solid', onclick: () => this.setAllSolid(true) }),
          el('button', { text: 'None', onclick: () => this.setAllSolid(false) }),
        ),
      ),
      el(
        'section',
        {},
        el('h3', { text: 'Zoom' }),
        el(
          'div',
          { class: 'button-row' },
          ...[1, 2, 3, 4, 6].map((factor) =>
            el('button', {
              text: `${factor}x`,
              onclick: () => {
                this.zoom = factor;
                this.render();
              },
            }),
          ),
        ),
      ),
    );

    this.syncFields();

    return el(
      'div',
      { class: 'tileset-editor' },
      el('div', { class: 'tileset-stage' }, this.view),
      sidebar,
    );
  }

  activate(): void {
    this.resizeObserver ??= new ResizeObserver(() => this.render());
    this.resizeObserver.observe(this.element.querySelector('.tileset-stage')!);
    this.render();
  }

  deactivate(): void {
    this.resizeObserver?.disconnect();
  }

  dispose(): void {
    this.deactivate();
    this.unsubscribe?.();
  }

  // -- data ------------------------------------------------------------

  private syncFields(): void {
    const tileset = this.store.tileset(this.tilesetName);
    if (!tileset) return;
    this.fields.tileWidth.value = String(tileset.tileWidth);
    this.fields.tileHeight.value = String(tileset.tileHeight);
    this.fields.offsetX.value = String(tileset.offsetX ?? 0);
    this.fields.offsetY.value = String(tileset.offsetY ?? 0);
    this.fields.spacingX.value = String(tileset.spacingX ?? 0);
    this.fields.spacingY.value = String(tileset.spacingY ?? 0);

    this.summary.replaceChildren(
      el('span', { text: 'Tiles' }),
      el('strong', { text: `${tileset.columns} × ${tileset.rows} = ${tileset.columns * tileset.rows}` }),
    );
    this.updateReadout();
  }

  /** Spell out exactly which pixels a tile comes from. */
  private updateReadout(): void {
    const tileset = this.store.tileset(this.tilesetName);
    if (!tileset) return;

    const index = this.hovered;
    if (index < 0 || index >= tileset.columns * tileset.rows) {
      this.readout.replaceChildren(
        el('span', { class: 'muted', text: 'Hover a tile to see its pixels' }),
      );
      return;
    }

    const column = index % tileset.columns;
    const row = Math.floor(index / tileset.columns);
    const { x, y } = tilePixel(tileset, column, row);
    const sheetWidth = this.sheet?.naturalWidth ?? 0;
    const sheetHeight = this.sheet?.naturalHeight ?? 0;
    const overflows = x + tileset.tileWidth > sheetWidth || y + tileset.tileHeight > sheetHeight;

    const rows: HTMLElement[] = [
      el('div', { text: `tile ${index}  ·  col ${column}, row ${row}` }),
      el('div', {
        text: `x ${x}–${x + tileset.tileWidth - 1}   y ${y}–${y + tileset.tileHeight - 1}`,
      }),
    ];
    if (overflows) {
      rows.push(el('div', { class: 'readout-warn', text: 'falls outside the image' }));
    }
    this.readout.replaceChildren(...rows);
  }

  private loadSheet(): Promise<void> {
    return new Promise((resolve) => {
      const tileset = this.store.tileset(this.tilesetName);
      if (!tileset?.image) return resolve();
      const image = new Image();
      image.onload = () => {
        this.sheet = image;
        this.render();
        resolve();
      };
      image.onerror = () => resolve();
      image.src = 'data:image/png;base64,' + tileset.image;
    });
  }

  /**
   * Measure the slicing from the sheet itself.
   *
   * The blank pixels between tiles give the size, margin and gap exactly; a
   * sheet packed flush has nothing to measure, and says so rather than
   * pretending.
   */
  private detectSlicing(): void {
    const sheet = this.sheet;
    if (!sheet?.naturalWidth) return;

    const grid = detectGridFromImage(sheet, sheet.naturalWidth, sheet.naturalHeight);
    if (!grid.measured) {
      this.readout.textContent =
        'Nothing to measure: the tiles are packed flush, so set the size by hand.';
      this.readout.classList.add('readout-warn');
      return;
    }

    this.store.commit('detect tileset grid', () => {
      const tileset = this.tileset;
      tileset.tileWidth = grid.x.size;
      tileset.tileHeight = grid.y.size;
      tileset.offsetX = grid.x.offset;
      tileset.offsetY = grid.y.offset;
      tileset.spacingX = grid.x.spacing;
      tileset.spacingY = grid.y.spacing;
      this.regrid(tileset, sheet.naturalWidth, sheet.naturalHeight);
    });
    this.syncFields();
    this.render();
  }

  /** Re-derive the grid whenever tile size, margin, spacing or the image changes. */
  private regrid(tileset: TilesetFile, width: number, height: number): void {
    const grid = tilesetGrid(tileset, width, height);
    const columns = Math.max(1, grid.columns);
    const rows = Math.max(1, grid.rows);
    const solid = new Array(columns * rows).fill(false);

    // Keep existing flags for tiles that still exist at the same coordinate.
    for (let row = 0; row < Math.min(rows, tileset.rows); row++) {
      for (let column = 0; column < Math.min(columns, tileset.columns); column++) {
        solid[row * columns + column] = tileset.solid[row * tileset.columns + column] ?? false;
      }
    }

    tileset.columns = columns;
    tileset.rows = rows;
    tileset.solid = solid;
  }

  private applyTileSize(): void {
    const sheet = this.sheet;
    if (!sheet) return;

    const read = (key: string, min: number) =>
      Math.max(min, Number(this.fields[key].value) | 0);

    this.store.commit('set tile slicing', () => {
      const tileset = this.tileset;
      tileset.tileWidth = read('tileWidth', 1);
      tileset.tileHeight = read('tileHeight', 1);
      tileset.offsetX = read('offsetX', 0);
      tileset.offsetY = read('offsetY', 0);
      tileset.spacingX = read('spacingX', 0);
      tileset.spacingY = read('spacingY', 0);
      this.regrid(tileset, sheet.naturalWidth, sheet.naturalHeight);
    });
    this.syncFields();
    this.render();
  }

  private importImage(): void {
    const input = el('input', { type: 'file', accept: 'image/png,image/*' }) as HTMLInputElement;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;

      const dataUrl = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.readAsDataURL(file);
      });

      // Re-encode through a canvas so the stored sheet is always PNG.
      const image = new Image();
      await new Promise((resolve) => {
        image.onload = resolve;
        image.onerror = resolve;
        image.src = dataUrl;
      });
      if (!image.naturalWidth) return;

      const canvas = el('canvas', {
        width: image.naturalWidth,
        height: image.naturalHeight,
      }) as HTMLCanvasElement;
      canvas.getContext('2d')!.drawImage(image, 0, 0);

      // Measure the grid off the new sheet, so a sheet with visible margins
      // and gaps arrives already sliced correctly.
      const grid = detectGridFromImage(image, image.naturalWidth, image.naturalHeight);

      this.store.commit('import tileset image', () => {
        const tileset = this.tileset;
        tileset.image = canvas.toDataURL('image/png').split(',')[1];
        if (grid.measured) {
          tileset.tileWidth = grid.x.size;
          tileset.tileHeight = grid.y.size;
          tileset.offsetX = grid.x.offset;
          tileset.offsetY = grid.y.offset;
          tileset.spacingX = grid.x.spacing;
          tileset.spacingY = grid.y.spacing;
        }
        this.regrid(tileset, image.naturalWidth, image.naturalHeight);
      });

      await this.loadSheet();
      this.syncFields();
      if (grid.measured) {
        this.readout.textContent =
          `Grid detected: ${grid.x.size}×${grid.y.size} tiles` +
          (grid.x.spacing || grid.y.spacing ? `, ${grid.x.spacing}px gaps` : '') +
          (grid.x.offset || grid.y.offset ? `, ${grid.x.offset},${grid.y.offset} margin` : '');
        this.readout.classList.remove('readout-warn');
      }
    };
    input.click();
  }

  private setAllSolid(value: boolean): void {
    this.store.commit(value ? 'mark all solid' : 'clear solid', () => {
      const tileset = this.tileset;
      tileset.solid = new Array(tileset.columns * tileset.rows).fill(value);
    });
    this.render();
  }

  // -- painting ---------------------------------------------------------

  /** Which tile the pointer is over, accounting for margin and spacing. */
  private tileAt(event: PointerEvent): number {
    const tileset = this.tileset;
    const rect = this.view.getBoundingClientRect();
    const px = (event.clientX - rect.left) / this.zoom;
    const py = (event.clientY - rect.top) / this.zoom;

    const stepX = tileset.tileWidth + (tileset.spacingX ?? 0);
    const stepY = tileset.tileHeight + (tileset.spacingY ?? 0);
    const column = Math.floor((px - (tileset.offsetX ?? 0)) / stepX);
    const row = Math.floor((py - (tileset.offsetY ?? 0)) / stepY);
    if (column < 0 || row < 0 || column >= tileset.columns || row >= tileset.rows) return -1;

    // Reject the gap between tiles, so a click there does nothing.
    const origin = tilePixel(tileset, column, row);
    if (px - origin.x >= tileset.tileWidth || py - origin.y >= tileset.tileHeight) return -1;

    return row * tileset.columns + column;
  }

  private attachEvents(): void {
    this.view.addEventListener('pointerdown', (event) => {
      const index = this.tileAt(event);
      if (index < 0) return;
      this.view.setPointerCapture(event.pointerId);
      // Drag paints whatever the first tile became, so a sweep is uniform.
      this.painting = !this.tileset.solid[index];
      this.paint(index);
    });

    this.view.addEventListener('pointermove', (event) => {
      const index = this.tileAt(event);
      if (index !== this.hovered) {
        this.hovered = index;
        this.updateReadout();
        this.render();
      }
      if (this.painting !== null && index >= 0) this.paint(index);
    });

    this.view.addEventListener('pointerleave', () => {
      this.hovered = -1;
      this.updateReadout();
      this.render();
    });

    const stop = () => {
      this.painting = null;
    };
    this.view.addEventListener('pointerup', stop);
    this.view.addEventListener('pointercancel', stop);
  }

  private paint(index: number): void {
    if (this.painting === null || this.tileset.solid[index] === this.painting) return;
    const value = this.painting;
    this.store.commit('set tile solidity', () => {
      this.tileset.solid[index] = value;
    });
    this.render();
  }

  // -- rendering ---------------------------------------------------------

  private render(): void {
    const tileset = this.store.tileset(this.tilesetName);
    if (!tileset || !this.sheet) return;

    // The whole sheet is shown, margin and gaps included, so it is obvious
    // when the slicing does not line up with the artwork.
    const width = this.sheet.naturalWidth * this.zoom;
    const height = this.sheet.naturalHeight * this.zoom;
    this.view.width = width;
    this.view.height = height;

    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.sheet, 0, 0, width, height);

    const tw = tileset.tileWidth * this.zoom;
    const th = tileset.tileHeight * this.zoom;
    const rectOf = (index: number) => {
      const column = index % tileset.columns;
      const row = Math.floor(index / tileset.columns);
      const origin = tilePixel(tileset, column, row);
      return { x: origin.x * this.zoom, y: origin.y * this.zoom };
    };

    // Dim everything the slice does not cover, so margin and gaps read as
    // unused at a glance. One even-odd fill: the canvas minus every tile rect.
    ctx.beginPath();
    ctx.rect(0, 0, width, height);
    for (let index = 0; index < tileset.columns * tileset.rows; index++) {
      const { x, y } = rectOf(index);
      ctx.rect(x, y, tw, th);
    }
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill('evenodd');

    for (let index = 0; index < tileset.columns * tileset.rows; index++) {
      const { x, y } = rectOf(index);

      if (this.showSolid && tileset.solid[index]) {
        ctx.fillStyle = 'rgba(255, 0, 77, 0.35)';
        ctx.fillRect(x, y, tw, th);
        ctx.strokeStyle = '#ff004d';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, tw - 2, th - 2);
      }

      ctx.strokeStyle = index === this.hovered ? '#29adff' : 'rgba(255,255,255,0.3)';
      ctx.lineWidth = index === this.hovered ? 2 : 1;
      ctx.strokeRect(x + 0.5, y + 0.5, tw - 1, th - 1);

      if (tw >= 24) {
        ctx.font = '9px ui-monospace, monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.textBaseline = 'top';
        ctx.fillText(String(index), x + 3, y + 2);
      }
    }
  }
}
