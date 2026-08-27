# obj_menu: the title screen. A block floor scrolls past (the view slides),
# the colours pulse on a one-second "visual beat", and four buttons work by
# keyboard (arrows + Enter) or mouse.

MENU_VIEW_W = 570
MENU_VIEW_H = 330
MENU_BUTTONS = [("Play", "rm_levels"), ("Editor", "rm_editor"), ("Icon", "rm_icon"), ("Quit", None)]
MENU_BUTTON_X = 205
MENU_BUTTON_Y = 150
MENU_BUTTON_W = 160
MENU_BUTTON_H = 28
MENU_BUTTON_GAP = 36
MENU_TITLE_X = 285
MENU_TITLE_Y = 70
MENU_SCROLL_SPEED = 1.5
MENU_BEAT_STEPS = 60
MENU_CELL = 30


def menu_button_rect(index):
    """Screen rectangle (x, y, w, h) of button `index`."""
    return (MENU_BUTTON_X, MENU_BUTTON_Y + index * MENU_BUTTON_GAP, MENU_BUTTON_W, MENU_BUTTON_H)


def create(self):
    state_ensure_game()
    self.depth = -100
    # No button focused until the keyboard or the mouse picks one: Down
    # lands on Play, Up on Quit.
    self.focus = -1
    self.t = 0
    self.scroll = 0.0
    self.message = ""
    self.message_timer = 0


def room_start(self):
    view_set_size(MENU_VIEW_W, MENU_VIEW_H)
    view_set(0, 0)


def step(self):
    self.t += 1
    # Slide the view along the floor; the blocks are drawn on the room grid
    # so the scroll wraps invisibly every two cells.
    self.scroll = (self.scroll + MENU_SCROLL_SPEED) % (MENU_CELL * 2)
    view_set(self.scroll, 0)
    ui = ui_begin()

    count = len(MENU_BUTTONS)
    if keyboard_check_pressed("up") or keyboard_check_pressed("w"):
        self.focus = count - 1 if self.focus < 0 else ui_nav(self.focus, count, -1)
    if keyboard_check_pressed("down") or keyboard_check_pressed("s"):
        self.focus = 0 if self.focus < 0 else ui_nav(self.focus, count, 1)
    if ui["moved"]:
        for i in range(count):
            x, y, w, h = menu_button_rect(i)
            if ui_hovering(x, y, w, h):
                self.focus = i
    if self.message_timer > 0:
        self.message_timer -= 1


def _activate(self, index):
    label, room = MENU_BUTTONS[index]
    if room is None:
        game_end()
        return
    if not state_goto(room):
        self.message = "This project has no %s room" % label.lower()
        self.message_timer = 120


def _beat(self):
    return 0.5 + 0.5 * math.sin(self.t * 2 * math.pi / MENU_BEAT_STEPS)


def draw(self):
    vx, vy = view_get()
    beat = _beat(self)
    draw_set_color(ui_mix(UI_PALETTE["bg"], UI_PALETTE["bg_dark"], beat * 0.7))
    draw_rectangle(vx, vy, vx + MENU_VIEW_W, vy + MENU_VIEW_H, False)

    fill = ui_mix(UI_PALETTE["panel"], UI_PALETTE["panel_edge"], beat * 0.35)
    edge = ui_mix(UI_PALETTE["panel_edge"], UI_PALETTE["text"], beat * 0.4)
    start = int(vx // MENU_CELL) * MENU_CELL - MENU_CELL
    x = start
    while x < vx + MENU_VIEW_W + MENU_CELL:
        for row in range(2):
            y = vy + MENU_VIEW_H - (2 - row) * MENU_CELL
            draw_set_color(fill)
            draw_rectangle(x + 1, y + 1, x + MENU_CELL - 1, y + MENU_CELL - 1, False)
            draw_set_color(edge)
            draw_rectangle(x, y, x + MENU_CELL, y + MENU_CELL, True)
        # A thinner ceiling row.
        draw_set_color(fill)
        draw_rectangle(x + 1, vy + 1, x + MENU_CELL - 1, vy + 11, False)
        draw_set_color(edge)
        draw_rectangle(x, vy, x + MENU_CELL, vy + 12, True)
        x += MENU_CELL
    draw_set_color(UI_PALETTE["text"])
    draw_line(vx, vy + MENU_VIEW_H - 2 * MENU_CELL, vx + MENU_VIEW_W, vy + MENU_VIEW_H - 2 * MENU_CELL, 2)


def draw_gui(self):
    ui = ui_begin()
    vx, vy = ui["vx"], ui["vy"]
    pulse = 2 + 0.08 * math.sin(self.t * 2 * math.pi / MENU_BEAT_STEPS)
    draw_sprite_ext("spr_title", 0, vx + MENU_TITLE_X, vy + MENU_TITLE_Y, pulse, pulse, 0, c_white, 1)
    ui_text(MENU_TITLE_X, MENU_TITLE_Y + 30, "the full clone, in Python", UI_PALETTE["text_dim"], 1, "center")

    for i in range(len(MENU_BUTTONS)):
        label, room = MENU_BUTTONS[i]
        x, y, w, h = menu_button_rect(i)
        if ui_button(x, y, w, h, label, self.focus == i, True, 1):
            _activate(self, i)

    primary, secondary, shape = icon_settings()
    icon_draw(vx + 90, vy + 205, shape, primary, secondary, 1.5, 1.5, self.t * 2, 1)
    ui_text(90, 236, "your icon", UI_PALETTE["muted"], 1, "center")

    if self.message_timer > 0:
        ui_text(MENU_VIEW_W / 2, 300, self.message, UI_PALETTE["warn"], 1, "center")
    else:
        ui_text(MENU_VIEW_W / 2, 300, "arrows + enter, or click", UI_PALETTE["muted"], 1, "center")
