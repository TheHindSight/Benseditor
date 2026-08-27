"""The GameObject base class.

Subclass it in an object's script and define event methods -- `create`, `step`,
`draw`, `collision` and friends. The engine calls whichever ones exist; there is
no need to implement events you do not use.
"""

from __future__ import annotations

import math
from typing import Any, Optional

from . import runtime

ALARM_COUNT = 12


class GameObject:
    # Filled in from the .bobject definition when the project loads.
    object_name: str = "GameObject"
    sprite_index: Any = None
    depth: int = 0
    visible: bool = True
    solid: bool = False
    persistent: bool = False
    parent_name: Optional[str] = None

    def __init__(self, x: float = 0.0, y: float = 0.0) -> None:
        cls = type(self)
        self.id: int = 0
        self.x = float(x)
        self.y = float(y)
        self.xstart = self.x
        self.ystart = self.y
        self.xprevious = self.x
        self.yprevious = self.y

        self.hspeed = 0.0
        self.vspeed = 0.0
        self.gravity = 0.0
        self.gravity_direction = 270.0
        self.friction = 0.0

        self.sprite_index = cls.sprite_index
        self.image_index = 0.0
        self.image_speed = 1.0
        self.image_xscale = 1.0
        self.image_yscale = 1.0
        self.image_angle = 0.0
        self.image_alpha = 1.0
        self.image_blend: Any = (255, 255, 255)

        self.visible = cls.visible
        self.solid = cls.solid
        self.depth = cls.depth
        # Countdowns in steps; -1 means off. Set one with `self.alarms[0] = 30`,
        # then handle it with `def alarm(self, index)`. The plural spelling keeps
        # the list from shadowing the event method.
        self.alarms = [-1] * ALARM_COUNT

        self._destroyed = False

    # -- identity -------------------------------------------------------

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"<{self.object_name} id={self.id} at ({self.x:.1f}, {self.y:.1f})>"

    def is_a(self, name: str) -> bool:
        """True if this instance is `name` or descends from it via `parent`."""
        return runtime.require_game().object_is_a(type(self), name)

    # -- movement -------------------------------------------------------

    @property
    def speed(self) -> float:
        return math.hypot(self.hspeed, self.vspeed)

    @speed.setter
    def speed(self, value: float) -> None:
        direction = self.direction
        radians = math.radians(direction)
        self.hspeed = math.cos(radians) * value
        self.vspeed = -math.sin(radians) * value

    @property
    def direction(self) -> float:
        """Degrees counter-clockwise, 0 = right (GameMaker convention)."""
        if self.hspeed == 0 and self.vspeed == 0:
            return 0.0
        return math.degrees(math.atan2(-self.vspeed, self.hspeed)) % 360

    @direction.setter
    def direction(self, value: float) -> None:
        magnitude = self.speed
        radians = math.radians(value)
        self.hspeed = math.cos(radians) * magnitude
        self.vspeed = -math.sin(radians) * magnitude

    def move_towards_point(self, x: float, y: float, speed: float) -> None:
        angle = math.atan2(-(y - self.y), x - self.x)
        self.hspeed = math.cos(angle) * speed
        self.vspeed = -math.sin(angle) * speed

    def distance_to_point(self, x: float, y: float) -> float:
        return math.hypot(x - self.x, y - self.y)

    def distance_to_object(self, other: "GameObject") -> float:
        return math.hypot(other.x - self.x, other.y - self.y)

    # -- sprite metrics -------------------------------------------------

    @property
    def sprite_width(self) -> float:
        return self.sprite_index.width * self.image_xscale if self.sprite_index else 0.0

    @property
    def sprite_height(self) -> float:
        return self.sprite_index.height * self.image_yscale if self.sprite_index else 0.0

    @property
    def image_number(self) -> int:
        return len(self.sprite_index.frames) if self.sprite_index else 0

    def bbox(self) -> tuple[float, float, float, float]:
        """Collision rectangle in room space: (left, top, right, bottom)."""
        sprite = self.sprite_index
        if sprite is None:
            return (self.x - 1, self.y - 1, self.x + 1, self.y + 1)

        mask = sprite.collision
        x1 = self.x + (mask.left - sprite.origin_x) * self.image_xscale
        x2 = self.x + (mask.right + 1 - sprite.origin_x) * self.image_xscale
        y1 = self.y + (mask.top - sprite.origin_y) * self.image_yscale
        y2 = self.y + (mask.bottom + 1 - sprite.origin_y) * self.image_yscale
        # Negative scales flip the rectangle; normalise so left <= right.
        return (min(x1, x2), min(y1, y2), max(x1, x2), max(y1, y2))

    @property
    def bbox_left(self) -> float:
        return self.bbox()[0]

    @property
    def bbox_top(self) -> float:
        return self.bbox()[1]

    @property
    def bbox_right(self) -> float:
        return self.bbox()[2]

    @property
    def bbox_bottom(self) -> float:
        return self.bbox()[3]

    # -- collision helpers ----------------------------------------------

    def place_meeting(self, x: float, y: float, obj: Any) -> bool:
        return self.instance_place(x, y, obj) is not None

    def instance_place(self, x: float, y: float, obj: Any) -> Optional["GameObject"]:
        """First instance of `obj` overlapping this one when moved to (x, y)."""
        game = runtime.require_game()
        old_x, old_y = self.x, self.y
        self.x, self.y = x, y
        try:
            box = self.bbox()
            for other in game.instances_matching(obj):
                if other is self or other._destroyed:
                    continue
                if _overlaps(box, other.bbox()):
                    return other
        finally:
            self.x, self.y = old_x, old_y
        return None

    def instance_place_list(self, x: float, y: float, obj: Any) -> list["GameObject"]:
        game = runtime.require_game()
        old_x, old_y = self.x, self.y
        self.x, self.y = x, y
        try:
            box = self.bbox()
            return [
                other
                for other in game.instances_matching(obj)
                if other is not self and not other._destroyed and _overlaps(box, other.bbox())
            ]
        finally:
            self.x, self.y = old_x, old_y

    def move_contact(self, obj: Any, dx: float, dy: float, max_steps: int = 64) -> None:
        """Step towards (dx, dy) one unit at a time, stopping before a collision."""
        length = math.hypot(dx, dy)
        if length == 0:
            return
        step_x = dx / length
        step_y = dy / length
        for _ in range(min(max_steps, int(math.ceil(length)))):
            if self.place_meeting(self.x + step_x, self.y + step_y, obj):
                return
            self.x += step_x
            self.y += step_y

    # -- drawing --------------------------------------------------------

    def draw_self(self) -> None:
        """Draw this instance's sprite with its current image_* properties."""
        runtime.require_game().render_instance(self)

    # -- lifecycle ------------------------------------------------------

    def destroy(self) -> None:
        runtime.require_game().destroy_instance(self)

    @property
    def destroyed(self) -> bool:
        return self._destroyed


def _overlaps(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]
