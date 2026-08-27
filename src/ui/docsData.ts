/**
 * The manual.
 *
 * One structured source, two outputs: the Docs tab renders it in the editor,
 * and `tools/build-docs.mjs` writes `docs/api-reference.md` from the same data.
 * `tests/docs.test.mjs` checks every documented name against the Luau sources,
 * so a function that gets renamed in `prelude.luau` fails the build rather than
 * quietly leaving the manual wrong.
 */

/** Where a name lives, so the drift test knows how to look for it. */
export type DocOrigin =
  | 'global' // a global function in prelude.luau or roblox.luau
  | 'method' // InstanceMethods.<name>
  | 'field' // a field on an instance table
  | 'constant' // a global constant
  | 'member' // a member of a service or namespace table
  | 'event'; // an event handler an object script may define

/**
 * The manual has a Python axis. The engine API is one API with two syntaxes,
 * so every entry keeps its single `summary` (the completion popup quotes it
 * verbatim) and grows a `python*` twin only where the wording or the sample
 * is language-specific. A missing twin means "the Luau text is fine as it is"
 * and the renderers fall back to it.
 */
export type DocLanguage = 'luau' | 'python';

/** How a method is called on an instance: `self:place_meeting` or `self.place_meeting`. */
export function methodReceiver(language: DocLanguage): string {
  return language === 'python' ? 'self.' : 'self:';
}

export interface DocEntry {
  name: string;
  signature?: string;
  returns?: string;
  summary: string;
  detail?: string;
  /** `detail` reworded for Python, where the Luau one names colon syntax or `nil`. */
  pythonDetail?: string;
  example?: string;
  /** The same sample in Python. Present for every entry with an `example`. */
  pythonExample?: string;
  origin: DocOrigin;
}

export interface DocBlock {
  heading?: string;
  text?: string;
  /** `text` reworded for Python mode. */
  pythonText?: string;
  code?: string;
  /** The same sample in Python. Present for every block with `code`. */
  pythonCode?: string;
  list?: string[];
  /** `list` reworded for Python mode. */
  pythonList?: string[];
  table?: { head: string[]; rows: string[][] };
}

export interface DocSection {
  id: string;
  title: string;
  blurb: string;
  /** `blurb` reworded for Python mode. */
  pythonBlurb?: string;
  blocks?: DocBlock[];
  entries?: DocEntry[];
}

export interface DocChapter {
  title: string;
  sections: DocSection[];
}

// ---------------------------------------------------------------------------

const overview: DocSection = {
  id: 'overview',
  title: 'Overview',
  blurb: 'What Benseditor is, and how the pieces fit together.',
  blocks: [
    {
      text:
        'Benseditor is a 2D game engine with GameMaker’s shape — sprites, objects, rooms, ' +
        'events, alarms, depth — scripted in Luau, with a Roblox-flavoured layer on top for ' +
        'signals, tasks and services. Everything runs in the browser: the editor, the Luau VM ' +
        'compiled to WebAssembly, and a WebGL2 renderer.',
      pythonText:
        'Benseditor is a 2D game engine with GameMaker’s shape — sprites, objects, rooms, ' +
        'events, alarms, depth — scripted in Python (or Luau), with a Roblox-flavoured layer on ' +
        'top for signals, tasks and services. Everything runs in the browser: the editor, a ' +
        'MicroPython VM compiled to WebAssembly, and a WebGL2 renderer.',
    },
    {
      heading: 'The five kinds of asset',
      list: [
        '**Sprites** — pixel art, one or more frames, with an origin and a collision rectangle. Drawn with the built-in pixel editor.',
        '**Tilesets** — one image sliced into a grid of tiles, each of which can be marked solid.',
        '**Objects** — behaviour. An object pairs a Luau script with a sprite, a depth and a few flags. Objects are the *class*; what runs in a room is an *instance*.',
        '**Rooms** — a level: a size, a background colour, placed instances, and tile layers.',
        '**Scripts** — shared Luau modules under `scripts/`. They run before any object script, so anything they assign as a global is visible everywhere.',
      ],
      pythonList: [
        '**Sprites** — pixel art, one or more frames, with an origin and a collision rectangle. Drawn with the built-in pixel editor.',
        '**Tilesets** — one image sliced into a grid of tiles, each of which can be marked solid.',
        '**Objects** — behaviour. An object pairs a Python script with a sprite, a depth and a few flags. Objects are the *class*; what runs in a room is an *instance*.',
        '**Rooms** — a level: a size, a background colour, placed instances, and tile layers.',
        '**Scripts** — shared Python modules under `scripts/`. They run before any object script, and `require("name")` hands any object the module.',
      ],
    },
    {
      heading: 'Where your code runs',
      text:
        'A game script is a Luau module. It runs inside a WebAssembly VM, and the whole game ' +
        'API — drawing, collision, input, maths — is itself written in Luau rather than ' +
        'exposed as host calls. That is a deliberate performance decision, explained under ' +
        '*How the engine works*; the practical consequence is that calling engine functions is ' +
        'cheap and you can call them thousands of times per frame.',
      pythonText:
        'A game script is a Python module. It runs inside a MicroPython VM compiled to ' +
        'WebAssembly, and the whole game API — drawing, collision, input, maths — is itself ' +
        'written in Python inside that VM rather than exposed as host calls, mirroring the ' +
        'Luau engine function for function. That is a deliberate performance decision, ' +
        'explained under *How the engine works*; the practical consequence is that calling ' +
        'engine functions is cheap and you can call them thousands of times per frame.',
    },
    {
      heading: 'Coordinates',
      text:
        'The origin is the top-left of the room. X grows right, Y grows **down**. Angles are in ' +
        'degrees, counter-clockwise, with 0 pointing right — so 90 points *up* the screen. ' +
        'That matches GameMaker, and it is why `lengthdir_y` returns a negated sine.',
    },
  ],
};

const firstGame: DocSection = {
  id: 'first-game',
  title: 'Your first object',
  blurb: 'From an empty project to something moving on screen.',
  blocks: [
    {
      text:
        'Press **New** and pick *Blank*. You get one empty room and nothing else. The steps ' +
        'below add a controllable square.',
    },
    {
      heading: '1. Draw a sprite',
      text:
        'Click **+** next to SPRITES, name it `spr_hero`, and paint something in the pixel ' +
        'editor. Set the origin to the middle (the Origin fields in the right-hand panel) so ' +
        'the sprite rotates and scales around its centre.',
    },
    {
      heading: '2. Make an object',
      text:
        'Click **+** next to OBJECTS and name it `obj_hero`. In the object editor choose ' +
        '`spr_hero` as its sprite, then click the **Step** event to add a handler. An object ' +
        'script is a plain Luau module: a table of event functions, returned at the end.',
      pythonText:
        'Click **+** next to OBJECTS and name it `obj_hero`. In the object editor choose ' +
        '`spr_hero` as its sprite, then click the **Step** event to add a handler. An object ' +
        'script is a plain Python module: each event is a top-level function named after it.',
      code: `local obj = {}

function obj.create(self)
\tself.speed = 2
end

function obj.step(self)
\tif keyboard_check("right") then
\t\tself.x += self.speed
\tend
\tif keyboard_check("left") then
\t\tself.x -= self.speed
\tend
end

return obj`,
      pythonCode: `def create(self):
    self.speed = 2


def step(self):
    if keyboard_check("right"):
        self.x += self.speed
    if keyboard_check("left"):
        self.x -= self.speed`,
    },
    {
      heading: '3. Put it in the room',
      text:
        'Open the room, make sure the mode switch says **Instances**, pick `obj_hero` from the ' +
        'list on the left, and click in the room to place one.',
    },
    {
      heading: '4. Play it',
      text:
        'Press **▶ Play**. The game is built from whatever the editors currently hold — ' +
        'there is no build step, and no save is required first. If a script fails to compile, ' +
        'the offending line is shown with its neighbours.',
    },
    {
      heading: 'Where to go next',
      list: [
        'Add a `draw` event to take over rendering — without one, a visible instance draws its own sprite.',
        'Add a `collision` event and check `other:is_a("obj_thing")`.',
        'Use `self.alarms[1] = 60` and an `alarm` event for anything on a timer.',
        'Read *The frame* to see exactly when each event fires.',
      ],
      pythonList: [
        'Add a `draw` event to take over rendering — without one, a visible instance draws its own sprite.',
        'Add a `collision` event and check `other.is_a("obj_thing")`.',
        'Use `self.alarms[1] = 60` and an `alarm` event for anything on a timer.',
        'Read *The frame* to see exactly when each event fires.',
      ],
    },
  ],
};

const editorTour: DocSection = {
  id: 'editor',
  title: 'The editor',
  blurb: 'What each panel does, and the shortcuts worth knowing.',
  blocks: [
    {
      heading: 'Layout',
      list: [
        '**Sidebar** — every asset, grouped by kind. Click to open, right-click to rename, duplicate, delete, or set a room as the start room.',
        '**Tabs** — one per open asset, plus the game.',
        '**Topbar** — Play, project actions, and the two exports.',
      ],
    },
    {
      heading: 'Sprite editor',
      text:
        'Pencil, eraser, fill, line, rectangle and picker, with a 16-colour palette you can ' +
        'edit. Frames run along the bottom; the preview animates them at the sprite’s frame ' +
        'rate. The collision rectangle drawn over the canvas is what `bbox()` and every ' +
        'collision function use — it is not derived from the pixels.',
    },
    {
      heading: 'Importing sprites',
      text:
        'Drop image files on the SPRITES group, or use its ⭳ button. A sheet’s grid is ' +
        'measured from the blank pixels between frames — size, margin and spacing — and the ' +
        'dialog shows the cut lines over the image so a wrong slice is visible before you ' +
        'commit to it. The sprite’s palette is taken from the imported art. Inside the sprite ' +
        'editor, **Import frames…** appends a sheet to the sprite you already have, cropped ' +
        'or padded to its size — never scaled, because scaling pixel art blurs it.',
    },
    {
      heading: 'Tileset editor',
      text:
        'Load a sheet and the grid is detected from the blank pixels between tiles; **Detect ' +
        'grid** re-measures after you change things, and the margin and spacing fields are ' +
        'there for sheets it cannot measure. The readout under the grid names the exact ' +
        'source pixels of the selected tile. Click a tile to toggle **solid**, or drag to ' +
        'paint a run of them; solid tiles are what `place_meeting(x, y, "tiles")`, ' +
        '`tile_solid_at` and the Collision panel’s “Solid tiles” entry all test.',
    },
    {
      heading: 'Room editor',
      text:
        'Two modes. **Instances** places objects, with an inspector for position, scale and ' +
        'angle. **Tiles** paints on tile layers — add a layer, choose a tileset, pick a tile ' +
        'from the palette and paint; hold the bucket toggle for a flood fill.',
    },
    {
      heading: 'Code editor',
      text:
        'Syntax highlighting, completions that know what the engine provides, and the editing ' +
        'commands you expect. The status bar shows the caret position, the size of the ' +
        'selection and the length of the file; the matching bracket is highlighted whenever ' +
        'the caret is beside one.',
      table: {
        head: ['Key', 'Does'],
        rows: [
          ['`Ctrl+Space`', 'Completions. They also appear as you type, and after `.` or `:`.'],
          ['`Tab` (in the popup)', 'Accept the highlighted completion. `Enter` accepts only a suggestion that continues what you typed.'],
          ['`Tab` / `Shift+Tab`', 'Indent or outdent. With more than one line selected, every line moves.'],
          ['`Ctrl+/`', 'Comment the selected lines, or uncomment them if they all already are.'],
          ['`Alt+↑` / `Alt+↓`', 'Move the current line, or the selected lines, up or down.'],
          ['`Shift+Alt+↑↓`', 'Duplicate them.'],
          ['`Ctrl+Shift+K`', 'Delete the line.'],
          ['`Ctrl+F` / `Ctrl+H`', 'Find, and find with replace. `Enter` and `Shift+Enter` step through matches.'],
          ['`Ctrl+G`', 'Go to line.'],
          ['`Home`', 'To the first non-blank character, then to the margin.'],
          ['`Ctrl+S`', 'Save.'],
          ['`Ctrl+Z` / `Ctrl+Y`', 'Undo and redo. Inside the editor this is the text; elsewhere it is the whole project.'],
        ],
      },
    },
    {
      heading: 'While you type',
      list: [
        'Enter after `then`, `do`, `else`, `repeat`, a function header or an open bracket indents a level **and writes the closing `end`** — or `until`, after `repeat`.',
        'The `end` only appears when the file is actually missing one, so editing inside a block that already closes adds nothing and you never get a stray `end`. A keyword inside a comment or a string opens nothing at all.',
        'Typing `end`, `else`, `elseif`, `until` or `}` on its own line pulls it back one level.',
        'Brackets and quotes auto-close, except directly in front of a word — `(` before an existing name is a call, not a wrap. Typing the closer steps over it, Backspace between an empty pair deletes both, and selecting text then typing a bracket wraps the selection.',
        'Completions rank by how well they match, so `insnum` finds `instance_number`. Inside a string they become your asset names instead.',
        '`Tab` always accepts the highlighted completion. `Enter` only accepts one that continues what you typed, so writing `number` in a type annotation stays `number` rather than becoming `image_number`.',
      ],
      pythonList: [
        'Enter after a line ending in `:` or an open bracket indents a level. Python has no closing keyword, so nothing is written on the line after — except the partner of a freshly typed bracket, which goes on its own line.',
        'Enter after a `return`, `pass`, `break`, `continue` or `raise` that ends the line takes one level off, since the block is over.',
        'Typing `else`, `elif`, `except` or `finally` on its own line pulls it back one level to line up with its `if` or `try`.',
        'Brackets and quotes auto-close, except directly in front of a word — `(` before an existing name is a call, not a wrap. Typing the closer steps over it, Backspace between an empty pair deletes both, and selecting text then typing a bracket wraps the selection.',
        'Completions rank by how well they match, so `insnum` finds `instance_number`. Inside a string they become your asset names instead.',
        '`Tab` always accepts the highlighted completion. `Enter` only accepts one that continues what you typed, so writing `int` in an annotation stays `int` rather than becoming `instance_find`.',
      ],
    },
    {
      heading: 'Saving',
      text:
        'Work is mirrored to `localStorage` continuously, so a refresh never loses anything. ' +
        '**Save** writes a real folder of files through the File System Access API (or, on the ' +
        'desktop build, straight to disk); **Export project** downloads the whole thing as one ' +
        'JSON file for browsers without folder access.',
    },
  ],
};

