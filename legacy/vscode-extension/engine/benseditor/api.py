"""The functions game code calls.

Everything here is a thin wrapper over the running :class:`~benseditor.game.Game`,
named after its GameMaker counterpart where one exists.
"""

from __future__ import annotations

import math
import random as _random
from typing import Any, Optional, Sequence

from . import runtime
from .gameobject import GameObject
from .input import resolve_key, resolve_mouse_button

# -- instances ----------------------------------------------------------


def instance_create(x: float, y: float, obj: Any) -> GameObject:
    """Create an instance of `obj` (an object name or class) at (x, y)."""
    return runtime.require_game().create_instance(x, y, obj)


def instance_destroy(instance: GameObject) -> None:
    runtime.require_game().destroy_instance(instance)


def instance_exists(obj: Any) -> bool:
    return any(not inst.destroyed for inst in runtime.require_game().instances_matching(obj))


def instance_number(obj: Any) -> int:
    return sum(1 for inst in runtime.require_game().instances_matching(obj) if not inst.destroyed)


def instance_list(obj: Any) -> list[GameObject]:
    return [inst for inst in runtime.require_game().instances_matching(obj) if not inst.destroyed]


def instance_find(obj: Any, index: int = 0) -> Optional[GameObject]:
    found = instance_list(obj)
    return found[index] if 0 <= index < len(found) else None


def instance_nearest(x: float, y: float, obj: Any) -> Optional[GameObject]:
    found = instance_list(obj)
    if not found:
        return None
    return min(found, key=lambda inst: math.hypot(inst.x - x, inst.y - y))


def instance_furthest(x: float, y: float, obj: Any) -> Optional[GameObject]:
    found = instance_list(obj)
    if not found:
        return None
    return max(found, key=lambda inst: math.hypot(inst.x - x, inst.y - y))


def collision_point(x: float, y: float, obj: Any) -> Optional[GameObject]:
    """First instance of `obj` whose collision box contains (x, y)."""
    for instance in instance_list(obj):
        left, top, right, bottom = instance.bbox()
        if left <= x <= right and top <= y <= bottom:
            return instance
    return None


# -- rooms and the game ------------------------------------------------


def room_goto(name: str) -> None:
    runtime.require_game().goto_room(name)


def room_restart() -> None:
    runtime.require_game().restart_room()


def room_current() -> str:
    room = runtime.require_game().room
    return room.name if room else ""


def room_width() -> int:
    game = runtime.require_game()
    return game.room.width if game.room else 0


def room_height() -> int:
    game = runtime.require_game()
    return game.room.height if game.room else 0


def room_speed() -> int:
    return runtime.require_game().room_speed


def game_end() -> None:
    runtime.require_game().quit()


def view_set(x: float, y: float) -> None:
    """Scroll the visible area so its top-left corner sits at (x, y)."""
    game = runtime.require_game()
    game.view_x = x
    game.view_y = y


def view_get() -> tuple[float, float]:
    game = runtime.require_game()
    return game.view_x, game.view_y


# -- input --------------------------------------------------------------


def keyboard_check(key: "str | int") -> bool:
    return runtime.require_game().input.check(resolve_key(key))


def keyboard_check_pressed(key: "str | int") -> bool:
    return runtime.require_game().input.check_pressed(resolve_key(key))


def keyboard_check_released(key: "str | int") -> bool:
    return runtime.require_game().input.check_released(resolve_key(key))


def mouse_check_button(button: "str | int" = "left") -> bool:
    state = runtime.require_game().input
    return resolve_mouse_button(button) in state.mouse_held


def mouse_check_button_pressed(button: "str | int" = "left") -> bool:
    state = runtime.require_game().input
    return resolve_mouse_button(button) in state.mouse_pressed


def mouse_check_button_released(button: "str | int" = "left") -> bool:
    state = runtime.require_game().input
    return resolve_mouse_button(button) in state.mouse_released


def mouse_x() -> float:
    return runtime.require_game().input.mouse_x


def mouse_y() -> float:
    return runtime.require_game().input.mouse_y


def mouse_wheel() -> int:
    return runtime.require_game().input.mouse_wheel


# -- drawing ------------------------------------------------------------


def draw_set_color(color: Any) -> None:
    runtime.require_game().draw_color = color


def draw_get_color() -> Any:
    return runtime.require_game().draw_color


def draw_set_alpha(alpha: float) -> None:
    runtime.require_game().draw_alpha = alpha


def draw_sprite(sprite: str, index: float, x: float, y: float) -> None:
    runtime.require_game().draw_sprite(sprite, index, x, y)


def draw_sprite_ext(
    sprite: str,
    index: float,
    x: float,
    y: float,
    xscale: float = 1.0,
    yscale: float = 1.0,
    angle: float = 0.0,
    color: Any = None,
    alpha: float = 1.0,
) -> None:
    runtime.require_game().draw_sprite(sprite, index, x, y, xscale, yscale, angle, color, alpha)


def draw_text(x: float, y: float, text: Any, color: Any = None) -> None:
    runtime.require_game().draw_text(x, y, text, color)


def draw_rectangle(x1: float, y1: float, x2: float, y2: float, outline: bool = False) -> None:
    runtime.require_game().draw_rectangle(x1, y1, x2, y2, outline)


def draw_line(x1: float, y1: float, x2: float, y2: float, width: float = 1.0) -> None:
    runtime.require_game().draw_line(x1, y1, x2, y2, width)


def draw_circle(x: float, y: float, radius: float, outline: bool = False) -> None:
    runtime.require_game().draw_circle(x, y, radius, outline)


def string_width(text: str) -> float:
    return runtime.require_game().font.measure(str(text))[0]


def string_height(text: str) -> float:
    return runtime.require_game().font.measure(str(text))[1]


# -- maths --------------------------------------------------------------


def point_distance(x1: float, y1: float, x2: float, y2: float) -> float:
    return math.hypot(x2 - x1, y2 - y1)


def point_direction(x1: float, y1: float, x2: float, y2: float) -> float:
    """Degrees counter-clockwise from the +x axis, matching GameMaker."""
    return math.degrees(math.atan2(-(y2 - y1), x2 - x1)) % 360


def lengthdir_x(length: float, direction: float) -> float:
    return math.cos(math.radians(direction)) * length


def lengthdir_y(length: float, direction: float) -> float:
    return -math.sin(math.radians(direction)) * length


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def lerp(a: float, b: float, amount: float) -> float:
    return a + (b - a) * amount


def approach(value: float, target: float, amount: float) -> float:
    """Move `value` towards `target` by at most `amount`."""
    if value < target:
        return min(value + amount, target)
    return max(value - amount, target)


def sign(value: float) -> int:
    return (value > 0) - (value < 0)


def choose(*options: Any) -> Any:
    if len(options) == 1 and isinstance(options[0], (list, tuple)):
        options = tuple(options[0])
    return _random.choice(options)


def irandom(maximum: int) -> int:
    """Random integer from 0 to `maximum` inclusive."""
    return _random.randint(0, maximum)


def irandom_range(low: int, high: int) -> int:
    return _random.randint(low, high)


def random_range(low: float, high: float) -> float:
    return _random.uniform(low, high)


def angle_difference(a: float, b: float) -> float:
    """Shortest signed turn from `b` to `a`, in degrees."""
    return ((a - b + 180) % 360) - 180


def wrap(value: float, low: float, high: float) -> float:
    span = high - low
    if span <= 0:
        return low
    return low + (value - low) % span


def shuffled(items: Sequence[Any]) -> list[Any]:
    copy = list(items)
    _random.shuffle(copy)
    return copy
