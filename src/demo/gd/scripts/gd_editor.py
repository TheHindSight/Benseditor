# gd_editor -- the editor's document model. Pure functions over a `doc`, so
# the headless suite drives every rule without an engine.
#
# A doc IS a gd_codec level dict (header keys + "objects") extended with the
# editor's own state, so `encode_level(doc)` and `validate_level(doc)` work on
# it directly and `save_level(doc)` (gd_store) stores it unchanged:
#   {name, author, len, mode, speed, size, diff, bg, beat, objects, extra,
#    id, undo, redo, stroke, saved_data, saved_verified}
#
# Undo model: every action is a list of changes, each
#   ("cell", key, before, after)   before/after = (code, param) or None
#   ("len", before, after)
# `begin_stroke`/`end_stroke` buffer the changes of one drag into a single
# action, so a painted stroke undoes as one. Depends on gd_const and gd_codec.

EDITOR_BAR_H = 62
PAL_CELL = 16
PAL_X = 5
PAL_Y = VIEW_H - EDITOR_BAR_H + 4

SETTING_FIELDS = ["mode", "speed", "size", "diff", "beat", "bg"]
# field: (low, high, wraps, step)
SETTING_RANGES = {
    "mode": (0, 7, True, 1),
    "speed": (0, 4, True, 1),
    "size": (0, 1, True, 1),
    "diff": (1, 10, True, 1),
    "beat": (10, 120, False, 5),
    "bg": (0, 7, True, 1),
}

FIELD_LETTERS = "abcdefghijklmnopqrstuvwxyz"
FIELD_DIGITS = "0123456789"


# ---- the document -----------------------------------------------------------


def doc_new(name=None):
    """A fresh, never-saved document (badge DRAFT*)."""
    doc = new_level(name)
    doc["id"] = ""
    doc["undo"] = []
    doc["redo"] = []
    doc["stroke"] = None
    doc["saved_data"] = None
    doc["saved_verified"] = False
    return doc


def doc_from_level(level, level_id="", verified=False, data=None):
    """A document over an existing level (opened from the store).

    `data` is the stored canonical string; when it is None it is recomputed,
    so `dirty(doc)` starts False either way."""
    doc = doc_new()
    for k in HEADER_KEYS:
        doc[k] = level.get(k, HEADER_DEFAULTS[k])
    doc["objects"] = dict(level.get("objects", {}))
    doc["id"] = str(level_id or level.get("id") or "")
    doc["saved_verified"] = verified is True
    doc["saved_data"] = data if isinstance(data, str) else encode_level(doc)
    return doc


def doc_to_level(doc):
    """A clean gd_codec level dict (no editor fields)."""
    level = new_level()
    for k in HEADER_KEYS:
        level[k] = doc.get(k, HEADER_DEFAULTS[k])
    level["objects"] = dict(doc["objects"])
    if doc.get("id"):
        level["id"] = doc["id"]
    return level


def doc_encode(doc):
    return encode_level(doc)


def doc_tiles(doc):
    return level_tiles(doc)


def dirty(doc):
    """Canonical comparison: the doc differs from what the store holds."""
    saved = doc.get("saved_data")
    return saved is None or encode_level(doc) != saved


def badge(doc):
    if dirty(doc):
        return "DRAFT*"
    return "VERIFIED" if doc.get("saved_verified") else "UNVERIFIED"


# ---- undo / redo ------------------------------------------------------------


def _push(doc, changes):
    """Record one action; while a stroke is open it merges into it."""
    if not changes:
        return
    if doc["stroke"] is not None:
        doc["stroke"].extend(changes)
    else:
        doc["undo"].append(changes)
        doc["redo"] = []


def begin_stroke(doc):
    """Group every change until end_stroke into one undoable action."""
    end_stroke(doc)
    doc["stroke"] = []


def end_stroke(doc):
    """Close the open stroke. True when it recorded anything."""
    stroke = doc["stroke"]
    doc["stroke"] = None
    if stroke:
        doc["undo"].append(stroke)
        doc["redo"] = []
        return True
    return False