const blockMode: DocSection = {
  id: 'block-mode',
  title: 'Block mode',
  blurb: 'Scratch-style blocks that compile to your project’s language.',
  blocks: [
    {
      text:
        'Choose **Blocks** under Scripting when creating a project, or switch to it in ' +
        '**Settings**. Every object then opens in a block workspace: snap an event hat ' +
        '(*when step*, *when draw*, …) together with motion, sensing, drawing, instance, ' +
        'room and maths blocks, plus the usual logic, loops, variables and functions. ' +
        'Each change compiles the workspace into ordinary Luau or Python — whichever the ' +
        'project uses — and that script is what the engine runs, what exports carry, and ' +
        'what an error message points at. **View code** shows it beside the blocks.',
    },
    {
      heading: 'How blocks map to the API',
      list: [
        'Every engine block is one documented function or field: *key … held?* is `keyboard_check`, *draw rectangle* is `draw_rectangle`, *change x by* is `self.x += …`. The hover text names the function.',
        'Variables are per instance: a variable `score` is `self.score`, so each instance keeps its own and any event can read it.',
        'Functions (the *Functions* category) become script-level functions that receive `self` first, so they can use the instance’s fields and methods.',
        '*self* and *other* (in a collision hat) and *alarm index* (in an alarm hat) are Sensing blocks.',
        'Inside loops, *break* and *continue* work in both languages — the Luau side never emits `goto`.',
      ],
    },
    {
      heading: 'Switching and converting',
      list: [
        '**Convert to code** on an object keeps its generated script and drops its blocks; from then on it is edited as text. Undo brings the blocks back.',
        'Switching the project to **Code** keeps every object’s blocks dormant and shows the generated scripts; switching back to **Blocks** reopens them as blocks.',
        'A hand-written object in a block-mode project stays code, with a **Start from blocks** offer that replaces it with an empty workspace.',
        'Object templates are code, so in block mode a new object starts as a *create* and a *step* hat instead.',
        'Nothing about the project’s files changes: the blocks sit in the object’s `.bobject`, the generated script in its `.luau` or `.py`, and exports never include the blocks.',
      ],
    },
  ],
};

const pythonMode: DocSection = {
  id: 'python-mode',
  title: 'Python mode',
  blurb: 'The same engine and the same names, written in Python.',
  blocks: [
    {
      text:
        'A project’s scripting language is chosen when it is created, and can be switched ' +
        'later under **Settings**. Switching changes which engine runs the game and which ' +
        'editor opens scripts; it does not translate anything, so keep a project’s scripts in ' +
        'one language. The API is identical: every function, field, service and event in this ' +
        'manual exists under the same name in both languages, with the same arguments — only ' +
        'the syntax around it changes. In the editor the samples follow the project’s language ' +
        'and the switch at the top of the Docs tab shows the other; the markdown copy under ' +
        '`docs/` shows both.',
    },
    {
      heading: 'The shape of a script',
      text:
        'A Luau object script returns a table of event functions. A Python object script *is* ' +
        'that table: each event is a top-level `def` named after the event, there is no ' +
        '`return`, and any other top-level name is a private helper. Methods on an instance ' +
        'are called with a dot rather than a colon, and so is everything on a service, a ' +
        'signal or a data store. Alarm indices stay 1-based, exactly as documented.',
      code: `local obj = {}

function obj.create(self)
\tself.alarms[1] = room_speed() * 2
end

function obj.alarm(self, index)
\tif not self:place_meeting(self.x, self.y + 4, "obj_wall") then
\t\tself.y += 4
\tend
end

return obj`,
      pythonCode: `def create(self):
    self.alarms[1] = room_speed() * 2


def alarm(self, index):
    if not self.place_meeting(self.x, self.y + 4, "obj_wall"):
        self.y += 4`,
    },
    {
      heading: 'Luau to Python',
      table: {
        head: ['Luau', 'Python'],
        rows: [
          ['`local x = 1`', '`x = 1`'],
          ['`nil`', '`None`'],
          ['`a ~= b`', '`a != b`'],
          ['`"Score " .. n`', '`f"Score {n}"`'],
          ['`self:destroy()`', '`self.destroy()`'],
          ['`game:GetService("RunService")`', '`game.GetService("RunService")`'],
          ['`sig:Connect(fn)` / `conn:Disconnect()`', '`sig.Connect(fn)` / `conn.Disconnect()`'],
          ['`for i = 1, 3 do … end`', '`for i in range(1, 4):`'],
          ['`for _, inst in list do … end`', '`for inst in list:`'],
          ['`#list`', '`len(list)`'],
          ['`if a then … elseif b then … else … end`', '`if a:` … `elif b:` … `else:`'],
          ['`function(x) … end`', '`def name(x):` or `lambda x: …`'],
          ['`math.floor(n)`', '`math.floor(n)`, after `import math`'],
          ['`pcall(fn)`', '`try:` … `except Exception:`'],
          ['`task.wait(1)`', '`await task.wait(1)`, inside an `async def`'],
          ['`self.alarms[1]`', '`self.alarms[1]` — still 1 to 12'],
        ],
      },
    },
    {
      heading: 'Waiting is async',
      text:
        'Only an `async def` can wait. Pass one to `task.spawn` (or `task.delay`) and write ' +
        '`await task.wait(seconds)` inside it. A plain `def` cannot wait — `await` is only ' +
        'legal inside `async def` — so a helper that pauses has to be async all the way down. ' +
        'Signal handlers and events are ordinary functions, as before.',
      code: `task.spawn(function()
\ttask.wait(0.5)
\tself.visible = true
end)`,
      pythonCode: `async def reveal():
    await task.wait(0.5)
    self.visible = True

task.spawn(reveal)`,
    },
    {
      heading: 'Files',
      text:
        'Python sources are saved as `.py` beside the object’s `.bobject`, exactly where a ' +
        'Luau project keeps its `.luau`: `objects/obj_hero.py`, `scripts/helpers.py`. ' +
        'Everything else in the project is the same JSON. See *Project format*.',
    },
  ],
};

const runningExporting: DocSection = {
  id: 'running',
  title: 'Running and exporting',
  blurb: 'The three ways to run the editor, and how a finished game ships.',
  blocks: [
    {
      heading: 'Running the editor',
      table: {
        head: ['Command', 'What you get'],
        rows: [
          ['`npm run dev`', 'Dev server with hot reload.'],
          ['`npm run build` then `npm run preview`', 'The production static site.'],
          ['`npm run build:single`', '`dist-single/benseditor.html` — the whole editor in one file. Open it directly; no server.'],
          ['`npm run desktop`', 'The Electron app, with native file dialogs.'],
        ],
      },
    },
    {
      heading: 'Export game',
      text:
        'Writes a single self-contained HTML file: your project, the Luau VM, the renderer and ' +
        'a minimal player, with no external requests. Open it anywhere, or put it on any static ' +
        'host. It is a few megabytes because it carries a whole language runtime.',
      pythonText:
        'Writes a single self-contained HTML file: your project, the MicroPython VM, the ' +
        'renderer and a minimal player, with no external requests. Open it anywhere, or put it ' +
        'on any static host. It is a few megabytes because it carries a whole language runtime.',
    },
    {
      heading: 'Export project',
      text:
        'Downloads the project as one JSON file, which **Import** reads back. Use *Save* to a ' +
        'folder instead if you want something that diffs sensibly in git.',
    },
  ],
};

// ---------------------------------------------------------------------------

