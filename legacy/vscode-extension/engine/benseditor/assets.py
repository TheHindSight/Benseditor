"""Loading a Benseditor project from disk."""

from __future__ import annotations

import base64
import importlib.util
import io
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Type

from PIL import Image

from .gameobject import GameObject


@dataclass
class CollisionMask:
    mode: str = "rect"
    left: int = 0
    top: int = 0
    right: int = 0
    bottom: int = 0


@dataclass
class SpriteAsset:
    name: str
    width: int
    height: int
    origin_x: int
    origin_y: int
    fps: int
    frames: list[Image.Image]
    collision: CollisionMask


@dataclass
class ObjectAsset:
    name: str
    sprite: str | None
    depth: int
    visible: bool
    solid: bool
    persistent: bool
    parent: str | None
    cls: Type[GameObject]


@dataclass
class RoomInstanceDef:
    object: str
    x: float
    y: float
    xscale: float = 1.0
    yscale: float = 1.0
    angle: float = 0.0


@dataclass
class RoomAsset:
    name: str
    width: int
    height: int
    background_color: str
    instances: list[RoomInstanceDef] = field(default_factory=list)


@dataclass
class ProjectAssets:
    root: Path
    name: str
    fps: int
    window: dict[str, Any]
    start_room: str
    sprites: dict[str, SpriteAsset]
    objects: dict[str, ObjectAsset]
    rooms: dict[str, RoomAsset]


class ProjectError(RuntimeError):
    """Raised when a project cannot be loaded."""


def load_project(root: Path) -> ProjectAssets:
    root = Path(root).resolve()
    config_path = root / "benseditor.json"
    if not config_path.exists():
        raise ProjectError(f"No benseditor.json found in {root}")

    config = _read_json(config_path)

    # User scripts live in scripts/ and are importable by object code.
    scripts_dir = root / "scripts"
    for path in (scripts_dir, root):
        entry = str(path)
        if path.exists() and entry not in sys.path:
            sys.path.insert(0, entry)

    sprites = {}
    for path in sorted((root / "sprites").glob("*.bsprite")):
        sprite = _load_sprite(path)
        sprites[sprite.name] = sprite

    objects = {}
    for path in sorted((root / "objects").glob("*.bobject")):
        asset = _load_object(path)
        objects[asset.name] = asset

    _bind_definitions(objects, sprites)

    rooms = {}
    for path in sorted((root / "rooms").glob("*.broom")):
        room = _load_room(path)
        _check_room_references(room, objects)
        rooms[room.name] = room

    if not rooms:
        raise ProjectError("This project has no rooms. Create one before running.")

    start_room = config.get("startRoom") or next(iter(rooms))
    if start_room not in rooms:
        raise ProjectError(
            f"Start room {start_room!r} does not exist. "
            f"Available rooms: {', '.join(sorted(rooms))}"
        )

    window = config.get("window") or {}
    return ProjectAssets(
        root=root,
        name=config.get("name", root.name),
        fps=int(config.get("fps", 60)),
        window={
            "width": int(window.get("width", 640)),
            "height": int(window.get("height", 360)),
            "scale": int(window.get("scale", 1)),
            "title": window.get("title", config.get("name", root.name)),
        },
        start_room=start_room,
        sprites=sprites,
        objects=objects,
        rooms=rooms,
    )


def _bind_definitions(
    objects: dict[str, ObjectAsset], sprites: dict[str, SpriteAsset]
) -> None:
    """Copy each `.bobject` definition onto its Python class.

    Instances read these as class defaults, so this is what connects the object
    editor's settings to the code you write in the object's script.
    """
    for asset in objects.values():
        sprite = None
        if asset.sprite:
            sprite = sprites.get(asset.sprite)
            if sprite is None:
                print(
                    f"warning: object {asset.name} references missing sprite "
                    f"{asset.sprite!r}",
                    file=sys.stderr,
                )

        cls = asset.cls
        cls.object_name = asset.name
        cls.sprite_index = sprite
        cls.depth = asset.depth
        cls.visible = asset.visible
        cls.solid = asset.solid
        cls.persistent = asset.persistent
        cls.parent_name = asset.parent

        if asset.parent and asset.parent not in objects:
            print(
                f"warning: object {asset.name} references missing parent "
                f"{asset.parent!r}",
                file=sys.stderr,
            )


