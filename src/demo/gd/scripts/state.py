# state: the persistent obj_game holder, created on demand by whichever scene
# runs first. It is never placed in a room.

GAME_OBJECT = "obj_game"


def state_ensure_game():
    """The single obj_game instance, created if this is the first scene."""
    try:
        found = instance_find(GAME_OBJECT)
    except Exception:
        found = None
    if found is not None:
        return found
    try:
        return instance_create(0, 0, GAME_OBJECT)
    except Exception:
        return None


def state_goto(room, fallback=None):
    """room_goto that survives a missing room (a scene not in this project)."""
    try:
        room_goto(room)
        return True
    except Exception:
        if fallback is not None:
            try:
                room_goto(fallback)
                return True
            except Exception:
                pass
    return False
