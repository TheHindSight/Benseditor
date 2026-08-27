/**
 * Every object template, on both engines.
 *
 * A template is the first thing a new user runs, so each one is registered
 * exactly as the editor would (with the sprite it expects, a wall to block
 * on, a coin to collect, a player for the enemy to see), started in a room
 * and stepped for sixty frames with some input -- in Luau AND in Python. An
 * exception anywhere fails the template by name, with the engine's message.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LuauState } from 'luau-web';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` -- ${detail}` : ''}`);
};

async function loadModule(path) {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    return await server.ssrLoadModule(path);
  } finally {
    await server.close();
  }
}

const { OBJECT_TEMPLATES } = await loadModule('/src/project/objectTemplates.ts');
const { LANGUAGES } = await loadModule('/src/project/languages.ts');

// ---- the two engines, driven the same way ---------------------------------

const hostStore = new Map();
const store = {
  get: (key) => hostStore.get(key) ?? '',
  set: (key, value) => (value === '' ? hostStore.delete(key) : hostStore.set(key, value)),
};

async function luauEngine() {
  const state = await LuauState.createAsync({ __host_store_get: store.get, __host_store_set: store.set });
  await state.loadstring(read('src', 'luau', 'roblox.luau'), 'roblox.luau', true)();
  const api = (await state.loadstring(read('src', 'luau', 'prelude.luau'), 'prelude.luau', true)())[0];
  const g = (name) => api.get(name);
  return {
    language: 'luau',
    reset: () => g('reset')(),
    sprite: (...args) => g('register_sprite')(...args),
    font: (...args) => g('register_font')(...args),
    room: (...args) => g('register_room')(...args),
    start: (name) => g('start')(name),
    frame: (input) => g('frame')(input, 1 / 60),
    async object(name, source, def) {
      const module = (await state.loadstring(source, `${name}.luau`, true)())[0];
      await g('register_object')(name, module, def.sprite ?? null, def.depth ?? 0, def.visible ?? true,
        def.solid ?? false, def.persistent ?? false, def.parent ?? null, (def.blockedBy ?? []).join(','));
    },
  };
}

async function pythonEngine() {
  const { loadMicroPython } = await import(`file:///${join(root, 'src', 'vendor', 'micropython.js').replace(/\\/g, '/')}`);
  const mp = await loadMicroPython({ stdout: () => {}, stderr: (line) => console.error('  py:', line) });
  mp.registerJsModule('__host', { store_get: store.get, store_set: store.set });
  mp.runPython(read('src', 'python', 'roblox.py'));
  mp.runPython(read('src', 'python', 'prelude.py'));
  const g = (name) => mp.globals.get(name);
  return {
    language: 'python',
    reset: () => g('__reset')(),
    sprite: (...args) => g('__register_sprite')(...args),
    font: (...args) => g('__register_font')(...args),
    room: (...args) => g('__register_room')(...args),
    start: (name) => g('__start')(name),
    frame: (input) => g('__frame_packed')(input, 1 / 60),
    async object(name, source, def) {
      g('__register_object')(name, source, def.sprite ?? null, def.depth ?? 0, def.visible ?? true,
        def.solid ?? false, def.persistent ?? false, def.parent ?? null, (def.blockedBy ?? []).join(','));
    },
  };
}

/** The cast every template may reference, from its own `def` and prose. */
const SUPPORTING = {
  obj_wall: { sprite: 'spr_wall', solid: true },
  obj_coin: { sprite: 'spr_coin' },
  obj_player: { sprite: 'spr_player' },
  obj_enemy: { sprite: 'spr_enemy' },
  obj_bullet: { sprite: 'spr_bullet' },
};

const INPUTS = ['', 'right||', 'right|space|', 'left||', '|space|', 'up||', 'down||', 'd||', 'w|w|'];

for (const make of [luauEngine, pythonEngine]) {
  const engine = await make();
  console.log(`\n=== templates on the ${engine.language} engine ===`);
  const inert = LANGUAGES[engine.language].objectFallback || (engine.language === 'python' ? '' : 'local obj = {}\nreturn obj\n');

  for (const template of OBJECT_TEMPLATES) {
    const source = template.source[engine.language];
    const name = template.suggestedName;
    let stage = 'register';
    try {
      await engine.reset();
      for (const spr of ['spr_wall', 'spr_coin', 'spr_player', 'spr_enemy', 'spr_bullet', 'spr_box']) {
        await engine.sprite(spr, 0, 2, 16, 16, 8, 8, 12, 0, 0, 15, 15);
      }
      await engine.font(12, '65,100,7,6,9;66,101,7,6,9;48,102,7,6,9');
      // The supporting cast are plain objects with the template's own script
      // only when they ARE the template.
      for (const [other, def] of Object.entries(SUPPORTING)) {
        if (other !== name) await engine.object(other, inert, def);
      }
      await engine.object(name, source || LANGUAGES[engine.language].newObjectSource(name), {
        sprite: 'spr_box',
        ...template.def,
      });
      stage = 'start';
      await engine.room('rm', 480, 288, 0x1d2b53, 16, 16,
        `${name},64,64,1,1,0;obj_wall,200,64,1,1,0;obj_wall,64,200,1,1,0;obj_coin,120,64,1,1,0;obj_enemy,300,64,1,1,0;obj_player,40,40,1,1,0`
          .split(';').filter((entry) => !entry.startsWith(`${name},`) || entry === `${name},64,64,1,1,0`).join(';'));
      await engine.start('rm');
      stage = 'frames';
      for (let i = 0; i < 60; i++) await engine.frame(INPUTS[i % INPUTS.length]);
      check(`${template.id} runs`, true);
    } catch (error) {
      const message = String(error?.message ?? error).split('\n').filter(Boolean).slice(-3).join(' | ');
      check(`${template.id} runs`, false, `${stage}: ${message}`);
    }
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
