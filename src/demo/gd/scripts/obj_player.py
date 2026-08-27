# obj_player: the icon. All physics lives in gdphys; this only wires events.
#
# The start position and gamemode come from an obj_start marker if the room
# has one: its instance name is `start` or `start:<mode>:<speed>:<mini>:<g>`
# (mode word, speed 0..4, mini 0/1, g 0 down / 1 up); missing parts default.


def _parse_start(name):
    mode, speed, mini, g = "cube", 1, False, 1
    parts = str(name).split(":")
    if len(parts) > 1 and parts[1] in MODES:
        mode = parts[1]
    if len(parts) > 2 and parts[2].isdigit():
        speed = int(parts[2])
    if len(parts) > 3:
        mini = parts[3] == "1"
    if len(parts) > 4:
        g = -1 if parts[4] == "1" else 1
    return mode, speed, mini, g


def create(self):
    self.hspeed = 0
    self.vspeed = 0
    self.gravity = 0
    x, y = self.x, self.y
    mode, speed, mini, g = "cube", 1, False, 1
    start = instance_find("obj_start")
    if start is not None:
        x, y = start.x, start.y
        mode, speed, mini, g = _parse_start(start.name)
    gd_init(self, x, y, mode, speed, mini, g)
    snap = ReplicatedStorage.Get("gd.checkpoint")
    if snap is not None and gd_practice():
        gd_restore(self, snap)


def step(self):
    held, pressed = gd_read_input()
    gd_step(self, held, pressed)


def collision(self, other):
    if self.dead:
        return
    if other.is_a("obj_hazard"):
        gd_touch_hazard(self, other)
    elif other.is_a("obj_pad"):
        gd_touch_pad(self, other)
    elif other.is_a("obj_orb"):
        gd_touch_orb(self, other)
    elif other.is_a("obj_portal"):
        gd_touch_portal(self, other)
    elif other.is_a("obj_coin"):
        gd_touch_coin(self, other)
    elif other.is_a("obj_finish"):
        gd_touch_finish(self, other)
    elif other.is_a("obj_checkpoint"):
        gd_touch_checkpoint(self, other)


def draw(self):
    if self.visible:
        self.draw_self()


def alarm(self, index):
    if index == 1:
        room_restart()
