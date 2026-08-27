# gdphys: the Geometry Dash physics core, shared by every object.
#
# Units are pixels per step at 60 Hz on a 30 px block grid, y down. The
# player moves itself: engine hspeed/vspeed/gravity stay 0 and nothing blocks
# it, so the exact GD kinematics (y += vy + a/2; vy += a) are ours to keep.
# Every number here is deterministic -- no random -- so a recorded input
# sequence replays byte for byte.
#
# Sign conventions: `g` is +1 for normal gravity (down is +y) and -1 when
# flipped. `vy` is in screen units, so a jump in normal gravity is negative.
# "Feet" are the box edge in the gravity direction, "head" the other one.

import math

GD_BLOCK = 30

# ---- level bounds, set by the controller through gd_set_bounds -------------

gd_floor_y = 600      # y of the floor's top surface: feet never go below it
gd_ceil_y = 270       # y of the ceiling: heads never go above it
gd_end_x = 0          # x of the level's end (0 = room width), for gd_percent

# ---- constants (addendum table) --------------------------------------------

MODES = ("cube", "ship", "ball", "ufo", "wave", "robot", "spider", "swing")
SPEED_DX = (4.186, 5.193, 6.457, 7.8, 9.6)
CUBE_V0 = (9.558, 10.062, 10.278, 10.107, 10.107)
CUBE_G = (0.76156, 0.77614, 0.77533, 0.77857, 0.77857)
G1 = 0.77614
TERMINAL = 13.5
MINI_V0 = 0.8
MINI_SCALE = 0.6

ROBOT_G = 0.69853
ROBOT_V = 0.5
ROBOT_STEPS = 17
BALL_G = 0.46568
BALL_KICK = 0.3
SPIDER_G = 0.46568

SHIP_HOLD = 0.31046
SHIP_HOLD_FALL = 0.38807
SHIP_RELEASE = 0.24836
SHIP_RELEASE_RISE = 0.37255
SHIP_MINI_DIV = 0.85
FLY_UP = 7.2
FLY_DOWN = 5.76
FLY_UP_MINI = 8.47
FLY_DOWN_MINI = 6.78

UFO_FLAP = 6.3
UFO_FLAP_MINI = 5.76
UFO_G_FALL = 0.31046
UFO_G_RISE = 0.46568

SWING_G = 0.31046
SWING_G_MINI = 0.46568
SWING_KEEP = 0.8
SWING_CLAMP = 7.2

PAD_YELLOW = 14.4
PAD_PINK = 9.36
PAD_RED = 18.0
GRAVITY_BOOST = 7.1        # blue pad / blue orb: speed in the new direction
DASH_MAX_TAN = 5.67

SNAP_GROUND = 10
SNAP_FLY = 6
INNER = 0.3                # inner (death) box as a fraction of the outer box

CUBE_SPIN = 7.32
CUBE_SPIN_MINI = 9.15
CUBE_SPIN_PAD = 4.5
BALL_ROLL = (8.06, 10, 12.4, 15, 18.5)
WAVE_TILT = 45
WAVE_TILT_MINI = 63.43

DEATH_STEPS = 60           # steps between death and room_restart

# Modes that touch surfaces with the head (ship, ufo, swing) or roll onto
# them (ball, spider); the cube and robot die on a face instead.
HEAD_LANDS = ("ship", "ufo", "swing", "ball", "spider")
FLYING = ("ship", "ufo", "swing", "wave")
JUMP_PADS = ("yellow", "pink", "red")
JUMP_ORBS = ("yellow", "pink", "red", "black")

# GD lets a held button fire orbs; the plan's balancing rule wants a fresh
# press (or one buffered in the air) instead. Flip this to restore GD's rule.
GD_ORB_NEEDS_FRESH_PRESS = True


def gd_set_bounds(floor_y, ceil_y, end_x=None):
    """The controller calls this once per level: floor top, ceiling, end x."""
    global gd_floor_y, gd_ceil_y, gd_end_x
    gd_floor_y = floor_y
    gd_ceil_y = ceil_y
    if end_x is not None:
        gd_end_x = end_x


def gd_get_bounds():
    return gd_floor_y, gd_ceil_y, gd_end_x


# ---- player state ------------------------------------------------------------


