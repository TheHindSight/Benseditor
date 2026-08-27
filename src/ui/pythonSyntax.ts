import { ENGINE_SET } from './apiSurface';
import { PY_BUILTIN_SET, PY_KEYWORD_SET } from './pythonApi';
import { isDigitCode, isWordCode, isWordStartCode, renderTokens, type Token } from './syntaxCore';

/**
 * Python tokeniser, on the same Token contract as `tokenizeLuau`.
 *
 * The same shape as the Luau scanner -- one pass over character codes, a
 * token per comment, string, number and word, nothing for punctuation -- so
 * the editor's questions (is the caret in a string, is this bracket code) get
 * the same answers for both languages.
 *
 * Simplifications, on purpose:
 *
 * - The inside of an f-string is one `tok-string`; the `{expr}` holes are not
 *   tokenised as code.
 * - An unterminated single-quoted string ends at its line, as in Luau, so one
 *   missing quote does not swallow the file. An unterminated triple-quoted
 *   string does run to the end of the file, because that is what it means.
 * - `match` and `case` are soft keywords and highlight as identifiers.
 */

const LF = 10;
const SPACE = 32;
const TAB = 9;
const HASH = 35;
const QUOTE = 34;
const APOSTROPHE = 39;
const BACKSLASH = 92;
const DOT = 46;
const OPEN_PAREN = 40;
const ZERO = 48;
const PLUS = 43;
const DASH = 45;
const UNDERSCORE = 95;
const LOWER_E = 101;
const UPPER_E = 69;
const LOWER_J = 106;
const UPPER_J = 74;

const isHexCode = (code: number) =>
  isDigitCode(code) ||
  (code >= 97 && code <= 102) ||
  (code >= 65 && code <= 70) ||
  code === UNDERSCORE;

/** `0x`, `0b`, `0o` in either case: the letter's lower-case code, or 0. */
const radixLetter = (code: number): number => {
  const lower = code | 32;
  return lower === 120 || lower === 98 || lower === 111 ? lower : 0;
};

/** Python identifiers may be Unicode; anything past ASCII is a word character here. */
const isPyWordStart = (code: number) => isWordStartCode(code) || code > 127;
const isPyWord = (code: number) => isWordCode(code) || code > 127;

/** `r`, `b`, `f`, `rb`, `br`, `fr`, `rf` in any case -- the string prefixes. */
const isStringPrefix = (word: string): boolean => /^(?:[rbfRBF]|[rR][bBfF]|[bBfF][rR])$/.test(word);

export function tokenizePython(source: string): Token[] {
  const tokens: Token[] = [];
  const length = source.length;

  /**
   * Past the end of a string opened at `open` with `quote`, or where it gives
   * up: the end of the line for a short string, the end of the file for a
   * triple-quoted one.
   */
  const scanString = (open: number, quote: number): number => {
    const triple =
      source.charCodeAt(open + 1) === quote && source.charCodeAt(open + 2) === quote;
    let j = open + (triple ? 3 : 1);
    while (j < length) {
      const c = source.charCodeAt(j);
      if (c === BACKSLASH) {
        // An escaped newline continues a short string on the next line.
        j += 2;
      } else if (c === quote) {
        if (!triple) return j + 1;
        if (source.charCodeAt(j + 1) === quote && source.charCodeAt(j + 2) === quote) {
          return j + 3;
        }
        j++;
      } else if (c === LF && !triple) {
        return j;
      } else {
        j++;
      }
    }
    return length;
  };

  // `def` and `class` start a name.
  let expectName = false;

  let i = 0;
  while (i < length) {
    const code = source.charCodeAt(i);

    if (code === HASH) {
      let end = source.indexOf('\n', i);
      if (end === -1) end = length;
      tokens.push({ start: i, end, cls: 'tok-comment' });
      i = end;
      continue;
    }

    if (code === QUOTE || code === APOSTROPHE) {
      const end = scanString(i, code);
      tokens.push({ start: i, end, cls: 'tok-string' });
      i = end;
      continue;
    }

    if (isDigitCode(code) || (code === DOT && isDigitCode(source.charCodeAt(i + 1)))) {
      let j = i;
      const radix = code === ZERO ? radixLetter(source.charCodeAt(i + 1)) : 0;
      if (radix) {
        // Binary and octal are scanned with the hex rule: lenient, but a
        // stray digit is the compiler's to complain about, not the painter's.
        j = i + 2;
        while (j < length && isHexCode(source.charCodeAt(j))) j++;
      } else {
        while (j < length) {
          const c = source.charCodeAt(j);
          if (!isDigitCode(c) && c !== DOT && c !== UNDERSCORE) break;
          j++;
        }
        const c = source.charCodeAt(j);
        if (c === LOWER_E || c === UPPER_E) {
          j++;
          const sign = source.charCodeAt(j);
          if (sign === PLUS || sign === DASH) j++;
          while (j < length && (isDigitCode(source.charCodeAt(j)) || source.charCodeAt(j) === UNDERSCORE)) j++;
        }
      }
      const suffix = source.charCodeAt(j);
      if (suffix === LOWER_J || suffix === UPPER_J) j++;
      tokens.push({ start: i, end: j, cls: 'tok-number' });
      i = j;
      continue;
    }

    if (isPyWordStart(code)) {
      let j = i;
      while (j < length && isPyWord(source.charCodeAt(j))) j++;
      const word = source.slice(i, j);

      // `f"..."`, `rb'...'`: the prefix is part of the string.
      const quote = source.charCodeAt(j);
      if ((quote === QUOTE || quote === APOSTROPHE) && isStringPrefix(word)) {
        const end = scanString(j, quote);
        tokens.push({ start: i, end, cls: 'tok-string' });
        i = end;
        expectName = false;
        continue;
      }

      // The next non-blank character decides whether this is a call.
      let k = j;
      while (k < length) {
        const c = source.charCodeAt(k);
        if (c !== SPACE && c !== TAB) break;
        k++;
      }
      const after = source.charCodeAt(k);

      let cls: string | null;
      if (expectName) cls = 'tok-fn';
      else if (word === 'self') cls = 'tok-self';
      else if (PY_KEYWORD_SET.has(word)) cls = 'tok-keyword';
      else if (ENGINE_SET.has(word)) cls = 'tok-engine';
      else if (PY_BUILTIN_SET.has(word)) cls = 'tok-builtin';
      // A name called like a function is worth seeing.
      else cls = after === OPEN_PAREN ? 'tok-call' : null;

      expectName = word === 'def' || word === 'class';

      tokens.push({ start: i, end: j, cls });
      i = j;
      continue;
    }

    if (expectName && code !== SPACE && code !== TAB) expectName = false;
    i++;
  }

  return tokens;
}

/** Convenience for callers that only want colour, like the Docs tab. */
export function highlightPython(source: string): string {
  return renderTokens(source, tokenizePython(source));
}
