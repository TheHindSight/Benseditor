# obj_checkpoint: a practice checkpoint. Touching it stores gd_snapshot of
# the player under ReplicatedStorage "gd.checkpoint"; `used` makes it one-shot.


def create(self):
    self.used = False
