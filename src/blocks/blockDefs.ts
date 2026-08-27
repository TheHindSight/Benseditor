/**
 * The block language: Scratch-style blocks over the engine API.
 *
 * Every custom block is defined once as JSON and compiled to BOTH scripting
 * languages here, so a project can switch between Luau and Python without the
 * blocks knowing. The engine never sees a block: `generate.ts` turns a
 * workspace into ordinary source text, which is what runs, exports and
 * reports errors.
 *
 * Framework-free and DOM-free on purpose: this module runs headless in Node
 * for the tests, and only `blockEditor.ts` adds a rendered workspace on top.
 *
 * Blockly's stock generators are reused for Logic, Loops, Math, Text and Lists;
 * the overrides at the bottom are the places where stock output is wrong for
 * Benseditor:
 *
 *  - Luau has a `continue` keyword and no `goto`, so the stock Lua
 *    `goto continue` / `::continue::` pair is replaced.
 *  - Blockly variables are per-instance state (`self.score`), never module
 *    globals, and loop variables are bound to `self.<name>` inside the loop.
 *  - Procedures take `self` first, so they can reach the instance.
 */
import * as Blockly from 'blockly';
import { luaGenerator, Order as LuaOrder } from 'blockly/lua';
import { pythonGenerator, Order as PyOrder } from 'blockly/python';
import { COLOURS, EVENT_NAMES, KEY_NAMES } from '../ui/apiSurface';

type Block = Blockly.Block;
type Generator = Blockly.CodeGenerator;
type Lang = 'luau' | 'python';
type Code = string | [string, number] | null;
type BlockFn = (block: Block, generator: Generator) => Code;

// ---- events -----------------------------------------------------------------

export interface BlockEvent {
  name: string;
  label: string;
  /** Parameter names of the handler, `self` first. Mirrors `EVENTS` in objectEditor.ts. */
  args: string[];
}

const EVENT_LABELS: Record<string, string> = {
  create: 'when created',
  destroy: 'when destroyed',
  room_start: 'when room starts',
  room_end: 'when room ends',
  alarm: 'when alarm fires',
  step_begin: 'begin step',
  step: 'every step',
  step_end: 'end step',
  collision: 'when colliding with other',
  animation_end: 'when animation ends',
  draw: 'draw',
  draw_gui: 'draw GUI',
};

/** Each engine event, in the order the code editor's checklist lists them. */
export const BLOCK_EVENTS: BlockEvent[] = EVENT_NAMES.map((name) => ({
  name,
  label: EVENT_LABELS[name] ?? name,
  args: name === 'alarm' ? ['self', 'index'] : name === 'collision' ? ['self', 'other'] : ['self'],
}));

export const EVENT_BLOCK_PREFIX = 'bs_event_';

export function eventBlockType(eventName: string): string {
  return EVENT_BLOCK_PREFIX + eventName;
}

/** The event a hat block defines, or undefined for any other block type. */
export function eventOfBlockType(type: string): string | undefined {
  if (!type.startsWith(EVENT_BLOCK_PREFIX)) return undefined;
  const name = type.slice(EVENT_BLOCK_PREFIX.length);
  return EVENT_NAMES.includes(name) ? name : undefined;
}

// ---- colours ----------------------------------------------------------------

export const HUE = {
  events: 40,
  motion: 225,
  looks: 285,
  sensing: 195,
  control: 30,
  instances: 120,
  rooms: 160,
  maths: 230,
  data: 15,
};

// ---- the instance fields the Motion blocks expose ---------------------------

export const NUMERIC_FIELDS = [
  'x', 'y', 'xstart', 'ystart', 'xprevious', 'yprevious',
  'hspeed', 'vspeed', 'gravity', 'gravity_direction', 'friction',
  'image_index', 'image_speed', 'image_xscale', 'image_yscale',
  'image_angle', 'image_alpha', 'depth',
];

const MOUSE_BUTTONS = ['left', 'right', 'middle'];

// ---- table-driven call blocks -----------------------------------------------

/**
 * How one input of a call block is presented and compiled.
 *
 *  - `num` / `str` / `bool` / `inst` / `any` / `list` / `colour` / `key` are
 *    value inputs, defaulting to a literal of that kind when left empty.
 *  - `text` is a field typed straight into the block and emitted as a string
 *    literal (object, sprite and room names).
 *  - `button` is a dropdown of mouse buttons, emitted as a string literal.
 */
type ArgKind = 'num' | 'str' | 'bool' | 'inst' | 'any' | 'list' | 'colour' | 'key' | 'text' | 'button';

interface ArgSpec {
  name: string;
  kind: ArgKind;
  /** Shown in the toolbox shadow / field. */
  example?: string | number | boolean;
}

/** Who the call hangs off. `arg0` means the first input is the receiver. */
type Receiver = 'global' | 'self' | 'arg0' | 'Instance' | 'ReplicatedStorage';

type Output = 'Number' | 'String' | 'Boolean' | 'Array' | 'Instance' | 'Any';

interface CallSpec {
  type: string;
  /** The engine name. */
  fn: string;
  receiver: Receiver;
  /** Block text with `%1 … %n` in argument order. */
  message: string;
  args: ArgSpec[];
  /** Absent for a statement block. */
  output?: Output;
  /** Also define `<type>_stmt`: the same call as a statement whose result is dropped. */
  alsoStatement?: boolean;
  colour: number;
  tooltip?: string;
}

const num = (name: string, example: number = 0): ArgSpec => ({ name, kind: 'num', example });
const str = (name: string, example = ''): ArgSpec => ({ name, kind: 'str', example });
const bool = (name: string, example = false): ArgSpec => ({ name, kind: 'bool', example });
const inst = (name: string): ArgSpec => ({ name, kind: 'inst' });
const text = (name: string, example = ''): ArgSpec => ({ name, kind: 'text', example });
const colour = (name: string): ArgSpec => ({ name, kind: 'colour' });

