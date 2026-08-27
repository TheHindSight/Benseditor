import {
  MAX_FRAME,
  cutFrames,
  extractPalette,
  framePixel,
  sliceGrid,
  spriteNameFromFile,
  suggestSlice,
  wholeImage,
  type SliceOptions,
} from '../project/importImage';
import { validateAssetName } from '../project/types';
import { el, modal } from './dom';

/**
 * The import dialog.
 *
 * One image, a grid over it, and a live count of the frames that grid produces.
 * The preview draws the actual cut lines because the failure everyone hits with
 * a sprite sheet is a margin or a gap they did not know was there, and a number
 * alone will not show you that.
 */

export interface ImportResult {
  name: string;
  width: number;
  height: number;
  /** Base64 PNG per frame. */
  frames: string[];
  palette: string[];
}

export interface ImportRequest {
  image: HTMLImageElement;
  fileName: string;
  /** Set when importing into a sprite that already exists. */
  existing?: { name: string; width: number; height: number };
  /** Names already taken, so the dialog can refuse a duplicate up front. */
  taken?: (name: string) => boolean;
}

const PREVIEW_MAX = 340;

export async function showImportDialog(request: ImportRequest): Promise<ImportResult | null> {
  const { image, fileName, existing } = request;
  const imageWidth = image.naturalWidth;
  const imageHeight = image.naturalHeight;

  const detected = suggestSlice(image, imageWidth, imageHeight);
  const options: SliceOptions = existing
    ? { ...detected.slice, frameWidth: existing.width, frameHeight: existing.height }
    : detected.slice;

  const nameInput = el('input', {
    type: 'text',
    value: spriteNameFromFile(fileName),
  }) as HTMLInputElement;

  const number = (value: number, min = 0) =>
    el('input', { type: 'number', value: String(value), min: String(min) }) as HTMLInputElement;

  const fields = {
    frameWidth: number(options.frameWidth, 1),
    frameHeight: number(options.frameHeight, 1),
    offsetX: number(options.offsetX),
    offsetY: number(options.offsetY),
    spacingX: number(options.spacingX),
    spacingY: number(options.spacingY),
  };

  const preview = el('canvas', { class: 'import-preview' }) as HTMLCanvasElement;
  const readout = el('p', { class: 'tile-readout' });
  const error = el('p', { class: 'field-error' });

  const read = (): SliceOptions => ({
    frameWidth: Math.max(1, Math.min(MAX_FRAME, Number(fields.frameWidth.value) | 0)),
    frameHeight: Math.max(1, Math.min(MAX_FRAME, Number(fields.frameHeight.value) | 0)),
    offsetX: Math.max(0, Number(fields.offsetX.value) | 0),
    offsetY: Math.max(0, Number(fields.offsetY.value) | 0),
    spacingX: Math.max(0, Number(fields.spacingX.value) | 0),
    spacingY: Math.max(0, Number(fields.spacingY.value) | 0),
  });

  const update = () => {
    const current = read();
    const { columns, rows, count } = sliceGrid(imageWidth, imageHeight, current);

    const scale = Math.min(1, PREVIEW_MAX / imageWidth, PREVIEW_MAX / imageHeight);
    preview.width = Math.max(1, Math.round(imageWidth * scale));
    preview.height = Math.max(1, Math.round(imageHeight * scale));

    const ctx = preview.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, preview.width, preview.height);
    ctx.drawImage(image, 0, 0, preview.width, preview.height);

    // Dim whatever the grid does not cover, then outline the cells.
    ctx.save();
    ctx.fillStyle = 'rgba(20, 22, 28, 0.55)';
    ctx.fillRect(0, 0, preview.width, preview.height);
    ctx.globalCompositeOperation = 'destination-out';
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const { x, y } = framePixel(current, column, row);
        ctx.fillRect(
          x * scale,
          y * scale,
          current.frameWidth * scale,
          current.frameHeight * scale,
        );
      }
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(41, 173, 255, 0.9)';
    ctx.lineWidth = 1;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const { x, y } = framePixel(current, column, row);
        ctx.strokeRect(
          Math.round(x * scale) + 0.5,
          Math.round(y * scale) + 0.5,
          Math.round(current.frameWidth * scale) - 1,
          Math.round(current.frameHeight * scale) - 1,
        );
      }
    }

    const notes: string[] = [];
    if (count === 0) notes.push('the frame is bigger than the image');
    else if (count === 1) notes.push('one frame');
    else notes.push(`${count} frames · ${columns} × ${rows}`);

    notes.push(`${current.frameWidth}×${current.frameHeight} each`);

    const leftoverX = imageWidth - current.offsetX - columns * (current.frameWidth + current.spacingX) + current.spacingX;
    const leftoverY = imageHeight - current.offsetY - rows * (current.frameHeight + current.spacingY) + current.spacingY;
    if (count > 0 && (leftoverX > 0 || leftoverY > 0)) {
      notes.push(`${leftoverX}×${leftoverY} px left over`);
    }
    if (existing && (current.frameWidth !== existing.width || current.frameHeight !== existing.height)) {
      notes.push(`cropped to ${existing.width}×${existing.height} for ${existing.name}`);
    }

    readout.textContent = `${imageWidth}×${imageHeight} sheet — ${notes.join('  ·  ')}`;
    readout.classList.toggle('readout-warn', count === 0);
  };

  const applySlice = (slice: SliceOptions) => {
    fields.frameWidth.value = String(slice.frameWidth);
    fields.frameHeight.value = String(slice.frameHeight);
    fields.offsetX.value = String(slice.offsetX);
    fields.offsetY.value = String(slice.offsetY);
    fields.spacingX.value = String(slice.spacingX);
    fields.spacingY.value = String(slice.spacingY);
    update();
  };

  for (const field of Object.values(fields)) {
    field.addEventListener('input', update);
  }

  const pair = (label: string, a: HTMLInputElement, b: HTMLInputElement) =>
    el(
      'div',
      { class: 'field-row' },
      el('label', { class: 'field' }, el('span', { text: label }), a),
      el('label', { class: 'field' }, el('span', { text: '' }), b),
    );

  const body = el(
    'div',
    { class: 'modal-body import-body' },
    el('div', { class: 'import-preview-wrap' }, preview),
    readout,
    existing
      ? el('p', { class: 'muted small', text: `Frames will be added to ${existing.name}.` })
      : el('label', { class: 'field' }, el('span', { text: 'Name' }), nameInput),
    pair('Frame', fields.frameWidth, fields.frameHeight),
    pair('Margin', fields.offsetX, fields.offsetY),
    pair('Spacing', fields.spacingX, fields.spacingY),
    el(
      'div',
      { class: 'button-row' },
      el('button', {
        text: 'Detect grid',
        title: 'Measure the frame size from the blank pixels between frames',
        onclick: () => {
          const found = suggestSlice(image, imageWidth, imageHeight);
          applySlice(found.slice);
          if (!found.measured) {
            readout.textContent =
              `${imageWidth}×${imageHeight} sheet — nothing to measure: the frames are packed ` +
              'flush, so set the size yourself';
            readout.classList.add('readout-warn');
          }
        },
      }),
      el('button', { text: 'Whole image', onclick: () => applySlice(wholeImage(imageWidth, imageHeight)) }),
    ),
    error,
  );

  update();
  if (detected.measured && !existing) {
    readout.textContent += '  ·  grid detected';
  }

  for (;;) {
    if (!(await modal(existing ? 'Import frames' : 'Import sprite', body, 'Import'))) return null;

    const current = read();
    const { count } = sliceGrid(imageWidth, imageHeight, current);
    const name = existing ? existing.name : nameInput.value.trim();

    const problem = count === 0
      ? 'That frame size does not fit inside the image.'
      : existing
        ? undefined
        : validateAssetName(name) ??
          (request.taken?.(name) ? `A sprite called ${name} already exists.` : undefined);

    if (problem) {
      // Re-open with the message in place rather than dropping the work.
      error.textContent = problem;
      continue;
    }

    const frames = cutFrames(image, imageWidth, imageHeight, current);
    return {
      name,
      width: current.frameWidth,
      height: current.frameHeight,
      frames,
      palette: extractPalette(image, imageWidth, imageHeight),
    };
  }
}