const objects: DocSection = {
  id: 'objects',
  title: 'Objects and events',
  blurb: 'The shape of an object script, and every event it can define.',
  blocks: [
    {
      text:
        'An object script is a module that returns a table. Each event is a function on that ' +
        'table, and the first argument is always the instance the event is running for. The ' +
        'table is shared by every instance of the object; per-instance state belongs on `self`.',
      pythonText:
        'An object script is a Python module. Each event is a top-level function named after ' +
        'the event, and the first argument is always the instance the event is running for. The ' +
        'module is shared by every instance of the object; per-instance state belongs on `self`.',
      code: `local obj = {}

function obj.create(self)
\tself.health = 3
end

return obj`,
      pythonCode: `def create(self):
    self.health = 3`,
    },
    {
      text:
        'The script must end by returning that table. A script that returns nothing is reported ' +
        'as an error when the game starts, rather than failing later with something opaque.',
      pythonText:
        'There is nothing to return: the module’s own namespace is the event table, so a ' +
        'top-level function whose name is an event name is picked up, and any other top-level ' +
        'name — a constant, a helper — stays private to the script.',
    },
    {
      heading: 'Inheritance',
      text:
        'An object can name a **parent**. `is_a("obj_parent")` is then true for the child, and ' +
        'so is every collision and instance query that names the parent — `instance_number' +
        '("obj_enemy")` counts every kind of enemy. Events are *not* inherited: a child that ' +
        'wants the parent’s behaviour has to call it itself.',
    },
    {
      heading: 'Flags',
      list: [
        '**Visible** — seeds `self.visible`. A visible instance with no `draw` event draws its own sprite.',
        '**Solid** — seeds `self.solid`. The engine does not act on it; it is yours to test.',
        '**Persistent** — the instance survives a room change instead of being destroyed with the room.',
        '**Depth** — seeds `self.depth`. Larger values draw further back.',
      ],
    },
    {
      heading: 'Templates',
      text:
        'Creating an object offers ready-made behaviours — a top-down player, a platformer ' +
        'player, a wall, a collectible, a patrolling enemy, a bullet and a controller. Each is ' +
        'a working object, not a snippet: pick Player, drop it in a room with walls, and it ' +
        'moves and collides with nothing else written. The scripts assume conventional names ' +
        'like `obj_player` and `obj_wall`, and say so where they do.',
    },
    {
      heading: 'Collision without code',
      text:
        'The **Collision** panel lists solid tiles and every other object; ticking one means ' +
        'this object cannot walk into it. The engine resolves movement against the ticked set ' +
        'after every step, one axis at a time — so a blocked object slides along a wall rather ' +
        'than sticking to it, gravity rests on floors without accumulating, and plain ' +
        '`hspeed`/`vspeed` movement needs no `place_meeting` calls at all. A blocked axis has ' +
        'its speed zeroed on contact. The `collision` *event* is separate and still fires for ' +
        'genuine overlaps — pickups, hitboxes — which blocking prevents rather than causes.',
    },
  ],
  entries: [
    {
      name: 'create',
      signature: '(self)',
      summary: 'Runs once, as the instance comes into existence.',
      detail:
        'For instances placed in a room, every instance in that room is created first and only ' +
        'then does any `create` run — so a `create` handler can already see its neighbours. ' +
        '`instance_create` runs it immediately instead, before returning.',
      origin: 'event',
    },
    {
      name: 'destroy',
      signature: '(self)',
      summary: 'Runs when the instance is destroyed.',
      detail:
        'Fires from `destroy()` / `instance_destroy()`, before the instance leaves the world. ' +
        'It does *not* fire for instances cleared by a room change.',
      origin: 'event',
    },
    {
      name: 'room_start',
      signature: '(self)',
      summary: 'Runs on every live instance when a room begins.',
      origin: 'event',
    },
    {
      name: 'room_end',
      signature: '(self)',
      summary: 'Runs on every live instance just before a room is left.',
      origin: 'event',
    },
    {
      name: 'alarm',
      signature: '(self, index)',
      summary: 'Runs when one of the twelve alarm counters reaches zero.',
      detail: '`index` is 1 to 12. See `alarms` under *Instance fields*.',
      example: `function obj.create(self)
\tself.alarms[1] = 60
end

function obj.alarm(self, index)
\tif index == 1 then
\t\tself:destroy()
\tend
end`,
      pythonExample: `def create(self):
    self.alarms[1] = 60


def alarm(self, index):
    if index == 1:
        self.destroy()`,
      origin: 'event',
    },
    {
      name: 'step_begin',
      signature: '(self)',
      summary: 'Runs before alarms and the main step.',
      origin: 'event',
    },
    {
      name: 'step',
      signature: '(self)',
      summary: 'The main per-frame event. Runs before movement is applied.',
      detail:
        'Setting `hspeed` here takes effect this same frame, because movement is applied after ' +
        'every instance’s `step` has run.',
      origin: 'event',
    },
    {
      name: 'step_end',
      signature: '(self)',
      summary: 'Runs after movement and collisions, before drawing.',
      detail: 'The right place for a camera that must not lag a frame behind the player.',
      origin: 'event',
    },
    {
      name: 'collision',
      signature: '(self, other)',
      summary: 'Runs once for every other instance overlapping this one.',
      detail:
        'It fires for **every** overlapping instance, whatever its object, so filter with ' +
        '`other:is_a(...)`. Only instances that define this event (or connect to `Collided`) ' +
        'are tested at all, which is what keeps a room full of scenery cheap.',
      pythonDetail:
        'It fires for **every** overlapping instance, whatever its object, so filter with ' +
        '`other.is_a(...)`. Only instances that define this event (or connect to `Collided`) ' +
        'are tested at all, which is what keeps a room full of scenery cheap.',
      example: `function obj.collision(self, other)
\tif other:is_a("obj_coin") then
\t\tother:destroy()
\t\tself.score += 1
\tend
end`,
      pythonExample: `def collision(self, other):
    if other.is_a("obj_coin"):
        other.destroy()
        self.score += 1`,
      origin: 'event',
    },
    {
      name: 'animation_end',
      signature: '(self)',
      summary: 'Runs on the step the sprite’s frame index wraps past the last frame.',
      detail: 'Never fires for a single-frame sprite, or while `image_speed` is 0.',
      origin: 'event',
    },
    {
      name: 'draw',
      signature: '(self)',
      summary: 'Takes over drawing for this instance.',
      detail:
        'Defining it replaces the automatic sprite draw entirely — including the `visible` ' +
        'check — so call `self:draw_self()` if you still want the sprite. Instances are ' +
        'drawn in depth order, interleaved with tile layers.',
      pythonDetail:
        'Defining it replaces the automatic sprite draw entirely — including the `visible` ' +
        'check — so call `self.draw_self()` if you still want the sprite. Instances are ' +
        'drawn in depth order, interleaved with tile layers.',
      origin: 'event',
    },
    {
      name: 'draw_gui',
      signature: '(self)',
      summary: 'Runs after every instance and layer has drawn.',
      detail:
        'Use it for HUD and overlays: it is drawn last, so it is always on top. It is **not** ' +
        'a separate screen-space pass — coordinates are still room coordinates, so if you ' +
        'scroll the view with `view_set` you must offset the HUD by `view_get()` to pin it.',
      origin: 'event',
    },
  ],
};

const frameOrder: DocSection = {
  id: 'frame',
  title: 'The frame',
  blurb: 'Exactly what happens, in order, every step.',
  blocks: [
    {
      text:
        'The game steps `room_speed()` times a second — 60 unless the project says otherwise. ' +
        'Everything below happens in a single call into the VM, in this order:',
      list: [
        'This frame’s keyboard and mouse state is applied.',
        '`UserInputService.InputBegan` fires for each key pressed this frame, `InputEnded` for each released.',
        'The `task` scheduler runs: anything due from `task.wait`, `task.delay` or `task.defer` resumes.',
        '`RunService.Stepped` fires with the delta in seconds.',
        '`step_begin` on every instance.',
        'Alarms count down; each one that reaches zero fires `alarm`.',
        '`step` on every instance.',
        'Movement is applied: `xprevious`/`yprevious` are recorded, gravity and friction adjust `hspeed`/`vspeed`, and those are added to `x`/`y`. Objects with a Collision list move one axis at a time and stop at contact with anything ticked.',
        'Collisions are tested and `collision` fires.',
        '`step_end` on every instance.',
        'Animation advances `image_index`; `animation_end` fires on a wrap.',
        '`RunService.Heartbeat` fires with the delta.',
        '`RunService.RenderStepped` fires, and the draw buffer is reset.',
        'Tile layers and instances are drawn together in descending depth order, each instance using its `draw` event or its sprite.',
        '`draw_gui` on every instance.',
        'A `room_goto` or `room_restart` requested during the step takes effect now.',
      ],
    },
    {
      heading: 'Fixed timestep',
      text:
        'Steps happen on a fixed clock, not per animation frame: a 144 Hz display still steps ' +
        '60 times a second, so anything counted in steps — alarms, `image_speed`, a counter you ' +
        'increment yourself — runs at the same speed everywhere, and the delta handed to ' +
        '`RunService.Heartbeat` and `task.wait` is a constant `1 / room_speed()`. When the ' +
        'machine falls behind (a hitch, a backgrounded tab) at most three steps run before a ' +
        'frame is drawn and the rest of the backlog is dropped, so the game slows down rather ' +
        'than racing to catch up.',
    },
    {
      heading: 'Depth',
      text:
        'Larger depth draws further back; smaller depth draws in front. Instances at equal ' +
        'depth draw in creation order, oldest first. Tile layers carry a depth too and sort ' +
        'into the same order, so a layer can sit between two sets of objects.',
    },
    {
      heading: 'Destruction is deferred',
      text:
        'A destroyed instance is flagged immediately — its `destroy` event and `Destroying` ' +
        'signal fire straight away, and it stops matching queries — but it is removed from ' +
        'the world at the end of the current phase. Holding a reference to a destroyed instance ' +
        'and reading its fields is safe.',
    },
  ],
};

