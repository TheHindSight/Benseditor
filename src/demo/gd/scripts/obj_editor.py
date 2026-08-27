# obj_editor: the in-game level editor, placed in rm_editor.
#
# The document (gd_editor doc) lives in ReplicatedStorage "gd.doc" and the
# scroll/tool state in "gd.editor_view", so editor -> playtest -> editor keeps
# both. Blocks are drawn by the pre-authored lay_edit tile layer (kept in sync
# with the doc through gd_tiles.sync_layer); everything else is drawn from the
# doc with the same sprite/frame mapping the spawner uses.
#
# Keys: left-drag paint, right-drag erase, middle-drag or arrows pan, wheel
# scrolls (shift: vertically); palette by click / 1-0 / comma+period; r rotate,
# e level end at the cursor, z/y undo/redo, g grid, n name, f cycles the
# selected setting and [ ] adjust it, s save, p playtest from the cursor
# (shift+p from the start), v verify run, delete twice clears, escape leaves
# (twice while unsaved).

ED_BAR_H = 62
ED_PAN = 8
ED_WHEEL = 60
ED_TOAST_STEPS = 150
ED_CONFIRM_STEPS = 180
ED_GRID_COLOUR = 0x2A3C74
ED_END_COLOUR = 0x00E436
ED_RUNUP_COLOUR = 0xFF004D
ED_TOOL_KEYS = "1234567890"

# Palette thumbnails: portals are 30x90 and the speed portal 60x30, so they
# shrink differently to fit the 16 px cell.
ED_PAL_SCALE = {"G": (0.4, 0.14), "M": (0.4, 0.14), "Z": (0.4, 0.14), "V": (0.22, 0.44)}

DOC_KEY = "gd.doc"
VIEW_KEY = "gd.editor_view"


def _sprite_for(code, param):
    """(sprite, frame) for a level object -- the spawner's mapping."""
    if code == "S":
        return ("spr_spike", 0)
    if code == "P":
        return ("spr_pad", max(0, TYPES["P"]["params"].find(param)))
    if code == "O":
        return ("spr_orb", max(0, TYPES["O"]["params"].find(param)))
    if code == "G":
        return ("spr_portal_gravity", int(param))
    if code == "M":
        return ("spr_portal_mode", int(param))
    if code == "V":
        return ("spr_portal_speed", int(param))
    if code == "Z":
        return ("spr_portal_size", int(param))
    if code == "C":
        return ("spr_coin", 0)
    return (None, 0)


def _toast(self, text, steps=ED_TOAST_STEPS):
    self.toast = str(text)
    self.toast_timer = steps


def _clamp_scroll(self):
    view = self.view
    view["sx"] = clamp(view["sx"], 0, max(0, ROOM_W - VIEW_W))
    view["sy"] = clamp(view["sy"], 0, max(0, ROOM_H - VIEW_H))


def _consume_result(self):
    """Returning from a verify run: adopt the stored verified flag and say so."""
    result = ReplicatedStorage.Get("gd.result")
    if not isinstance(result, dict):
        return
    if result.get("mode") != "verify" or not result.get("finished"):
        return
    doc = self.doc
    if not doc.get("id") or result.get("level_id") != doc.get("id"):
        return
    record = load_level(doc["id"])
    if record is not None:
        doc["saved_verified"] = record.get("verified") is True
        doc["saved_data"] = record["data"]
    if doc["saved_verified"]:
        _toast(self, "VERIFIED in %d attempts" % int(result.get("attempts", 1)), 300)
    ReplicatedStorage.Set("gd.result", None)


def create(self):
    state_ensure_game()
    self.visible = False
    self.depth = -500
    doc = ReplicatedStorage.Get(DOC_KEY)
    if not isinstance(doc, dict) or "objects" not in doc:
        doc = doc_new()
        ReplicatedStorage.Set(DOC_KEY, doc)
    self.doc = doc
    view = ReplicatedStorage.Get(VIEW_KEY)
    if not isinstance(view, dict):
        view = {"sx": 0, "sy": ROOM_H - VIEW_H, "tool": 0, "grid": True}
        ReplicatedStorage.Set(VIEW_KEY, view)
    self.view = view
    self.t = 0
    self.toast = ""
    self.toast_timer = 0
    self.naming = False
    self.field = None
    self.setting = 0
    self.confirm_clear = 0
    self.confirm_exit = 0
    self.stroke_button = ""
    self.pan_from = None
    self.cursor = (0, 0)
    self.cursor_on = False
    self.tiles = doc_tiles(doc)
    _consume_result(self)