def gd_init(self, x, y, mode="cube", speed=1, mini=False, g=1):
    self.hspeed = 0
    self.vspeed = 0
    self.gravity = 0
    self.x = x
    self.y = y
    self.start_x = x
    self.g = 1 if g >= 0 else -1
    self.mini = bool(mini)
    self.vy = 0.0
    self.on_ground = False
    self.holding = False
    self.hold_buffer = False
    self.pressed_now = False
    self.held_now = False
    self.robot_hold = 0
    self.robot_boost = False
    self.dashing = False
    self.dash_tan = 0.0
    self.dead = False
    self.won = False
    self.fresh = True
    self.coins = []
    self.jumps = 0
    self.spin = CUBE_SPIN
    self.mode = ""
    self.speed = -1
    self.image_angle = 0
    self.image_index = 0
    self.visible = True
    _set_size(self, self.mini)
    gd_set_speed(self, speed)
    gd_set_mode(self, mode)
    self.prev_feet = _feet(self)
    self.prev_head = _head(self)
    gd_animate(self)


def _set_size(self, mini):
    self.mini = bool(mini)
    self.scale = MINI_SCALE if self.mini else 1
    self.size = GD_BLOCK * self.scale
    _set_box(self)
    if self.speed >= 0:
        gd_set_speed(self, self.speed)


def _set_box(self):
    # Half extents of the outer box; the wave is a 10 px diamond.
    self.hb = (5 if self.mode == "wave" else 15) * self.scale


def gd_set_speed(self, speed):
    speed = int(clamp(speed, 0, 4))
    self.speed = speed
    self.dx = SPEED_DX[speed]
    self.v0 = CUBE_V0[speed] * (MINI_V0 if self.mini else 1)
    self.grav = CUBE_G[speed]


def gd_set_mode(self, mode):
    if mode == self.mode:
        return
    self.mode = mode
    self.sprite_index = "spr_" + mode
    self.image_index = 0
    self.dashing = False
    self.robot_boost = False
    if mode == "ship":
        self.vy = self.vy / 2
    elif mode == "wave" or mode == "spider" or mode == "ball":
        self.vy = 0.0
    _set_box(self)


def gd_set_mini(self, mini):
    if bool(mini) == self.mini:
        return
    _set_size(self, mini)


def gd_flip_gravity(self):
    """Portal / blue / green: vy halves, then the sign flips."""
    self.vy = -self.vy / 2
    self.g = -self.g
    self.on_ground = False


# ---- geometry ----------------------------------------------------------------


def _feet(self):
    return self.y + self.hb if self.g > 0 else self.y - self.hb


def _head(self):
    return self.y - self.hb if self.g > 0 else self.y + self.hb


def outer_box(self):
    hb = self.hb
    return self.x - hb, self.y - hb, self.x + hb, self.y + hb


def inner_box(self):
    hi = self.hb * INNER
    return self.x - hi, self.y - hi, self.x + hi, self.y + hi


def _box_solid(l, t, r, b):
    """Four-corner sample: exact for boxes no wider than a tile."""
    r -= 0.001
    b -= 0.001
    return tile_solid_at(l, t) or tile_solid_at(r, t) or tile_solid_at(l, b) or tile_solid_at(r, b)


# ---- input -------------------------------------------------------------------


def gd_read_input():
    held = keyboard_check("space") or keyboard_check("up") or keyboard_check("w") or mouse_check_button("left")
    pressed = (
        keyboard_check_pressed("space") or keyboard_check_pressed("up")
        or keyboard_check_pressed("w") or mouse_check_button_pressed("left")
    )
    return held, pressed


# ---- the step ----------------------------------------------------------------


