# obj_pad: jump pads. `kind` is yellow / pink / red / blue / spider, set by
# the spawner; `used` makes it one-shot. A pad on a ceiling has
# image_yscale = -1 (set by the spawner) so its 30x10 base faces down.

KINDS = ("yellow", "pink", "red", "blue", "spider")


def create(self):
    self.kind = "yellow"
    self.used = False


def draw(self):
    self.image_index = KINDS.index(self.kind) if self.kind in KINDS else 0
    self.draw_self()
