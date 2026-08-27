# obj_coin: a secret coin. `index` (0..2) is set by the spawner; `taken`
# is set by gd_touch_coin before the instance is destroyed.


def create(self):
    self.index = 0
    self.taken = False
