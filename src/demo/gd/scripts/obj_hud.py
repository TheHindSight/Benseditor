# obj_hud: lives in rm_play. Owns the camera, drives the run state
# (run_room_start on every room start, run_tick every step), draws the HUD
# and the pause overlay, and shows the death particles the run collects.
#
# Contracts with the player (obj_player, named "player"):
#   player.on_ground   -- read for automatic practice checkpoints
#   player.mode        -- "cube"/"ship"/... chooses the camera behaviour
#   run_input_locked() -- the player ignores input while it returns True
#   run_die / run_coin_touch / run_finish / run_jump -- called by the player

HUD_VIEW_W = 570
HUD_VIEW_H = 330
HUD_LEAD = 150          # the player sits this far from the left edge
HUD_CELL = 30
HUD_FLOOR_ROWS = 2      # floor rows kept in view in ground modes
HUD_SMOOTH = 0.1
HUD_FLYING = ("ship", "ufo", "wave", "swing")
PAUSE_ITEMS = ("Resume", "Practice", "Restart", "Exit")
PAUSE_X = 195
PAUSE_Y = 112
PAUSE_W = 180
PAUSE_H = 26
PAUSE_GAP = 32


def pause_button_rect(index):
    return (PAUSE_X, PAUSE_Y + index * PAUSE_GAP, PAUSE_W, PAUSE_H)


def create(self):
    state_ensure_game()
    self.depth = -900
    self.visible = False
    self.pause_focus = 0
    self.cam_y = None
    self.t = 0


def room_start(self):
    view_set_size(HUD_VIEW_W, HUD_VIEW_H)
    run_room_start(self)
    self.pause_focus = 0
    self.cam_y = None
    _camera(self, True)


def _player(self):
    try:
        return instance_find("obj_player")
    except Exception:
        return None


def _bounds(self):
    # gdphys copies its globals into every object's namespace at load, so a
    # local `gd_floor_y` is the stale default; read the live value from the
    # module the controller set through gd_set_bounds.
    try:
        return require("gdphys").gd_get_bounds()
    except Exception:
        floor_y = globals().get("gd_floor_y")
        if isinstance(floor_y, (int, float)):
            return floor_y, 0, 0
        return room_height() - HUD_FLOOR_ROWS * HUD_CELL, 0, 0


def _floor_y(self):
    return _bounds(self)[0]


def _camera(self, snap):
    player = _player(self)
    x = 0
    if player is not None:
        x = player.x - HUD_LEAD
    x = clamp(x, 0, max(0, room_width() - HUD_VIEW_W))

    ground_y = _floor_y(self) + HUD_FLOOR_ROWS * HUD_CELL - HUD_VIEW_H
    top_limit = max(0, room_height() - HUD_VIEW_H)
    mode = getattr(player, "mode", "cube") if player is not None else "cube"
    if mode in HUD_FLYING and player is not None:
        target = player.y - HUD_VIEW_H / 2
    else:
        target = ground_y
    target = clamp(target, 0, min(top_limit, max(0, ground_y)))
    if snap or self.cam_y is None:
        self.cam_y = target
    else:
        self.cam_y += (target - self.cam_y) * HUD_SMOOTH
    view_set(x, self.cam_y)


def step(self):
    self.t += 1
    ui = ui_begin()
    player = _player(self)

    if keyboard_check_pressed("escape"):
        if run_paused():
            run_resume()
        elif run_pause():
            self.pause_focus = 0

    if run_paused():
        count = len(PAUSE_ITEMS)
        if keyboard_check_pressed("up") or keyboard_check_pressed("w"):
            self.pause_focus = ui_nav(self.pause_focus, count, -1)
        if keyboard_check_pressed("down") or keyboard_check_pressed("s"):
            self.pause_focus = ui_nav(self.pause_focus, count, 1)
        if ui["moved"]:
            for i in range(count):
                x, y, w, h = pause_button_rect(i)
                if ui_hovering(x, y, w, h):
                    self.pause_focus = i

    run_tick(player)


def step_end(self):
    if not run_paused():
        _camera(self, False)


def _pause_action(self, index):
    if index == 0:
        run_resume()
    elif index == 1:
        run_toggle_practice()
    elif index == 2:
        run_restart()
    elif index == 3:
        run_exit_to_menu()


