# obj_levels: level select. Nine rows at a time: name, difficulty stars,
# best %, coins and a VERIFIED / UNVERIFIED badge. Unverified custom levels
# are greyed out and refuse to launch. Enter or a click launches; Escape goes
# back; arrows, page up/down and the wheel scroll.

LEVELS_VIEW_W = 570
LEVELS_VIEW_H = 330
LEVELS_ROWS = 9
LEVELS_TOP = 40
LEVELS_ROW_H = 30
LEVELS_X = 8
LEVELS_W = 554
LEVELS_MESSAGE_STEPS = 150
LEVELS_REFUSED = "Verify it in the editor first"


def create(self):
    state_ensure_game()
    self.depth = -100
    self.rows = levels_list()
    self.selected = 0
    self.first = 0
    self.message = ""
    self.message_timer = 0
    self.t = 0


def room_start(self):
    view_set_size(LEVELS_VIEW_W, LEVELS_VIEW_H)
    view_set(0, 0)
    # The editor may have saved or verified something since.
    self.rows = levels_list()
    if self.selected >= len(self.rows):
        self.selected = max(0, len(self.rows) - 1)


def _visible(self):
    return min(LEVELS_ROWS, len(self.rows) - self.first)


def step(self):
    self.t += 1
    ui = ui_begin()
    count = len(self.rows)
    if self.message_timer > 0:
        self.message_timer -= 1

    if keyboard_check_pressed("up") or keyboard_check_pressed("w"):
        self.selected = ui_nav(self.selected, count, -1)
    if keyboard_check_pressed("down") or keyboard_check_pressed("s"):
        self.selected = ui_nav(self.selected, count, 1)
    if keyboard_check_pressed("pageup"):
        self.selected = ui_nav(self.selected, count, -LEVELS_ROWS, False)
    if keyboard_check_pressed("pagedown"):
        self.selected = ui_nav(self.selected, count, LEVELS_ROWS, False)
    if ui["wheel"] != 0:
        limit = max(0, count - LEVELS_ROWS)
        self.first = int(clamp(self.first + ui["wheel"] * 3, 0, limit))
        self.selected = int(clamp(self.selected, self.first, self.first + LEVELS_ROWS - 1))
    self.first = ui_list_window(self.selected, count, LEVELS_ROWS, self.first)

    hovered = ui_hover_index(ui["mx"], ui["my"], LEVELS_X, LEVELS_TOP, LEVELS_W, LEVELS_ROW_H, _visible(self))
    if hovered >= 0 and (ui["moved"] or ui["click"]):
        self.selected = self.first + hovered
    if ui["click"] and hovered >= 0:
        _launch(self)
    elif ui["enter"]:
        _launch(self)

    if keyboard_check_pressed("escape"):
        state_goto("rm_menu")


def _launch(self):
    if not self.rows:
        return
    row = self.rows[self.selected]
    if not row["verified"]:
        self.message = LEVELS_REFUSED
        self.message_timer = LEVELS_MESSAGE_STEPS
        return
    row = levels_load_data(row)
    if not row.get("data"):
        self.message = "This level has no data"
        self.message_timer = LEVELS_MESSAGE_STEPS
        return
    run_start(row, "play", 0, "rm_levels")


def draw(self):
    vx, vy = view_get()
    draw_set_color(UI_PALETTE["bg"])
    draw_rectangle(vx, vy, vx + LEVELS_VIEW_W, vy + LEVELS_VIEW_H, False)


def draw_gui(self):
    ui = ui_begin()
    ui_text(LEVELS_X, 8, "LEVELS", UI_PALETTE["accent"], 2)
    ui_text(LEVELS_VIEW_W - LEVELS_X, 12, "enter: play   esc: back", UI_PALETTE["muted"], 1, "right")

    count = len(self.rows)
    if count == 0:
        ui_text(LEVELS_VIEW_W / 2, 150, "No levels yet. Make one in the editor.", UI_PALETTE["text_dim"], 1, "center")

    visible = _visible(self)
    for i in range(visible):
        index = self.first + i
        row = self.rows[index]
        y = LEVELS_TOP + i * LEVELS_ROW_H
        chosen = index == self.selected
        verified = row["verified"]
        if chosen:
            ui_panel(LEVELS_X, y, LEVELS_W, LEVELS_ROW_H - 2, UI_PALETTE["hover"], UI_PALETTE["focus"])
        else:
            ui_panel(LEVELS_X, y, LEVELS_W, LEVELS_ROW_H - 2, UI_PALETTE["panel"], UI_PALETTE["muted"])
        colour = UI_PALETTE["text"] if verified else UI_PALETTE["disabled"]
        if chosen and verified:
            colour = UI_PALETTE["accent"]
        ui_text(LEVELS_X + 8, y + 2, row["name"][:18], colour, 2)
        ui_stars(LEVELS_X + 268, y + 10, row["difficulty"], 1, UI_PALETTE["accent"] if verified else UI_PALETTE["disabled"])

        record = progress_peek(row["id"])
        pct_colour = UI_PALETTE["good"] if record["completed"] else UI_PALETTE["text_dim"]
        if not verified:
            pct_colour = UI_PALETTE["disabled"]
        ui_text(LEVELS_X + 396, y + 8, "%d%%" % record["best"], pct_colour, 1, "right")
        ui_coins(LEVELS_X + 404, y + 8, record["coins"], 1)
        if verified:
            ui_badge(LEVELS_X + 466, y + 6, "VERIFIED", UI_PALETTE["good"], 1)
        else:
            ui_badge(LEVELS_X + 452, y + 6, "UNVERIFIED", UI_PALETTE["bad"], 1, UI_PALETTE["text"])

    if count > LEVELS_ROWS:
        track_h = LEVELS_ROWS * LEVELS_ROW_H - 2
        knob_h = max(12, track_h * LEVELS_ROWS / count)
        knob_y = LEVELS_TOP + (track_h - knob_h) * self.first / max(1, count - LEVELS_ROWS)
        ui_panel(LEVELS_X + LEVELS_W + 2, LEVELS_TOP, 4, track_h, UI_PALETTE["bg_dark"])
        ui_panel(LEVELS_X + LEVELS_W + 2, knob_y, 4, knob_h, UI_PALETTE["text_dim"])

    if self.message_timer > 0:
        ui_panel(LEVELS_VIEW_W / 2 - 120, 312, 240, 16, UI_PALETTE["bg_dark"], UI_PALETTE["bad"])
        ui_text(LEVELS_VIEW_W / 2, 314, self.message, UI_PALETTE["warn"], 1, "center")
    elif count > 0:
        row = self.rows[self.selected]
        ui_text(LEVELS_VIEW_W / 2, 314, "by " + row["author"], UI_PALETTE["muted"], 1, "center")
    _ = ui
