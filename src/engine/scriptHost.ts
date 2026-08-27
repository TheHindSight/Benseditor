import type { ObjectFile, ScriptLanguage } from '../project/types';

/**
 * The seam between the host and whichever VM runs the game.
 *
 * Everything language-specific -- compiling a script, the VM's calling
 * convention, how the frame comes back -- sits behind this interface. The
 * runtime only registers assets through it and calls `frame` once per tick,
 * so the Luau and Python engines are interchangeable from the host's point of
 * view. Registration takes the same packed-string arguments the preludes
 * expect; `registerObject` and `registerScriptModule` take *source*, because
 * turning source into something runnable is the one thing each VM does its
 * own way.
 */

/** What one frame of the game produced. */
export interface FrameResult {
  /** Base64 of the draw-command records; see protocol.ts. */
  payload: string;
  count: number;
  background: number;
  viewWidth: number;
  viewHeight: number;
  viewX: number;
  viewY: number;
  quit: boolean;
}

export interface ScriptHost {
  readonly language: ScriptLanguage;
  /** Wipe every registered asset and all live state; the VM itself is reused. */
  reset(): Promise<void>;
  start(room: string): Promise<void>;
  frame(input: string, dt: number): Promise<FrameResult>;

  registerSprite(...args: unknown[]): Promise<void>;
  registerTileset(...args: unknown[]): Promise<void>;
  registerRoom(...args: unknown[]): Promise<void>;
  registerRoomLayer(...args: unknown[]): Promise<void>;
  registerFont(lineHeight: number, packed: string): Promise<void>;
  /** Compile an object's script and register it with its properties. */
  registerObject(def: ObjectFile, source: string): Promise<void>;
  /** Compile a shared script so `require(name)` can find it. */
  registerScriptModule(name: string, source: string): Promise<void>;
}

export type ScriptHostFactory = (language: ScriptLanguage) => Promise<ScriptHost>;

/**
 * The host for a language, loading its VM on first use.
 *
 * Dynamic imports so an app that only ever runs Luau never downloads the
 * Python interpreter, and vice versa; each player entry point imports one
 * host directly instead, which lets the bundler drop the other entirely.
 */
export async function getScriptHost(language: ScriptLanguage): Promise<ScriptHost> {
  if (language === 'python') {
    const { getPythonHost } = await import('./pythonHost');
    return getPythonHost();
  }
  const { getLuauHost } = await import('./luauHost');
  return getLuauHost();
}
