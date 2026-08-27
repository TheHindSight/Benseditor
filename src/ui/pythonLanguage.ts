import { ENGINE_SET, SERVICE_NAMES } from './apiSurface';
import type { LanguageSpec, NewlineContext, NewlineEdit } from './languageSpec';
import { PY_BUILTIN_SET, PY_GLOBAL_COMPLETIONS, PY_KEYWORD_SET, pyMembersFor } from './pythonApi';
import { tokenizePython } from './pythonSyntax';
import { isCode } from './syntaxCore';

/** The Python editor's language spec. */

const INDENT = '    ';

/** Typing an opener inserts its partner; typing the closer steps over it. */
const PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
};
const CLOSERS = new Set(Object.values(PAIRS));

/**
 * Statements that end a block: the line after a bare `return` is one level
 * out. Only when it is the line's first word -- `if done: return` is an `if`.
 */
const BLOCK_ENDERS = /^[\t ]*(return|pass|break|continue|raise)\b/;

/** `indent` with one level taken off the end: a unit of spaces, or a tab. */
function outdent(indent: string): string {
  if (indent.endsWith(INDENT)) return indent.slice(0, -INDENT.length);
  if (indent.endsWith('\t')) return indent.slice(0, -1);
  return indent.replace(/ +$/, '');
}

/**
 * Enter keeps the current indentation, adds a level after a `:` or an open
 * bracket, and takes one off after a statement that ends the block.
 *
 * Python has no closing keyword, so nothing is ever written on the line after
 * -- except the partner of a freshly typed bracket, which goes on its own line
 * exactly as it does in Luau.
 */
function newline(ctx: NewlineContext): NewlineEdit {
  const { tokens, selectionStart, lineStart, textToCaret: line, indent, nextChar, rest } = ctx;

  // Ignore a trailing comment when deciding whether a block was opened. The
  // tokens say where it starts, so a `#` inside a string does not count.
  let code = line;
  for (const token of tokens) {
    if (token.start >= selectionStart) break;
    if (token.end <= lineStart || token.cls !== 'tok-comment') continue;
    code = line.slice(0, Math.max(0, token.start - lineStart));
    break;
  }
  code = code.trimEnd();

  // The colon or bracket has to be real code: `x = "a:` is a broken string.
  const lastIsCode = code.length > 0 && isCode(tokens, lineStart + code.length - 1);
  const opensBracket = lastIsCode && /[({[]$/.test(code);
  const opensBlock = opensBracket || (lastIsCode && code.endsWith(':'));

  if (opensBlock) {
    const inner = '\n' + indent + INDENT;
    const caret = selectionStart + inner.length;
    // Pressing Enter between a freshly opened pair puts the closer on its own
    // line: `(|)` becomes `(`, an indented blank line, then `)`.
    if (opensBracket && CLOSERS.has(nextChar)) {
      return { text: `${inner}\n${indent}`, caret };
    }
    return { text: inner, caret };
  }

  // Only when the rest of the line is empty -- splitting `return | x` in half
  // is not the end of a block.
  const endsBlock = rest.trim() === '' && BLOCK_ENDERS.test(code);
  const inner = '\n' + (endsBlock ? outdent(indent) : indent);
  return { text: inner, caret: selectionStart + inner.length };
}

export const PYTHON_LANGUAGE: LanguageSpec = {
  id: 'python',
  label: 'Python',
  extension: 'py',

  indent: INDENT,
  pairs: PAIRS,
  lineComment: '#',

  tokenize: tokenizePython,
  newline,

  /**
   * Pull `else`, `elif`, `except` and `finally` back one level as they are
   * typed, so they line up with the `if` or `try` that opened them.
   *
   * The editor rebuilds the line as `group1.slice(0, -1) + group2`: it drops
   * the last character of group 1 and whatever lies between the groups. A
   * level here is four spaces, so group 1 is made to end one character into
   * the indent unit and the pattern leaves the other three uncaptured -- the
   * lazy `*?` forces that split. A tab unit still comes off as one character.
   */
  dedentPattern: /^([\t ]*?(?: |\t)) {0,3}(else|elif|except|finally)$/,

  globalCompletions: PY_GLOBAL_COMPLETIONS,
  memberAccessors: ['.'],
  membersFor: pyMembersFor,
  // `GetService("` only ever takes a service, so do not bury those seven
  // names among every asset in the project.
  serviceCallPattern: /GetService\s*\(\s*["']$/,
  serviceNames: SERVICE_NAMES,

  keywords: PY_KEYWORD_SET,
  builtins: PY_BUILTIN_SET,
  engineNames: ENGINE_SET,

  /**
   * A traceback lists frames outermost first; the last `File "x.py", line N`
   * is where the error actually happened.
   */
  parseError(message) {
    let found: { name: string; line: number } | null = null;
    for (const match of message.matchAll(/File "([^"]+?)\.py", line (\d+)/g)) {
      found = { name: match[1], line: Number(match[2]) };
    }
    return found;
  },
  compilingText: 'Compiling Python and building the atlas…',
};
