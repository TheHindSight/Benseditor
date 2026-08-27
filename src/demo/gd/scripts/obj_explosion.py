# obj_explosion: 24 particles for 40 steps, then gone. Created by gd_die.
# Deterministic on purpose (no random): replays stay byte-identical.

LIFE = 40
COUNT = 24


def create(self):
    self.visible = False
    self.life = LIFE
    self.parts = []
    for i in range(COUNT):
        angle = math.radians(i * (360 / COUNT))
        speed = 2.5 + (i % 3) * 1.5
        self.parts.append([self.x, self.y, math.cos(angle) * speed, -math.sin(angle) * speed])


def step(self):
    self.life -= 1
    if self.life <= 0:
        self.destroy()
        return
    for p in self.parts:
        p[0] += p[2]
        p[1] += p[3]
        p[2] *= 0.94
        p[3] *= 0.94


def draw(self):
    fade = self.life / LIFE
    draw_set_alpha(fade)
    draw_set_color(c_yellow if self.life % 2 == 0 else c_orange)
    radius = 1.5 + 3 * fade
    for p in self.parts:
        draw_circle(p[0], p[1], radius, False)
    draw_set_alpha(1)