const instanceFields: DocSection = {
  id: 'instance-fields',
  title: 'Instance fields',
  blurb: 'The built-in fields on every instance. Assign your own freely alongside them.',
  blocks: [
    {
      text:
        '`self` is an ordinary Luau table, so `self.anything = value` works and persists for ' +
        'that instance’s lifetime. The fields below are set up before `create` runs.',
      pythonText:
        '`self` is an ordinary Python object, so `self.anything = value` works and persists ' +
        'for that instance’s lifetime. The fields below are set up before `create` runs.',
    },
  ],
  entries: [
    { name: 'x', summary: 'Position in the room, in pixels.', origin: 'field' },
    { name: 'y', summary: 'Position in the room, in pixels. Y grows downward.', origin: 'field' },
    { name: 'xstart', summary: 'Where the instance was created. Never changed by the engine.', origin: 'field' },
    { name: 'ystart', summary: 'Where the instance was created.', origin: 'field' },
    { name: 'xprevious', summary: 'x at the start of this step, recorded before movement.', origin: 'field' },
    { name: 'yprevious', summary: 'y at the start of this step.', origin: 'field' },
    {
      name: 'hspeed',
      summary: 'Pixels added to x each step. Default 0.',
      detail: 'Applied after every `step` event, so setting it in `step` moves the instance the same frame.',
      origin: 'field',
    },
    { name: 'vspeed', summary: 'Pixels added to y each step. Default 0.', origin: 'field' },
    {
      name: 'gravity',
      summary: 'Speed added along gravity_direction each step. Default 0.',
      origin: 'field',
    },
    {
      name: 'gravity_direction',
      summary: 'Direction gravity pulls, in degrees. Default 270, which is down.',
      origin: 'field',
    },
    {
      name: 'friction',
      summary: 'Speed subtracted from the movement vector each step, never past zero. Default 0.',
      origin: 'field',
    },
    {
      name: 'sprite_index',
      summary: 'Name of the sprite this instance draws, or nil.',
      detail: 'A string, not a handle — `self.sprite_index = "spr_hurt"` is how you swap sprites.',
      origin: 'field',
    },
    {
      name: 'image_index',
      summary: 'Current frame, counted from 0. Fractional values are floored when drawn.',
      origin: 'field',
    },
    {
      name: 'image_speed',
      summary: 'Frames advanced per step. Defaults to the sprite’s frame rate divided by 60.',
      detail: 'Set it to 0 to freeze the animation and drive `image_index` yourself.',
      origin: 'field',
    },
    {
      name: 'image_xscale',
      summary: 'Horizontal scale. Negative flips the sprite; also scales the collision box.',
      origin: 'field',
    },
    { name: 'image_yscale', summary: 'Vertical scale.', origin: 'field' },
    {
      name: 'image_angle',
      summary: 'Rotation in degrees, counter-clockwise, about the sprite’s origin.',
      detail: 'Rotation is visual only — the collision box stays axis-aligned.',
      origin: 'field',
    },
    { name: 'image_alpha', summary: 'Opacity from 0 to 1. Default 1.', origin: 'field' },
    {
      name: 'image_blend',
      summary: 'Colour multiplied into the sprite. Default c_white, which leaves it alone.',
      detail:
        'It is a multiply, so tinting a green sprite red gives black. To fade something out, ' +
        'lower `image_alpha` instead.',
      origin: 'field',
    },
    {
      name: 'visible',
      summary: 'Whether the sprite is drawn automatically. Seeded from the object.',
      detail: 'Ignored if the object defines a `draw` event — that runs regardless.',
      origin: 'field',
    },
    {
      name: 'solid',
      summary: 'A flag seeded from the object. The engine never reads it.',
      origin: 'field',
    },
    {
      name: 'depth',
      summary: 'Draw order. Larger is further back. Seeded from the object; assigning it re-sorts before the next draw.',
      origin: 'field',
    },
    {
      name: 'alarms',
      summary: 'Twelve countdowns, 1 to 12. Set one to a number of steps; -1 is off.',
      detail:
        'Each is decremented once per step and fires the `alarm` event when it hits zero, ' +
        'after which it resets itself to -1. Setting one to 0 does nothing — use 1 for ' +
        '"next step".',
      example: 'self.alarms[2] = room_speed() * 3  -- three seconds',
      pythonExample: 'self.alarms[2] = room_speed() * 3  # three seconds',
      origin: 'field',
    },
    {
      name: 'name',
      summary: 'The instance’s name: the object name unless a room placement or Name sets another.',
      detail:
        'What `find_first_child` and `Workspace:FindFirstChild` match on. Set it in the room ' +
        'editor’s inspector, or write `self.Name = "boss"` at runtime.',
      pythonDetail:
        'What `find_first_child` and `Workspace.FindFirstChild` match on. Set it in the room ' +
        'editor’s inspector, or write `self.Name = "boss"` at runtime.',
      origin: 'field',
    },
    {
      name: 'Name',
      summary: 'The Roblox spelling of name; reading or writing either is the same.',
      origin: 'field',
    },
    {
      name: 'Parent',
      summary: 'The instance this one is parented to, or the Workspace for a root.',
      detail:
        'Assign it to move the instance in the tree; `nil` or `workspace` makes it a root ' +
        'again. Parenting is a naming and ownership structure only — it never moves anything ' +
        '— but a parent takes its children with it when destroyed. Making a cycle raises an ' +
        'error. See *The instance tree*.',
      pythonDetail:
        'Assign it to move the instance in the tree; `None` or `workspace` makes it a root ' +
        'again. Parenting is a naming and ownership structure only — it never moves anything ' +
        '— but a parent takes its children with it when destroyed. Making a cycle raises an ' +
        'error. See *The instance tree*.',
      example: `local shield = instance_create(self.x, self.y, "obj_shield")
shield.Parent = self`,
      pythonExample: `shield = instance_create(self.x, self.y, "obj_shield")
shield.Parent = self`,
      origin: 'field',
    },
    {
      name: 'Destroying',
      summary: 'A Signal fired with the instance when it is destroyed.',
      detail: 'Created the first time you touch it, so it costs nothing on instances that never use it.',
      example: `self.Destroying:Connect(function(inst)
\tprint("gone", inst.x, inst.y)
end)`,
      pythonExample: `def gone(inst):
    print("gone", inst.x, inst.y)

self.Destroying.Connect(gone)`,
      origin: 'field',
    },
    {
      name: 'Collided',
      summary: 'A Signal fired with the other instance on every overlap.',
      detail:
        'An alternative to the `collision` event; connecting to it is enough to opt the ' +
        'instance into collision testing.',
      origin: 'field',
    },
  ],
};

const instanceMethods: DocSection = {
  id: 'instance-methods',
  title: 'Instance methods',
  blurb: 'Called with a colon on an instance: `self:place_meeting(...)`.',
  pythonBlurb: 'Called with a dot on an instance: `self.place_meeting(...)`.',
  entries: [
    {
      name: 'draw_self',
      signature: '()',
      summary: 'Draws this instance’s sprite with its current image_* fields.',
      detail: 'What the engine calls for you when an object has no `draw` event.',
      origin: 'method',
    },
    {
      name: 'destroy',
      signature: '()',
      summary: 'Destroys the instance, firing its destroy event and Destroying signal.',
      detail: 'Safe to call twice. Also available as `Destroy()` for Roblox-style code.',
      origin: 'method',
    },
    {
      name: 'is_a',
      signature: '(name)',
      returns: 'boolean',
      summary: 'True if this instance’s object is name, or descends from it.',
      origin: 'method',
    },
    {
      name: 'get_children',
      signature: '()',
      returns: 'array',
      summary: 'This instance’s live children, oldest first.',
      detail: 'Also available as `GetChildren()`. See *The instance tree*.',
      origin: 'method',
    },
    {
      name: 'get_descendants',
      signature: '()',
      returns: 'array',
      summary: 'Every live instance below this one, parents before their children.',
      detail: 'Also available as `GetDescendants()`.',
      origin: 'method',
    },
    {
      name: 'find_first_child',
      signature: '(name)',
      returns: 'instance or nil',
      summary: 'The first child with that name, or failing that the first child of that object type.',
      detail: 'Direct children only. Also available as `FindFirstChild(name)`.',
      example: `local weapon = self:find_first_child("sword")
if weapon then weapon:destroy() end`,
      pythonExample: `weapon = self.find_first_child("sword")
if weapon:
    weapon.destroy()`,
      origin: 'method',
    },
    {
      name: 'bbox',
      signature: '()',
      returns: 'left, top, right, bottom',
      summary: 'The collision rectangle in room coordinates.',
      detail:
        'Derived from the sprite’s collision rectangle, offset by the origin and scaled by ' +
        '`image_xscale`/`image_yscale`. Never rotated. An instance with no sprite gets a 2×2 ' +
        'box around its position.',
      origin: 'method',
    },
    {
      name: 'place_meeting',
      signature: '(x, y, target)',
      returns: 'boolean',
      summary: 'Would this instance collide if it stood at (x, y)?',
      detail:
        '`target` is an object name — matching children too — or the literal string ' +
        '`"tiles"`, which tests solid tiles on every layer of the room. The instance is not moved.',
      example: `if not self:place_meeting(self.x + 4, self.y, "obj_wall") then
\tself.x += 4
end`,
      pythonExample: `if not self.place_meeting(self.x + 4, self.y, "obj_wall"):
    self.x += 4`,
      origin: 'method',
    },
    {
      name: 'instance_place',
      signature: '(x, y, target)',
      returns: 'instance or nil',
      summary: 'The first instance that would be collided with at (x, y).',
      origin: 'method',
    },
    {
      name: 'instance_place_list',
      signature: '(x, y, target)',
      returns: 'array',
      summary: 'Every instance that would be collided with at (x, y).',
      origin: 'method',
    },
    {
      name: 'move_contact',
      signature: '(target, dx, dy)',
      summary: 'Slides one pixel at a time along (dx, dy), stopping just before a collision.',
      detail:
        'Moves at most the length of (dx, dy). Use it after a blocked move to close the ' +
        'remaining gap so the instance ends up flush against what stopped it.',
      origin: 'method',
    },
    {
      name: 'move_towards_point',
      signature: '(x, y, speed)',
      summary: 'Points hspeed and vspeed at (x, y) at the given speed.',
      detail: 'Sets the speed; it does not stop on arrival.',
      origin: 'method',
    },
    {
      name: 'distance_to_point',
      signature: '(x, y)',
      returns: 'number',
      summary: 'Distance from this instance’s position to a point.',
      origin: 'method',
    },
    {
      name: 'distance_to_object',
      signature: '(other)',
      returns: 'number',
      summary: 'Distance between two instances’ positions.',
      detail: 'Position to position, not edge to edge.',
      origin: 'method',
    },
    {
      name: 'speed',
      signature: '()',
      returns: 'number',
      summary: 'Magnitude of the current hspeed/vspeed vector.',
      origin: 'method',
    },
    {
      name: 'direction',
      signature: '()',
      returns: 'number',
      summary: 'Direction of travel in degrees; 0 when not moving.',
      origin: 'method',
    },
    {
      name: 'set_speed',
      signature: '(magnitude, direction)',
      summary: 'Sets hspeed and vspeed from a speed and an angle in degrees.',
      origin: 'method',
    },
    {
      name: 'sprite_width',
      signature: '()',
      returns: 'number',
      summary: 'The sprite’s width times image_xscale, or 0 with no sprite.',
      origin: 'method',
    },
    {
      name: 'sprite_height',
      signature: '()',
      returns: 'number',
      summary: 'The sprite’s height times image_yscale.',
      origin: 'method',
    },
    {
      name: 'image_number',
      signature: '()',
      returns: 'number',
      summary: 'How many frames the current sprite has.',
      origin: 'method',
    },
  ],
};

const instanceFunctions: DocSection = {
  id: 'instances',
  title: 'Finding and making instances',
  blurb: 'Global functions for creating, destroying and querying instances.',
  blocks: [
    {
      text:
        'Every function that takes an object name also matches objects that descend from it. ' +
        'Queries return instances in no guaranteed order — do not rely on `instance_find` ' +
        'giving you the oldest one.',
    },
  ],
  entries: [
    {
      name: 'instance_create',
      signature: '(x, y, object)',
      returns: 'instance',
      summary: 'Creates an instance and runs its create event immediately.',
      detail: 'Raises an error if no object has that name.',
      origin: 'global',
    },
    {
      name: 'instance_destroy',
      signature: '(instance)',
      summary: 'Destroys an instance. The same as calling instance:destroy().',
      origin: 'global',
    },
    {
      name: 'instance_exists',
      signature: '(object)',
      returns: 'boolean',
      summary: 'True if at least one instance of the object is alive.',
      origin: 'global',
    },
    {
      name: 'instance_number',
      signature: '(object)',
      returns: 'number',
      summary: 'How many instances of the object are alive.',
      origin: 'global',
    },
    {
      name: 'instance_find',
      signature: '(object, index?)',
      returns: 'instance or nil',
      summary: 'The index-th matching instance, counting from 0. Defaults to the first.',
      origin: 'global',
    },
    {
      name: 'instance_list',
      signature: '(object)',
      returns: 'array',
      summary: 'Every matching instance, as an array.',
      origin: 'global',
    },
    {
      name: 'instance_nearest',
      signature: '(x, y, object)',
      returns: 'instance or nil',
      summary: 'The matching instance closest to a point.',
      origin: 'global',
    },
    {
      name: 'collision_point',
      signature: '(x, y, object)',
      returns: 'instance or nil',
      summary: 'A matching instance whose collision box contains the point.',
      example: `local clicked = collision_point(mouse_x(), mouse_y(), "obj_button")
if clicked and mouse_check_button("left") then
\tclicked:press()
end`,
      pythonExample: `clicked = collision_point(mouse_x(), mouse_y(), "obj_button")
if clicked and mouse_check_button("left"):
    clicked.press()`,
      origin: 'global',
    },
  ],
};