const CALLS: CallSpec[] = [
  // ---- motion / self ----
  { type: 'bs_move_towards_point', fn: 'move_towards_point', receiver: 'self', colour: HUE.motion,
    message: 'move towards x %1 y %2 speed %3', args: [num('X'), num('Y'), num('SPEED', 4)] },
  { type: 'bs_set_speed', fn: 'set_speed', receiver: 'self', colour: HUE.motion,
    message: 'set speed %1 direction %2', args: [num('SPEED', 4), num('DIRECTION', 0)] },
  { type: 'bs_move_contact', fn: 'move_contact', receiver: 'self', colour: HUE.motion,
    message: 'move until touching %1 by dx %2 dy %3', args: [text('OBJECT', 'tiles'), num('DX', 0), num('DY', 1)] },
  { type: 'bs_distance_to_point', fn: 'distance_to_point', receiver: 'self', colour: HUE.motion, output: 'Number',
    message: 'distance to x %1 y %2', args: [num('X'), num('Y')] },
  { type: 'bs_distance_to_object', fn: 'distance_to_object', receiver: 'self', colour: HUE.motion, output: 'Number',
    message: 'distance to %1', args: [inst('OTHER')] },
  { type: 'bs_speed', fn: 'speed', receiver: 'self', colour: HUE.motion, output: 'Number', message: 'speed', args: [] },
  { type: 'bs_direction', fn: 'direction', receiver: 'self', colour: HUE.motion, output: 'Number', message: 'direction', args: [] },
  { type: 'bs_place_meeting', fn: 'place_meeting', receiver: 'self', colour: HUE.sensing, output: 'Boolean',
    message: 'would touch %3 at x %1 y %2', args: [num('X'), num('Y'), text('OBJECT', 'tiles')],
    tooltip: 'True if this instance would collide there. Use "tiles" for solid tiles.' },
  { type: 'bs_instance_place', fn: 'instance_place', receiver: 'self', colour: HUE.sensing, output: 'Instance',
    message: 'instance of %3 touched at x %1 y %2', args: [num('X'), num('Y'), text('OBJECT', 'obj_')] },
  { type: 'bs_draw_self', fn: 'draw_self', receiver: 'self', colour: HUE.looks, message: 'draw self', args: [] },

  // ---- sensing ----
  { type: 'bs_keyboard_check', fn: 'keyboard_check', receiver: 'global', colour: HUE.sensing, output: 'Boolean',
    message: 'key %1 held?', args: [{ name: 'KEY', kind: 'key' }] },
  { type: 'bs_keyboard_check_pressed', fn: 'keyboard_check_pressed', receiver: 'global', colour: HUE.sensing, output: 'Boolean',
    message: 'key %1 pressed?', args: [{ name: 'KEY', kind: 'key' }] },
  { type: 'bs_keyboard_check_released', fn: 'keyboard_check_released', receiver: 'global', colour: HUE.sensing, output: 'Boolean',
    message: 'key %1 released?', args: [{ name: 'KEY', kind: 'key' }] },
  { type: 'bs_mouse_check_button', fn: 'mouse_check_button', receiver: 'global', colour: HUE.sensing, output: 'Boolean',
    message: 'mouse %1 button down?', args: [{ name: 'BUTTON', kind: 'button' }] },
  { type: 'bs_mouse_x', fn: 'mouse_x', receiver: 'global', colour: HUE.sensing, output: 'Number', message: 'mouse x', args: [] },
  { type: 'bs_mouse_y', fn: 'mouse_y', receiver: 'global', colour: HUE.sensing, output: 'Number', message: 'mouse y', args: [] },
  { type: 'bs_mouse_wheel', fn: 'mouse_wheel', receiver: 'global', colour: HUE.sensing, output: 'Number', message: 'mouse wheel', args: [] },
  { type: 'bs_collision_point', fn: 'collision_point', receiver: 'global', colour: HUE.sensing, output: 'Instance',
    message: 'instance of %3 at x %1 y %2', args: [num('X'), num('Y'), text('OBJECT', 'obj_')] },
  { type: 'bs_tile_solid_at', fn: 'tile_solid_at', receiver: 'global', colour: HUE.sensing, output: 'Boolean',
    message: 'solid tile at x %1 y %2?', args: [num('X'), num('Y')] },

  // ---- instances ----
  { type: 'bs_instance_create', fn: 'instance_create', receiver: 'global', colour: HUE.instances, output: 'Instance', alsoStatement: true,
    message: 'create %3 at x %1 y %2', args: [num('X'), num('Y'), text('OBJECT', 'obj_')] },
  { type: 'bs_destroy', fn: 'destroy', receiver: 'arg0', colour: HUE.instances,
    message: 'destroy %1', args: [inst('INST')] },
  { type: 'bs_instance_exists', fn: 'instance_exists', receiver: 'global', colour: HUE.instances, output: 'Boolean',
    message: '%1 exists?', args: [text('OBJECT', 'obj_')] },
  { type: 'bs_instance_number', fn: 'instance_number', receiver: 'global', colour: HUE.instances, output: 'Number',
    message: 'count of %1', args: [text('OBJECT', 'obj_')] },
  { type: 'bs_instance_find', fn: 'instance_find', receiver: 'global', colour: HUE.instances, output: 'Instance',
    message: 'instance # %2 of %1', args: [text('OBJECT', 'obj_'), num('INDEX', 1)] },
  { type: 'bs_instance_list', fn: 'instance_list', receiver: 'global', colour: HUE.instances, output: 'Array',
    message: 'all instances of %1', args: [text('OBJECT', 'obj_')] },
  { type: 'bs_instance_nearest', fn: 'instance_nearest', receiver: 'global', colour: HUE.instances, output: 'Instance',
    message: 'nearest %3 to x %1 y %2', args: [num('X'), num('Y'), text('OBJECT', 'obj_')] },
  { type: 'bs_instance_new', fn: 'new', receiver: 'Instance', colour: HUE.instances, output: 'Instance', alsoStatement: true,
    message: 'new %1 with parent %2', args: [text('OBJECT', 'obj_'), inst('PARENT')],
    tooltip: 'Instance.new: create an instance parented to another, at its position.' },
  { type: 'bs_find_first_child', fn: 'find_first_child', receiver: 'arg0', colour: HUE.instances, output: 'Instance',
    message: 'child of %1 named %2', args: [inst('INST'), str('NAME', 'child')] },
  { type: 'bs_get_children', fn: 'get_children', receiver: 'arg0', colour: HUE.instances, output: 'Array',
    message: 'children of %1', args: [inst('INST')] },
  { type: 'bs_is_a', fn: 'is_a', receiver: 'arg0', colour: HUE.instances, output: 'Boolean',
    message: '%1 is a %2?', args: [inst('INST'), text('OBJECT', 'obj_')] },

  // ---- looks / draw ----
  { type: 'bs_draw_sprite', fn: 'draw_sprite', receiver: 'global', colour: HUE.looks,
    message: 'draw sprite %1 frame %2 at x %3 y %4', args: [text('SPRITE', 'spr_'), num('INDEX'), num('X'), num('Y')] },
  { type: 'bs_draw_sprite_ext', fn: 'draw_sprite_ext', receiver: 'global', colour: HUE.looks,
    message: 'draw sprite %1 frame %2 at x %3 y %4 xscale %5 yscale %6 angle %7 colour %8 alpha %9',
    args: [text('SPRITE', 'spr_'), num('INDEX'), num('X'), num('Y'), num('XSCALE', 1), num('YSCALE', 1), num('ANGLE'), colour('COLOUR'), num('ALPHA', 1)] },
  { type: 'bs_draw_rectangle', fn: 'draw_rectangle', receiver: 'global', colour: HUE.looks,
    message: 'draw rectangle x1 %1 y1 %2 x2 %3 y2 %4 outline %5', args: [num('X1'), num('Y1'), num('X2', 16), num('Y2', 16), bool('OUTLINE')] },
  { type: 'bs_draw_line', fn: 'draw_line', receiver: 'global', colour: HUE.looks,
    message: 'draw line x1 %1 y1 %2 x2 %3 y2 %4 width %5', args: [num('X1'), num('Y1'), num('X2', 16), num('Y2', 16), num('WIDTH', 1)] },
  { type: 'bs_draw_circle', fn: 'draw_circle', receiver: 'global', colour: HUE.looks,
    message: 'draw circle x %1 y %2 radius %3 outline %4', args: [num('X'), num('Y'), num('RADIUS', 8), bool('OUTLINE')] },
  { type: 'bs_draw_text', fn: 'draw_text', receiver: 'global', colour: HUE.looks,
    message: 'draw text %3 at x %1 y %2 colour %4', args: [num('X'), num('Y'), str('TEXT', 'hello'), colour('COLOUR')] },
  { type: 'bs_draw_set_color', fn: 'draw_set_color', receiver: 'global', colour: HUE.looks,
    message: 'set draw colour %1', args: [colour('COLOUR')] },
  { type: 'bs_draw_set_alpha', fn: 'draw_set_alpha', receiver: 'global', colour: HUE.looks,
    message: 'set draw alpha %1', args: [num('ALPHA', 1)] },
  { type: 'bs_string_width', fn: 'string_width', receiver: 'global', colour: HUE.looks, output: 'Number',
    message: 'width of text %1', args: [str('TEXT', 'hello')] },
  { type: 'bs_string_height', fn: 'string_height', receiver: 'global', colour: HUE.looks, output: 'Number',
    message: 'height of text %1', args: [str('TEXT', 'hello')] },

  // ---- rooms & game ----
  { type: 'bs_room_goto', fn: 'room_goto', receiver: 'global', colour: HUE.rooms, message: 'go to room %1', args: [text('ROOM', 'rm_')] },
  { type: 'bs_room_restart', fn: 'room_restart', receiver: 'global', colour: HUE.rooms, message: 'restart room', args: [] },
  { type: 'bs_room_current', fn: 'room_current', receiver: 'global', colour: HUE.rooms, output: 'String', message: 'current room', args: [] },
  { type: 'bs_room_width', fn: 'room_width', receiver: 'global', colour: HUE.rooms, output: 'Number', message: 'room width', args: [] },
  { type: 'bs_room_height', fn: 'room_height', receiver: 'global', colour: HUE.rooms, output: 'Number', message: 'room height', args: [] },
  { type: 'bs_room_speed', fn: 'room_speed', receiver: 'global', colour: HUE.rooms, output: 'Number', message: 'room speed', args: [] },
  { type: 'bs_game_end', fn: 'game_end', receiver: 'global', colour: HUE.rooms, message: 'end game', args: [] },
  { type: 'bs_view_set', fn: 'view_set', receiver: 'global', colour: HUE.rooms, message: 'scroll view to x %1 y %2', args: [num('X'), num('Y')] },

  // ---- maths ----
  { type: 'bs_point_distance', fn: 'point_distance', receiver: 'global', colour: HUE.maths, output: 'Number',
    message: 'distance from x %1 y %2 to x %3 y %4', args: [num('X1'), num('Y1'), num('X2'), num('Y2')] },
  { type: 'bs_point_direction', fn: 'point_direction', receiver: 'global', colour: HUE.maths, output: 'Number',
    message: 'direction from x %1 y %2 to x %3 y %4', args: [num('X1'), num('Y1'), num('X2'), num('Y2')] },
  { type: 'bs_lengthdir_x', fn: 'lengthdir_x', receiver: 'global', colour: HUE.maths, output: 'Number',
    message: 'x of length %1 direction %2', args: [num('LENGTH', 1), num('DIRECTION')] },
  { type: 'bs_lengthdir_y', fn: 'lengthdir_y', receiver: 'global', colour: HUE.maths, output: 'Number',
    message: 'y of length %1 direction %2', args: [num('LENGTH', 1), num('DIRECTION')] },
  { type: 'bs_clamp', fn: 'clamp', receiver: 'global', colour: HUE.maths, output: 'Number',
    message: 'clamp %1 between %2 and %3', args: [num('VALUE'), num('LOW'), num('HIGH', 1)] },
  { type: 'bs_lerp', fn: 'lerp', receiver: 'global', colour: HUE.maths, output: 'Number',
    message: 'lerp from %1 to %2 amount %3', args: [num('A'), num('B', 1), num('AMOUNT', 0.5)] },
  { type: 'bs_approach', fn: 'approach', receiver: 'global', colour: HUE.maths, output: 'Number',
    message: 'move %1 towards %2 by %3', args: [num('VALUE'), num('TARGET'), num('AMOUNT', 1)] },
  { type: 'bs_sign', fn: 'sign', receiver: 'global', colour: HUE.maths, output: 'Number', message: 'sign of %1', args: [num('VALUE')] },
  { type: 'bs_irandom', fn: 'irandom', receiver: 'global', colour: HUE.maths, output: 'Number',
    message: 'random integer 0 to %1', args: [num('MAXIMUM', 10)] },
  { type: 'bs_irandom_range', fn: 'irandom_range', receiver: 'global', colour: HUE.maths, output: 'Number',
    message: 'random integer %1 to %2', args: [num('LOW', 1), num('HIGH', 10)] },
  { type: 'bs_random_range', fn: 'random_range', receiver: 'global', colour: HUE.maths, output: 'Number',
    message: 'random number %1 to %2', args: [num('LOW'), num('HIGH', 1)] },
  { type: 'bs_angle_difference', fn: 'angle_difference', receiver: 'global', colour: HUE.maths, output: 'Number',
    message: 'angle difference %1 %2', args: [num('A'), num('B')] },
  { type: 'bs_wrap', fn: 'wrap', receiver: 'global', colour: HUE.maths, output: 'Number',
    message: 'wrap %1 between %2 and %3', args: [num('VALUE'), num('LOW'), num('HIGH', 360)] },
  { type: 'bs_choose', fn: 'choose', receiver: 'global', colour: HUE.maths, output: 'Any',
    message: 'choose %1 or %2', args: [{ name: 'A', kind: 'any' }, { name: 'B', kind: 'any' }] },

  // ---- data ----
  { type: 'bs_storage_set', fn: 'Set', receiver: 'ReplicatedStorage', colour: HUE.data,
    message: 'set shared %1 to %2', args: [str('KEY', 'score'), { name: 'VALUE', kind: 'any' }],
    tooltip: 'ReplicatedStorage: a value every object can read.' },
  { type: 'bs_storage_get', fn: 'Get', receiver: 'ReplicatedStorage', colour: HUE.data, output: 'Any',
    message: 'shared %1 or %2', args: [str('KEY', 'score'), { name: 'DEFAULT', kind: 'any' }],
    tooltip: 'ReplicatedStorage: read a shared value, or the default when unset.' },
];

