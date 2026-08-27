/**
 * Checks the Python tokeniser, language spec and completion tables.
 *
 * The editor's every question -- is the caret in a string, does this line
 * open a block, which word earns a dedent -- rests on the token invariants in
 * `syntaxCore.ts`, so the tokeniser is thrown adversarial input first, and
 * the spec's behaviour is exercised the way `codeEditor.ts` drives it.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${!ok && detail ? ` -- ${detail}` : ''}`);
};

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

const { tokenizePython, highlightPython } = await loadModule('/src/ui/pythonSyntax.ts');
const { PYTHON_LANGUAGE } = await loadModule('/src/ui/pythonLanguage.ts');
const { pyMembersFor, PY_GLOBAL_COMPLETIONS } = await loadModule('/src/ui/pythonApi.ts');
const { isCaretInCode, isCaretInString } = await loadModule('/src/ui/syntaxCore.ts');

// ---- token invariants -------------------------------------------------------

console.log('\n=== token invariants ===');

/** Every invariant `syntaxCore.ts` promises, or the first one broken. */
function invariantsBroken(source, tokens) {
  let previousEnd = 0;
  for (const [i, token] of tokens.entries()) {
    if (!(token.start >= 0 && token.end <= source.length)) return `token ${i} out of bounds`;
    if (!(token.start < token.end)) return `token ${i} is empty or reversed`;
    if (token.start < previousEnd) return `token ${i} overlaps its predecessor`;
    previousEnd = token.end;
  }
  return '';
}

const NASTY = {
  'nested quotes': `s = "it's" + 'say "hi"' + "a \\" b" + '\\''`,
  'hash inside strings': `x = "# not a comment" # real comment\ny = '#' # again`,
  'triple quotes across lines': `doc = """line one\n'quoted' # not a comment\nline three""" + 1\nz = '''a\nb'''`,
  'unterminated quote contained': `a = 'oops\nb = 2 # after\nc = "also oops\nd = 3`,
  'f-strings with braces': `t = f"Score {storage.Get('score', 0)} {{literal}}" + rf'\\d{x}' + F"{a!r:>{w}}"`,
  'hex and underscore numbers': `n = 0xFF_FF + 0b1010_1 + 0o7_7 + 1_000_000 + 3.14e-2_0 + .5 + 2j + 1e5J`,
  'unicode identifiers': `café = 1\nπ = 3.14159\ndef naïve(self): return café * π`,
  // A raw string still cannot end on a lone backslash, so `rb'\\d'` is the form.
  'string prefixes': `a = b'x' + B"y" + rb'\\\\d' + Br"z" + u'w' + bf"not a prefix"`,
  'backslash newline in string': `s = 'one \\\ntwo'\nafter = 1`,
  'unterminated triple': `s = """never closed\nx = 1\n# still string`,
  'empty': '',
  'only comment': '# nothing here',
};

for (const [label, source] of Object.entries(NASTY)) {
  const tokens = tokenizePython(source);
  check(`invariants hold: ${label}`, invariantsBroken(source, tokens) === '', invariantsBroken(source, tokens));
}

// A long file with one missing quote must still tokenise sanely (contained
// to its line), and quickly.
const big = 'x = 1 # note\n'.repeat(2000) + "y = 'unterminated\n" + 'z = 2\n'.repeat(2000);
const bigTokens = tokenizePython(big);
check('big file with one stray quote keeps invariants', invariantsBroken(big, bigTokens) === '');
check(
  'the stray quote does not swallow the rest of the file',
  bigTokens.filter((t) => t.cls === 'tok-string').every((t) => !big.slice(t.start, t.end).includes('\n')),
);

// ---- class assignment ------------------------------------------------------

console.log('\n=== classes ===');

/** Class of the token covering the first occurrence of `word` in `source`. */
const classOf = (source, word, tokens = tokenizePython(source)) => {
  const at = source.indexOf(word);
  const token = tokens.find((t) => t.start === at);
  return token ? token.cls : `(no token at ${at})`;
};

