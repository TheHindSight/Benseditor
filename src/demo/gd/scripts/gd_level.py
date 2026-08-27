# gd_level -- the run hand-off, object spawning and the streaming window.
#
# Run contract (ReplicatedStorage): gd.run = {mode: play|test|verify, source,
# level_id, data, start_col, return_to}; gd.result = {finished, attempts,
# practice_used, coins, best_pct}. The spawner object (obj_level) is thin --
# the streaming logic lives here so run.py can call reset_window(spawner, col)
# after a checkpoint respawn. Depends on gd_const, gd_codec, gd_tiles.

_RS = game.GetService("ReplicatedStorage")

RUN_KEY = "gd.run"
RESULT_KEY = "gd.result"
LEVEL_KEY = "gd.level"
FINISH_KEY = "gd.finish_x"
TILE_SYNC_KEY = "gd.tiles_sync"

# The finish is a virtual object at column len (not part of the level data).
FINISH_CODE = "F"


def gd_run():
    """The current run request, or None. Accepts both a flat "gd.run" key and
    a "gd" dict holding "run"."""
    run = _RS.Get(RUN_KEY)
    if isinstance(run, dict):
        return run
    gd = _RS.Get("gd")
    if isinstance(gd, dict) and isinstance(gd.get("run"), dict):
        return gd["run"]
    return None


def gd_set_run(mode, data, source="builtin", level_id="", start_col=0, return_to="rm_menu"):
    run = {
        "mode": mode,
        "source": source,
        "level_id": level_id,
        "data": data,
        "start_col": int(start_col),
        "return_to": return_to,
    }
    _RS.Set(RUN_KEY, run)
    return run


def gd_set_result(finished, attempts, practice_used, coins, best_pct):
    result = {
        "finished": bool(finished),
        "attempts": int(attempts),
        "practice_used": bool(practice_used),
        "coins": list(coins) if coins is not None else [False] * MAX_COINS,
        "best_pct": int(best_pct),
    }
    _RS.Set(RESULT_KEY, result)
    return result


def gd_result():
    result = _RS.Get(RESULT_KEY)
    return result if isinstance(result, dict) else None


def finish_col(level):
    return int(level.get("len", 0))


def finish_x(level):
    """Room x of the finish line: the centre of column len."""
    return cell_x(finish_col(level))


def set_bounds(floor_y, ceil_y, end_x=None):
    """Tell the physics where the level's floor, ceiling and end are, if it is
    loaded. Shared-script globals are copied per module, so the value has to be
    set through a setter or on gdphys's own namespace."""
    setter = globals().get("gd_set_bounds")
    if setter is not None:
        setter(floor_y, ceil_y, end_x)
        return True
    try:
        module = require("gdphys")
    except Exception:
        return False
    namespace = getattr(module, "_namespace", None)
    if isinstance(namespace, dict):
        if "gd_floor_y" in namespace:
            namespace["gd_floor_y"] = floor_y
        if "gd_ceil_y" in namespace:
            namespace["gd_ceil_y"] = ceil_y
        if end_x is not None and "gd_end_x" in namespace:
            namespace["gd_end_x"] = end_x
        return True
    return False


def flip_for(code, param, col, row, tiles):
    """+1 or -1 for image_yscale: down spikes hang; a pad hangs when a block
    sits directly above it and none below (it is glued to a ceiling)."""
    if code == "S":
        return -1 if param == "1" else 1
    if code == "P":
        above = (col, tile_y(row + 1)) in tiles if row + 1 < ROWS else True
        below = (col, tile_y(row - 1)) in tiles if row >= 1 else True
        if above and not below:
            return -1
    return 1


def _create(x, y, object_name):
    """instance_create that returns None when the object is not part of the project."""
    try:
        return instance_create(x, y, object_name)
    except ValueError as error:
        if "no object named" in str(error):
            return None
        raise