// ---- literal helpers --------------------------------------------------------

/** A double-quoted string literal that is valid in both Luau and Python. */
export function quote(value: string): string {
  return '"' + String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t') + '"';
}

const NIL: Record<Lang, string> = { luau: 'nil', python: 'None' };
const FALSE: Record<Lang, string> = { luau: 'false', python: 'False' };
const TRUE: Record<Lang, string> = { luau: 'true', python: 'True' };
const EMPTY_LIST: Record<Lang, string> = { luau: '{}', python: '[]' };

const NONE: Record<Lang, number> = { luau: LuaOrder.NONE, python: PyOrder.NONE };
const CALL_ORDER: Record<Lang, number> = { luau: LuaOrder.HIGH, python: PyOrder.FUNCTION_CALL };
const MEMBER_ORDER: Record<Lang, number> = { luau: LuaOrder.HIGH, python: PyOrder.MEMBER };
const ATOMIC: Record<Lang, number> = { luau: LuaOrder.ATOMIC, python: PyOrder.ATOMIC };

function langOf(generator: Generator): Lang {
  return (generator as unknown) === pythonGenerator ? 'python' : 'luau';
}

function value(block: Block, name: string, generator: Generator, fallback: string): string {
  return generator.valueToCode(block, name, NONE[langOf(generator)]) || fallback;
}