const sample = [
  'import math  # helper',
  'SPEED = 0x1F',
  'def step(self, other):',
  '    if self.hspeed != 0 and not keyboard_check("left"):',
  '        print(len(instance_list("obj_wall")))',
  '    return None',
  'class Thing:',
  '    pass',
  'name = f"hello {SPEED}"',
  'match = 1',
].join('\n');
const sampleTokens = tokenizePython(sample);

check('def is a keyword', classOf(sample, 'def', sampleTokens) === 'tok-keyword');
check('if is a keyword', classOf(sample, 'if', sampleTokens) === 'tok-keyword');
check('return is a keyword', classOf(sample, 'return', sampleTokens) === 'tok-keyword');
check('None is a keyword', classOf(sample, 'None', sampleTokens) === 'tok-keyword');
check('class is a keyword', classOf(sample, 'class', sampleTokens) === 'tok-keyword');
check('self is tok-self', classOf(sample, 'self', sampleTokens) === 'tok-self');
check('def name is tok-fn', classOf(sample, 'step', sampleTokens) === 'tok-fn');
check('class name is tok-fn', classOf(sample, 'Thing', sampleTokens) === 'tok-fn');
check('engine function is tok-engine', classOf(sample, 'keyboard_check', sampleTokens) === 'tok-engine');
check('engine function is tok-engine (2)', classOf(sample, 'instance_list', sampleTokens) === 'tok-engine');
check('print is a builtin', classOf(sample, 'print', sampleTokens) === 'tok-builtin');
check('len is a builtin', classOf(sample, 'len', sampleTokens) === 'tok-builtin');
check('math is a builtin', classOf(sample, 'math', sampleTokens) === 'tok-builtin');
check('comment is tok-comment', classOf(sample, '# helper', sampleTokens) === 'tok-comment');
check('string is tok-string', classOf(sample, '"left"', sampleTokens) === 'tok-string');
check('f-string starts at its prefix', classOf(sample, 'f"hello', sampleTokens) === 'tok-string');
check('hex number is tok-number', classOf(sample, '0x1F', sampleTokens) === 'tok-number');
check('match is an identifier, not a keyword', classOf(sample, 'match', sampleTokens) === null);

const fstringToken = sampleTokens.find((t) => t.start === sample.indexOf('f"hello'));
check(
  'f-string interior is one string token',
  fstringToken && sample.slice(fstringToken.start, fstringToken.end) === 'f"hello {SPEED}"',
);

const hashInString = NASTY['hash inside strings'];
const hashTokens = tokenizePython(hashInString);
check(
  '# inside a string is part of the string',
  hashTokens.find((t) => t.start === hashInString.indexOf('"# not'))?.cls === 'tok-string' &&
    hashTokens.find((t) => t.start === hashInString.indexOf('# real'))?.cls === 'tok-comment',
);

const triple = NASTY['triple quotes across lines'];
const tripleTokens = tokenizePython(triple);
const tripleToken = tripleTokens.find((t) => t.start === triple.indexOf('"""'));
check(
  'triple-quoted string spans lines and ends at its closer',
  tripleToken && triple.slice(tripleToken.start, tripleToken.end) === `"""line one\n'quoted' # not a comment\nline three"""`,
);

const contained = NASTY['unterminated quote contained'];
const containedTokens = tokenizePython(contained);
const stray = containedTokens.find((t) => t.start === contained.indexOf("'oops"));
check(
  "an unterminated ' ends at its line",
  stray && contained.slice(stray.start, stray.end) === "'oops",
  stray && JSON.stringify(contained.slice(stray.start, stray.end)),
);
check(
  'the line after an unterminated string is code again',
  containedTokens.find((t) => t.start === contained.indexOf('# after'))?.cls === 'tok-comment',
);

const numbers = NASTY['hex and underscore numbers'];
const numberTokens = tokenizePython(numbers).filter((t) => t.cls === 'tok-number');
check(
  'every numeric literal is one number token',
  numberTokens.map((t) => numbers.slice(t.start, t.end)).join(' ') ===
    '0xFF_FF 0b1010_1 0o7_7 1_000_000 3.14e-2_0 .5 2j 1e5J',
  numberTokens.map((t) => numbers.slice(t.start, t.end)).join(' '),
);

