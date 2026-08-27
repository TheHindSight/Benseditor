/**
 * The engine API surface, described once.
 *
 * Drives both syntax highlighting and autocomplete, so the two can never
 * disagree about what the engine actually provides. Signatures are kept in
 * step with `src/luau/prelude.luau`.
 *
 * Descriptions are not written here: they come from the manual in
 * `docsData.ts`, so the line the completion popup shows is the same sentence
 * the Docs tab shows.
 *
 * Nothing in this file is tied to Luau's syntax -- the tables are the engine's
 * names, which every scripting language it grows offers the same way. The
 * Luau keywords, builtins and member semantics live in `luauApi.ts`.
 */
import { ALL_ENTRIES } from './docsData';

export type CompletionKind = 'keyword' | 'function' | 'method' | 'field' | 'constant' | 'local' | 'asset';

export interface ApiEntry {
  name: string;
  kind: CompletionKind;
  /** Shown dimmed beside the name, e.g. `(x, y, object)`. */
  signature?: string;
  doc?: string;
}

// Events are excluded: `destroy` is both an event you define and a method you
// call, and it is the method a completion after `:` is describing.
const MANUAL = new Map(
  ALL_ENTRIES.filter((entry) => entry.origin !== 'event').map((entry) => [entry.name, entry.summary]),
);

/**
 * Take each entry's description from the manual.
 *
 * The manual wins over any `doc` written here, so the popup and the Docs tab
 * cannot say different things about the same name. A local `doc` is the
 * fallback for the handful of aliases the manual does not list separately.
 *
 * `owner` is the receiver these members hang off, because the manual spells
 * them out in full -- `task.spawn`, not `spawn`.
 */
export function documented(entries: ApiEntry[], owner?: string): ApiEntry[] {
  return entries.map((entry) => ({
    ...entry,
    doc: (owner ? MANUAL.get(`${owner}.${entry.name}`) : undefined) ?? MANUAL.get(entry.name) ?? entry.doc,
  }));
}

export const COLOURS = [
  'c_black', 'c_white', 'c_red', 'c_green', 'c_blue',
  'c_yellow', 'c_orange', 'c_purple', 'c_gray', 'c_grey',
];

