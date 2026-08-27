import type { ObjectFile } from '../project/types';
import PRELUDE from '../python/prelude.py?raw';
import ROBLOX from '../python/roblox.py?raw';
import { loadMicroPython, type MicroPythonInstance } from '../vendor/micropython.js';
import type { FrameResult, ScriptHost } from './scriptHost';

/**
 * The Python engine behind the ScriptHost seam.
 *
 * `src/python/prelude.py` mirrors `prelude.luau` function for function, and
 * runs inside MicroPython compiled to WASM (vendored with the wasm embedded,
 * so nothing is fetched -- see tools/vendor-micropython.mjs). The same rule
 * as the Luau host applies: one call per frame. `__frame_packed` returns a
 * single string rather than a tuple so no proxy objects are created per
 * frame.
 *
 * Object scripts cross as source text and are compiled inside the VM with
 * their file name, so a traceback reads `File "obj_player.py", line 12`.
 */

const DATASTORE_PREFIX = 'benseditor.datastore.';

type PyFunction = (...args: unknown[]) => unknown;

interface PreludeApi {
  frame: (input: string, dt: number) => string;
  start: (room: string, fps: number) => unknown;
  room_current: () => unknown;
  reset: () => unknown;
  register_sprite: PyFunction;
  register_tileset: PyFunction;
  register_object: PyFunction;
  register_room: PyFunction;
  register_room_layer: PyFunction;
  register_font: PyFunction;
  register_module: PyFunction;
}

const ENTRY_POINTS: Record<keyof PreludeApi, string> = {
  frame: '__frame_packed',
  start: '__start',
  room_current: 'room_current',
  reset: '__reset',
  register_sprite: '__register_sprite',
  register_tileset: '__register_tileset',
  register_object: '__register_object',
  register_room: '__register_room',
  register_room_layer: '__register_room_layer',
  register_font: '__register_font',
  register_module: '__register_module',
};

/** One interpreter for the whole session, like the Luau VM. */
let sharedHost: Promise<PreludeApi> | undefined;

async function getApi(): Promise<PreludeApi> {
  sharedHost ??= (async () => {
    const mp: MicroPythonInstance = await loadMicroPython({
      stdout: (line) => console.log(line),
      stderr: (line) => console.error(line),
    });

    mp.registerJsModule('__host', {
      store_get: (key: string) => localStorage.getItem(DATASTORE_PREFIX + key) ?? '',
      store_set: (key: string, value: string) => {
        try {
          if (value === '') localStorage.removeItem(DATASTORE_PREFIX + key);
          else localStorage.setItem(DATASTORE_PREFIX + key, value);
        } catch {
          // Quota exceeded; the game keeps running with in-memory state only.
        }
      },
    });

    mp.runPython(ROBLOX);
    mp.runPython(PRELUDE);

    const api = {} as Record<string, unknown>;
    for (const [key, name] of Object.entries(ENTRY_POINTS)) {
      const fn = mp.globals.get(name);
      if (typeof fn !== 'function') {
        throw new Error(`prelude.py did not define "${name}"`);
      }
      api[key] = fn;
    }
    return api as unknown as PreludeApi;
  })();
  return sharedHost;
}

class PythonHost implements ScriptHost {
  readonly language = 'python' as const;

  constructor(private readonly api: PreludeApi) {}

  async reset(): Promise<void> {
    this.api.reset();
  }

  async start(room: string, fps: number): Promise<void> {
    this.api.start(room, fps);
  }

  async roomCurrent(): Promise<string> {
    return String(this.api.room_current() ?? '');
  }

  async frame(input: string, dt: number): Promise<FrameResult> {
    const packed = this.api.frame(input, dt);
    // "count;background;viewWidth;viewHeight;viewX;viewY;quit;payload" -- the
    // payload is base64 and never contains ';', so seven splits suffice.
    const fields: string[] = [];
    let from = 0;
    for (let i = 0; i < 7; i++) {
      const at = packed.indexOf(';', from);
      fields.push(packed.slice(from, at));
      from = at + 1;
    }
    return {
      count: Number(fields[0]),
      background: Number(fields[1]),
      viewWidth: Number(fields[2]),
      viewHeight: Number(fields[3]),
      viewX: Number(fields[4]),
      viewY: Number(fields[5]),
      quit: fields[6] === '1',
      payload: packed.slice(from),
    };
  }

  async registerSprite(...args: unknown[]): Promise<void> {
    this.api.register_sprite(...args);
  }

  async registerTileset(...args: unknown[]): Promise<void> {
    this.api.register_tileset(...args);
  }

  async registerRoom(...args: unknown[]): Promise<void> {
    this.api.register_room(...args);
  }

  async registerRoomLayer(...args: unknown[]): Promise<void> {
    this.api.register_room_layer(...args);
  }

  async registerFont(lineHeight: number, packed: string): Promise<void> {
    this.api.register_font(lineHeight, packed);
  }

  async registerObject(def: ObjectFile, source: string): Promise<void> {
    // Compiled inside the VM under its own file name, so errors say
    // `File "obj_x.py", line N` -- there is nothing to add here.
    this.api.register_object(
      def.name,
      source,
      def.sprite,
      def.depth,
      def.visible,
      def.solid,
      def.persistent,
      def.parent,
      (def.blockedBy ?? []).join(','),
    );
  }

  async registerScriptModule(name: string, source: string): Promise<void> {
    this.api.register_module(name, source);
  }
}

/** The shared Python host for this session. */
export async function getPythonHost(): Promise<ScriptHost> {
  return new PythonHost(await getApi());
}