function argCode(arg: ArgSpec, block: Block, generator: Generator): string {
  const lang = langOf(generator);
  switch (arg.kind) {
    case 'num': return value(block, arg.name, generator, '0');
    case 'str': return value(block, arg.name, generator, '""');
    case 'key': return value(block, arg.name, generator, '""');
    case 'bool': return value(block, arg.name, generator, FALSE[lang]);
    case 'inst': return value(block, arg.name, generator, NIL[lang]);
    case 'any': return value(block, arg.name, generator, NIL[lang]);
    case 'list': return value(block, arg.name, generator, EMPTY_LIST[lang]);
    case 'colour': return value(block, arg.name, generator, 'c_white');
    case 'text': return quote(block.getFieldValue(arg.name) ?? '');
    case 'button': return quote(block.getFieldValue(arg.name) ?? 'left');
  }
}

/** Method call syntax differs; everything else is spelled the same. */
function methodCall(receiver: string, fn: string, args: string[], lang: Lang): string {
  return `${receiver}${lang === 'luau' ? ':' : '.'}${fn}(${args.join(', ')})`;
}

function callExpression(spec: CallSpec, block: Block, generator: Generator): string {
  const lang = langOf(generator);
  const values = spec.args.map((arg) => argCode(arg, block, generator));
  switch (spec.receiver) {
    case 'global': return `${spec.fn}(${values.join(', ')})`;
    case 'self': return methodCall('self', spec.fn, values, lang);
    case 'arg0': return methodCall(values[0] === NIL[lang] ? 'self' : values[0], spec.fn, values.slice(1), lang);
    case 'Instance': return `Instance.${spec.fn}(${values.join(', ')})`;
    case 'ReplicatedStorage': return methodCall('ReplicatedStorage', spec.fn, values, lang);
  }
}

// ---- JSON block definitions -------------------------------------------------

type Json = Record<string, unknown>;

const OUTPUT_CHECK: Record<Output, string | null> = {
  Number: 'Number',
  String: 'String',
  Boolean: 'Boolean',
  Array: 'Array',
  Instance: null,
  Any: null,
};

function argJson(arg: ArgSpec): Json {
  switch (arg.kind) {
    case 'num': return { type: 'input_value', name: arg.name, check: 'Number' };
    case 'str': return { type: 'input_value', name: arg.name, check: 'String' };
    case 'key': return { type: 'input_value', name: arg.name, check: 'String' };
    case 'bool': return { type: 'input_value', name: arg.name, check: 'Boolean' };
    case 'colour': return { type: 'input_value', name: arg.name, check: 'Number' };
    case 'list': return { type: 'input_value', name: arg.name, check: 'Array' };
    case 'inst':
    case 'any': return { type: 'input_value', name: arg.name };
    case 'text': return { type: 'field_input', name: arg.name, text: String(arg.example ?? '') };
    case 'button': return { type: 'field_dropdown', name: arg.name, options: MOUSE_BUTTONS.map((b) => [b, b]) };
  }
}

function callBlockJson(spec: CallSpec, asStatement: boolean): Json {
  const json: Json = {
    type: asStatement && spec.output ? `${spec.type}_stmt` : spec.type,
    message0: spec.message,
    args0: spec.args.map(argJson),
    colour: spec.colour,
    tooltip: spec.tooltip ?? spec.fn,
    inputsInline: true,
  };
  if (spec.output && !asStatement) {
    json.output = OUTPUT_CHECK[spec.output];
  } else {
    json.previousStatement = null;
    json.nextStatement = null;
  }
  return json;
}

const fieldOptions = (names: string[]) => names.map((n) => [n, n]);

