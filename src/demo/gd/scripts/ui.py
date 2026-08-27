# ui: an immediate-mode toolkit for the menus and the HUD.
#
# Every widget takes SCREEN coordinates (pixels from the top-left of the view)
# and converts them through `view_get()` when it draws, because the engine
# draws in room coordinates and `mouse_x/y` are room coordinates too. Call
# `ui_begin()` once per step (or at the top of draw_gui) to refresh the view
# offset, the mouse position and the click edge; the widgets read `ui_state`.
#
# The pure helpers (`ui_hit`, `ui_nav`, `ui_list_window`, `ui_hover_index`) do
# no drawing and touch no engine state, so the headless test drives them
# directly.

# The PICO-8 palette, indexed the way the icon screen shows it.
UI_COLOURS = [
    0x000000, 0x1D2B53, 0x7E2553, 0x008751, 0xAB5236, 0x5F574F, 0xC2C3C7, 0xFFF1E8,
    0xFF004D, 0xFFA300, 0xFFEC27, 0x00E436, 0x29ADFF, 0x83769C, 0xFF77A8, 0xFFCCAA,
]

UI_PALETTE = {
    "bg": 0x1D2B53,
    "bg_dark": 0x0B1230,
    "panel": 0x101C40,
    "panel_edge": 0x29ADFF,
    "text": 0xFFF1E8,
    "text_dim": 0xC2C3C7,
    "muted": 0x83769C,
    "accent": 0xFFEC27,
    "focus": 0x29ADFF,
    "hover": 0x1F3A7A,
    "disabled": 0x5F574F,
    "good": 0x00E436,
    "bad": 0xFF004D,
    "warn": 0xFFA300,
    "coin": 0xFFEC27,
    "coin_off": 0x5F574F,
}

# Refreshed by ui_begin. Shared by reference with every script that uses it.
ui_state = {
    "vx": 0,
    "vy": 0,
    "mx": 0,
    "my": 0,
    "last_mx": 0,
    "last_my": 0,
    "moved": False,
    "click": False,
    "down": False,
    "wheel": 0,
    "enter": False,
    "hovered": None,
}


def ui_begin():
    """Read the view, the mouse (converted to screen space) and the click
    edge for this step. Returns the shared state dict."""
    vx, vy = view_get()
    s = ui_state
    s["vx"] = vx
    s["vy"] = vy
    mx = mouse_x() - vx
    my = mouse_y() - vy
    s["moved"] = mx != s["last_mx"] or my != s["last_my"]
    s["last_mx"] = mx
    s["last_my"] = my
    s["mx"] = mx
    s["my"] = my
    s["click"] = mouse_check_button_pressed("left")
    s["down"] = mouse_check_button("left")
    s["wheel"] = mouse_wheel()
    s["enter"] = keyboard_check_pressed("enter") or keyboard_check_pressed("space")
    s["hovered"] = None
    return s


# ---- pure helpers -----------------------------------------------------------


def ui_hit(px, py, x, y, w, h):
    """Is the point inside the rectangle (x, y, w, h)?"""
    return px >= x and py >= y and px < x + w and py < y + h


def ui_nav(index, count, delta, wrap=True):
    """Move a keyboard cursor by `delta` through `count` entries, wrapping
    around the ends or clamping at them."""
    if count <= 0:
        return 0
    target = int(index) + int(delta)
    if wrap:
        return target % count
    if target < 0:
        return 0
    if target >= count:
        return count - 1
    return target


def ui_list_window(selected, count, visible, first):
    """The first row of a scrolling list so `selected` stays on screen."""
    if count <= visible:
        return 0
    first = int(first)
    if selected < first:
        first = selected
    elif selected >= first + visible:
        first = selected - visible + 1
    limit = count - visible
    if first > limit:
        first = limit
    if first < 0:
        first = 0
    return first


