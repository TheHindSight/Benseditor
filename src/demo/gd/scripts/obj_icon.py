# obj_icon: choose the icon's shape and its two colours. Two 4x4 palette
# grids (primary, secondary), a row of the four shapes, and a rotating
# preview. Tab moves between the three sections, arrows move inside one;
# clicking works everywhere. Every change is saved at once.

ICON_VIEW_W = 570
ICON_VIEW_H = 330
ICON_GRID_X = (40, 170)
ICON_GRID_Y = 96
ICON_CELL = 22
ICON_GAP = 4
ICON_SHAPES_X = 310
ICON_SHAPES_Y = 110
ICON_SHAPE_GAP = 40
ICON_PREVIEW_X = 470
ICON_PREVIEW_Y = 190
ICON_SECTIONS = 3
ICON_BACK = (205, 288, 160, 26)


def icon_cell_rect(section, index):
    """Screen rect of palette cell `index` (0..15) in grid `section` (0/1)."""
    gx = ICON_GRID_X[section]
    col = index % 4
    row = index // 4
    return (gx + col * (ICON_CELL + ICON_GAP), ICON_GRID_Y + row * (ICON_CELL + ICON_GAP), ICON_CELL, ICON_CELL)


def icon_shape_rect(index):
    return (ICON_SHAPES_X + index * ICON_SHAPE_GAP - 16, ICON_SHAPES_Y - 16, 32, 32)


def create(self):
    state_ensure_game()
    self.depth = -100
    settings = progress_settings()
    self.section = 0
    self.cursor = [settings["primary"], settings["secondary"], settings["icon"]]
    self.t = 0
    self.back_focus = False


def room_start(self):
    view_set_size(ICON_VIEW_W, ICON_VIEW_H)
    view_set(0, 0)


def _apply(self):
    progress_save_settings(self.cursor[0], self.cursor[1], self.cursor[2])


def _move(self, delta):
    section = self.section
    count = 16 if section < 2 else ICON_COUNT
    before = self.cursor[section]
    self.cursor[section] = ui_nav(before, count, delta)
    if self.cursor[section] != before:
        _apply(self)


def step(self):
    self.t += 1
    ui = ui_begin()

    if keyboard_check_pressed("tab"):
        self.section = ui_nav(self.section, ICON_SECTIONS, 1)
        self.back_focus = False
    if keyboard_check_pressed("left"):
        _move(self, -1)
    if keyboard_check_pressed("right"):
        _move(self, 1)
    if keyboard_check_pressed("up"):
        if self.section < 2:
            _move(self, -4)
        else:
            self.section = ui_nav(self.section, ICON_SECTIONS, -1)
    if keyboard_check_pressed("down"):
        if self.section < 2:
            _move(self, 4)
        else:
            self.section = ui_nav(self.section, ICON_SECTIONS, 1)

    if ui["click"]:
        for section in range(2):
            for index in range(16):
                x, y, w, h = icon_cell_rect(section, index)
                if ui_hit(ui["mx"], ui["my"], x, y, w, h):
                    self.section = section
                    if self.cursor[section] != index:
                        self.cursor[section] = index
                        _apply(self)
        for index in range(ICON_COUNT):
            x, y, w, h = icon_shape_rect(index)
            if ui_hit(ui["mx"], ui["my"], x, y, w, h):
                self.section = 2
                if self.cursor[2] != index:
                    self.cursor[2] = index
                    _apply(self)

    if keyboard_check_pressed("escape"):
        state_goto("rm_menu")


def draw(self):
    vx, vy = view_get()
    draw_set_color(UI_PALETTE["bg"])
    draw_rectangle(vx, vy, vx + ICON_VIEW_W, vy + ICON_VIEW_H, False)


def draw_gui(self):
    ui = ui_begin()
    vx, vy = ui["vx"], ui["vy"]
    ui_text(ICON_VIEW_W / 2, 10, "ICON", UI_PALETTE["accent"], 2, "center")
    ui_text(ICON_VIEW_W - 8, 14, "tab: section   esc: back", UI_PALETTE["muted"], 1, "right")

    labels = ("PRIMARY", "SECONDARY")
    for section in range(2):
        gx = ICON_GRID_X[section]
        focused = self.section == section
        ui_text(gx, ICON_GRID_Y - 16, labels[section], UI_PALETTE["accent"] if focused else UI_PALETTE["text_dim"], 1)
        for index in range(16):
            x, y, w, h = icon_cell_rect(section, index)
            ui_panel(x, y, w, h, UI_COLOURS[index], None)
            if self.cursor[section] == index:
                draw_set_color(UI_PALETTE["accent"] if focused else UI_PALETTE["text"])
                draw_rectangle(vx + x - 2, vy + y - 2, vx + x + w + 2, vy + y + h + 2, True)
                draw_rectangle(vx + x - 1, vy + y - 1, vx + x + w + 1, vy + y + h + 1, True)

    primary = icon_colour(self.cursor[0])
    secondary = icon_colour(self.cursor[1])
    focused = self.section == 2
    ui_text(ICON_SHAPES_X - 16, ICON_SHAPES_Y - 40, "SHAPE", UI_PALETTE["accent"] if focused else UI_PALETTE["text_dim"], 1)
    for index in range(ICON_COUNT):
        x, y, w, h = icon_shape_rect(index)
        if self.cursor[2] == index:
            ui_panel(x, y, w, h, UI_PALETTE["hover"], UI_PALETTE["accent"] if focused else UI_PALETTE["text"])
        icon_draw(vx + x + w / 2, vy + y + h / 2, index, primary, secondary, 1, 1, 0, 1)
    ui_text(ICON_SHAPES_X - 16, ICON_SHAPES_Y + 24, ICON_NAMES[self.cursor[2]], UI_PALETTE["text_dim"], 1)

    # The preview spins on a little floor.
    draw_set_color(UI_PALETTE["text"])
    draw_line(vx + ICON_PREVIEW_X - 60, vy + ICON_PREVIEW_Y + 46, vx + ICON_PREVIEW_X + 60, vy + ICON_PREVIEW_Y + 46, 2)
    icon_draw(vx + ICON_PREVIEW_X, vy + ICON_PREVIEW_Y, self.cursor[2], primary, secondary, 3, 3, self.t * 1.5, 1)

    if progress_state["save_failed"]:
        ui_badge(ICON_VIEW_W - 100, 40, "SAVE FAILED", UI_PALETTE["bad"], 1, UI_PALETTE["text"])

    x, y, w, h = ICON_BACK
    if ui_button(x, y, w, h, "Back", False, True, 1):
        state_goto("rm_menu")
