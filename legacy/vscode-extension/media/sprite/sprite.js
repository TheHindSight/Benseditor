// @ts-check
/**
 * Benseditor pixel art sprite editor.
 *
 * Frames are held as ImageData (exact pixel writes, no blending) with a canvas
 * mirror used for display, thumbnails and PNG encoding. Every committed change
 * posts the whole sprite back to the extension, which writes it to the text
 * document -- so VS Code's own undo stack is the undo stack.
 */
(function () {
  const vscode = acquireVsCodeApi();

  const svg = (d, extra = '') =>
    `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"${extra}>${d}</svg>`;

  const TOOLS = [
    { id: 'pencil', key: 'b', title: 'Pencil (B)', icon: svg('<path d="M2 14l1-3.5L10.5 3 13 5.5 5.5 13 2 14z"/>') },
    { id: 'eraser', key: 'e', title: 'Eraser (E)', icon: svg('<path d="M4 13h9"/><path d="M6.5 11.5L2.5 7.5 8 2l4 4-5.5 5.5z"/>') },
    { id: 'fill', key: 'g', title: 'Flood fill (G)', icon: svg('<path d="M6 2l6 6-5 5-6-6 5-5z"/><path d="M13.5 11c0 1-0.7 1.7-1.5 1.7S10.5 12 10.5 11 12 8.6 12 8.6 13.5 10 13.5 11z" fill="currentColor" stroke="none"/>') },
    { id: 'picker', key: 'i', title: 'Colour picker (I)', icon: svg('<path d="M11 2.5l2.5 2.5-7 7L3 13l1-3.5 7-7z"/><path d="M9.5 4l2.5 2.5"/>') },
    { id: 'line', key: 'l', title: 'Line (L)', icon: svg('<path d="M3 13L13 3"/>') },
    { id: 'rect', key: 'r', title: 'Rectangle (R) — hold Shift to fill', icon: svg('<rect x="2.5" y="3.5" width="11" height="9"/>') },
    { id: 'ellipse', key: 'c', title: 'Ellipse (C) — hold Shift to fill', icon: svg('<ellipse cx="8" cy="8" rx="5.5" ry="4.5"/>') },
    { id: 'move', key: 'm', title: 'Shift pixels (M)', icon: svg('<path d="M8 2v12M2 8h12M8 2L6 4M8 2l2 2M8 14l-2-2M8 14l2-2M2 8l2-2M2 8l2 2M14 8l-2-2M14 8l-2 2"/>') },
  ];

  const SIZES = [1, 2, 3, 4];

  /** @type {any} */
  const state = {
    sprite: null,
    /** @type {{canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, img: ImageData, dirty: boolean}[]} */
    frames: [],
    current: 0,
    tool: 'pencil',
    brush: 1,
    primary: '#000000',
    secondary: '#ffffff',
    zoom: 8,
    panX: 0,
    panY: 0,
    grid: false,
    onion: false,
    showOrigin: true,
    playing: false,
    lastSent: null,
  };

  /** In-progress stroke. */
  let stroke = null;
  let spaceDown = false;
  let panning = null;

  const $ = (id) => /** @type {any} */ (document.getElementById(id));

  const view = /** @type {HTMLCanvasElement} */ ($('view'));
  const vctx = /** @type {CanvasRenderingContext2D} */ (view.getContext('2d'));
  const preview = /** @type {HTMLCanvasElement} */ ($('preview'));
  const pctx = /** @type {CanvasRenderingContext2D} */ (preview.getContext('2d'));

  // ---- colour helpers -------------------------------------------------

  function hexToRgba(hex) {
    const h = hex.replace('#', '');
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
      255,
    ];
  }

  function rgbaToHex(r, g, b) {
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  // ---- frame helpers --------------------------------------------------

  function makeFrame(w, h) {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = /** @type {CanvasRenderingContext2D} */ (
      canvas.getContext('2d', { willReadFrequently: true })
    );
    return { canvas, ctx, img: ctx.createImageData(w, h), dirty: true };
  }

  function decodeFrame(b64, w, h) {
    return new Promise((resolve) => {
      const frame = makeFrame(w, h);
      const image = new Image();
      image.onload = () => {
        frame.ctx.drawImage(image, 0, 0);
        frame.img = frame.ctx.getImageData(0, 0, w, h);
        resolve(frame);
      };
      image.onerror = () => resolve(frame); // corrupt frame -> blank
      image.src = 'data:image/png;base64,' + b64;
    });
  }

  function flush(frame) {
    if (frame.dirty) {
      frame.ctx.putImageData(frame.img, 0, 0);
      frame.dirty = false;
    }
  }

  function encodeFrame(frame) {
    flush(frame);
    return frame.canvas.toDataURL('image/png').split(',')[1];
  }

  const currentFrame = () => state.frames[state.current];

  // ---- pixel operations ----------------------------------------------

  function setPixel(frame, x, y, rgba) {
    const { width: w, height: h } = state.sprite;
    if (x < 0 || y < 0 || x >= w || y >= h) {
      return;
    }
    const i = (y * w + x) * 4;
    const d = frame.img.data;
    d[i] = rgba[0];
    d[i + 1] = rgba[1];
    d[i + 2] = rgba[2];
    d[i + 3] = rgba[3];
    frame.dirty = true;
  }

  function getPixel(frame, x, y) {
    const { width: w, height: h } = state.sprite;
    if (x < 0 || y < 0 || x >= w || y >= h) {
      return [0, 0, 0, 0];
    }
    const i = (y * w + x) * 4;
    const d = frame.img.data;
    return [d[i], d[i + 1], d[i + 2], d[i + 3]];
  }

  /** Stamp the brush square centred on (x, y). */
  function stamp(frame, x, y, rgba) {
    const n = state.brush;
    const start = -Math.floor((n - 1) / 2);
    for (let dy = 0; dy < n; dy++) {
      for (let dx = 0; dx < n; dx++) {
        setPixel(frame, x + start + dx, y + start + dy, rgba);
      }
    }
  }

  function drawLine(frame, x0, y0, x1, y1, rgba, thick = true) {
    let dx = Math.abs(x1 - x0);
    let dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;

    for (;;) {
      if (thick) {
        stamp(frame, x0, y0, rgba);
      } else {
        setPixel(frame, x0, y0, rgba);
      }
      if (x0 === x1 && y0 === y1) {
        break;
      }
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

  function drawRect(frame, x0, y0, x1, y1, rgba, filled) {
    const [lo, hi] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [top, bot] = [Math.min(y0, y1), Math.max(y0, y1)];
    for (let y = top; y <= bot; y++) {
      for (let x = lo; x <= hi; x++) {
        if (filled || x === lo || x === hi || y === top || y === bot) {
          setPixel(frame, x, y, rgba);
        }
      }
    }
  }

  function drawEllipse(frame, x0, y0, x1, y1, rgba, filled) {
    const [lo, hi] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [top, bot] = [Math.min(y0, y1), Math.max(y0, y1)];
    const cx = (lo + hi) / 2;
    const cy = (top + bot) / 2;
    const rx = Math.max((hi - lo) / 2, 0.5);
    const ry = Math.max((bot - top) / 2, 0.5);

    const inside = (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

    for (let y = top; y <= bot; y++) {
      for (let x = lo; x <= hi; x++) {
        if (!inside(x, y)) {
          continue;
        }
        const edge =
          !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
        if (filled || edge) {
          setPixel(frame, x, y, rgba);
        }
      }
    }
  }

  function floodFill(frame, x, y, rgba) {
    const { width: w, height: h } = state.sprite;
    const target = getPixel(frame, x, y);
    if (target.every((v, i) => v === rgba[i])) {
      return;
    }

    const matches = (px, py) => {
      const p = getPixel(frame, px, py);
      return p.every((v, i) => v === target[i]);
    };

    const stack = [[x, y]];
    const seen = new Uint8Array(w * h);
    while (stack.length) {
      const [px, py] = stack.pop();
      if (px < 0 || py < 0 || px >= w || py >= h || seen[py * w + px]) {
        continue;
      }
      seen[py * w + px] = 1;
      if (!matches(px, py)) {
        continue;
      }
      setPixel(frame, px, py, rgba);
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
  }

  function shiftPixels(frame, snapshot, dx, dy) {
    const { width: w, height: h } = state.sprite;
    const d = frame.img.data;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const sx = x - dx;
        const sy = y - dy;
        const i = (y * w + x) * 4;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
          d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0;
        } else {
          const j = (sy * w + sx) * 4;
          d[i] = snapshot[j];
          d[i + 1] = snapshot[j + 1];
          d[i + 2] = snapshot[j + 2];
          d[i + 3] = snapshot[j + 3];
        }
      }
    }
    frame.dirty = true;
  }

  // ---- view transform -------------------------------------------------

  function screenToPixel(ev) {
    const rect = view.getBoundingClientRect();
    return {
      x: Math.floor((ev.clientX - rect.left - state.panX) / state.zoom),
      y: Math.floor((ev.clientY - rect.top - state.panY) / state.zoom),
    };
  }

  function fitView() {
    const rect = view.getBoundingClientRect();
    const { width: w, height: h } = state.sprite;
    const scale = Math.min((rect.width - 40) / w, (rect.height - 40) / h);
    state.zoom = Math.max(1, Math.min(48, Math.floor(scale)));
    state.panX = Math.round((rect.width - w * state.zoom) / 2);
    state.panY = Math.round((rect.height - h * state.zoom) / 2);
  }

  function zoomAt(clientX, clientY, factor) {
    const rect = view.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const next = Math.max(1, Math.min(64, state.zoom * factor));
    if (next === state.zoom) {
      return;
    }
    state.panX = px - ((px - state.panX) / state.zoom) * next;
    state.panY = py - ((py - state.panY) / state.zoom) * next;
    state.zoom = next;
    $('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
    render();
  }

  // ---- rendering ------------------------------------------------------

  function resizeView() {
    const rect = view.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    view.width = Math.max(1, Math.round(rect.width * dpr));
    view.height = Math.max(1, Math.round(rect.height * dpr));
    vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  function render() {
    if (!state.sprite) {
      return;
    }
    const { width: w, height: h } = state.sprite;
    const z = state.zoom;
    const rect = view.getBoundingClientRect();

    vctx.clearRect(0, 0, rect.width, rect.height);
    vctx.imageSmoothingEnabled = false;

    // Transparency checkerboard, clipped to the sprite bounds.
    const check = 8;
    vctx.save();
    vctx.beginPath();
    vctx.rect(state.panX, state.panY, w * z, h * z);
    vctx.clip();
    vctx.fillStyle = '#2b2b2b';
    vctx.fillRect(state.panX, state.panY, w * z, h * z);
    vctx.fillStyle = '#3a3a3a';
    for (let y = 0; y < Math.ceil((h * z) / check); y++) {
      for (let x = 0; x < Math.ceil((w * z) / check); x++) {
        if ((x + y) % 2 === 0) {
          vctx.fillRect(state.panX + x * check, state.panY + y * check, check, check);
        }
      }
    }
    vctx.restore();

    if (state.onion && state.frames.length > 1) {
      const prev = state.frames[(state.current - 1 + state.frames.length) % state.frames.length];
      flush(prev);
      vctx.globalAlpha = 0.3;
      vctx.drawImage(prev.canvas, state.panX, state.panY, w * z, h * z);
      vctx.globalAlpha = 1;
    }

    const frame = currentFrame();
    if (frame) {
      flush(frame);
      vctx.drawImage(frame.canvas, state.panX, state.panY, w * z, h * z);
    }

    if (state.grid && z >= 4) {
      vctx.strokeStyle = 'rgba(128,128,128,0.35)';
      vctx.lineWidth = 1;
      vctx.beginPath();
      for (let x = 0; x <= w; x++) {
        vctx.moveTo(state.panX + x * z + 0.5, state.panY);
        vctx.lineTo(state.panX + x * z + 0.5, state.panY + h * z);
      }
      for (let y = 0; y <= h; y++) {
        vctx.moveTo(state.panX, state.panY + y * z + 0.5);
        vctx.lineTo(state.panX + w * z, state.panY + y * z + 0.5);
      }
      vctx.stroke();
    }

    // Sprite border
    vctx.strokeStyle = 'rgba(160,160,160,0.8)';
    vctx.lineWidth = 1;
    vctx.strokeRect(state.panX - 0.5, state.panY - 0.5, w * z + 1, h * z + 1);

    if (state.showOrigin) {
      const ox = state.panX + state.sprite.originX * z;
      const oy = state.panY + state.sprite.originY * z;
      vctx.strokeStyle = '#ff004d';
      vctx.lineWidth = 1;
      vctx.beginPath();
      vctx.moveTo(ox - 7, oy + 0.5);
      vctx.lineTo(ox + 7, oy + 0.5);
      vctx.moveTo(ox + 0.5, oy - 7);
      vctx.lineTo(ox + 0.5, oy + 7);
      vctx.stroke();
    }
  }

  // ---- palette & toolbar ----------------------------------------------

  function buildToolbar() {
    const tools = $('tools');
    tools.innerHTML = '';
    for (const tool of TOOLS) {
      const button = document.createElement('button');
      button.innerHTML = tool.icon;
      button.title = tool.title;
      button.dataset.tool = tool.id;
      button.addEventListener('click', () => selectTool(tool.id));
      tools.appendChild(button);
    }

    const sizes = $('sizes');
    sizes.innerHTML = '';
    for (const size of SIZES) {
      const button = document.createElement('button');
      button.textContent = String(size);
      button.title = `Brush size ${size} ([ and ])`;
      button.dataset.size = String(size);
      button.addEventListener('click', () => {
        state.brush = size;
        syncToolbar();
      });
      sizes.appendChild(button);
    }
  }

  function selectTool(id) {
    state.tool = id;
    syncToolbar();
  }

  function syncToolbar() {
    for (const button of document.querySelectorAll('#tools button')) {
      button.classList.toggle('active', button.dataset.tool === state.tool);
    }
    for (const button of document.querySelectorAll('#sizes button')) {
      button.classList.toggle('active', Number(button.dataset.size) === state.brush);
    }
  }

  function buildPalette() {
    const palette = $('palette');
    palette.innerHTML = '';
    (state.sprite.palette || []).forEach((hex, index) => {
      const swatch = document.createElement('button');
      swatch.className = 'swatch';
      swatch.style.background = hex;
      swatch.title = `${hex} — click to pick, right-click to replace with primary, middle-click to remove`;
      swatch.classList.toggle('selected', hex.toLowerCase() === state.primary.toLowerCase());
      swatch.addEventListener('click', () => {
        state.primary = hex;
        $('primary').value = hex;
        buildPalette();
      });
      swatch.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        state.sprite.palette[index] = state.primary;
        buildPalette();
        commit();
      });
      swatch.addEventListener('auxclick', (ev) => {
        if (ev.button === 1) {
          state.sprite.palette.splice(index, 1);
          buildPalette();
          commit();
        }
      });
      palette.appendChild(swatch);
    });
  }

  // ---- frame strip ----------------------------------------------------

  function buildFrameStrip() {
    const strip = $('frame-strip');
    strip.innerHTML = '';
    const { width: w, height: h } = state.sprite;
    const scale = Math.max(1, Math.floor(Math.min(44 / w, 44 / h)) || 1);

    state.frames.forEach((frame, index) => {
      flush(frame);
      const button = document.createElement('button');
      button.className = 'frame' + (index === state.current ? ' selected' : '');
      button.title = `Frame ${index + 1}`;

      const thumb = document.createElement('canvas');
      thumb.width = w * scale;
      thumb.height = h * scale;
      const tctx = /** @type {CanvasRenderingContext2D} */ (thumb.getContext('2d'));
      tctx.imageSmoothingEnabled = false;
      tctx.fillStyle = '#2b2b2b';
      tctx.fillRect(0, 0, thumb.width, thumb.height);
      tctx.drawImage(frame.canvas, 0, 0, thumb.width, thumb.height);

      const label = document.createElement('span');
      label.className = 'index';
      label.textContent = String(index + 1);

      button.append(thumb, label);
      button.addEventListener('click', () => {
        state.current = index;
        buildFrameStrip();
        render();
      });
      strip.appendChild(button);
    });
  }

  // ---- animation preview ----------------------------------------------

  let previewFrame = 0;
  let previewClock = 0;

  function tickPreview(now) {
    requestAnimationFrame(tickPreview);
    if (!state.sprite || !state.frames.length) {
      return;
    }

    const { width: w, height: h } = state.sprite;
    const scale = Math.max(1, Math.floor(Math.min(72 / w, 72 / h)) || 1);
    if (preview.width !== w * scale) {
      preview.width = w * scale;
      preview.height = h * scale;
    }

    if (state.playing) {
      const interval = 1000 / Math.max(1, state.sprite.fps);
      if (now - previewClock >= interval) {
        previewClock = now;
        previewFrame = (previewFrame + 1) % state.frames.length;
      }
    } else {
      previewFrame = state.current;
    }

    const frame = state.frames[Math.min(previewFrame, state.frames.length - 1)];
    flush(frame);
    pctx.imageSmoothingEnabled = false;
    pctx.clearRect(0, 0, preview.width, preview.height);
    pctx.drawImage(frame.canvas, 0, 0, preview.width, preview.height);
  }
  requestAnimationFrame(tickPreview);

  // ---- persistence ----------------------------------------------------

  function commit() {
    state.sprite.frames = state.frames.map(encodeFrame);
    state.lastSent = JSON.stringify(state.sprite);
    vscode.postMessage({ type: 'update', sprite: state.sprite });
    buildFrameStrip();
  }

  async function load(sprite) {
    const incoming = JSON.stringify(sprite);
    if (incoming === state.lastSent) {
      return; // echo of our own write
    }
    state.lastSent = incoming;

    const first = !state.sprite;
    const resized =
      state.sprite && (state.sprite.width !== sprite.width || state.sprite.height !== sprite.height);
    state.sprite = sprite;

    state.frames = await Promise.all(
      (sprite.frames.length ? sprite.frames : ['']).map((b64) =>
        decodeFrame(b64, sprite.width, sprite.height),
      ),
    );
    state.current = Math.min(state.current, state.frames.length - 1);

    $('sprite-name').textContent = sprite.name;
    $('sprite-size').textContent = `${sprite.width} × ${sprite.height}`;
    $('origin-x').value = sprite.originX;
    $('origin-y').value = sprite.originY;
    $('fps').value = sprite.fps;
    $('collision-mode').value = sprite.collision.mode;
    $('col-left').value = sprite.collision.left;
    $('col-top').value = sprite.collision.top;
    $('col-right').value = sprite.collision.right;
    $('col-bottom').value = sprite.collision.bottom;

    if (first || resized) {
      fitView();
      $('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
    }
    buildPalette();
    buildFrameStrip();
    render();
  }

  // ---- pointer input --------------------------------------------------

  function beginStroke(ev) {
    const frame = currentFrame();
    const { x, y } = screenToPixel(ev);
    const erasing = state.tool === 'eraser';
    const colour = erasing
      ? [0, 0, 0, 0]
      : hexToRgba(ev.button === 2 ? state.secondary : state.primary);

    if (ev.altKey) {
      setOrigin(x, y);
      return;
    }

    if (state.tool === 'picker') {
      const [r, g, b, a] = getPixel(frame, x, y);
      if (a > 0) {
        const hex = rgbaToHex(r, g, b);
        if (ev.button === 2) {
          state.secondary = hex;
          $('secondary').value = hex;
        } else {
          state.primary = hex;
          $('primary').value = hex;
        }
        buildPalette();
      }
      return;
    }

    stroke = {
      startX: x,
      startY: y,
      lastX: x,
      lastY: y,
      colour,
      snapshot: new Uint8ClampedArray(frame.img.data),
    };

    if (state.tool === 'pencil' || state.tool === 'eraser') {
      stamp(frame, x, y, colour);
    } else if (state.tool === 'fill') {
      floodFill(frame, x, y, colour);
    }
    render();
  }

  function moveStroke(ev) {
    const frame = currentFrame();
    const { x, y } = screenToPixel(ev);
    $('pos').textContent = `${x}, ${y}`;

    if (!stroke) {
      return;
    }

    switch (state.tool) {
      case 'pencil':
      case 'eraser':
        drawLine(frame, stroke.lastX, stroke.lastY, x, y, stroke.colour);
        break;
      case 'line':
        frame.img.data.set(stroke.snapshot);
        frame.dirty = true;
        drawLine(frame, stroke.startX, stroke.startY, x, y, stroke.colour);
        break;
      case 'rect':
        frame.img.data.set(stroke.snapshot);
        frame.dirty = true;
        drawRect(frame, stroke.startX, stroke.startY, x, y, stroke.colour, ev.shiftKey);
        break;
      case 'ellipse':
        frame.img.data.set(stroke.snapshot);
        frame.dirty = true;
        drawEllipse(frame, stroke.startX, stroke.startY, x, y, stroke.colour, ev.shiftKey);
        break;
      case 'move':
        shiftPixels(frame, stroke.snapshot, x - stroke.startX, y - stroke.startY);
        break;
    }

    stroke.lastX = x;
    stroke.lastY = y;
    render();
  }

  function endStroke() {
    if (!stroke) {
      return;
    }
    stroke = null;
    commit();
  }

  view.addEventListener('pointerdown', (ev) => {
    view.setPointerCapture(ev.pointerId);
    if (ev.button === 1 || spaceDown) {
      panning = { x: ev.clientX - state.panX, y: ev.clientY - state.panY };
      ev.preventDefault();
      return;
    }
    if (ev.button === 0 || ev.button === 2) {
      beginStroke(ev);
    }
  });

  view.addEventListener('pointermove', (ev) => {
    if (panning) {
      state.panX = ev.clientX - panning.x;
      state.panY = ev.clientY - panning.y;
      render();
      return;
    }
    moveStroke(ev);
  });

  const releasePointer = () => {
    panning = null;
    endStroke();
  };
  view.addEventListener('pointerup', releasePointer);
  view.addEventListener('pointercancel', releasePointer);
  view.addEventListener('pointerleave', () => {
    if (!stroke && !panning) {
      $('pos').textContent = '–, –';
    }
  });

  view.addEventListener('contextmenu', (ev) => ev.preventDefault());

  view.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.15 : 1 / 1.15);
    },
    { passive: false },
  );

  // ---- sidebar controls -----------------------------------------------

  function setOrigin(x, y) {
    state.sprite.originX = x;
    state.sprite.originY = y;
    $('origin-x').value = x;
    $('origin-y').value = y;
    render();
    commit();
  }

  $('origin-x').addEventListener('change', (ev) =>
    setOrigin(Number(ev.target.value) | 0, state.sprite.originY),
  );
  $('origin-y').addEventListener('change', (ev) =>
    setOrigin(state.sprite.originX, Number(ev.target.value) | 0),
  );

  for (const button of document.querySelectorAll('[data-origin]')) {
    button.addEventListener('click', () => {
      const { width: w, height: h } = state.sprite;
      const presets = {
        topleft: [0, 0],
        center: [Math.floor(w / 2), Math.floor(h / 2)],
        bottom: [Math.floor(w / 2), h - 1],
      };
      const [x, y] = presets[button.dataset.origin];
      setOrigin(x, y);
    });
  }

  $('fps').addEventListener('change', (ev) => {
    state.sprite.fps = Math.max(1, Number(ev.target.value) | 0);
    commit();
  });

  $('play').addEventListener('click', () => {
    state.playing = !state.playing;
    $('play').textContent = state.playing ? '⏸ Pause' : '▶ Play';
  });

  for (const id of ['collision-mode', 'col-left', 'col-top', 'col-right', 'col-bottom']) {
    $(id).addEventListener('change', () => {
      state.sprite.collision = {
        mode: $('collision-mode').value,
        left: Number($('col-left').value) | 0,
        top: Number($('col-top').value) | 0,
        right: Number($('col-right').value) | 0,
        bottom: Number($('col-bottom').value) | 0,
      };
      commit();
    });
  }

  $('col-auto').addEventListener('click', () => {
    const { width: w, height: h } = state.sprite;
    let left = w;
    let top = h;
    let right = -1;
    let bottom = -1;
    for (const frame of state.frames) {
      const d = frame.img.data;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (d[(y * w + x) * 4 + 3] > 0) {
            left = Math.min(left, x);
            top = Math.min(top, y);
            right = Math.max(right, x);
            bottom = Math.max(bottom, y);
          }
        }
      }
    }
    if (right < 0) {
      [left, top, right, bottom] = [0, 0, w - 1, h - 1];
    }
    state.sprite.collision = { mode: state.sprite.collision.mode, left, top, right, bottom };
    $('col-left').value = left;
    $('col-top').value = top;
    $('col-right').value = right;
    $('col-bottom').value = bottom;
    commit();
  });

  $('primary').addEventListener('input', (ev) => {
    state.primary = ev.target.value;
    buildPalette();
  });
  $('secondary').addEventListener('input', (ev) => {
    state.secondary = ev.target.value;
  });
  $('add-swatch').addEventListener('click', () => {
    if (!state.sprite.palette.includes(state.primary)) {
      state.sprite.palette.push(state.primary);
      buildPalette();
      commit();
    }
  });

  $('show-grid').addEventListener('change', (ev) => {
    state.grid = ev.target.checked;
    render();
  });
  $('show-onion').addEventListener('change', (ev) => {
    state.onion = ev.target.checked;
    render();
  });
  $('show-origin').addEventListener('change', (ev) => {
    state.showOrigin = ev.target.checked;
    render();
  });

  // ---- frame actions ---------------------------------------------------

  $('frame-add').addEventListener('click', () => {
    state.frames.splice(
      state.current + 1,
      0,
      makeFrame(state.sprite.width, state.sprite.height),
    );
    state.current++;
    commit();
    render();
  });

  $('frame-dup').addEventListener('click', () => {
    const source = currentFrame();
    const copy = makeFrame(state.sprite.width, state.sprite.height);
    copy.img.data.set(source.img.data);
    state.frames.splice(state.current + 1, 0, copy);
    state.current++;
    commit();
    render();
  });

  $('frame-del').addEventListener('click', () => {
    if (state.frames.length <= 1) {
      return;
    }
    state.frames.splice(state.current, 1);
    state.current = Math.max(0, state.current - 1);
    commit();
    render();
  });

  const moveFrame = (delta) => {
    const target = state.current + delta;
    if (target < 0 || target >= state.frames.length) {
      return;
    }
    const [frame] = state.frames.splice(state.current, 1);
    state.frames.splice(target, 0, frame);
    state.current = target;
    commit();
  };
  $('frame-left').addEventListener('click', () => moveFrame(-1));
  $('frame-right').addEventListener('click', () => moveFrame(1));

  // ---- resize dialog ---------------------------------------------------

  $('resize').addEventListener('click', () => showResizeDialog());

  function showResizeDialog() {
    const backdrop = document.createElement('div');
    backdrop.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:grid;place-items:center;z-index:30';
    const box = document.createElement('div');
    box.style.cssText =
      'background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:14px;display:flex;flex-direction:column;gap:10px;min-width:220px';
    box.innerHTML = `
      <h2 style="margin:0">Resize canvas</h2>
      <div class="row"><label>W</label><input type="number" id="rz-w" min="1" max="1024" value="${state.sprite.width}">
      <label>H</label><input type="number" id="rz-h" min="1" max="1024" value="${state.sprite.height}"></div>
      <div class="row"><label style="grid-column:span 1">Anchor</label>
        <select id="rz-anchor" style="grid-column:span 3">
          <option value="topleft">Top left</option>
          <option value="center" selected>Centre</option>
        </select></div>
      <div class="button-row"><button id="rz-cancel">Cancel</button><button id="rz-ok">Resize</button></div>`;
    backdrop.appendChild(box);
    document.body.appendChild(backdrop);

    const close = () => backdrop.remove();
    box.querySelector('#rz-cancel').addEventListener('click', close);
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) {
        close();
      }
    });

    box.querySelector('#rz-ok').addEventListener('click', () => {
      const w = Math.max(1, Math.min(1024, Number(box.querySelector('#rz-w').value) | 0));
      const h = Math.max(1, Math.min(1024, Number(box.querySelector('#rz-h').value) | 0));
      const centred = box.querySelector('#rz-anchor').value === 'center';
      resizeSprite(w, h, centred);
      close();
    });
  }

  function resizeSprite(w, h, centred) {
    const ow = state.sprite.width;
    const oh = state.sprite.height;
    const dx = centred ? Math.floor((w - ow) / 2) : 0;
    const dy = centred ? Math.floor((h - oh) / 2) : 0;

    state.frames = state.frames.map((old) => {
      const next = makeFrame(w, h);
      for (let y = 0; y < oh; y++) {
        for (let x = 0; x < ow; x++) {
          const tx = x + dx;
          const ty = y + dy;
          if (tx < 0 || ty < 0 || tx >= w || ty >= h) {
            continue;
          }
          const s = (y * ow + x) * 4;
          const t = (ty * w + tx) * 4;
          next.img.data[t] = old.img.data[s];
          next.img.data[t + 1] = old.img.data[s + 1];
          next.img.data[t + 2] = old.img.data[s + 2];
          next.img.data[t + 3] = old.img.data[s + 3];
        }
      }
      return next;
    });

    state.sprite.width = w;
    state.sprite.height = h;
    state.sprite.originX = Math.max(0, Math.min(w - 1, state.sprite.originX + dx));
    state.sprite.originY = Math.max(0, Math.min(h - 1, state.sprite.originY + dy));
    state.sprite.collision = { mode: state.sprite.collision.mode, left: 0, top: 0, right: w - 1, bottom: h - 1 };

    $('sprite-size').textContent = `${w} × ${h}`;
    $('col-left').value = 0;
    $('col-top').value = 0;
    $('col-right').value = w - 1;
    $('col-bottom').value = h - 1;
    $('origin-x').value = state.sprite.originX;
    $('origin-y').value = state.sprite.originY;

    fitView();
    commit();
    render();
  }

  // ---- keyboard --------------------------------------------------------

  window.addEventListener('keydown', (ev) => {
    const target = /** @type {HTMLElement} */ (ev.target);
    if (target && /INPUT|SELECT|TEXTAREA/.test(target.tagName)) {
      return;
    }

    if (ev.ctrlKey || ev.metaKey) {
      const key = ev.key.toLowerCase();
      if (key === 'z') {
        ev.preventDefault();
        vscode.postMessage({ type: ev.shiftKey ? 'redo' : 'undo' });
      } else if (key === 'y') {
        ev.preventDefault();
        vscode.postMessage({ type: 'redo' });
      } else if (key === 's') {
        ev.preventDefault();
        vscode.postMessage({ type: 'save' });
      }
      return;
    }

    if (ev.key === ' ') {
      spaceDown = true;
      view.style.cursor = 'grab';
      ev.preventDefault();
      return;
    }

    const tool = TOOLS.find((t) => t.key === ev.key.toLowerCase());
    if (tool) {
      selectTool(tool.id);
      return;
    }

    switch (ev.key) {
      case '[':
        state.brush = Math.max(1, state.brush - 1);
        syncToolbar();
        break;
      case ']':
        state.brush = Math.min(SIZES.length, state.brush + 1);
        syncToolbar();
        break;
      case ',':
        state.current = (state.current - 1 + state.frames.length) % state.frames.length;
        buildFrameStrip();
        render();
        break;
      case '.':
        state.current = (state.current + 1) % state.frames.length;
        buildFrameStrip();
        render();
        break;
      case 'x': {
        const swap = state.primary;
        state.primary = state.secondary;
        state.secondary = swap;
        $('primary').value = state.primary;
        $('secondary').value = state.secondary;
        buildPalette();
        break;
      }
      case '0':
        fitView();
        $('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
        render();
        break;
    }
  });

  window.addEventListener('keyup', (ev) => {
    if (ev.key === ' ') {
      spaceDown = false;
      view.style.cursor = 'crosshair';
    }
  });

  // ---- messages --------------------------------------------------------

  window.addEventListener('message', (ev) => {
    const message = ev.data;
    if (message.type === 'load') {
      load(message.sprite);
    } else if (message.type === 'error') {
      showBanner(message.message);
    }
  });

  function showBanner(text) {
    let banner = document.getElementById('banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'banner';
      document.body.appendChild(banner);
    }
    banner.textContent = text;
    setTimeout(() => banner && banner.remove(), 6000);
  }

  new ResizeObserver(resizeView).observe($('canvas-wrap'));

  buildToolbar();
  syncToolbar();
  $('primary').value = state.primary;
  $('secondary').value = state.secondary;
  vscode.postMessage({ type: 'ready' });
})();