def room_start(self):
    view_set_size(VIEW_W, VIEW_H)
    _clamp_scroll(self)
    view_set(self.view["sx"], self.view["sy"])
    self.tiles = doc_tiles(self.doc)
    sync_layer(LAYER_EDIT, self.tiles)


def _sync_tiles(self):
    self.tiles = doc_tiles(self.doc)
    sync_layer(LAYER_EDIT, self.tiles)


def _name_entry_step(self):
    shift = keyboard_check("shift")
    field = self.field
    for ch in FIELD_LETTERS:
        if keyboard_check_pressed(ch):
            field_key(field, ch, shift)
    for ch in FIELD_DIGITS:
        if keyboard_check_pressed(ch):
            field_key(field, ch, shift)
    for name in ("space", "minus", "backspace", "delete", "left", "right", "home", "end"):
        if keyboard_check_pressed(name):
            field_key(field, name, shift)
    if keyboard_check_pressed("enter"):
        text = field["text"]
        if text.strip() != "":
            self.doc["name"] = text
        else:
            _toast(self, "the name cannot be empty")
        self.naming = False
    elif keyboard_check_pressed("escape"):
        self.naming = False


def _save(self):
    doc = self.doc
    ok, msg = save_level(doc)
    if ok:
        doc["saved_data"] = encode_level(doc)
        record = load_level(doc["id"])
        doc["saved_verified"] = record is not None and record.get("verified") is True
    _toast(self, msg)
    return ok


def _launch(self, mode, start_col):
    doc = self.doc
    problems = validate_level(doc)
    if problems:
        _toast(self, problems[0])
        return False
    if mode == "verify":
        # A verify run plays the STORED data from the start; save first so the
        # stale-run guard in gd_store.mark_verified compares equal strings.
        if not _save(self):
            return False
        record = load_level(doc["id"])
        data = record["data"] if record is not None else encode_level(doc)
        start_col = 0
    else:
        data = encode_level(doc)
    gd_set_run(mode, data, "custom", doc.get("id") or "", start_col, "rm_editor")
    ReplicatedStorage.Set(DOC_KEY, doc)
    room_goto("rm_play")
    return True


