# run: one play session of a level, surviving every `room_restart`.
#
# The hand-off in ReplicatedStorage "gd.run" says what to play:
#   {mode: "play"|"test"|"verify", source, level_id, data, start_col, return_to}
# and "gd.result" is written when the run ends:
#   {finished, attempts, practice_used, coins, best_pct, time, jumps, ...}
#
# The HUD drives this module: `run_room_start(hud)` on every room start (so a
# restart re-applies the practice checkpoint), `run_tick(player)` every step.
# The player calls `run_die`, `run_coin_touch`, `run_finish`, `run_jump` and
# checks `run_input_locked()` / `run_frozen()`.
#
# Physics helpers from gdphys (`gd_percent`, `gd_snapshot`, `gd_restore`) are
# looked up at call time and degrade to x/y bookkeeping when absent, so this
# module also runs without the physics script.

RUN_ROOM = "rm_play"
RUN_END_ROOM = "rm_end"
RUN_CELL = 30
RUN_AUTO_INTERVAL = 120     # steps between automatic practice checkpoints
RUN_LOCK_STEPS = 10         # input lock after resuming from pause
RUN_DEATH_STEPS = 40        # explosion, then room_restart
RUN_FINISH_STEPS = 60       # LEVEL COMPLETE flash, then rm_end
RUN_BANNER_STEPS = 90       # "Attempt N" banner
RUN_MAX_CHECKPOINTS = 100
RUN_PARTICLES = 24

run_state = {
    "active": False,
    "handoff": None,
    "mode": "play",
    "level_id": None,
    "name": "",
    "data": "",
    "length_px": 0,
    "start_col": 0,
    "return_to": "rm_levels",
    "practice": False,
    "practice_used": False,
    "attempts": 1,
    "checkpoints": [],
    "auto_timer": 0,
    "paused": False,
    "lock": 0,
    "frozen": False,
    "frozen_motion": None,
    "dead": False,
    "death_timer": 0,
    "death_x": 0,
    "death_y": 0,
    "particles": [],
    "finished": False,
    "finish_timer": 0,
    "coins_run": [False, False, False],
    "time": 0,
    "jumps": 0,
    "pct": 0,
    "run_best": 0,
    "best_pct": 0,
    "new_best": False,
    "pending_restore": None,
    "banner": 0,
    "result": None,
    "message": "",
    "message_timer": 0,
}


# ---- contracts owned by other scripts ----------------------------------------


def _contract(name, module_name):
    """A function another shared script defines, if it has been registered:
    first as a global (scripts registered earlier), then through require."""
    fn = globals().get(name)
    if fn is not None:
        return fn
    module = ScriptService.FindFirstChild(module_name)
    if module is None:
        return None
    try:
        return getattr(module, name)
    except AttributeError:
        return None


def _header_fields(data):
    """The `k=v` pairs of a level string's header (`GD1;name=..;len=..|...`)."""
    fields = {}
    if not isinstance(data, str):
        return fields
    head = data.split("|")[0]
    for part in head.split(";"):
        at = part.find("=")
        if at > 0:
            fields[part[:at]] = part[at + 1:]
    return fields


def _length_px(level, data):
    columns = 0
    if isinstance(level, dict):
        try:
            columns = int(level.get("columns") or level.get("len") or 0)
        except Exception:
            columns = 0
    if columns <= 0:
        try:
            columns = int(_header_fields(data).get("len", "0"))
        except Exception:
            columns = 0
    if columns <= 0:
        level_columns = _contract("level_columns", "gd_codec")
        if level_columns is not None:
            try:
                columns = int(level_columns(data))
            except Exception:
                columns = 0
    if columns <= 0:
        return 0
    return columns * RUN_CELL


def _percent(player):
    s = run_state
    gd_percent = _contract("gd_percent", "gdphys")
    if gd_percent is not None:
        try:
            return int(clamp(gd_percent(player), 0, 100))
        except Exception:
            pass
    length = s["length_px"]
    if length <= 0:
        length = room_width()
    if length <= 0:
        return 0
    return int(clamp(player.x / length * 100, 0, 100))


