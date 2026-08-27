# obj_spike: parent obj_hazard. `kind` 0 points up, 1 points down (the spawner
# sets kind and flips image_yscale = -1 for a down spike, which also flips the
# 20x20 bottom-anchored hitbox the sprite's collision rect defines).


def create(self):
    self.kind = 0
