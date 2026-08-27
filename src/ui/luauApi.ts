/**
 * The Luau-specific side of the API surface: the language's own keywords and
 * builtins, and what `.` and `:` mean after a receiver.
 *
 * The engine's tables -- functions, instance members, services, key names --
 * are in `apiSurface.ts` and re-exported here, so `import ... from './luauApi'`
 * resolves everything it always has.
 */
import {
  COLOURS,
  DATASTORE_METHODS,
  ENGINE_FUNCTIONS,
  INSTANCE_FIELDS,
  INSTANCE_METHODS,
  NAMESPACE_MEMBERS,
  ROBLOX_GLOBALS,
  SIGNAL_METHODS,
  type ApiEntry,
} from './apiSurface';

export * from './apiSurface';

export const KEYWORDS = [
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
  'continue', 'export', 'type',
];

export const BUILTINS = [
  'self', 'math', 'table', 'string', 'buffer', 'os', 'bit32', 'pairs', 'ipairs', 'next',
  'tonumber', 'tostring', 'typeof', 'select', 'error', 'assert', 'pcall', 'setmetatable',
  'getmetatable', 'rawget', 'rawset', 'print',
];

/** Fast membership sets for the highlighter. */
export const KEYWORD_SET = new Set(KEYWORDS);
export const BUILTIN_SET = new Set(BUILTINS);

/** Everything completable at the top level of a script. */
export const GLOBAL_COMPLETIONS: ApiEntry[] = [
  ...ENGINE_FUNCTIONS,
  ...ROBLOX_GLOBALS,
  ...COLOURS.map((name) => ({ name, kind: 'constant' as const, doc: 'Colour constant' })),
  ...KEYWORDS.map((name) => ({ name, kind: 'keyword' as const })),
  ...BUILTINS.map((name) => ({ name, kind: 'field' as const })),
];

/**
 * Members offered after `.` or `:`.
 *
 * `owner` is the identifier written before the accessor. Unknown receivers fall
 * back to instance members plus signal and DataStore methods, which covers the
 * common case of a value held in a local.
 */
export function membersFor(owner: string | undefined, accessor: ':' | '.'): ApiEntry[] {
  if (owner && NAMESPACE_MEMBERS[owner]) {
    return NAMESPACE_MEMBERS[owner];
  }
  if (owner === 'self') {
    return accessor === ':'
      ? [...INSTANCE_METHODS, ...SIGNAL_METHODS]
      : [...INSTANCE_FIELDS, ...INSTANCE_METHODS];
  }
  if (accessor === ':') {
    return [...INSTANCE_METHODS, ...SIGNAL_METHODS, ...DATASTORE_METHODS];
  }
  return [...INSTANCE_FIELDS, ...SIGNAL_METHODS];
}
