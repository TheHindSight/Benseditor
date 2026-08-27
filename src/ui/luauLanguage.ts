import { BUILTIN_SET, ENGINE_SET, GLOBAL_COMPLETIONS, KEYWORD_SET, SERVICE_NAMES, membersFor } from './luauApi';
import { tokenizeLuau } from './luauSyntax';
import type { Token } from './syntaxCore';
import type { LanguageSpec, NewlineContext, NewlineEdit } from './languageSpec';

/** The Luau editor's language spec, assembled from the pieces it always had. */

const INDENT = '\t';

/** Typing an opener inserts its partner; typing the closer steps over it. */
const PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
  '`': '`',
};
const CLOSERS = new Set(Object.values(PAIRS));

/**
 * How far a stretch of code opens or closes blocks.
 *
 * Counted from the tokens, so a `function` inside a comment or a string does
 * not register. `for` and `while` are deliberately not counted: they always
 * carry a `do`, and counting both would double up.
 */
function keywordBalance(
  value: string,
  tokens: Token[],
  from: number,
  to: number,
): { blocks: number; repeats: number } {
  let blocks = 0;
  let repeats = 0;

  for (const token of tokens) {
    if (token.start >= to) break;
    if (token.end <= from || token.cls !== 'tok-keyword') continue;

    switch (value.slice(token.start, token.end)) {
      case 'function':
      case 'if':
      case 'do':
        blocks++;
        break;
      case 'end':
        blocks--;
        break;
      case 'repeat':
        repeats++;
        break;
      case 'until':
        repeats--;
        break;
    }
  }

  return { blocks, repeats };
}

/**
 * Enter keeps the current indentation, adds a level after a block opener, and
 * closes the block for you.
 *
 * The `end` is only written when the file is actually missing one. Typing
 * inside a block that already closes correctly -- which is most editing --
 * adds nothing, so this can never leave a stray `end` behind.
 */
function newline(ctx: NewlineContext): NewlineEdit {
  const { source: value, tokens, selectionStart, lineStart, textToCaret: line, indent, nextChar, rest } = ctx;

  // Ignore a trailing comment when deciding whether a block was opened.
  const code = line.replace(/--.*$/, '').trimEnd();

  const lineBalance = keywordBalance(value, tokens, lineStart, selectionStart);
  const opensBlock =
    lineBalance.blocks > 0 ||
    lineBalance.repeats > 0 ||
    /\b(then|do|else|repeat)$/.test(code) ||
    /[({[]$/.test(code);

  const inner = '\n' + indent + (opensBlock ? INDENT : '');
  const caret = selectionStart + inner.length;

  // Pressing Enter between a freshly opened pair puts the closer on its own
  // line: `{|}` becomes `{`, an indented blank line, then `}`.
  if (opensBlock && CLOSERS.has(nextChar) && /[({[]$/.test(code)) {
    return { text: `${inner}\n${indent}`, caret };
  }

  if (opensBlock) {
    const document = keywordBalance(value, tokens, 0, value.length);
    const closer =
      lineBalance.repeats > 0 && document.repeats > 0
        ? 'until '
        : document.blocks > 0
          ? 'end'
          : null;

    // Only when the rest of the line is empty -- splitting a line in half is
    // not a request to close anything.
    if (closer && rest.trim() === '') {
      return { text: `${inner}\n${indent}${closer}`, caret };
    }
  }

  return { text: inner, caret };
}

export const LUAU_LANGUAGE: LanguageSpec = {
  id: 'luau',
  label: 'Luau',
  extension: 'luau',

  indent: INDENT,
  pairs: PAIRS,
  lineComment: '--',

  tokenize: tokenizeLuau,
  newline,

  /**
   * Pull `end`, `else`, `elseif`, `until` and `}` back one level as they are
   * typed, so a closing keyword lines up with the statement that opened it.
   */
  dedentPattern: /^([\t ]*\t)(end|else|elseif|until|\})$/,

  globalCompletions: GLOBAL_COMPLETIONS,
  memberAccessors: ['.', ':'],
  membersFor: (owner, accessor) => membersFor(owner, accessor as ':' | '.'),
  // `GetService("` only ever takes a service, so do not bury those seven
  // names among every asset in the project.
  serviceCallPattern: /GetService\s*\(\s*["'`]$/,
  serviceNames: SERVICE_NAMES,

  keywords: KEYWORD_SET,
  builtins: BUILTIN_SET,
  engineNames: ENGINE_SET,

  parseError(message) {
    const match = /\[string "([^"]+?)(?:\.luau)?"\]:(\d+)/.exec(message);
    if (!match) return null;
    return { name: match[1], line: Number(match[2]) };
  },
  compilingText: 'Compiling Luau and building the atlas…',
};
