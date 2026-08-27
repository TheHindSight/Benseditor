import { languageOf } from '../project/languages';
import { colorToInt, encodeTiles, tilePixel, type Project } from '../project/types';
import { buildAtlas, loadFrame, type Atlas, type AtlasSource } from './atlas';
import { buildFont, packFontMetrics } from './font';
import { InputCapture } from './input';
import { FixedStepClock } from './fixedStep';
import { FrameDecoder } from './protocol';
import { Renderer } from './renderer';
import type { FrameResult, ScriptHost, ScriptHostFactory } from './scriptHost';

/**
 * Hosts a running game.
 *
 * All game state lives inside the script VM -- Luau or Python, behind the
 * `ScriptHost` seam. Each frame the host does exactly one thing across the
 * WASM boundary: `frame(input)`, which returns the draw commands and the
 * frame's metadata together. Everything else -- events, movement, collision,
 * the drawing API -- happens inside the VM, because a call out to JS costs
 * ~90us and a per-sprite callback would blow the frame budget.
 */

export type ErrorReporter = (message: string) => void;

/**
 * Above this many tiles a layer is streamed per frame instead of held on the
 * GPU, so an enormous map cannot pin a huge static buffer in memory.
 */
const MAX_STATIC_TILES = 40_000;

/** Expand a tile layer into triangles once, ready to sit in a GPU buffer. */
function buildLayerGeometry(
  layer: { columns: number; rows: number; tiles: number[] },
  tileWidth: number,
  tileHeight: number,
  firstAtlasId: number,
  tileCount: number,
  atlas: Atlas,
): Float32Array {
  const filled = layer.tiles.filter((tile) => tile >= 0 && tile < tileCount).length;
  const vertices = new Float32Array(filled * 6 * 8);
  let o = 0;

  for (let row = 0; row < layer.rows; row++) {
    for (let column = 0; column < layer.columns; column++) {
      const tile = layer.tiles[row * layer.columns + column];
      if (tile < 0 || tile >= tileCount) continue;

      const entry = atlas.entries[firstAtlasId + tile];
      if (!entry) continue;

      const x0 = column * tileWidth;
      const y0 = row * tileHeight;
      const x1 = x0 + entry.width;
      const y1 = y0 + entry.height;

      const xs = [x0, x1, x1, x0, x1, x0];
      const ys = [y0, y0, y1, y0, y1, y1];
      const us = [entry.u0, entry.u1, entry.u1, entry.u0, entry.u1, entry.u0];
      const vs = [entry.v0, entry.v0, entry.v1, entry.v0, entry.v1, entry.v1];

      for (let i = 0; i < 6; i++) {
        vertices[o] = xs[i];
        vertices[o + 1] = ys[i];
        vertices[o + 2] = us[i];
        vertices[o + 3] = vs[i];
        vertices[o + 4] = 1;
        vertices[o + 5] = 1;
        vertices[o + 6] = 1;
        vertices[o + 7] = 1;
        o += 8;
      }
    }
  }

  return vertices;
}

export class GameRuntime {
  private running = false;
  private rafHandle = 0;
  private readonly decoder = new FrameDecoder();
  private frameTimes: number[] = [];
  /** The in-flight `__frame` call, if any. Tearing down mid-call is fatal. */
  private pending: Promise<void> | null = null;
  private lastFrameAt = 0;

  /** Steps run so far; the browser tests check the rate. */
  private steps = 0;

  private constructor(
    private readonly host: ScriptHost,
    private readonly renderer: Renderer,
    private readonly input: InputCapture,
    private readonly canvas: HTMLCanvasElement,
    private readonly gl: WebGL2RenderingContext,
    private readonly scale: number,
    private readonly onError: ErrorReporter,
    private readonly clock: FixedStepClock,
  ) {}

  /**
   * `hostFactory` picks the VM for the project's language: the editor passes
   * `getScriptHost` (both engines, loaded on demand); each player entry point
   * passes its own engine, so a bundle only ever carries the VM it uses.
   */
  static async create(
    canvas: HTMLCanvasElement,
    project: Project,
    onError: ErrorReporter,
    hostFactory: ScriptHostFactory,
  ): Promise<GameRuntime> {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error('This browser does not support WebGL2, which Benseditor requires.');
    }

    const host = await hostFactory(languageOf(project.config));
    // Clear anything the previous run registered.
    await host.reset();

    const { atlas, layerGeometry } = await GameRuntime.registerAssets(host, project);

