import { LuauState } from 'luau-web';
import PRELUDE from '../luau/prelude.luau?raw';
import ROBLOX from '../luau/roblox.luau?raw';
import type { ObjectFile } from '../project/types';
import type { FrameResult, ScriptHost } from './scriptHost';

/**
 * The Luau engine behind the ScriptHost seam.
 *
 * All game state lives inside the Luau VM. Each frame the host does exactly
 * one thing across the WASM boundary: `frame(input)`, which returns the draw
 * commands and the frame's metadata together. Everything else -- events,
 * movement, collision, the drawing API -- happens in Luau, because a call out
 * to JS costs ~90us and a per-sprite callback would blow the frame budget.
 */

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface PreludeApi {
  frame: (
    input: string,
    dt: number,
  ) => Promise<[string, number, number, number, number, number, number, boolean]>;
  start: (room: string, fps: number) => Promise<unknown>;
  room_current: () => Promise<string>;
  reset: () => Promise<unknown>;
  register_sprite: (...args: unknown[]) => Promise<unknown>;
  register_object: (...args: unknown[]) => Promise<unknown>;
  register_room: (...args: unknown[]) => Promise<unknown>;
  register_room_layer: (...args: unknown[]) => Promise<unknown>;
  register_tileset: (...args: unknown[]) => Promise<unknown>;
  register_font: (...args: unknown[]) => Promise<unknown>;
  register_module: (name: string, value: unknown) => Promise<unknown>;
}

const DATASTORE_PREFIX = 'benseditor.datastore.';

/**
 * One Luau VM for the whole session, created lazily.
 *
 * Deliberately *not* one VM per run. luau-web corrupts its own global state
 * when a VM that has run more than a few dozen frames is destroyed, and the
 * next VM then fails while registering assets. Reusing a single VM avoids that
 * entirely, and makes pressing Run cheap -- no 300 kB VM re-initialisation.
 */
let sharedHost: Promise<{ state: LuauState; api: PreludeApi }> | undefined;

async function getHost(): Promise<{ state: LuauState; api: PreludeApi }> {
  sharedHost ??= (async () => {
    const state = await LuauState.createAsync({
      // DataStore persistence. Called rarely, so the ~90us crossing is fine.
      __host_store_get: (key: string) => localStorage.getItem(DATASTORE_PREFIX + key) ?? '',
      __host_store_set: (key: string, value: string) => {
        try {
          if (value === '') localStorage.removeItem(DATASTORE_PREFIX + key);
          else localStorage.setItem(DATASTORE_PREFIX + key, value);
        } catch {
          // Quota exceeded; the game keeps running with in-memory state only.
        }
      },
    });

    // The Roblox layer first: the prelude fires its signals and drives its
    // task scheduler. It only touches engine globals from inside function
    // bodies, which Luau resolves at call time, so the order is safe.
    await state.loadstring(ROBLOX, 'roblox.luau', true)();

    // The prelude returns its host-facing API; Luau globals are not readable
    // from JS, though they stay visible to every game script.
    const handle = (await state.loadstring(PRELUDE, 'prelude.luau', true)())[0];

    const api = {} as Record<string, unknown>;
    for (const name of [
      'frame', 'start', 'reset', 'room_current',
      'register_sprite', 'register_tileset', 'register_object',
      'register_room', 'register_room_layer', 'register_font', 'register_module',
    ]) {
      const fn = handle.get(name);
      if (typeof fn !== 'function') {
        throw new Error(`prelude.luau did not export "${name}"`);
      }
      api[name] = fn;
    }

    return { state, api: api as unknown as PreludeApi };
  })();

  return sharedHost;
}

class LuauHost implements ScriptHost {
  readonly language = 'luau' as const;

  constructor(
    private readonly state: LuauState,
    private readonly api: PreludeApi,
  ) {}

  async reset(): Promise<void> {
    await this.api.reset();
  }

  async start(room: string, fps: number): Promise<void> {
    await this.api.start(room, fps);
  }

  async roomCurrent(): Promise<string> {
    return String(await this.api.room_current());
  }

  async frame(input: string, dt: number): Promise<FrameResult> {
    const [payload, count, background, viewWidth, viewHeight, viewX, viewY, quit] =
      await this.api.frame(input, dt);
    return { payload, count, background, viewWidth, viewHeight, viewX, viewY, quit };
  }

  async registerSprite(...args: unknown[]): Promise<void> {
    await this.api.register_sprite(...args);
  }

  async registerTileset(...args: unknown[]): Promise<void> {
    await this.api.register_tileset(...args);
  }

  async registerRoom(...args: unknown[]): Promise<void> {
    await this.api.register_room(...args);
  }

  async registerRoomLayer(...args: unknown[]): Promise<void> {
    await this.api.register_room_layer(...args);
  }

  async registerFont(lineHeight: number, packed: string): Promise<void> {
    await this.api.register_font(lineHeight, packed);
  }

  async registerObject(def: ObjectFile, source: string): Promise<void> {
    let module: { get(key: string): unknown } | undefined;
    try {
      module = (await this.state.loadstring(source, `${def.name}.luau`, true)())[0];
    } catch (error) {
      throw new Error(`${def.name}.luau: ${describe(error)}`);
    }
    if (!module || typeof module.get !== 'function') {
      throw new Error(
        `${def.name}.luau must end with \`return obj\`, returning the table holding its events.`,
      );
    }
    await this.api.register_object(
      def.name,
      module,
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
    try {
      const returned = (await this.state.loadstring(source, `${name}.luau`, true)())[0];
      await this.api.register_module(name, returned ?? true);
    } catch (error) {
      throw new Error(`${name}.luau: ${describe(error)}`);
    }
  }
}

/** The shared Luau host for this session. */
export async function getLuauHost(): Promise<ScriptHost> {
  const { state, api } = await getHost();
  return new LuauHost(state, api);
}
