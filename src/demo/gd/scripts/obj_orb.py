# obj_orb: jump orbs. `kind` is yellow / pink / red / blue / green / black /
# spider / dash / gdash; `used` makes it one-shot. Dash orbs use image_angle
# (set by the spawner) as the dash direction.

KINDS = ("yellow", "pink", "red", "blue", "green", "black", "spider", "dash", "gdash")


def create(self):
    self.kind = "yellow"
    self.used = False


def draw(self):
    self.image_index = KINDS.index(self.kind) if self.kind in KINDS else 0
    self.draw_self()