    const renderer = new Renderer(gl, atlas);
    renderer.setLayers(layerGeometry);
    const input = new InputCapture(canvas);
    const scale = Math.max(1, project.config.window.scale || 1);

    // The game steps `fps` times a second whatever the display's refresh rate.
    const fps = Math.min(240, Math.max(1, Math.round(project.config.fps || 60)));
    const runtime = new GameRuntime(
      host, renderer, input, canvas, gl, scale, onError, new FixedStepClock(1 / fps),
    );

    // Checked here so the message names the fix rather than surfacing as a
    // Luau error from deep inside the prelude.
    if (project.rooms.length === 0) {
      throw new Error('This project has no rooms. Create one before running.');
    }
    const start = project.rooms.find((room) => room.name === project.config.startRoom);
    if (!start) {
      throw new Error(
        `The start room "${project.config.startRoom}" does not exist. ` +
          `Right-click a room in the sidebar and choose "Set as start room". ` +
          `Available: ${project.rooms.map((room) => room.name).join(', ')}`,
      );
    }

    await host.start(start.name, fps);
    return runtime;
  }

  /** Build the atlas and hand every asset to the VM. */
  private static async registerAssets(
    host: ScriptHost,
    project: Project,
  ): Promise<{ atlas: Atlas; layerGeometry: Float32Array[] }> {
    const sources: AtlasSource[] = [];
    const spriteFirstIds = new Map<string, number>();
    const layerGeometry: Float32Array[] = [];

    for (const sprite of project.sprites) {
      spriteFirstIds.set(sprite.name, sources.length);
      for (const encoded of sprite.frames) {
        const image = await loadFrame(encoded);
        sources.push({
          image,
          width: sprite.width,
          height: sprite.height,
          originX: sprite.originX,
          originY: sprite.originY,
        });
      }
    }

    // Tilesets are sliced into one atlas entry per tile, so a tile is drawn by
    // atlas id exactly like a sprite frame -- no second texture, no extra pass.
    const tilesetFirstIds = new Map<string, number>();
    for (const tileset of project.tilesets) {
      tilesetFirstIds.set(tileset.name, sources.length);
      const sheet = await loadFrame(tileset.image);

      for (let row = 0; row < tileset.rows; row++) {
        for (let column = 0; column < tileset.columns; column++) {
          const tile = document.createElement('canvas');
          tile.width = tileset.tileWidth;
          tile.height = tileset.tileHeight;
          const ctx = tile.getContext('2d')!;
          ctx.imageSmoothingEnabled = false;
          const source = tilePixel(tileset, column, row);
          ctx.drawImage(
            sheet,
            source.x,
            source.y,
            tileset.tileWidth,
            tileset.tileHeight,
            0,
            0,
            tileset.tileWidth,
            tileset.tileHeight,
          );
          sources.push({
            image: tile,
            width: tileset.tileWidth,
            height: tileset.tileHeight,
            // Tiles are placed by their top-left corner.
            originX: 0,
            originY: 0,
          });
        }
      }
    }

    const font = buildFont(12);
    const fontFirstId = sources.length;
    sources.push(...font.sources);

    const atlas = buildAtlas(sources);

    for (const sprite of project.sprites) {
      await host.registerSprite(
        sprite.name,
        spriteFirstIds.get(sprite.name)!,
        Math.max(1, sprite.frames.length),
        sprite.width,
        sprite.height,
        sprite.originX,
        sprite.originY,
        sprite.fps,
        sprite.collision.left,
        sprite.collision.top,
        sprite.collision.right,
        sprite.collision.bottom,
      );
    }

    for (const tileset of project.tilesets) {
      await host.registerTileset(
        tileset.name,
        tilesetFirstIds.get(tileset.name)!,
        tileset.tileWidth,
        tileset.tileHeight,
        tileset.columns,
        tileset.rows,
        // One character per tile keeps this to a single small string.
        tileset.solid.map((flag) => (flag ? '1' : '0')).join(''),
      );
    }

    await host.registerFont(font.lineHeight, packFontMetrics(font, fontFirstId));

    // Shared modules first: they may define globals the objects rely on, and
    // whatever they return becomes available through `require(name)`.
    for (const script of project.scripts) {
      await host.registerScriptModule(script.name, script.source);
    }

    for (const { def, source } of project.objects) {
      await host.registerObject(def, source);
    }

    for (const room of project.rooms) {
      // The name is the optional seventh field; the prelude accepts six too.
      const packed = room.instances
        .map((i) => [i.object, i.x, i.y, i.xscale, i.yscale, i.angle, i.name ?? ''].join(','))
        .join(';');
      await host.registerRoom(
        room.name,
        room.width,
        room.height,
        colorToInt(room.backgroundColor),
        room.gridWidth,
        room.gridHeight,
        packed,
      );

      for (const layer of room.layers ?? []) {
        const tileset = project.tilesets.find((t) => t.name === layer.tileset);
        let bufferIndex = -1;

        if (tileset && layer.columns * layer.rows <= MAX_STATIC_TILES) {
          bufferIndex = layerGeometry.length;
          layerGeometry.push(
            buildLayerGeometry(
              layer,
              tileset.tileWidth,
              tileset.tileHeight,
              tilesetFirstIds.get(tileset.name)!,
              tileset.columns * tileset.rows,
              atlas,
            ),
          );
        }

        await host.registerRoomLayer(
          room.name,
          layer.id,
          layer.tileset,
          layer.depth,
          layer.visible,
          layer.columns,
          layer.rows,
          encodeTiles(layer.tiles),
          bufferIndex,
        );
      }
    }

    return { atlas, layerGeometry };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.input.attach();
    this.lastFrameAt = performance.now();
    void this.tick();
  }

  stop(): void {
    this.running = false;
    this.input.detach();
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
  }

  /**
   * Stop this runtime and wait for any in-flight frame to settle.
   *
   * The VM itself is shared and outlives the runtime, so it is never destroyed
   * here; `__reset` on the next run clears its state instead.
   */
  async dispose(): Promise<void> {
    this.stop();
    try {
      await this.pending;
    } catch {
      // Already handled by tick().
    }
    this.pending = null;
  }

  /** Rolling average cost of one game step, in milliseconds. */
  get averageFrameMs(): number {
    if (this.frameTimes.length === 0) return 0;
    return this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
  }

  /** How many steps have run since start(). */
  get stepCount(): number {
    return this.steps;
  }

  /** The room the game is in right now. Waits for any in-flight step. */
  async currentRoom(): Promise<string> {
    try {
      await this.pending;
    } catch {
      // Already reported by tick().
    }
    return this.host.roomCurrent();
  }

  /**
   * One animation frame: zero or more fixed steps, then one draw.
   *
   * Awaits each VM call rather than driving from a bare rAF callback, so
   * steps can never overlap even if one runs long. `dt` handed to the game is
   * the constant step length, so `task.wait(1)` is exactly `fps` steps.
   */
  private async tick(): Promise<void> {
    if (!this.running) return;

    const now = performance.now();
    const steps = this.clock.advance((now - this.lastFrameAt) / 1000);
    this.lastFrameAt = now;

    let last: FrameResult | null = null;
    try {
      for (let i = 0; i < steps; i++) {
        const started = performance.now();
        // The snapshot happens per step, so input edges land in exactly one.
        const call = this.host.frame(this.input.snapshot(), this.clock.stepSeconds);
        this.pending = call.then(
          () => undefined,
          () => undefined,
        );
        last = await call;
        this.pending = null;
        this.steps++;

        // A stop() during the await means this step is stale; drop it.
        if (!this.running) return;

        this.frameTimes.push(performance.now() - started);
        if (this.frameTimes.length > 60) this.frameTimes.shift();
        if (last.quit) break;
      }

      if (last) {
        const { payload, count, background, viewWidth, viewHeight, viewX, viewY, quit } = last;
        this.input.setView(viewWidth, viewHeight);
        this.resizeTo(viewWidth, viewHeight);

        const commands = this.decoder.decode(payload, count);
        this.renderer.drawFrame(commands, background, viewWidth, viewHeight, viewX, viewY);

        if (quit) {
          this.stop();
          return;
        }
      }
      // With no step due, the canvas keeps the previous frame: the context is
      // created with preserveDrawingBuffer.
    } catch (error) {
      this.pending = null;
      // Errors raised while shutting down are a consequence of the teardown,
      // not a fault in the game.
      if (!this.running) return;
      this.stop();
      this.onError(error instanceof Error ? error.message : String(error));
      return;
    }

    this.rafHandle = requestAnimationFrame(() => void this.tick());
  }

  private resizeTo(viewWidth: number, viewHeight: number): void {
    const width = Math.round(viewWidth * this.scale);
    const height = Math.round(viewHeight * this.scale);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.gl.viewport(0, 0, width, height);
  }
}