def _apply(doc, change, backwards):
    kind = change[0]
    if kind == "cell":
        value = change[2] if backwards else change[3]
        if value is None:
            doc["objects"].pop(change[1], None)
        else:
            doc["objects"][change[1]] = value
    elif kind == "len":
        doc["len"] = change[1] if backwards else change[2]


def undo(doc):
    end_stroke(doc)
    if not doc["undo"]:
        return False
    changes = doc["undo"].pop()
    for i in range(len(changes) - 1, -1, -1):
        _apply(doc, changes[i], True)
    doc["redo"].append(changes)
    return True


def redo(doc):
    end_stroke(doc)
    if not doc["redo"]:
        return False
    changes = doc["redo"].pop()
    for change in changes:
        _apply(doc, change, False)
    doc["undo"].append(changes)
    return True


# ---- editing ----------------------------------------------------------------


def _free_coin_index(doc, at_key):
    """The lowest coin index no OTHER cell uses, or None when all are taken."""
    used = {}
    for k in doc["objects"]:
        entry = doc["objects"][k]
        if entry[0] == "C" and k != at_key:
            used[entry[1]] = True
    for param in TYPES["C"]["params"]:
        if param not in used:
            return param
    return None


def place(doc, col, row, code, param=None):
    """Put an object at a cell. False when out of bounds (col past the level's
    end included), the coin indices are exhausted, or nothing would change."""
    if col < 0 or row < 0 or row >= ROWS:
        return False
    if col >= int(doc.get("len", 0)):
        return False
    info = TYPES.get(code)
    if info is None:
        return False
    if code == "C":
        param = _free_coin_index(doc, key(col, row))
        if param is None:
            return False
    elif param is None or param == "":
        param = default_param(code)
    elif info["params"] != "" and info["params"].find(param) < 0:
        return False
    k = key(col, row)
    before = doc["objects"].get(k)
    after = (code, param)
    if before == after:
        return False
    _push(doc, [("cell", k, before, after)])
    doc["objects"][k] = after
    return True


def erase(doc, col, row):
    """Remove whatever is at a cell. False when it was empty."""
    if col < 0 or row < 0 or row >= ROWS:
        return False
    k = key(col, row)
    before = doc["objects"].get(k)
    if before is None:
        return False
    _push(doc, [("cell", k, before, None)])
    del doc["objects"][k]
    return True


def rotate(doc, col, row):
    """Cycle the object's parameter (spike up/down, pad and orb colour, portal
    target, coin index -- skipping indices other coins hold). False when the
    cell is empty or the type has a single parameter."""
    k = key(col, row)
    entry = doc["objects"].get(k)
    if entry is None:
        return False
    code, param = entry
    params = TYPES[code]["params"]
    if len(params) < 2:
        return False
    at = params.find(param)
    for i in range(1, len(params)):
        candidate = params[(at + i) % len(params)]
        if code == "C" and _coin_index_used(doc, k, candidate):
            continue
        after = (code, candidate)
        _push(doc, [("cell", k, entry, after)])
        doc["objects"][k] = after
        return True
    return False


def _coin_index_used(doc, at_key, param):
    for k in doc["objects"]:
        entry = doc["objects"][k]
        if entry[0] == "C" and entry[1] == param and k != at_key:
            return True
    return False


def set_length(doc, col):
    """Move the level's end to a column. Refuses when objects lie beyond it."""
    col = int(col)
    if col < MIN_LEN or col > MAX_LEN:
        return (False, "length must be %d-%d columns" % (MIN_LEN, MAX_LEN))
    beyond = 0
    for k in doc["objects"]:
        if k // ROWS >= col:
            beyond += 1
    if beyond:
        return (False, "%d object(s) lie beyond column %d" % (beyond, col - 1))
    before = int(doc.get("len", 0))
    if col == before:
        return (True, "length is already %d" % col)
    _push(doc, [("len", before, col)])
    doc["len"] = col
    return (True, "length set to %d" % col)


def clear(doc):
    """Remove every object as ONE undoable action. False when already empty."""
    if not doc["objects"]:
        return False
    changes = []
    for k in sorted(doc["objects"].keys()):
        changes.append(("cell", k, doc["objects"][k], None))
    _push(doc, changes)
    doc["objects"] = {}
    return True