def gd_step(self, held, pressed):
    if self.dead or self.won:
        return
    if self.fresh:
        # First step after gd_init: learn whether we stand on something, so
        # a jump held from the very first frame works (the bounds may only be
        # set after create).
        self.fresh = False
        resolve_collisions(self)
        if self.dead:
            return
    self.prev_feet = _feet(self)
    self.prev_head = _head(self)
    self.held_now = held
    self.pressed_now = pressed
    self.holding = held
    if not held:
        self.hold_buffer = False
    elif pressed:
        self.hold_buffer = True

    self.x += self.dx

    if self.dashing:
        if held:
            self.vy = -self.dx * self.dash_tan
            self.y += self.vy
            resolve_collisions(self)
            gd_animate(self)
            return
        self.dashing = False
        self.vy = 0.0

    mode = self.mode
    if mode == "cube":
        step_cube(self, held, pressed)
    elif mode == "ship":
        step_ship(self, held, pressed)
    elif mode == "ball":
        step_ball(self, held, pressed)
    elif mode == "ufo":
        step_ufo(self, held, pressed)
    elif mode == "wave":
        step_wave(self, held, pressed)
    elif mode == "robot":
        step_robot(self, held, pressed)
    elif mode == "spider":
        step_spider(self, held, pressed)
    elif mode == "swing":
        step_swing(self, held, pressed)

    resolve_collisions(self)
    gd_animate(self)


def _integrate(self, a):
    self.y += self.vy + a / 2
    self.vy += a


def _clamp_fall(self):
    if self.vy * self.g > TERMINAL:
        self.vy = TERMINAL * self.g


def _clamp_fly(self):
    g = self.g
    up = FLY_UP_MINI if self.mini else FLY_UP
    down = FLY_DOWN_MINI if self.mini else FLY_DOWN
    if self.vy * g < -up:
        self.vy = -up * g
    elif self.vy * g > down:
        self.vy = down * g


def _ground_jump(self, v):
    self.vy = -v * self.g
    self.on_ground = False
    self.hold_buffer = False
    self.jumps += 1


def step_cube(self, held, pressed):
    if self.on_ground and held:
        _ground_jump(self, self.v0)
        self.spin = CUBE_SPIN_MINI if self.mini else CUBE_SPIN
    _integrate(self, self.grav * self.g)
    _clamp_fall(self)


def step_robot(self, held, pressed):
    if self.on_ground and held and not self.robot_boost:
        self.robot_boost = True
        self.robot_hold = 0
        self.on_ground = False
        self.hold_buffer = False
        self.jumps += 1
    if self.robot_boost:
        if held and self.robot_hold < ROBOT_STEPS:
            self.robot_hold += 1
            self.vy = -ROBOT_V * self.v0 * self.g
            self.y += self.vy
            return
        self.robot_boost = False
    _integrate(self, ROBOT_G * self.g)
    _clamp_fall(self)


def step_ball(self, held, pressed):
    if self.on_ground and held:
        self.g = -self.g
        self.vy = BALL_KICK * self.v0 * self.g
        self.on_ground = False
        self.hold_buffer = False
        self.jumps += 1
    _integrate(self, BALL_G * self.g)
    _clamp_fall(self)


def step_spider(self, held, pressed):
    if self.on_ground and (pressed or (held and self.hold_buffer)):
        _spider_teleport(self)
        self.hold_buffer = False
        self.jumps += 1
        return
    _integrate(self, SPIDER_G * self.g)
    _clamp_fall(self)


def step_ship(self, held, pressed):
    g = self.g
    falling = self.vy * g > 0
    rising = self.vy * g < 0
    if held:
        a = -(SHIP_HOLD_FALL if falling else SHIP_HOLD)
    else:
        a = SHIP_RELEASE_RISE if rising else SHIP_RELEASE
    if self.mini:
        a = a / SHIP_MINI_DIV
    a *= g
    if held and self.on_ground:
        self.on_ground = False
    _clamp_fly(self)
    _integrate(self, a)
    _clamp_fly(self)


def step_ufo(self, held, pressed):
    g = self.g
    if pressed:
        flap = UFO_FLAP_MINI if self.mini else UFO_FLAP
        if self.vy * g > -flap:
            self.vy = -flap * g
        self.on_ground = False
        self.hold_buffer = False
        self.jumps += 1
    a = (UFO_G_FALL if self.vy * g >= 0 else UFO_G_RISE) * g
    _clamp_fly(self)
    _integrate(self, a)
    _clamp_fly(self)


def step_wave(self, held, pressed):
    dy = self.dx * (2 if self.mini else 1)
    self.vy = -dy * self.g if held else dy * self.g
    self.y += self.vy
    if held:
        self.on_ground = False