def _settings_colours():
    settings = globals().get("progress_settings")
    colours = globals().get("UI_COLOURS")
    if settings is None or colours is None:
        return 0xFFEC27, 0x29ADFF
    try:
        s = settings()
        return colours[s["primary"]], colours[s["secondary"]]
    except Exception:
        return 0xFFEC27, 0x29ADFF


# ---- starting a run ----------------------------------------------------------


def _begin(handoff):
    """Reset every field for a fresh session of the level in the hand-off."""
    s = run_state
    level_id = handoff.get("level_id")
    data = handoff.get("data") or ""
    name = handoff.get("name")
    if not name:
        name = _header_fields(data).get("name", "") or "Untitled"
    mode = handoff.get("mode") or "play"
    return_to = handoff.get("return_to")
    if not return_to:
        return_to = "rm_editor" if mode in ("test", "verify") else "rm_levels"

    s["active"] = True
    s["handoff"] = handoff
    s["mode"] = mode
    s["level_id"] = level_id
    s["name"] = name
    s["data"] = data
    s["length_px"] = _length_px(handoff, data)
    s["start_col"] = int(handoff.get("start_col") or 0)
    s["return_to"] = return_to
    s["practice"] = False
    s["practice_used"] = False
    s["attempts"] = 1
    s["checkpoints"] = []
    s["auto_timer"] = 0
    s["paused"] = False
    s["lock"] = 0
    s["frozen"] = False
    s["frozen_motion"] = None
    s["dead"] = False
    s["death_timer"] = 0
    s["particles"] = []
    s["finished"] = False
    s["finish_timer"] = 0
    s["coins_run"] = [False, False, False]
    s["time"] = 0
    s["jumps"] = 0
    s["pct"] = 0
    s["run_best"] = 0
    s["new_best"] = False
    s["pending_restore"] = None
    s["banner"] = 0
    s["result"] = None
    s["message"] = ""
    s["message_timer"] = 0

    s["best_pct"] = 0
    level_record = globals().get("progress_level")
    if level_record is not None and level_id and mode != "test":
        try:
            s["best_pct"] = level_record(level_id)["best"]
        except Exception:
            s["best_pct"] = 0
    return s


def run_start(level, mode="play", start_col=0, return_to=None):
    """Hand a level to rm_play. `level` is a dict with id, name, data and
    optionally builtin. Returns the hand-off written to "gd.run"."""
    if not isinstance(level, dict):
        level = {"data": str(level)}
    if return_to is None:
        return_to = "rm_editor" if mode in ("test", "verify") else "rm_levels"
    handoff = {
        "mode": mode,
        "source": "builtin" if level.get("builtin") else "custom",
        "level_id": level.get("id"),
        "name": level.get("name") or "",
        "data": level.get("data") or "",
        "start_col": int(start_col or 0),
        "return_to": return_to,
    }
    ReplicatedStorage.Set("gd.run", handoff)
    _begin(handoff)
    try:
        room_goto(RUN_ROOM)
    except Exception:
        pass
    return handoff


def run_replay():
    """Play the same level again from the start, in the same mode."""
    handoff = run_state["handoff"]
    if handoff is None:
        handoff = ReplicatedStorage.Get("gd.run")
    if handoff is None:
        return None
    level = {
        "id": handoff.get("level_id"),
        "name": handoff.get("name"),
        "data": handoff.get("data"),
        "builtin": handoff.get("source") == "builtin",
    }
    return run_start(level, handoff.get("mode") or "play", handoff.get("start_col") or 0, handoff.get("return_to"))


def run_room_start(hud=None):
    """Called by the HUD's room_start: adopt a hand-off the editor wrote, and
    reset the per-attempt fields (restoring the practice checkpoint)."""
    s = run_state
    handoff = ReplicatedStorage.Get("gd.run")
    if handoff is not None and (not s["active"] or s["handoff"] is not handoff):
        _begin(handoff)
    if not s["active"]:
        return False

    s["dead"] = False
    s["death_timer"] = 0
    s["finished"] = False
    s["finish_timer"] = 0
    s["paused"] = False
    s["frozen"] = False
    s["frozen_motion"] = None
    s["lock"] = 0
    s["particles"] = []
    s["banner"] = RUN_BANNER_STEPS
    s["auto_timer"] = 0
    s["pending_restore"] = None

    checkpoints = s["checkpoints"]
    if s["practice"] and checkpoints:
        cp = checkpoints[-1]
        s["pending_restore"] = cp
        s["coins_run"] = list(cp["coins"])
        s["time"] = cp["time"]
        s["jumps"] = cp["jumps"]
        s["pct"] = cp["pct"]
    else:
        s["coins_run"] = [False, False, False]
        s["time"] = 0
        s["jumps"] = 0
        s["pct"] = 0
    return True