/** Blocks with bespoke generators, defined by hand. */
const CUSTOM_BLOCKS: Json[] = [
  ...BLOCK_EVENTS.map((event) => ({
    type: eventBlockType(event.name),
    message0: event.label,
    message1: '%1',
    args1: [{ type: 'input_statement', name: 'BODY' }],
    colour: HUE.events,
    tooltip: `${event.name}(${event.args.join(', ')})`,
    hat: 'cap',
  })),
  { type: 'bs_self', message0: 'myself', output: null, colour: HUE.sensing, tooltip: 'This instance.' },
  { type: 'bs_other', message0: 'other', output: null, colour: HUE.sensing, tooltip: 'The other instance in a collision event.' },
  { type: 'bs_alarm_index', message0: 'alarm number', output: 'Number', colour: HUE.sensing, tooltip: 'Which alarm fired, in an alarm event.' },

  { type: 'bs_get_field', message0: '%1', args0: [{ type: 'field_dropdown', name: 'FIELD', options: fieldOptions(NUMERIC_FIELDS) }],
    output: 'Number', colour: HUE.motion, tooltip: 'A property of this instance.' },
  { type: 'bs_set_field', message0: 'set %1 to %2',
    args0: [{ type: 'field_dropdown', name: 'FIELD', options: fieldOptions(NUMERIC_FIELDS) }, { type: 'input_value', name: 'VALUE', check: 'Number' }],
    previousStatement: null, nextStatement: null, colour: HUE.motion, inputsInline: true },
  { type: 'bs_change_field', message0: 'change %1 by %2',
    args0: [{ type: 'field_dropdown', name: 'FIELD', options: fieldOptions(NUMERIC_FIELDS) }, { type: 'input_value', name: 'VALUE', check: 'Number' }],
    previousStatement: null, nextStatement: null, colour: HUE.motion, inputsInline: true },
  { type: 'bs_get_field_of', message0: '%1 of %2',
    args0: [{ type: 'field_dropdown', name: 'FIELD', options: fieldOptions(NUMERIC_FIELDS) }, { type: 'input_value', name: 'INST' }],
    output: 'Number', colour: HUE.instances, inputsInline: true, tooltip: 'A property of another instance.' },
  { type: 'bs_set_field_of', message0: 'set %1 of %2 to %3',
    args0: [{ type: 'field_dropdown', name: 'FIELD', options: fieldOptions(NUMERIC_FIELDS) }, { type: 'input_value', name: 'INST' }, { type: 'input_value', name: 'VALUE', check: 'Number' }],
    previousStatement: null, nextStatement: null, colour: HUE.instances, inputsInline: true },
  { type: 'bs_set_sprite', message0: 'set sprite to %1', args0: [{ type: 'field_input', name: 'SPRITE', text: 'spr_' }],
    previousStatement: null, nextStatement: null, colour: HUE.looks },
  { type: 'bs_visible', message0: 'visible %1', args0: [{ type: 'field_checkbox', name: 'VISIBLE', checked: true }],
    previousStatement: null, nextStatement: null, colour: HUE.looks },

  { type: 'bs_key', message0: '%1', args0: [{ type: 'field_dropdown', name: 'KEY', options: fieldOptions(KEY_NAMES) }],
    output: 'String', colour: HUE.sensing, tooltip: 'A key name. Swap in a text block for any other key.' },
  { type: 'bs_colour', message0: '%1', args0: [{ type: 'field_dropdown', name: 'COLOUR', options: fieldOptions(COLOURS) }],
    output: 'Number', colour: HUE.looks, tooltip: 'A named colour.' },
  { type: 'bs_rgb', message0: 'colour # %1', args0: [{ type: 'field_input', name: 'HEX', text: 'ff8800' }],
    output: 'Number', colour: HUE.looks, tooltip: 'A colour from six hex digits, RRGGBB.' },

  { type: 'bs_view_x', message0: 'view x', output: 'Number', colour: HUE.rooms },
  { type: 'bs_view_y', message0: 'view y', output: 'Number', colour: HUE.rooms },
  { type: 'bs_set_alarm', message0: 'set alarm %1 to %2 steps',
    args0: [{ type: 'input_value', name: 'INDEX', check: 'Number' }, { type: 'input_value', name: 'VALUE', check: 'Number' }],
    previousStatement: null, nextStatement: null, colour: HUE.rooms, inputsInline: true,
    tooltip: 'Fires the alarm event after that many steps. Alarms are numbered 1 to 12.' },
  { type: 'bs_get_alarm', message0: 'alarm %1', args0: [{ type: 'input_value', name: 'INDEX', check: 'Number' }],
    output: 'Number', colour: HUE.rooms, tooltip: 'Steps left on that alarm.' },

  { type: 'bs_set_parent', message0: 'set parent of %1 to %2', args0: [{ type: 'input_value', name: 'INST' }, { type: 'input_value', name: 'PARENT' }],
    previousStatement: null, nextStatement: null, colour: HUE.instances, inputsInline: true },
  { type: 'bs_get_parent', message0: 'parent of %1', args0: [{ type: 'input_value', name: 'INST' }], output: null, colour: HUE.instances },
  { type: 'bs_get_name', message0: 'name of %1', args0: [{ type: 'input_value', name: 'INST' }], output: 'String', colour: HUE.instances },
  { type: 'bs_set_name', message0: 'set name of %1 to %2', args0: [{ type: 'input_value', name: 'INST' }, { type: 'input_value', name: 'NAME', check: 'String' }],
    previousStatement: null, nextStatement: null, colour: HUE.instances, inputsInline: true },

  { type: 'bs_print', message0: 'print %1', args0: [{ type: 'input_value', name: 'VALUE' }],
    previousStatement: null, nextStatement: null, colour: HUE.data, tooltip: 'Write to the console.' },
];

const CALL_BLOCKS: Json[] = CALLS.flatMap((spec) =>
  spec.alsoStatement && spec.output
    ? [callBlockJson(spec, false), callBlockJson(spec, true)]
    : [callBlockJson(spec, false)],
);

/** Every custom block type, for the toolbox and the tests. */
export const CUSTOM_BLOCK_TYPES: string[] = [...CUSTOM_BLOCKS, ...CALL_BLOCKS].map((b) => String(b.type));

/**
 * Every engine name a block references, so a test can prove the block
 * language never reaches for something the manual does not describe.
 * Namespaced members are written `Owner.member`, as the manual lists them.
 */
export const ENGINE_BLOCK_NAMES: string[] = [
  ...new Set([
    ...CALLS.map((spec) =>
      spec.receiver === 'Instance' || spec.receiver === 'ReplicatedStorage' ? `${spec.receiver}.${spec.fn}` : spec.fn,
    ),
    ...NUMERIC_FIELDS,
    'sprite_index', 'visible', 'alarms', 'Parent', 'Name',
    'view_get',
    ...COLOURS,
  ]),
];

// ---- bespoke generators -----------------------------------------------------

/** The `self.<field>` or bare parameter name a Blockly variable compiles to. */
function variableTarget(block: Block, generator: Generator): string {
  const id = block.getFieldValue('VAR') as string;
  const name = generator.getVariableName(id);
  const root = block.getRootBlock();
  if (root.type === 'procedures_defnoreturn' || root.type === 'procedures_defreturn') {
    const params = root.getVarModels().map((model) => model.getId());
    if (params.includes(id)) return name;
  }
  return `self.${name}`;
}

function distinctName(generator: Generator, base: string): string {
  return generator.nameDB_?.getDistinctName(base, Blockly.Names.NameType.VARIABLE) ?? base;
}

function isNumberLiteral(code: string): boolean {
  return Blockly.utils.string.isNumber(code);
}

interface Definitions {
  definitions_: Record<string, string>;
}

/** `definitions_` is protected; the procedure generators are the one place it is written. */
function definitions(generator: Generator): Record<string, string> {
  return (generator as unknown as Definitions).definitions_;
}

function forEachLanguage(build: (lang: Lang) => Record<string, BlockFn>): void {
  for (const lang of ['luau', 'python'] as Lang[]) {
    const generator = lang === 'luau' ? luaGenerator : pythonGenerator;
    Object.assign(generator.forBlock, build(lang));
  }
}