def step_swing(self, held, pressed):
    if pressed or (held and self.hold_buffer):
        self.g = -self.g
        self.vy = self.vy * SWING_KEEP
        self.on_ground = False
        self.hold_buffer = False
        self.jumps += 1
    a = (SWING_G_MINI if self.mini else SWING_G) * self.g
    _integrate(self, a)
    if self.vy > SWING_CLAMP:
        self.vy = SWING_CLAMP
    elif self.vy < -SWING_CLAMP:
        self.vy = -SWING_CLAMP


def _spider_teleport(self):
    """Flip gravity and jump to the nearest surface on the other side: the
    first solid tile row above/below the box, or the level bound."""
    hb = self.hb
    l = self.x - hb
    r = self.x + hb - 0.001
    if self.g > 0:
        edge = gd_ceil_y
        ty = math.floor((self.y - hb - 0.001) / GD_BLOCK)
        for _ in range(64):
            bottom = ty * GD_BLOCK + GD_BLOCK
            if bottom <= gd_ceil_y:
                break
            mid = ty * GD_BLOCK + GD_BLOCK / 2
            if tile_solid_at(l, mid) or tile_solid_at(r, mid):
                edge = bottom
                break
            ty -= 1
        self.y = edge + hb
    else:
        edge = gd_floor_y
        ty = math.floor((self.y + hb) / GD_BLOCK)
        for _ in range(64):
            top = ty * GD_BLOCK
            if top >= gd_floor_y:
                break
            mid = top + GD_BLOCK / 2
            if tile_solid_at(l, mid) or tile_solid_at(r, mid):
                edge = top
                break
            ty += 1
        self.y = edge - hb
    self.g = -self.g
    self.vy = 0.0
    self.on_ground = True
    self.dashing = False
    self.robot_boost = False


# ---- collisions --------------------------------------------------------------


def _land(self):
    self.on_ground = True
    if self.vy * self.g > 0:
        self.vy = 0.0
    self.robot_boost = False


def _bump_head(self):
    if self.vy * self.g < 0:
        self.vy = 0.0


def resolve_collisions(self):
    g = self.g
    hb = self.hb
    mode = self.mode
    self.on_ground = False

    # Level bounds.
    if g > 0:
        if self.y + hb >= gd_floor_y:
            self.y = gd_floor_y - hb
            _land(self)
        elif self.y - hb <= gd_ceil_y:
            self.y = gd_ceil_y + hb
            _bump_head(self)
    else:
        if self.y - hb <= gd_ceil_y:
            self.y = gd_ceil_y + hb
            _land(self)
        elif self.y + hb >= gd_floor_y:
            self.y = gd_floor_y - hb
            _bump_head(self)

    x = self.x
    l = x - hb
    r = x + hb - 0.001

    if mode == "wave":
        # Any solid under the wave's box is death; bounds only clamp.
        if _box_solid(x - hb, self.y - hb, x + hb, self.y + hb):
            gd_die(self)
        return

    snap = SNAP_FLY if mode in FLYING else SNAP_GROUND
    landed = False

    # Feet: the edge in the gravity direction. Touching counts, so a cube at
    # rest on a tile keeps on_ground every step.
    if g > 0:
        feet = self.y + hb
        sample = feet
    else:
        feet = self.y - hb
        sample = feet - 0.001
    if tile_solid_at(l, sample) or tile_solid_at(r, sample):
        edge = math.floor(sample / GD_BLOCK) * GD_BLOCK
        if g < 0:
            edge += GD_BLOCK
        pen = (feet - edge) * g
        if pen <= snap or (self.prev_feet - edge) * g <= 0.001:
            self.y = edge - hb * g
            _land(self)
            landed = True

    if not landed and mode in HEAD_LANDS:
        if g > 0:
            head = self.y - hb
            sample = head - 0.001
        else:
            head = self.y + hb
            sample = head
        if tile_solid_at(l, sample) or tile_solid_at(r, sample):
            edge = math.floor(sample / GD_BLOCK) * GD_BLOCK
            if g > 0:
                edge += GD_BLOCK
            pen = (edge - head) * g
            if pen <= snap or (edge - self.prev_head) * g <= 0.001:
                self.y = edge + hb * g
                _bump_head(self)

    # A face: only the inner box kills.
    hi = hb * INNER
    if _box_solid(x - hi, self.y - hi, x + hi, self.y + hi):
        gd_die(self)