# ---- per step ----------------------------------------------------------------


def _find_player():
    try:
        return instance_find("obj_player")
    except Exception:
        return None


def _apply_restore(player):
    s = run_state
    cp = s["pending_restore"]
    s["pending_restore"] = None
    if cp is None:
        return
    restored = False
    gd_restore = _contract("gd_restore", "gdphys")
    if gd_restore is not None and cp.get("phys") is not None:
        try:
            gd_restore(player, cp["phys"])
            restored = True
        except Exception:
            restored = False
    if not restored:
        player.x = cp["x"]
        player.y = cp["y"]
    player.visible = True
    level = None
    try:
        level = instance_find("obj_level")
    except Exception:
        level = None
    if level is not None:
        # obj_level binds `reset_window` on itself in create; failing that,
        # gd_level may expose it as a shared function taking the instance.
        if hasattr(level, "reset_window"):
            try:
                level.reset_window(cp["col"])
            except Exception:
                pass
        else:
            reset = _contract("level_reset_window", "gd_level")
            if reset is not None:
                try:
                    reset(level, cp["col"])
                except Exception:
                    pass


def _update_particles():
    particles = run_state["particles"]
    alive = []
    for p in particles:
        p["x"] += p["vx"]
        p["y"] += p["vy"]
        p["vy"] += 0.15
        p["vx"] *= 0.98
        p["life"] -= 1
        if p["life"] > 0:
            alive.append(p)
    run_state["particles"] = alive


def run_tick(player=None):
    """Advance the run one step. `player` is the obj_player instance (or None
    while it does not exist yet). Returns True while the attempt is live."""
    s = run_state
    if not s["active"]:
        return False
    if s["lock"] > 0:
        s["lock"] -= 1
    if s["banner"] > 0:
        s["banner"] -= 1
    if s["message_timer"] > 0:
        s["message_timer"] -= 1
    _update_particles()
    if s["paused"]:
        return False

    if player is not None and s["pending_restore"] is not None:
        _apply_restore(player)

    if s["dead"]:
        if s["death_timer"] > 0:
            s["death_timer"] -= 1
            if s["death_timer"] == 0:
                room_restart()
        return False

    if s["finished"]:
        if s["finish_timer"] > 0:
            s["finish_timer"] -= 1
            if s["finish_timer"] == 0:
                _go_end()
        return False

    s["time"] += 1
    if player is None:
        return True

    # Bridge from the physics: gdphys sets `won` / `dead` on the player
    # instance. Both targets are one-shot (guarded by s["finished"] and
    # s["dead"]), so this stays correct if the player also calls them.
    if getattr(player, "won", False):
        run_finish(player)
        return False
    if getattr(player, "dead", False):
        run_die(player)
        return False

    pct = _percent(player)
    s["pct"] = pct
    if pct > s["run_best"]:
        s["run_best"] = pct

    if s["practice"]:
        if keyboard_check_pressed("z"):
            run_add_checkpoint(player)
        elif keyboard_check_pressed("x"):
            run_remove_checkpoint()
        s["auto_timer"] += 1
        if s["auto_timer"] >= RUN_AUTO_INTERVAL and getattr(player, "on_ground", False):
            run_add_checkpoint(player)
    return True


# ---- pause -------------------------------------------------------------------


def run_freeze():
    """Stop the player where it is (engine motion zeroed, remembered for thaw)."""
    s = run_state
    s["frozen"] = True
    player = _find_player()
    if player is not None and s["frozen_motion"] is None:
        s["frozen_motion"] = (player.hspeed, player.vspeed, player.gravity)
        player.hspeed = 0
        player.vspeed = 0
        player.gravity = 0
    return True


def run_thaw():
    s = run_state
    s["frozen"] = False
    motion = s["frozen_motion"]
    s["frozen_motion"] = None
    if motion is not None:
        player = _find_player()
        if player is not None:
            player.hspeed, player.vspeed, player.gravity = motion
    return True


