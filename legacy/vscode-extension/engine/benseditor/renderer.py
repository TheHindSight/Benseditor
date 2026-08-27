"""Batched sprite renderer built on ModernGL.

All artwork lives in one atlas texture, so an entire frame -- sprites, shapes
and text -- collapses into a single draw call. Geometry is accumulated into a
growable float32 array and uploaded once per flush.
"""

from __future__ import annotations

import math
from typing import Hashable, Sequence

import moderngl
import numpy as np
from PIL import Image

from .atlas import AtlasEntry

VERTEX_SHADER = """
#version 330

uniform mat4 projection;

in vec2 in_pos;
in vec2 in_uv;
in vec4 in_color;

out vec2 v_uv;
out vec4 v_color;

void main() {
    v_uv = in_uv;
    v_color = in_color;
    gl_Position = projection * vec4(in_pos, 0.0, 1.0);
}
"""

FRAGMENT_SHADER = """
#version 330

uniform sampler2D atlas;

in vec2 v_uv;
in vec4 v_color;

out vec4 f_color;

void main() {
    f_color = texture(atlas, v_uv) * v_color;
}
"""

FLOATS_PER_VERTEX = 8
VERTICES_PER_QUAD = 6
INITIAL_QUADS = 2048


class Renderer:
    """Draws textured quads in screen space with a top-left origin, y down."""

    def __init__(
        self,
        ctx: moderngl.Context,
        atlas_image: Image.Image,
        entries: dict[Hashable, AtlasEntry],
        white_key: Hashable,
    ) -> None:
        self.ctx = ctx
        self.entries = entries
        self._white = entries[white_key]

        self.program = ctx.program(
            vertex_shader=VERTEX_SHADER, fragment_shader=FRAGMENT_SHADER
        )
        self.texture = ctx.texture(atlas_image.size, 4, atlas_image.tobytes())
        self.texture.filter = (moderngl.NEAREST, moderngl.NEAREST)
        self.texture.repeat_x = False
        self.texture.repeat_y = False

        self._capacity = INITIAL_QUADS
        self._data = np.zeros(
            self._capacity * VERTICES_PER_QUAD * FLOATS_PER_VERTEX, dtype="f4"
        )
        self._count = 0  # quads written this batch

        self.vbo = ctx.buffer(reserve=self._data.nbytes, dynamic=True)
        self.vao = ctx.vertex_array(
            self.program,
            [(self.vbo, "2f 2f 4f", "in_pos", "in_uv", "in_color")],
        )

        ctx.enable(moderngl.BLEND)
        ctx.blend_func = moderngl.SRC_ALPHA, moderngl.ONE_MINUS_SRC_ALPHA

    # -- frame lifecycle ------------------------------------------------

    def set_viewport(
        self, width: int, height: int, offset_x: float = 0.0, offset_y: float = 0.0
    ) -> None:
        """Map world units onto the framebuffer, with (offset_x, offset_y) top-left."""
        projection = np.array(
            [
                2.0 / width, 0.0, 0.0, 0.0,
                0.0, -2.0 / height, 0.0, 0.0,
                0.0, 0.0, -1.0, 0.0,
                -1.0 - 2.0 * offset_x / width, 1.0 + 2.0 * offset_y / height, 0.0, 1.0,
            ],
            dtype="f4",
        )
        self.program["projection"].write(projection.tobytes())

    def begin(self) -> None:
        self._count = 0

    def flush(self) -> None:
        if self._count == 0:
            return
        floats = self._count * VERTICES_PER_QUAD * FLOATS_PER_VERTEX
        self.vbo.write(self._data[:floats].tobytes())
        self.texture.use(0)
        self.program["atlas"].value = 0
        self.vao.render(moderngl.TRIANGLES, vertices=self._count * VERTICES_PER_QUAD)
        self._count = 0

    def release(self) -> None:
        for resource in (self.vao, self.vbo, self.texture, self.program):
            try:
                resource.release()
            except Exception:  # pragma: no cover - shutdown best effort
                pass

    # -- geometry -------------------------------------------------------

    def _reserve(self) -> int:
        if self._count >= self._capacity:
            # Flushing mid-frame is cheaper than reallocating every batch, but
            # a genuinely huge frame grows the buffer once and keeps it.
            self._capacity *= 2
            grown = np.zeros(
                self._capacity * VERTICES_PER_QUAD * FLOATS_PER_VERTEX, dtype="f4"
            )
            grown[: self._data.size] = self._data
            self._data = grown
            self.vbo.orphan(self._data.nbytes)
        offset = self._count * VERTICES_PER_QUAD * FLOATS_PER_VERTEX
        self._count += 1
        return offset

    def _push(
        self,
        corners: Sequence[tuple[float, float]],
        uvs: Sequence[tuple[float, float]],
        color: tuple[float, float, float, float],
    ) -> None:
        offset = self._reserve()
        data = self._data
        r, g, b, a = color
        # Two triangles: 0-1-2 and 0-2-3.
        for index in (0, 1, 2, 0, 2, 3):
            x, y = corners[index]
            u, v = uvs[index]
            data[offset : offset + 8] = (x, y, u, v, r, g, b, a)
            offset += 8

    def draw_entry(
        self,
        entry: AtlasEntry,
        x: float,
        y: float,
        origin_x: float,
        origin_y: float,
        xscale: float = 1.0,
        yscale: float = 1.0,
        angle: float = 0.0,
        color: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0),
    ) -> None:
        """Draw an atlas entry with GameMaker semantics (angle CCW in degrees)."""
        left = -origin_x * xscale
        top = -origin_y * yscale
        right = left + entry.width * xscale
        bottom = top + entry.height * yscale

        local = ((left, top), (right, top), (right, bottom), (left, bottom))

        if angle:
            radians = math.radians(angle)
            cos_a = math.cos(radians)
            sin_a = math.sin(radians)
            # Counter-clockwise on screen, where +y points down.
            corners = tuple(
                (x + lx * cos_a + ly * sin_a, y - lx * sin_a + ly * cos_a)
                for lx, ly in local
            )
        else:
            corners = tuple((x + lx, y + ly) for lx, ly in local)

        uvs = (
            (entry.u0, entry.v0),
            (entry.u1, entry.v0),
            (entry.u1, entry.v1),
            (entry.u0, entry.v1),
        )
        self._push(corners, uvs, color)

    def draw_rectangle(
        self,
        x: float,
        y: float,
        width: float,
        height: float,
        color: tuple[float, float, float, float],
    ) -> None:
        """Axis-aligned solid rectangle, drawn with the atlas's white pixel."""
        white = self._white
        # Sample the middle of the white pixel so neighbours never bleed in.
        u = (white.u0 + white.u1) / 2
        v = (white.v0 + white.v1) / 2
        corners = (
            (x, y),
            (x + width, y),
            (x + width, y + height),
            (x, y + height),
        )
        self._push(corners, ((u, v),) * 4, color)

    def _white_uv(self) -> tuple[float, float]:
        """Centre of the atlas's white pixel, for untextured geometry."""
        return (
            (self._white.u0 + self._white.u1) / 2,
            (self._white.v0 + self._white.v1) / 2,
        )

    def draw_triangle(
        self,
        p1: tuple[float, float],
        p2: tuple[float, float],
        p3: tuple[float, float],
        color: tuple[float, float, float, float],
    ) -> None:
        uv = self._white_uv()
        # A quad with a repeated last corner draws as a single triangle.
        self._push((p1, p2, p3, p1), (uv,) * 4, color)

    def draw_line(
        self,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        width: float,
        color: tuple[float, float, float, float],
    ) -> None:
        dx = x2 - x1
        dy = y2 - y1
        length = math.hypot(dx, dy)
        if length == 0:
            return
        # Perpendicular offset of half the line width.
        nx = -dy / length * width / 2
        ny = dx / length * width / 2

        white = self._white
        u = (white.u0 + white.u1) / 2
        v = (white.v0 + white.v1) / 2
        corners = (
            (x1 + nx, y1 + ny),
            (x2 + nx, y2 + ny),
            (x2 - nx, y2 - ny),
            (x1 - nx, y1 - ny),
        )
        self._push(corners, ((u, v),) * 4, color)