const prefixes = NASTY['string prefixes'];
const prefixTokens = tokenizePython(prefixes).filter((t) => t.cls === 'tok-string');
check(
  'rb/Br prefixes belong to their strings, bf does not',
  prefixTokens.map((t) => prefixes.slice(t.start, t.end)).join(' ') ===
    `b'x' B"y" rb'\\\\d' Br"z" 'w' "not a prefix"`,
  prefixTokens.map((t) => prefixes.slice(t.start, t.end)).join(' '),
);

check('highlightPython escapes and wraps', highlightPython('x = "<b>"').includes('<span class="tok-string">"&lt;b&gt;"</span>'));

// ---- caret conventions -----------------------------------------------------

console.log('\n=== caret ===');

const caretSource = 'print("hi") # note';
const caretTokens = tokenizePython(caretSource);
const quoteAt = caretSource.indexOf('"');
const hashAt = caretSource.indexOf('#');
check('caret before the opening quote is code', isCaretInCode(caretTokens, quoteAt));
check('caret before the opening quote is not in string', !isCaretInString(caretTokens, quoteAt));
check('caret one past the opening quote is in string', isCaretInString(caretTokens, quoteAt + 1));
check('caret one past the opening quote is not code', !isCaretInCode(caretTokens, quoteAt + 1));
check('caret at the closing quote is still in string', isCaretInString(caretTokens, caretSource.indexOf('")')));
check('caret after the closing quote is code', isCaretInCode(caretTokens, caretSource.indexOf(')')));
check('caret at the start of a comment is code', isCaretInCode(caretTokens, hashAt));
check('caret inside a comment is not code', !isCaretInCode(caretTokens, hashAt + 1));
check('caret at end of file is code', isCaretInCode(caretTokens, caretSource.length));

// ---- newline ---------------------------------------------------------------

console.log('\n=== newline ===');

/** Build the context `codeEditor.insertNewline` builds, with `|` marking the caret. */
function pressEnter(marked) {
  const selectionStart = marked.indexOf('|');
  const source = marked.slice(0, selectionStart) + marked.slice(selectionStart + 1);
  const lineStart = source.lastIndexOf('\n', selectionStart - 1) + 1;
  let lineEnd = source.indexOf('\n', selectionStart);
  if (lineEnd === -1) lineEnd = source.length;
  const line = source.slice(lineStart, selectionStart);
  const edit = PYTHON_LANGUAGE.newline({
    source,
    tokens: PYTHON_LANGUAGE.tokenize(source),
    selectionStart,
    selectionEnd: selectionStart,
    lineStart,
    textToCaret: line,
    indent: /^[\t ]*/.exec(line)[0],
    nextChar: source[selectionStart] ?? '',
    rest: source.slice(selectionStart, lineEnd),
    lineEnd,
  });
  const result = source.slice(0, selectionStart) + edit.text + source.slice(selectionStart);
  return { edit, result, caretText: result.slice(0, edit.caret) + '|' + result.slice(edit.caret) };
}

const S4 = '    ';

let r = pressEnter('def step(self):|');
check('after def: newline plus one indent level', r.edit.text === '\n' + S4, JSON.stringify(r.edit.text));
check('after def: caret at end of the new indent', r.caretText === 'def step(self):\n' + S4 + '|');
check('after def: no closer written', !r.result.includes('end'));

r = pressEnter('def step(self):\n    if x:|');
check('nested colon adds a level to the current indent', r.edit.text === '\n' + S4 + S4, JSON.stringify(r.edit.text));

r = pressEnter('    x = 1|');
check('plain statement keeps its indent', r.edit.text === '\n' + S4, JSON.stringify(r.edit.text));

r = pressEnter('    x = 1  # trailing: comment|');
check('a colon inside a trailing comment does not open a block', r.edit.text === '\n' + S4, JSON.stringify(r.edit.text));

