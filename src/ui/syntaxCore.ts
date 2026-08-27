/**
 * The language-neutral half of syntax handling.
 *
 * A tokeniser -- `tokenizeLuau`, or a Python one later -- produces a run of
 * tokens; everything here asks questions of that run or draws it, and knows
 * nothing about which language produced it.
 *
 * Token invariants every tokeniser must keep, because every function below
 * relies on them:
 *
 * - Tokens are sorted by `start` and never overlap.
 * - Each token covers the half-open range `[start, end)`.
 * - A caret sitting exactly at `token.start` counts as being in code, not in
 *   the token (see `isCaretInCode`).
 * - Only the classes `tok-comment` and `tok-string` suppress code behaviour --
 *   bracket pairing, bracket matching, completion. Any other class, or none,
 *   is ordinary code.
 *
 * Rendering is a separate pass so the same token run can be drawn with extra
 * ranges layered over it: search matches, the bracket under the caret.
 */

export interface Token {
  start: number;
  /** Exclusive. */
  end: number;
  cls: string | null;
}

/** An extra class painted over a range, on top of whatever token is there. */
export interface Overlay {
  start: number;
  end: number;
  cls: string;
}

const ZERO = 48;
const NINE = 57;
const UPPER_A = 65;
const UPPER_Z = 90;
const LOWER_A = 97;
const LOWER_Z = 122;
const UNDERSCORE = 95;

export const isDigitCode = (code: number) => code >= ZERO && code <= NINE;

export const isWordStartCode = (code: number) =>
  (code >= LOWER_A && code <= LOWER_Z) || (code >= UPPER_A && code <= UPPER_Z) || code === UNDERSCORE;

export const isWordCode = (code: number) => isWordStartCode(code) || isDigitCode(code);

const escapeHtml = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The token containing an offset, or undefined between tokens. */
export function tokenAt(tokens: Token[], offset: number): Token | undefined {
  let low = 0;
  let high = tokens.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const token = tokens[mid];
    if (offset < token.start) high = mid - 1;
    else if (offset >= token.end) low = mid + 1;
    else return token;
  }
  return undefined;
}

/** Index of the first token that reaches `offset`; for slicing a window out. */
export function firstTokenFrom(tokens: Token[], offset: number): number {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (tokens[mid].end <= offset) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Whether the *character* at an offset is ordinary code.
 *
 * For characters, `offset === token.start` is inside the token -- the `[` that
 * opens a long string is part of it. Callers reasoning about a caret want
 * `isCaretInCode` instead.
 */
export function isCode(tokens: Token[], offset: number): boolean {
  const cls = tokenAt(tokens, offset)?.cls;
  return cls !== 'tok-comment' && cls !== 'tok-string';
}

export function isInString(tokens: Token[], offset: number): boolean {
  return tokenAt(tokens, offset)?.cls === 'tok-string';
}

/**
 * The same questions, asked about a caret rather than a character.
 *
 * A caret sits *between* characters, so one resting immediately before a token
 * is not yet inside it: in `print(|"hi")` the caret is in code, and at the very
 * start of `|--note` it is too. Treating those as inside the token offered
 * asset names where globals belonged, and refused to auto-close a bracket.
 */
export function isCaretInString(tokens: Token[], offset: number): boolean {
  const token = tokenAt(tokens, offset);
  return !!token && token.cls === 'tok-string' && offset > token.start;
}

export function isCaretInCode(tokens: Token[], offset: number): boolean {
  const token = tokenAt(tokens, offset);
  if (!token || offset === token.start) return true;
  return token.cls !== 'tok-comment' && token.cls !== 'tok-string';
}

/**
 * Render tokens to HTML, with `overlays` layered on top.
 *
 * Both lists are swept in one pass, so a region with hundreds of search matches
 * costs the same as one with none.
 */
export function renderTokens(source: string, tokens: Token[], overlays: Overlay[] = []): string {
  const bounds = new Set<number>([0, source.length]);
  for (const token of tokens) {
    bounds.add(token.start);
    bounds.add(token.end);
  }
  for (const overlay of overlays) {
    // Clamped at both ends: an overlay lying entirely outside the rendered
    // slice would otherwise fold a boundary back inside it and duplicate text.
    bounds.add(Math.min(source.length, Math.max(0, overlay.start)));
    bounds.add(Math.max(0, Math.min(source.length, overlay.end)));
  }

  const points = [...bounds].sort((a, b) => a - b);
  const sortedOverlays = [...overlays].sort((a, b) => a.start - b.start);

  let out = '';
  let tokenIndex = 0;
  let overlayIndex = 0;
  let active: Overlay[] = [];

  for (let k = 0; k + 1 < points.length; k++) {
    const from = points[k];
    const to = points[k + 1];
    if (to <= from) continue;

    while (tokenIndex < tokens.length && tokens[tokenIndex].end <= from) tokenIndex++;
    while (overlayIndex < sortedOverlays.length && sortedOverlays[overlayIndex].start <= from) {
      active.push(sortedOverlays[overlayIndex++]);
    }
    if (active.length) active = active.filter((overlay) => overlay.end > from);

    const token = tokens[tokenIndex];
    const text = escapeHtml(source.slice(from, to));

    let classes = token && token.start <= from && token.end >= to && token.cls ? token.cls : '';
    for (const overlay of active) classes = classes ? `${classes} ${overlay.cls}` : overlay.cls;

    out += classes ? `<span class="${classes}">${text}</span>` : text;
  }

  return out;
}

const OPENERS = '([{';
const CLOSING = ')]}';
const PARTNER: Record<string, string> = {
  '(': ')', '[': ']', '{': '}',
  ')': '(', ']': '[', '}': '{',
};

/** Give up rather than scan a huge file for a bracket that has no partner. */
const BRACKET_SCAN_LIMIT = 200_000;

/**
 * The bracket next to the caret and its partner, if both are real code.
 *
 * Looks at the character before the caret first, which is where it is after
 * you type one.
 */
export function matchBracket(
  source: string,
  tokens: Token[],
  caret: number,
): [number, number] | null {
  for (const at of [caret - 1, caret]) {
    if (at < 0 || at >= source.length) continue;
    const ch = source[at];
    const forward = OPENERS.includes(ch);
    if (!forward && !CLOSING.includes(ch)) continue;
    if (!isCode(tokens, at)) continue;

    const step = forward ? 1 : -1;
    const want = PARTNER[ch];
    const stop = forward
      ? Math.min(source.length, at + BRACKET_SCAN_LIMIT)
      : Math.max(-1, at - BRACKET_SCAN_LIMIT);
    let depth = 0;

    let found: [number, number] | null = null;
    for (let i = at; forward ? i < stop : i > stop; i += step) {
      const c = source[i];
      if (c !== ch && c !== want) continue;
      if (!isCode(tokens, i)) continue;
      if (c === ch) depth++;
      else if (--depth === 0) {
        found = [at, i];
        break;
      }
    }
    // An unmatched bracket before the caret should not stop us looking at the
    // one after it: in `)|(` both are worth checking.
    if (found) return found;
  }
  return null;
}
