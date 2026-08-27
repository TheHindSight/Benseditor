# gd_codec -- the GD1 level text format.
#
#   GD1;name=Stereo Steps;len=116;diff=2|S18.0;B30.0*4;O61.2;G78.11;C12.0
#
# Header: `GD1` then `key=value` fields separated by `;` (unknown keys are kept
# in level["extra"] and ignored). Objects after `|`, separated by `;`:
#   CODE COL '.' ROW [PARAM] ['*' RUN]
# CODE is one letter of TYPES, COL/ROW are ints, PARAM one character (omitted
# when it is the type's default), RUN repeats the object over RUN consecutive
# columns. PARAM is written with the type's `text` alphabet (a letter even for
# digit-valued parameters -- `S24.0d`, `M20.1s`, `C12.0b` -- because a digit
# after the row digits would be ambiguous); in memory the parameter is the
# `params` value (`"1"`, `"4"`, ...). Encoding is canonical -- objects sorted by (col, row), runs collapsed
# maximally, defaults omitted -- so equal strings mean equal levels.
#
# A level in memory is a dict:
#   {name, author, len, mode, speed, size, diff, bg, beat, objects, extra}
# with objects = {key(col, row): (code, param)}. Depends on gd_const.

_NAME_FORBIDDEN = ";|\n\r"


def new_level(name=None):
    level = {}
    for k in HEADER_KEYS:
        level[k] = HEADER_DEFAULTS[k]
    if name is not None:
        level["name"] = name
    level["objects"] = {}
    level["extra"] = {}
    return level


def level_key(col, row):
    return key(col, row)


def level_unkey(k):
    return unkey(k)


def default_param(code):
    params = TYPES[code]["params"]
    return params[0] if params else ""


def param_to_text(code, param):
    info = TYPES[code]
    at = info["params"].find(param)
    return info["text"][at] if at >= 0 and at < len(info["text"]) else param


def param_from_text(code, text):
    """The in-memory parameter for a text character, or None when unknown."""
    info = TYPES[code]
    at = info["text"].find(text)
    if at < 0 or at >= len(info["params"]):
        return None
    return info["params"][at]


def place_object(level, code, col, row, param=None):
    """Put one object at a cell (replacing what was there). Returns the key."""
    if param is None or param == "":
        param = default_param(code)
    if row < 0 or row >= ROWS or col < 0:
        raise ValueError("cell (%d, %d) is outside the grid (rows 0-%d)" % (col, row, ROWS - 1))
    k = key(col, row)
    level["objects"][k] = (code, param)
    return k


def _header_value(k, raw):
    if k in ("name", "author"):
        return raw
    try:
        return int(raw)
    except ValueError:
        try:
            return int(float(raw))
        except ValueError:
            return HEADER_DEFAULTS[k]


def encode_header(level):
    parts = [MAGIC]
    for k in HEADER_KEYS:
        value = level.get(k, HEADER_DEFAULTS[k])
        if k in ("name", "author"):
            text = str(value)
            for ch in _NAME_FORBIDDEN:
                text = text.replace(ch, " ")
            value = text
        else:
            value = int(value)
        if k != "name" and k != "len" and value == HEADER_DEFAULTS[k]:
            continue
        parts.append("%s=%s" % (k, value))
    return ";".join(parts)


def encode_objects(objects):
    """Canonical object list: sorted by (col, row), maximal runs, defaults omitted."""
    keys = sorted(objects.keys())
    consumed = set()
    out = []
    for k in keys:
        if k in consumed:
            continue
        code, param = objects[k]
        col, row = unkey(k)
        run = 1
        while True:
            nk = key(col + run, row)
            other = objects.get(nk)
            if other is None or other[0] != code or other[1] != param or nk in consumed:
                break
            consumed.add(nk)
            run += 1
        entry = "%s%d.%d" % (code, col, row)
        if param != default_param(code):
            entry += param_to_text(code, param)
        if run > 1:
            entry += "*%d" % run
        out.append(entry)
    return ";".join(out)


def encode_level(level):
    return encode_header(level) + "|" + encode_objects(level["objects"])