def step(self):
    self.t += 1
    if self.toast_timer > 0:
        self.toast_timer -= 1
    if self.confirm_clear > 0:
        self.confirm_clear -= 1
    if self.confirm_exit > 0:
        self.confirm_exit -= 1
    doc = self.doc
    view = self.view
    ui = ui_begin()

    if self.naming:
        _name_entry_step(self)
        view_set(view["sx"], view["sy"])
        return

    shift = keyboard_check("shift")
    mx, my = ui["mx"], ui["my"]
    over_bar = my >= VIEW_H - ED_BAR_H
    col, row = cell_at(mouse_x(), mouse_y(), 0, 0)
    self.cursor = (col, row)
    self.cursor_on = not over_bar and 0 <= row < ROWS

    # ---- palette -----------------------------------------------------------
    pal = hit_palette(mx, my)
    if ui["click"] and pal >= 0:
        view["tool"] = pal
    for i in range(len(ED_TOOL_KEYS)):
        if keyboard_check_pressed(ED_TOOL_KEYS[i]):
            view["tool"] = i
    if keyboard_check_pressed("comma"):
        view["tool"] = (view["tool"] - 1) % len(PALETTE)
    if keyboard_check_pressed("period"):
        view["tool"] = (view["tool"] + 1) % len(PALETTE)

    # ---- painting ----------------------------------------------------------
    changed = False
    if ui["click"] and not over_bar:
        begin_stroke(doc)
        self.stroke_button = "left"
    if mouse_check_button_pressed("right") and not over_bar:
        begin_stroke(doc)
        self.stroke_button = "right"
    if self.stroke_button == "left" and mouse_check_button("left"):
        if self.cursor_on:
            code, param, _label = PALETTE[view["tool"]]
            if place(doc, col, row, code, param):
                changed = True
    elif self.stroke_button == "right" and mouse_check_button("right"):
        if self.cursor_on and erase(doc, col, row):
            changed = True
    if self.stroke_button != "" and not mouse_check_button(self.stroke_button):
        end_stroke(doc)
        self.stroke_button = ""

    # ---- panning and scrolling ---------------------------------------------
    if mouse_check_button("middle"):
        if self.pan_from is not None:
            view["sx"] -= mx - self.pan_from[0]
            view["sy"] -= my - self.pan_from[1]
        self.pan_from = (mx, my)
    else:
        self.pan_from = None
    if keyboard_check("left"):
        view["sx"] -= ED_PAN
    if keyboard_check("right"):
        view["sx"] += ED_PAN
    if keyboard_check("up"):
        view["sy"] -= ED_PAN
    if keyboard_check("down"):
        view["sy"] += ED_PAN
    wheel = ui["wheel"]
    if wheel != 0:
        if shift:
            view["sy"] += wheel * ED_WHEEL
        else:
            view["sx"] += wheel * ED_WHEEL

    # ---- keys --------------------------------------------------------------
    if keyboard_check_pressed("r") and self.cursor_on:
        if rotate(doc, col, row):
            changed = True
    if keyboard_check_pressed("e") and self.cursor_on:
        ok, msg = set_length(doc, col)
        _toast(self, msg)
        changed = changed or ok
    if keyboard_check_pressed("z"):
        if undo(doc):
            changed = True
        else:
            _toast(self, "nothing to undo")
    if keyboard_check_pressed("y"):
        if redo(doc):
            changed = True
        else:
            _toast(self, "nothing to redo")
    if keyboard_check_pressed("g"):
        view["grid"] = not view["grid"]
    if keyboard_check_pressed("n"):
        self.field = field_new(doc["name"])
        self.naming = True
    if keyboard_check_pressed("f"):
        self.setting = (self.setting + (-1 if shift else 1)) % len(SETTING_FIELDS)
        _toast(self, setting_label(doc, self.setting), 90)
    if keyboard_check_pressed("bracketleft"):
        field, _value = adjust_setting(doc, self.setting, -1)
        _toast(self, setting_label(doc, self.setting), 90)
    if keyboard_check_pressed("bracketright"):
        field, _value = adjust_setting(doc, self.setting, 1)
        _toast(self, setting_label(doc, self.setting), 90)
    if keyboard_check_pressed("s"):
        _save(self)
    if keyboard_check_pressed("p"):
        start = 0 if shift else int(clamp(col, 0, max(0, int(doc.get("len", 1)) - 1)))
        _launch(self, "test", start)
    if keyboard_check_pressed("v"):
        _launch(self, "verify", 0)
    if keyboard_check_pressed("delete"):
        if self.confirm_clear > 0:
            self.confirm_clear = 0
            if clear(doc):
                changed = True
                _toast(self, "cleared (z undoes)")
        else:
            self.confirm_clear = ED_CONFIRM_STEPS
            _toast(self, "press delete again to clear the level")
    if keyboard_check_pressed("escape"):
        if dirty(doc) and self.confirm_exit <= 0:
            self.confirm_exit = ED_CONFIRM_STEPS
            _toast(self, "unsaved changes: esc discards, s saves")
        else:
            state_goto("rm_menu")

    if changed:
        _sync_tiles(self)
    _clamp_scroll(self)
    view_set(view["sx"], view["sy"])


# ---- drawing ----------------------------------------------------------------


def _draw_object(self, code, param, col, row, alpha):
    name, frame = _sprite_for(code, param)
    if name is None:
        return
    flip = flip_for(code, param, col, row, self.tiles)
    draw_sprite_ext(name, frame, cell_x(col), cell_y(row), 1, flip, 0, c_white, alpha)


