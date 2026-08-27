/**
 * Checks the manual against the engine.
 *
 * Documentation rots silently, so every name in `src/ui/docsData.ts` is looked
 * up in the Luau sources it claims to describe -- and, in the other direction,
 * every public function the engine defines has to be documented. Renaming
 * something in `prelude.luau` without touching the manual fails here.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` -- ${detail}` : ''}`);
};

const prelude = read('src', 'luau', 'prelude.luau');
const roblox = read('src', 'luau', 'roblox.luau');
const objectEditor = read('src', 'ui', 'objectEditor.ts');
const input = read('src', 'engine', 'input.ts');
const luau = prelude + '\n' + roblox;

const matches = (source, pattern) => [...source.matchAll(pattern)].map((m) => m[1]);

// ---- what the engine actually defines -------------------------------------

/** Globals are `function name(...)`; locals are `local function`. */
const preludeGlobals = new Set(matches(prelude, /^function ([A-Za-z_][A-Za-z0-9_]*)\(/gm));
const robloxGlobals = new Set(matches(roblox, /^function ([A-Za-z_][A-Za-z0-9_]*)\(/gm));
for (const name of matches(roblox, /^([A-Za-z_][A-Za-z0-9_]*) = /gm)) robloxGlobals.add(name);

const publicGlobals = new Set([...preludeGlobals].filter((name) => !name.startsWith('__')));
const colours = new Set(matches(prelude, /^(c_[a-z]+) = /gm));

const instanceMethods = new Set(matches(prelude, /^function InstanceMethods\.([A-Za-z_][A-Za-z0-9_]*)\(/gm));
for (const name of matches(prelude, /^InstanceMethods\.([A-Za-z_][A-Za-z0-9_]*) = /gm)) {
  instanceMethods.add(name);
}

/** The table literal in `make_instance` is the list of built-in fields. */
const instanceFields = (() => {
  const from = prelude.indexOf('local inst = setmetatable({');
  const to = prelude.indexOf('}, InstanceMeta)', from);
  const body = prelude.slice(from, to);
  const found = new Set(matches(body, /^\t\t([A-Za-z_][A-Za-z0-9_]*) = /gm));
  for (const name of [...found]) if (name.startsWith('__')) found.delete(name);
  // Lazily created signals live on the instance too, as do the properties the
  // metatable resolves (`Parent`, `Name`).
  for (const table of ['SIGNAL_FIELDS', 'PROPERTY_FIELDS']) {
    const literal = new RegExp(`local ${table} = \\{([^}]*)\\}`).exec(prelude)?.[1] ?? '';
    for (const name of matches(literal, /([A-Za-z_][A-Za-z0-9_]*) = true/g)) found.add(name);
  }
  return found;
})();

const events = new Set(matches(objectEditor, /\{ name: '([a-z_]+)', label:/g));
const specialKeys = new Set(matches(input, /^  [A-Za-z]+: '([a-z]+)',$/gm));

console.log('\n=== the engine surface the manual has to cover ===');
console.log(
  `   ${publicGlobals.size} globals, ${instanceMethods.size} instance methods, ` +
    `${instanceFields.size} fields, ${colours.size} colours, ${events.size} events`,
);
check('found the prelude globals', publicGlobals.size > 50, String(publicGlobals.size));
check('found the instance methods', instanceMethods.size > 15, String(instanceMethods.size));
check('found the instance fields', instanceFields.size > 20, String(instanceFields.size));

// ---- the Python engine mirrors the Luau one --------------------------------
//
// `src/python/prelude.py` and `roblox.py` are a port of the two Luau files and
// must expose exactly the same names: the same manual documents both, and a
// name one engine has that the other lacks is a bug in the port. Scraped with
// the Python analogues of the Luau conventions -- `def name(` at column 0 for
// globals, `class Instance` methods at four spaces, fields assigned one per
// line in `__init__`, `c_* =` colours -- and compared as sets.

console.log('\n=== the Python engine mirrors the Luau one ===');

const preludePy = read('src', 'python', 'prelude.py');
const robloxPy = read('src', 'python', 'roblox.py');
const isPrivate = (name) => name.startsWith('_');

const pyGlobals = new Set(matches(preludePy, /^def ([A-Za-z][A-Za-z0-9_]*)\(/gm));
const pyColours = new Set(matches(preludePy, /^(c_[a-z]+) = /gm));

/** The `class Instance:` body, up to the next column-0 definition. */
const pyInstanceBody = (() => {
  const from = preludePy.indexOf('\nclass Instance:');
  const after = preludePy.slice(from + 1);
  const end = after.search(/\n(?:class |def |[A-Za-z_][A-Za-z0-9_]* = )/);
  return end < 0 ? after : after.slice(0, end);
})();
const pyTuple = (name) => {
  const literal = new RegExp(`^${name} = \(([^)]*)\)`, 'm').exec(preludePy)?.[1] ?? '';
  return matches(literal, /"([A-Za-z_][A-Za-z0-9_]*)"/g);
};
const pyProperties = new Set([...pyTuple('SIGNAL_FIELDS'), ...pyTuple('PROPERTY_FIELDS')]);

// Static and class methods are namespace members (`Instance.new`), not
// instance methods, so a decorated def is skipped.
const pyStatic = new Set(matches(pyInstanceBody, /^    @(?:static|class)method\n    def ([A-Za-z][A-Za-z0-9_]*)\(/gm));
const pyMethods = new Set();
for (const name of matches(pyInstanceBody, /^    def ([A-Za-z][A-Za-z0-9_]*)\(/gm)) {
  if (!pyProperties.has(name) && !pyStatic.has(name)) pyMethods.add(name);
}
for (const name of matches(pyInstanceBody, /^    ([A-Za-z][A-Za-z0-9_]*) = /gm)) {
  if (!pyProperties.has(name)) pyMethods.add(name);
}

const pyFields = (() => {
  const init = /    def __init__\(self[^)]*\):\n([\s\S]*?)\n    def /.exec(pyInstanceBody)?.[1] ?? '';
  const found = new Set(matches(init, /^        self\.([A-Za-z][A-Za-z0-9_]*) = /gm));
  for (const name of pyProperties) found.add(name);
  return found;
})();

const pyRobloxGlobals = new Set([
  ...matches(robloxPy, /^def ([A-Za-z][A-Za-z0-9_]*)\(/gm),
  ...matches(robloxPy, /^class ([A-Za-z][A-Za-z0-9_]*)[:(]/gm),
  ...matches(robloxPy, /^([A-Za-z][A-Za-z0-9_]*) = /gm),
]);
const luauRobloxGlobals = new Set([...robloxGlobals].filter((name) => !name.startsWith('__')));

const symmetricDifference = (a, b) => [
  ...[...a].filter((x) => !b.has(x)).map((x) => `${x} (luau only)`),
  ...[...b].filter((x) => !a.has(x)).map((x) => `${x} (python only)`),
];
for (const [label, luauSet, pySet] of [
  ['engine globals', publicGlobals, pyGlobals],
  ['instance methods', instanceMethods, pyMethods],
  ['instance fields', instanceFields, pyFields],
  ['colour constants', colours, pyColours],
  ['Roblox globals', luauRobloxGlobals, pyRobloxGlobals],
]) {
  const diff = symmetricDifference(luauSet, pySet);
  check(`both engines define the same ${label}`, diff.length === 0 && luauSet.size > 0, diff.join(', '));
}
check('no private Python helper is scraped as public', ![...pyGlobals, ...pyMethods].some(isPrivate));

// ---- load the manual -------------------------------------------------------

/** Load a TypeScript module in Node, the same way the docs generator does. */
async function loadModule(path) {
  const server = await createServer({
    root,
    configFile: false,
    logLevel: 'error',
    server: { middlewareMode: true, hmr: false },
    // Nothing here needs pre-bundled dependencies, and the scan chokes on the
    // editor's virtual modules.
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    return await server.ssrLoadModule(path);
  } finally {
    await server.close();
  }
}

const { DOCS, ALL_SECTIONS, ALL_ENTRIES } = await loadModule('/src/ui/docsData.ts');

console.log('\n=== the manual ===');
console.log(`   ${DOCS.length} chapters, ${ALL_SECTIONS.length} sections, ${ALL_ENTRIES.length} entries`);

const ids = ALL_SECTIONS.map((section) => section.id);
check('section ids are unique', new Set(ids).size === ids.length, ids.join(','));
check(
  'every section has a blurb',
  ALL_SECTIONS.every((section) => section.blurb?.length > 10),
  ALL_SECTIONS.filter((s) => !(s.blurb?.length > 10)).map((s) => s.id).join(','),
);
check(
  'every entry has a summary',
  ALL_ENTRIES.every((entry) => entry.summary?.length > 5),
  ALL_ENTRIES.filter((e) => !(e.summary?.length > 5)).map((e) => e.name).join(','),
);
// Constants are documented by their value, e.g. `0xFF004D`, so they are exempt.
const needsPunctuation = ALL_ENTRIES.filter((entry) => entry.origin !== 'constant');
check(
  'every entry ends its summary with a full stop',
  needsPunctuation.every((entry) => /[.?]$/.test(entry.summary.trim())),
  needsPunctuation.filter((e) => !/[.?]$/.test(e.summary.trim())).map((e) => e.name).slice(0, 4).join(','),
);

// A name may appear once per origin -- `destroy` is both an event you define
// and a method you call -- but never twice as the same kind of thing.
const keys = ALL_ENTRIES.map((entry) => `${entry.origin}:${entry.name}`);
const duplicates = keys.filter((key, i, all) => all.indexOf(key) !== i);
check('no name is documented twice for the same kind', duplicates.length === 0, duplicates.join(','));

// ---- every documented name exists -----------------------------------------

console.log('\n=== documented -> defined ===');

/**
 * A service or namespace member: `Owner.member`, or a bare method name.
 *
 * Three shapes count, because the Roblox layer uses all three: a declared
 * method, a key in a service table, and an alias assigned afterwards
 * (`ReplicatedStorage.Set = ReplicatedStorage.SetAttribute`).
 */
function memberExists(name) {
  const member = name.includes('.') ? name.split('.').pop() : name;
  return (
    new RegExp(`function\\s+[A-Za-z_][A-Za-z0-9_]*\\.${member}\\s*\\(`).test(luau) ||
    new RegExp(`(^|[\\s{,.])${member}\\s*=`, 'm').test(luau)
  );
}

const missing = [];
for (const entry of ALL_ENTRIES) {
  let ok;
  switch (entry.origin) {
    case 'global':
      ok = publicGlobals.has(entry.name) || robloxGlobals.has(entry.name);
      break;
    case 'method':
      ok = instanceMethods.has(entry.name);
      break;
    case 'field':
      ok = instanceFields.has(entry.name);
      break;
    case 'constant':
      ok = colours.has(entry.name);
      break;
    case 'member':
      ok = memberExists(entry.name);
      break;
    case 'event':
      ok = events.has(entry.name);
      break;
    default:
      ok = false;
  }
  if (!ok) missing.push(`${entry.name} (${entry.origin})`);
}
check('every documented name exists in the engine', missing.length === 0, missing.join(', '));

// ---- and everything that exists is documented ------------------------------

console.log('\n=== defined -> documented ===');

const documented = new Set(ALL_ENTRIES.map((entry) => entry.name));
/** Aliases are covered in the prose of the name they alias. */
const ALIASES = new Set(['Destroy', 'wait', 'GetChildren', 'GetDescendants', 'FindFirstChild']);

const undocumentedGlobals = [...publicGlobals].filter(
  (name) => !documented.has(name) && !ALIASES.has(name),
);
check('every public global is documented', undocumentedGlobals.length === 0, undocumentedGlobals.join(', '));

const undocumentedMethods = [...instanceMethods].filter(
  (name) => !documented.has(name) && !ALIASES.has(name),
);
check('every instance method is documented', undocumentedMethods.length === 0, undocumentedMethods.join(', '));

const undocumentedFields = [...instanceFields].filter((name) => !documented.has(name));
check('every instance field is documented', undocumentedFields.length === 0, undocumentedFields.join(', '));

const undocumentedColours = [...colours].filter((name) => !documented.has(name));
check('every colour constant is documented', undocumentedColours.length === 0, undocumentedColours.join(', '));

const undocumentedEvents = [...events].filter((name) => !documented.has(name));
check('every object event is documented', undocumentedEvents.length === 0, undocumentedEvents.join(', '));

// Key names are a string API with no compiler behind them at all.
const inputSection = ALL_SECTIONS.find((section) => section.id === 'input');
const inputProse = (inputSection.blocks ?? []).map((block) => block.text ?? '').join(' ');
const unlistedKeys = [...specialKeys].filter((key) => !inputProse.includes(`\`${key}\``));
check('every special key name is listed', unlistedKeys.length === 0, unlistedKeys.join(', '));

// ---- autocomplete agrees with the manual ----------------------------------

console.log('\n=== autocomplete ===');

const api = await loadModule('/src/ui/luauApi.ts');

const offeredButMissing = api.ENGINE_FUNCTIONS.filter((entry) => !publicGlobals.has(entry.name));
check(
  'every completion the editor offers exists',
  offeredButMissing.length === 0,
  offeredButMissing.map((e) => e.name).join(', '),
);

const undescribed = api.ENGINE_FUNCTIONS.filter((entry) => !entry.doc);
check(
  'every engine completion carries a description',
  undescribed.length === 0,
  undescribed.map((e) => e.name).join(', '),
);

const methodsUndescribed = api.INSTANCE_METHODS.filter((entry) => !entry.doc);
check(
  'every instance-method completion carries a description',
  methodsUndescribed.length === 0,
  methodsUndescribed.map((e) => e.name).join(', '),
);

// The popup must never paraphrase the manual: where both describe a name, the
// text has to be identical.
const manualSummary = new Map(
  ALL_ENTRIES.filter((entry) => entry.origin !== 'event').map((entry) => [entry.name, entry.summary]),
);
const disagreeing = [...api.ENGINE_FUNCTIONS, ...api.INSTANCE_METHODS, ...api.INSTANCE_FIELDS].filter(
  (entry) => manualSummary.has(entry.name) && entry.doc !== manualSummary.get(entry.name),
);
check(
  'completions quote the manual verbatim',
  disagreeing.length === 0,
  disagreeing.map((e) => e.name).join(', '),
);

check(
  'the offered key names match the ones input.ts produces',
  [...specialKeys].every((key) => api.KEY_NAMES.includes(key)),
  [...specialKeys].filter((k) => !api.KEY_NAMES.includes(k)).join(', '),
);

// ---- the Python axis --------------------------------------------------------
//
// Every sample has a Python twin, and the twin has to be Python: not a Luau
// sample with the colons filed off. There is no Python parser here, so the
// checks are the tells -- Luau keywords and operators that cannot appear in
// valid Python, and indentation that only ever follows a `:`.

console.log('\n=== the Python axis ===');

const blocks = ALL_SECTIONS.flatMap((section) =>
  (section.blocks ?? []).map((block, i) => ({ block, where: `${section.id}#${i}` })),
);

const examplesWithoutPython = ALL_ENTRIES.filter((entry) => entry.example && !entry.pythonExample);
check(
  'every entry with an example has a Python one',
  examplesWithoutPython.length === 0,
  examplesWithoutPython.map((e) => e.name).join(', '),
);

const codeWithoutPython = blocks.filter(({ block }) => block.code && !block.pythonCode);
check(
  'every block with code has Python code',
  codeWithoutPython.length === 0,
  codeWithoutPython.map((b) => b.where).join(', '),
);

const pythonSamples = [
  ...ALL_ENTRIES.filter((entry) => entry.pythonExample).map((entry) => ({
    where: entry.name,
    luau: entry.example,
    python: entry.pythonExample,
  })),
  ...blocks
    .filter(({ block }) => block.pythonCode)
    .map(({ block, where }) => ({ where, luau: block.code, python: block.pythonCode })),
];
check('found the Python samples', pythonSamples.length > 20, String(pythonSamples.length));

/** Things that are Luau, or Lua, and never Python. */
const LUAU_TELLS = [
  [/\blocal /, 'local'],
  [/ then\b/, 'then'],
  [/^\s*end\b|\bend\)?\s*$/m, 'end'],
  [/~=/, '~='],
  [/[^.]\.\.[^.]/, '..'],
  [/\bself:/, 'self:'],
  [/:Connect\(/, ':Connect('],
  [/\bnil\b/, 'nil'],
  [/\belseif\b/, 'elseif'],
  [/--/, '-- comment'],
  [/\bfunction\b/, 'function'],
];

function luauTells(source) {
  return LUAU_TELLS.filter(([pattern]) => pattern.test(source)).map(([, name]) => name);
}

const withTells = pythonSamples
  .map((sample) => ({ ...sample, tells: luauTells(sample.python) }))
  .filter((sample) => sample.tells.length);
check(
  'no Python sample contains Luau syntax',
  withTells.length === 0,
  withTells.map((s) => `${s.where}: ${s.tells.join(' ')}`).join('; '),
);

/**
 * An indented line either continues a bracket left open on the line before,
 * or opens a block -- and a Python block opener ends in `:`. Anything else is
 * not Python.
 */
function badIndent(source) {
  const lines = source.split('\n');
  let previous = null;
  let depth = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    const indent = line.match(/^ */)[0].length;
    if (indent % 4 !== 0 || /^\t/.test(line)) return `"${line.trim()}" is not indented by four spaces`;
    if (previous !== null && indent > previous.indent && depth === 0) {
      const code = previous.line.replace(/#.*$/, '').trimEnd();
      if (!code.endsWith(':') && !code.endsWith('\\')) return `"${line.trim()}" follows "${code.trim()}"`;
    }
    for (const ch of line.replace(/"[^"]*"|'[^']*'/g, '').replace(/#.*$/, '')) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth--;
    }
    previous = { line, indent };
  }
  return depth === 0 ? null : 'brackets left open';
}

const badlyIndented = pythonSamples
  .map((sample) => ({ ...sample, problem: badIndent(sample.python) }))
  .filter((sample) => sample.problem);
check(
  'every Python sample indents like Python',
  badlyIndented.length === 0,
  badlyIndented.map((s) => `${s.where}: ${s.problem}`).join('; '),
);

// The Python sample is the Luau sample in another syntax, so the engine names
// it reaches for have to be the same ones -- in both directions.
const engineNames = new Set([
  ...publicGlobals,
  ...robloxGlobals,
  ...instanceMethods,
  ...instanceFields,
  ...colours,
  ...ALL_ENTRIES.flatMap((entry) => entry.name.split('.')),
]);
const engineNamesIn = (source) =>
  new Set([...source.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]).filter((n) => engineNames.has(n)));

const drifted = pythonSamples
  .map((sample) => {
    const luau = engineNamesIn(sample.luau);
    const python = engineNamesIn(sample.python);
    const onlyLuau = [...luau].filter((n) => !python.has(n));
    const onlyPython = [...python].filter((n) => !luau.has(n));
    return { ...sample, onlyLuau, onlyPython };
  })
  .filter((sample) => sample.onlyLuau.length || sample.onlyPython.length);
check(
  'a Python sample uses the same engine names as its Luau twin',
  drifted.length === 0,
  drifted
    .map((s) => `${s.where}: luau-only [${s.onlyLuau}] python-only [${s.onlyPython}]`)
    .join('; '),
);

// The mode has its own section, and it carries samples in both languages.
const pythonSection = ALL_SECTIONS.find((section) => section.id === 'python-mode');
check('the manual has a Python mode section', Boolean(pythonSection));
check(
  'the Python mode section shows both languages',
  Boolean(pythonSection?.blocks?.some((block) => block.code && block.pythonCode)),
);

const pyApi = await loadModule('/src/ui/pythonApi.ts');
const pyDisagreeing = pyApi.PY_GLOBAL_COMPLETIONS.filter(
  (entry) =>
    // Colour constants are documented by their value; the popup says "Colour constant".
    entry.kind !== 'constant' && manualSummary.has(entry.name) && entry.doc !== manualSummary.get(entry.name),
);
check(
  'Python completions quote the manual verbatim',
  pyDisagreeing.length === 0,
  pyDisagreeing.map((e) => e.name).join(', '),
);

// ---- the generated markdown is current -------------------------------------

console.log('\n=== docs/ ===');
const generated = spawnSync(process.execPath, [join(root, 'tools', 'build-docs.mjs'), '--check'], {
  cwd: root,
  encoding: 'utf8',
});
check(
  'the markdown in docs/ is up to date',
  generated.status === 0,
  (generated.stderr || generated.stdout || '').trim().split('\n')[0],
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