const instanceTree: DocSection = {
  id: 'instance-tree',
  title: 'The instance tree',
  blurb: 'Roblox-style parenting: Parent, Instance.new, and the Workspace.',
  blocks: [
    {
      text:
        'Every instance starts as a *root* — a direct child of the Workspace — and stays one ' +
        'unless game code parents it. Parenting is an ownership and naming structure, not a ' +
        'transform: a child keeps its own `x` and `y`. What it buys you is a place to hang ' +
        'related instances (a ship and its turrets, a boss and its health bar) so they can be ' +
        'found by name and destroyed together.',
      code: `function obj.create(self)
	local bar = Instance.new("obj_healthbar", self)
	bar.Name = "health"
end

function obj.step(self)
	local bar = self:find_first_child("health")
	if bar then bar.value = self.health end
end
-- when self is destroyed, the bar goes with it`,
      pythonCode: `def create(self):
    bar = Instance.new("obj_healthbar", self)
    bar.Name = "health"


def step(self):
    bar = self.find_first_child("health")
    if bar:
        bar.value = self.health

# when self is destroyed, the bar goes with it`,
    },
    {
      heading: 'Rules',
      list: [
        '`inst.Parent = other` moves it; `nil` or `workspace` makes it a root again. A cycle raises an error.',
        '`Instance.new(object, parent)` is `instance_create` with the parent set *before* `create` runs, at the parent’s position.',
        'Destroying a parent destroys its descendants, parent first, so the parent’s `destroy` event and `Destroying` signal fire before the children’s.',
        'A persistent child of a non-persistent parent survives a room change as a root; a persistent parent drops any children that did not survive.',
        '`name` defaults to the object name; the room editor’s inspector can set one per placement, and `Name` is the same field.',
        'Names and parents are per instance and per run — the editor’s Explorer view (Roblox style) organises *assets* and is unrelated to this runtime tree.',
      ],
      pythonList: [
        '`inst.Parent = other` moves it; `None` or `workspace` makes it a root again. A cycle raises an error.',
        '`Instance.new(object, parent)` is `instance_create` with the parent set *before* `create` runs, at the parent’s position.',
        'Destroying a parent destroys its descendants, parent first, so the parent’s `destroy` event and `Destroying` signal fire before the children’s.',
        'A persistent child of a non-persistent parent survives a room change as a root; a persistent parent drops any children that did not survive.',
        '`name` defaults to the object name; the room editor’s inspector can set one per placement, and `Name` is the same field.',
        'Names and parents are per instance and per run — the editor’s Explorer view (Roblox style) organises *assets* and is unrelated to this runtime tree.',
      ],
    },
  ],
  entries: [
    {
      name: 'Instance.new',
      signature: '(object, parent?)',
      returns: 'instance',
      summary: 'Creates an instance of the object under parent and runs its create event.',
      detail:
        'The Roblox spelling of `instance_create`. Without a parent the instance is a root at ' +
        '(0, 0); with one it starts at the parent’s position and `self.Parent` is already set ' +
        'inside `create`.',
      origin: 'member',
    },
  ],
};

// ---------------------------------------------------------------------------

const drawing: DocSection = {
  id: 'drawing',
  title: 'Drawing',
  blurb: 'Sprites, shapes and text. Only valid during a draw or draw_gui event.',
  blocks: [
    {
      text:
        'Drawing calls outside a draw event are discarded: the command buffer is cleared after ' +
        'the step events and before drawing begins. Shapes and text use the current colour and ' +
        'alpha; sprites take theirs as arguments.',
    },
    {
      heading: 'The command budget',
      text:
        'A frame holds 8192 draw commands, and anything past that is silently dropped. One ' +
        'sprite, rectangle, line or circle is one command — and so is **each character** of ' +
        '`draw_text`, which is the usual way to hit the limit.',
    },
  ],
  entries: [
    {
      name: 'draw_sprite',
      signature: '(sprite, index, x, y)',
      summary: 'Draws a sprite frame at its natural size.',
      detail: 'The frame index wraps, so passing a step counter animates without any bounds check.',
      origin: 'global',
    },
    {
      name: 'draw_sprite_ext',
      signature: '(sprite, index, x, y, xscale, yscale, angle, colour, alpha)',
      summary: 'Draws a sprite frame scaled, rotated, tinted and faded.',
      detail:
        'Rotation is in degrees, counter-clockwise, about the sprite’s origin. `colour` is ' +
        'multiplied into the pixels, so `c_white` leaves them untouched. Trailing arguments ' +
        'may be nil and fall back to 1, 1, 0, white, 1.',
      origin: 'global',
    },
    {
      name: 'draw_text',
      signature: '(x, y, text, colour?)',
      summary: 'Draws a line of text, using the current colour if none is given.',
      detail:
        'Newlines start a new line at the original x. The built-in font covers printable ASCII ' +
        '(space to `~`); anything else advances half a line height and draws nothing.',
      origin: 'global',
    },
    {
      name: 'draw_text_transformed',
      signature: '(x, y, text, xscale, yscale, angle, colour?)',
      summary: 'Draws text scaled and rotated; big crisp text for titles and menus.',
      detail:
        'Each glyph is a sprite, so this costs the same as draw_text. Scaled text is ' +
        '`string_width(text) * xscale` wide. Angle is degrees counter-clockwise, about (x, y).',
      example: `local title = "READY"
draw_text_transformed(240 - string_width(title) * 3 / 2, 40, title, 3, 3, 0, c_yellow)`,
      pythonExample: `title = "READY"
draw_text_transformed(240 - string_width(title) * 3 / 2, 40, title, 3, 3, 0, c_yellow)`,
      origin: 'global',
    },
    {
      name: 'draw_rectangle',
      signature: '(x1, y1, x2, y2, outline)',
      summary: 'Draws a rectangle in the current colour and alpha.',
      detail: 'Pass true for an outline, false for a filled rectangle.',
      origin: 'global',
    },
    {
      name: 'draw_line',
      signature: '(x1, y1, x2, y2, width?)',
      summary: 'Draws a line. Width defaults to 1.',
      origin: 'global',
    },
    {
      name: 'draw_circle',
      signature: '(x, y, radius, outline)',
      summary: 'Draws a circle, approximated with 24 segments.',
      origin: 'global',
    },
    {
      name: 'draw_set_color',
      signature: '(colour)',
      summary: 'Sets the colour used by shapes and by draw_text without a colour.',
      detail: 'Reset to white at the start of every frame. Does not affect sprites.',
      origin: 'global',
    },
    {
      name: 'draw_get_color',
      signature: '()',
      returns: 'number',
      summary: 'The current draw colour.',
      origin: 'global',
    },
    {
      name: 'draw_set_alpha',
      signature: '(alpha)',
      summary: 'Sets the alpha used by shapes and text, from 0 to 1.',
      detail: 'Reset to 1 at the start of every frame.',
      origin: 'global',
    },
    {
      name: 'string_width',
      signature: '(text)',
      returns: 'number',
      summary: 'Width of the text in pixels; the longest line if it has newlines.',
      origin: 'global',
    },
    {
      name: 'string_height',
      signature: '(text)',
      returns: 'number',
      summary: 'Height in pixels: the line height times the number of lines.',
      example: `local label = "Score: 1200"
draw_set_color(c_black)
draw_rectangle(6, 6, 10 + string_width(label), 10 + string_height(label), false)
draw_text(8, 8, label, c_white)`,
      pythonExample: `label = "Score: 1200"
draw_set_color(c_black)
draw_rectangle(6, 6, 10 + string_width(label), 10 + string_height(label), False)
draw_text(8, 8, label, c_white)`,
      origin: 'global',
    },
  ],
};

const colours: DocSection = {
  id: 'colours',
  title: 'Colours',
  blurb: 'Plain 0xRRGGBB integers, with ten named constants.',
  blocks: [
    {
      text:
        'A colour is an integer, so `0xFF00FF` works anywhere a constant does, and you can ' +
        'compute one arithmetically. The named constants are the PICO-8 palette entries the ' +
        'editor defaults to.',
      code: `local function rgb(r, g, b)
\treturn r * 65536 + g * 256 + b
end

draw_set_color(rgb(255, 128, 0))`,
      pythonCode: `def rgb(r, g, b):
    return r * 65536 + g * 256 + b


draw_set_color(rgb(255, 128, 0))`,
    },
  ],
  entries: [
    { name: 'c_black', summary: '0x000000', origin: 'constant' },
    { name: 'c_white', summary: '0xFFFFFF', origin: 'constant' },
    { name: 'c_red', summary: '0xFF004D', origin: 'constant' },
    { name: 'c_green', summary: '0x00E436', origin: 'constant' },
    { name: 'c_blue', summary: '0x29ADFF', origin: 'constant' },
    { name: 'c_yellow', summary: '0xFFEC27', origin: 'constant' },
    { name: 'c_orange', summary: '0xFFA300', origin: 'constant' },
    { name: 'c_purple', summary: '0x83769C', origin: 'constant' },
    { name: 'c_gray', summary: '0x5F574F', origin: 'constant' },
    { name: 'c_grey', summary: 'The same as c_gray.', origin: 'constant' },
  ],
};

// ---------------------------------------------------------------------------

const rooms: DocSection = {
  id: 'rooms',
  title: 'Rooms and the view',
  blurb: 'Moving between levels, and scrolling what is on screen.',
  blocks: [
    {
      text:
        'A room change requested during a step is applied at the end of that frame, after ' +
        'drawing, so the rest of the step runs normally. Every instance gets `room_end`, ' +
        'non-persistent instances are discarded, the new room’s instances are created, all ' +
        'their `create` events run, and then `room_start` fires on everything alive.',
    },
    {
      heading: 'The view',
      text:
        'The visible area is always the room’s full width and height; `view_set` scrolls ' +
        'that window over a larger world. The canvas is sized to the room, multiplied by the ' +
        'project’s window scale.',
      code: `-- Centre the camera on the player, clamped to the room.
function obj.step_end(self)
\tlocal player = instance_find("obj_player")
\tif not player then return end
\tview_set(
\t\tclamp(player.x - room_width() / 2, 0, room_width()),
\t\tclamp(player.y - room_height() / 2, 0, room_height())
\t)
end`,
      pythonCode: `# Centre the camera on the player, clamped to the room.
def step_end(self):
    player = instance_find("obj_player")
    if not player:
        return
    view_set(
        clamp(player.x - room_width() / 2, 0, room_width()),
        clamp(player.y - room_height() / 2, 0, room_height()),
    )`,
    },
  ],
  entries: [
    {
      name: 'room_goto',
      signature: '(name)',
      summary: 'Switches to another room at the end of this step.',
      detail: 'Raises an error immediately if no room has that name.',
      origin: 'global',
    },
    {
      name: 'room_restart',
      signature: '()',
      summary: 'Reloads the current room at the end of this step.',
      origin: 'global',
    },
    {
      name: 'room_current',
      signature: '()',
      returns: 'string',
      summary: 'The current room’s name.',
      origin: 'global',
    },
    { name: 'room_width', signature: '()', returns: 'number', summary: 'Room width in pixels.', origin: 'global' },
    { name: 'room_height', signature: '()', returns: 'number', summary: 'Room height in pixels.', origin: 'global' },
    {
      name: 'room_speed',
      signature: '()',
      returns: 'number',
      summary: 'The steps per second — 60 unless the project settings say otherwise.',
      detail:
        'Useful for expressing durations in seconds: `room_speed() * 3` is three seconds. The ' +
        'game really does step this many times a second, whatever the display — see *The frame*.',
      origin: 'global',
    },
    {
      name: 'view_set',
      signature: '(x, y)',
      summary: 'Scrolls the visible area to this top-left corner.',
      origin: 'global',
    },
    {
      name: 'view_get',
      signature: '()',
      returns: 'x, y',
      summary: 'The view’s current top-left corner.',
      origin: 'global',
    },
    {
      name: 'view_set_size',
      signature: '(width, height)',
      summary: 'Sets the size of the visible area, for a room larger than the window.',
      detail:
        'The view is the whole room until a game says otherwise, and it resets to the ' +
        'room’s size whenever a room is entered — so set it in `room_start`. The window ' +
        'is sized to the view, and `view_set` scrolls it.',
      example: `function obj.room_start(self)
	view_set_size(480, 288)
end

function obj.step_end(self)
	view_set(clamp(self.x - 140, 0, room_width() - view_width()), 0)
end`,
      pythonExample: `def room_start(self):
    view_set_size(480, 288)


def step_end(self):
    view_set(clamp(self.x - 140, 0, room_width() - view_width()), 0)`,
      origin: 'global',
    },
    {
      name: 'view_width',
      signature: '()',
      returns: 'number',
      summary: 'The width of the visible area, in pixels.',
      origin: 'global',
    },
    {
      name: 'view_height',
      signature: '()',
      returns: 'number',
      summary: 'The height of the visible area, in pixels.',
      origin: 'global',
    },
    {
      name: 'game_end',
      signature: '()',
      summary: 'Stops the game after this frame.',
      origin: 'global',
    },
  ],
};

