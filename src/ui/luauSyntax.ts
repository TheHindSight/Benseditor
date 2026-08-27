import { BUILTIN_SET, ENGINE_SET, KEYWORD_SET } from './luauApi';
import { isDigitCode, isWordCode, isWordStartCode, renderTokens, type Token } from './syntaxCore';

// The token types, the caret and bracket questions and the HTML renderer live
// in `syntaxCore.ts`, shared with every other language. Re-exported so every
// existing import of `./luauSyntax` keeps resolving.
export * from './syntaxCore';
export { renderTokens as renderLuau } from './syntaxCore';

/**
 * Luau tokeniser.
 *
 * A scanner rather than a bag of regexes, because the editor needs to ask
 * questions the old pattern could not answer: is this offset inside a string,
 * is that bracket real code or part of a comment, where does this long string
 * end. Long brackets (`[==[ ... ]==]`) have to match their own level, which a
 * regular expression cannot do at all.
 *
 * It runs on every keystroke, so the inner loop works on character codes --
 * `source[i]` allocates a one-character string, `charCodeAt` does not.
 *
 * Rendering is a separate pass so the same token run can be drawn with extra
 * ranges layered over it: search matches, the bracket under the caret.
 */

const LF = 10;
const SPACE = 32;
const TAB = 9;
const QUOTE = 34;
const APOSTROPHE = 39;
const BACKTICK = 96;
const BACKSLASH = 92;
const DASH = 45;
const DOT = 46;
const EQUALS = 61;
const OPEN_BRACKET = 91;
const OPEN_PAREN = 40;
const ZERO = 48;
const LOWER_X = 120;
const UPPER_X = 88;
const LOWER_Z = 122;
const UNDERSCORE = 95;
const LOWER_E = 101;
const UPPER_E = 69;
const PLUS = 43;

const CR = 13;
const FF = 12;
const VT = 11;

/** Whitespace as Lua's `\z` escape understands it, newlines included. */
const isSpaceCode = (code: number) =>
  code === SPACE || code === TAB || code === LF || code === CR || code === FF || code === VT;

const isHexCode = (code: number) =>
  isDigitCode(code) ||
  (code >= 97 && code <= 102) ||
  (code >= 65 && code <= 70) ||
  code === UNDERSCORE;

export function tokenizeLuau(source: string): Token[] {
  const tokens: Token[] = [];
  const length = source.length;

  /** `[`, `[=[`, `[==[` … the number of `=`, or -1 if this is not one. */
  const openLevel = (at: number): number => {
    let j = at + 1;
    while (source.charCodeAt(j) === EQUALS) j++;
    return source.charCodeAt(j) === OPEN_BRACKET ? j - at - 1 : -1;
  };

  /** Past the matching close bracket, or the end of the file if unterminated. */
  const closeLong = (from: number, level: number): number => {
    const close = `]${'='.repeat(level)}]`;
    const found = source.indexOf(close, from);
    return found === -1 ? length : found + close.length;
  };

  // `function` starts a name that may be dotted -- `obj.step`, `a.b:c` -- and
  // runs until the parameter list.
  let expectName = false;

  let i = 0;
  while (i < length) {
    const code = source.charCodeAt(i);

    if (code === DASH && source.charCodeAt(i + 1) === DASH) {
      if (source.charCodeAt(i + 2) === OPEN_BRACKET) {
        const level = openLevel(i + 2);
        if (level >= 0) {
          const end = closeLong(i + 2 + level + 2, level);
          tokens.push({ start: i, end, cls: 'tok-comment' });
          i = end;
          continue;
        }
      }
      let end = source.indexOf('\n', i);
      if (end === -1) end = length;
      tokens.push({ start: i, end, cls: 'tok-comment' });
      i = end;
      continue;
    }

    if (code === OPEN_BRACKET) {
      const level = openLevel(i);
      if (level >= 0) {
        const end = closeLong(i + level + 2, level);
        tokens.push({ start: i, end, cls: 'tok-string' });
        i = end;
        continue;
      }
    }

    if (code === QUOTE || code === APOSTROPHE || code === BACKTICK) {
      // No quoted string, backticks included, may contain a raw newline: an
      // unterminated one ends at the line. Letting backticks run on meant a
      // single stray one turned the rest of the file into a string.
      let j = i + 1;
      while (j < length) {
        const c = source.charCodeAt(j);
        if (c === BACKSLASH) {
          // `\z` skips the whitespace that follows it, newlines included, so
          // the string genuinely continues on the next line.
          if (source.charCodeAt(j + 1) === LOWER_Z) {
            j += 2;
            while (j < length && isSpaceCode(source.charCodeAt(j))) j++;
          } else {
            j += 2;
          }
        } else if (c === code) {
          j++;
          break;
        } else if (c === LF) {
          break;
        } else {
          j++;
        }
      }
      tokens.push({ start: i, end: Math.min(j, length), cls: 'tok-string' });
      i = Math.min(j, length);
      continue;
    }

    if (isDigitCode(code) || (code === DOT && isDigitCode(source.charCodeAt(i + 1)))) {
      let j = i;
      const next = source.charCodeAt(i + 1);
      if (code === ZERO && (next === LOWER_X || next === UPPER_X)) {
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
          while (j < length && isDigitCode(source.charCodeAt(j))) j++;
        }
      }
      tokens.push({ start: i, end: j, cls: 'tok-number' });
      i = j;
      continue;
    }

    if (isWordStartCode(code)) {
      let j = i;
      while (j < length && isWordCode(source.charCodeAt(j))) j++;
      const word = source.slice(i, j);

      // The next non-blank character decides a couple of the cases below.
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
      else if (KEYWORD_SET.has(word)) cls = 'tok-keyword';
      else if (ENGINE_SET.has(word)) cls = 'tok-engine';
      else if (BUILTIN_SET.has(word)) cls = 'tok-builtin';
      // A name called like a function is worth seeing.
      else cls = after === OPEN_PAREN ? 'tok-call' : null;

      if (word === 'function') expectName = true;
      else if (expectName) {
        // Stay in name mode across `.` and `:` only.
        expectName = after === DOT || after === 58;
      }

      tokens.push({ start: i, end: j, cls });
      i = j;
      continue;
    }

    if (expectName && code !== DOT && code !== 58 && code !== SPACE && code !== TAB) {
      expectName = false;
    }
    i++;
  }

  return tokens;
}

/** Convenience for callers that only want colour, like the Docs tab. */
export function highlightLuau(source: string): string {
  return renderTokens(source, tokenizeLuau(source));
}
