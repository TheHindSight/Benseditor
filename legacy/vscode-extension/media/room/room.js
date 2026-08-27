// @ts-check
/**
 * Benseditor room editor: place object instances on a room canvas.
 *
 * Mirrors GameMaker's room editor -- pick an object on the left, click to
 * place, drag to move, right-click to remove. Depth ordering matches the
 * runtime (higher depth draws further back).
 */
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {any} */
  const state = {
    room: null,
    objects: [],
    /** @type {Record<string, any>} */
    sprites: {},
    /** @type {Record<string, HTMLImageElement>} */
    images: {},
    placing: null,
    selected: null,
    zoom: 1,
    panX: 20,
    panY: 20,
    snap: true,
    grid: true,
    lastSent: null,
  };

  let drag = null;
  let panning = null;
  let spaceDown = false;

  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  const view = /** @type {HTMLCanvasElement} */ ($('view'));
  const vctx = /** @type {CanvasRenderingContext2D} */ (view.getContext('2d'));

  const objectByName = (name) => state.objects.find((o) => o.name === name);

  function spriteFor(objectName) {
    const object = objectByName(objectName);
    return object && object.sprite ? state.sprites[object.sprite] : undefined;
  }

  // ---- geometry --------------------------------------------------------

  function screenToRoom(ev) {
    const rect = view.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left - state.panX) / state.zoom,
      y: (ev.clientY - rect.top - state.panY) / state.zoom,
    };
  }

  function snapPoint(x, y) {
    if (!state.snap) {
      return { x: Math.round(x), y: Math.round(y) };
    }
    const gw = Math.max(1, state.room.gridWidth || 16);
    const gh = Math.max(1, state.room.gridHeight || 16);
    return { x: Math.round(x / gw) * gw, y: Math.round(y / gh) * gh };
  }

  /** Axis-aligned bounds of an instance in room space. */
  function bounds(inst) {
    const sprite = spriteFor(inst.object);
    if (!sprite) {
      return { left: inst.x - 8, top: inst.y - 8, right: inst.x + 8, bottom: inst.y + 8 };
    }
    const w = sprite.width * inst.xscale;
    const h = sprite.height * inst.yscale;
    const left = inst.x - sprite.originX * inst.xscale;
    const top = inst.y - sprite.originY * inst.yscale;
    return { left, top, right: left + w, bottom: top + h };
  }

  function instanceAt(x, y) {
    // Topmost first: lowest depth wins, then latest placed.
    const sorted = [...state.room.instances].sort(
      (a, b) => depthOf(a) - depthOf(b) || state.room.instances.indexOf(b) - state.room.instances.indexOf(a),
    );
    return sorted.find((inst) => {
      const b = bounds(inst);
      return x >= b.left && x <= b.right && y >= b.top && y <= b.bottom;
    });
  }

  const depthOf = (inst) => {
    const object = objectByName(inst.object);
    return object ? object.depth : 0;
  };

  // ---- rendering -------------------------------------------------------

  function resizeView() {
    const rect = view.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    view.width = Math.max(1, Math.round(rect.width * dpr));
    view.height = Math.max(1, Math.round(rect.height * dpr));
    vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }

  function render() {
    if (!state.room) {
      return;
    }
    const rect = view.getBoundingClientRect();
    const { width: w, height: h } = state.room;
    const z = state.zoom;

    vctx.clearRect(0, 0, rect.width, rect.height);
    vctx.imageSmoothingEnabled = false;

    vctx.fillStyle = state.room.backgroundColor || '#000000';
    vctx.fillRect(state.panX, state.panY, w * z, h * z);

    if (state.grid) {
      const gw = Math.max(1, state.room.gridWidth || 16) * z;
      const gh = Math.max(1, state.room.gridHeight || 16) * z;
      if (gw >= 4 && gh >= 4) {
        vctx.strokeStyle = 'rgba(255,255,255,0.12)';
        vctx.lineWidth = 1;
        vctx.beginPath();
        for (let x = 0; x <= w * z; x += gw) {
          vctx.moveTo(state.panX + x + 0.5, state.panY);
          vctx.lineTo(state.panX + x + 0.5, state.panY + h * z);
        }
        for (let y = 0; y <= h * z; y += gh) {
          vctx.moveTo(state.panX, state.panY + y + 0.5);
          vctx.lineTo(state.panX + w * z, state.panY + y + 0.5);
        }
        vctx.stroke();
      }
    }

    // Painter's order: larger depth is further back.
    const ordered = [...state.room.instances].sort((a, b) => depthOf(b) - depthOf(a));
    for (const inst of ordered) {
      drawInstance(inst);
    }

    if (state.selected) {
      const inst = state.room.instances.find((i) => i.id === state.selected);
      if (inst) {
        const b = bounds(inst);
        vctx.strokeStyle = '#29adff';
        vctx.lineWidth = 1;
        vctx.setLineDash([4, 3]);
        vctx.strokeRect(
          state.panX + b.left * z - 0.5,
          state.panY + b.top * z - 0.5,
          (b.right - b.left) * z + 1,
          (b.bottom - b.top) * z + 1,
        );
        vctx.setLineDash([]);
      }
    }

    vctx.strokeStyle = 'rgba(200,200,200,0.9)';
    vctx.lineWidth = 1;
    vctx.strokeRect(state.panX - 0.5, state.panY - 0.5, w * z + 1, h * z + 1);
  }

  function drawInstance(inst) {
    const z = state.zoom;
    const sprite = spriteFor(inst.object);
    const image = sprite ? state.images[objectByName(inst.object).sprite] : undefined;

    vctx.save();
    vctx.translate(state.panX + inst.x * z, state.panY + inst.y * z);
    vctx.rotate((-(inst.angle || 0) * Math.PI) / 180);
    vctx.scale(inst.xscale * z, inst.yscale * z);

    if (sprite && image && image.complete && image.naturalWidth) {
      vctx.drawImage(image, -sprite.originX, -sprite.originY);
    } else {
      // Objects with no sprite still need a visible, clickable footprint.
      vctx.fillStyle = 'rgba(255,119,168,0.35)';
      vctx.fillRect(-8, -8, 16, 16);
      vctx.strokeStyle = '#ff77a8';
      vctx.lineWidth = 1 / (inst.xscale * z || 1);
      vctx.strokeRect(-8, -8, 16, 16);
    }
    vctx.restore();
  }

  // ---- object palette --------------------------------------------------

  function buildObjectList() {
    const list = $('object-list');
    list.innerHTML = '';

    if (!state.objects.length) {
      const note = document.createElement('div');
      note.className = 'empty-note';
      note.textContent = 'No objects yet. Create one from the Benseditor Assets panel.';
      list.appendChild(note);
      return;
    }

    for (const object of state.objects) {
      const entry = document.createElement('button');
      entry.className = 'object-entry' + (state.placing === object.name ? ' selected' : '');
      entry.title = object.sprite ? `${object.name} (${object.sprite})` : object.name;

      const thumb = document.createElement('canvas');
      thumb.width = 22;
      thumb.height = 22;
      const tctx = /** @type {CanvasRenderingContext2D} */ (thumb.getContext('2d'));
      tctx.imageSmoothingEnabled = false;
      const sprite = object.sprite ? state.sprites[object.sprite] : undefined;
      const image = object.sprite ? state.images[object.sprite] : undefined;
      if (sprite && image && image.complete && image.naturalWidth) {
        const scale = Math.min(22 / sprite.width, 22 / sprite.height);
        const dw = sprite.width * scale;
        const dh = sprite.height * scale;
        tctx.drawImage(image, (22 - dw) / 2, (22 - dh) / 2, dw, dh);
      } else {
        tctx.fillStyle = 'rgba(255,119,168,0.4)';
        tctx.fillRect(4, 4, 14, 14);
      }

      const label = document.createElement('span');
      label.textContent = object.name;

      entry.append(thumb, label);
      entry.addEventListener('click', () => {
        state.placing = state.placing === object.name ? null : object.name;
        buildObjectList();
      });
      list.appendChild(entry);
    }
  }

  function loadImages() {
    for (const [name, sprite] of Object.entries(state.sprites)) {
      if (!sprite.thumb) {
        continue;
      }
      const image = new Image();
      image.onload = () => {
        render();
        buildObjectList();
      };
      image.src = 'data:image/png;base64,' + sprite.thumb;
      state.images[name] = image;
    }
  }

  // ---- persistence -----------------------------------------------------

  function commit() {
    state.lastSent = JSON.stringify(state.room);
    vscode.postMessage({ type: 'update', room: state.room });
    $('instance-count').textContent = `${state.room.instances.length} placed`;
  }

  function load(room) {
    const incoming = JSON.stringify(room);
    if (incoming === state.lastSent) {
      return;
    }
    state.lastSent = incoming;

    const first = !state.room;
    state.room = room;
    if (!state.room.instances) {
      state.room.instances = [];
    }

    $('room-name').textContent = room.name;
    $('room-w').value = room.width;
    $('room-h').value = room.height;
    $('grid-w').value = room.gridWidth ?? 16;
    $('grid-h').value = room.gridHeight ?? 16;
    $('room-bg').value = room.backgroundColor || '#000000';
    $('instance-count').textContent = `${room.instances.length} placed`;

    if (state.selected && !room.instances.some((i) => i.id === state.selected)) {
      state.selected = null;
    }
    syncInstancePanel();

    if (first) {
      fitView();
    }
    render();
  }

  function fitView() {
    const rect = view.getBoundingClientRect();
    const scale = Math.min(
      (rect.width - 40) / state.room.width,
      (rect.height - 40) / state.room.height,
    );
    state.zoom = Math.max(0.1, Math.min(8, scale));
    state.panX = Math.round((rect.width - state.room.width * state.zoom) / 2);
    state.panY = Math.round((rect.height - state.room.height * state.zoom) / 2);
    $('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
  }

  // ---- instance panel --------------------------------------------------

  function selectedInstance() {
    return state.room.instances.find((i) => i.id === state.selected);
  }

  function syncInstancePanel() {
    const inst = state.selected ? selectedInstance() : null;
    $('instance-panel').hidden = !inst;
    if (!inst) {
      return;
    }
    $('inst-object').textContent = inst.object;
    $('inst-x').value = inst.x;
    $('inst-y').value = inst.y;
    $('inst-xs').value = inst.xscale;
    $('inst-ys').value = inst.yscale;
    $('inst-angle').value = inst.angle;
  }

  for (const [id, key, parse] of /** @type {[string,string,(v:string)=>number][]} */ ([
    ['inst-x', 'x', Number],
    ['inst-y', 'y', Number],
    ['inst-xs', 'xscale', Number],
    ['inst-ys', 'yscale', Number],
    ['inst-angle', 'angle', Number],
  ])) {
    $(id).addEventListener('change', (ev) => {
      const inst = selectedInstance();
      if (!inst) {
        return;
      }
      const value = parse(ev.target.value);
      inst[key] = Number.isFinite(value) ? value : inst[key];
      render();
      commit();
    });
  }

  $('inst-delete').addEventListener('click', () => deleteSelected());
  $('inst-edit').addEventListener('click', () => {
    const inst = selectedInstance();
    if (inst) {
      vscode.postMessage({ type: 'openObject', name: inst.object });
    }
  });

  function deleteSelected() {
    if (!state.selected) {
      return;
    }
    state.room.instances = state.room.instances.filter((i) => i.id !== state.selected);
    state.selected = null;
    syncInstancePanel();
    render();
    commit();
  }

  // ---- room properties -------------------------------------------------

  for (const [id, key] of [
    ['room-w', 'width'],
    ['room-h', 'height'],
    ['grid-w', 'gridWidth'],
    ['grid-h', 'gridHeight'],
  ]) {
    $(id).addEventListener('change', (ev) => {
      const value = Math.max(1, Number(ev.target.value) | 0);
      state.room[key] = value;
      ev.target.value = value;
      render();
      commit();
    });
  }

  $('room-bg').addEventListener('input', (ev) => {
    state.room.backgroundColor = ev.target.value;
    render();
  });
  $('room-bg').addEventListener('change', () => commit());

  $('clear-room').addEventListener('click', () => {
    if (!state.room.instances.length) {
      return;
    }
    state.room.instances = [];
    state.selected = null;
    syncInstancePanel();
    render();
    commit();
  });

  $('snap').addEventListener('change', (ev) => {
    state.snap = ev.target.checked;
  });
  $('show-grid').addEventListener('change', (ev) => {
    state.grid = ev.target.checked;
    render();
  });

  // ---- pointer input ---------------------------------------------------

  function nextInstanceId() {
    let max = 0;
    for (const inst of state.room.instances) {
      const match = /^inst_(\d+)$/.exec(inst.id || '');
      if (match) {
        max = Math.max(max, Number(match[1]));
      }
    }
    return `inst_${max + 1}`;
  }

  view.addEventListener('pointerdown', (ev) => {
    if (!state.room) {
      return;
    }
    view.setPointerCapture(ev.pointerId);

    if (ev.button === 1 || spaceDown) {
      panning = { x: ev.clientX - state.panX, y: ev.clientY - state.panY };
      ev.preventDefault();
      return;
    }

    const point = screenToRoom(ev);
    const hit = instanceAt(point.x, point.y);

    if (ev.button === 2) {
      if (hit) {
        state.room.instances = state.room.instances.filter((i) => i !== hit);
        if (state.selected === hit.id) {
          state.selected = null;
        }
        syncInstancePanel();
        render();
        commit();
      }
      return;
    }

    if (hit) {
      state.selected = hit.id;
      drag = { inst: hit, offsetX: point.x - hit.x, offsetY: point.y - hit.y, moved: false };
      syncInstancePanel();
      render();
      return;
    }

    if (state.placing) {
      const { x, y } = snapPoint(point.x, point.y);
      const inst = {
        id: nextInstanceId(),
        object: state.placing,
        x,
        y,
        xscale: 1,
        yscale: 1,
        angle: 0,
      };
      state.room.instances.push(inst);
      state.selected = inst.id;
      drag = { inst, offsetX: 0, offsetY: 0, moved: true };
      syncInstancePanel();
      render();
      return;
    }

    state.selected = null;
    syncInstancePanel();
    render();
  });

  view.addEventListener('pointermove', (ev) => {
    if (panning) {
      state.panX = ev.clientX - panning.x;
      state.panY = ev.clientY - panning.y;
      render();
      return;
    }

    const point = screenToRoom(ev);
    $('pos').textContent = `${Math.round(point.x)}, ${Math.round(point.y)}`;

    if (drag) {
      const { x, y } = snapPoint(point.x - drag.offsetX, point.y - drag.offsetY);
      if (x !== drag.inst.x || y !== drag.inst.y) {
        drag.inst.x = x;
        drag.inst.y = y;
        drag.moved = true;
        syncInstancePanel();
        render();
      }
    }
  });

  const release = () => {
    panning = null;
    if (drag) {
      if (drag.moved) {
        commit();
      }
      drag = null;
    }
  };
  view.addEventListener('pointerup', release);
  view.addEventListener('pointercancel', release);

  view.addEventListener('contextmenu', (ev) => ev.preventDefault());

  view.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault();
      const rect = view.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const factor = ev.deltaY < 0 ? 1.15 : 1 / 1.15;
      const next = Math.max(0.1, Math.min(16, state.zoom * factor));
      state.panX = px - ((px - state.panX) / state.zoom) * next;
      state.panY = py - ((py - state.panY) / state.zoom) * next;
      state.zoom = next;
      $('zoom-label').textContent = Math.round(state.zoom * 100) + '%';
      render();
    },
    { passive: false },
  );

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
    } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
      deleteSelected();
    } else if (ev.key === 'Escape') {
      state.placing = null;
      state.selected = null;
      buildObjectList();
      syncInstancePanel();
      render();
    } else if (ev.key === '0') {
      fitView();
      render();
    }
  });

  window.addEventListener('keyup', (ev) => {
    if (ev.key === ' ') {
      spaceDown = false;
      view.style.cursor = 'default';
    }
  });

  // ---- messages --------------------------------------------------------

  window.addEventListener('message', (ev) => {
    const message = ev.data;
    if (message.type === 'load') {
      load(message.room);
    } else if (message.type === 'resources') {
      state.objects = message.objects;
      state.sprites = message.sprites;
      loadImages();
      buildObjectList();
      render();
    } else if (message.type === 'error') {
      let banner = document.getElementById('banner');
      if (!banner) {
        banner = document.createElement('div');
        banner.id = 'banner';
        document.body.appendChild(banner);
      }
      banner.textContent = message.message;
      setTimeout(() => banner && banner.remove(), 6000);
    }
  });

  new ResizeObserver(resizeView).observe($('canvas-wrap'));
  vscode.postMessage({ type: 'ready' });
})();
