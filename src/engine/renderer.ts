import type { Atlas } from './atlas';
import { CMD_CIRCLE, CMD_LAYER, CMD_LINE, CMD_RECT, CMD_SPRITE, RECORD_FLOATS } from './protocol';

/**
 * Batched WebGL2 sprite renderer.
 *
 * Consumes a frame of draw commands produced by Luau and turns the whole thing
 * into one draw call: every quad samples the same atlas, so shapes and text
 * batch alongside sprites.
 */

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
in vec4 a_color;

uniform mat4 u_projection;

out vec2 v_uv;
out vec4 v_color;

void main() {
    v_uv = a_uv;
    v_color = a_color;
    gl_Position = u_projection * vec4(a_pos, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec2 v_uv;
in vec4 v_color;

uniform sampler2D u_atlas;

out vec4 outColor;

void main() {
    outColor = texture(u_atlas, v_uv) * v_color;
}`;

const FLOATS_PER_VERTEX = 8;
const VERTICES_PER_QUAD = 6;
const INITIAL_QUADS = 4096;

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader failed to compile: ${log}`);
  }
  return shader;
}

export class Renderer {
  private readonly program: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly texture: WebGLTexture;
  private readonly projectionLocation: WebGLUniformLocation;
  private readonly atlasLocation: WebGLUniformLocation;

  private data = new Float32Array(INITIAL_QUADS * VERTICES_PER_QUAD * FLOATS_PER_VERTEX);
  private quadCount = 0;
  private capacity = INITIAL_QUADS;

  /** Static tile layers, uploaded once and drawn by index. */
  private layers: { vao: WebGLVertexArrayObject; vbo: WebGLBuffer; vertices: number }[] = [];

  private readonly projection = new Float32Array(16);

  constructor(
    private readonly gl: WebGL2RenderingContext,
    private atlas: Atlas,
  ) {
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);

