# levels_menu: the rows the level select shows, merging the generated
# built-ins (`BUILTIN` from gd_levels) with the custom index (`gd_store`).
# Each row: {"id", "name", "author", "difficulty", "builtin", "verified", "data"}.

LEVELS_DEFAULT_AUTHOR = "RobTop"


def _lookup(name, module_name):
    value = globals().get(name)
    if value is not None:
        return value
    module = ScriptService.FindFirstChild(module_name)
    if module is None:
        return None
    try:
        return getattr(module, name)
    except AttributeError:
        return None


def _difficulty(value):
    try:
        value = int(value)
    except Exception:
        return 1
    if value < 0:
        return 0
    if value > 10:
        return 10
    return value


def _row(entry, builtin):
    row = {
        "id": str(entry.get("id") or ""),
        "name": str(entry.get("name") or "Untitled"),
        "author": str(entry.get("author") or (LEVELS_DEFAULT_AUTHOR if builtin else "you")),
        "difficulty": _difficulty(entry.get("difficulty", 1)),
        "builtin": builtin,
        "verified": True if builtin else entry.get("verified") is True,
        "data": entry.get("data"),
    }
    return row


def _entries(index):
    if isinstance(index, dict):
        entries = index.get("entries")
        if isinstance(entries, list):
            return entries
        if isinstance(entries, dict):
            return list(entries.values())
        return []
    if isinstance(index, list):
        return index
    return []


def levels_list():
    rows = []
    builtin = _lookup("BUILTIN", "gd_levels")
    if isinstance(builtin, list):
        for entry in builtin:
            if isinstance(entry, dict):
                rows.append(_row(entry, True))
    load_index = _lookup("load_index", "gd_store")
    if load_index is not None:
        try:
            index = load_index()
        except Exception:
            index = None
        for entry in _entries(index):
            if isinstance(entry, dict):
                rows.append(_row(entry, False))
    return rows


def levels_get(level_id):
    """One row by id, with its data loaded if the index only held metadata."""
    for row in levels_list():
        if row["id"] == str(level_id):
            return levels_load_data(row)
    return None


def levels_load_data(row):
    """Fill in `data` for a custom row whose index entry lacks it."""
    if row.get("data") or row.get("builtin"):
        return row
    load_level = _lookup("load_level", "gd_store")
    if load_level is not None:
        try:
            data = load_level(row["id"])
        except Exception:
            data = None
        if isinstance(data, dict):
            data = data.get("data")
        if isinstance(data, str):
            row["data"] = data
    return row
