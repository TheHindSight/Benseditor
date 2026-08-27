# obj_portal_speed: parent obj_portal. `kind` 0..4 = 0.5x 1x 2x 3x 4x.


def create(self):
    self.kind = 1


def draw(self):
    self.image_index = self.kind
    self.draw_self()