def run_pause():
    s = run_state
    if not s["active"] or s["paused"] or s["dead"] or s["finished"]:
        return False
    s["paused"] = True
    run_freeze()
    return True


def run_resume():
    s = run_state
    if not s["paused"]:
        return False
    s["paused"] = False
    # +1: the tick of the step that resumed counts it down once already.
    s["lock"] = RUN_LOCK_STEPS + 1
    run_thaw()
    return True


def run_input_locked():
    """True while the player must ignore input: paused, frozen, or in the
    short lock after resuming so the click that closed the menu does not jump."""
    s = run_state
    return s["paused"] or s["frozen"] or s["lock"] > 0


def run_frozen():
    return run_state["frozen"] or run_state["paused"]


def run_paused():
    return run_state["paused"]


def run_active():
    return run_state["active"]


def run_dead():
    return run_state["dead"]


def run_finished():
    return run_state["finished"]


def run_practice():
    return run_state["practice"]


def run_mode():
    return run_state["mode"]


def run_attempt():
    return run_state["attempts"]


def run_say(text, steps=120):
    run_state["message"] = text
    run_state["message_timer"] = steps


# ---- practice ----------------------------------------------------------------


def run_toggle_practice():
    """Enter practice (checkpoints start fresh) or leave it (the level restarts
    from the beginning). Not allowed in a verify run. Returns the new state."""
    s = run_state
    if not s["active"] or s["mode"] == "verify":
        run_say("Practice is not allowed in a verify run")
        return s["practice"]
    if s["practice"]:
        s["practice"] = False
        s["checkpoints"] = []
        s["auto_timer"] = 0
        s["attempts"] += 1
        if s["paused"]:
            run_resume()
        room_restart()
    else:
        s["practice"] = True
        s["practice_used"] = True
        s["checkpoints"] = []
        s["auto_timer"] = 0
    return s["practice"]


