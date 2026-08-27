"""Holds the running game so the module-level API can find it.

Kept in its own module with no imports of its own, so every other module can
depend on it without creating an import cycle.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:  # pragma: no cover
    from .game import Game

game: Optional["Game"] = None


def require_game() -> "Game":
    if game is None:
        raise RuntimeError(
            "No game is running. Engine functions can only be called from inside "
            "object events while the game loop is active."
        )
    return game
