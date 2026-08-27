# Geometry Dash physics core — object contract

Everything physical lives in `gdphys.py` (a shared script, so its public
names are globals in every object). The objects are thin: they hold the
fields the spawner sets and forward their events. Units are px/step at 60 Hz
on a 30 px grid, y down; `g` is +1 for normal gravity and -1 when flipped.

## Objects and the fields the spawner sets

Every object's `create` sets defaults; the spawner overwrites them right after
`instance_create`. Hitboxes come from the sprites' collision rects (player
30x30 rect 0,0,29,29; wave rect 10,10,19,19; spike rect 5,10,24,29 = 20x20
bottom-anchored; pad rect 0,20,29,29 = 30x10 base; orb full; portal 30x90
full; coin rect 4,4,25,25). Mini scales the player's `image_xscale/yscale`
by 0.6, so engine collisions and the physics boxes agree.

| object | parent | fields | notes |
|---|---|---|---|
| `obj_player` | — | (state from `gd_init`) | `hspeed = vspeed = gravity = 0`, `blockedBy = []`; moves itself |
| `obj_start` | — | *name* | invisible marker; name `start` or `start:<mode>:<speed>:<mini>:<g>` (mode word, speed 0–4, mini 0/1, g 0 down / 1 up). The player spawns at its x,y |
| `obj_spike` | `obj_hazard` | `kind` 0 up / 1 down, `image_yscale = -1` for down | the flipped scale flips the bottom-anchored box to hang from the cell top |
| `obj_pad` | — | `kind` yellow/pink/red/blue/spider, `image_yscale = -1` on a ceiling | `used` one-shot |
| `obj_orb` | — | `kind` yellow/pink/red/blue/green/black/spider/dash/gdash, `image_angle` for dash | `used` one-shot |
| `obj_portal_gravity` | `obj_portal` | `kind` 0 down / 1 up | |
| `obj_portal_mode` | `obj_portal` | `kind` 0..7 = cube ship ball ufo wave robot spider swing | |
| `obj_portal_speed` | `obj_portal` | `kind` 0..4 = 0.5x 1x 2x 3x 4x | |
| `obj_portal_size` | `obj_portal` | `kind` 0 normal / 1 mini | |
| `obj_coin` | — | `index` 0..2 | `taken`; destroyed on pickup |
| `obj_finish` | — | — | sets the player's `won` |
| `obj_checkpoint` | — | — | stores `gd_snapshot` under `gd.checkpoint`; `used` |
| `obj_explosion` | — | — | 24 particles for 40 steps; created by `gd_die` |

`obj_hazard` and `obj_portal` are empty parents: the player's `collision`
event dispatches with `other.is_a(...)` on `obj_hazard / obj_pad / obj_orb /
obj_portal / obj_coin / obj_finish / obj_checkpoint`.

## Module globals (the controller sets them)

`gd_floor_y` (y of the floor's top surface), `gd_ceil_y` (y of the ceiling)
and `gd_end_x` (x of the level's end, 0 = room width) are gdphys globals.
Set them through `gd_set_bounds(floor_y, ceil_y, end_x=None)` — assigning
`require("gdphys").gd_floor_y` would not reach the functions' globals.
`gd_get_bounds()` reads them back. They survive `room_restart`.

## ReplicatedStorage keys

Read:
- `gd.run` — the run hand-off (`{mode: play|test|verify, source, level_id,
  data, start_col, return_to, practice?}`); the player only reads `practice`
  (through `gd_practice()`, which falls back to `gd.practice`).
- `gd.checkpoint` — a `gd_snapshot` dict; restored in the player's `create`
  when practice is on.

Written:
- `gd.checkpoint` by `gd_touch_checkpoint` / `gd_save_checkpoint(self)`
  (`gd_clear_checkpoint()` removes it).
- `gd.won` by `gd_touch_finish`, `gd.last_death_x` by `gd_die`.

## Functions the HUD / controller call

- `gd_init(self, x, y, mode="cube", speed=1, mini=False, g=1)` — attach the
  state; `gd_set_mode / gd_set_speed / gd_set_mini / gd_flip_gravity` change it
  the way portals do.
- `gd_read_input()` → `(held, pressed)` from space / up / w / left mouse.
- `gd_step(self, held, pressed)` — one step: x += dx, the mode's step,
  `resolve_collisions`, `gd_animate`. The first step after `gd_init` probes the
  ground so a jump held from frame one works.
- `gd_touch_pad/orb/portal/hazard/coin/checkpoint/finish(self, other)`.
- `gd_die(self)` — hides the player, spawns `obj_explosion`, arms alarm 1
  (60 steps → the player's `alarm` calls `room_restart`).
- `gd_snapshot(self)` → dict `{x, y, vy, g, mode, speed, mini, coins}`;
  `gd_restore(self, snap)`.
- `gd_percent(self)` → 0..100 from `start_x` to `gd_end_x`.
- `gd_state_string(self)` → `"x;y;vy;g;mode;on_ground;dead;won;speed;mini"`;
  `gd_probe()` / `gd_probe_field(name)` / `gd_player()` read the first
  `obj_player` (tests and the HUD).

Player fields worth reading: `mode, g, speed, mini, vy, on_ground, dead, won,
coins, jumps, dashing, size, hb (half box), scale, start_x`.

## Rules that differ from a naive reading of the addendum

- Orbs need a fresh press or a press buffered in the air; a hold that began
  with a ground jump does not fire them (`GD_ORB_NEEDS_FRESH_PRESS = True`
  restores GD's hold-fires-orbs rule when set to False). Dash orbs fire on hold.
- The wave ignores yellow/pink/red pads and yellow/pink/red/black orbs;
  gravity ones (blue, green, spider, dash) still apply.
- Collision boxes are half-open: feet exactly on a spike's top edge is a
  graze, one step inside is death.
- The ship's release curve reaches +5.76 at +43 steps (5.715 at +42) — the
  addendum's "+42" rounds 19.33 + 22.2 steps down.