export const ENGINE_FUNCTIONS: ApiEntry[] = documented([
  // instances
  { name: 'instance_create', kind: 'function', signature: '(x, y, object)', doc: 'Create an instance and run its create event. Returns it.' },
  { name: 'instance_destroy', kind: 'function', signature: '(instance)', doc: 'Destroy an instance.' },
  { name: 'instance_exists', kind: 'function', signature: '(object)', doc: 'True if any instance of the object exists.' },
  { name: 'instance_number', kind: 'function', signature: '(object)', doc: 'How many instances of the object exist.' },
  { name: 'instance_find', kind: 'function', signature: '(object, index?)', doc: 'The index-th instance, or nil.' },
  { name: 'instance_list', kind: 'function', signature: '(object)', doc: 'Array of every matching instance.' },
  { name: 'instance_nearest', kind: 'function', signature: '(x, y, object)', doc: 'Closest instance to a point.' },
  { name: 'collision_point', kind: 'function', signature: '(x, y, object)', doc: 'Instance whose box contains the point.' },

  // rooms and game
  { name: 'room_goto', kind: 'function', signature: '(name)', doc: 'Switch rooms at the end of this step.' },
  { name: 'room_restart', kind: 'function', signature: '()', doc: 'Reload the current room.' },
  { name: 'room_current', kind: 'function', signature: '()', doc: 'Name of the current room.' },
  { name: 'room_width', kind: 'function', signature: '()' },
  { name: 'room_height', kind: 'function', signature: '()' },
  { name: 'room_speed', kind: 'function', signature: '()', doc: 'Steps per second.' },
  { name: 'game_end', kind: 'function', signature: '()', doc: 'Stop the game.' },
  { name: 'view_set', kind: 'function', signature: '(x, y)', doc: 'Scroll the visible area.' },
  { name: 'view_get', kind: 'function', signature: '()', doc: 'Returns x, y of the view.' },

  // input
  { name: 'keyboard_check', kind: 'function', signature: '(key)', doc: 'True while the key is held. e.g. "left", "space", "a".' },
  { name: 'keyboard_check_pressed', kind: 'function', signature: '(key)', doc: 'True on the step the key went down.' },
  { name: 'keyboard_check_released', kind: 'function', signature: '(key)', doc: 'True on the step the key came up.' },
  { name: 'mouse_check_button', kind: 'function', signature: '(button?)', doc: '"left", "right" or "middle".' },
  { name: 'mouse_x', kind: 'function', signature: '()' },
  { name: 'mouse_y', kind: 'function', signature: '()' },
  { name: 'mouse_wheel', kind: 'function', signature: '()', doc: '-1, 0 or 1 this step.' },

  // drawing
  { name: 'draw_sprite', kind: 'function', signature: '(sprite, index, x, y)' },
  { name: 'draw_sprite_ext', kind: 'function', signature: '(sprite, index, x, y, xscale, yscale, angle, colour, alpha)' },
  { name: 'draw_text', kind: 'function', signature: '(x, y, text, colour?)' },
  { name: 'draw_rectangle', kind: 'function', signature: '(x1, y1, x2, y2, outline)' },
  { name: 'draw_line', kind: 'function', signature: '(x1, y1, x2, y2, width?)' },
  { name: 'draw_circle', kind: 'function', signature: '(x, y, radius, outline)' },
  { name: 'draw_set_color', kind: 'function', signature: '(colour)' },
  { name: 'draw_set_alpha', kind: 'function', signature: '(alpha)' },
  { name: 'draw_get_color', kind: 'function', signature: '()' },
  { name: 'string_width', kind: 'function', signature: '(text)' },
  { name: 'string_height', kind: 'function', signature: '(text)' },

  // tiles
  { name: 'tilemap_get', kind: 'function', signature: '(layer, tileX, tileY)', doc: 'Tile index, or -1 for empty.' },
  { name: 'tilemap_set', kind: 'function', signature: '(layer, tileX, tileY, index)' },
  { name: 'tilemap_get_at', kind: 'function', signature: '(layer, x, y)', doc: 'Same, but by room position.' },
  { name: 'tilemap_layers', kind: 'function', signature: '()', doc: 'Layer ids in the current room.' },
  { name: 'tile_solid_at', kind: 'function', signature: '(x, y)', doc: 'True if a solid tile covers this point.' },

  // maths
  { name: 'point_distance', kind: 'function', signature: '(x1, y1, x2, y2)' },
  { name: 'point_direction', kind: 'function', signature: '(x1, y1, x2, y2)', doc: 'Degrees counter-clockwise, 0 = right.' },
  { name: 'lengthdir_x', kind: 'function', signature: '(length, direction)' },
  { name: 'lengthdir_y', kind: 'function', signature: '(length, direction)' },
  { name: 'clamp', kind: 'function', signature: '(value, low, high)' },
  { name: 'lerp', kind: 'function', signature: '(a, b, amount)' },
  { name: 'approach', kind: 'function', signature: '(value, target, amount)' },
  { name: 'sign', kind: 'function', signature: '(value)' },
  { name: 'choose', kind: 'function', signature: '(...)' },
  { name: 'irandom', kind: 'function', signature: '(maximum)', doc: '0 to maximum inclusive.' },
  { name: 'irandom_range', kind: 'function', signature: '(low, high)' },
  { name: 'random_range', kind: 'function', signature: '(low, high)' },
  { name: 'angle_difference', kind: 'function', signature: '(a, b)' },
  { name: 'wrap', kind: 'function', signature: '(value, low, high)' },
]);

export const INSTANCE_METHODS: ApiEntry[] = documented([
  { name: 'draw_self', kind: 'method', signature: '()', doc: 'Draw this instance with its current image_* values.' },
  { name: 'destroy', kind: 'method', signature: '()' },
  { name: 'is_a', kind: 'method', signature: '(name)', doc: 'True if this object is name, or descends from it.' },
  { name: 'get_children', kind: 'method', signature: '()' },
  { name: 'get_descendants', kind: 'method', signature: '()' },
  { name: 'find_first_child', kind: 'method', signature: '(name)' },
  { name: 'bbox', kind: 'method', signature: '()', doc: 'Returns left, top, right, bottom.' },
  { name: 'place_meeting', kind: 'method', signature: '(x, y, object)', doc: 'Would it collide if moved here? Pass "tiles" for solid tiles.' },
  { name: 'instance_place', kind: 'method', signature: '(x, y, object)', doc: 'The instance it would collide with, or nil.' },
  { name: 'instance_place_list', kind: 'method', signature: '(x, y, object)', doc: 'Every overlapping instance.' },
  { name: 'move_contact', kind: 'method', signature: '(object, dx, dy)', doc: 'Slide until just before a collision.' },
  { name: 'move_towards_point', kind: 'method', signature: '(x, y, speed)' },
  { name: 'distance_to_point', kind: 'method', signature: '(x, y)' },
  { name: 'distance_to_object', kind: 'method', signature: '(other)' },
  { name: 'speed', kind: 'method', signature: '()' },
  { name: 'direction', kind: 'method', signature: '()' },
  { name: 'set_speed', kind: 'method', signature: '(magnitude, direction)' },
  { name: 'sprite_width', kind: 'method', signature: '()' },
  { name: 'sprite_height', kind: 'method', signature: '()' },
  { name: 'image_number', kind: 'method', signature: '()' },
]);