def run_add_checkpoint(player):
    """Store where the player is: the physics snapshot plus coins, time and
    jumps so a respawn continues exactly from here."""
    s = run_state
    if not s["active"] or player is None or s["dead"] or s["finished"]:
        return None
    phys = None
    gd_snapshot = _contract("gd_snapshot", "gdphys")
    if gd_snapshot is not None:
        try:
            phys = gd_snapshot(player)
        except Exception:
            phys = None
    cp = {
        "phys": phys,
        "x": player.x,
        "y": player.y,
        "col": int(player.x // RUN_CELL),
        "coins": list(s["coins_run"]),
        "time": s["time"],
        "jumps": s["jumps"],
        "pct": s["pct"],
    }
    s["checkpoints"].append(cp)
    if len(s["checkpoints"]) > RUN_MAX_CHECKPOINTS:
        del s["checkpoints"][0]
    s["auto_timer"] = 0
    return cp


def run_remove_checkpoint():
    s = run_state
    if s["checkpoints"]:
        return s["checkpoints"].pop()
    return None


def run_checkpoints():
    return run_state["checkpoints"]


# ---- death, coins, finish ----------------------------------------------------


def _record_death():
    s = run_state
    if s["mode"] == "test" or not s["level_id"]:
        if not s["practice"] and s["pct"] > s["best_pct"]:
            s["best_pct"] = s["pct"]
        return
    record = globals().get("progress_record_death")
    if record is None:
        return
    try:
        entry = record(s["level_id"], s["pct"], s["practice"])
        s["best_pct"] = entry["best"]
    except Exception:
        pass


def run_die(player=None):
    """The player hit something. Hides it, bursts particles, records the
    attempt, and restarts the room RUN_DEATH_STEPS later."""
    s = run_state
    if not s["active"] or s["dead"] or s["finished"]:
        return False
    s["dead"] = True
    s["death_timer"] = RUN_DEATH_STEPS
    if player is None:
        player = _find_player()
    x, y = 0, 0
    if player is not None:
        x, y = player.x, player.y
        player.visible = False
    s["death_x"] = x
    s["death_y"] = y

    primary, secondary = _settings_colours()
    particles = []
    for i in range(RUN_PARTICLES):
        angle = math.radians(i * (360 / RUN_PARTICLES))
        speed = 2.5 + (i % 3) * 1.5
        particles.append({
            "x": x, "y": y,
            "vx": math.cos(angle) * speed,
            "vy": -math.sin(angle) * speed - 1.5,
            "life": 28 + (i % 4) * 4,
            "colour": primary if i % 2 == 0 else secondary,
        })
    s["particles"] = particles

    _record_death()
    s["attempts"] += 1
    if not s["practice"]:
        s["coins_run"] = [False, False, False]
    return True


def run_restart():
    """Restart from the pause menu: counts as an attempt, keeps practice
    checkpoints."""
    s = run_state
    if not s["active"] or s["dead"] or s["finished"]:
        return False
    if s["paused"]:
        run_resume()
    _record_death()
    s["attempts"] += 1
    room_restart()
    return True


def run_coin_touch(player, index):
    """A coin (0..2) was touched. True the first time in this attempt."""
    s = run_state
    if not s["active"] or s["dead"] or s["finished"]:
        return False
    index = int(index)
    if index < 0 or index > 2:
        return False
    if s["coins_run"][index]:
        return False
    s["coins_run"][index] = True
    return True


def run_jump():
    run_state["jumps"] += 1


def _result(finished):
    s = run_state
    return {
        "finished": finished,
        "attempts": s["attempts"],
        "practice_used": s["practice_used"],
        "practice": s["practice"],
        "coins": list(s["coins_run"]) if finished else [False, False, False],
        "best_pct": s["best_pct"],
        "pct": s["pct"],
        "time": s["time"],
        "jumps": s["jumps"],
        "level_id": s["level_id"],
        "name": s["name"],
        "mode": s["mode"],
        "verified": finished and s["mode"] == "verify" and not s["practice"],
        "new_best": s["new_best"],
        "return_to": s["return_to"],
    }


def run_finish(player=None):
    """The player reached the finish. Records completion (coins count only in
    normal and verify runs), writes "gd.result" and goes to rm_end after the
    LEVEL COMPLETE flash."""
    s = run_state
    if not s["active"] or s["dead"] or s["finished"]:
        return False
    s["finished"] = True
    s["finish_timer"] = RUN_FINISH_STEPS
    s["pct"] = 100
    s["run_best"] = 100
    s["new_best"] = False

    if s["mode"] != "test" and s["level_id"]:
        level_record = globals().get("progress_level")
        record = globals().get("progress_record_complete")
        if level_record is not None and record is not None:
            try:
                before = level_record(s["level_id"])
                was_best = before["best"]
                had_coins = list(before["coins"])
                entry = record(s["level_id"], s["coins_run"], s["practice"], s["mode"])
                s["best_pct"] = entry["best"]
                if not s["practice"]:
                    gained = False
                    for i in range(3):
                        if entry["coins"][i] and not had_coins[i]:
                            gained = True
                    s["new_best"] = was_best < 100 or gained
            except Exception:
                pass
        if s["mode"] == "verify" and not s["practice"]:
            mark = _contract("mark_verified", "gd_store")
            if mark is not None:
                try:
                    mark(s["level_id"], s["data"], s["attempts"])
                except Exception:
                    pass
    elif not s["practice"]:
        s["new_best"] = s["best_pct"] < 100
        s["best_pct"] = 100

    s["result"] = _result(True)
    ReplicatedStorage.Set("gd.result", s["result"])
    return True


def _go_end():
    s = run_state
    s["active"] = False
    try:
        room_goto(RUN_END_ROOM)
    except Exception:
        try:
            room_goto(s["return_to"])
        except Exception:
            pass


def run_exit_to_menu():
    """Leave the level early (pause menu Exit): writes an unfinished result
    and returns to where the run came from."""
    s = run_state
    if s["paused"]:
        run_resume()
    s["result"] = _result(False)
    ReplicatedStorage.Set("gd.result", s["result"])
    s["active"] = False
    target = s["return_to"] or "rm_levels"
    try:
        room_goto(target)
    except Exception:
        try:
            room_goto("rm_menu")
        except Exception:
            pass
    return s["result"]


def run_result():
    """The last result written, or a live snapshot of the current run."""
    s = run_state
    if s["result"] is not None:
        return s["result"]
    stored = ReplicatedStorage.Get("gd.result")
    if stored is not None:
        return stored
    return _result(False)
