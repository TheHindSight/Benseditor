# benseditor-engine

The Python runtime for [Benseditor](../README.md) projects: a batched ModernGL
sprite renderer plus a GameMaker-shaped event loop.

The VS Code extension ships this package and puts it on `PYTHONPATH`, so it does
not normally need installing. Install it directly if you want to run games
without the editor:

```bash
pip install -e engine
benseditor path/to/project
```

Or without installing:

```bash
PYTHONPATH=engine python -m benseditor.run path/to/project
```

## Flags

| Flag | Effect |
| --- | --- |
| `--steps N` | Exit after N game steps. Steps are counted rather than rendered frames, since frame pacing depends on vsync. |
| `--screenshot PATH` | Save the last rendered frame as a PNG before exiting. |

## Dependencies

`moderngl`, `pyglet`, `pillow`, `numpy`. Requires OpenGL 3.3.

See the [main README](../README.md) for the scripting API.