function installCustomGenerators(): void {
  forEachLanguage((lang) => {
    const py = lang === 'python';
    const stmt = (code: string) => code + '\n';
    const member = (code: string): Code => [code, MEMBER_ORDER[lang]];
    const call = (code: string): Code => [code, CALL_ORDER[lang]];
    const fns: Record<string, BlockFn> = {};

    // Events.
    for (const event of BLOCK_EVENTS) {
      fns[eventBlockType(event.name)] = (block, generator) => {
        const body = generator.statementToCode(block, 'BODY');
        const args = event.args.join(', ');
        if (py) {
          return `def ${event.name}(${args}):\n${body || pythonGenerator.PASS}\n`;
        }
        return `function obj.${event.name}(${args})\n${body}end\n\n`;
      };
    }

    fns.bs_self = () => ['self', ATOMIC[lang]];
    fns.bs_other = () => ['other', ATOMIC[lang]];
    fns.bs_alarm_index = () => ['index', ATOMIC[lang]];

    fns.bs_get_field = (block) => member(`self.${block.getFieldValue('FIELD')}`);
    fns.bs_set_field = (block, generator) =>
      stmt(`self.${block.getFieldValue('FIELD')} = ${value(block, 'VALUE', generator, '0')}`);
    fns.bs_change_field = (block, generator) =>
      stmt(`self.${block.getFieldValue('FIELD')} += ${value(block, 'VALUE', generator, '0')}`);
    fns.bs_get_field_of = (block, generator) =>
      member(`${value(block, 'INST', generator, 'self')}.${block.getFieldValue('FIELD')}`);
    fns.bs_set_field_of = (block, generator) =>
      stmt(`${value(block, 'INST', generator, 'self')}.${block.getFieldValue('FIELD')} = ${value(block, 'VALUE', generator, '0')}`);
    fns.bs_set_sprite = (block) => stmt(`self.sprite_index = ${quote(block.getFieldValue('SPRITE') ?? '')}`);
    fns.bs_visible = (block) =>
      stmt(`self.visible = ${block.getFieldValue('VISIBLE') === 'TRUE' ? TRUE[lang] : FALSE[lang]}`);

    fns.bs_key = (block) => [quote(block.getFieldValue('KEY') ?? ''), ATOMIC[lang]];
    fns.bs_colour = (block) => [block.getFieldValue('COLOUR') ?? 'c_white', ATOMIC[lang]];
    fns.bs_rgb = (block) => {
      const hex = String(block.getFieldValue('HEX') ?? '').replace(/[^0-9a-fA-F]/g, '').slice(0, 6) || '0';
      return [`0x${hex.toLowerCase()}`, ATOMIC[lang]];
    };

    fns.bs_view_x = () => call(py ? 'view_get()[0]' : '(view_get())');
    fns.bs_view_y = () => call(py ? 'view_get()[1]' : 'select(2, view_get())');
    fns.bs_set_alarm = (block, generator) =>
      stmt(`self.alarms[${value(block, 'INDEX', generator, '1')}] = ${value(block, 'VALUE', generator, '0')}`);
    fns.bs_get_alarm = (block, generator) => member(`self.alarms[${value(block, 'INDEX', generator, '1')}]`);

    fns.bs_set_parent = (block, generator) =>
      stmt(`${value(block, 'INST', generator, 'self')}.Parent = ${value(block, 'PARENT', generator, NIL[lang])}`);
    fns.bs_get_parent = (block, generator) => member(`${value(block, 'INST', generator, 'self')}.Parent`);
    fns.bs_get_name = (block, generator) => member(`${value(block, 'INST', generator, 'self')}.Name`);
    fns.bs_set_name = (block, generator) =>
      stmt(`${value(block, 'INST', generator, 'self')}.Name = ${value(block, 'NAME', generator, '""')}`);

    fns.bs_print = (block, generator) => stmt(`print(${value(block, 'VALUE', generator, '""')})`);

    // Table-driven calls.
    for (const spec of CALLS) {
      if (spec.output) {
        fns[spec.type] = (block, generator) => call(callExpression(spec, block, generator));
        if (spec.alsoStatement) fns[`${spec.type}_stmt`] = (block, generator) => stmt(callExpression(spec, block, generator));
      } else {
        fns[spec.type] = (block, generator) => stmt(callExpression(spec, block, generator));
      }
    }

    return fns;
  });
}

/**
 * Variables are instance state and procedures take `self`.
 *
 * Replaces Blockly's stock `variables_*`, `math_change`, `controls_for`,
 * `controls_forEach` and `procedures_*` on both generators.
 */
function installVariableAndProcedureOverrides(): void {
  forEachLanguage((lang) => {
    const py = lang === 'python';
    const fns: Record<string, BlockFn> = {};

    fns.variables_get = (block, generator) => [variableTarget(block, generator), MEMBER_ORDER[lang]];
    fns.variables_set = (block, generator) =>
      `${variableTarget(block, generator)} = ${value(block, 'VALUE', generator, '0')}\n`;
    fns.math_change = (block, generator) =>
      `${variableTarget(block, generator)} += ${value(block, 'DELTA', generator, '0')}\n`;

    // Count with a local, and bind the Blockly variable to it each pass.
    fns.controls_for = (block, generator) => {
      const target = variableTarget(block, generator);
      const loopVar = distinctName(generator, `${generator.getVariableName(block.getFieldValue('VAR'))}_loop`);
      const from = value(block, 'FROM', generator, '0');
      const to = value(block, 'TO', generator, '0');
      const by = value(block, 'BY', generator, '1');
      const branch = generator.statementToCode(block, 'DO');
      const bind = `${generator.INDENT}${target} = ${loopVar}\n`;
      if (py) {
        const range = generator.provideFunction_('bs_range', [
          `def ${generator.FUNCTION_NAME_PLACEHOLDER_}(start, end, step):`,
          `${generator.INDENT}step = abs(step) if start <= end else -abs(step)`,
          `${generator.INDENT}value = start`,
          `${generator.INDENT}while (value <= end) if step > 0 else (value >= end):`,
          `${generator.INDENT}${generator.INDENT}yield value`,
          `${generator.INDENT}${generator.INDENT}value += step`,
        ]);
        return `for ${loopVar} in ${range}(${from}, ${to}, ${by}):\n${bind}${branch}`;
      }
      let code = '';
      let step: string;
      if (isNumberLiteral(from) && isNumberLiteral(to) && isNumberLiteral(by)) {
        step = (Number(from) <= Number(to) ? '' : '-') + Math.abs(Number(by));
      } else {
        step = distinctName(generator, `${loopVar}_step`);
        code += `local ${step} = math.abs(${by})\n`;
        code += `if (${from}) > (${to}) then\n${generator.INDENT}${step} = -${step}\nend\n`;
      }
      return `${code}for ${loopVar} = ${from}, ${to}, ${step} do\n${bind}${branch}end\n`;
    };

    fns.controls_forEach = (block, generator) => {
      const target = variableTarget(block, generator);
      const loopVar = distinctName(generator, `${generator.getVariableName(block.getFieldValue('VAR'))}_item`);
      const list = value(block, 'LIST', generator, EMPTY_LIST[lang]);
      const branch = generator.statementToCode(block, 'DO');
      const bind = `${generator.INDENT}${target} = ${loopVar}\n`;
      return py
        ? `for ${loopVar} in ${list}:\n${bind}${branch}`
        : `for _, ${loopVar} in ipairs(${list}) do\n${bind}${branch}end\n`;
    };

    const procedureDef: BlockFn = (block, generator) => {
      const name = generator.getProcedureName(block.getFieldValue('NAME'));
      const params = ['self', ...block.getVarModels().map((model) => generator.getVariableName(model.getId()))];
      let branch = generator.statementToCode(block, 'STACK');
      let returns = '';
      if (block.type === 'procedures_defreturn') {
        const result = generator.valueToCode(block, 'RETURN', NONE[lang]);
        if (result) returns = `${generator.INDENT}return ${result}\n`;
      }
      let code: string;
      if (py) {
        if (!branch && !returns) branch = pythonGenerator.PASS;
        code = `def ${name}(${params.join(', ')}):\n${branch}${returns}`;
      } else {
        code = `local function ${name}(${params.join(', ')})\n${branch}${returns}end\n`;
      }
      definitions(generator)[`%${name}`] = code;
      return null;
    };
    fns.procedures_defnoreturn = procedureDef;
    fns.procedures_defreturn = procedureDef;

    const procedureCall = (block: Block, generator: Generator): string => {
      const name = generator.getProcedureName(block.getFieldValue('NAME'));
      const args = ['self'];
      for (let i = 0; block.getInput(`ARG${i}`); i++) args.push(value(block, `ARG${i}`, generator, NIL[lang]));
      return `${name}(${args.join(', ')})`;
    };
    fns.procedures_callreturn = (block, generator) => [procedureCall(block, generator), CALL_ORDER[lang]];
    fns.procedures_callnoreturn = (block, generator) => `${procedureCall(block, generator)}\n`;

    return fns;
  });
}