def spawn_object(code, param, col, row, tiles=None):
    """Create the instance for one level object; blocks are tiles and give None."""
    info = TYPES.get(code)
    if info is None or info["object"] is None:
        return None
    inst = _create(cell_x(col), cell_y(row), info["object"])
    if inst is None:
        return None
    if code in ("P", "O"):
        inst.kind = param
    else:
        inst.kind = int(param) if param != "" else 0
    inst.col = col
    inst.row = row
    inst.code = code
    inst.param = param
    if code == "C":
        inst.index = int(param)
    flip = flip_for(code, param, col, row, tiles if tiles is not None else {})
    inst.flipped = flip < 0
    if flip < 0:
        inst.image_yscale = -abs(inst.image_yscale) if inst.image_yscale else -1
    return inst


# ---- the streaming window -----------------------------------------------------
#
# The spawner instance carries: level, columns, tiles, live {col: [inst]},
# spawned {key: count}, next_col, lo, start_col, finish_spawned.


def spawner_init(spawner, level, start_col=0):
    spawner.level = level
    spawner.columns = level_columns(level)
    spawner.tiles = level_tiles(level)
    spawner.finish_col = finish_col(level)
    spawner.start_col = int(start_col)
    spawner.live = {}
    spawner.spawned = {}
    spawner.total_spawned = 0
    spawner.next_col = 0
    spawner.lo = 0
    spawner.hi = -1
    _RS.Set(LEVEL_KEY, level)
    _RS.Set(FINISH_KEY, finish_x(level))


def spawner_live_count(spawner):
    count = 0
    for col in spawner.live:
        count += len(spawner.live[col])
    return count


def _window(view_x, view_w):
    lo = col_at(view_x) - SPAWN_BEHIND
    hi = col_at(view_x + view_w - 1) + SPAWN_AHEAD
    return max(0, lo), min(MAX_COLUMNS - 1, hi)


def _spawn_column(spawner, col):
    made = []
    bucket = spawner.columns.get(col)
    if bucket:
        for row, code, param in bucket:
            inst = spawn_object(code, param, col, row, spawner.tiles)
            k = key(col, row)
            spawner.spawned[k] = spawner.spawned.get(k, 0) + 1
            if inst is not None:
                made.append(inst)
    if col == spawner.finish_col:
        inst = _create(finish_x(spawner.level), cell_y(0), "obj_finish")
        if inst is not None:
            inst.col = col
            inst.code = FINISH_CODE
            made.append(inst)
        k = key(col, 0)
        spawner.spawned[k] = spawner.spawned.get(k, 0) + 1
    if made:
        spawner.live[col] = made
        spawner.total_spawned += len(made)


def _destroy_column(spawner, col):
    made = spawner.live.get(col)
    if made is None:
        return
    for inst in made:
        inst.destroy()
    del spawner.live[col]


def spawner_clear(spawner):
    for col in list(spawner.live.keys()):
        _destroy_column(spawner, col)
    spawner.live = {}


def reset_window(spawner, col):
    """Rebuild the live set around a column (a restart or a checkpoint respawn):
    everything is destroyed and the columns the view at `col` shows, plus the
    look-ahead, are spawned fresh."""
    spawner_clear(spawner)
    lo, hi = _window(cell_x(col) - CAMERA_X, view_width() or VIEW_W)
    for c in range(lo, hi + 1):
        _spawn_column(spawner, c)
    spawner.lo = lo
    spawner.hi = hi
    spawner.next_col = hi + 1


def spawner_step(spawner):
    """Advance the window to the current view: spawn newly visible columns,
    destroy the ones left behind, rebuild if the view jumped backwards."""
    view_x, _view_y = view_get()
    lo, hi = _window(view_x, view_width() or VIEW_W)
    if lo < spawner.lo - 1:
        reset_window(spawner, col_at(view_x) + SPAWN_BEHIND + 2)
        return
    if hi >= spawner.next_col:
        for c in range(spawner.next_col, hi + 1):
            _spawn_column(spawner, c)
        spawner.next_col = hi + 1
        spawner.hi = hi
    if lo > spawner.lo:
        for c in range(spawner.lo, lo):
            _destroy_column(spawner, c)
        spawner.lo = lo


def ensure_player(start_col):
    """The run's player, created at the start column when the room has none."""
    if instance_exists("obj_player"):
        return instance_find("obj_player")
    return _create(cell_x(start_col), cell_y(0), "obj_player")
