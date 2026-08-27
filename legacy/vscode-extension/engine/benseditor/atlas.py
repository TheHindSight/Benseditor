"""Texture atlas packing.

Every sprite frame and font glyph is packed into a single texture so the whole
frame can be drawn in one batched call.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Hashable

from PIL import Image

PADDING = 1


@dataclass(frozen=True)
class AtlasEntry:
    """Where one image lives in the atlas, in pixels and in UV space."""

    x: int
    y: int
    width: int
    height: int
    u0: float
    v0: float
    u1: float
    v1: float


class AtlasBuilder:
    """Shelf packer: rows of equal height, filled left to right."""

    def __init__(self, max_width: int = 2048) -> None:
        self._max_width = max_width
        self._images: list[tuple[Hashable, Image.Image]] = []

    def add(self, key: Hashable, image: Image.Image) -> None:
        self._images.append((key, image.convert("RGBA")))

    def build(self) -> tuple[Image.Image, dict[Hashable, AtlasEntry]]:
        # Tallest first keeps shelves tightly packed.
        ordered = sorted(self._images, key=lambda item: -item[1].height)

        placements: list[tuple[Hashable, Image.Image, int, int]] = []
        pen_x = pen_y = shelf_height = 0
        used_width = 0

        for key, image in ordered:
            width = image.width + PADDING
            height = image.height + PADDING
            if pen_x + width > self._max_width and pen_x > 0:
                pen_x = 0
                pen_y += shelf_height
                shelf_height = 0
            placements.append((key, image, pen_x, pen_y))
            pen_x += width
            shelf_height = max(shelf_height, height)
            used_width = max(used_width, pen_x)

        atlas_width = _next_power_of_two(max(used_width, 1))
        atlas_height = _next_power_of_two(max(pen_y + shelf_height, 1))
        atlas = Image.new("RGBA", (atlas_width, atlas_height), (0, 0, 0, 0))

        entries: dict[Hashable, AtlasEntry] = {}
        for key, image, x, y in placements:
            atlas.paste(image, (x, y))
            entries[key] = AtlasEntry(
                x=x,
                y=y,
                width=image.width,
                height=image.height,
                u0=x / atlas_width,
                v0=y / atlas_height,
                u1=(x + image.width) / atlas_width,
                v1=(y + image.height) / atlas_height,
            )

        return atlas, entries


def _next_power_of_two(value: int) -> int:
    power = 1
    while power < value:
        power *= 2
    return power
