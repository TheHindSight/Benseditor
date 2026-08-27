# progress: the player's settings and per-level records, in DataStore "gd".
#
#   settings = {version, primary, secondary, icon}
#   progress = {version, levels: {id: {best, practice_best, coins[3],
#                                       attempts, completed, verified}}}
#
# Every save is read straight back and compared; a mismatch (the browser's
# storage quota is exceeded silently) sets progress_state["save_failed"] so
# the HUD can show SAVE FAILED instead of pretending.

PROGRESS_VERSION = 1
PROGRESS_STORE = "gd"
PROGRESS_KEY = "progress"
SETTINGS_KEY = "settings"

# Palette indices into UI_COLOURS: yellow body, blue detail, the classic cube.
DEFAULT_PRIMARY = 10
DEFAULT_SECONDARY = 12

progress_state = {
    "settings": None,
    "progress": None,
    "loaded": False,
    "save_failed": False,
}


def _store():
    return DataStoreService.GetDataStore(PROGRESS_STORE)


def progress_default_settings():
    return {"version": PROGRESS_VERSION, "primary": DEFAULT_PRIMARY, "secondary": DEFAULT_SECONDARY, "icon": 0}


def progress_default():
    return {"version": PROGRESS_VERSION, "levels": {}}


def progress_default_level():
    return {
        "best": 0,
        "practice_best": 0,
        "coins": [False, False, False],
        "attempts": 0,
        "completed": False,
        "verified": False,
    }


def _int(value, low, high, fallback):
    try:
        value = int(value)
    except Exception:
        return fallback
    if value < low or value > high:
        return fallback
    return value


def _clean_settings(raw):
    clean = progress_default_settings()
    if isinstance(raw, dict):
        clean["primary"] = _int(raw.get("primary"), 0, 15, DEFAULT_PRIMARY)
        clean["secondary"] = _int(raw.get("secondary"), 0, 15, DEFAULT_SECONDARY)
        clean["icon"] = _int(raw.get("icon"), 0, 3, 0)
    return clean


def _clean_level(raw):
    clean = progress_default_level()
    if not isinstance(raw, dict):
        return clean
    clean["best"] = _int(raw.get("best"), 0, 100, 0)
    clean["practice_best"] = _int(raw.get("practice_best"), 0, 100, 0)
    clean["attempts"] = _int(raw.get("attempts"), 0, 1000000000, 0)
    clean["completed"] = raw.get("completed") is True
    clean["verified"] = raw.get("verified") is True
    coins = raw.get("coins")
    if isinstance(coins, list):
        for i in range(3):
            clean["coins"][i] = i < len(coins) and coins[i] is True
    return clean


def _clean_progress(raw):
    clean = progress_default()
    if isinstance(raw, dict):
        levels = raw.get("levels")
        if isinstance(levels, dict):
            for key, value in levels.items():
                if isinstance(key, str) and key != "":
                    clean["levels"][key] = _clean_level(value)
    return clean


def progress_load(force=False):
    """Read both records from the store (once; `force` re-reads)."""
    state = progress_state
    if state["loaded"] and not force:
        return state["progress"]
    store = _store()
    state["settings"] = _clean_settings(store.GetAsync(SETTINGS_KEY, None))
    state["progress"] = _clean_progress(store.GetAsync(PROGRESS_KEY, None))
    state["loaded"] = True
    return state["progress"]


def _write_back(key, value):
    """SetAsync, then read back: True only when the store holds the value."""
    store = _store()
    try:
        store.SetAsync(key, value)
    except Exception:
        return False
    stored = store.GetAsync(key, None)
    return stored == value


def progress_settings():
    progress_load()
    return progress_state["settings"]


def progress_save_settings(primary=None, secondary=None, icon=None):
    """Update any of the three fields and persist. Returns True when the
    store read back what was written."""
    settings = progress_settings()
    if primary is not None:
        settings["primary"] = _int(primary, 0, 15, settings["primary"])
    if secondary is not None:
        settings["secondary"] = _int(secondary, 0, 15, settings["secondary"])
    if icon is not None:
        settings["icon"] = _int(icon, 0, 3, settings["icon"])
    ok = _write_back(SETTINGS_KEY, settings)
    progress_state["save_failed"] = not ok
    return ok


def progress_level(level_id):
    """The record for a level, created in memory on first use."""
    progress = progress_load()
    key = str(level_id)
    entry = progress["levels"].get(key)
    if entry is None:
        entry = progress_default_level()
        progress["levels"][key] = entry
    return entry


def progress_peek(level_id):
    """The record for a level without creating one: a default for unknown ids."""
    progress = progress_load()
    entry = progress["levels"].get(str(level_id))
    if entry is None:
        return progress_default_level()
    return entry


def progress_save():
    """Persist the progress record. Returns True only when the read-back
    matches; otherwise progress_state["save_failed"] is set."""
    progress = progress_load()
    ok = _write_back(PROGRESS_KEY, progress)
    progress_state["save_failed"] = not ok
    return ok


def progress_record_death(level_id, pct, practice=False):
    """One attempt ended short of the finish. Practice attempts never touch
    `best`; they keep their own `practice_best`."""
    entry = progress_level(level_id)
    pct = _int(pct, 0, 100, 0)
    entry["attempts"] += 1
    if practice:
        if pct > entry["practice_best"]:
            entry["practice_best"] = pct
    elif pct > entry["best"]:
        entry["best"] = pct
    progress_save()
    return entry


def progress_record_complete(level_id, coins, practice=False, mode="play"):
    """The level was finished. Normal and verify runs mark it completed with
    best 100 and OR in the coins collected; a verify run also marks the
    level verified. Practice completions only raise practice_best."""
    entry = progress_level(level_id)
    entry["attempts"] += 1
    if practice:
        entry["practice_best"] = 100
    else:
        entry["best"] = 100
        entry["completed"] = True
        if isinstance(coins, (list, tuple)):
            for i in range(3):
                if i < len(coins) and coins[i]:
                    entry["coins"][i] = True
        if mode == "verify":
            entry["verified"] = True
    progress_save()
    return entry


def progress_reset():
    """Forget everything, in memory and in the store."""
    store = _store()
    progress_state["settings"] = progress_default_settings()
    progress_state["progress"] = progress_default()
    progress_state["loaded"] = True
    try:
        store.RemoveAsync(PROGRESS_KEY)
        store.RemoveAsync(SETTINGS_KEY)
    except Exception:
        pass
    ok = store.GetAsync(PROGRESS_KEY, None) is None and store.GetAsync(SETTINGS_KEY, None) is None
    progress_state["save_failed"] = not ok
    return ok
