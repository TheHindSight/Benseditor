# obj_portal_gravity: parent obj_portal. `kind` 0 = normal gravity (down),
# 1 = flipped (up). Set by the spawner.


def create(self):
    self.kind = 0


def draw(self):
    self.image_index = self.kind
    self.draw_self()