const tiles: DocSection = {
  id: 'tiles',
  title: 'Tiles',
  blurb: 'Tile layers, solid tiles, and reading or writing the grid at runtime.',
  blocks: [
    {
      text:
        'A tileset is one image cut into a grid; tiles are numbered from 0, left to right and ' +
        'top to bottom. A room holds any number of tile layers, each bound to one tileset, each ' +
        'with its own depth and visibility. A tile value of -1 means empty.',
    },
    {
      heading: 'Solid tiles',
      text:
        'Marking a tile solid in the tileset editor is what makes it block movement. ' +
        '`place_meeting(x, y, "tiles")` tests an instance’s whole collision box against every ' +
        'layer at once, which is how you get terrain collision with no objects involved.',
    },
    {
      heading: 'Layer identifiers',
      text:
        'The `layer` argument is the layer’s id, not its display name. `tilemap_layers()` ' +
        'returns the ids of the current room’s layers, sorted with the furthest back first.',
    },
    {
      heading: 'Editing costs something',
      text:
        'An untouched layer lives in a GPU buffer and costs one draw command per frame however ' +
        'big it is. The first `tilemap_set` on a layer invalidates that, and from then on its ' +
        'visible tiles are sent individually every frame. For a layer you rewrite constantly, ' +
        'consider drawing sprites instead.',
    },
  ],
  entries: [
    {
      name: 'tilemap_get',
      signature: '(layer, tileX, tileY)',
      returns: 'number',
      summary: 'The tile index at a tile coordinate, or -1 if empty or out of bounds.',
      origin: 'global',
    },
    {
      name: 'tilemap_set',
      signature: '(layer, tileX, tileY, index)',
      returns: 'boolean',
      summary: 'Writes a tile. Returns false if the coordinate is outside the layer.',
      detail: 'Pass -1 to clear a cell.',
      origin: 'global',
    },
    {
      name: 'tilemap_get_at',
      signature: '(layer, x, y)',
      returns: 'number',
      summary: 'The tile index at a room position rather than a tile coordinate.',
      origin: 'global',
    },
    {
      name: 'tilemap_layers',
      signature: '()',
      returns: 'array of strings',
      summary: 'The layer ids in the current room.',
      origin: 'global',
    },
    {
      name: 'tile_solid_at',
      signature: '(x, y)',
      returns: 'boolean',
      summary: 'True if a solid tile on any layer covers this room position.',
      example: `-- Dig out the tile under the mouse.
local layer = tilemap_layers()[1]
if layer and mouse_check_button("left") then
\ttilemap_set(layer, math.floor(mouse_x() / 16), math.floor(mouse_y() / 16), -1)
end`,
      pythonExample: `# Dig out the tile under the mouse.
import math

layers = tilemap_layers()
if layers and mouse_check_button("left"):
    tilemap_set(layers[0], math.floor(mouse_x() / 16), math.floor(mouse_y() / 16), -1)`,
      origin: 'global',
    },
  ],
};

// ---------------------------------------------------------------------------

const input: DocSection = {
  id: 'input',
  title: 'Input',
  blurb: 'Keyboard and mouse, sampled once per frame.',
  blocks: [
    {
      heading: 'Key names',
      text:
        'Keys are lowercase strings. Letters and digits are themselves: `"a"`, `"7"`. The rest ' +
        'are `left`, `right`, `up`, `down`, `space`, `enter`, `escape`, `shift`, `ctrl`, `alt`, ' +
        '`tab`, `backspace`, `delete`, `home`, `end`, `pageup`, `pagedown`, `comma`, ' +
        '`period`, `minus`, `equal`, `slash`, `semicolon`, `quote`, `bracketleft`, ' +
        '`bracketright` and `backquote`. Names follow the physical key, so they do not change with the keyboard ' +
        'layout, and left and right modifiers report the same name.',
    },
    {
      heading: 'Focus',
      text:
        'Held keys are cleared when the window loses focus, so nothing sticks down after ' +
        'alt-tabbing. Mouse position is reported in room coordinates whatever the canvas is ' +
        'scaled to.',
    },
  ],
  entries: [
    {
      name: 'keyboard_check',
      signature: '(key)',
      returns: 'boolean',
      summary: 'True for every step the key is held.',
      origin: 'global',
    },
    {
      name: 'keyboard_check_pressed',
      signature: '(key)',
      returns: 'boolean',
      summary: 'True only on the step the key went down.',
      origin: 'global',
    },
    {
      name: 'keyboard_check_released',
      signature: '(key)',
      returns: 'boolean',
      summary: 'True only on the step the key came up.',
      origin: 'global',
    },
    {
      name: 'mouse_check_button',
      signature: '(button?)',
      returns: 'boolean',
      summary: 'True while a mouse button is down. "left" (the default), "right" or "middle".',
      origin: 'global',
    },
    {
      name: 'mouse_check_button_pressed',
      signature: '(button?)',
      returns: 'boolean',
      summary: 'True only on the step the button went down. "left" (the default), "right" or "middle".',
      origin: 'global',
    },
    {
      name: 'mouse_check_button_released',
      signature: '(button?)',
      returns: 'boolean',
      summary: 'True only on the step the button came up.',
      origin: 'global',
    },
    {
      name: 'mouse_x',
      signature: '()',
      returns: 'number',
      summary: 'Mouse x in room coordinates.',
      detail:
        'The view offset is included, so the value compares directly with instance x/y while ' +
        'the view scrolls. Subtract `view_get()` for a position on screen.',
      origin: 'global',
    },
    { name: 'mouse_y', signature: '()', returns: 'number', summary: 'Mouse y in room coordinates.', origin: 'global' },
    {
      name: 'mouse_wheel',
      signature: '()',
      returns: 'number',
      summary: '-1, 0 or 1 for this step’s wheel movement.',
      origin: 'global',
    },
  ],
};

const maths: DocSection = {
  id: 'maths',
  title: 'Maths helpers',
  blurb: 'The usual game-maths shorthand. Luau’s own `math` library is available too.',
  pythonBlurb: 'The usual game-maths shorthand. Python’s own `math` module is available too, after `import math`.',
  entries: [
    {
      name: 'point_distance',
      signature: '(x1, y1, x2, y2)',
      returns: 'number',
      summary: 'Distance between two points.',
      origin: 'global',
    },
    {
      name: 'point_direction',
      signature: '(x1, y1, x2, y2)',
      returns: 'number',
      summary: 'Angle from the first point to the second, in degrees, 0 to 360.',
      detail: 'Counter-clockwise with 0 pointing right, so a target below returns roughly 270.',
      origin: 'global',
    },
    {
      name: 'lengthdir_x',
      signature: '(length, direction)',
      returns: 'number',
      summary: 'The x component of a vector given as a length and an angle.',
      origin: 'global',
    },
    {
      name: 'lengthdir_y',
      signature: '(length, direction)',
      returns: 'number',
      summary: 'The y component. Negated, because y grows downward.',
      example: `-- Fire a bullet along the angle the turret is facing.
local b = instance_create(self.x, self.y, "obj_bullet")
b.hspeed = lengthdir_x(6, self.image_angle)
b.vspeed = lengthdir_y(6, self.image_angle)`,
      pythonExample: `# Fire a bullet along the angle the turret is facing.
b = instance_create(self.x, self.y, "obj_bullet")
b.hspeed = lengthdir_x(6, self.image_angle)
b.vspeed = lengthdir_y(6, self.image_angle)`,
      origin: 'global',
    },
    {
      name: 'clamp',
      signature: '(value, low, high)',
      returns: 'number',
      summary: 'Holds a value between two bounds.',
      origin: 'global',
    },
    {
      name: 'lerp',
      signature: '(a, b, amount)',
      returns: 'number',
      summary: 'Interpolates between a and b. Not clamped.',
      origin: 'global',
    },
    {
      name: 'approach',
      signature: '(value, target, amount)',
      returns: 'number',
      summary: 'Moves value towards target by at most amount, never overshooting.',
      origin: 'global',
    },
    {
      name: 'sign',
      signature: '(value)',
      returns: 'number',
      summary: '-1, 0 or 1.',
      origin: 'global',
    },
    {
      name: 'choose',
      signature: '(...)',
      summary: 'One of its arguments, picked at random.',
      origin: 'global',
    },
    {
      name: 'irandom',
      signature: '(maximum)',
      returns: 'number',
      summary: 'A whole number from 0 to maximum, inclusive at both ends.',
      origin: 'global',
    },
    {
      name: 'irandom_range',
      signature: '(low, high)',
      returns: 'number',
      summary: 'A whole number from low to high, inclusive.',
      origin: 'global',
    },
    {
      name: 'random_range',
      signature: '(low, high)',
      returns: 'number',
      summary: 'A fractional number from low up to high.',
      origin: 'global',
    },
    {
      name: 'angle_difference',
      signature: '(a, b)',
      returns: 'number',
      summary: 'The shortest signed turn from b to a, between -180 and 180.',
      origin: 'global',
    },
    {
      name: 'wrap',
      signature: '(value, low, high)',
      returns: 'number',
      summary: 'Wraps a value into a range, so it reappears at the other end.',
      origin: 'global',
    },
  ],
};

// ---------------------------------------------------------------------------

const signals: DocSection = {
  id: 'signals',
  title: 'Signals',
  blurb: 'Roblox-style events, for your own code and for the engine’s.',
  blocks: [
    {
      text:
        '`Signal.new()` makes one. Connecting returns a Connection you can disconnect. Handlers ' +
        'are called in the order they connected, and a handler may safely disconnect itself or ' +
        'others while the signal is firing.',
      code: `local died = Signal.new()

local connection = died:Connect(function(who)
\tprint(who, "died")
end)

died:Fire("the hero")
connection:Disconnect()`,
      pythonCode: `died = Signal.new()

def on_died(who):
    print(who, "died")

connection = died.Connect(on_died)

died.Fire("the hero")
connection.Disconnect()`,
    },
    {
      text:
        'Every instance also carries `Destroying` and `Collided` signals, created on first use. ' +
        'Method names have lowercase aliases (`connect`, `once`, `fire`, `wait`, `disconnect`) ' +
        'if you prefer the engine’s snake_case style.',
    },
  ],
  entries: [
    {
      name: 'Signal.new',
      signature: '()',
      returns: 'Signal',
      summary: 'Creates a signal.',
      origin: 'member',
    },
    {
      name: 'Connect',
      signature: '(handler)',
      returns: 'Connection',
      summary: 'Calls handler every time the signal fires.',
      detail: 'Raises an error if handler is not a function.',
      origin: 'member',
    },
    {
      name: 'Once',
      signature: '(handler)',
      returns: 'Connection',
      summary: 'Calls handler on the next fire only, then disconnects.',
      origin: 'member',
    },
    {
      name: 'Fire',
      signature: '(...)',
      summary: 'Calls every connected handler with these arguments.',
      origin: 'member',
    },
    {
      name: 'Wait',
      signature: '()',
      summary: 'Yields until the next fire, and returns what it was fired with.',
      detail: 'Only works on a coroutine — call it inside `task.spawn` or `task.delay`.',
      origin: 'member',
    },
    {
      name: 'DisconnectAll',
      signature: '()',
      summary: 'Drops every handler and every waiting thread.',
      origin: 'member',
    },
    {
      name: 'Disconnect',
      signature: '()',
      summary: 'On a Connection: stops it receiving anything further.',
      origin: 'member',
    },
  ],
};

