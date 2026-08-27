"""Bitmap font baked into the atlas.

Text is drawn from atlas quads like everything else, so it batches with sprites
and needs no font file shipped alongside the game.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from PIL import Image, ImageDraw, ImageFont

FIRST_CHAR = 32
LAST_CHAR = 126


@dataclass
class Glyph:
    image: Image.Image
    advance: float


@dataclass
class FontData:
    glyphs: dict[str, Glyph]
    line_height: int

    def measure(self, text: str) -> tuple[float, float]:
        """Width and height of `text`, honouring newlines."""
        lines = text.split("\n")
        width = max(
            (sum(self.glyphs[c].advance for c in line if c in self.glyphs) for line in lines),
            default=0.0,
        )
        return width, self.line_height * len(lines)


def build_font(size: int = 16) -> FontData:
    try:
        font = ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10.1 has a fixed-size default font
        font = ImageFont.load_default()

    characters = [chr(code) for code in range(FIRST_CHAR, LAST_CHAR + 1)]

    line_height = 1
    for character in characters:
        bbox = font.getbbox(character)
        if bbox:
            line_height = max(line_height, int(math.ceil(bbox[3])))
    line_height += 1

    glyphs: dict[str, Glyph] = {}
    for character in characters:
        advance = float(font.getlength(character))
        width = max(1, int(math.ceil(advance)))
        image = Image.new("RGBA", (width, line_height), (0, 0, 0, 0))
        if character != " ":
            # Default anchor puts the ascender box at the origin, so every
            # glyph shares the same baseline.
            ImageDraw.Draw(image).text((0, 0), character, font=font, fill=(255, 255, 255, 255))
        glyphs[character] = Glyph(image=image, advance=advance)

    return FontData(glyphs=glyphs, line_height=line_height)
