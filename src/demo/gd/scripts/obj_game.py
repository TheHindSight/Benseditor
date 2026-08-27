# obj_game: the persistent, invisible state holder. Created on demand by the
# first scene (state_ensure_game); never placed in a room. It loads the
# saved progress once; everything else lives in the shared scripts.


def create(self):
    self.visible = False
    self.depth = -1000
    progress_load()
