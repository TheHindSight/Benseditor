# icons: the player's look. Four shapes, each a sprite with the frames
#   0 outline (black lines only), 1 primary mask (white), 2 secondary mask
#   (white), 3 flat white-with-outline composite (for drawing without tints).
# The mode sprites (spr_ship, spr_ball, ...) use the same frame layout, so
# `icon_draw_sprite` colours any of them.

ICON_COUNT = 4
ICON_NAMES = ["Cube", "Visor", "Cross", "Circuit"]
ICON_MODE_SPRITES = {
    "cube": None,   # the chosen icon shape
    "ship": "spr_ship",
    "ball": "spr_ball",
    "ufo": "spr_ufo",
    "wave": "spr_wave",
    "robot": "spr_robot",
    "spider": "spr_spider",
    "swing": "spr_swing",
}


def icon_sprite(shape):
    return "spr_icon_%d" % (int(shape) % ICON_COUNT)


# The PICO-8 palette again, so this script works whichever order the shared
# scripts were registered in (ui.py's UI_COLOURS is the same list).
_ICON_COLOURS = [
    0x000000, 0x1D2B53, 0x7E2553, 0x008751, 0xAB5236, 0x5F574F, 0xC2C3C7, 0xFFF1E8,
    0xFF004D, 0xFFA300, 0xFFEC27, 0x00E436, 0x29ADFF, 0x83769C, 0xFF77A8, 0xFFCCAA,
]


def icon_colour(index):
    """Palette index (0..15) to a 0xRRGGBB colour."""
    colours = globals().get("UI_COLOURS") or _ICON_COLOURS
    return colours[int(index) % len(colours)]


def icon_settings():
    """(primary colour, secondary colour, shape) from the saved settings."""
    getter = globals().get("progress_settings")
    if getter is None:
        return icon_colour(10), icon_colour(12), 0
    s = getter()
    return icon_colour(s["primary"]), icon_colour(s["secondary"]), s["icon"]


def icon_draw_sprite(sprite, x, y, primary, secondary, xscale=1, yscale=1, angle=0, alpha=1):
    """Three draws: primary mask tinted, secondary mask tinted, outline on top."""
    draw_sprite_ext(sprite, 1, x, y, xscale, yscale, angle, primary, alpha)
    draw_sprite_ext(sprite, 2, x, y, xscale, yscale, angle, secondary, alpha)
    draw_sprite_ext(sprite, 0, x, y, xscale, yscale, angle, 0xFFFFFF, alpha)


def icon_draw(x, y, shape, primary, secondary, xscale=1, yscale=1, angle=0, alpha=1):
    icon_draw_sprite(icon_sprite(shape), x, y, primary, secondary, xscale, yscale, angle, alpha)


def icon_mode_sprite(mode, shape=0):
    """The sprite for a gamemode: the icon shape for the cube, else the
    mode's vehicle."""
    name = ICON_MODE_SPRITES.get(mode)
    if name is None:
        return icon_sprite(shape)
    return name


def icon_draw_mode(x, y, mode, primary, secondary, shape=0, xscale=1, yscale=1, angle=0, alpha=1):
    icon_draw_sprite(icon_mode_sprite(mode, shape), x, y, primary, secondary, xscale, yscale, angle, alpha)
