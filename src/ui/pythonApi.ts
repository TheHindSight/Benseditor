/**
 * The Python-specific side of the API surface: the language's own keywords
 * and builtins, and what `.` means after a receiver.
 *
 * The engine's tables -- functions, instance members, services, key names --
 * are in `apiSurface.ts` and are used here as they are, so the completion
 * popup quotes the manual exactly the way the Luau one does.
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

/**
 * Python 3's reserved words. `match` and `case` are soft keywords -- valid
 * variable names -- so they are deliberately left out and highlight as plain
 * identifiers.
 */
export const PY_KEYWORDS = [
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise',
  'return', 'try', 'while', 'with', 'yield',
];

/**
 * The builtins a game script is likely to reach for. `self` is here for the
 * same reason it is in the Luau list: so the popup offers it at the top level.
 */
export const PY_BUILTINS = [
  'self', 'print', 'len', 'range', 'int', 'float', 'str', 'bool', 'list', 'dict', 'set',
  'tuple', 'abs', 'min', 'max', 'round', 'sorted', 'reversed', 'enumerate', 'zip', 'map',
  'filter', 'sum', 'any', 'all', 'isinstance', 'super', 'object', 'type', 'iter', 'next',
  'hasattr', 'getattr', 'setattr', 'repr', 'chr', 'ord', 'hex', 'divmod', 'pow', 'id',
  'callable', 'format', 'slice', 'bytes', 'bytearray', 'frozenset', 'input',
  'math', 'random',
  'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'AttributeError',
  'ZeroDivisionError', 'RuntimeError', 'StopIteration', 'NotImplementedError',
];

/** Fast membership sets for the highlighter. */
export const PY_KEYWORD_SET = new Set(PY_KEYWORDS);
export const PY_BUILTIN_SET = new Set(PY_BUILTINS);

/** Everything completable at the top level of a script. */
export const PY_GLOBAL_COMPLETIONS: ApiEntry[] = [
  ...ENGINE_FUNCTIONS,
  ...ROBLOX_GLOBALS,
  ...COLOURS.map((name) => ({ name, kind: 'constant' as const, doc: 'Colour constant' })),
  ...PY_KEYWORDS.map((name) => ({ name, kind: 'keyword' as const })),
  ...PY_BUILTINS.map((name) => ({ name, kind: 'field' as const })),
];

/** `NAMESPACE_MEMBERS` is keyed by `workspace`; the capitalised alias means the same thing. */
const NAMESPACE_ALIASES: Record<string, string> = { Workspace: 'workspace' };

/**
 * Members offered after `.`.
 *
 * Python has one accessor for fields and methods alike, so there is no `:`
 * split: `self.` offers everything an instance has, a known namespace offers
 * its own members, and anything else -- a value held in a local -- gets the
 * instance members plus the signal and DataStore methods.
 */
export function pyMembersFor(owner: string | undefined, _accessor: string): ApiEntry[] {
  if (owner) {
    const namespace = NAMESPACE_MEMBERS[NAMESPACE_ALIASES[owner] ?? owner];
    if (namespace) return namespace;
  }
  if (owner === 'self') {
    return [...INSTANCE_FIELDS, ...INSTANCE_METHODS, ...SIGNAL_METHODS];
  }
  return [...INSTANCE_FIELDS, ...INSTANCE_METHODS, ...SIGNAL_METHODS, ...DATASTORE_METHODS];
}
