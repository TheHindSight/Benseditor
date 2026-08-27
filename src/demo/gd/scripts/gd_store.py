# gd_store -- custom levels in the DataStore.
#
# DataStore "gd":
#   gd/index          {"seq": n, "entries": {id: {name, len, verified, best,
#                      size, seq, author}}}
#   gd/level/<guid>   {"id", "data" (GD1 text), "verified", "verify_attempts",
#                      "best", "completions", "coins": [b, b, b], "seq"}
#
# The store is localStorage under the hood and fails SILENTLY on quota, so
# every write is read back and compared; each function returns
# (ok, message). Depends on gd_const and gd_codec.

_DS = game.GetService("DataStoreService").GetDataStore("gd")
_HTTP = game.GetService("HttpService")

INDEX_KEY = "index"
LEVEL_PREFIX = "level/"

SAVE_FAILED = "SAVE FAILED: nothing was stored (storage full?)"


def _level_key(level_id):
    return LEVEL_PREFIX + str(level_id)


def new_id():
    return _HTTP.GenerateGUID()


def load_index():
    index = _DS.GetAsync(INDEX_KEY)
    if not isinstance(index, dict):
        index = {}
    if not isinstance(index.get("seq"), int):
        index["seq"] = 0
    if not isinstance(index.get("entries"), dict):
        index["entries"] = {}
    return index


def list_levels():
    """Index entries (each with its "id"), oldest first."""
    index = load_index()
    rows = []
    for level_id in index["entries"]:
        entry = dict(index["entries"][level_id])
        entry["id"] = level_id
        rows.append(entry)
    rows.sort(key=lambda e: e.get("seq", 0))
    return rows


def load_level(level_id):
    """The stored record, or None."""
    record = _DS.GetAsync(_level_key(level_id))
    if not isinstance(record, dict) or not isinstance(record.get("data"), str):
        return None
    return record


def _write_index(index):
    _DS.SetAsync(INDEX_KEY, index)
    back = _DS.GetAsync(INDEX_KEY)
    if not isinstance(back, dict) or back.get("seq") != index["seq"]:
        return False
    if sorted(back.get("entries", {}).keys()) != sorted(index["entries"].keys()):
        return False
    return True


def _write_record(record):
    _DS.SetAsync(_level_key(record["id"]), record)
    back = load_level(record["id"])
    return back is not None and back["data"] == record["data"] and back.get("verified") == record.get("verified")


def _entry_for(record, level):
    return {
        "name": level["name"],
        "author": level.get("author", ""),
        "len": int(level["len"]),
        "verified": bool(record.get("verified", False)),
        "best": int(record.get("best", 0)),
        "size": len(record["data"]),
        "seq": int(record.get("seq", 0)),
    }


def _update_entry(level_id, record, level=None):
    index = load_index()
    if level is None:
        level = decode_level(record["data"])
    entry = _entry_for(record, level)
    if level_id not in index["entries"]:
        index["seq"] += 1
        entry["seq"] = index["seq"]
        record["seq"] = entry["seq"]
    else:
        entry["seq"] = index["entries"][level_id].get("seq", entry["seq"])
    index["entries"][level_id] = entry
    return _write_index(index)


def save_level(doc_or_level, level_id=None):
    """Validate, encode, store, read back and index a level.

    Accepts a level dict (gd_codec), a GD1 string, or an editor document
    holding the level under "level" (and its id under "id"). The id used is
    written back into the level as level["id"]. A save whose data differs from
    the stored data drops the verified flag. Returns (ok, message)."""
    level = doc_or_level
    if isinstance(level, dict) and "level" in level and "objects" not in level:
        if level_id is None:
            level_id = level.get("id")
        level = level["level"]
    if isinstance(level, str):
        try:
            level = decode_level(level)
        except ValueError as error:
            return (False, str(error))
    if not isinstance(level, dict) or "objects" not in level:
        return (False, "not a level")
    problems = validate_level(level)
    if problems:
        return (False, problems[0])
    data = encode_level(level)
    if level_id is None:
        level_id = level.get("id")
    if level_id is None or level_id == "":
        level_id = new_id()
    level["id"] = level_id

    previous = load_level(level_id)
    record = {
        "id": level_id,
        "data": data,
        "verified": False,
        "verify_attempts": 0,
        "best": 0,
        "completions": 0,
        "coins": [False, False, False],
        "seq": 0,
    }
    if previous is not None:
        for k in ("verified", "verify_attempts", "best", "completions", "coins", "seq"):
            if k in previous:
                record[k] = previous[k]
        if previous["data"] != data:
            record["verified"] = False
            record["verify_attempts"] = 0
    if not _write_record(record):
        return (False, SAVE_FAILED)
    if not _update_entry(level_id, record, level):
        return (False, "SAVE FAILED: the level was stored but the index was not")
    return (True, "Saved")


def delete_level(level_id):
    _DS.RemoveAsync(_level_key(level_id))
    if load_level(level_id) is not None:
        return (False, "DELETE FAILED: the level is still stored")
    index = load_index()
    if level_id in index["entries"]:
        del index["entries"][level_id]
        if not _write_index(index):
            return (False, "DELETE FAILED: the index was not updated")
    return (True, "Deleted")


def mark_verified(level_id, data, attempts):
    """Flag a level VERIFIED -- only when the data the run played equals the
    stored data, so a run started before an edit cannot verify the edit."""
    record = load_level(level_id)
    if record is None:
        return (False, "no such level")
    if record["data"] != data:
        return (False, "the level changed since this run started")
    record["verified"] = True
    record["verify_attempts"] = int(attempts)
    if not _write_record(record):
        return (False, SAVE_FAILED)
    if not _update_entry(level_id, record):
        return (False, "SAVE FAILED: the index was not updated")
    return (True, "Verified")


def record_best(level_id, pct):
    record = load_level(level_id)
    if record is None:
        return (False, "no such level")
    pct = int(max(0, min(100, pct)))
    if pct <= int(record.get("best", 0)):
        return (True, "unchanged")
    record["best"] = pct
    if not _write_record(record):
        return (False, SAVE_FAILED)
    if not _update_entry(level_id, record):
        return (False, "SAVE FAILED: the index was not updated")
    return (True, "Saved")


def record_completion(level_id, coins=None):
    """A finished normal run: best 100, completions + 1, coins merged in."""
    record = load_level(level_id)
    if record is None:
        return (False, "no such level")
    record["best"] = 100
    record["completions"] = int(record.get("completions", 0)) + 1
    had = record.get("coins")
    if not isinstance(had, list) or len(had) != MAX_COINS:
        had = [False] * MAX_COINS
    if coins:
        for i in range(MAX_COINS):
            if i < len(coins) and coins[i]:
                had[i] = True
    record["coins"] = had
    if not _write_record(record):
        return (False, SAVE_FAILED)
    if not _update_entry(level_id, record):
        return (False, "SAVE FAILED: the index was not updated")
    return (True, "Saved")


def storage_used():
    """Approximate bytes held by the gd store (keys and JSON values)."""
    index = load_index()
    total = len("gd/" + INDEX_KEY) + len(_HTTP.JSONEncode(index))
    for level_id in index["entries"]:
        record = load_level(level_id)
        if record is not None:
            total += len("gd/" + _level_key(level_id)) + len(_HTTP.JSONEncode(record))
    return total
