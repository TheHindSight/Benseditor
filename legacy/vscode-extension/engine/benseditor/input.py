"""Keyboard and mouse state, tracked per step.

Keys are named with plain strings -- `"left"`, `"space"`, `"a"`, `"5"` -- so
game code never has to import key constants.
"""

from __future__ import annotations

from typing import Iterable

from pyglet.window import key as pyglet_key
from pyglet.window import mouse as pyglet_mouse

ALIASES: dict[str, tuple[int, ...]] = {
    "left": (pyglet_key.LEFT,),
    "right": (pyglet_key.RIGHT,),
    "up": (pyglet_key.UP,),
    "down": (pyglet_key.DOWN,),
    "space": (pyglet_key.SPACE,),
    "enter": (pyglet_key.ENTER, pyglet_key.NUM_ENTER),
    "return": (pyglet_key.ENTER, pyglet_key.NUM_ENTER),
    "escape": (pyglet_key.ESCAPE,),
    "esc": (pyglet_key.ESCAPE,),
    "tab": (pyglet_key.TAB,),
    "backspace": (pyglet_key.BACKSPACE,),
    "delete": (pyglet_key.DELETE,),
    "shift": (pyglet_key.LSHIFT, pyglet_key.RSHIFT),
    "control": (pyglet_key.LCTRL, pyglet_key.RCTRL),
    "ctrl": (pyglet_key.LCTRL, pyglet_key.RCTRL),
    "alt": (pyglet_key.LALT, pyglet_key.RALT),
    "home": (pyglet_key.HOME,),
    "end": (pyglet_key.END,),
    "pageup": (pyglet_key.PAGEUP,),
    "pagedown": (pyglet_key.PAGEDOWN,),
    "comma": (pyglet_key.COMMA,),
    "period": (pyglet_key.PERIOD,),
}

MOUSE_BUTTONS: dict[str, int] = {
    "left": pyglet_mouse.LEFT,
    "right": pyglet_mouse.RIGHT,
    "middle": pyglet_mouse.MIDDLE,
}

_key_cache: dict[str, tuple[int, ...]] = {}


def resolve_key(name: "str | int") -> tuple[int, ...]:
    """Turn a key name into the pyglet symbols that satisfy it."""
    if isinstance(name, int):
        return (name,)

    cached = _key_cache.get(name)
    if cached is not None:
        return cached

    lowered = name.lower()
    symbols: tuple[int, ...] | None = ALIASES.get(lowered)

    if symbols is None and len(lowered) == 1:
        if lowered.isalpha():
            symbols = (getattr(pyglet_key, lowered.upper()),)
        elif lowered.isdigit():
            symbols = (getattr(pyglet_key, f"_{lowered}"), getattr(pyglet_key, f"NUM_{lowered}"))

    if symbols is None:
        found = getattr(pyglet_key, name.upper(), None)
        if isinstance(found, int):
            symbols = (found,)

    if symbols is None:
        raise ValueError(f"Unknown key name: {name!r}")

    _key_cache[name] = symbols
    return symbols


def resolve_mouse_button(button: "str | int") -> int:
    if isinstance(button, int):
        return button
    try:
        return MOUSE_BUTTONS[button.lower()]
    except KeyError:
        raise ValueError(f"Unknown mouse button: {button!r}") from None


class InputState:
    """Held / pressed / released sets, refreshed once per step."""

    def __init__(self) -> None:
        self.held: set[int] = set()
        self.pressed: set[int] = set()
        self.released: set[int] = set()

        self.mouse_held: set[int] = set()
        self.mouse_pressed: set[int] = set()
        self.mouse_released: set[int] = set()

        self.mouse_x = 0.0
        self.mouse_y = 0.0
        self.mouse_wheel = 0

    # -- event sinks ----------------------------------------------------

    def on_key_press(self, symbol: int) -> None:
        if symbol not in self.held:
            self.pressed.add(symbol)
        self.held.add(symbol)

    def on_key_release(self, symbol: int) -> None:
        self.held.discard(symbol)
        self.released.add(symbol)

    def on_mouse_press(self, button: int) -> None:
        if button not in self.mouse_held:
            self.mouse_pressed.add(button)
        self.mouse_held.add(button)

    def on_mouse_release(self, button: int) -> None:
        self.mouse_held.discard(button)
        self.mouse_released.add(button)

    def end_step(self) -> None:
        self.pressed.clear()
        self.released.clear()
        self.mouse_pressed.clear()
        self.mouse_released.clear()
        self.mouse_wheel = 0

    def clear(self) -> None:
        self.held.clear()
        self.mouse_held.clear()
        self.end_step()

    # -- queries --------------------------------------------------------

    def check(self, symbols: Iterable[int]) -> bool:
        return any(symbol in self.held for symbol in symbols)

    def check_pressed(self, symbols: Iterable[int]) -> bool:
        return any(symbol in self.pressed for symbol in symbols)

    def check_released(self, symbols: Iterable[int]) -> bool:
        return any(symbol in self.released for symbol in symbols)
