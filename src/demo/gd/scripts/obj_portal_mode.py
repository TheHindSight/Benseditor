# obj_portal_mode: parent obj_portal. `kind` 0..7 indexes MODES:
# cube ship ball ufo wave robot spider swing. Set by the spawner.


def create(self):
    self.kind = 0


def draw(self):
    self.image_index = self.kind
    self.draw_self()
