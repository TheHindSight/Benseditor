"""Window creation and the main loop.

Uses pyglet for the window and input, and ModernGL for rendering into pyglet's
OpenGL 3.3 context.
"""

from __future__ import annotations

import time
from pathlib import Path

import moderngl
import pyglet

from .assets import load_project
from .game import Game

MAX_CATCHUP_STEPS = 5


def run(
    project_dir: Path | str,
    max_steps: int | None = None,
    screenshot: Path | str | None = None,
) -> None:
    """Run a project.

    `max_steps` exits once that many game steps have run and `screenshot` saves
    the last rendered frame to a PNG -- both exist for smoke-testing and
    documentation shots. Steps are counted rather than rendered frames, because
    frame pacing depends on vsync but a step is always 1/fps of game time.
    """
    project = load_project(Path(project_dir))

    scale = max(1, int(project.window["scale"]))
    width = project.window["width"] * scale
    height = project.window["height"] * scale

    config = pyglet.gl.Config(
        major_version=3,
        minor_version=3,
        forward_compatible=True,
        double_buffer=True,
        depth_size=0,
        sample_buffers=0,
    )
    window = pyglet.window.Window(
        width=width,
        height=height,
        caption=project.window["title"],
        config=config,
        resizable=False,
        vsync=True,
    )
    window.switch_to()

    ctx = moderngl.create_context()
    game = Game(project, ctx)

    @window.event
    def on_key_press(symbol: int, modifiers: int) -> None:
        game.input.on_key_press(symbol)

    @window.event
    def on_key_release(symbol: int, modifiers: int) -> None:
        game.input.on_key_release(symbol)

    def set_mouse(x: float, y: float) -> None:
        # pyglet measures y from the bottom; rooms measure from the top.
        game.input.mouse_x = game.view_x + x * game.view_width / window.width
        game.input.mouse_y = game.view_y + (window.height - y) * game.view_height / window.height

    @window.event
    def on_mouse_motion(x, y, dx, dy) -> None:
        set_mouse(x, y)

    @window.event
    def on_mouse_drag(x, y, dx, dy, buttons, modifiers) -> None:
        set_mouse(x, y)

    @window.event
    def on_mouse_press(x, y, button, modifiers) -> None:
        set_mouse(x, y)
        game.input.on_mouse_press(button)

    @window.event
    def on_mouse_release(x, y, button, modifiers) -> None:
        set_mouse(x, y)
        game.input.on_mouse_release(button)

    @window.event
    def on_mouse_scroll(x, y, scroll_x, scroll_y) -> None:
        game.input.mouse_wheel = int(scroll_y)

    @window.event
    def on_deactivate() -> None:
        # Held keys would otherwise stick while the window is unfocused.
        game.input.clear()

    game.start()

    step_time = 1.0 / max(1, game.fps)
    accumulator = 0.0
    previous = time.perf_counter()
    steps_run = 0

    try:
        while not window.has_exit and not game.should_quit:
            window.switch_to()
            window.dispatch_events()

            now = time.perf_counter()
            accumulator += now - previous
            previous = now

            steps = 0
            while accumulator >= step_time and steps < MAX_CATCHUP_STEPS:
                game.step()
                accumulator -= step_time
                steps += 1
                steps_run += 1
                if game.should_quit or window.has_exit:
                    break
                if max_steps is not None and steps_run >= max_steps:
                    break
            if accumulator > step_time * MAX_CATCHUP_STEPS:
                accumulator = 0.0  # a long stall should not fast-forward the game

            if window.has_exit or game.should_quit:
                break

            framebuffer_size = window.get_framebuffer_size()
            ctx.viewport = (0, 0, framebuffer_size[0], framebuffer_size[1])
            ctx.screen.use()
            game.draw()

            done = max_steps is not None and steps_run >= max_steps
            if screenshot and done:
                _save_screenshot(ctx, framebuffer_size, Path(screenshot))
                screenshot = None

            window.flip()

            if done:
                break
    finally:
        game.shutdown()
        game.renderer.release()
        window.close()


def _save_screenshot(ctx: moderngl.Context, size: tuple[int, int], path: Path) -> None:
    from PIL import Image

    pixels = ctx.screen.read(components=3)
    image = Image.frombytes("RGB", size, pixels)
    # OpenGL reads bottom-up.
    image.transpose(Image.FLIP_TOP_BOTTOM).save(path)
    print(f"Saved screenshot to {path}")