# ---- touches (called from the player's collision event) ------------------


def gd_touch_hazard(self, other):
    gd_die(self)


def _after_launch(self):
    self.on_ground = False
    self.robot_boost = False
    self.dashing = False
    self.hold_buffer = False


def gd_touch_pad(self, pad):
    if self.dead or self.won or getattr(pad, "used", False):
        return
    kind = getattr(pad, "kind", "yellow")
    if self.mode == "wave" and kind in JUMP_PADS:
        return
    pad.used = True
    mult = 1
    if self.mode == "ball" or self.mode == "spider":
        mult = 0.6
    elif self.mini:
        mult = 0.8
    if kind == "yellow":
        self.vy = -PAD_YELLOW * mult * self.g
    elif kind == "pink":
        self.vy = -PAD_PINK * mult * self.g
    elif kind == "red":
        self.vy = -PAD_RED * mult * self.g
    elif kind == "blue":
        self.g = -self.g
        self.vy = GRAVITY_BOOST * self.g
    elif kind == "spider":
        _spider_teleport(self)
        return
    _after_launch(self)
    self.spin = CUBE_SPIN_PAD
    if self.mode in FLYING:
        _clamp_fly(self)


def _orb_wants(self, kind):
    if kind == "dash" or kind == "gdash":
        return self.held_now
    if self.pressed_now:
        return True
    if self.held_now and (self.hold_buffer or not GD_ORB_NEEDS_FRESH_PRESS):
        return True
    return False


def gd_touch_orb(self, orb):
    if self.dead or self.won or getattr(orb, "used", False):
        return
    kind = getattr(orb, "kind", "yellow")
    if self.mode == "wave" and kind in JUMP_ORBS:
        return
    if not _orb_wants(self, kind):
        return
    orb.used = True
    mode = self.mode
    g = self.g
    v0 = self.v0
    if kind == "yellow":
        self.vy = -(0.9 if mode == "robot" else 1.0) * v0 * g
    elif kind == "pink":
        f = 0.72
        if mode == "ship":
            f = 0.37
        elif mode == "ufo":
            f = 0.42
        elif mode == "ball":
            f = 0.77
        self.vy = -f * v0 * g
    elif kind == "red":
        f = 1.38
        if mode == "ship":
            f = 1.4 if self.mini else 1.38
        elif mode == "ufo":
            f = 1.36 if self.mini else 1.02
        elif mode == "ball" or mode == "spider":
            f = 1.34
        elif mode == "robot":
            f = 1.28
        self.vy = -f * v0 * g
    elif kind == "blue":
        self.g = -g
        self.vy = GRAVITY_BOOST * self.g
    elif kind == "green":
        gd_flip_gravity(self)
        self.vy = -(0.7 if mode == "ship" else 1.0) * v0 * self.g
    elif kind == "black":
        f = 13.5
        if mode == "ship" or mode == "wave":
            f = 12.6
        elif mode == "ufo":
            f = 10.08
        elif mode == "spider":
            f = 14.85
        self.vy = f * g
    elif kind == "spider":
        _spider_teleport(self)
        self.hold_buffer = False
        return
    elif kind == "dash" or kind == "gdash":
        if kind == "gdash":
            self.g = -g
        tan = math.tan(math.radians(getattr(orb, "image_angle", 0)))
        self.dash_tan = clamp(tan, -DASH_MAX_TAN, DASH_MAX_TAN)
        self.vy = 0.0
        self.on_ground = False
        self.robot_boost = False
        self.dashing = True
        self.hold_buffer = False
        self.jumps += 1
        return
    _after_launch(self)
    self.spin = CUBE_SPIN_MINI if self.mini else CUBE_SPIN
    self.jumps += 1


def gd_touch_portal(self, portal):
    if self.dead or self.won:
        return
    kind = getattr(portal, "kind", 0)
    if portal.is_a("obj_portal_gravity"):
        want = -1 if kind == 1 else 1
        if self.g != want:
            gd_flip_gravity(self)
    elif portal.is_a("obj_portal_mode"):
        gd_set_mode(self, MODES[int(clamp(kind, 0, 7))])
    elif portal.is_a("obj_portal_speed"):
        gd_set_speed(self, kind)
    elif portal.is_a("obj_portal_size"):
        gd_set_mini(self, kind == 1)