r = pressEnter('    x = "a:"  # c|');
check('a colon inside a string does not open a block', r.edit.text === '\n' + S4, JSON.stringify(r.edit.text));

r = pressEnter('    x = "#:"|');
check('a # inside a string is not stripped as a comment (colon is in the string)', r.edit.text === '\n' + S4, JSON.stringify(r.edit.text));

r = pressEnter('        return|');
check('bare return dedents the next line', r.edit.text === '\n' + S4, JSON.stringify(r.edit.text));

r = pressEnter('        return self.x + 1|');
check('return with an expression dedents too', r.edit.text === '\n' + S4, JSON.stringify(r.edit.text));

r = pressEnter('        return_value = 1|');
check('return_value is not a return', r.edit.text === '\n' + S4 + S4, JSON.stringify(r.edit.text));

r = pressEnter('        if done: return|');
check('return after an if on the same line does not dedent', r.edit.text === '\n' + S4 + S4, JSON.stringify(r.edit.text));

r = pressEnter('        return| x');
check('splitting a return in half keeps the indent', r.edit.text === '\n' + S4 + S4, JSON.stringify(r.edit.text));

r = pressEnter('    pass|');
check('pass dedents to column 0', r.edit.text === '\n', JSON.stringify(r.edit.text));

r = pressEnter('\t\tbreak|');
check('tab-indented break drops one tab', r.edit.text === '\n\t', JSON.stringify(r.edit.text));

r = pressEnter('    view_set(|)');
check('Enter between (|) splits onto three lines', r.result === '    view_set(\n' + S4 + S4 + '\n' + S4 + ')', JSON.stringify(r.result));
check('Enter between (|) leaves the caret on the middle line', r.caretText === '    view_set(\n' + S4 + S4 + '|\n' + S4 + ')');

r = pressEnter('d = {|}');
check('Enter between {|} splits onto three lines', r.result === 'd = {\n' + S4 + '\n}', JSON.stringify(r.result));

r = pressEnter('f(|b)');
check('an open bracket with more on the line just indents', r.edit.text === '\n' + S4, JSON.stringify(r.edit.text));

r = pressEnter('f(a,|b)');
check('a trailing comma is not an opener', r.edit.text === '\n', JSON.stringify(r.edit.text));

r = pressEnter('items = [|');
check('open bracket at end of line indents, no closer', r.result === 'items = [\n' + S4, JSON.stringify(r.result));

// ---- dedent pattern --------------------------------------------------------

console.log('\n=== dedentPattern ===');

/** What `codeEditor.maybeDedent` writes back, or null when the pattern misses. */
function dedented(text) {
  const match = PYTHON_LANGUAGE.dedentPattern.exec(text);
  return match ? match[1].slice(0, -1) + match[2] : null;
}

check('matches 8-space else', PYTHON_LANGUAGE.dedentPattern.test(S4 + S4 + 'else'));
check('matches 4-space elif', PYTHON_LANGUAGE.dedentPattern.test(S4 + 'elif'));
check('does not match 4-space x', !PYTHON_LANGUAGE.dedentPattern.test(S4 + 'x'));
check('does not match else at column 0', !PYTHON_LANGUAGE.dedentPattern.test('else'));
check('does not match elsewhere', !PYTHON_LANGUAGE.dedentPattern.test(S4 + 'elsewhere'));
check('8-space else pulls back a whole level', dedented(S4 + S4 + 'else') === S4 + 'else', JSON.stringify(dedented(S4 + S4 + 'else')));
check('4-space elif pulls back to column 0', dedented(S4 + 'elif') === 'elif', JSON.stringify(dedented(S4 + 'elif')));
check('12-space except pulls back one level', dedented(S4 + S4 + S4 + 'except') === S4 + S4 + 'except');
check('8-space finally pulls back one level', dedented(S4 + S4 + 'finally') === S4 + 'finally');
check('two tabs pull back one tab', dedented('\t\telse') === '\telse', JSON.stringify(dedented('\t\telse')));
check('a tab then four spaces drops the spaces', dedented('\t    else') === '\telse', JSON.stringify(dedented('\t    else')));
check('an odd two-space indent goes to column 0', dedented('  else') === 'else', JSON.stringify(dedented('  else')));