def draw(self):
    doc = self.doc
    vx, vy = view_get()

    if self.view["grid"]:
        draw_set_color(ED_GRID_COLOUR)
        x = int(vx // CELL) * CELL
        while x < vx + VIEW_W + CELL:
            draw_line(x, vy, x, vy + VIEW_H)
            x += CELL
        y = int(vy // CELL) * CELL
        while y < vy + VIEW_H + CELL:
            draw_line(vx, y, vx + VIEW_W, y)
            y += CELL

    # The run-up (columns 0-7 must stay empty) and the level's end.
    runup = SPAWN_COLS * CELL
    if vx < runup:
        draw_set_color(ED_RUNUP_COLOUR)
        draw_set_alpha(0.12)
        draw_rectangle(vx, vy, min(runup, vx + VIEW_W), vy + VIEW_H, False)
        draw_set_alpha(1)
    end_x = int(doc.get("len", 0)) * CELL
    if vx - CELL < end_x < vx + VIEW_W + CELL:
        draw_set_color(ED_END_COLOUR)
        draw_line(end_x, vy, end_x, vy + VIEW_H, 2)
        draw_set_alpha(0.1)
        draw_rectangle(max(end_x, vx), vy, vx + VIEW_W, vy + VIEW_H, False)
        draw_set_alpha(1)

    lo = int(vx // CELL) - 1
    hi = int((vx + VIEW_W) // CELL) + 1
    objects = doc["objects"]
    for k in objects:
        col = k // ROWS
        if col < lo or col > hi:
            continue
        entry = objects[k]
        if entry[0] == "B":
            continue
        _draw_object(self, entry[0], entry[1], col, k % ROWS, 1)

    if self.cursor_on:
        col, row = self.cursor
        x1 = col * CELL
        y1 = cell_y(row) - CELL // 2
        code, param, _label = PALETTE[self.view["tool"]]
        if code == "B":
            draw_set_color(UI_PALETTE["panel_edge"])
            draw_set_alpha(0.4)
            draw_rectangle(x1 + 2, y1 + 2, x1 + CELL - 2, y1 + CELL - 2, False)
            draw_set_alpha(1)
        else:
            _draw_object(self, code, param, col, row, 0.45)
        draw_set_color(UI_PALETTE["accent"])
        draw_rectangle(x1, y1, x1 + CELL, y1 + CELL, True)


def _draw_palette(self, ui):
    vx, vy = ui["vx"], ui["vy"]
    tool = self.view["tool"]
    for i in range(len(PALETTE)):
        x, y, w, h = palette_rect(i)
        code, param, _label = PALETTE[i]
        if i == tool:
            ui_panel(x, y, w - 1, h - 1, UI_PALETTE["hover"], UI_PALETTE["accent"])
        else:
            ui_panel(x, y, w - 1, h - 1, UI_PALETTE["bg_dark"], None)
        cx = vx + x + w / 2
        cy = vy + y + h / 2
        if code == "B":
            draw_set_color(UI_PALETTE["panel_edge"])
            draw_rectangle(cx - 5, cy - 5, cx + 5, cy + 5, False)
        else:
            name, frame = _sprite_for(code, param)
            sx, sy = ED_PAL_SCALE.get(code, (0.44, 0.44))
            draw_sprite_ext(name, frame, cx, cy, sx, sy, 0, c_white, 1)


def draw_gui(self):
    doc = self.doc
    ui = ui_begin()
    bar_y = VIEW_H - ED_BAR_H
    ui_panel(0, bar_y, VIEW_W, ED_BAR_H, UI_PALETTE["panel"], UI_PALETTE["panel_edge"])
    _draw_palette(self, ui)

    # Line 1: the name (with a blinking caret while typing) and the badge.
    y1 = bar_y + 24
    if self.naming:
        field = self.field
        caret = field["caret"]
        shown = field["text"][:caret] + ("|" if (self.t // 15) % 2 == 0 else " ") + field["text"][caret:]
        ui_text(6, y1, "name: " + shown, UI_PALETTE["accent"], 1)
    else:
        ui_text(6, y1, str(doc.get("name", "")), UI_PALETTE["text"], 1)
    state = badge(doc)
    if state == "VERIFIED":
        ui_badge(VIEW_W - 74, y1 - 2, state, UI_PALETTE["good"], 1)
    elif state == "UNVERIFIED":
        ui_badge(VIEW_W - 88, y1 - 2, state, UI_PALETTE["bad"], 1, UI_PALETTE["text"])
    else:
        ui_badge(VIEW_W - 62, y1 - 2, state, UI_PALETTE["warn"], 1)

    # Line 2: cursor, tool and the selected setting.
    y2 = bar_y + 44
    col, row = self.cursor
    _code, _param, label = PALETTE[self.view["tool"]]
    ui_text(6, y2, "col %d/%d row %d" % (col, int(doc.get("len", 0)), row), UI_PALETTE["text_dim"], 1)
    ui_text(160, y2, label, UI_PALETTE["accent"], 1)
    ui_text(300, y2, setting_label(doc, self.setting), UI_PALETTE["text_dim"], 1)
    ui_text(VIEW_W - 6, y2, "s save  p test  v verify", UI_PALETTE["muted"], 1, "right")

    if self.toast_timer > 0:
        ui_panel(VIEW_W / 2 - 150, bar_y - 24, 300, 18, UI_PALETTE["bg_dark"], UI_PALETTE["accent"])
        ui_text(VIEW_W / 2, bar_y - 21, self.toast, UI_PALETTE["text"], 1, "center")