def gd_touch_coin(self, coin):
    if self.dead or getattr(coin, "taken", False):
        return
    coin.taken = True
    coin.visible = False
    index = getattr(coin, "index", 0)
    if index not in self.coins:
        self.coins.append(index)
    coin.destroy()


def gd_touch_checkpoint(self, checkpoint):
    if self.dead or getattr(checkpoint, "used", False):
        return
    checkpoint.used = True
    gd_save_checkpoint(self)


def gd_touch_finish(self, finish):
    if self.dead or self.won:
        return
    self.won = True
    self.vy = 0.0
    self.dashing = False
    ReplicatedStorage.Set("gd.won", True)


# ---- death, practice ---------------------------------------------------------


def gd_die(self):
    if self.dead or self.won:
        return
    self.dead = True
    self.visible = False
    self.dashing = False
    self.vy = 0.0
    ReplicatedStorage.Set("gd.last_death_x", self.x)
    try:
        instance_create(self.x, self.y, "obj_explosion")
    except ValueError:
        pass
    self.alarms[1] = DEATH_STEPS


def gd_snapshot(self):
    return {
        "x": self.x,
        "y": self.y,
        "vy": self.vy,
        "g": self.g,
        "mode": self.mode,
        "speed": self.speed,
        "mini": self.mini,
        "coins": list(self.coins),
    }


def gd_restore(self, snap):
    gd_init(self, snap["x"], snap["y"], snap["mode"], snap["speed"], snap["mini"], snap["g"])
    self.vy = snap["vy"]
    self.coins = list(snap.get("coins", []))
    self.prev_feet = _feet(self)
    self.prev_head = _head(self)


def gd_save_checkpoint(self):
    ReplicatedStorage.Set("gd.checkpoint", gd_snapshot(self))


def gd_clear_checkpoint():
    ReplicatedStorage.Set("gd.checkpoint", None)


def gd_practice():
    run = ReplicatedStorage.Get("gd.run")
    if isinstance(run, dict):
        return bool(run.get("practice", False))
    return bool(ReplicatedStorage.Get("gd.practice", False))


# ---- animation ---------------------------------------------------------------


def gd_animate(self):
    g = self.g
    mode = self.mode
    self.image_xscale = self.scale
    self.image_yscale = g * self.scale
    angle = self.image_angle
    if mode == "cube":
        if self.on_ground:
            self.image_angle = round(angle / 90) * 90
        else:
            self.image_angle = angle - self.spin * g
    elif mode == "ball":
        self.image_angle = angle - BALL_ROLL[self.speed] * g
    elif mode == "ship" or mode == "swing":
        target = math.degrees(math.atan2(-self.vy, self.dx))
        self.image_angle = angle + (target - angle) * 0.15
    elif mode == "ufo":
        target = -self.vy * 1.5
        self.image_angle = angle + (target - angle) * 0.15
    elif mode == "wave":
        tilt = WAVE_TILT_MINI if self.mini else WAVE_TILT
        target = tilt if self.vy < 0 else -tilt
        self.image_angle = angle + (target - angle) * 0.25
    else:
        self.image_angle = 0


# ---- HUD / test helpers ------------------------------------------------------


def gd_percent(self):
    end = gd_end_x if gd_end_x > 0 else room_width()
    span = end - self.start_x
    if span <= 0:
        return 100
    return clamp(100 * (self.x - self.start_x) / span, 0, 100)


def gd_state_string(self):
    return "%.4f;%.4f;%.4f;%d;%s;%d;%d;%d;%d;%d" % (
        self.x, self.y, self.vy, self.g, self.mode,
        1 if self.on_ground else 0, 1 if self.dead else 0, 1 if self.won else 0,
        self.speed, 1 if self.mini else 0,
    )


def gd_player():
    return instance_find("obj_player")


def gd_probe():
    player = instance_find("obj_player")
    return "" if player is None else gd_state_string(player)


def gd_probe_field(name):
    player = instance_find("obj_player")
    return "" if player is None else str(getattr(player, name))