    this.program = gl.createProgram()!;
    gl.attachShader(this.program, vertex);
    gl.attachShader(this.program, fragment);
    gl.linkProgram(this.program);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(`Shader program failed to link: ${gl.getProgramInfoLog(this.program)}`);
    }
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);

    this.projectionLocation = gl.getUniformLocation(this.program, 'u_projection')!;
    this.atlasLocation = gl.getUniformLocation(this.program, 'u_atlas')!;

    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);

    const stride = FLOATS_PER_VERTEX * 4;
    const bind = (name: string, size: number, offset: number) => {
      const location = gl.getAttribLocation(this.program, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
    };
    bind('a_pos', 2, 0);
    bind('a_uv', 2, 8);
    bind('a_color', 4, 16);
    gl.bindVertexArray(null);

    this.texture = gl.createTexture()!;
    this.uploadAtlas(atlas);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /**
   * Upload one static vertex buffer per tile layer.
   *
   * These never change while the game runs, so they are written once and then
   * drawn with a bind and a draw call -- instead of crossing the WASM boundary
   * as tens of thousands of floats every frame.
   */
  setLayers(geometry: Float32Array[]): void {
    const gl = this.gl;

    for (const layer of this.layers) {
      gl.deleteVertexArray(layer.vao);
      gl.deleteBuffer(layer.vbo);
    }
    this.layers = [];

    const stride = FLOATS_PER_VERTEX * 4;
    for (const vertices of geometry) {
      const vao = gl.createVertexArray()!;
      const vbo = gl.createBuffer()!;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

      const bind = (name: string, size: number, offset: number) => {
        const location = gl.getAttribLocation(this.program, name);
        gl.enableVertexAttribArray(location);
        gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset);
      };
      bind('a_pos', 2, 0);
      bind('a_uv', 2, 8);
      bind('a_color', 4, 16);

      this.layers.push({ vao, vbo, vertices: vertices.length / FLOATS_PER_VERTEX });
    }

    gl.bindVertexArray(null);
  }

  uploadAtlas(atlas: Atlas): void {
    const gl = this.gl;
    this.atlas = atlas;
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      atlas.canvas as HTMLCanvasElement,
    );
    // Pixel art: never interpolate.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** World units 0..width / 0..height, top-left origin with y pointing down. */
  private setProjection(width: number, height: number, offsetX: number, offsetY: number): void {
    const m = this.projection;
    m.fill(0);
    m[0] = 2 / width;
    m[5] = -2 / height;
    m[10] = -1;
    m[12] = -1 - (2 * offsetX) / width;
    m[13] = 1 + (2 * offsetY) / height;
    m[15] = 1;
  }

  private ensureCapacity(extraQuads: number): void {
    if (this.quadCount + extraQuads <= this.capacity) {
      return;
    }
    while (this.quadCount + extraQuads > this.capacity) {
      this.capacity *= 2;
    }
    const grown = new Float32Array(this.capacity * VERTICES_PER_QUAD * FLOATS_PER_VERTEX);
    grown.set(this.data);
    this.data = grown;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.vbo);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, this.data.byteLength, this.gl.DYNAMIC_DRAW);
  }

  private pushQuad(
    x0: number, y0: number,
    x1: number, y1: number,
    x2: number, y2: number,
    x3: number, y3: number,
    u0: number, v0: number,
    u1: number, v1: number,
    r: number, g: number, b: number, a: number,
  ): void {
    this.ensureCapacity(1);
    const d = this.data;
    let o = this.quadCount * VERTICES_PER_QUAD * FLOATS_PER_VERTEX;

    // Two triangles: 0-1-2 and 0-2-3.
    const xs = [x0, x1, x2, x0, x2, x3];
    const ys = [y0, y1, y2, y0, y2, y3];
    const us = [u0, u1, u1, u0, u1, u0];
    const vs = [v0, v0, v1, v0, v1, v1];

    for (let i = 0; i < 6; i++) {
      d[o] = xs[i];
      d[o + 1] = ys[i];
      d[o + 2] = us[i];
      d[o + 3] = vs[i];
      d[o + 4] = r;
      d[o + 5] = g;
      d[o + 6] = b;
      d[o + 7] = a;
      o += FLOATS_PER_VERTEX;
    }
    this.quadCount++;
  }

  private whiteUV(): [number, number] {
    const white = this.atlas.entries[this.atlas.whiteId];
    return [(white.u0 + white.u1) / 2, (white.v0 + white.v1) / 2];
  }

  private pushSolidQuad(
    x0: number, y0: number, x1: number, y1: number,
    x2: number, y2: number, x3: number, y3: number,
    r: number, g: number, b: number, a: number,
  ): void {
    const [u, v] = this.whiteUV();
    this.pushQuad(x0, y0, x1, y1, x2, y2, x3, y3, u, v, u, v, r, g, b, a);
  }

  private pushLine(
    x1: number, y1: number, x2: number, y2: number, width: number,
    r: number, g: number, b: number, a: number,
  ): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (length === 0) return;
    const nx = ((-dy / length) * width) / 2;
    const ny = ((dx / length) * width) / 2;
    this.pushSolidQuad(
      x1 + nx, y1 + ny,
      x2 + nx, y2 + ny,
      x2 - nx, y2 - ny,
      x1 - nx, y1 - ny,
      r, g, b, a,
    );
  }

  /**
   * Render one frame of commands.
   *
   * `commands` is the decoded float32 view straight from Luau; it is read
   * once, expanded into geometry, and drawn.
   */
  drawFrame(
    commands: Float32Array,
    background: number,
    viewWidth: number,
    viewHeight: number,
    viewX: number,
    viewY: number,
  ): void {
    const gl = this.gl;
    this.quadCount = 0;

    this.setProjection(viewWidth, viewHeight, viewX, viewY);
    gl.clearColor(
      ((background >> 16) & 0xff) / 255,
      ((background >> 8) & 0xff) / 255,
      (background & 0xff) / 255,
      1,
    );
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Set up once: every batch and every layer shares the shader and atlas.
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.projectionLocation, false, this.projection);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.atlasLocation, 0);

    const count = Math.floor(commands.length / RECORD_FLOATS);
    for (let i = 0; i < count; i++) {
      const o = i * RECORD_FLOATS;
      const kind = commands[o];
      const p1 = commands[o + 1];
      const p2 = commands[o + 2];
      const p3 = commands[o + 3];
      const p4 = commands[o + 4];
      const p5 = commands[o + 5];
      const p6 = commands[o + 6];
      const r = commands[o + 7];
      const g = commands[o + 8];
      const b = commands[o + 9];
      const a = commands[o + 10];

      switch (kind) {
        case CMD_SPRITE: {
          const entry = this.atlas.entries[p1];
          if (!entry) break;

          const left = -entry.originX * p4;
          const top = -entry.originY * p5;
          const right = left + entry.width * p4;
          const bottom = top + entry.height * p5;

          if (p6 === 0) {
            this.pushQuad(
              p2 + left, p3 + top,
              p2 + right, p3 + top,
              p2 + right, p3 + bottom,
              p2 + left, p3 + bottom,
              entry.u0, entry.v0, entry.u1, entry.v1,
              r, g, b, a,
            );
          } else {
            // Counter-clockwise on screen, where +y points down.
            const rad = (p6 * Math.PI) / 180;
            const cos = Math.cos(rad);
            const sin = Math.sin(rad);
            const tx = (lx: number, ly: number) => p2 + lx * cos + ly * sin;
            const ty = (lx: number, ly: number) => p3 - lx * sin + ly * cos;
            this.pushQuad(
              tx(left, top), ty(left, top),
              tx(right, top), ty(right, top),
              tx(right, bottom), ty(right, bottom),
              tx(left, bottom), ty(left, bottom),
              entry.u0, entry.v0, entry.u1, entry.v1,
              r, g, b, a,
            );
          }
          break;
        }

        case CMD_RECT: {
          const left = Math.min(p1, p3);
          const right = Math.max(p1, p3);
          const top = Math.min(p2, p4);
          const bottom = Math.max(p2, p4);
          if (p5 === 1) {
            const w = p6 || 1;
            this.pushLine(left, top, right, top, w, r, g, b, a);
            this.pushLine(right, top, right, bottom, w, r, g, b, a);
            this.pushLine(right, bottom, left, bottom, w, r, g, b, a);
            this.pushLine(left, bottom, left, top, w, r, g, b, a);
          } else {
            this.pushSolidQuad(
              left, top, right, top, right, bottom, left, bottom,
              r, g, b, a,
            );
          }
          break;
        }

        case CMD_LINE:
          this.pushLine(p1, p2, p3, p4, p5 || 1, r, g, b, a);
          break;

        case CMD_LAYER: {
          // Everything queued so far must land before the layer, or the depth
          // ordering the engine worked out would be lost.
          this.flushBatch();
          const layer = this.layers[p1];
          if (layer) {
            gl.bindVertexArray(layer.vao);
            gl.drawArrays(gl.TRIANGLES, 0, layer.vertices);
            gl.bindVertexArray(null);
          }
          break;
        }

        case CMD_CIRCLE: {
          const segments = Math.max(3, Math.floor(p5) || 24);
          const radius = p3;
          let px = p1 + radius;
          let py = p2;
          for (let s = 1; s <= segments; s++) {
            const angle = (2 * Math.PI * s) / segments;
            const nx = p1 + Math.cos(angle) * radius;
            const ny = p2 + Math.sin(angle) * radius;
            if (p4 === 1) {
              this.pushLine(px, py, nx, ny, 1, r, g, b, a);
            } else {
              // Triangle fan, drawn as degenerate quads.
              this.pushSolidQuad(p1, p2, px, py, nx, ny, p1, p2, r, g, b, a);
            }
            px = nx;
            py = ny;
          }
          break;
        }
      }
    }

    this.flushBatch();
  }

  /** Upload and draw whatever quads have accumulated, then start a new batch. */
  private flushBatch(): void {
    if (this.quadCount === 0) return;
    const gl = this.gl;

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(
      gl.ARRAY_BUFFER,
      0,
      this.data.subarray(0, this.quadCount * VERTICES_PER_QUAD * FLOATS_PER_VERTEX),
    );
    gl.drawArrays(gl.TRIANGLES, 0, this.quadCount * VERTICES_PER_QUAD);
    gl.bindVertexArray(null);

    this.quadCount = 0;
  }
}