/**
 * Luau loops: the stock Lua generator writes `goto continue` and closes each
 * loop with a `::continue::` label. Luau has no `goto` but does have
 * `continue`, so the flow block emits the keyword and every loop is rebuilt
 * without the label. `controls_for` / `controls_forEach` are already replaced
 * above; the remaining three mirror upstream minus the label.
 */
function installLuauLoopOverrides(): void {
  const fns: Record<string, BlockFn> = {};

  fns.controls_flow_statements = (block) => {
    switch (block.getFieldValue('FLOW')) {
      case 'BREAK': return 'break\n';
      case 'CONTINUE': return 'continue\n';
    }
    throw new Error('Unknown flow statement.');
  };

  const repeat: BlockFn = (block, generator) => {
    let repeats: string;
    if (block.getField('TIMES')) {
      repeats = String(Number(block.getFieldValue('TIMES')));
    } else {
      repeats = generator.valueToCode(block, 'TIMES', LuaOrder.NONE) || '0';
    }
    repeats = isNumberLiteral(repeats) ? String(parseInt(repeats, 10)) : `math.floor(${repeats})`;
    let branch = generator.statementToCode(block, 'DO');
    branch = generator.addLoopTrap(branch, block);
    const loopVar = distinctName(generator, 'count');
    return `for ${loopVar} = 1, ${repeats} do\n${branch}end\n`;
  };
  fns.controls_repeat_ext = repeat;
  fns.controls_repeat = repeat;

  fns.controls_whileUntil = (block, generator) => {
    const until = block.getFieldValue('MODE') === 'UNTIL';
    let condition = generator.valueToCode(block, 'BOOL', until ? LuaOrder.UNARY : LuaOrder.NONE) || 'false';
    let branch = generator.statementToCode(block, 'DO');
    branch = generator.addLoopTrap(branch, block);
    if (until) condition = `not ${condition}`;
    return `while ${condition} do\n${branch}end\n`;
  };

  Object.assign(luaGenerator.forBlock, fns);
}

// ---- toolbox ----------------------------------------------------------------

function shadowFor(arg: ArgSpec): Json | undefined {
  switch (arg.kind) {
    case 'num': return { shadow: { type: 'math_number', fields: { NUM: arg.example ?? 0 } } };
    case 'str': return { shadow: { type: 'text', fields: { TEXT: arg.example ?? '' } } };
    case 'bool': return { shadow: { type: 'logic_boolean', fields: { BOOL: arg.example ? 'TRUE' : 'FALSE' } } };
    case 'key': return { shadow: { type: 'bs_key', fields: { KEY: 'space' } } };
    case 'colour': return { shadow: { type: 'bs_colour', fields: { COLOUR: 'c_white' } } };
    case 'inst': return { shadow: { type: 'bs_self' } };
    default: return undefined;
  }
}

function toolboxCall(spec: CallSpec, asStatement = false): Json {
  const inputs: Json = {};
  for (const arg of spec.args) {
    const shadow = shadowFor(arg);
    if (shadow) inputs[arg.name] = shadow;
  }
  return { kind: 'block', type: asStatement ? `${spec.type}_stmt` : spec.type, inputs };
}

const numberShadow = (n: number) => ({ shadow: { type: 'math_number', fields: { NUM: n } } });
const textShadow = (t: string) => ({ shadow: { type: 'text', fields: { TEXT: t } } });
const selfShadow = () => ({ shadow: { type: 'bs_self' } });

function toolboxBlock(type: string, inputs: Json = {}, fields?: Json): Json {
  const block: Json = { kind: 'block', type, inputs };
  if (fields) block.fields = fields;
  return block;
}

const byType = new Map(CALLS.map((spec) => [spec.type, spec]));
const callsOf = (types: string[]) => types.map((type) => {
  const stmt = type.endsWith('_stmt');
  const spec = byType.get(stmt ? type.slice(0, -5) : type);
  if (!spec) throw new Error(`no call spec for ${type}`);
  return toolboxCall(spec, stmt);
});

function category(name: string, colour: number, contents: Json[], extra: Json = {}): Json {
  return { kind: 'category', name, colour: String(colour), contents, ...extra };
}

