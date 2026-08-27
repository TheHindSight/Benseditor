// @ts-check
/** Benseditor object editor: properties plus the object's event checklist. */
(function () {
  const vscode = acquireVsCodeApi();

  /** @type {any} */
  const state = { object: null, events: [], defined: [], sprites: {}, objects: [], lastSent: null };

  const $ = (id) => /** @type {any} */ (document.getElementById(id));
  const preview = /** @type {HTMLCanvasElement} */ ($('preview'));
  const pctx = /** @type {CanvasRenderingContext2D} */ (preview.getContext('2d'));

  function commit() {
    state.lastSent = JSON.stringify(state.object);
    vscode.postMessage({ type: 'update', object: state.object });
  }

  function load(message) {
    const incoming = JSON.stringify(message.object);
    const sameObject = incoming === state.lastSent;
    state.lastSent = incoming;
    state.events = message.events;
    state.defined = message.defined;

    if (!sameObject) {
      state.object = message.object;
      $('obj-name').textContent = state.object.name;
      $('obj-depth').value = state.object.depth;
      $('obj-visible').checked = !!state.object.visible;
      $('obj-solid').checked = !!state.object.solid;
      $('obj-persistent').checked = !!state.object.persistent;
      buildSelects();
      drawPreview();
    }
    buildEvents();
  }

  function buildSelects() {
    if (!state.object) {
      return;
    }

    const spriteSelect = $('obj-sprite');
    spriteSelect.innerHTML = '<option value="">(no sprite)</option>';
    for (const name of Object.keys(state.sprites).sort()) {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      spriteSelect.appendChild(option);
    }
    spriteSelect.value = state.object.sprite || '';

    const parentSelect = $('obj-parent');
    parentSelect.innerHTML = '<option value="">(no parent)</option>';
    for (const object of state.objects) {
      if (object.name === state.object.name) {
        continue;
      }
      const option = document.createElement('option');
      option.value = object.name;
      option.textContent = object.name;
      parentSelect.appendChild(option);
    }
    parentSelect.value = state.object.parent || '';
  }

  function drawPreview() {
    pctx.clearRect(0, 0, preview.width, preview.height);
    const sprite = state.object && state.object.sprite ? state.sprites[state.object.sprite] : null;
    if (!sprite || !sprite.thumb) {
      return;
    }
    const image = new Image();
    image.onload = () => {
      pctx.imageSmoothingEnabled = false;
      const scale = Math.max(1, Math.floor(Math.min(96 / sprite.width, 96 / sprite.height))) || 1;
      const w = sprite.width * scale;
      const h = sprite.height * scale;
      pctx.clearRect(0, 0, preview.width, preview.height);
      pctx.drawImage(image, (96 - w) / 2, (96 - h) / 2, w, h);
    };
    image.src = 'data:image/png;base64,' + sprite.thumb;
  }

  function buildEvents() {
    const list = $('event-list');
    list.innerHTML = '';
    for (const event of state.events) {
      const defined = state.defined.includes(event.name);
      const button = document.createElement('button');
      button.className = 'event' + (defined ? ' defined' : '');
      button.title = defined
        ? `${event.name}() is defined — click to open it`
        : `Add def ${event.name}(${event.signature}) to the script`;
      button.innerHTML = `<span class="dot"></span><span>${event.label}</span>`;
      button.addEventListener('click', () =>
        vscode.postMessage({ type: 'addEvent', event: event.name }),
      );
      list.appendChild(button);
    }
  }

  $('obj-sprite').addEventListener('change', (ev) => {
    state.object.sprite = ev.target.value || null;
    drawPreview();
    commit();
  });
  $('obj-parent').addEventListener('change', (ev) => {
    state.object.parent = ev.target.value || null;
    commit();
  });
  $('obj-depth').addEventListener('change', (ev) => {
    state.object.depth = Number(ev.target.value) | 0;
    commit();
  });
  for (const [id, key] of [
    ['obj-visible', 'visible'],
    ['obj-solid', 'solid'],
    ['obj-persistent', 'persistent'],
  ]) {
    $(id).addEventListener('change', (ev) => {
      state.object[key] = ev.target.checked;
      commit();
    });
  }

  $('open-script').addEventListener('click', () => vscode.postMessage({ type: 'openScript' }));
  $('edit-sprite').addEventListener('click', () => {
    if (state.object && state.object.sprite) {
      vscode.postMessage({ type: 'openSprite', name: state.object.sprite });
    }
  });

  window.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      vscode.postMessage({ type: 'save' });
    }
  });

  window.addEventListener('message', (ev) => {
    const message = ev.data;
    if (message.type === 'load') {
      load(message);
    } else if (message.type === 'resources') {
      state.sprites = message.sprites;
      state.objects = message.objects;
      buildSelects();
      drawPreview();
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

  vscode.postMessage({ type: 'ready' });
})();