// ---- parseError ------------------------------------------------------------

console.log('\n=== parseError ===');

const traceback =
  'Traceback (most recent call last):\n' +
  '  File "<stdin>", line 4, in <module>\n' +
  '  File "obj_controller.py", line 9, in step\n' +
  '  File "obj_player.py", line 2, in step\n' +
  'ZeroDivisionError: divide by zero';
const where = PYTHON_LANGUAGE.parseError(traceback);
check('innermost frame wins', where && where.name === 'obj_player' && where.line === 2, JSON.stringify(where));
check('no frame gives null', PYTHON_LANGUAGE.parseError('SyntaxError: invalid syntax') === null);
check(
  'a stdin-only traceback gives null',
  PYTHON_LANGUAGE.parseError('  File "<stdin>", line 4, in <module>\nNameError: x') === null,
);

// ---- completion tables -----------------------------------------------------

console.log('\n=== completions ===');

const names = (entries) => entries.map((e) => e.name);
const selfMembers = names(pyMembersFor('self', '.'));
check("self. offers fields", selfMembers.includes('x') && selfMembers.includes('hspeed'));
check("self. offers methods", selfMembers.includes('place_meeting') && selfMembers.includes('destroy'));
check("self. offers signals", selfMembers.includes('Destroying') && selfMembers.includes('Connect'));
check('task. offers spawn', names(pyMembersFor('task', '.')).includes('spawn'));
check('game. offers GetService', names(pyMembersFor('game', '.')).includes('GetService'));
check('Workspace. is the same as workspace.', names(pyMembersFor('Workspace', '.')).includes('CountOf'));
const other = names(pyMembersFor('store', '.'));
check('an unknown receiver offers instance and DataStore members', other.includes('x') && other.includes('SetAsync') && other.includes('Connect'));
check('an undefined receiver offers something', names(pyMembersFor(undefined, '.')).length > 0);

const engineEntries = PY_GLOBAL_COMPLETIONS.filter((e) => e.kind === 'function' && !['require', 'wait'].includes(e.name));
const undescribed = engineEntries.filter((e) => !e.doc);
check('every engine completion carries a description', undescribed.length === 0, names(undescribed).join(', '));
check('keywords are offered', PY_GLOBAL_COMPLETIONS.some((e) => e.name === 'elif' && e.kind === 'keyword'));
check('builtins are offered', PY_GLOBAL_COMPLETIONS.some((e) => e.name === 'len'));
check('colours are offered', PY_GLOBAL_COMPLETIONS.some((e) => e.name === 'c_white' && e.kind === 'constant'));
check('task.spawn quotes the manual', pyMembersFor('task', '.').find((e) => e.name === 'spawn')?.doc?.length > 5);

// ---- spec shape ------------------------------------------------------------

console.log('\n=== spec ===');
check('id, label, extension', PYTHON_LANGUAGE.id === 'python' && PYTHON_LANGUAGE.label === 'Python' && PYTHON_LANGUAGE.extension === 'py');
check('four-space indent', PYTHON_LANGUAGE.indent === S4);
check('no backtick pair', !('`' in PYTHON_LANGUAGE.pairs) && PYTHON_LANGUAGE.pairs['('] === ')');
check('line comment is #', PYTHON_LANGUAGE.lineComment === '#');
check('only the dot accessor', PYTHON_LANGUAGE.memberAccessors.length === 1 && PYTHON_LANGUAGE.memberAccessors[0] === '.');
check('service call pattern hits', PYTHON_LANGUAGE.serviceCallPattern.test('game.GetService("'));
check('engineNames knows instance_create', PYTHON_LANGUAGE.engineNames.has('instance_create'));
check('keywords knows elif', PYTHON_LANGUAGE.keywords.has('elif'));
check('builtins knows print', PYTHON_LANGUAGE.builtins.has('print'));

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
