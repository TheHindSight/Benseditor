# obj_portal_size: parent obj_portal. `kind` 0 = normal size, 1 = mini.


def create(self):
    self.kind = 0


def draw(self):
    self.image_index = self.kind
    self.draw_self()