const tasks: DocSection = {
  id: 'task',
  title: 'task',
  blurb: 'Coroutines on the engine’s clock, for code that has to wait.',
  blocks: [
    {
      text:
        'The scheduler is pumped once per frame with the real frame delta, before any step ' +
        'event. Waits are therefore accurate to a frame, and a wait shorter than one frame ' +
        'still costs a frame.',
      pythonText:
        'The scheduler is pumped once per frame with the real frame delta, before any step ' +
        'event. Waits are therefore accurate to a frame, and a wait shorter than one frame ' +
        'still costs a frame. In Python only an `async def` can wait: pass one to `task.spawn` ' +
        'and write `await task.wait(seconds)` inside it. A plain `def` cannot wait, because ' +
        '`await` is only legal inside `async def`.',
      code: `function obj.create(self)
\ttask.spawn(function()
\t\tfor i = 3, 1, -1 do
\t\t\tself.countdown = i
\t\t\ttask.wait(1)
\t\tend
\t\tself.countdown = nil
\t\troom_goto("rm_level2")
\tend)
end`,
      pythonCode: `def create(self):
    async def countdown():
        for i in range(3, 0, -1):
            self.countdown = i
            await task.wait(1)
        self.countdown = None
        room_goto("rm_level2")

    task.spawn(countdown)`,
    },
    {
      text:
        'An error inside a scheduled thread propagates out and stops the game, the same as an ' +
        'error in a step event.',
    },
  ],
  entries: [
    {
      name: 'task.spawn',
      signature: '(fn, ...)',
      returns: 'thread',
      summary: 'Runs fn immediately on its own coroutine, so it may yield.',
      detail: 'Accepts an existing coroutine instead of a function.',
      pythonDetail:
        'Pass an `async def` when the function needs to `await task.wait(...)`; a plain `def` ' +
        'runs to completion on the spot.',
      origin: 'member',
    },
    {
      name: 'task.wait',
      signature: '(seconds)',
      returns: 'number',
      summary: 'Yields the current coroutine for at least this long.',
      detail: 'Errors if called outside a coroutine. Also available as the global `wait`.',
      pythonDetail:
        'Must be awaited — `await task.wait(1)` — inside an `async def` started by ' +
        '`task.spawn` or `task.delay`. A plain function cannot wait.',
      origin: 'member',
    },
    {
      name: 'task.delay',
      signature: '(seconds, fn, ...)',
      summary: 'Runs fn on its own coroutine after a delay.',
      origin: 'member',
    },
    {
      name: 'task.defer',
      signature: '(fn, ...)',
      summary: 'Runs fn on the next frame.',
      origin: 'member',
    },
    {
      name: 'task.cancel',
      signature: '(thread)',
      summary: 'Removes a thread from the queue so it never resumes.',
      origin: 'member',
    },
  ],
};

const services: DocSection = {
  id: 'services',
  title: 'Services',
  blurb: 'game:GetService("...") — the Roblox-shaped half of the API.',
  pythonBlurb: 'game.GetService("...") — the Roblox-shaped half of the API.',
  blocks: [
    {
      text:
        'Services are also plain globals, so `RunService.Heartbeat` works without fetching it ' +
        'first. `GetService` raises a helpful error for an unknown name, and a distinct one if ' +
        'you forget the quotes — an unquoted name is a nil global, which is otherwise a ' +
        'confusing failure.',
      pythonText:
        'Services are also plain globals, so `RunService.Heartbeat` works without fetching it ' +
        'first. `GetService` takes the name as a string and raises a helpful error for an ' +
        'unknown one — including the service object itself, which is what ' +
        '`game.GetService(RunService)` without quotes passes.',
      code: 'local RunService = game:GetService("RunService")',
      pythonCode: 'RunService = game.GetService("RunService")',
    },
    {
      heading: 'The seven services',
      table: {
        head: ['Service', 'For'],
        rows: [
          ['`RunService`', 'Per-frame signals.'],
          ['`UserInputService`', 'Input signals and polling.'],
          ['`ReplicatedStorage`', 'Shared values, with a change signal.'],
          ['`DataStoreService`', 'Saves that survive a reload.'],
          ['`HttpService`', 'JSON encoding and GUIDs.'],
          ['`ScriptService`', 'Modules from the project’s scripts folder.'],
          ['`Workspace`', 'The instance tree.'],
        ],
      },
    },
  ],
  entries: [
    {
      name: 'game.GetService',
      signature: '(name)',
      summary: 'Returns a service by name, or raises an error listing the valid ones.',
      origin: 'member',
    },
    {
      name: 'game.FindService',
      signature: '(name)',
      summary: 'The same, but returns nil instead of raising.',
      origin: 'member',
    },
    {
      name: 'game.GetServices',
      signature: '()',
      returns: 'array of strings',
      summary: 'Every service name, sorted.',
      origin: 'member',
    },
    {
      name: 'RunService.Heartbeat',
      summary: 'Signal fired once per frame after the step events, with the delta in seconds.',
      origin: 'member',
    },
    {
      name: 'RunService.Stepped',
      summary: 'Signal fired before the step events, with the delta.',
      origin: 'member',
    },
    {
      name: 'RunService.RenderStepped',
      summary: 'Signal fired just before drawing, with the delta.',
      origin: 'member',
    },
    {
      name: 'RunService.IsRunning',
      signature: '()',
      summary: 'Always true while a game is playing.',
      origin: 'member',
    },
    {
      name: 'UserInputService.InputBegan',
      summary: 'Signal fired for each key pressed, with { KeyCode, UserInputType }.',
      example: `UserInputService.InputBegan:Connect(function(input)
\tif input.KeyCode == "r" then
\t\troom_restart()
\tend
end)`,
      pythonExample: `def on_input(input):
    if input.KeyCode == "r":
        room_restart()

UserInputService.InputBegan.Connect(on_input)`,
      origin: 'member',
    },
    {
      name: 'UserInputService.InputEnded',
      summary: 'Signal fired for each key released.',
      origin: 'member',
    },
    {
      name: 'UserInputService.IsKeyDown',
      signature: '(key)',
      returns: 'boolean',
      summary: 'The same as keyboard_check.',
      origin: 'member',
    },
    {
      name: 'UserInputService.GetMouseLocation',
      signature: '()',
      returns: 'x, y',
      summary: 'The mouse position in room coordinates.',
      origin: 'member',
    },
    {
      name: 'UserInputService.IsMouseButtonPressed',
      signature: '(button)',
      returns: 'boolean',
      summary: 'The same as mouse_check_button.',
      origin: 'member',
    },
    {
      name: 'Workspace.GetChildren',
      signature: '()',
      returns: 'array',
      summary: 'Every root instance: those not parented to another instance.',
      detail: 'In a game that never sets `Parent`, that is every live instance.',
      origin: 'member',
    },
    {
      name: 'Workspace.GetDescendants',
      signature: '()',
      returns: 'array',
      summary: 'Every live instance, at any depth of the tree.',
      origin: 'member',
    },
    {
      name: 'Workspace.FindFirstChild',
      signature: '(name)',
      returns: 'instance or nil',
      summary: 'A root instance with that name, or failing that any instance of the object called that.',
      origin: 'member',
    },
    {
      name: 'Workspace.CountOf',
      signature: '(objectName)',
      returns: 'number',
      summary: 'How many instances of that object are alive.',
      origin: 'member',
    },
    {
      name: 'Workspace.GetPartsInRegion',
      signature: '(x1, y1, x2, y2)',
      returns: 'array',
      summary: 'Every instance whose collision box overlaps the rectangle.',
      origin: 'member',
    },
    {
      name: 'HttpService.JSONEncode',
      signature: '(value)',
      returns: 'string',
      summary: 'Encodes a table, number, string or boolean as JSON.',
      detail:
        'Object keys must be strings. NaN and infinity raise an error rather than producing ' +
        'invalid JSON.',
      origin: 'member',
    },
    {
      name: 'HttpService.JSONDecode',
      signature: '(text)',
      summary: 'Parses JSON. Raises an error if the text is malformed.',
      origin: 'member',
    },
    {
      name: 'HttpService.GenerateGUID',
      signature: '()',
      returns: 'string',
      summary: 'A random identifier.',
      origin: 'member',
    },
  ],
};

const storage: DocSection = {
  id: 'storage',
  title: 'Saving and shared values',
  blurb: 'ReplicatedStorage for the session, DataStoreService for the disk.',
  blocks: [
    {
      text:
        '`ReplicatedStorage` is a shared table that lives as long as the run — a tidy way ' +
        'for unrelated objects to agree on the score without one of them owning it. ' +
        '`DataStoreService` writes through to the browser’s local storage, so its values ' +
        'survive a reload.',
      code: `local DataStoreService = game:GetService("DataStoreService")
local saves = DataStoreService:GetDataStore("scores")

-- GetAsync returns the default when nothing was ever saved.
local best = saves:GetAsync("best", 0)
if self.score > best then
\tsaves:SetAsync("best", self.score)
end`,
      pythonCode: `DataStoreService = game.GetService("DataStoreService")
saves = DataStoreService.GetDataStore("scores")

# GetAsync returns the default when nothing was ever saved.
best = saves.GetAsync("best", 0)
if self.score > best:
    saves.SetAsync("best", self.score)`,
    },
    {
      text:
        'Values are stored as JSON, so tables, numbers, strings and booleans all round-trip. ' +
        'Corrupt or missing data falls back to the default you pass rather than raising, which ' +
        'matters here because this engine’s `pcall` cannot catch errors.',
      pythonText:
        'Values are stored as JSON, so dicts, lists, numbers, strings and booleans all ' +
        'round-trip. Corrupt or missing data falls back to the default you pass rather than ' +
        'raising, so there is nothing to wrap in `try`.',
    },
  ],
  entries: [
    {
      name: 'ReplicatedStorage.Set',
      signature: '(key, value)',
      summary: 'Stores a value for this run and fires Changed.',
      detail: 'Also spelled `SetAttribute`.',
      origin: 'member',
    },
    {
      name: 'ReplicatedStorage.Get',
      signature: '(key, default)',
      summary: 'Reads a value, or the default if it was never set.',
      detail: 'Also spelled `GetAttribute`.',
      origin: 'member',
    },
    {
      name: 'ReplicatedStorage.GetAttributes',
      signature: '()',
      returns: 'table',
      summary: 'A copy of everything stored.',
      origin: 'member',
    },
    {
      name: 'ReplicatedStorage.ClearAllAttributes',
      signature: '()',
      summary: 'Empties the store.',
      origin: 'member',
    },
    {
      name: 'ReplicatedStorage.Changed',
      summary: 'Signal fired with (key, value) whenever a value is set.',
      origin: 'member',
    },
    {
      name: 'DataStoreService.GetDataStore',
      signature: '(name)',
      returns: 'DataStore',
      summary: 'Opens a named store, creating it if needed.',
      origin: 'member',
    },
    {
      name: 'SetAsync',
      signature: '(key, value)',
      summary: 'Writes a value, and returns it.',
      origin: 'member',
    },
    {
      name: 'GetAsync',
      signature: '(key, default)',
      summary: 'Reads a value, falling back to default if missing or unreadable.',
      origin: 'member',
    },
    {
      name: 'RemoveAsync',
      signature: '(key)',
      summary: 'Deletes a value and returns what it was.',
      origin: 'member',
    },
    {
      name: 'IncrementAsync',
      signature: '(key, delta)',
      returns: 'number',
      summary: 'Adds to a stored number, defaulting the delta to 1.',
      origin: 'member',
    },
    {
      name: 'UpdateAsync',
      signature: '(key, transform)',
      summary: 'Reads a value, passes it through transform, writes the result back.',
      origin: 'member',
    },
  ],
};