def draw(self):
    s = run_state
    # Practice checkpoints, in room space.
    if s["practice"]:
        for cp in s["checkpoints"]:
            draw_sprite_ext("spr_checkpoint", 0, cp["x"], cp["y"], 1, 1, 0, c_white, 0.8)
    # The explosion and its particles.
    if s["dead"]:
        age = RUN_DEATH_STEPS - s["death_timer"]
        if age < 16:
            draw_sprite_ext("spr_explosion", age // 4, s["death_x"], s["death_y"], 1.5, 1.5, 0, c_white, 1)
    for p in s["particles"]:
        draw_set_color(p["colour"])
        draw_set_alpha(min(1, p["life"] / 12))
        draw_rectangle(p["x"] - 2, p["y"] - 2, p["x"] + 2, p["y"] + 2, False)
    draw_set_alpha(1)


def draw_gui(self):
    s = run_state
    ui = ui_begin()
    if not s["active"] and s["result"] is None:
        return

    # Progress bar and percentage along the top.
    ui_progress(135, 8, 300, 10, s["pct"] / 100)
    ui_text(442, 7, "%d%%" % s["pct"], UI_PALETTE["text"], 1)
    ui_text(8, 7, "Attempt %d" % s["attempts"], UI_PALETTE["text"], 1)

    y = 24
    if s["practice"]:
        ui_badge(8, y, "PRACTICE", UI_PALETTE["good"], 1)
        y += 20
    if s["mode"] == "verify":
        ui_badge(8, y, "VERIFY RUN", UI_PALETTE["warn"], 1)
        y += 20
    elif s["mode"] == "test":
        ui_badge(8, y, "TEST", UI_PALETTE["panel_edge"], 1)
        y += 20
    ui_coins(8, y, s["coins_run"], 1)

    if progress_state["save_failed"]:
        ui_badge(HUD_VIEW_W - 92, 24, "SAVE FAILED", UI_PALETTE["bad"], 1, UI_PALETTE["text"])
    if s["best_pct"] > 0:
        ui_text(HUD_VIEW_W - 8, 7, "best %d%%" % s["best_pct"], UI_PALETTE["text_dim"], 1, "right")

    if s["banner"] > 0 and not s["dead"] and not s["finished"]:
        alpha = min(1, s["banner"] / 30)
        ui_text(HUD_VIEW_W / 2, 100, "Attempt %d" % s["attempts"], UI_PALETTE["accent"], 3, "center", alpha)

    if s["finished"]:
        flash = UI_PALETTE["accent"] if (self.t // 6) % 2 == 0 else UI_PALETTE["good"]
        ui_text(HUD_VIEW_W / 2, 110, "LEVEL COMPLETE", flash, 3, "center")

    if s["message_timer"] > 0:
        ui_text(HUD_VIEW_W / 2, 150, s["message"], UI_PALETTE["warn"], 1, "center")

    if s["practice"] and not s["paused"]:
        ui_text(HUD_VIEW_W / 2, HUD_VIEW_H - 16, "z: checkpoint   x: remove", UI_PALETTE["muted"], 1, "center")

    if s["paused"]:
        ui_panel(0, 0, HUD_VIEW_W, HUD_VIEW_H, 0x000000, None, 0.6)
        ui_panel(PAUSE_X - 24, PAUSE_Y - 44, PAUSE_W + 48, len(PAUSE_ITEMS) * PAUSE_GAP + 56, UI_PALETTE["panel"], UI_PALETTE["panel_edge"])
        ui_text(HUD_VIEW_W / 2, PAUSE_Y - 34, "PAUSED", UI_PALETTE["accent"], 2, "center")
        for i in range(len(PAUSE_ITEMS)):
            label = PAUSE_ITEMS[i]
            enabled = True
            if i == 1:
                label = "Practice ON" if s["practice"] else "Practice OFF"
                enabled = s["mode"] != "verify"
            x, y, w, h = pause_button_rect(i)
            if ui_button(x, y, w, h, label, self.pause_focus == i, enabled, 1):
                _pause_action(self, i)
        if s["mode"] == "verify":
            ui_text(HUD_VIEW_W / 2, PAUSE_Y + len(PAUSE_ITEMS) * PAUSE_GAP, "no practice in a verify run", UI_PALETTE["muted"], 1, "center")
    _ = ui
