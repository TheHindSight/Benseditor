# obj_end: the end screen. LEVEL COMPLETE (or VERIFIED! after a verify run),
# the level's name, attempts, jumps, time, coins, NEW BEST, and Replay /
# Menu (Editor when the run came from the editor). A practice completion
# says so and is not recorded.

END_VIEW_W = 570
END_VIEW_H = 330
END_BUTTON_Y = 262
END_BUTTON_W = 130
END_BUTTON_H = 28
END_BUTTONS_X = (140, 300)


def end_button_rect(index):
    return (END_BUTTONS_X[index], END_BUTTON_Y, END_BUTTON_W, END_BUTTON_H)


def create(self):
    state_ensure_game()
    self.depth = -100
    self.result = run_result()
    self.focus = 0
    self.t = 0


def room_start(self):
    view_set_size(END_VIEW_W, END_VIEW_H)
    view_set(0, 0)
    self.result = run_result()


def _from_editor(self):
    return self.result.get("mode") in ("test", "verify")


def _menu(self):
    if _from_editor(self):
        state_goto(self.result.get("return_to") or "rm_editor", "rm_menu")
    else:
        state_goto("rm_menu")


def _replay(self):
    if run_replay() is None:
        _menu(self)


def step(self):
    self.t += 1
    ui = ui_begin()
    if keyboard_check_pressed("left") or keyboard_check_pressed("up"):
        self.focus = ui_nav(self.focus, 2, -1)
    if keyboard_check_pressed("right") or keyboard_check_pressed("down"):
        self.focus = ui_nav(self.focus, 2, 1)
    if ui["moved"]:
        for i in range(2):
            x, y, w, h = end_button_rect(i)
            if ui_hovering(x, y, w, h):
                self.focus = i
    if keyboard_check_pressed("escape"):
        _menu(self)


def _clock(steps):
    seconds = int(steps / max(1, room_speed()))
    return "%02d:%02d" % (seconds // 60, seconds % 60)


def draw(self):
    vx, vy = view_get()
    beat = 0.5 + 0.5 * math.sin(self.t * 2 * math.pi / 60)
    draw_set_color(ui_mix(UI_PALETTE["bg"], UI_PALETTE["bg_dark"], beat * 0.7))
    draw_rectangle(vx, vy, vx + END_VIEW_W, vy + END_VIEW_H, False)


def draw_gui(self):
    ui = ui_begin()
    vx, vy = ui["vx"], ui["vy"]
    r = self.result
    practice = r.get("practice") or (r.get("practice_used") and not r.get("verified"))

    if r.get("verified"):
        ui_text(END_VIEW_W / 2, 24, "VERIFIED!", UI_PALETTE["good"], 3, "center")
    elif r.get("finished"):
        ui_text(END_VIEW_W / 2, 24, "LEVEL COMPLETE", UI_PALETTE["accent"], 3, "center")
    else:
        ui_text(END_VIEW_W / 2, 24, "RUN OVER", UI_PALETTE["text_dim"], 3, "center")
    if r.get("practice"):
        ui_text(END_VIEW_W / 2, 64, "PRACTICE - not recorded", UI_PALETTE["warn"], 1, "center")
    ui_text(END_VIEW_W / 2, 84, str(r.get("name") or ""), UI_PALETTE["text"], 2, "center")

    ui_panel(150, 118, 270, 120, UI_PALETTE["panel"], UI_PALETTE["panel_edge"])
    rows = (
        ("Attempts", str(r.get("attempts", 0))),
        ("Jumps", str(r.get("jumps", 0))),
        ("Time", _clock(r.get("time", 0))),
    )
    y = 128
    for label, value in rows:
        ui_text(166, y, label, UI_PALETTE["text_dim"], 1)
        ui_text(404, y, value, UI_PALETTE["text"], 1, "right")
        y += 20
    ui_text(166, y, "Coins", UI_PALETTE["text_dim"], 1)
    ui_coins(340, y - 4, r.get("coins") or [False, False, False], 1.5)
    y += 24
    if r.get("new_best") and not practice:
        ui_badge(166, y, "NEW BEST", UI_PALETTE["accent"], 1)
    elif r.get("finished"):
        ui_text(166, y + 2, "best %d%%" % int(r.get("best_pct", 0)), UI_PALETTE["muted"], 1)

    primary, secondary, shape = icon_settings()
    icon_draw(vx + 80, vy + 180, shape, primary, secondary, 2, 2, self.t * 2, 1)

    x, y, w, h = end_button_rect(0)
    if ui_button(x, y, w, h, "Replay", self.focus == 0, True, 1):
        _replay(self)
    x, y, w, h = end_button_rect(1)
    if ui_button(x, y, w, h, "Editor" if _from_editor(self) else "Menu", self.focus == 1, True, 1):
        _menu(self)
