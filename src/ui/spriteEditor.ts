import { decodeImageFile, pickImageFiles, refitFrame } from '../project/importImage';
import type { ProjectStore } from '../project/store';
import type { SpriteFile } from '../project/types';
import { clear, el, modal, type Panel } from './dom';
import { showImportDialog } from './importSprite';

/**
 * Pixel art editor.
 *
 * Frames are held as ImageData so pixel writes are exact -- no blending, which
 * is what pixel art needs -- with a canvas mirror used for display, thumbnails
 * and PNG encoding. Each committed stroke is one entry on the project's undo
 * stack.
 */

type RGBA = [number, number, number, number];

interface Frame {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  img: ImageData;
  dirty: boolean;
}

interface Stroke {
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  colour: RGBA;
  snapshot: Uint8ClampedArray;
}

const svg = (path: string) =>
  `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

const TOOLS = [
  { id: 'pencil', key: 'b', title: 'Pencil (B)', icon: svg('<path d="M2 14l1-3.5L10.5 3 13 5.5 5.5 13 2 14z"/>') },
  { id: 'eraser', key: 'e', title: 'Eraser (E)', icon: svg('<path d="M4 13h9"/><path d="M6.5 11.5L2.5 7.5 8 2l4 4-5.5 5.5z"/>') },
  { id: 'fill', key: 'g', title: 'Flood fill (G)', icon: svg('<path d="M6 2l6 6-5 5-6-6 5-5z"/><path d="M13.5 11c0 1-.7 1.7-1.5 1.7S10.5 12 10.5 11 12 8.6 12 8.6 13.5 10 13.5 11z" fill="currentColor" stroke="none"/>') },
  { id: 'picker', key: 'i', title: 'Colour picker (I)', icon: svg('<path d="M11 2.5l2.5 2.5-7 7L3 13l1-3.5 7-7z"/><path d="M9.5 4l2.5 2.5"/>') },
  { id: 'line', key: 'l', title: 'Line (L)', icon: svg('<path d="M3 13L13 3"/>') },
  { id: 'rect', key: 'r', title: 'Rectangle (R) — Shift fills', icon: svg('<rect x="2.5" y="3.5" width="11" height="9"/>') },
  { id: 'ellipse', key: 'c', title: 'Ellipse (C) — Shift fills', icon: svg('<ellipse cx="8" cy="8" rx="5.5" ry="4.5"/>') },
  { id: 'move', key: 'm', title: 'Shift pixels (M)', icon: svg('<path d="M8 2v12M2 8h12M8 2L6 4M8 2l2 2M8 14l-2-2M8 14l2-2M2 8l2-2M2 8l2 2M14 8l-2-2M14 8l-2 2"/>') },
] as const;

const SIZES = [1, 2, 3, 4];

function hexToRgba(hex: string): RGBA {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
    255,
  ];
}

function rgbaToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

export class SpriteEditor implements Panel {
  readonly element: HTMLElement;

  private frames: Frame[] = [];
  private current = 0;
  private tool: string = 'pencil';
  private brush = 1;
  private primary = '#000000';
  private secondary = '#ffffff';
  private zoom = 8;
  private panX = 0;
  private panY = 0;
  private showGrid = false;
  private showOnion = false;
  private showOrigin = true;
  private playing = false;

  private stroke: Stroke | null = null;
  private panning: { x: number; y: number } | null = null;
  private spaceDown = false;

  private view!: HTMLCanvasElement;
  private vctx!: CanvasRenderingContext2D;
  private preview!: HTMLCanvasElement;
  private pctx!: CanvasRenderingContext2D;
  private strip!: HTMLElement;
  private paletteBox!: HTMLElement;
  private toolsBox!: HTMLElement;
  private sizesBox!: HTMLElement;
  private fields: Record<string, HTMLInputElement | HTMLSelectElement> = {};
  private posLabel!: HTMLElement;
  private zoomLabel!: HTMLElement;

  private previewFrame = 0;
  private previewClock = 0;
  private rafHandle = 0;
  private resizeObserver?: ResizeObserver;
  private unsubscribe?: () => void;
  private lastLoaded = '';

  constructor(
    private readonly store: ProjectStore,
    private readonly spriteName: string,
  ) {
    this.element = this.build();
    this.unsubscribe = store.on('change', () => this.syncFromStore());
    void this.syncFromStore();
  }

  private get sprite(): SpriteFile {
    const found = this.store.sprite(this.spriteName);
    if (!found) throw new Error(`Sprite ${this.spriteName} no longer exists`);
    return found;
  }

  // -- construction ----------------------------------------------------

  private build(): HTMLElement {
    this.view = el('canvas', { class: 'pixel-view' });
    this.vctx = this.view.getContext('2d')!;
    this.preview = el('canvas', { class: 'anim-preview' });
    this.pctx = this.preview.getContext('2d')!;
    this.strip = el('div', { class: 'frame-strip' });
    this.paletteBox = el('div', { class: 'palette' });
    this.toolsBox = el('div', { class: 'tool-grid' });
    this.sizesBox = el('div', { class: 'tool-grid' });
    this.posLabel = el('span', { class: 'mono', text: '0, 0' });
    this.zoomLabel = el('span', { class: 'mono', text: '100%' });

    for (const tool of TOOLS) {
      this.toolsBox.append(
        el('button', {
          html: tool.icon,
          title: tool.title,
          dataset: { tool: tool.id },
          onclick: () => this.selectTool(tool.id),
        }),
      );
    }
    for (const size of SIZES) {
      this.sizesBox.append(
        el('button', {
          text: String(size),
          title: `Brush size ${size} ( [ and ] )`,
          dataset: { size: String(size) },
          onclick: () => {
            this.brush = size;
            this.syncToolbar();
          },
        }),
      );
    }

    const primaryInput = el('input', {
      type: 'color',
      value: this.primary,
      title: 'Primary colour (left mouse)',
      oninput: (e: Event) => {
        this.primary = (e.target as HTMLInputElement).value;
        this.buildPalette();
      },
    });
    const secondaryInput = el('input', {
      type: 'color',
      value: this.secondary,
      title: 'Secondary colour (right mouse)',
      oninput: (e: Event) => {
        this.secondary = (e.target as HTMLInputElement).value;
      },
    });
    this.fields.primary = primaryInput;
    this.fields.secondary = secondaryInput;

    const toolbar = el(
      'aside',
      { class: 'pixel-toolbar' },
      this.toolsBox,
      this.sizesBox,
      el(
        'div',
        { class: 'swatch-pair' },
        primaryInput,
        secondaryInput,
      ),
      el('button', {
        class: 'mini',
        text: '+',
        title: 'Add primary colour to the palette',
        onclick: () => this.addSwatch(),
      }),
      this.paletteBox,
    );

    const canvasWrap = el('div', { class: 'pixel-canvas-wrap' }, this.view);

    const checkbox = (label: string, checked: boolean, onchange: (v: boolean) => void) =>
      el(
        'label',
        {},
        el('input', {
          type: 'checkbox',
          checked,
          onchange: (e: Event) => onchange((e.target as HTMLInputElement).checked),
        }),
        label,
      );

    const status = el(
      'div',
      { class: 'pixel-status' },
      this.posLabel,
      this.zoomLabel,
      el('span', { class: 'grow' }),
      checkbox('Grid', this.showGrid, (v) => {
        this.showGrid = v;
        this.render();
      }),
      checkbox('Onion', this.showOnion, (v) => {
        this.showOnion = v;
        this.render();
      }),
      checkbox('Origin', this.showOrigin, (v) => {
        this.showOrigin = v;
        this.render();
      }),
    );

    const numberField = (key: string, label: string, onchange: () => void) => {
      const input = el('input', { type: 'number', onchange }) as HTMLInputElement;
      this.fields[key] = input;
      return el('label', { class: 'field' }, el('span', { text: label }), input);
    };

    const sidebar = el(
      'aside',
      { class: 'pixel-sidebar' },
      el(
        'section',
        {},
        el('h3', { text: 'Sprite' }),
        el('div', { class: 'kv' }, el('span', { text: 'Name' }), el('strong', { text: this.spriteName })),
        el('div', { class: 'kv' }, el('span', { text: 'Size' }), el('strong', { class: 'size-label' })),
        el('button', { text: 'Resize canvas…', onclick: () => void this.showResize() }),
        el('button', {
          text: 'Import frames…',
          title: 'Add frames from an image or sprite sheet',
          onclick: () => void this.importFrames(),
        }),
      ),
      el(
        'section',
        {},
        el('h3', { text: 'Origin' }),
        el(
          'div',
          { class: 'field-row' },
          numberField('originX', 'X', () => this.applyOrigin()),
          numberField('originY', 'Y', () => this.applyOrigin()),
        ),
        el(
          'div',
          { class: 'button-row' },
          el('button', { text: 'Top left', onclick: () => this.presetOrigin('topleft') }),
          el('button', { text: 'Centre', onclick: () => this.presetOrigin('center') }),
          el('button', { text: 'Bottom', onclick: () => this.presetOrigin('bottom') }),
        ),
      ),
      el(
        'section',
        {},
        el('h3', { text: 'Collision' }),
        el(
          'div',
          { class: 'field-row' },
          numberField('colLeft', 'L', () => this.applyCollision()),
          numberField('colTop', 'T', () => this.applyCollision()),
        ),
        el(
          'div',
          { class: 'field-row' },
          numberField('colRight', 'R', () => this.applyCollision()),
          numberField('colBottom', 'B', () => this.applyCollision()),
        ),
        el('button', { text: 'Fit to pixels', onclick: () => this.fitCollision() }),
      ),
      el(
        'section',
        {},
        el('h3', { text: 'Animation' }),
        el('div', { class: 'field-row' }, numberField('fps', 'FPS', () => this.applyFps())),
        el('button', {
          class: 'play-toggle',
          text: '▶ Play',
          onclick: (e: Event) => {
            this.playing = !this.playing;
            (e.target as HTMLElement).textContent = this.playing ? '⏸ Pause' : '▶ Play';
          },
        }),
        el('div', { class: 'preview-wrap' }, this.preview),
      ),
    );

    const frames = el(
      'div',
      { class: 'frame-bar' },
      this.strip,
      el(
        'div',
        { class: 'frame-actions' },
        el('button', { text: '+', title: 'Add empty frame', onclick: () => this.addFrame() }),
        el('button', { text: '⧉', title: 'Duplicate frame', onclick: () => this.duplicateFrame() }),
        el('button', { text: '🗑', title: 'Delete frame', onclick: () => this.deleteFrame() }),
        el('button', { text: '◀', title: 'Move frame left', onclick: () => this.moveFrame(-1) }),
        el('button', { text: '▶', title: 'Move frame right', onclick: () => this.moveFrame(1) }),
      ),
    );

    this.attachCanvasEvents();

    return el(
      'div',
      { class: 'sprite-editor' },
      toolbar,
      el('div', { class: 'pixel-stage' }, canvasWrap, status),
      sidebar,
      frames,
    );
  }

  // -- lifecycle -------------------------------------------------------

  activate(): void {
    this.resizeObserver ??= new ResizeObserver(() => this.resizeView());
    this.resizeObserver.observe(this.element.querySelector('.pixel-canvas-wrap')!);
    document.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('keyup', this.onKeyUp);
    this.rafHandle = requestAnimationFrame(this.tickPreview);
    this.resizeView();
  }

  deactivate(): void {
    this.resizeObserver?.disconnect();
    document.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('keyup', this.onKeyUp);
    cancelAnimationFrame(this.rafHandle);
  }

  dispose(): void {
    this.deactivate();
    this.unsubscribe?.();
  }

  // -- store sync ------------------------------------------------------

  private async syncFromStore(): Promise<void> {
    const sprite = this.store.sprite(this.spriteName);
    if (!sprite) return;

    const serialised = JSON.stringify(sprite);
    if (serialised === this.lastLoaded) return;

    const resized =
      this.frames.length > 0 &&
      (this.frames[0].canvas.width !== sprite.width || this.frames[0].canvas.height !== sprite.height);
    const first = this.frames.length === 0;

    this.lastLoaded = serialised;
    this.frames = await Promise.all(
      (sprite.frames.length ? sprite.frames : ['']).map((encoded) =>
        this.decodeFrame(encoded, sprite.width, sprite.height),
      ),
    );
    this.current = Math.min(this.current, this.frames.length - 1);

    (this.element.querySelector('.size-label') as HTMLElement).textContent =
      `${sprite.width} × ${sprite.height}`;
    (this.fields.originX as HTMLInputElement).value = String(sprite.originX);
    (this.fields.originY as HTMLInputElement).value = String(sprite.originY);
    (this.fields.fps as HTMLInputElement).value = String(sprite.fps);
    (this.fields.colLeft as HTMLInputElement).value = String(sprite.collision.left);
    (this.fields.colTop as HTMLInputElement).value = String(sprite.collision.top);
    (this.fields.colRight as HTMLInputElement).value = String(sprite.collision.right);
    (this.fields.colBottom as HTMLInputElement).value = String(sprite.collision.bottom);

    if (first || resized) this.fitView();
    this.buildPalette();
    this.buildStrip();
    this.render();
  }

  /** Persist the current pixel data plus any property changes. */
  private commit(label: string, mutate?: (sprite: SpriteFile) => void): void {
    const encoded = this.frames.map((frame) => this.encodeFrame(frame));
    this.store.commit(label, () => {
      const sprite = this.sprite;
      sprite.frames = encoded;
      mutate?.(sprite);
    });
    this.lastLoaded = JSON.stringify(this.sprite);
    this.buildStrip();
  }

  // -- frame helpers ---------------------------------------------------

  private makeFrame(width: number, height: number): Frame {
    const canvas = el('canvas', { width, height }) as HTMLCanvasElement;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    return { canvas, ctx, img: ctx.createImageData(width, height), dirty: true };
  }

  private decodeFrame(encoded: string, width: number, height: number): Promise<Frame> {
    return new Promise((resolve) => {
      const frame = this.makeFrame(width, height);
      if (!encoded) return resolve(frame);
      const image = new Image();
      image.onload = () => {
        frame.ctx.drawImage(image, 0, 0);
        frame.img = frame.ctx.getImageData(0, 0, width, height);
        resolve(frame);
      };
      image.onerror = () => resolve(frame);
      image.src = 'data:image/png;base64,' + encoded;
    });
  }

  private flush(frame: Frame): void {
    if (frame.dirty) {
      frame.ctx.putImageData(frame.img, 0, 0);
      frame.dirty = false;
    }
  }

  private encodeFrame(frame: Frame): string {
    this.flush(frame);
    return frame.canvas.toDataURL('image/png').split(',')[1];
  }

  private get frame(): Frame {
    return this.frames[this.current];
  }

  // -- pixel operations ------------------------------------------------

  private setPixel(frame: Frame, x: number, y: number, rgba: RGBA): void {
    const { width, height } = this.sprite;
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    frame.img.data[i] = rgba[0];
    frame.img.data[i + 1] = rgba[1];
    frame.img.data[i + 2] = rgba[2];
    frame.img.data[i + 3] = rgba[3];
    frame.dirty = true;
  }

  private getPixel(frame: Frame, x: number, y: number): RGBA {
    const { width, height } = this.sprite;
    if (x < 0 || y < 0 || x >= width || y >= height) return [0, 0, 0, 0];
    const i = (y * width + x) * 4;
    const d = frame.img.data;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  }

  private stamp(frame: Frame, x: number, y: number, rgba: RGBA): void {
    const start = -Math.floor((this.brush - 1) / 2);
    for (let dy = 0; dy < this.brush; dy++) {
      for (let dx = 0; dx < this.brush; dx++) {
        this.setPixel(frame, x + start + dx, y + start + dy, rgba);
      }
    }
  }

  private drawLine(frame: Frame, x0: number, y0: number, x1: number, y1: number, rgba: RGBA): void {
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;

    for (;;) {
      this.stamp(frame, x0, y0, rgba);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  private drawRect(
    frame: Frame, x0: number, y0: number, x1: number, y1: number, rgba: RGBA, filled: boolean,
  ): void {
    const [lo, hi] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [top, bottom] = [Math.min(y0, y1), Math.max(y0, y1)];
    for (let y = top; y <= bottom; y++) {
      for (let x = lo; x <= hi; x++) {
        if (filled || x === lo || x === hi || y === top || y === bottom) {
          this.setPixel(frame, x, y, rgba);
        }
      }
    }
  }

  private drawEllipse(
    frame: Frame, x0: number, y0: number, x1: number, y1: number, rgba: RGBA, filled: boolean,
  ): void {
    const [lo, hi] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [top, bottom] = [Math.min(y0, y1), Math.max(y0, y1)];
    const cx = (lo + hi) / 2;
    const cy = (top + bottom) / 2;
    const rx = Math.max((hi - lo) / 2, 0.5);
    const ry = Math.max((bottom - top) / 2, 0.5);
    const inside = (x: number, y: number) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

    for (let y = top; y <= bottom; y++) {
      for (let x = lo; x <= hi; x++) {
        if (!inside(x, y)) continue;
        const edge =
          !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
        if (filled || edge) this.setPixel(frame, x, y, rgba);
      }
    }
  }

  private floodFill(frame: Frame, x: number, y: number, rgba: RGBA): void {
    const { width, height } = this.sprite;
    const target = this.getPixel(frame, x, y);
    if (target.every((v, i) => v === rgba[i])) return;

    const stack: [number, number][] = [[x, y]];
    const seen = new Uint8Array(width * height);
    while (stack.length) {
      const [px, py] = stack.pop()!;
      if (px < 0 || py < 0 || px >= width || py >= height || seen[py * width + px]) continue;
      seen[py * width + px] = 1;
      if (!this.getPixel(frame, px, py).every((v, i) => v === target[i])) continue;
      this.setPixel(frame, px, py, rgba);
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
  }

  private shiftPixels(frame: Frame, snapshot: Uint8ClampedArray, dx: number, dy: number): void {
    const { width, height } = this.sprite;
    const d = frame.img.data;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const sx = x - dx;
        const sy = y - dy;
        const i = (y * width + x) * 4;
        if (sx < 0 || sy < 0 || sx >= width || sy >= height) {
          d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
        } else {
          const j = (sy * width + sx) * 4;
          d[i] = snapshot[j];
          d[i + 1] = snapshot[j + 1];
          d[i + 2] = snapshot[j + 2];
          d[i + 3] = snapshot[j + 3];
        }
      }
    }
    frame.dirty = true;
  }

  // -- view ------------------------------------------------------------

  private screenToPixel(event: PointerEvent): { x: number; y: number } {
    const rect = this.view.getBoundingClientRect();
    return {
      x: Math.floor((event.clientX - rect.left - this.panX) / this.zoom),
      y: Math.floor((event.clientY - rect.top - this.panY) / this.zoom),
    };
  }

  private fitView(): void {
    const rect = this.view.getBoundingClientRect();
    const { width, height } = this.sprite;
    if (rect.width < 2 || rect.height < 2) return;
    this.zoom = Math.max(1, Math.min(48, Math.floor(
      Math.min((rect.width - 40) / width, (rect.height - 40) / height),
    )));
    this.panX = Math.round((rect.width - width * this.zoom) / 2);
    this.panY = Math.round((rect.height - height * this.zoom) / 2);
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
  }

  private resizeView(): void {
    const rect = this.view.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.view.width = Math.max(1, Math.round(rect.width * dpr));
    this.view.height = Math.max(1, Math.round(rect.height * dpr));
    this.vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  private render(): void {
    if (!this.frames.length) return;
    const sprite = this.store.sprite(this.spriteName);
    if (!sprite) return;

    const { width, height } = sprite;
    const z = this.zoom;
    const rect = this.view.getBoundingClientRect();
    const ctx = this.vctx;

    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.imageSmoothingEnabled = false;

    // Transparency checkerboard, clipped to the sprite bounds.
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.panX, this.panY, width * z, height * z);
    ctx.clip();
    ctx.fillStyle = '#2b2b2b';
    ctx.fillRect(this.panX, this.panY, width * z, height * z);
    ctx.fillStyle = '#3a3a3a';
    const check = 8;
    for (let y = 0; y < Math.ceil((height * z) / check); y++) {
      for (let x = 0; x < Math.ceil((width * z) / check); x++) {
        if ((x + y) % 2 === 0) {
          ctx.fillRect(this.panX + x * check, this.panY + y * check, check, check);
        }
      }
    }
    ctx.restore();

    if (this.showOnion && this.frames.length > 1) {
      const prev = this.frames[(this.current - 1 + this.frames.length) % this.frames.length];
      this.flush(prev);
      ctx.globalAlpha = 0.3;
      ctx.drawImage(prev.canvas, this.panX, this.panY, width * z, height * z);
      ctx.globalAlpha = 1;
    }

    this.flush(this.frame);
    ctx.drawImage(this.frame.canvas, this.panX, this.panY, width * z, height * z);

    if (this.showGrid && z >= 4) {
      ctx.strokeStyle = 'rgba(128,128,128,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 0; x <= width; x++) {
        ctx.moveTo(this.panX + x * z + 0.5, this.panY);
        ctx.lineTo(this.panX + x * z + 0.5, this.panY + height * z);
      }
      for (let y = 0; y <= height; y++) {
        ctx.moveTo(this.panX, this.panY + y * z + 0.5);
        ctx.lineTo(this.panX + width * z, this.panY + y * z + 0.5);
      }
      ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(160,160,160,0.8)';
    ctx.lineWidth = 1;
    ctx.strokeRect(this.panX - 0.5, this.panY - 0.5, width * z + 1, height * z + 1);

    if (this.showOrigin) {
      const ox = this.panX + sprite.originX * z;
      const oy = this.panY + sprite.originY * z;
      ctx.strokeStyle = '#ff004d';
      ctx.beginPath();
      ctx.moveTo(ox - 7, oy + 0.5);
      ctx.lineTo(ox + 7, oy + 0.5);
      ctx.moveTo(ox + 0.5, oy - 7);
      ctx.lineTo(ox + 0.5, oy + 7);
      ctx.stroke();
    }
  }

  // -- toolbar / palette -----------------------------------------------

  private selectTool(id: string): void {
    this.tool = id;
    this.syncToolbar();
  }

  private syncToolbar(): void {
    for (const button of this.toolsBox.querySelectorAll('button')) {
      button.classList.toggle('active', button.dataset.tool === this.tool);
    }
    for (const button of this.sizesBox.querySelectorAll('button')) {
      button.classList.toggle('active', Number(button.dataset.size) === this.brush);
    }
  }

  private buildPalette(): void {
    clear(this.paletteBox);
    const sprite = this.store.sprite(this.spriteName);
    if (!sprite) return;

    sprite.palette.forEach((hex, index) => {
      const swatch = el('button', {
        class: 'swatch' + (hex.toLowerCase() === this.primary.toLowerCase() ? ' selected' : ''),
        style: `background:${hex}`,
        title: `${hex} — click to pick, right-click to replace, middle-click to remove`,
        onclick: () => {
          this.primary = hex;
          (this.fields.primary as HTMLInputElement).value = hex;
          this.buildPalette();
        },
        oncontextmenu: (event: MouseEvent) => {
          event.preventDefault();
          this.store.commit('replace palette colour', () => {
            this.sprite.palette[index] = this.primary;
          });
          this.lastLoaded = JSON.stringify(this.sprite);
          this.buildPalette();
        },
        onauxclick: (event: MouseEvent) => {
          if (event.button !== 1) return;
          this.store.commit('remove palette colour', () => {
            this.sprite.palette.splice(index, 1);
          });
          this.lastLoaded = JSON.stringify(this.sprite);
          this.buildPalette();
        },
      });
      this.paletteBox.append(swatch);
    });
  }

  private addSwatch(): void {
    if (this.sprite.palette.includes(this.primary)) return;
    this.store.commit('add palette colour', () => this.sprite.palette.push(this.primary));
    this.lastLoaded = JSON.stringify(this.sprite);
    this.buildPalette();
  }

  // -- frame strip -----------------------------------------------------

  private buildStrip(): void {
    clear(this.strip);
    const sprite = this.store.sprite(this.spriteName);
    if (!sprite) return;
    const scale = Math.max(1, Math.floor(Math.min(44 / sprite.width, 44 / sprite.height)) || 1);

    this.frames.forEach((frame, index) => {
      this.flush(frame);
      const thumb = el('canvas', {
        width: sprite.width * scale,
        height: sprite.height * scale,
      }) as HTMLCanvasElement;
      const tctx = thumb.getContext('2d')!;
      tctx.imageSmoothingEnabled = false;
      tctx.fillStyle = '#2b2b2b';
      tctx.fillRect(0, 0, thumb.width, thumb.height);
      tctx.drawImage(frame.canvas, 0, 0, thumb.width, thumb.height);

      this.strip.append(
        el(
          'button',
          {
            class: 'frame' + (index === this.current ? ' selected' : ''),
            title: `Frame ${index + 1}`,
            onclick: () => {
              this.current = index;
              this.buildStrip();
              this.render();
            },
          },
          thumb,
          el('span', { class: 'index', text: String(index + 1) }),
        ),
      );
    });
  }

  private addFrame(): void {
    const sprite = this.sprite;
    this.frames.splice(this.current + 1, 0, this.makeFrame(sprite.width, sprite.height));
    this.current++;
    this.commit('add frame');
    this.render();
  }

  private duplicateFrame(): void {
    const sprite = this.sprite;
    const copy = this.makeFrame(sprite.width, sprite.height);
    copy.img.data.set(this.frame.img.data);
    this.frames.splice(this.current + 1, 0, copy);
    this.current++;
    this.commit('duplicate frame');
    this.render();
  }

  private deleteFrame(): void {
    if (this.frames.length <= 1) return;
    this.frames.splice(this.current, 1);
    this.current = Math.max(0, this.current - 1);
    this.commit('delete frame');
    this.render();
  }

  private moveFrame(delta: number): void {
    const target = this.current + delta;
    if (target < 0 || target >= this.frames.length) return;
    const [frame] = this.frames.splice(this.current, 1);
    this.frames.splice(target, 0, frame);
    this.current = target;
    this.commit('reorder frames');
  }

  // -- property edits --------------------------------------------------

  private applyOrigin(): void {
    const x = Number((this.fields.originX as HTMLInputElement).value) | 0;
    const y = Number((this.fields.originY as HTMLInputElement).value) | 0;
    this.setOrigin(x, y);
  }

  private setOrigin(x: number, y: number): void {
    this.store.commit('set origin', () => {
      this.sprite.originX = x;
      this.sprite.originY = y;
    });
    this.lastLoaded = JSON.stringify(this.sprite);
    (this.fields.originX as HTMLInputElement).value = String(x);
    (this.fields.originY as HTMLInputElement).value = String(y);
    this.render();
  }

  private presetOrigin(which: 'topleft' | 'center' | 'bottom'): void {
    const { width, height } = this.sprite;
    const presets = {
      topleft: [0, 0],
      center: [Math.floor(width / 2), Math.floor(height / 2)],
      bottom: [Math.floor(width / 2), height - 1],
    } as const;
    const [x, y] = presets[which];
    this.setOrigin(x, y);
  }

  private applyFps(): void {
    const fps = Math.max(1, Number((this.fields.fps as HTMLInputElement).value) | 0);
    this.store.commit('set animation speed', () => {
      this.sprite.fps = fps;
    });
    this.lastLoaded = JSON.stringify(this.sprite);
  }

  private applyCollision(): void {
    const read = (key: string) => Number((this.fields[key] as HTMLInputElement).value) | 0;
    this.store.commit('set collision mask', () => {
      this.sprite.collision = {
        mode: this.sprite.collision.mode,
        left: read('colLeft'),
        top: read('colTop'),
        right: read('colRight'),
        bottom: read('colBottom'),
      };
    });
    this.lastLoaded = JSON.stringify(this.sprite);
  }

  private fitCollision(): void {
    const { width, height } = this.sprite;
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;

    for (const frame of this.frames) {
      const d = frame.img.data;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          if (d[(y * width + x) * 4 + 3] > 0) {
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
          }
        }
      }
    }
    if (right < 0) [left, top, right, bottom] = [0, 0, width - 1, height - 1];

    (this.fields.colLeft as HTMLInputElement).value = String(left);
    (this.fields.colTop as HTMLInputElement).value = String(top);
    (this.fields.colRight as HTMLInputElement).value = String(right);
    (this.fields.colBottom as HTMLInputElement).value = String(bottom);
    this.applyCollision();
  }

  /**
   * Append frames from an image file to this sprite.
   *
   * The frames are cropped or padded to the sprite's size rather than scaled:
   * scaling pixel art blurs it, and a wrong-sized import is better noticed
   * than silently smoothed over.
   */
  private async importFrames(): Promise<void> {
    const [file] = await pickImageFiles(false);
    if (!file) return;

    const image = await decodeImageFile(file);
    if (!image) {
      await modal(
        'Import failed',
        el('div', { class: 'modal-body' }, el('p', { text: `${file.name} could not be read as an image.` })),
        'OK',
      );
      return;
    }

    const sprite = this.sprite;
    const result = await showImportDialog({
      image,
      fileName: file.name,
      existing: { name: sprite.name, width: sprite.width, height: sprite.height },
    });
    if (!result || result.frames.length === 0) return;

    const fitted = await Promise.all(
      result.frames.map((frame) => refitFrame(frame, sprite.width, sprite.height)),
    );

    const decoded = await Promise.all(
      fitted.map((frame) => this.decodeFrame(frame, sprite.width, sprite.height)),
    );
    this.frames.push(...decoded);
    this.current = this.frames.length - 1;
    this.commit('import frames', (target) => {
      // Colours from the imported art, added without duplicating.
      for (const colour of result.palette) {
        if (!target.palette.includes(colour) && target.palette.length < 32) {
          target.palette.push(colour);
        }
      }
    });
    this.buildPalette();
    this.render();
  }

  private async showResize(): Promise<void> {
    const sprite = this.sprite;
    const widthInput = el('input', { type: 'number', value: String(sprite.width), min: '1', max: '512' }) as HTMLInputElement;
    const heightInput = el('input', { type: 'number', value: String(sprite.height), min: '1', max: '512' }) as HTMLInputElement;
    const anchor = el('select', {}, el('option', { value: 'topleft', text: 'Top left' }), el('option', { value: 'center', text: 'Centre', selected: true })) as HTMLSelectElement;

    const body = el(
      'div',
      { class: 'modal-body' },
      el('div', { class: 'field-row' },
        el('label', { class: 'field' }, el('span', { text: 'W' }), widthInput),
        el('label', { class: 'field' }, el('span', { text: 'H' }), heightInput)),
      el('label', { class: 'field' }, el('span', { text: 'Anchor' }), anchor),
    );

    if (!(await modal('Resize canvas', body, 'Resize'))) return;

    const width = Math.max(1, Math.min(512, Number(widthInput.value) | 0));
    const height = Math.max(1, Math.min(512, Number(heightInput.value) | 0));
    this.resizeSprite(width, height, anchor.value === 'center');
  }

  private resizeSprite(width: number, height: number, centred: boolean): void {
    const sprite = this.sprite;
    const oldWidth = sprite.width;
    const oldHeight = sprite.height;
    const dx = centred ? Math.floor((width - oldWidth) / 2) : 0;
    const dy = centred ? Math.floor((height - oldHeight) / 2) : 0;

    this.frames = this.frames.map((old) => {
      const next = this.makeFrame(width, height);
      for (let y = 0; y < oldHeight; y++) {
        for (let x = 0; x < oldWidth; x++) {
          const tx = x + dx;
          const ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
          const s = (y * oldWidth + x) * 4;
          const t = (ty * width + tx) * 4;
          next.img.data[t] = old.img.data[s];
          next.img.data[t + 1] = old.img.data[s + 1];
          next.img.data[t + 2] = old.img.data[s + 2];
          next.img.data[t + 3] = old.img.data[s + 3];
        }
      }
      return next;
    });

    this.commit('resize sprite', (s) => {
      s.width = width;
      s.height = height;
      s.originX = Math.max(0, Math.min(width - 1, s.originX + dx));
      s.originY = Math.max(0, Math.min(height - 1, s.originY + dy));
      s.collision = { mode: s.collision.mode, left: 0, top: 0, right: width - 1, bottom: height - 1 };
    });

    void this.syncFromStore();
    this.fitView();
    this.render();
  }

  // -- input -----------------------------------------------------------

  private attachCanvasEvents(): void {
    this.view.addEventListener('pointerdown', (event) => {
      this.view.setPointerCapture(event.pointerId);
      if (event.button === 1 || this.spaceDown) {
        this.panning = { x: event.clientX - this.panX, y: event.clientY - this.panY };
        event.preventDefault();
        return;
      }
      if (event.button === 0 || event.button === 2) this.beginStroke(event);
    });

    this.view.addEventListener('pointermove', (event) => {
      if (this.panning) {
        this.panX = event.clientX - this.panning.x;
        this.panY = event.clientY - this.panning.y;
        this.render();
        return;
      }
      this.moveStroke(event);
    });

    const release = () => {
      this.panning = null;
      if (this.stroke) {
        this.stroke = null;
        this.commit('paint');
      }
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
        const next = Math.max(1, Math.min(64, this.zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
        if (next === this.zoom) return;
        this.panX = px - ((px - this.panX) / this.zoom) * next;
        this.panY = py - ((py - this.panY) / this.zoom) * next;
        this.zoom = next;
        this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
        this.render();
      },
      { passive: false },
    );
  }

  private beginStroke(event: PointerEvent): void {
    const { x, y } = this.screenToPixel(event);

    if (event.altKey) {
      this.setOrigin(x, y);
      return;
    }

    if (this.tool === 'picker') {
      const [r, g, b, a] = this.getPixel(this.frame, x, y);
      if (a > 0) {
        const hex = rgbaToHex(r, g, b);
        if (event.button === 2) {
          this.secondary = hex;
          (this.fields.secondary as HTMLInputElement).value = hex;
        } else {
          this.primary = hex;
          (this.fields.primary as HTMLInputElement).value = hex;
        }
        this.buildPalette();
      }
      return;
    }

    const colour: RGBA =
      this.tool === 'eraser'
        ? [0, 0, 0, 0]
        : hexToRgba(event.button === 2 ? this.secondary : this.primary);

    this.stroke = {
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      colour,
      snapshot: new Uint8ClampedArray(this.frame.img.data),
    };

    if (this.tool === 'pencil' || this.tool === 'eraser') this.stamp(this.frame, x, y, colour);
    else if (this.tool === 'fill') this.floodFill(this.frame, x, y, colour);
    this.render();
  }

  private moveStroke(event: PointerEvent): void {
    const { x, y } = this.screenToPixel(event);
    this.posLabel.textContent = `${x}, ${y}`;
    if (!this.stroke) return;

    const frame = this.frame;
    const restore = () => {
      frame.img.data.set(this.stroke!.snapshot);
      frame.dirty = true;
    };

    switch (this.tool) {
      case 'pencil':
      case 'eraser':
        this.drawLine(frame, this.stroke.lastX, this.stroke.lastY, x, y, this.stroke.colour);
        break;
      case 'line':
        restore();
        this.drawLine(frame, this.stroke.startX, this.stroke.startY, x, y, this.stroke.colour);
        break;
      case 'rect':
        restore();
        this.drawRect(frame, this.stroke.startX, this.stroke.startY, x, y, this.stroke.colour, event.shiftKey);
        break;
      case 'ellipse':
        restore();
        this.drawEllipse(frame, this.stroke.startX, this.stroke.startY, x, y, this.stroke.colour, event.shiftKey);
        break;
      case 'move':
        this.shiftPixels(frame, this.stroke.snapshot, x - this.stroke.startX, y - this.stroke.startY);
        break;
    }

    this.stroke.lastX = x;
    this.stroke.lastY = y;
    this.render();
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null;
    if (target && /INPUT|SELECT|TEXTAREA/.test(target.tagName)) return;
    if (event.ctrlKey || event.metaKey) return; // undo/redo handled globally

    if (event.key === ' ') {
      this.spaceDown = true;
      this.view.style.cursor = 'grab';
      event.preventDefault();
      return;
    }

    const tool = TOOLS.find((t) => t.key === event.key.toLowerCase());
    if (tool) {
      this.selectTool(tool.id);
      return;
    }

    switch (event.key) {
      case '[':
        this.brush = Math.max(1, this.brush - 1);
        this.syncToolbar();
        break;
      case ']':
        this.brush = Math.min(SIZES.length, this.brush + 1);
        this.syncToolbar();
        break;
      case ',':
        this.current = (this.current - 1 + this.frames.length) % this.frames.length;
        this.buildStrip();
        this.render();
        break;
      case '.':
        this.current = (this.current + 1) % this.frames.length;
        this.buildStrip();
        this.render();
        break;
      case 'x': {
        [this.primary, this.secondary] = [this.secondary, this.primary];
        (this.fields.primary as HTMLInputElement).value = this.primary;
        (this.fields.secondary as HTMLInputElement).value = this.secondary;
        this.buildPalette();
        break;
      }
      case '0':
        this.fitView();
        this.render();
        break;
    }
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.key === ' ') {
      this.spaceDown = false;
      this.view.style.cursor = 'crosshair';
    }
  };

  // -- animation preview -----------------------------------------------

  private tickPreview = (now: number): void => {
    this.rafHandle = requestAnimationFrame(this.tickPreview);
    const sprite = this.store.sprite(this.spriteName);
    if (!sprite || !this.frames.length) return;

    const scale = Math.max(1, Math.floor(Math.min(72 / sprite.width, 72 / sprite.height)) || 1);
    if (this.preview.width !== sprite.width * scale) {
      this.preview.width = sprite.width * scale;
      this.preview.height = sprite.height * scale;
    }

    if (this.playing) {
      if (now - this.previewClock >= 1000 / Math.max(1, sprite.fps)) {
        this.previewClock = now;
        this.previewFrame = (this.previewFrame + 1) % this.frames.length;
      }
    } else {
      this.previewFrame = this.current;
    }

    const frame = this.frames[Math.min(this.previewFrame, this.frames.length - 1)];
    this.flush(frame);
    this.pctx.imageSmoothingEnabled = false;
    this.pctx.clearRect(0, 0, this.preview.width, this.preview.height);
    this.pctx.drawImage(frame.canvas, 0, 0, this.preview.width, this.preview.height);
  };
}