def _parse_entry(entry, objects):
    """One `CODE COL . ROW [PARAM] [*RUN]` entry into objects; raises ValueError."""
    if len(entry) < 4:
        raise ValueError("bad object entry '%s'" % entry)
    code = entry[0]
    info = TYPES.get(code)
    if info is None:
        raise ValueError("unknown object code '%s' in '%s'" % (code, entry))
    rest = entry[1:]
    run = 1
    star = rest.find("*")
    if star >= 0:
        try:
            run = int(rest[star + 1:])
        except ValueError:
            raise ValueError("bad run in '%s'" % entry)
        if run < 1:
            raise ValueError("bad run in '%s'" % entry)
        rest = rest[:star]
    dot = rest.find(".")
    if dot <= 0:
        raise ValueError("missing '.' in '%s'" % entry)
    try:
        col = int(rest[:dot])
    except ValueError:
        raise ValueError("bad column in '%s'" % entry)
    rest = rest[dot + 1:]
    digits = 0
    while digits < len(rest) and rest[digits] >= "0" and rest[digits] <= "9":
        digits += 1
    if digits == 0:
        raise ValueError("bad row in '%s'" % entry)
    row = int(rest[:digits])
    if row >= ROWS:
        raise ValueError("row %d outside 0-%d in '%s'" % (row, ROWS - 1, entry))
    param = rest[digits:]
    if len(param) > 1:
        raise ValueError("bad parameter in '%s'" % entry)
    if param == "":
        param = default_param(code)
    else:
        value = param_from_text(code, param) if info["params"] != "" else None
        if value is None:
            raise ValueError("unknown parameter '%s' for %s in '%s'" % (param, info["name"], entry))
        param = value
    for i in range(run):
        objects[key(col + i, row)] = (code, param)


def decode_level(text):
    """Parse a GD1 string. Raises ValueError on a malformed string; unknown
    header keys are tolerated (kept in level["extra"])."""
    if not isinstance(text, str):
        raise ValueError("level data must be a string")
    text = text.strip()
    bar = text.find("|")
    header_text = text if bar < 0 else text[:bar]
    body = "" if bar < 0 else text[bar + 1:]
    fields = header_text.split(";")
    if fields[0] != MAGIC:
        raise ValueError("not a GD1 level (header starts with '%s')" % fields[0][:8])
    level = new_level()
    for field in fields[1:]:
        if field == "":
            continue
        eq = field.find("=")
        if eq < 0:
            level["extra"][field] = ""
            continue
        k = field[:eq]
        raw = field[eq + 1:]
        if k in HEADER_KEYS:
            level[k] = _header_value(k, raw)
        else:
            level["extra"][k] = raw
    objects = level["objects"]
    for entry in body.split(";"):
        entry = entry.strip()
        if entry == "":
            continue
        _parse_entry(entry, objects)
    return level


def name_ok(name):
    if not isinstance(name, str):
        return False
    if len(name) < 1 or len(name) > MAX_NAME:
        return False
    for ch in name:
        if ch in _NAME_FORBIDDEN or ord(ch) < 32 or ord(ch) > 126:
            return False
    if name.strip() == "":
        return False
    return True


def validate_level(level):
    """A list of problems (empty means the level is playable)."""
    problems = []
    name = level.get("name", "")
    if not name_ok(name):
        problems.append("name must be 1-%d printable characters without ; or |" % MAX_NAME)
    length = level.get("len", 0)
    if not isinstance(length, int) or length < MIN_LEN or length > MAX_LEN:
        problems.append("length must be between %d and %d columns" % (MIN_LEN, MAX_LEN))
        length = MAX_LEN if not isinstance(length, int) else max(MIN_LEN, min(MAX_LEN, length))
    mode = level.get("mode", 0)
    if not isinstance(mode, int) or mode < 0 or mode >= len(MODES):
        problems.append("start mode must be 0-%d" % (len(MODES) - 1))
    speed = level.get("speed", 1)
    if not isinstance(speed, int) or speed < 0 or speed >= len(SPEED_LABELS):
        problems.append("start speed must be 0-%d" % (len(SPEED_LABELS) - 1))
    size = level.get("size", 0)
    if size not in (0, 1):
        problems.append("size must be 0 (normal) or 1 (mini)")
    diff = level.get("diff", 1)
    if not isinstance(diff, int) or diff < 1 or diff > 10:
        problems.append("difficulty must be 1-10")
    objects = level.get("objects", {})
    if len(objects) > MAX_OBJECTS:
        problems.append("too many objects (%d, the limit is %d)" % (len(objects), MAX_OBJECTS))
    out_of_bounds = 0
    run_up = 0
    coins = {}
    for k in sorted(objects.keys()):
        code, param = objects[k]
        col, row = unkey(k)
        info = TYPES.get(code)
        if info is None:
            problems.append("unknown object code '%s' at column %d" % (code, col))
            continue
        if info["params"] and param not in info["params"]:
            problems.append("bad parameter '%s' for %s at column %d" % (param, info["name"], col))
        if col < 0 or row < 0 or row >= ROWS or col >= length:
            out_of_bounds += 1
        elif col < SPAWN_COLS:
            run_up += 1
        if code == "C":
            coins[param] = coins.get(param, 0) + 1
    if out_of_bounds:
        problems.append("%d object(s) outside the level (columns 0-%d, rows 0-%d)" % (out_of_bounds, length - 1, ROWS - 1))
    if run_up:
        problems.append("columns 0-%d must be empty (the run-up)" % (SPAWN_COLS - 1))
    total_coins = 0
    for index in sorted(coins.keys()):
        count = coins[index]
        total_coins += count
        if count > 1:
            problems.append("coin %s is placed %d times (each index once)" % (index, count))
    if total_coins > MAX_COINS:
        problems.append("at most %d coins" % MAX_COINS)
    return problems


