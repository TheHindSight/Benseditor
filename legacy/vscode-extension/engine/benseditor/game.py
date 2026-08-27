"""The game loop: instances, event dispatch, rooms and drawing."""

from __future__ import annotations

import math
from typing import Any, Optional, Type

import moderngl
from PIL import Image

from . import runtime
from .assets import ProjectAssets, RoomAsset, SpriteAsset
from .atlas import AtlasBuilder
from .colors import to_rgba
from .font import build_font
from .gameobject import GameObject
from .input import InputState
from .renderer import Renderer

WHITE_KEY = ("white",)


class Game:
    """Owns every instance and drives one step per frame."""

    def __init__(self, project: ProjectAssets, ctx: moderngl.Context) -> None:
        self.project = project
        self.ctx = ctx
        self.fps = project.fps
        self.input = InputState()

        self.view_width: int = project.window["width"]
        self.view_height: int = project.window["height"]
        self.view_x = 0.0
        self.view_y = 0.0

        self.room: Optional[RoomAsset] = None
        self.room_speed = project.fps
        self.instances: list[GameObject] = []
        self._pending_add: list[GameObject] = []
        self._next_id = 1
        self._room_change: Optional[str] = None
        self._quit = False

        self.draw_color: Any = (255, 255, 255)
        self.draw_alpha: float = 1.0
        self._in_gui_pass = False

        # Sized for low-resolution rooms; roughly matches GameMaker's default.
        self.font = build_font(size=12)
        self.renderer = self._build_renderer()

        runtime.game = self

    # -- setup ----------------------------------------------------------

    def _build_renderer(self) -> Renderer:
        builder = AtlasBuilder()
        builder.add(WHITE_KEY, Image.new("RGBA", (1, 1), (255, 255, 255, 255)))

        for sprite in self.project.sprites.values():
            for index, frame in enumerate(sprite.frames):
                builder.add(("sprite", sprite.name, index), frame)

        for character, glyph in self.font.glyphs.items():
            builder.add(("glyph", character), glyph.image)

        atlas_image, entries = builder.build()
        return Renderer(self.ctx, atlas_image, entries, WHITE_KEY)

    # -- object metadata -------------------------------------------------

    def object_class(self, name: str) -> Type[GameObject]:
        asset = self.project.objects.get(name)
        if asset is None:
            raise KeyError(f"No object named {name!r} in this project")
        return asset.cls

    def object_is_a(self, cls: Type[GameObject], name: str) -> bool:
        """Match by Python inheritance or by the declared `parent` chain."""
        for base in cls.__mro__:
            if getattr(base, "object_name", None) == name:
                return True

        current = getattr(cls, "object_name", None)
        seen: set[str] = set()
        while current and current not in seen:
            if current == name:
                return True
            seen.add(current)
            asset = self.project.objects.get(current)
            current = asset.parent if asset else None
        return False

    def instances_matching(self, obj: Any) -> list[GameObject]:
        """Resolve `all`, an object name, a class or an instance to instances."""
        if obj is all or obj is None:
            return list(self.instances)
        if isinstance(obj, GameObject):
            return [obj]
        if isinstance(obj, type):
            obj = getattr(obj, "object_name", None)
        if isinstance(obj, str):
            return [inst for inst in self.instances if self.object_is_a(type(inst), obj)]
        raise TypeError(f"Cannot interpret {obj!r} as an object selector")

    # -- instance lifecycle ---------------------------------------------

    def create_instance(
        self, x: float, y: float, obj: Any, *, run_create: bool = True
    ) -> GameObject:
        cls = obj if isinstance(obj, type) else self.object_class(obj)
        instance = cls(x, y)
        instance.id = self._next_id
        self._next_id += 1

        sprite = instance.sprite_index
        if isinstance(sprite, SpriteAsset):
            # Play at the sprite's authored frame rate by default.
            instance.image_speed = sprite.fps / max(1, self.room_speed)

        self._pending_add.append(instance)
        if run_create:
            self._dispatch(instance, "create")
        return instance

    def destroy_instance(self, instance: GameObject) -> None:
        if instance._destroyed:
            return
        instance._destroyed = True
        self._dispatch(instance, "destroy")

    def _absorb_pending(self) -> None:
        if self._pending_add:
            self.instances.extend(self._pending_add)
            self._pending_add.clear()
        if any(inst._destroyed for inst in self.instances):
            self.instances = [inst for inst in self.instances if not inst._destroyed]

    @staticmethod
    def _dispatch(instance: GameObject, event: str, *args: Any) -> None:
        handler = getattr(instance, event, None)
        if handler is not None:
            handler(*args)

    def _live(self) -> list[GameObject]:
        return [inst for inst in self.instances if not inst._destroyed]

    # -- rooms ------------------------------------------------------------

    def goto_room(self, name: str) -> None:
        """Queue a room change; it takes effect at the end of the current step."""
        if name not in self.project.rooms:
            raise KeyError(f"No room named {name!r} in this project")
        self._room_change = name

    def restart_room(self) -> None:
        if self.room:
            self._room_change = self.room.name

    def _enter_room(self, name: str) -> None:
        if self.room is not None:
            for instance in self._live():
                self._dispatch(instance, "room_end")

        # Persistent instances survive the transition, as in GameMaker.
        survivors = [
            inst
            for inst in self._live()
            if getattr(type(inst), "persistent", False)
        ]
        self.instances = survivors
        self._pending_add.clear()

        room = self.project.rooms[name]
        self.room = room
        self.view_width = room.width
        self.view_height = room.height
        self.view_x = 0.0
        self.view_y = 0.0

        for placement in room.instances:
            if placement.object not in self.project.objects:
                continue
            instance = self.create_instance(placement.x, placement.y, placement.object, run_create=False)
            instance.image_xscale = placement.xscale
            instance.image_yscale = placement.yscale
            instance.image_angle = placement.angle
            instance.xstart = placement.x
            instance.ystart = placement.y

        self._absorb_pending()
        for instance in self._live():
            self._dispatch(instance, "create")
        self._absorb_pending()
        for instance in self._live():
            self._dispatch(instance, "room_start")
        self._absorb_pending()

    def start(self) -> None:
        self._enter_room(self.project.start_room)

    def quit(self) -> None:
        self._quit = True

    def shutdown(self) -> None:
        """Fire room_end and destroy on the way out, so objects can clean up."""
        for event in ("room_end", "destroy"):
            for instance in self._live():
                try:
                    self._dispatch(instance, event)
                except Exception:  # pragma: no cover - never block shutdown
                    import traceback

                    traceback.print_exc()
        self.instances.clear()

    @property
    def should_quit(self) -> bool:
        return self._quit

    # -- the step ---------------------------------------------------------

    def step(self) -> None:
        self._absorb_pending()

        for instance in self._live():
            self._dispatch(instance, "step_begin")
        self._absorb_pending()

        self._run_alarms()
        self._absorb_pending()

        for instance in self._live():
            self._dispatch(instance, "step")
        self._absorb_pending()

        self._apply_movement()
        self._run_collisions()
        self._absorb_pending()

        for instance in self._live():
            self._dispatch(instance, "step_end")
        self._absorb_pending()

        self._advance_animation()
        self._absorb_pending()

        self.input.end_step()

        if self._room_change is not None:
            target, self._room_change = self._room_change, None
            self._enter_room(target)

    def _run_alarms(self) -> None:
        for instance in self._live():
            for index, value in enumerate(instance.alarms):
                if value < 0:
                    continue
                value -= 1
                instance.alarms[index] = value
                if value == 0:
                    instance.alarms[index] = -1
                    self._dispatch(instance, "alarm", index)

    def _apply_movement(self) -> None:
        for instance in self._live():
            instance.xprevious = instance.x
            instance.yprevious = instance.y

            if instance.gravity:
                radians = math.radians(instance.gravity_direction)
                instance.hspeed += math.cos(radians) * instance.gravity
                instance.vspeed -= math.sin(radians) * instance.gravity

            if instance.friction:
                speed = math.hypot(instance.hspeed, instance.vspeed)
                if speed > 0:
                    reduced = max(0.0, speed - instance.friction)
                    scale = reduced / speed
                    instance.hspeed *= scale
                    instance.vspeed *= scale

            instance.x += instance.hspeed
            instance.y += instance.vspeed

    def _run_collisions(self) -> None:
        # Only instances that actually handle collisions are tested.
        actors = [inst for inst in self._live() if getattr(inst, "collision", None) is not None]
        if not actors:
            return

        others = self._live()
        for actor in actors:
            if actor._destroyed:
                continue
            box = actor.bbox()
            for other in others:
                if other is actor or other._destroyed or actor._destroyed:
                    continue
                other_box = other.bbox()
                if (
                    box[0] < other_box[2]
                    and other_box[0] < box[2]
                    and box[1] < other_box[3]
                    and other_box[1] < box[3]
                ):
                    self._dispatch(actor, "collision", other)

    def _advance_animation(self) -> None:
        for instance in self._live():
            sprite = instance.sprite_index
            if not isinstance(sprite, SpriteAsset) or len(sprite.frames) <= 1:
                continue
            if not instance.image_speed:
                continue
            instance.image_index += instance.image_speed
            if instance.image_index >= len(sprite.frames):
                instance.image_index %= len(sprite.frames)
                self._dispatch(instance, "animation_end")
            elif instance.image_index < 0:
                instance.image_index %= len(sprite.frames)
                self._dispatch(instance, "animation_end")

    # -- drawing ----------------------------------------------------------

    def draw(self) -> None:
        room = self.room
        background = to_rgba(room.background_color if room else "#000000")
        self.ctx.clear(background[0], background[1], background[2], 1.0)

        ordered = sorted(self._live(), key=lambda inst: -inst.depth)

        self.renderer.set_viewport(self.view_width, self.view_height, self.view_x, self.view_y)
        self.renderer.begin()
        self._in_gui_pass = False
        for instance in ordered:
            handler = getattr(instance, "draw", None)
            if handler is not None:
                handler()
            elif instance.visible:
                self.render_instance(instance)
        self.renderer.flush()

        gui_drawers = [inst for inst in ordered if getattr(inst, "draw_gui", None) is not None]
        if gui_drawers:
            self.renderer.set_viewport(self.view_width, self.view_height)
            self.renderer.begin()
            self._in_gui_pass = True
            for instance in gui_drawers:
                instance.draw_gui()
            self.renderer.flush()
            self._in_gui_pass = False

    def sprite_entry(self, sprite: SpriteAsset, index: float):
        frame = int(index) % len(sprite.frames)
        return self.renderer.entries[("sprite", sprite.name, frame)]

    def render_instance(self, instance: GameObject) -> None:
        sprite = instance.sprite_index
        if not isinstance(sprite, SpriteAsset):
            return
        entry = self.sprite_entry(sprite, instance.image_index)
        color = to_rgba(instance.image_blend, instance.image_alpha)
        self.renderer.draw_entry(
            entry,
            instance.x,
            instance.y,
            sprite.origin_x,
            sprite.origin_y,
            instance.image_xscale,
            instance.image_yscale,
            instance.image_angle,
            color,
        )

    def draw_sprite(
        self,
        sprite_name: str,
        index: float,
        x: float,
        y: float,
        xscale: float = 1.0,
        yscale: float = 1.0,
        angle: float = 0.0,
        color: Any = None,
        alpha: float = 1.0,
    ) -> None:
        sprite = self.project.sprites.get(sprite_name)
        if sprite is None:
            raise KeyError(f"No sprite named {sprite_name!r} in this project")
        entry = self.sprite_entry(sprite, index)
        self.renderer.draw_entry(
            entry,
            x,
            y,
            sprite.origin_x,
            sprite.origin_y,
            xscale,
            yscale,
            angle,
            to_rgba(color if color is not None else (255, 255, 255), alpha),
        )

    def draw_text(self, x: float, y: float, text: str, color: Any = None, alpha: float = None) -> None:
        rgba = to_rgba(
            color if color is not None else self.draw_color,
            self.draw_alpha if alpha is None else alpha,
        )
        pen_x = x
        pen_y = y
        for character in str(text):
            if character == "\n":
                pen_x = x
                pen_y += self.font.line_height
                continue
            glyph = self.font.glyphs.get(character)
            if glyph is None:
                pen_x += self.font.line_height * 0.5
                continue
            entry = self.renderer.entries[("glyph", character)]
            self.renderer.draw_entry(entry, pen_x, pen_y, 0, 0, 1.0, 1.0, 0.0, rgba)
            pen_x += glyph.advance

    def draw_rectangle(
        self, x1: float, y1: float, x2: float, y2: float, outline: bool = False, color: Any = None
    ) -> None:
        rgba = to_rgba(color if color is not None else self.draw_color, self.draw_alpha)
        left, right = min(x1, x2), max(x1, x2)
        top, bottom = min(y1, y2), max(y1, y2)
        if outline:
            self.draw_line(left, top, right, top, 1, color)
            self.draw_line(right, top, right, bottom, 1, color)
            self.draw_line(right, bottom, left, bottom, 1, color)
            self.draw_line(left, bottom, left, top, 1, color)
        else:
            self.renderer.draw_rectangle(left, top, right - left, bottom - top, rgba)

    def draw_line(
        self, x1: float, y1: float, x2: float, y2: float, width: float = 1.0, color: Any = None
    ) -> None:
        rgba = to_rgba(color if color is not None else self.draw_color, self.draw_alpha)
        self.renderer.draw_line(x1, y1, x2, y2, width, rgba)

    def draw_circle(
        self, x: float, y: float, radius: float, outline: bool = False, color: Any = None, segments: int = 24
    ) -> None:
        rgba = to_rgba(color if color is not None else self.draw_color, self.draw_alpha)
        points = [
            (
                x + math.cos(2 * math.pi * i / segments) * radius,
                y + math.sin(2 * math.pi * i / segments) * radius,
            )
            for i in range(segments)
        ]
        if outline:
            for i in range(segments):
                x1, y1 = points[i]
                x2, y2 = points[(i + 1) % segments]
                self.renderer.draw_line(x1, y1, x2, y2, 1.0, rgba)
        else:
            # Triangle fan from the centre.
            for i in range(segments):
                self.renderer.draw_triangle(
                    (x, y), points[i], points[(i + 1) % segments], rgba
                )