def _check_room_references(room: RoomAsset, objects: dict[str, ObjectAsset]) -> None:
    missing = sorted({inst.object for inst in room.instances if inst.object not in objects})
    if missing:
        print(
            f"warning: room {room.name} places unknown objects: {', '.join(missing)}",
            file=sys.stderr,
        )


def _read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ProjectError(f"{path.name} is not valid JSON: {exc}") from exc


def _load_sprite(path: Path) -> SpriteAsset:
    data = _read_json(path)
    name = data.get("name") or path.stem
    width = int(data.get("width", 32))
    height = int(data.get("height", 32))

    frames: list[Image.Image] = []
    for encoded in data.get("frames") or []:
        if not encoded:
            continue
        try:
            frames.append(
                Image.open(io.BytesIO(base64.b64decode(encoded))).convert("RGBA")
            )
        except Exception as exc:  # pragma: no cover - corrupt asset
            raise ProjectError(f"Sprite {name} has an unreadable frame: {exc}") from exc

    if not frames:
        frames = [Image.new("RGBA", (width, height), (0, 0, 0, 0))]

    collision_data = data.get("collision") or {}
    collision = CollisionMask(
        mode=collision_data.get("mode", "rect"),
        left=int(collision_data.get("left", 0)),
        top=int(collision_data.get("top", 0)),
        right=int(collision_data.get("right", width - 1)),
        bottom=int(collision_data.get("bottom", height - 1)),
    )

    return SpriteAsset(
        name=name,
        width=width,
        height=height,
        origin_x=int(data.get("originX", 0)),
        origin_y=int(data.get("originY", 0)),
        fps=int(data.get("fps", 12)),
        frames=frames,
        collision=collision,
    )


def _load_object(path: Path) -> ObjectAsset:
    data = _read_json(path)
    name = data.get("name") or path.stem
    cls = _load_object_class(path.with_suffix(".py"), name)

    return ObjectAsset(
        name=name,
        sprite=data.get("sprite") or None,
        depth=int(data.get("depth", 0)),
        visible=bool(data.get("visible", True)),
        solid=bool(data.get("solid", False)),
        persistent=bool(data.get("persistent", False)),
        parent=data.get("parent") or None,
        cls=cls,
    )


def _load_object_class(script_path: Path, name: str) -> Type[GameObject]:
    """Import an object's behaviour script and find its GameObject subclass."""
    if not script_path.exists():
        return type(name, (GameObject,), {})

    spec = importlib.util.spec_from_file_location(f"benseditor_objects.{name}", script_path)
    if spec is None or spec.loader is None:
        raise ProjectError(f"Could not import {script_path}")

    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as exc:
        raise ProjectError(f"Error in {script_path.name}: {exc}") from exc

    candidate = getattr(module, name, None)
    if isinstance(candidate, type) and issubclass(candidate, GameObject):
        return candidate

    # Fall back to any GameObject subclass defined in that module.
    for value in vars(module).values():
        if (
            isinstance(value, type)
            and issubclass(value, GameObject)
            and value is not GameObject
            and value.__module__ == spec.name
        ):
            return value

    return type(name, (GameObject,), {})


def _load_room(path: Path) -> RoomAsset:
    data = _read_json(path)
    instances = [
        RoomInstanceDef(
            object=entry["object"],
            x=float(entry.get("x", 0)),
            y=float(entry.get("y", 0)),
            xscale=float(entry.get("xscale", 1)),
            yscale=float(entry.get("yscale", 1)),
            angle=float(entry.get("angle", 0)),
        )
        for entry in data.get("instances") or []
        if entry.get("object")
    ]

    return RoomAsset(
        name=data.get("name") or path.stem,
        width=int(data.get("width", 640)),
        height=int(data.get("height", 360)),
        background_color=data.get("backgroundColor", "#000000"),
        instances=instances,
    )
