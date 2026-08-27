/**
 * The draw-command protocol shared with `src/luau/prelude.luau`.
 *
 * Luau packs one frame of commands into a float32 buffer and base64-encodes it;
 * base64 because the host string channel is UTF-8 decoded and would replace any
 * byte above 127 with U+FFFD. These constants must stay in step with the Luau
 * side -- the engine tests assert against them.
 */

export const CMD_SPRITE = 0;
export const CMD_RECT = 1;
export const CMD_LINE = 2;
export const CMD_CIRCLE = 3;
/**
 * "Draw static tile layer N here."
 *
 * A full-screen layer is ~540 tiles; sending those as quads every frame costs
 * about 10 ms in encode and decode alone. Static layers instead live in their
 * own GPU buffer, and this one marker keeps them correctly ordered against the
 * instances around them.
 */
export const CMD_LAYER = 4;

/** Floats per command record: kind, 6 params, rgba, 1 reserved. */
export const RECORD_FLOATS = 12;

export const MAX_COMMANDS = 8192;

/**
 * Decodes a frame into a Float32Array view.
 *
 * Reuses its scratch buffers between frames so a 60fps loop allocates nothing.
 */
export class FrameDecoder {
  private bytes = new Uint8Array(MAX_COMMANDS * RECORD_FLOATS * 4);
  private floats = new Float32Array(this.bytes.buffer);

  /** Returns a view of exactly `commandCount * RECORD_FLOATS` floats. */
  decode(base64: string, commandCount: number): Float32Array {
    const binary = atob(base64);
    const needed = binary.length;

    if (needed > this.bytes.length) {
      this.bytes = new Uint8Array(needed);
      this.floats = new Float32Array(this.bytes.buffer);
    }

    for (let i = 0; i < needed; i++) {
      this.bytes[i] = binary.charCodeAt(i);
    }

    return this.floats.subarray(0, commandCount * RECORD_FLOATS);
  }
}