def objects_in_column(level, col):
    """[(row, code, param), ...] sorted by row for one column."""
    found = []
    objects = level["objects"]
    base = key(col, 0)
    for row in range(ROWS):
        entry = objects.get(base + row)
        if entry is not None:
            found.append((row, entry[0], entry[1]))
    return found


def level_columns(level):
    """{col: [(row, code, param), ...]} for every non-empty column, rows ascending."""
    columns = {}
    for k in sorted(level["objects"].keys()):
        code, param = level["objects"][k]
        col, row = unkey(k)
        bucket = columns.get(col)
        if bucket is None:
            bucket = []
            columns[col] = bucket
        bucket.append((row, code, param))
    return columns


def level_tiles(level):
    """{(tile_x, tile_y): tile index} for every block; the floor is authored in the room."""
    tiles = {}
    for k, entry in level["objects"].items():
        if entry[0] == "B":
            col, row = unkey(k)
            if 0 <= row < ROWS and 0 <= col < MAX_COLUMNS:
                tiles[(col, tile_y(row))] = TILE_BLOCK
    return tiles


def start_state(level):
    return {
        "mode": int(level.get("mode", 0)),
        "speed": int(level.get("speed", 1)),
        "gravity": 0,
        "mini": 1 if level.get("size", 0) else 0,
    }


def _apply_state(state, code, param):
    if code == "M":
        state["mode"] = int(param)
    elif code == "V":
        state["speed"] = int(param)
    elif code == "Z":
        state["mini"] = int(param)
    elif code == "G":
        state["gravity"] = int(param)
    elif code == "P" and param in ("b", "w"):
        # Blue and spider pads flip gravity and cannot be skipped on the ground path.
        state["gravity"] = 1 - state["gravity"]


def level_states(level):
    """The state in force at every column 0..len-1, as a list of dicts.
    Portals (and the gravity-flipping pads) act at their own column."""
    state = start_state(level)
    columns = level_columns(level)
    out = []
    length = int(level.get("len", 0))
    for col in range(length):
        bucket = columns.get(col)
        if bucket:
            for row, code, param in bucket:
                _apply_state(state, code, param)
        out.append(dict(state))
    return out


def state_at_column(level, col):
    """{mode, speed, gravity, mini} in force at a column (portals at columns <= col applied)."""
    state = start_state(level)
    for k in sorted(level["objects"].keys()):
        c, row = unkey(k)
        if c > col:
            break
        code, param = level["objects"][k]
        _apply_state(state, code, param)
    return state


def level_summary(level):
    counts = {}
    for entry in level["objects"].values():
        counts[entry[0]] = counts.get(entry[0], 0) + 1
    modes = set()
    speeds = set()
    for state in level_states(level):
        modes.add(state["mode"])
        speeds.add(state["speed"])
    return {
        "name": level.get("name", ""),
        "len": int(level.get("len", 0)),
        "objects": len(level["objects"]),
        "blocks": counts.get("B", 0),
        "coins": counts.get("C", 0),
        "counts": counts,
        "modes": sorted(modes),
        "speeds": sorted(speeds),
        "size": len(encode_level(level)),
    }