/** A Blockly category toolbox, Scratch-style. */
export const TOOLBOX = {
  kind: 'categoryToolbox',
  contents: [
    category('Events', HUE.events, BLOCK_EVENTS.map((event) => toolboxBlock(eventBlockType(event.name)))),
    category('Motion', HUE.motion, [
      toolboxBlock('bs_set_field', { VALUE: numberShadow(0) }, { FIELD: 'x' }),
      toolboxBlock('bs_change_field', { VALUE: numberShadow(1) }, { FIELD: 'x' }),
      toolboxBlock('bs_get_field', {}, { FIELD: 'x' }),
      ...callsOf(['bs_move_towards_point', 'bs_set_speed', 'bs_move_contact', 'bs_speed', 'bs_direction',
        'bs_distance_to_point', 'bs_distance_to_object']),
    ]),
    category('Looks', HUE.looks, [
      ...callsOf(['bs_draw_self']),
      toolboxBlock('bs_set_sprite'),
      toolboxBlock('bs_visible'),
      ...callsOf(['bs_draw_sprite', 'bs_draw_sprite_ext', 'bs_draw_rectangle', 'bs_draw_line', 'bs_draw_circle',
        'bs_draw_text', 'bs_draw_set_color', 'bs_draw_set_alpha', 'bs_string_width', 'bs_string_height']),
      toolboxBlock('bs_colour'),
      toolboxBlock('bs_rgb'),
    ]),
    category('Sensing', HUE.sensing, [
      ...callsOf(['bs_keyboard_check', 'bs_keyboard_check_pressed', 'bs_keyboard_check_released',
        'bs_mouse_check_button', 'bs_mouse_x', 'bs_mouse_y', 'bs_mouse_wheel',
        'bs_place_meeting', 'bs_instance_place', 'bs_collision_point', 'bs_tile_solid_at']),
      toolboxBlock('bs_key'),
      toolboxBlock('bs_self'),
      toolboxBlock('bs_other'),
      toolboxBlock('bs_alarm_index'),
    ]),
    category('Control', HUE.control, [
      toolboxBlock('controls_if'),
      { kind: 'block', type: 'controls_if', extraState: { hasElse: true } },
      toolboxBlock('controls_repeat_ext', { TIMES: numberShadow(10) }),
      toolboxBlock('controls_whileUntil'),
      toolboxBlock('controls_for', { FROM: numberShadow(1), TO: numberShadow(10), BY: numberShadow(1) }),
      toolboxBlock('controls_forEach'),
      toolboxBlock('controls_flow_statements'),
      toolboxBlock('bs_set_alarm', { INDEX: numberShadow(1), VALUE: numberShadow(60) }),
      toolboxBlock('bs_get_alarm', { INDEX: numberShadow(1) }),
    ]),
    category('Instances', HUE.instances, [
      ...callsOf(['bs_instance_create_stmt', 'bs_instance_create', 'bs_destroy', 'bs_instance_exists',
        'bs_instance_number', 'bs_instance_find', 'bs_instance_list', 'bs_instance_nearest']),
      toolboxBlock('bs_get_field_of', { INST: selfShadow() }, { FIELD: 'x' }),
      toolboxBlock('bs_set_field_of', { INST: selfShadow(), VALUE: numberShadow(0) }, { FIELD: 'x' }),
      ...callsOf(['bs_instance_new_stmt', 'bs_instance_new']),
      toolboxBlock('bs_set_parent', { INST: selfShadow(), PARENT: selfShadow() }),
      toolboxBlock('bs_get_parent', { INST: selfShadow() }),
      ...callsOf(['bs_find_first_child', 'bs_get_children', 'bs_is_a']),
      toolboxBlock('bs_get_name', { INST: selfShadow() }),
      toolboxBlock('bs_set_name', { INST: selfShadow(), NAME: textShadow('name') }),
    ]),
    category('Rooms', HUE.rooms, [
      ...callsOf(['bs_room_goto', 'bs_room_restart', 'bs_room_current', 'bs_room_width', 'bs_room_height',
        'bs_room_speed', 'bs_game_end', 'bs_view_set']),
      toolboxBlock('bs_view_x'),
      toolboxBlock('bs_view_y'),
    ]),
    category('Logic', 210, [
      toolboxBlock('logic_compare'),
      toolboxBlock('logic_operation'),
      toolboxBlock('logic_negate'),
      toolboxBlock('logic_boolean'),
      toolboxBlock('logic_ternary'),
    ]),
    category('Maths', HUE.maths, [
      toolboxBlock('math_number', {}, { NUM: 0 }),
      toolboxBlock('math_arithmetic', { A: numberShadow(1), B: numberShadow(1) }),
      toolboxBlock('math_single', { NUM: numberShadow(9) }),
      toolboxBlock('math_trig', { NUM: numberShadow(45) }),
      toolboxBlock('math_round', { NUM: numberShadow(3.1) }),
      toolboxBlock('math_modulo', { DIVIDEND: numberShadow(64), DIVISOR: numberShadow(10) }),
      toolboxBlock('math_number_property', { NUMBER_TO_CHECK: numberShadow(0) }),
      ...callsOf(['bs_point_distance', 'bs_point_direction', 'bs_lengthdir_x', 'bs_lengthdir_y', 'bs_clamp',
        'bs_lerp', 'bs_approach', 'bs_sign', 'bs_irandom', 'bs_irandom_range', 'bs_random_range',
        'bs_angle_difference', 'bs_wrap', 'bs_choose']),
    ]),
    category('Text', 160, [
      toolboxBlock('text'),
      toolboxBlock('text_join'),
      toolboxBlock('text_length', { VALUE: textShadow('abc') }),
      toolboxBlock('text_isEmpty', { VALUE: textShadow('') }),
      toolboxBlock('text_indexOf', { VALUE: textShadow('abc'), FIND: textShadow('b') }),
      toolboxBlock('text_charAt', { VALUE: textShadow('abc') }),
      toolboxBlock('text_getSubstring', { STRING: textShadow('abc') }),
      toolboxBlock('text_changeCase', { TEXT: textShadow('abc') }),
      toolboxBlock('bs_print', { VALUE: textShadow('hello') }),
    ]),
    category('Lists', 260, [
      toolboxBlock('lists_create_with', {}, undefined),
      toolboxBlock('lists_create_empty'),
      toolboxBlock('lists_repeat', { NUM: numberShadow(5) }),
      toolboxBlock('lists_length'),
      toolboxBlock('lists_isEmpty'),
      toolboxBlock('lists_indexOf'),
      toolboxBlock('lists_getIndex'),
      toolboxBlock('lists_setIndex'),
      toolboxBlock('lists_sort'),
    ]),
    category('Data', HUE.data, [
      ...callsOf(['bs_storage_set', 'bs_storage_get']),
    ]),
    category('Variables', 330, [], { custom: 'VARIABLE' }),
    category('Functions', 290, [], { custom: 'PROCEDURE' }),
  ],
};

// ---- install ----------------------------------------------------------------

let installed = false;

/**
 * Define every custom block and install both generators. Safe to call any
 * number of times; only the first does the work.
 */
export function installBlocks(): void {
  if (installed) return;
  installed = true;

  luaGenerator.INDENT = '\t';
  pythonGenerator.INDENT = '    ';
  // The receiver every event and procedure gets, and the extras the hats bind.
  luaGenerator.addReservedWords('self,other,index,obj');
  pythonGenerator.addReservedWords('self,other,index');

  Blockly.common.defineBlocksWithJsonArray([...CUSTOM_BLOCKS, ...CALL_BLOCKS] as Parameters<typeof Blockly.common.defineBlocksWithJsonArray>[0]);
  installCustomGenerators();
  installVariableAndProcedureOverrides();
  installLuauLoopOverrides();
}