def ui_hover_index(px, py, x, y, w, row_h, count):
    """Which row of a vertical list the point is over, or -1."""
    if count <= 0 or row_h <= 0:
        return -1
    if px < x or px >= x + w or py < y:
        return -1
    index = int((py - y) // row_h)
    if index < 0 or index >= count:
        return -1
    return index


def ui_mix(a, b, t):
    """Blend two 0xRRGGBB colours; t = 0 gives a, t = 1 gives b."""
    if t < 0:
        t = 0
    if t > 1:
        t = 1
    ar, ag, ab = (a >> 16) & 255, (a >> 8) & 255, a & 255
    br, bg, bb = (b >> 16) & 255, (b >> 8) & 255, b & 255
    r = int(ar + (br - ar) * t)
    g = int(ag + (bg - ag) * t)
    bl = int(ab + (bb - ab) * t)
    return (r << 16) | (g << 8) | bl


def ui_hovering(x, y, w, h):
    """Is the mouse over this screen rectangle right now?"""
    return ui_hit(ui_state["mx"], ui_state["my"], x, y, w, h)


# ---- drawing widgets --------------------------------------------------------


def ui_text(x, y, text, colour=None, scale=1, align="left", alpha=1):
    """Text at a scale, aligned around x. Returns the drawn width."""
    text = str(text)
    width = string_width(text) * scale
    if align == "center":
        x = x - width / 2
    elif align == "right":
        x = x - width
    if alpha != 1:
        draw_set_alpha(alpha)
    draw_text_transformed(
        ui_state["vx"] + x, ui_state["vy"] + y, text, scale, scale, 0,
        UI_PALETTE["text"] if colour is None else colour,
    )
    if alpha != 1:
        draw_set_alpha(1)
    return width


def ui_panel(x, y, w, h, fill=None, edge=None, alpha=1):
    vx, vy = ui_state["vx"], ui_state["vy"]
    if alpha != 1:
        draw_set_alpha(alpha)
    draw_set_color(UI_PALETTE["panel"] if fill is None else fill)
    draw_rectangle(vx + x, vy + y, vx + x + w, vy + y + h, False)
    if edge is not None:
        draw_set_color(edge)
        draw_rectangle(vx + x, vy + y, vx + x + w, vy + y + h, True)
    if alpha != 1:
        draw_set_alpha(1)


def ui_button(x, y, w, h, label, focused=False, enabled=True, scale=1):
    """A labelled button. Returns True on the step it is activated: a click
    edge while hovered, or Enter/Space while it has keyboard focus."""
    s = ui_state
    hover = ui_hit(s["mx"], s["my"], x, y, w, h)
    if hover:
        s["hovered"] = label
    if not enabled:
        fill = UI_PALETTE["bg_dark"]
        edge = UI_PALETTE["disabled"]
        colour = UI_PALETTE["disabled"]
    elif focused or hover:
        fill = UI_PALETTE["hover"]
        edge = UI_PALETTE["focus"] if focused else UI_PALETTE["panel_edge"]
        colour = UI_PALETTE["accent"] if focused else UI_PALETTE["text"]
    else:
        fill = UI_PALETTE["panel"]
        edge = UI_PALETTE["muted"]
        colour = UI_PALETTE["text"]
    ui_panel(x, y, w, h, fill, edge)
    if focused and enabled:
        ui_text(x + 8, y + (h - 12 * scale) / 2, ">", UI_PALETTE["accent"], scale)
    ui_text(x + w / 2, y + (h - 12 * scale) / 2, label, colour, scale, "center")
    if not enabled:
        return False
    if hover and s["click"]:
        return True
    if focused and s["enter"]:
        return True
    return False


def ui_progress(x, y, w, h, fraction, colour=None, back=None):
    vx, vy = ui_state["vx"], ui_state["vy"]
    if fraction < 0:
        fraction = 0
    if fraction > 1:
        fraction = 1
    draw_set_color(UI_PALETTE["bg_dark"] if back is None else back)
    draw_rectangle(vx + x, vy + y, vx + x + w, vy + y + h, False)
    if fraction > 0:
        draw_set_color(UI_PALETTE["good"] if colour is None else colour)
        draw_rectangle(vx + x + 1, vy + y + 1, vx + x + 1 + (w - 2) * fraction, vy + y + h - 1, False)
    draw_set_color(UI_PALETTE["text_dim"])
    draw_rectangle(vx + x, vy + y, vx + x + w, vy + y + h, True)


def ui_stars(x, y, count, scale=1, colour=None):
    """A difficulty rating as a row of stars (up to 10). Returns the width."""
    vx, vy = ui_state["vx"], ui_state["vy"]
    count = int(count)
    if count < 0:
        count = 0
    if count > 10:
        count = 10
    step = 9 * scale
    tint = UI_PALETTE["accent"] if colour is None else colour
    for i in range(count):
        draw_sprite_ext("spr_star", 0, vx + x + 4 * scale + i * step, vy + y + 4 * scale, scale, scale, 0, tint, 1)
    return count * step


def ui_badge(x, y, text, colour=None, scale=1, text_colour=None):
    """A small filled label. Returns its width."""
    text = str(text)
    width = string_width(text) * scale + 8
    height = 12 * scale + 4
    fill = UI_PALETTE["good"] if colour is None else colour
    ui_panel(x, y, width, height, fill, None)
    ui_text(x + 4, y + 2, text, 0x000000 if text_colour is None else text_colour, scale)
    return width


def ui_coins(x, y, coins, scale=1):
    """Three coin icons, lit for the ones collected. Returns the width."""
    vx, vy = ui_state["vx"], ui_state["vy"]
    step = 14 * scale
    for i in range(3):
        got = i < len(coins) and coins[i]
        draw_sprite_ext(
            "spr_coin", 0 if got else 1, vx + x + 6 * scale + i * step, vy + y + 6 * scale,
            scale * 0.5, scale * 0.5, 0,
            UI_PALETTE["coin"] if got else UI_PALETTE["coin_off"], 1 if got else 0.6,
        )
    return 3 * step
