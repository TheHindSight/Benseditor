"""Colour handling.

Anywhere the API takes a colour it accepts an ``(r, g, b)`` or ``(r, g, b, a)``
tuple with 0-255 components, a ``"#rrggbb"`` string, or a ``0xRRGGBB`` integer.
"""

from __future__ import annotations

from typing import Any

c_black = (0, 0, 0)
c_white = (255, 255, 255)
c_red = (255, 0, 77)
c_green = (0, 228, 54)
c_blue = (41, 173, 255)
c_yellow = (255, 236, 39)
c_orange = (255, 163, 0)
c_purple = (131, 118, 156)
c_gray = (95, 87, 79)
c_grey = c_gray


def to_rgba(color: Any, alpha: float = 1.0) -> tuple[float, float, float, float]:
    """Normalise any accepted colour form to floats in 0..1."""
    if isinstance(color, str):
        text = color.lstrip("#")
        if len(text) == 3:
            text = "".join(c * 2 for c in text)
        if len(text) not in (6, 8):
            raise ValueError(f"Invalid colour string: {color!r}")
        parts = [int(text[i : i + 2], 16) for i in range(0, len(text), 2)]
    elif isinstance(color, int):
        parts = [(color >> 16) & 0xFF, (color >> 8) & 0xFF, color & 0xFF]
    else:
        parts = [int(v) for v in color]

    if len(parts) == 3:
        parts.append(255)
    if len(parts) != 4:
        raise ValueError(f"Invalid colour: {color!r}")

    r, g, b, a = parts
    return (r / 255.0, g / 255.0, b / 255.0, (a / 255.0) * alpha)
