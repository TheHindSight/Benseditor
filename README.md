# Benseditor

> **A note on how this was made.** Benseditor is *vibe-coded*: the author
> directs the design and the priorities, and the code, tests and docs are
> written by an AI coding assistant (Claude Code) under that direction. That
> is an accessibility choice — it is how the author is able to build and
> maintain a project of this size. Everything is verified by the test suites
> described under [Status](#status) rather than by hand-review of every line,
> so read the code with that in mind, and report anything that looks wrong.

A GameMaker-style 2D game engine scripted in **Luau or Python** — typed, or
snapped together from **Scratch-style blocks** that compile to either. With one
switch in Project settings it is a Roblox-style one instead: an Explorer tree
of services and folders in the editor, and `Parent` / `Instance.new` /
`FindFirstChild` at runtime. The **Geometry Dash** template shows how far the
Python side goes: a full GD clone — eight gamemodes, an in-game level editor,
saved custom levels — written entirely in object scripts.

The whole editor builds to **one HTML file** you open by double-clicking — no
install, no server, no toolchain. It also runs as an Electron desktop app or a
static site, from the same source.

Finished games export the same way: **one self-contained HTML file** that plays
by double-clicking.

```
sprites/  spr_player.bsprite   →  pixel art editor
tilesets/ ts_stone.btileset    →  tile sheet + solid flags
objects/  obj_player.bobject   →  properties + event checklist
          obj_player.luau      →  function obj.step(self) ... end
          obj_player.py        →  def step(self): ...   (Python projects)
rooms/    rm_main.broom        →  drag-and-drop layout + tile layers
scripts/  helpers.luau         →  shared modules
```

## Documentation

The full manual lives in **[docs/](docs/README.md)** — 172 documented names
across seven chapters, from a first-object walkthrough to the exact order of a
frame.

The same text is built into the editor: press **F1** or click **Docs** for a
searchable copy, with every code sample syntax-highlighted. The completion popup
shows the same one-line description as the manual, because it reads it from
there.

All of it is generated from one source, `src/ui/docsData.ts`. `npm run test:docs`
checks every documented name against `prelude.luau` and `roblox.luau` in both
directions — a renamed engine function, or a new one nobody documented, fails
the build.

```bash
npm run build:docs   # regenerate docs/ after editing the manual
npm run test:docs    # check the manual against the engine
```

## Architecture

Two halves that meet exactly **once per frame**.

| Part | Language | Job |
| --- | --- | --- |
| **Engine** | Luau (WASM) — or Python (MicroPython WASM) | Instances, events, movement, collision, rooms, the entire drawing API |
| **Host** | TypeScript | Atlas packing, WebGL2 rendering, input capture, project IO |

Each step the host calls `__frame(input)` and gets back the step's draw
commands as one base64 string plus its metadata. That is the *only* crossing.
Steps run on a fixed clock — `room_speed()` times a second, 60 by default —
whatever the display's refresh rate; a frame draws the latest step.
The host talks to whichever engine through one seam, `src/engine/scriptHost.ts`;
the two engines are the same program twice (`prelude.luau` / `prelude.py`),
and `test:docs` fails if their public surfaces differ by a single name.

### Why it's built that way

This shape isn't stylistic — it's forced by two measured properties of the
Luau/WASM boundary:

1. **A call from Luau out to JS costs 89 µs (JSPI) to 320 µs (Asyncify).**
   If `draw_sprite()` were a JS function, a 300-sprite draw event would cost
   27–96 ms against a 16.6 ms budget. Reading state back through the table
   proxy is no better: 19.7 µs per `.get()`, so 65 ms/frame for one frame's
   worth of fields.
2. **The Luau→JS string channel is UTF-8 decoded, so any byte ≥ 128 becomes
   U+FFFD.** `buffer.tostring()` on binary returns the *correct length* while
   the values are silently garbage. Hence base64.

So the game-facing API lives in `src/luau/prelude.luau`, never in JS, and one
packed buffer carries the frame. Measured cost of that design:

| | Node (Asyncify) | Chromium (JSPI) |
| --- | --- | --- |
| 300 instances, full frame | 7.3 ms | **3.8 ms** |

## Running it

```bash
npm install
npm run build:single   # → dist-single/benseditor.html, just open it
npm run desktop        # or the Electron desktop app
npm run dev            # or the web app at http://localhost:5173
```

`build:single` inlines everything — UI, engine, Luau VM, and the player used by
**Export game** — into a ~4.3 MB file that works from `file://`. Copy it
anywhere; it is the entire development environment.

For desktop development with hot reload, run `npm run dev` in one terminal and
`npm run desktop:dev` in another — the second attaches to the Vite server.

```bash
npm run desktop:build   # installers into release/ via electron-builder
npm run build           # static site in dist/
npm test                # everything
```

| Build | Size | Needs |
| --- | --- | --- |
| `dist-single/benseditor.html` | ~4.3 MB | a browser |
| `dist/` (static site) | ~324 kB gzipped | any static host |
| Electron app | normal Electron size | nothing, but bundles Chromium |

Only one Luau VM ever loads — JSPI where the browser supports it, Asyncify
otherwise. The single file is larger than the static site because it carries
both VMs and the export player inline rather than fetching what it needs.
Electron buys native file dialogs and direct disk access, at Chromium's size.

## Exporting a game

**Export game** writes a single HTML file with the engine, the VM for your
project's language and your whole project inlined — about 2 MB for Luau,
0.8 MB for Python — and it runs from `file://`. Drop it on a USB stick, email
it, or put it on any static host. An export never carries the other VM.

**Export project** downloads the project as one JSON file instead, for moving
work between machines. On the desktop, **Save** writes an ordinary folder of
`.bsprite` / `.btileset` / `.bobject` / `.luau` / `.broom` files that lives
happily in git.

## Making games without writing the plumbing

Three features carry most of the weight:

**Object templates.** Creating an object offers a working behaviour, not an
empty file: top-down player, platformer player (gravity and jump), wall,
collectible, patrolling enemy, bullet, controller (score HUD, camera follow,
restart). Each suggests its conventional name and arrives with its collision
list already ticked.

**Collision without code.** Every object has a *Collision* panel listing solid
tiles and the other objects; tick what it cannot walk into. The engine then
resolves that object's movement per axis after each step — slide along walls,
rest on floors under gravity without `vspeed` winding up, speed zeroed on the
blocked axis. The whole top-down player template is therefore:

```lua
function obj.step(self)
	self.hspeed = (axis("right", "d") - axis("left", "a")) * SPEED
	self.vspeed = (axis("down", "s") - axis("up", "w")) * SPEED
end
```

The `collision` *event* is unchanged and orthogonal: blocking prevents
overlaps, the event reports the overlaps you still want (pickups, hitboxes).

**Sprite import.** Drop image files on the SPRITES group (or click ⭳). Sheet
slicing is *measured*, not guessed: the detector reads the blank columns and
rows between frames to recover frame size, margin and spacing exactly, and the
dialog draws the cut lines over the image before you commit. Palettes are
extracted from the art. The tileset editor uses the same detector — importing
a sheet with visible gaps arrives already sliced, and **Detect grid**
re-measures on demand. A flush-packed sheet has nothing to measure, and both
say so rather than pretending.

## Python mode

The same engine, the same API, in Python. Pick the language when creating a
project (**New → Language**), or switch it later in **Settings** — nothing is
translated, so existing scripts then need rewriting, and the dialog says so.

```python
# objects/obj_player.py
SPEED = 4


def create(self):
    self.hp = 3


def step(self):
    if keyboard_check("right") and not self.place_meeting(self.x + SPEED, self.y, "obj_wall"):
        self.x += SPEED


def collision(self, other):
    if other.is_a("obj_coin"):
        other.destroy()
```

What changes is only the spelling: events are module-level `def`s (no module
table to return), instance methods take a dot, `nil` is `None`, `alarms[1]`
stays 1-based, `game.GetService("RunService")`, and `task.wait` is an
awaitable — `await task.wait(0.5)` inside an `async def` handed to
`task.spawn`. Every name is identical, the manual shows both languages side by
side (the Docs tab follows the project, with a toggle), autocomplete and
highlighting are Python-aware, and the object templates and event stubs come
in Python.

It runs on [MicroPython](https://micropython.org/) compiled to WebAssembly,
vendored into `src/vendor/micropython.js` with the 436 KB `.wasm` embedded
(`tools/vendor-micropython.mjs`; `test:vendor` fails if it is stale), so the
single-file editor, the desktop app, exports and the Node tests all run it
with zero network requests. It is slower than Luau — roughly 5 ms a frame for
100 moving, animated instances with alarms against Luau's ~1 ms — which is
comfortably inside the budget for the kind of game this engine is for.
`src/python/prelude.py` mirrors `prelude.luau` section for section; the same
88 engine checks and 180 per-function checks run against both.

## Block mode

Choose **Blocks** under Scripting when creating a project, or switch in
**Settings**. Objects then open in a Scratch-style workspace — [Blockly](https://github.com/google/blockly)
with its `zelos` renderer, themed to the editor — with an event hat per engine
event and a block per engine function, field, colour and key, alongside the
usual logic, loops, maths, text, lists, variables and functions. Every change
compiles the workspace into the project's language (Luau or Python) and that
script is what runs, exports, and is named in error messages; **View code**
shows it beside the blocks.

The mapping is one-to-one with the API: *key right held?* is
`keyboard_check("right")`, *change x by 2* is `self.x += 2`, a variable
`score` is the per-instance field `self.score`, and a function from the
*Functions* category becomes a script-level function taking `self`. The Luau
generator is overridden where Blockly's stock output is not Luau (`goto
continue` becomes `continue`). **Convert to code** keeps an object's generated
script and drops its blocks; switching the project back to Code keeps every
object's blocks dormant, so the round trip loses nothing; templates are code,
so block-mode objects start from a *create* and a *step* hat.

Blockly is loaded only when a block editor opens (a separate 745 KB chunk),
and with the trashcan, zoom controls and sounds off nothing is fetched at
runtime — the single-file editor and the desktop app work from `file://`, and
`tests/browser-blocks.test.mjs` asserts no request leaves the app. Exports
carry only generated code, never Blockly. `tests/blocks.test.mjs` generates
each fixture workspace in both languages and runs the results on both
engines, asserting identical draw records.

## GameMaker style or Roblox style

The same project can be shown two ways. **Settings** in the top bar switches
between them, in either direction, as one undoable step:

| | GameMaker style (default) | Roblox style |
| --- | --- | --- |
| Sidebar | Five flat lists: sprites, tilesets, objects, rooms, scripts | An Explorer: `Workspace` (objects, each carrying its Script and Sprite rows), `StarterRooms`, `ReplicatedStorage` (shared scripts), `Assets` (sprites, tilesets) — with folders you create, drag into and nest |
| Files on disk | identical | identical |
| The engine | identical | identical |

Nothing is converted. The tree is an *overlay* — `config.explorer` in
`benseditor.json` is a flat list of nodes with parent pointers that reference
the same assets — so switching to Roblox style adopts every asset under its
service, switching back leaves the tree dormant, and switching again finds the
folders exactly as they were. Every create, rename and delete goes through the
same code in both views (`src/ui/assetOps.ts`), and the Explorer's own edits
(folders, drag-to-reparent) are ordinary undoable commits. Exported games
never carry any of it.

The *runtime* instance tree is independent of that view and available in both
styles — see [The instance tree](#the-instance-tree) below.

## Writing an object

An object is a `.bobject` (its properties) and a `.luau` (its behaviour). The
script returns a table; define only the events you need.

```lua
local obj = {}

function obj.create(self)
	self.hp = 3
	self.alarms[1] = 60          -- fires obj.alarm in 60 steps
end

function obj.step(self)
	if keyboard_check("space") then
		instance_create(self.x, self.y, "obj_bullet")
	end
end

function obj.collision(self, other)
	if other:is_a("obj_enemy") then
		self.hp -= 1
	end
end

function obj.draw(self)
	self:draw_self()
end

return obj
```

Events, in execution order: `create`, `destroy`, `room_start`, `room_end`,
`alarm(index)`, `step_begin`, `step`, `step_end`, `collision(other)`,
`animation_end`, `draw`, `draw_gui`.

Alarms are **1-based** (`self.alarms[1]`), matching Luau's table convention
rather than GameMaker's.

Keys are plain strings: `keyboard_check("left")`, `"space"`, `"a"`, `"5"`,
`"shift"`. Colours are `0xRRGGBB` integers.

The complete surface — 54 globals, 18 instance methods, 25 instance fields and
every service — is documented with signatures and examples in
[docs/scripting.md](docs/scripting.md), [docs/drawing.md](docs/drawing.md),
[docs/the-world.md](docs/the-world.md) and
[docs/input-and-maths.md](docs/input-and-maths.md). It is deliberately not
duplicated here, where it would rot.

## Roblox-style API

Since the scripting language is Luau, the engine also ships the patterns Roblox
developers expect — implemented in `src/luau/roblox.luau`, on top of the same
engine.

### Events

```lua
local bell = Signal.new()
local conn = bell:Connect(function(amount) print(amount) end)
bell:Once(function() end)       -- fires at most once
bell:Fire(10)
conn:Disconnect()
```

Instances carry `Collided` and `Destroying` signals, created lazily on first
access so a room full of walls costs nothing:

```lua
function obj.create(self)
    self.Collided:Connect(function(other)
        if other:is_a("obj_coin") then other:Destroy() end
    end)
end
```

### Services

```lua
local RunService = game:GetService("RunService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local DataStoreService = game:GetService("DataStoreService")
```

| Service | Provides |
| --- | --- |
| `RunService` | `Heartbeat`, `Stepped`, `RenderStepped` — all fired with the frame delta |
| `UserInputService` | `InputBegan`, `InputEnded`, `IsKeyDown`, `GetMouseLocation` |
| `ReplicatedStorage` | `Set` / `Get` (`SetAttribute` / `GetAttribute`) with a `Changed` signal |
| `DataStoreService` | `GetDataStore(name)` → `SetAsync`, `GetAsync`, `RemoveAsync`, `IncrementAsync`, `UpdateAsync` — persisted to the browser |
| `ScriptService` | `Require(name)`, `GetScripts()` — modules from `scripts/` |
| `HttpService` | `JSONEncode`, `JSONDecode`, `GenerateGUID` |
| `Workspace` (`workspace`) | `GetChildren` (the roots), `GetDescendants` (everything), `FindFirstChild` (by name, then by object), `CountOf`, `GetPartsInRegion` |

### task

```lua
task.spawn(function()
    task.wait(0.5)
    print("half a second later")
end)

task.delay(2, function() end)
task.defer(function() end)      -- next step
```

Shared modules return a table and load with `require`:

```lua
-- scripts/mathx.luau
local m = {}
function m.double(n) return n * 2 end
return m

-- anywhere else
local mathx = require("mathx")
```

### The instance tree

Every instance is a root — a child of the Workspace — until game code parents
it. Parenting is ownership and naming, not a transform: a child keeps its own
`x` and `y`. What it buys is a place to hang related instances so they can be
found by name and destroyed together:

```lua
function obj.create(self)
    local bar = Instance.new("obj_healthbar", self)   -- parented before create runs
    bar.Name = "health"
end

function obj.step(self)
    local bar = self:find_first_child("health")       -- or FindFirstChild
    if bar then bar.value = self.health end
end
-- destroying self destroys the bar, parent first
```

`inst.Parent = other` moves it (`nil` or `workspace` makes it a root; a cycle
is an error); `get_children` / `get_descendants` / `find_first_child` and their
CamelCase twins walk it; `name` defaults to the object name and can be set per
placement in the room editor's inspector. A persistent child of a dead parent
survives a room change as a root. All of it lives in the VM
(`src/luau/prelude.luau`), so a game that never parents anything is exactly the
flat world it always was — `tests/tree.test.mjs` checks that first.

### One caveat

**`pcall` does not catch errors in this Luau build** — they propagate straight
out to the host and stop the game. It is present and callable, so it looks like
it works. The engine works around it where it matters: `DataStore:GetAsync`
returns your default on corrupt data rather than relying on `pcall`.

## Conventions

Rooms use a top-left origin with **+y pointing down**. Angles are degrees
counter-clockwise with 0 = right, so `point_direction`, `image_angle` and
`lengthdir_*` all agree. Lower `depth` draws in front. An object's **Inherits**
(`parent` in `.bobject`) is a type relationship used by `is_a()` and collision
matching; it has nothing to do with the runtime `Parent` of an instance.

## Layout

```
src/luau/
  prelude.luau            the engine — all game logic and the scripting API
  roblox.luau             Signal, task, and game:GetService
src/python/
  prelude.py  roblox.py   the same engine in Python, for MicroPython
src/demo/gd/               the Geometry Dash clone: constants/levels/art/data + scripts/*.py
src/vendor/
  micropython.js          MicroPython WASM, wasm embedded (generated, do not edit)
src/engine/
  scriptHost.ts           the seam: one interface both engines implement
  luauHost.ts  pythonHost.ts   the two VMs behind it
  runtime.ts              asset registration and the frame loop
  renderer.ts             batched WebGL2 renderer
  atlas.ts  font.ts       texture atlas and baked bitmap font
  protocol.ts             draw-command format, shared with the prelude
  input.ts                keyboard/mouse capture and serialisation
src/ui/
  spriteEditor.ts         pixel art editor
  roomEditor.ts           room layout editor
  objectEditor.ts         properties + event checklist
  explorerTree.ts         the Roblox-style sidebar: services, folders, drag-to-reparent
  projectSettings.ts      the Settings dialog: style, language, scripting mode
  blockEditor.ts          the Scratch-style block editor (Blockly, lazily loaded)
src/blocks/
  blockDefs.ts            every block, its toolbox category, and its Luau and Python generators
  generate.ts             workspace JSON → a complete object script
  codeEditor.ts           editing commands, completion, find, the overlay
  languageSpec.ts         what the editor asks of a language; luauLanguage.ts, pythonLanguage.ts answer
  syntaxCore.ts           tokens, caret rules, bracket matching (language-neutral)
  luauSyntax.ts  pythonSyntax.ts   the two tokenisers
  apiSurface.ts           the API surface: names, kinds, signatures (language-neutral)
  luauApi.ts  pythonApi.ts        each language's keywords and completion rules
  docsData.ts             the manual — the one source docs/ is built from
  docsPanel.ts            the Docs tab
  assetTree.ts            the flat GameMaker-style sidebar
  assetOps.ts             create/rename/delete/import, shared by both sidebars
  gamePanel.ts            the play tab
src/project/
  types.ts                asset formats
  store.ts                open project, change events, undo
  storage.ts              File System Access, import/export, autosave
  validate.ts             defaults and repairs, on every path a project comes in by
  explorer.ts             the Explorer overlay: services, reconcile, drop rules
src/demo/                 the starter project
docs/                     generated from src/ui/docsData.ts
tools/build-docs.mjs      writes docs/; --check fails when it is stale
tools/build-single.mjs    inlines everything into one HTML file
tools/vendor-micropython.mjs  embeds the wasm into src/vendor/micropython.js; --check
tests/engine.test.mjs     engine tests (Node, no browser)
tests/docs.test.mjs       the manual against the engine, both directions
tests/tree.test.mjs       the runtime instance tree
tests/engine-py.test.mjs  the engine tests, against the Python engine
tests/api-py.test.mjs     the per-function audit, against the Python engine
tests/python-smoke.test.mjs   thirty Python scenes incl. a frame-time budget
tests/pythonSyntax.test.mjs   the Python tokeniser and editor rules
tests/browser-python.test.mjs Python end to end: editor, game, error line, export
tests/blocks.test.mjs     blocks → Luau and Python → both engines, identical output
tests/browser-blocks.test.mjs block mode end to end in Chromium
tests/browser.test.mjs    editor + game tests in real Chromium
tests/explorer.test.mjs   the Explorer model, and the paradigm switch in Chromium
legacy/vscode-extension/  superseded VS Code + Python version, kept for reference
```

## The editors

| Editor | What it does |
| --- | --- |
| **Sprite** | Pencil `B`, eraser `E`, fill `G`, picker `I`, line `L`, rect `R`, ellipse `C`, shift `M`. Brush sizes 1–4 (`[` `]`), palette, frames with onion skin and playback, draggable origin (Alt+click), collision mask with *Fit to pixels*, canvas resize. Scroll to zoom, space-drag to pan, `0` to fit. |
| **Room** | Object palette with live sprite thumbnails, click to place, drag to move, right-click to delete, snap-to-grid, depth-correct preview, per-instance inspector including the instance's runtime `name`. |
| **Tileset** | Import a sheet, set the tile size, and click tiles to mark them solid — the collision map is authored right on the artwork. |
| **Object** | Sprite/inherits/depth/flags, plus an event checklist derived from the script itself — click an undefined event to insert its stub (or its hat, in block mode). |
| **Blocks** | Scratch-style workspace per object: event hats, engine blocks, per-instance variables, functions; compiles to Luau or Python on every change, with *View code* and *Convert to code*. |
| **Code** | Luau or Python highlighting, ranked autocomplete, find and replace, comment toggling, line moving and duplication, bracket matching, an active-line marker and a status bar. Long files scroll inside the editor, and only the visible lines are highlighted. |
| **Docs** | The whole manual, searchable, with highlighted samples in both languages. `F1`. |

`Ctrl+Z` / `Ctrl+Y` undo across everything; `Ctrl+S` saves; `F1` opens the manual.

### Autocomplete

Fires as you type an identifier, or on `Ctrl+Space`. It knows where the caret
is, so it offers the right thing:

Matching is ranked, not filtered: an exact prefix wins, then a
case-insensitive one, then a substring, then an abbreviation — so `insnum`
finds `instance_number` without pushing `instance_create` off the top.

| Context | Suggestions |
| --- | --- |
| Anywhere | Engine functions with signatures, services, colour constants, keywords, and names already used in the file |
| Inside a comment | Nothing — the tokeniser knows where the caret is |
| After `self:` | Instance methods — `place_meeting(x, y, object)`, `draw_self()`, `is_a(name)` … |
| After `self.` | Instance fields — `x`, `hspeed`, `image_angle`, `alarms` … |
| After `task.` | `spawn`, `wait`, `delay`, `defer`, `cancel` |
| After `game:` | `GetService`, `FindService`, `GetServices` |
| After `RunService.` | `Heartbeat`, `Stepped`, `RenderStepped` |
| After any other `:` | Signal and DataStore methods, for handles held in locals |
| Inside `"…"` | Your own sprite, object and room names, plus key names like `"left"` |

The popup opens the moment you type `.` or `:` — before any prefix — since
that is exactly when you least know what is available. `↑`/`↓` to move, `Enter`
or `Tab` to accept, `Esc` to dismiss; accepting a function types its parentheses
and puts the caret between them. The selected entry's description is shown under
the list.

The list is generated from the same table that drives syntax highlighting
(`src/ui/luauApi.ts`), and the descriptions come from the manual
(`src/ui/docsData.ts`), so neither can drift out of step with the engine —
`test:docs` fails if they do.

### While typing

Enter after `then`, `do`, `else`, `repeat`, a function header or an opening
bracket indents a level **and closes the block for you** — `end`, or `until`
after `repeat`.

```lua
for i = 1, 10 do          -- press Enter here
	|                     -- and you get this
end                       -- and this
```

The `end` is written only when the file is genuinely missing one, counted from
the tokens rather than the raw text. So editing inside a block that already
closes adds nothing, a `function` inside a comment or a string opens nothing,
and `if x then return end` on one line is recognised as already balanced. You
cannot end up with a stray `end`.

Because the count comes from the tokeniser rather than a pattern, it also
handles what the old rule missed — `local function axis(a: string): number`
opens a block even though the line does not end in `)`.

Typing `end`, `else`, `elseif`, `until` or `}` pulls the line back one level.
Brackets and quotes auto-pair — except directly in front of a word, where `(`
means a call rather than a wrap — typing the closer steps over it, Backspace
between an empty pair removes both, selecting text and typing a bracket wraps
it, and Enter inside a fresh pair puts the closer on its own line.

`Tab` always accepts the highlighted completion. `Enter` only accepts one that
*continues* what you typed, so `local n: number` stays that way instead of
turning into `image_number()`.

### Editing commands

| Key | Does |
| --- | --- |
| `Tab` / `Shift+Tab` | Indent or outdent — every line, when the selection spans several |
| `Ctrl+/` | Comment the selected lines, or uncomment them if they all already are |
| `Alt+↑` `Alt+↓` | Move the line, or the selected lines |
| `Shift+Alt+↑↓` | Duplicate them |
| `Ctrl+Shift+K` | Delete the line |
| `Ctrl+F` / `Ctrl+H` | Find, and find with replace — with a match count and every hit highlighted |
| `Ctrl+G` | Go to line |
| `Home` | To the first non-blank character, then to the margin |

The status bar reports the caret position, the size of the selection and the
length of the file, and the bracket matching the one beside the caret is
highlighted.

### Two things that make it hold up

**Undo works.** Every programmatic change — auto-indent, bracket pairing,
accepting a completion, replace-all — goes through the browser's own
`insertText` command rather than assigning to `textarea.value`. Assigning to
`value` silently clears the native undo stack, which meant that before this,
one auto-indent made everything typed before it unrecoverable.

**Only the visible lines are highlighted.** Painting a whole file cost 220 ms
per keystroke at 2000 lines — 12,000 spans and 483 kB of HTML, for the forty
lines anyone can see. The overlay now renders the viewport plus a small margin
and is translated into place, and the scroll position is read once per
keystroke rather than before and after the repaint, which was forcing two full
layouts of a textarea holding the entire file.

| 2000-line file | Per keystroke |
| --- | --- |
| Whole document, two forced layouts | 220 ms |
| Windowed overlay, one layout read | **~9 ms** |

(Measured on an idle page. The same code measures anywhere from 5 to 25 ms
depending on what else is running, which is why the suite asserts the *shape* —
that the cost barely moves with file size — rather than a wall-clock number it
cannot reproduce.)

Tokenising still walks the whole file — it has to, since a long string can
begin anywhere above you — but that is 5 ms of the remainder, and the cost
barely moves with file size. The browser suite asserts exactly that: sixteen
times the file must not cost five times the work.

### What the review found

The rewrite was then read by four independent reviewers, each given one lens —
offset arithmetic, the windowed overlay, event handling, the tokeniser — and
every claim was handed to a separate agent told to refute it. Twelve survived,
and all twelve were real:

| Defect | Why it mattered |
| --- | --- |
| `lastIndexOf('\n', -1)` inspects index 0 | In a file starting with a blank line, *every* line command worked on the wrong line |
| Find offsets never recomputed after an edit | Replace All spliced from stale positions and silently mangled the file |
| Backtick strings scanned as multi-line | One stray `` ` `` turned the rest of the file into a string |
| `\z` escape not handled | The real closing quote was read as an opening one |
| `tokenAt` counted `offset === start` as inside | `print(|"hi")` offered asset names; `|--note` refused to auto-close |
| No resize handling | Dragging the window taller exposed blank lines |
| Completing mid-word | `insta|nce` left `instance_create()nce` |
| Popup chrome stole focus | Clicking its scrollbar dismissed it |
| `Ctrl+Z` in the find box | Rolled back the whole project |
| Tabs counted as a flat four columns | The status bar and popup drifted after a tab |
| Blur never flushed | Up to 400 ms of typing lost when a click committed to the store |
| Overlays clamped in one direction | A search match outside the rendered window duplicated text |

Ten further claims were raised but not put through verification; the ones that
held up on inspection are fixed too — `Ctrl+F` reaching the browser once the
find box had focus, no `isComposing` guard so an IME's committing Enter also
inserted a newline, AltGr-typed brackets never pairing, a selection ending at
column 0 indenting the line below it, the bracket overlay staying lit after the
editor lost focus, and `matchBracket` giving up on the character after the caret
when the one before it was unmatched.

The regression tests near the end of `test:browser` cover the ones that could
corrupt a file.

## Tiles

Tilesets are their own asset. A tileset is one sheet plus a tile size; the grid
is derived from the image, and each tile carries a **solid** flag.

Sheets rarely start at pixel 0 with tiles flush against each other, so the
tileset editor takes a **margin** (blank border before the first tile) and
**spacing** (the gap between tiles). The editor dims everything the slice does
not cover, and hovering a tile reports exactly which pixels it comes from —
`x 34–49  y 2–17` — plus a warning when a tile falls outside the image. If your
tiles look a pixel off or show slivers of their neighbours, that is what these
are for.

Rooms hold **tile layers**, each bound to a tileset with its own depth — so
tiles interleave with objects in exactly one draw order. In the room editor,
switch to **Tiles**, add a layer, pick a tile and paint. Right-click erases and
the bucket fills.

```lua
-- Solid tiles collide like an object, via the special target "tiles".
if not self:place_meeting(self.x + dx, self.y, "tiles") then
    self.x += dx
end

tilemap_get("stone", 4, 9)        -- tile index at a tile coordinate, -1 if empty
tilemap_get_at("stone", 72, 150)  -- same, by room position
tilemap_set("stone", 4, 9, 2)     -- change a tile at runtime
tile_solid_at(72, 150)            -- is any layer solid here?
tilemap_layers()                  -- layer ids in the current room
```

Layers are run-length encoded on the way into the engine, and a layer you never
edit is uploaded to the GPU once and drawn from a single marker command — so a
full-screen tilemap is effectively free:

| 540-tile checkerboard | Frame cost | Payload |
| --- | --- | --- |
| Streamed every frame | 10.2 ms | 33.8 KB |
| Static (the default) | **0.2 ms** | **0.1 KB** |

`tilemap_set` marks a layer as edited, after which it streams its tiles again
(culled to the visible area) so runtime changes still show up.

## Starting a project

**New** offers four templates:

| Template | What you get |
| --- | --- |
| **Blank** | One black room, runnable immediately — in Luau or Python, as code or blocks |
| **Coin collector** | The walkthrough demo — sprites, walls, tiles, HUD, DataStore |
| **Snake** | A complete little game in a single object script |
| **Dash** | A small Geometry Dash-style runner in Python: a tile-layer level, a camera, spikes, attempts and a progress bar |
| **Geometry Dash** | The full clone in Python — see below |

It warns before discarding unsaved work, and deliberately forgets the previous
folder so **Save** asks where to put the new project rather than overwriting
the old one.

### Geometry Dash

The **Geometry Dash** template is the largest thing built on the engine, and
all of it is Python object scripts (`src/demo/gd/`). It has the real game's
physics — the constants come from the 2.2 decompile, converted to the engine's
fixed 60 Hz step so a jump's height and length match the original — across all
eight gamemodes (cube, ship, ball, UFO, wave, robot, spider, swing), with jump
pads, orbs, gravity / speed / size / mode portals, mini mode, practice-mode
checkpoints and secret coins. A menu drives level select, an icon screen (pick
the cube's colours, saved between sessions), three built-in levels, and an
**in-game level editor**: place blocks, spikes, pads, orbs and portals on a
grid with the mouse, name the level, and save it in the browser. A custom
level is **unverified** until its creator completes it from the editor in a
full run from the start — only then will the menu let anyone play it, exactly
as Geometry Dash gates its own levels.

Everything is proven headlessly: `test:gd-physics` runs the 21 measured
scenarios (jump apexes per speed, the ship hold/release curve, wave slopes,
every pad and orb impulse, the spike hitbox) against the real engine;
`test:gd-levels` drives a bot through the built-in levels (one is completed end
to end, the others load, spawn every mechanic and play a real stretch);
`test:gd-codec` / `test:gd-spawner` / `test:gd-editor` cover the level format,
the streaming object spawner and the editor's document model; the browser
suites play the menu, icon screen, a level and the editor in Chromium. There
is no audio (the engine has none), so the "beat" is visual; hitboxes are
axis-aligned; level names are typed from the letter keys, since the engine has
no text-input API.

Snake is worth reading: the whole game is one `obj_snake` script that keeps its
body as an array of grid cells and draws it with `draw_sprite_ext`, rather than
spawning an instance per segment. Grid logic, input, a HUD, a checkerboard tile
layer and a persistent high score in about 150 lines.

## Saving

**Open folder** and **Save** use the File System Access API, so a project is
real files in a real folder — the same layout the engine reads, ready for git.
Browsers without that API fall back to **Export** / **Import** (one JSON file).
Either way the project is mirrored to `localStorage`, so a refresh never loses
work.

## Status

Everything above works and is covered by thirty-two suites, all run by `npm test`:

| Suite | Checks | What it covers |
| --- | --- | --- |
| `test:vendor` | 1 | That the vendored MicroPython matches the pinned package |
| `test:fixed-step` | 11 | The fixed-step clock: 60 steps a second at 60, 120 and 144 Hz, capped catch-up |
| `test:engine` | 90 | Engine behaviour — events, collision, rooms, tiles, depth |
| `test:api` | 191 | **Every scripting function, individually** |
| `test:tree` | 60 | The instance tree: parenting, lookup, cascade destroy, room changes, and that a flat world is unchanged |
| `test:python-smoke` | 185 | Thirty scenes on the Python engine, including a 100-instance frame-time budget |
| `test:engine-py` | 90 | The engine tests, same assertions, against the Python engine |
| `test:api-py` | 191 | The per-function audit against the Python engine |
| `test:python-syntax` | 107 | The Python tokeniser's invariants and the editor's Python rules |
| `test:blocks` | 172 | Every block has both generators; fixtures generate Luau and Python that run identically on both engines |
| `test:templates` | 16 | Every object template registered, started and stepped on both engines |
| `test:dash` | 19 | Plays the Dash demo in Chromium: runs, dies on the first spike, restarts, jumps, draws its HUD |
| `test:gd-physics` | 178 | Geometry Dash physics: the 21 measured scenarios across all eight gamemodes, pads, orbs, portals |
| `test:gd-codec` | 171 | The GD level format: encode/decode round trips, validation, the balance checker |
| `test:gd-spawner` | 73 | The streaming object spawner: window bounds, one spawn each, restart, tile sync |
| `test:gd-logic` | 124 | The GD menu/HUD/progress toolkit and scene state machines, headless |
| `test:gd-levels` | 4 | A bot plays the built-in levels: one completed end to end, all load and play |
| `test:gd-editor` | 93 | The level editor's document model: place/erase/undo, coins, name field, save with read-back, verification |
| `test:gd-menu` / `-icon` / `-play` / `-end` | 18 / 17 / 23 / 9 | The menu, icon colours, a played level and the end screen in Chromium |
| `test:gd-editor-browser` | 17 | The level editor in Chromium: place a block, name, save, verify, the menu's badge |
| `test:docs` | 36 | The manual against the engine in both directions, both languages' examples, and that the two engines expose identical names |
| `test:dev` | 4 | That `npm run dev` actually boots the app |
| `test:browser` | 167 | The editors and the game in real Chromium, reading pixels back out of the WebGL canvas |
| `test:explorer` | 63 | The Explorer overlay model, and switching paradigms both ways in Chromium |
| `test:browser-python` | 39 | A Python project end to end: editor rules, MicroPython in the game panel, `obj_x.py line N` errors, export played from `file://` |
| `test:browser-blocks` | 32 | Block mode end to end: workspace, hats from the checklist, regeneration, undo isolation, play, convert, mode round-trip, zero external requests |
| `test:snake` | 18 | Plays the Snake template — moves, steers, dies, restarts |
| `test:export` | 7 | Exports a game and plays the result over `file://` |
| `test:electron` | 10 | Launches the desktop app, checks the bridge and runs a game |
| `test:single` | 14 | Opens the one-file editor from `file://` and exports a game from it |

`test:api` walks the whole surface — every global, instance method, instance
field, event, colour constant, service and `task` function — so a function that
exists but is broken cannot hide behind the ones around it. It reports one line
per function.

`test:docs` is the other half of that: `test:api` proves each function *works*,
`test:docs` proves each one is *described*, and that nothing described has since
been renamed away.

Known limits: collision is axis-aligned boxes only (the `circle` and `precise`
mask modes are stored but unused); the `collision` event fires per overlapping
instance, so filter with `other:is_a(...)`; one camera (`view_set_size` and
`view_set`), no view layers; no
audio; text uses a canvas-rendered font, so it is slightly soft when scaled
rather than crisply pixelated.

One upstream bug worth knowing about: `luau-web` corrupts its own global state
if a VM that has run more than ~50 frames is destroyed, which breaks the *next*
VM. Benseditor therefore keeps **one VM for the whole session** and calls
`__reset` between runs — which is also why pressing Run is instant.

## Licence

MIT. Bundled: [luau-web](https://www.npmjs.com/package/luau-web) (MIT),
[MicroPython](https://github.com/micropython/micropython) (MIT, vendored with
its wasm), and [Blockly](https://github.com/google/blockly) (Apache-2.0).