const scripts: DocSection = {
  id: 'scripts',
  title: 'Shared scripts',
  blurb: 'Code that more than one object needs.',
  blocks: [
    {
      text:
        'Everything under SCRIPTS runs once, in name order, before any object script is loaded. ' +
        'There are two ways to use one.',
    },
    {
      heading: 'As a module',
      text: 'Return a table and pull it in with `require`.',
      pythonText: 'Define functions at the top level and pull the module in with `require`.',
      code: `-- scripts/enemies.luau
local enemies = {}

function enemies.spawn(x, y)
\treturn instance_create(x, y, choose("obj_bat", "obj_slime"))
end

return enemies

-- in an object
local enemies = require("enemies")
enemies.spawn(120, 64)`,
      pythonCode: `# scripts/enemies.py
def spawn(x, y):
    return instance_create(x, y, choose("obj_bat", "obj_slime"))


# in an object
enemies = require("enemies")
enemies.spawn(120, 64)`,
    },
    {
      heading: 'As globals',
      text:
        'A script that assigns globals makes them visible to every object with no `require` at ' +
        'all. Handy for a handful of helpers; a module is clearer once there are more than a ' +
        'few.',
      pythonText:
        'A Python script is a module, so its top-level names belong to it rather than to every ' +
        'object: reach a helper with `helpers = require("helpers")` and `helpers.grid_snap(...)`. ' +
        'Keep small helpers together in one module rather than relying on globals.',
      code: `-- scripts/helpers.luau
function grid_snap(value, size)
\treturn math.floor(value / size) * size
end`,
      pythonCode: `# scripts/helpers.py
import math


def grid_snap(value, size):
    return math.floor(value / size) * size`,
    },
  ],
  entries: [
    {
      name: 'require',
      signature: '(name)',
      summary: 'Returns what the named script returned. Errors if there is no such script.',
      origin: 'global',
    },
    {
      name: 'ScriptService.Require',
      signature: '(name)',
      summary: 'What require calls.',
      origin: 'member',
    },
    {
      name: 'ScriptService.FindFirstChild',
      signature: '(name)',
      summary: 'The module, or nil if there is no such script.',
      origin: 'member',
    },
    {
      name: 'ScriptService.GetScripts',
      signature: '()',
      returns: 'array of strings',
      summary: 'Every script name, sorted.',
      origin: 'member',
    },
  ],
};

// ---------------------------------------------------------------------------

const gotchas: DocSection = {
  id: 'gotchas',
  title: 'Things that will catch you out',
  blurb: 'Places where this engine is not quite Lua, or not quite GameMaker.',
  blocks: [
    {
      heading: 'pcall does not catch',
      text:
        'In this Luau build an error inside `pcall` propagates out to the host anyway and stops ' +
        'the game. Do not use it for control flow. Where the engine needs to survive bad data ' +
        '— reading a corrupt save, for instance — it checks the data instead of catching ' +
        'the failure, and you should too.',
      pythonText:
        'That is a Luau limitation; Python’s `try`/`except` works as usual. The advice still ' +
        'stands, though: where the engine needs to survive bad data — reading a corrupt save, ' +
        'for instance — it checks the data instead of catching the failure, and so should you.',
    },
    {
      heading: '_G is read-only',
      text:
        'Assign a plain global instead: `my_value = 1` at the top level of a shared script is ' +
        'visible everywhere.',
      pythonText:
        'Python has no `_G`, and a shared script’s top-level names stay inside its module. ' +
        'Share a value through `ReplicatedStorage`, or through a module loaded with `require`.',
    },
    {
      heading: 'GetService needs quotes',
      text:
        '`game:GetService(RunService)` passes a nil global, not a name. The engine detects this ' +
        'exact mistake and says so, but it is worth knowing why.',
      pythonText:
        '`game.GetService(RunService)` passes the service object, not its name. Quote it: ' +
        '`game.GetService("RunService")` — or just use the global `RunService` directly.',
    },
    {
      heading: 'Collision events see everything',
      text:
        'A `collision` event fires for every overlapping instance regardless of object, so ' +
        'always filter with `other:is_a(...)`.',
      pythonText:
        'A `collision` event fires for every overlapping instance regardless of object, so ' +
        'always filter with `other.is_a(...)`.',
    },
    {
      heading: 'draw_gui is not screen space',
      text:
        'It draws last, but in room coordinates. Offset by `view_get()` if the view scrolls.',
    },
    {
      heading: 'Tinting multiplies',
      text:
        '`image_blend` and the colour argument of `draw_sprite_ext` multiply into the sprite, ' +
        'so tinting a green sprite red gives black. Use `image_alpha` to fade.',
    },
    {
      heading: 'Rotation does not rotate collisions',
      text: '`image_angle` is visual. The collision box stays axis-aligned.',
    },
    {
      heading: 'Drawing only counts inside a draw event',
      text:
        'The command buffer is cleared after the step events, so a `draw_text` call from `step` ' +
        'is thrown away.',
    },
    {
      heading: 'Text is not free',
      text:
        'Every character is one of the frame’s 8192 draw commands, and the font covers ' +
        'printable ASCII only.',
    },
  ],
};

const performance: DocSection = {
  id: 'performance',
  title: 'How the engine works',
  blurb: 'Why the API is written in Luau, and what that buys.',
  pythonBlurb: 'Why the API lives inside the VM, and what that buys.',
  blocks: [
    {
      text:
        'A call from Luau out to JavaScript across the WebAssembly boundary costs roughly 90 to ' +
        '160 microseconds. At 60 frames a second the whole budget is 16.6 milliseconds, so a ' +
        'few hundred per-sprite callbacks would spend it several times over.',
      pythonText:
        'A call from the VM out to JavaScript across the WebAssembly boundary costs roughly 90 ' +
        'to 160 microseconds. At 60 frames a second the whole budget is 16.6 milliseconds, so ' +
        'a few hundred per-sprite callbacks would spend it several times over.',
    },
    {
      text:
        'So the boundary is crossed **once per frame**. The host calls `__frame(input, dt)`; ' +
        'events, movement, collision and the entire drawing API run inside the VM; and the ' +
        'frame comes back as one string of draw commands plus a little metadata. That is why ' +
        '`prelude.luau` is the engine rather than a thin wrapper over host functions.',
      pythonText:
        'So the boundary is crossed **once per frame**. The host calls one frame function; ' +
        'events, movement, collision and the entire drawing API run inside the VM; and the ' +
        'frame comes back as one string of draw commands plus a little metadata. That is why ' +
        '`prelude.py` — a function-for-function mirror of `prelude.luau` — is the engine ' +
        'rather than a thin wrapper over host functions.',
    },
    {
      heading: 'Why base64',
      text:
        'The host’s string channel is UTF-8 decoded, which replaces any byte above 127 with ' +
        'a replacement character and quietly corrupts binary. Commands are packed into a float ' +
        'buffer and base64-encoded, so every byte that crosses is ASCII.',
    },
    {
      heading: 'One texture, one shader',
      text:
        'Every sprite frame, every tile and every glyph is packed into a single atlas at load ' +
        'time, so a frame is one shader, one texture bind and a handful of buffer uploads. ' +
        'Sprites, shapes and text all batch together.',
    },
    {
      heading: 'Static tile layers',
      text:
        'A full-screen tile layer is around 540 tiles; sending those as quads every frame cost ' +
        'nearly 9 milliseconds in encoding alone. Layers are instead uploaded to their own GPU ' +
        'buffer once, and the frame carries a single marker command that keeps them correctly ' +
        'ordered against the instances around them. Layers above 40,000 tiles, and any layer ' +
        'edited with `tilemap_set`, fall back to streaming their visible tiles.',
    },
    {
      heading: 'One VM per session',
      text:
        'Pressing Play does not build a new virtual machine; it resets the existing one. That ' +
        'makes a re-run nearly instant, and avoids a bug in the Luau WebAssembly build where ' +
        'destroying a VM that has run a few dozen frames corrupts the next one.',
      pythonText:
        'Pressing Play does not build a new interpreter; it resets the existing one, so a ' +
        're-run is nearly instant.',
    },
  ],
};

const projectFormat: DocSection = {
  id: 'project-format',
  title: 'Project format',
  blurb: 'What Save writes to disk.',
  blocks: [
    {
      text:
        'A saved project is a folder of plain files, so it diffs and merges in version control. ' +
        'Sprite pixels ride along as base64 PNG, one per frame.',
      code: `benseditor.json          the project: name, start room, window size
sprites/spr_hero.bsprite
tilesets/ts_stone.btileset
objects/obj_hero.bobject  properties: sprite, depth, parent, flags
objects/obj_hero.luau     behaviour, beside its properties
rooms/rm_main.broom       size, background, instances, tile layers
scripts/helpers.luau`,
      pythonCode: `benseditor.json          the project: name, start room, window size, language
sprites/spr_hero.bsprite
tilesets/ts_stone.btileset
objects/obj_hero.bobject  properties: sprite, depth, parent, flags
objects/obj_hero.py       behaviour, beside its properties
rooms/rm_main.broom       size, background, instances, tile layers
scripts/helpers.py`,
    },
    {
      text:
        'Every file but the `.luau` sources is JSON. Tile layers store one integer per cell, ' +
        'row-major, with -1 for empty. **Export project** is the same data as a single JSON ' +
        'file, for browsers that cannot open folders.',
      pythonText:
        'Every file but the `.py` sources is JSON. Tile layers store one integer per cell, ' +
        'row-major, with -1 for empty. **Export project** is the same data as a single JSON ' +
        'file, for browsers that cannot open folders.',
    },
  ],
};

// ---------------------------------------------------------------------------

export const DOCS: DocChapter[] = [
  { title: 'Start here', sections: [overview, firstGame, editorTour, pythonMode, blockMode, runningExporting] },
  {
    title: 'Scripting',
    sections: [objects, frameOrder, instanceFields, instanceMethods, instanceFunctions, instanceTree],
  },
  { title: 'Drawing', sections: [drawing, colours] },
  { title: 'The world', sections: [rooms, tiles] },
  { title: 'Input and maths', sections: [input, maths] },
  { title: 'Services', sections: [signals, tasks, services, storage, scripts] },
  { title: 'Reference', sections: [gotchas, performance, projectFormat] },
];

/** Flat list, for search and for the drift test. */
export const ALL_SECTIONS: DocSection[] = DOCS.flatMap((chapter) => chapter.sections);

export const ALL_ENTRIES: DocEntry[] = ALL_SECTIONS.flatMap((section) => section.entries ?? []);