# ---- settings ---------------------------------------------------------------


def setting_field(index):
    return SETTING_FIELDS[index % len(SETTING_FIELDS)]


def adjust_setting(doc, index, delta):
    """Nudge one of mode/speed/size/diff/beat/bg. Returns (field, value)."""
    field = setting_field(index)
    low, high, wraps, step = SETTING_RANGES[field]
    try:
        value = int(doc.get(field, HEADER_DEFAULTS[field]))
    except (TypeError, ValueError):
        value = HEADER_DEFAULTS[field]
    value += int(delta) * step
    if wraps:
        value = low + (value - low) % (high - low + 1)
    elif value < low:
        value = low
    elif value > high:
        value = high
    doc[field] = value
    return (field, value)


def setting_label(doc, index):
    field = setting_field(index)
    value = doc.get(field, HEADER_DEFAULTS[field])
    try:
        value = int(value)
    except (TypeError, ValueError):
        value = HEADER_DEFAULTS[field]
    if field == "mode" and 0 <= value < len(MODES):
        text = MODES[value]
    elif field == "speed" and 0 <= value < len(SPEED_LABELS):
        text = SPEED_LABELS[value]
    elif field == "size":
        text = "mini" if value else "normal"
    else:
        text = str(value)
    return "%s %s" % (field, text)


# ---- the name field ---------------------------------------------------------


def field_new(text=""):
    text = str(text)
    return {"text": text, "caret": len(text), "done": False}


def field_key(field, key_name, shift=False):
    """Feed one engine key name into a hand-rolled text field: letters (shift
    for capitals), digits, space, minus, backspace/delete, caret moves, enter
    marks it done. Capped at MAX_NAME characters. Returns the field."""
    text = field["text"]
    caret = field["caret"]
    if caret < 0:
        caret = 0
    if caret > len(text):
        caret = len(text)
    if key_name == "enter":
        field["done"] = True
        field["caret"] = caret
        return field
    if key_name == "backspace":
        if caret > 0:
            field["text"] = text[:caret - 1] + text[caret:]
            caret -= 1
        field["caret"] = caret
        return field
    if key_name == "delete":
        if caret < len(text):
            field["text"] = text[:caret] + text[caret + 1:]
        field["caret"] = caret
        return field
    if key_name == "left":
        field["caret"] = caret - 1 if caret > 0 else 0
        return field
    if key_name == "right":
        field["caret"] = caret + 1 if caret < len(text) else len(text)
        return field
    if key_name == "home":
        field["caret"] = 0
        return field
    if key_name == "end":
        field["caret"] = len(text)
        return field
    ch = None
    if len(key_name) == 1 and key_name in FIELD_LETTERS:
        ch = key_name.upper() if shift else key_name
    elif len(key_name) == 1 and key_name in FIELD_DIGITS:
        ch = key_name
    elif key_name == "space":
        ch = " "
    elif key_name == "minus":
        ch = "_" if shift else "-"
    if ch is not None and len(text) < MAX_NAME:
        field["text"] = text[:caret] + ch + text[caret:]
        caret += 1
    field["caret"] = caret
    return field


# ---- palette and cells ------------------------------------------------------


def palette_rect(i):
    """Screen rectangle (x, y, w, h) of palette entry i (one 16 px row)."""
    return (PAL_X + i * PAL_CELL, PAL_Y, PAL_CELL, PAL_CELL)


def hit_palette(mx, my):
    """Palette index under a SCREEN point, or -1."""
    if my < PAL_Y or my >= PAL_Y + PAL_CELL or mx < PAL_X:
        return -1
    i = int((mx - PAL_X) // PAL_CELL)
    if i < 0 or i >= len(PALETTE):
        return -1
    return i


def cell_at(mx, my, scroll_x=0, scroll_y=0):
    """(col, row) under a point. `mouse_x/y` are already room coordinates
    (the view offset -- the editor's scroll -- is included), so the live
    editor passes 0, 0; the headless tests pass an explicit scroll."""
    return (col_at(mx + scroll_x), row_at(my + scroll_y))