export const INSTANCE_FIELDS: ApiEntry[] = documented(
  [
    'x', 'y', 'xstart', 'ystart', 'xprevious', 'yprevious',
    'hspeed', 'vspeed', 'gravity', 'gravity_direction', 'friction',
    'sprite_index', 'image_index', 'image_speed', 'image_xscale', 'image_yscale',
    'image_angle', 'image_alpha', 'image_blend',
    'visible', 'solid', 'depth', 'alarms',
    // The tree.
    'name', 'Name', 'Parent',
    // Signals, created on first access.
    'Destroying', 'Collided',
  ].map((name) => ({ name, kind: 'field' as const })),
);

/**
 * The Roblox-flavoured layer from `src/luau/roblox.luau`.
 *
 * `NAMESPACE_MEMBERS` is keyed by the receiver written before `.` or `:`, so
 * `task.` and `game:` offer the right thing instead of instance fields.
 */
export const SIGNAL_METHODS: ApiEntry[] = documented([
  { name: 'Connect', kind: 'method', signature: '(handler)', doc: 'Run handler on every fire. Returns a Connection.' },
  { name: 'Once', kind: 'method', signature: '(handler)', doc: 'Run handler on the next fire only.' },
  { name: 'Wait', kind: 'method', signature: '()', doc: 'Yield until the next fire. Needs task.spawn.' },
  { name: 'Fire', kind: 'method', signature: '(...)' },
  { name: 'DisconnectAll', kind: 'method', signature: '()' },
  { name: 'Disconnect', kind: 'method', signature: '()', doc: 'On a Connection.' },
]);

export const ROBLOX_GLOBALS: ApiEntry[] = documented([
  { name: 'game', kind: 'constant', doc: 'Root object. game:GetService("RunService")' },
  { name: 'workspace', kind: 'constant', doc: 'The live instance container.' },
  { name: 'Workspace', kind: 'constant' },
  { name: 'RunService', kind: 'constant', doc: 'Heartbeat, Stepped, RenderStepped' },
  { name: 'UserInputService', kind: 'constant', doc: 'InputBegan, InputEnded, IsKeyDown' },
  { name: 'ReplicatedStorage', kind: 'constant', doc: 'Shared values with a Changed signal.' },
  { name: 'DataStoreService', kind: 'constant', doc: 'Persistent saves.' },
  { name: 'HttpService', kind: 'constant', doc: 'JSONEncode / JSONDecode.' },
  { name: 'ScriptService', kind: 'constant', doc: 'Shared modules from scripts/.' },
  { name: 'Signal', kind: 'constant', doc: 'Signal.new() creates your own event.' },
  { name: 'Instance', kind: 'constant', doc: 'Instance.new("obj_x", parent) creates a parented instance.' },
  { name: 'task', kind: 'constant', doc: 'spawn, wait, delay, defer, cancel' },
  { name: 'require', kind: 'function', signature: '(name)', doc: 'Load a module from scripts/.' },
  { name: 'wait', kind: 'function', signature: '(seconds)', doc: 'Alias of task.wait.' },
]);

