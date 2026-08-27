# obj_level -- the level spawner, placed once in rm_play (not persistent, so a
# room_restart rebuilds it from the run request).
#
# create: decodes gd.run["data"], writes the blocks into lay_play, spawns the
# columns around start_col and creates the player there if the room has none.
# step: streams objects for the columns within the view + SPAWN_AHEAD and
# destroys those SPAWN_BEHIND behind (see gd_level.spawner_step). Practice
# respawns call reset_window(spawner, col) from run.py.

_RS = game.GetService("ReplicatedStorage")


def _fallback_data():
    """Built-in level 1 when nothing requested a run (rm_play entered directly)."""
    builtin = globals().get("BUILTIN")
    if builtin:
        return builtin[0]["data"]
    return "GD1;name=Empty;len=%d|" % MIN_LEN


def create(self):
    self.visible = False
    run = gd_run()
    if run is None:
        run = gd_set_run("play", _fallback_data())
    self.run = run
    try:
        level = decode_level(run.get("data", ""))
    except ValueError:
        level = decode_level(_fallback_data())
    self.start_col = int(run.get("start_col", 0) or 0)

    view_set_size(VIEW_W, VIEW_H)
    view_set(cell_x(self.start_col) - CAMERA_X, ROOM_H - VIEW_H)

    self.tile_sync = sync_layer(LAYER_PLAY, level_tiles(level))
    _RS.Set(TILE_SYNC_KEY, self.tile_sync)

    spawner_init(self, level, self.start_col)
    set_bounds(FLOOR_Y, CEIL_Y, finish_x(level))
    reset_window(self, self.start_col)
    self.player = ensure_player(self.start_col)


def step(self):
    spawner_step(self)


def destroy(self):
    spawner_clear(self)