export const NAMESPACE_MEMBERS: Record<string, ApiEntry[]> = {
  task: documented(
    [
      { name: 'spawn', kind: 'function', signature: '(fn, ...)' },
      { name: 'wait', kind: 'function', signature: '(seconds)' },
      { name: 'delay', kind: 'function', signature: '(seconds, fn, ...)' },
      { name: 'defer', kind: 'function', signature: '(fn, ...)' },
      { name: 'cancel', kind: 'function', signature: '(thread)' },
    ],
    'task',
  ),
  Signal: documented([{ name: 'new', kind: 'function', signature: '()' }], 'Signal'),
  Instance: documented([{ name: 'new', kind: 'function', signature: '(object, parent?)' }], 'Instance'),
  game: documented(
    [
      { name: 'GetService', kind: 'method', signature: '(name)' },
      { name: 'FindService', kind: 'method', signature: '(name)' },
      { name: 'GetServices', kind: 'method', signature: '()' },
    ],
    'game',
  ),
  workspace: documented(
    [
      { name: 'GetChildren', kind: 'method', signature: '()' },
      { name: 'GetDescendants', kind: 'method', signature: '()' },
      { name: 'FindFirstChild', kind: 'method', signature: '(name)' },
      { name: 'CountOf', kind: 'method', signature: '(objectName)' },
      { name: 'GetPartsInRegion', kind: 'method', signature: '(x1, y1, x2, y2)' },
    ],
    'Workspace',
  ),
  RunService: documented(
    [
      { name: 'Heartbeat', kind: 'field' },
      { name: 'Stepped', kind: 'field' },
      { name: 'RenderStepped', kind: 'field' },
      { name: 'IsRunning', kind: 'method', signature: '()' },
      { name: 'IsClient', kind: 'method', signature: '()', doc: 'Always true.' },
      { name: 'IsServer', kind: 'method', signature: '()', doc: 'Always false.' },
      { name: 'IsStudio', kind: 'method', signature: '()', doc: 'Always false.' },
    ],
    'RunService',
  ),
  UserInputService: documented(
    [
      { name: 'InputBegan', kind: 'field' },
      { name: 'InputEnded', kind: 'field' },
      { name: 'IsKeyDown', kind: 'method', signature: '(key)' },
      { name: 'GetMouseLocation', kind: 'method', signature: '()' },
      { name: 'IsMouseButtonPressed', kind: 'method', signature: '(button)' },
    ],
    'UserInputService',
  ),
  ReplicatedStorage: documented(
    [
      { name: 'Set', kind: 'method', signature: '(key, value)' },
      { name: 'Get', kind: 'method', signature: '(key, default)' },
      { name: 'SetAttribute', kind: 'method', signature: '(key, value)', doc: 'The same as Set.' },
      { name: 'GetAttribute', kind: 'method', signature: '(key, default)', doc: 'The same as Get.' },
      { name: 'GetAttributes', kind: 'method', signature: '()' },
      { name: 'ClearAllAttributes', kind: 'method', signature: '()' },
      { name: 'Changed', kind: 'field' },
    ],
    'ReplicatedStorage',
  ),
  DataStoreService: documented(
    [{ name: 'GetDataStore', kind: 'method', signature: '(name)' }],
    'DataStoreService',
  ),
  HttpService: documented(
    [
      { name: 'JSONEncode', kind: 'method', signature: '(value)' },
      { name: 'JSONDecode', kind: 'method', signature: '(text)' },
      { name: 'GenerateGUID', kind: 'method', signature: '()' },
    ],
    'HttpService',
  ),
  ScriptService: documented(
    [
      { name: 'Require', kind: 'method', signature: '(name)' },
      { name: 'GetScripts', kind: 'method', signature: '()' },
      { name: 'FindFirstChild', kind: 'method', signature: '(name)' },
    ],
    'ScriptService',
  ),
};

/** Valid arguments to `game:GetService(...)`. */
export const SERVICE_NAMES = [
  'RunService',
  'UserInputService',
  'ReplicatedStorage',
  'DataStoreService',
  'HttpService',
  'ScriptService',
  'Workspace',
];

/** DataStore handles are usually held in a local, so offer these on any `:`. */
export const DATASTORE_METHODS: ApiEntry[] = documented([
  { name: 'SetAsync', kind: 'method', signature: '(key, value)' },
  { name: 'GetAsync', kind: 'method', signature: '(key, default)' },
  { name: 'RemoveAsync', kind: 'method', signature: '(key)' },
  { name: 'IncrementAsync', kind: 'method', signature: '(key, delta)' },
  { name: 'UpdateAsync', kind: 'method', signature: '(key, transform)' },
]);

/** Offered inside string literals alongside asset names. Must match `keyName`. */
export const KEY_NAMES = [
  'left', 'right', 'up', 'down', 'space', 'enter', 'escape', 'shift', 'ctrl', 'alt',
  'tab', 'backspace', 'delete', 'home', 'end', 'pageup', 'pagedown', 'comma', 'period',
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  ...'0123456789'.split(''),
];

export const EVENT_NAMES = [
  'create', 'destroy', 'room_start', 'room_end', 'alarm',
  'step_begin', 'step', 'step_end', 'collision', 'animation_end', 'draw', 'draw_gui',
];

/** Fast membership set for the highlighter: every engine-provided global. */
export const ENGINE_SET = new Set([
  ...ENGINE_FUNCTIONS.map((e) => e.name),
  ...COLOURS,
  ...ROBLOX_GLOBALS.map((e) => e.name),
]);
