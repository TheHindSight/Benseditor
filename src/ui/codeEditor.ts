import { clear, el, modal, type Panel } from './dom';
import type { ApiEntry, CompletionKind } from './apiSurface';
import type { LanguageSpec } from './languageSpec';
import { LUAU_LANGUAGE } from './luauLanguage';
import {
  firstTokenFrom,
  isCaretInCode,
  isCaretInString,
  isWordCode,
  isWordStartCode,
  matchBracket,
  renderTokens,
  type Overlay,
  type Token,
} from './syntaxCore';

/**
 * Code editor.
 *
 * A transparent textarea over a syntax-highlighted <pre>. That keeps native
 * editing behaviour -- selection, IME, the browser's own undo stack -- with no
 * editor library, which matters for a build that should stay small.
 *
 * Everything language-specific -- the tokeniser, the indent, bracket pairs,
 * the comment marker, what Enter does, what to complete -- comes from a
 * `LanguageSpec`; Luau is the default.
 *
 * Two things make it hold up on a real file:
 *
 * 1. Every programmatic change goes through `edit()`, which uses `insertText`
 *    rather than assigning to `value`. Assigning to `value` wipes the undo
 *    stack, so auto-indenting one line used to make everything typed before it
 *    unrecoverable.
 * 2. Only the lines on screen are highlighted. Painting a 2000-line file in
 *    full cost 220 ms per keystroke -- 12,000 spans and half a megabyte of
 *    HTML, for the forty lines anyone can see.
 */

/** Matches the CSS `tab-size`, for column numbers and popup placement. */
const TAB_WIDTH = 4;
/**
 * Lines rendered above and below the viewport, so small scrolls are free.
 *
 * Every line here is DOM the browser parses on each keystroke, so the margin
 * buys smooth scrolling at a real cost -- a dozen lines is the balance.
 */
const WINDOW_MARGIN = 12;

const MAX_VISIBLE = 10;
const ICONS: Record<CompletionKind, string> = {
  keyword: 'K',
  function: 'ƒ',
  method: 'ƒ',
  field: '·',
  constant: '#',
  local: 'L',
  asset: '"',
};

interface ActiveCompletion {
  items: ApiEntry[];
  index: number;
  /** Offset in the source where the replaced word starts. */
  start: number;
  /** Function completions get their parentheses typed for them. */
  callable: boolean;
}

interface FindState {
  query: string;
  matches: number[];
  index: number;
  caseSensitive: boolean;
}

const isBlank = (code: number) => code === 32 || code === 9;

/**
 * Screen column after `text`, counting from 0.
 *
 * A tab advances to the next multiple of TAB_WIDTH rather than adding a fixed
 * four, which is what the browser draws and therefore where the caret and the
 * completion popup actually are.
 */
function visualColumn(text: string): number {
  let column = 0;
  for (let i = 0; i < text.length; i++) {
    column = text.charCodeAt(i) === 9 ? column + TAB_WIDTH - (column % TAB_WIDTH) : column + 1;
  }
  return column;
}

/**
 * Lowercase forms, kept because ranking runs over every name in the file on
 * every keystroke and `toLowerCase` allocates each time.
 */
const lowerCache = new Map<string, string>();
function lower(name: string): string {
  let value = lowerCache.get(name);
  if (value === undefined) {
    value = name.toLowerCase();
    lowerCache.set(name, value);
  }
  return value;
}

/**
 * How well `name` matches what has been typed.
 *
 * Higher is better, -1 means no match. Ranked rather than filtered so typing
 * `insnum` still finds `instance_number`, without burying an exact prefix
 * match underneath it.
 */
export function completionRank(name: string, prefix: string): number {
  if (!prefix) return 0;
  if (name.startsWith(prefix)) return 100;

  const lowerName = lower(name);
  const lowerPrefix = lower(prefix);
  if (lowerName.startsWith(lowerPrefix)) return 90;
  if (lowerName.includes(lowerPrefix)) return 60;

  // Subsequence matching is the expensive tier, and it is only ever useful for
  // an abbreviation -- `insnum` for `instance_number` -- which shares a first
  // letter. Requiring that turns thousands of scans into one comparison.
  if (lowerName.charCodeAt(0) !== lowerPrefix.charCodeAt(0)) return -1;

  let at = 0;
  for (let i = 0; i < lowerPrefix.length; i++) {
    at = lowerName.indexOf(lowerPrefix[i], at);
    if (at === -1) return -1;
    at++;
  }
  return 30;
}

export class CodeEditor implements Panel {
  readonly element: HTMLElement;

  private textarea: HTMLTextAreaElement;
  private highlighted: HTMLElement;
  private gutter: HTMLElement;
  private gutterLines: HTMLElement;
  private activeLine: HTMLElement;
  private status: HTMLElement;
  private popup: HTMLElement;
  private list: HTMLElement;
  private docLine: HTMLElement;

  // Built by buildFindBar(), which the constructor calls before laying out.
  private findBar!: HTMLElement;
  private findInput!: HTMLInputElement;
  private replaceInput!: HTMLInputElement;
  private findCount!: HTMLElement;
  private caseButton!: HTMLButtonElement;

  private saveTimer = 0;
  private active: ActiveCompletion | null = null;

  private measured = false;
  private charWidth = 7;
  private lineHeight = 19;
  private paddingTop = 10;
  private paddingLeft = 14;

  private tokens: Token[] = [];
  /** Offset where each line starts; the index behind every row lookup. */
  private lineOffsets: number[] = [0];
  private bracketPair: [number, number] | null = null;

  /** The line range currently in the overlay and the gutter. */
  private windowFrom = 0;
  private windowTo = -1;
  private currentRow = -1;
  private lastTransform = '';

  /**
   * Scroll position and viewport height, read once per keystroke.
   *
   * Reading these off the element forces the browser to lay out a textarea
   * holding the whole file, which costs several milliseconds however small the
   * change was. Reading them once up front and working from the copy keeps it
   * to a single layout per edit instead of one before and one after.
   */
  private metrics = { scrollTop: 0, scrollLeft: 0, clientHeight: 0, clientWidth: 0 };

  private locals: ApiEntry[] = [];
  private localsAt = 0;

  /** Set while `edit()` runs, so the input handler leaves it alone. */
  private programmatic = false;

  private find: FindState = { query: '', matches: [], index: 0, caseSensitive: false };

  /** Derived from the language once, not on every keystroke. */
  private readonly closers: Set<string>;
  /** A line that already carries a comment marker. */
  private readonly commentedPattern: RegExp;
  /** The marker and the one space after it, for uncommenting. */
  private readonly uncommentPattern: RegExp;

  private readonly onSelectionChange = () => {
    if (document.activeElement === this.textarea) this.syncCaret();
  };

  /**
   * The window is chosen from the viewport height, so a taller editor needs a
   * fresh one -- otherwise dragging the window bigger exposes blank lines that
   * stay blank until the next keystroke or scroll.
   */
  private readonly resizeObserver = new ResizeObserver(() => {
    this.measured = false;
    this.readMetrics();
    this.renderWindow(true);
    this.syncScroll(false);
  });

  constructor(
    private readonly getSource: () => string,
    private readonly setSource: (source: string) => void,
    private readonly title: string,
    /** Asset names offered inside string literals. */
    private readonly getAssetNames: () => string[] = () => [],
    private readonly language: LanguageSpec = LUAU_LANGUAGE,
  ) {
    this.closers = new Set(Object.values(this.language.pairs));
    const marker = this.language.lineComment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    this.commentedPattern = new RegExp(`^\\s*${marker}`);
    this.uncommentPattern = new RegExp(`^(\\s*)${marker} ?`);

    this.highlighted = el('pre', { class: 'code-highlight', 'aria-hidden': 'true' });
    this.gutterLines = el('div', { class: 'code-gutter-lines' });
    this.gutter = el('div', { class: 'code-gutter' }, this.gutterLines);
    this.activeLine = el('div', { class: 'code-active-line', 'aria-hidden': 'true' });

    this.list = el('div', { class: 'complete-list' });
    this.docLine = el('div', { class: 'complete-doc', hidden: true });
    this.popup = el(
      'div',
      {
        class: 'code-complete',
        hidden: true,
        // Keeps the textarea focused when the pointer lands on the popup's
        // scrollbar, its padding or the description -- a blur there would
        // dismiss the popup out from under the click.
        onpointerdown: (event: PointerEvent) => event.preventDefault(),
      },
      this.list,
      this.docLine,
    );

    this.textarea = el('textarea', {
      class: 'code-input',
      spellcheck: false,
      autocapitalize: 'off',
      autocomplete: 'off',
      wrap: 'off',
      value: this.getSource(),
      oninput: (event: Event) => this.onInput(event),
      onscroll: () => this.syncScroll(),
      onkeydown: (event: KeyboardEvent) => this.onKeyDown(event),
      onblur: () => this.onBlur(),
      onclick: () => this.dismiss(),
    }) as HTMLTextAreaElement;

    this.status = el('div', { class: 'code-status' });
    this.buildFindBar();

    this.element = el(
      'div',
      { class: 'code-editor' },
      el(
        'div',
        { class: 'code-header' },
        el('strong', { text: this.title }),
        el('span', { class: 'muted small', text: this.language.label }),
        el('span', { class: 'grow' }),
        el('button', {
          class: 'mini',
          text: 'Find',
          title: 'Find and replace (Ctrl+F)',
          onclick: () => this.openFind(),
        }),
        el('span', { class: 'muted small', text: 'Ctrl+Space completes · F1 for the manual' }),
      ),
      this.findBar,
      el(
        'div',
        { class: 'code-body' },
        this.gutter,
        el('div', { class: 'code-scroll' }, this.activeLine, this.highlighted, this.textarea, this.popup),
      ),
      this.status,
    );

    document.addEventListener('selectionchange', this.onSelectionChange);
    this.resizeObserver.observe(this.textarea);
    this.paint();
  }

  activate(): void {
    // Re-measure on activation: the panel had no computed style until now, and
    // a zoom change between visits would invalidate the old numbers.
    this.measured = false;
    this.refresh();
    this.paint();
  }

  deactivate(): void {
    this.dismiss();
    this.flush();
  }

  dispose(): void {
    this.flush();
    document.removeEventListener('selectionchange', this.onSelectionChange);
    this.resizeObserver.disconnect();
  }

  /**
   * Pull the latest source in, e.g. after an undo.
   *
   * Returns without touching anything when the text already matches. This is
   * called on every project change, including the autosave our own typing
   * triggers, and repainting there would double the cost of every fourth
   * keystroke for nothing.
   */
  refresh(): void {
    const source = this.getSource();
    if (this.textarea.value === source) return;

    // A wholesale replacement from outside; the undo stack is not ours to keep.
    this.textarea.value = source;
    this.paint();
  }

  // -- the one primitive ------------------------------------------------

  /**
   * Replace `[from, to)` with `text`.
   *
   * Routed through the browser's own editing commands so the change joins the
   * native undo stack. Assigning to `value` would clear it.
   */
  private edit(from: number, to: number, text: string, select?: [number, number]): void {
    const area = this.textarea;
    if (document.activeElement !== area) area.focus();
    area.setSelectionRange(from, to);

    this.programmatic = true;
    let applied = false;
    try {
      applied =
        text === ''
          ? document.execCommand('delete')
          : document.execCommand('insertText', false, text);
    } catch {
      applied = false;
    }
    this.programmatic = false;

    if (!applied) {
      // Correctness over undo history if the command is unavailable.
      area.setRangeText(text, from, to, 'end');
    }

    if (select) area.setSelectionRange(select[0], select[1]);
    this.paint();
    this.scheduleSave();
  }

  // -- geometry ---------------------------------------------------------

  private lineStartAt(offset: number): number {
    // `lastIndexOf` clamps a negative position to 0 and still inspects index 0,
    // so without this guard offset 0 of a file that begins with a newline
    // reports line 2 -- and every line command works on the wrong line.
    if (offset <= 0) return 0;
    return this.textarea.value.lastIndexOf('\n', offset - 1) + 1;
  }

  private lineEndAt(offset: number): number {
    const at = this.textarea.value.indexOf('\n', offset);
    return at === -1 ? this.textarea.value.length : at;
  }

  /** The whole lines covered by the selection. */
  private lineSpan(): { from: number; to: number } {
    const { selectionStart, selectionEnd } = this.textarea;
    const from = this.lineStartAt(selectionStart);

    // A selection ending exactly at the start of a line does not include it --
    // dragging down to the next line should not indent it.
    const end =
      selectionEnd > selectionStart && selectionEnd === this.lineStartAt(selectionEnd)
        ? selectionEnd - 1
        : selectionEnd;

    return { from, to: this.lineEndAt(Math.max(from, end)) };
  }

  private buildLineIndex(source: string): void {
    const offsets = [0];
    for (let i = 0; i < source.length; i++) {
      if (source.charCodeAt(i) === 10) offsets.push(i + 1);
    }
    this.lineOffsets = offsets;
  }

  /** Which line an offset is on. */
  private rowOf(offset: number): number {
    const offsets = this.lineOffsets;
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (offsets[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  private positionOf(offset: number): { row: number; column: number } {
    const row = this.rowOf(offset);
    const text = this.textarea.value.slice(this.lineOffsets[row], offset);
    return { row, column: visualColumn(text) };
  }

  /** Text of the current line up to the caret. */
  private lineToCaret(): { start: number; text: string } {
    const { selectionStart, value } = this.textarea;
    const start = this.lineStartAt(selectionStart);
    return { start, text: value.slice(start, selectionStart) };
  }

  // -- line commands ----------------------------------------------------

  private indentSelection(outdent: boolean): void {
    const { selectionStart, selectionEnd, value } = this.textarea;
    const { indent } = this.language;
    const { from, to } = this.lineSpan();
    const original = value.slice(from, to);
    const lines = original.split('\n');

    let firstDelta = 0;
    let total = 0;

    const changed = lines.map((line, index) => {
      if (outdent) {
        const removed = /^(\t| {1,4})/.exec(line)?.[0].length ?? 0;
        if (index === 0) firstDelta = -removed;
        total -= removed;
        return line.slice(removed);
      }
      // A blank final line would only gain trailing whitespace.
      if (line === '' && index === lines.length - 1 && lines.length > 1) return line;
      if (index === 0) firstDelta = indent.length;
      total += indent.length;
      return indent + line;
    });

    const text = changed.join('\n');
    if (text === original) return;

    this.edit(from, to, text, [
      Math.max(from, selectionStart + firstDelta),
      Math.max(from, selectionEnd + total),
    ]);
  }

  /** Comment the selected lines, or uncomment them if they all already are. */
  private toggleComment(): void {
    const { selectionStart, selectionEnd, value } = this.textarea;
    const { from, to } = this.lineSpan();
    const lines = value.slice(from, to).split('\n');

    const meaningful = lines.filter((line) => line.trim() !== '');
    if (meaningful.length === 0) return;
    const uncomment = meaningful.every((line) => this.commentedPattern.test(line));

    // The marker plus the space that follows it.
    const marker = this.language.lineComment;
    const added = marker.length + 1;

    let firstDelta = 0;
    let total = 0;

    const changed = lines.map((line, index) => {
      if (line.trim() === '') return line;

      if (uncomment) {
        const match = this.uncommentPattern.exec(line);
        if (!match) return line;
        const removed = match[0].length - match[1].length;
        if (index === 0) firstDelta = -removed;
        total -= removed;
        return match[1] + line.slice(match[0].length);
      }

      const indent = /^\s*/.exec(line)![0];
      if (index === 0) firstDelta = added;
      total += added;
      return `${indent}${marker} ${line.slice(indent.length)}`;
    });

    this.edit(from, to, changed.join('\n'), [
      Math.max(from, selectionStart + firstDelta),
      Math.max(from, selectionEnd + total),
    ]);
  }

  private moveLines(delta: number): void {
    const { selectionStart, selectionEnd, value } = this.textarea;
    const { from, to } = this.lineSpan();
    const block = value.slice(from, to);

    if (delta < 0) {
      if (from === 0) return;
      const previousFrom = this.lineStartAt(from - 1);
      const previous = value.slice(previousFrom, from - 1);
      const shift = from - previousFrom;
      this.edit(previousFrom, to, `${block}\n${previous}`, [
        selectionStart - shift,
        selectionEnd - shift,
      ]);
      return;
    }

    if (to >= value.length) return;
    const nextTo = this.lineEndAt(to + 1);
    const next = value.slice(to + 1, nextTo);
    const shift = next.length + 1;
    this.edit(from, nextTo, `${next}\n${block}`, [selectionStart + shift, selectionEnd + shift]);
  }

  private duplicateLines(): void {
    const { selectionStart, selectionEnd, value } = this.textarea;
    const { from, to } = this.lineSpan();
    const block = value.slice(from, to);
    const shift = block.length + 1;
    this.edit(to, to, `\n${block}`, [selectionStart + shift, selectionEnd + shift]);
  }

  private deleteLines(): void {
    const { value } = this.textarea;
    const { from, to } = this.lineSpan();
    // Take the newline with it, or the one before if this is the last line.
    const start = to >= value.length && from > 0 ? from - 1 : from;
    const end = to < value.length ? to + 1 : to;
    this.edit(start, end, '', [start, start]);
  }

  /** Home goes to the first non-blank character, then to the margin. */
  private smartHome(): void {
    const { selectionStart, value } = this.textarea;
    const start = this.lineStartAt(selectionStart);
    let indent = start;
    while (indent < value.length && isBlank(value.charCodeAt(indent))) indent++;

    const target = selectionStart === indent ? start : indent;
    this.textarea.setSelectionRange(target, target);
    this.syncCaret();
  }

  private async gotoLine(): Promise<void> {
    const total = this.lineOffsets.length;
    const field = el('input', {
      type: 'number',
      min: '1',
      max: String(total),
      value: String(this.rowOf(this.textarea.selectionStart) + 1),
    }) as HTMLInputElement;

    const body = el(
      'div',
      { class: 'modal-body' },
      el('label', { class: 'field' }, el('span', { text: 'Line' }), field),
      el('p', { class: 'muted small', text: `1 to ${total}` }),
    );
    if (!(await modal('Go to line', body, 'Go'))) return;

    const line = Math.min(total, Math.max(1, Number(field.value) | 0));
    const offset = this.lineOffsets[line - 1];
    this.textarea.focus();
    this.textarea.setSelectionRange(offset, this.lineEndAt(offset));
    this.reveal(offset);
    this.syncCaret();
  }

  // -- typing -----------------------------------------------------------

  /**
   * Bracket and quote handling. Returns true when the event was consumed.
   *
   * Three behaviours, matching what every editor does: typing an opener inserts
   * the pair (or wraps the selection), typing a closer that is already there
   * steps over it, and Backspace between an empty pair removes both.
   */
  private handleBrackets(event: KeyboardEvent): boolean {
    if (event.metaKey) return false;
    // AltGr arrives as Ctrl+Alt on Windows, and on several layouts that is how
    // you type a bracket at all -- so only a lone Ctrl or Alt disqualifies.
    if ((event.ctrlKey || event.altKey) && !(event.ctrlKey && event.altKey)) return false;

    const { selectionStart, selectionEnd, value } = this.textarea;
    const { pairs } = this.language;
    const nextChar = value[selectionStart] ?? '';

    if (event.key === 'Backspace' && selectionStart === selectionEnd) {
      const previous = value[selectionStart - 1] ?? '';
      if (pairs[previous] && pairs[previous] === nextChar) {
        event.preventDefault();
        this.edit(selectionStart - 1, selectionStart + 1, '');
        return true;
      }
      return false;
    }

    if (event.key.length !== 1) return false;

    const closer = pairs[event.key];
    if (closer) {
      const isQuote = event.key === closer;
      const beforeWord = /[\w"'`]/.test(nextChar);
      // Never pair in front of a word: typing `(` before an existing name is a
      // call, not a wrap, and the closer would only be in the way. Quotes get
      // the same treatment even when wrapping a selection, since a quote next
      // to a word is usually an apostrophe or the end of an open string.
      if (beforeWord && (isQuote || selectionStart === selectionEnd)) return false;
      // Nor inside a comment or string, where a stray `(` needs no partner.
      if (selectionStart === selectionEnd && !isCaretInCode(this.tokens, selectionStart)) {
        return false;
      }

      event.preventDefault();
      if (selectionStart !== selectionEnd) {
        const selected = value.slice(selectionStart, selectionEnd);
        this.edit(selectionStart, selectionEnd, event.key + selected + closer, [
          selectionStart + 1,
          selectionEnd + 1,
        ]);
      } else {
        this.edit(selectionStart, selectionEnd, event.key + closer, [
          selectionStart + 1,
          selectionStart + 1,
        ]);
      }
      return true;
    }

    // Typing the closer that is already sitting there just moves past it.
    if (this.closers.has(event.key) && nextChar === event.key && selectionStart === selectionEnd) {
      event.preventDefault();
      this.textarea.setSelectionRange(selectionStart + 1, selectionStart + 1);
      return true;
    }

    return false;
  }

  /**
   * Enter: the language decides what goes in and where the caret lands --
   * keeping the indentation, opening a block, writing its closer -- and the
   * editor performs the one edit.
   */
  private insertNewline(): void {
    const { selectionStart, selectionEnd, value } = this.textarea;
    const { start: lineStart, text: line } = this.lineToCaret();
    const lineEnd = this.lineEndAt(selectionEnd);

    const { text, caret } = this.language.newline({
      source: value,
      tokens: this.tokens,
      selectionStart,
      selectionEnd,
      lineStart,
      textToCaret: line,
      indent: /^[\t ]*/.exec(line)![0],
      nextChar: value[selectionEnd] ?? '',
      rest: value.slice(selectionEnd, lineEnd),
      lineEnd,
    });
    this.edit(selectionStart, selectionEnd, text, [caret, caret]);
  }

  /**
   * Pull a closing word back one level as it is typed -- `end`, `else`, `}`
   * in Luau -- so it lines up with the statement that opened it. The language
   * supplies the pattern; group 1 is the indentation to shorten by one
   * character, group 2 the word.
   */
  private maybeDedent(): void {
    const { start, text } = this.lineToCaret();
    const match = this.language.dedentPattern.exec(text);
    if (!match) return;

    const dedented = match[1].slice(0, -1) + match[2];
    const caret = start + dedented.length;
    this.edit(start, this.textarea.selectionStart, dedented, [caret, caret]);
  }

  private onInput(event?: Event): void {
    // `edit()` paints and saves for itself; re-entering here would also let the
    // dedent rule fire in the middle of a multi-line command.
    if (this.programmatic) return;

    this.paint();
    if (event instanceof InputEvent && event.inputType === 'insertText') {
      this.maybeDedent();
    }
    this.updateCompletions(false);
    this.scheduleSave();
  }

  /**
   * Leaving the editor commits immediately.
   *
   * Waiting out the save timer would lose up to 400 ms of typing whenever the
   * click that moved focus itself writes to the project -- adding an event
   * stub from the object editor, for instance.
   */
  private onBlur(): void {
    this.dismiss();
    this.flush();
    // The bracket overlay belongs to the focused editor; drop it.
    if (this.bracketPair) {
      this.bracketPair = null;
      this.renderWindow(true);
    }
  }

  private scheduleSave(): void {
    // Coalesce keystrokes into one project undo entry per pause.
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => this.flush(), 400);
  }

  private flush(): void {
    clearTimeout(this.saveTimer);
    if (this.textarea.value !== this.getSource()) this.setSource(this.textarea.value);
  }

  private onKeyDown(event: KeyboardEvent): void {
    // Mid-composition keys belong to the IME: the Enter that commits a
    // candidate must not also insert a newline.
    if (event.isComposing || event.keyCode === 229) return;

    if (this.active) {
      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          this.move(1);
          return;
        case 'ArrowUp':
          event.preventDefault();
          this.move(-1);
          return;
        case 'Tab':
          event.preventDefault();
          this.accept();
          return;
        case 'Enter':
          // Enter only commits a suggestion that continues what was typed.
          // Otherwise the word is one you meant literally -- writing `number`
          // in a type annotation should not turn into `image_number()` -- so
          // Enter does what Enter does. Tab above always accepts.
          if (this.acceptsOnEnter()) {
            event.preventDefault();
            this.accept();
            return;
          }
          this.dismiss();
          break;
        case 'Escape':
          event.preventDefault();
          this.dismiss();
          return;
      }
    }

    const control = event.ctrlKey || event.metaKey;
    const key = event.key.toLowerCase();

    if (control && event.code === 'Space') {
      event.preventDefault();
      this.updateCompletions(true);
      return;
    }

    if (event.altKey && !control && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      if (event.shiftKey) this.duplicateLines();
      else this.moveLines(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }

    if (control) {
      switch (key) {
        case 'f':
          event.preventDefault();
          return this.openFind();
        case 'h':
          event.preventDefault();
          return this.openFind(true);
        case 'g':
          event.preventDefault();
          void this.gotoLine();
          return;
        case '/':
          event.preventDefault();
          return this.toggleComment();
        case 'k':
          if (event.shiftKey) {
            event.preventDefault();
            return this.deleteLines();
          }
          break;
        case 's':
          event.preventDefault();
          return this.flush();
      }
    }

    if (event.key === 'Escape' && !this.findBar.hidden) {
      event.preventDefault();
      return this.closeFind();
    }

    if (event.key === 'Enter' && !control) {
      event.preventDefault();
      this.insertNewline();
      return;
    }

    if (event.key === 'Tab') {
      event.preventDefault();
      const { selectionStart, selectionEnd, value } = this.textarea;
      const spansLines = value.slice(selectionStart, selectionEnd).includes('\n');
      if (event.shiftKey || spansLines) {
        this.indentSelection(event.shiftKey);
      } else {
        const { indent } = this.language;
        const caret = selectionStart + indent.length;
        this.edit(selectionStart, selectionEnd, indent, [caret, caret]);
      }
      return;
    }

    if (event.key === 'Home' && !event.shiftKey && !control) {
      event.preventDefault();
      this.smartHome();
      return;
    }

    if (this.handleBrackets(event)) return;
  }

  // -- painting ---------------------------------------------------------

  private paint(): void {
    const source = this.textarea.value;
    // The one layout read of the keystroke; everything below works off it.
    this.readMetrics();
    this.tokens = this.language.tokenize(source);
    this.buildLineIndex(source);
    this.updateBracketPair();
    // The text may have moved every match; an open search has to keep up.
    if (!this.findBar.hidden) this.computeMatches();
    this.renderWindow(true);
    this.updateStatus();
    this.syncScroll(false);
  }

  private readMetrics(): void {
    const area = this.textarea;
    this.metrics.scrollTop = area.scrollTop;
    this.metrics.scrollLeft = area.scrollLeft;
    this.metrics.clientHeight = area.clientHeight;
    this.metrics.clientWidth = area.clientWidth;
  }

  /** The lines that need to exist in the overlay right now. */
  private visibleRange(): { first: number; last: number } {
    this.measure();
    const total = this.lineOffsets.length;
    const height = this.metrics.clientHeight || this.lineHeight * 40;
    const top = this.metrics.scrollTop;
    return {
      first: Math.max(0, Math.min(total - 1, Math.floor(top / this.lineHeight))),
      last: Math.max(0, Math.min(total - 1, Math.ceil((top + height) / this.lineHeight))),
    };
  }

  /**
   * Highlight the visible lines, plus a margin.
   *
   * Rendering the whole document is what made a large file unusable: the cost
   * is in the DOM, not the tokeniser, so the answer is to build less of it.
   */
  private renderWindow(force: boolean): void {
    const { first, last } = this.visibleRange();
    if (!force && first >= this.windowFrom && last <= this.windowTo) return;

    const total = this.lineOffsets.length;
    const from = Math.max(0, first - WINDOW_MARGIN);
    const to = Math.min(total - 1, last + WINDOW_MARGIN);

    const source = this.textarea.value;
    const start = this.lineOffsets[from];
    const end = to + 1 < total ? this.lineOffsets[to + 1] - 1 : source.length;

    // Tokens and overlays are clipped to the window and rebased onto it.
    const tokens: Token[] = [];
    for (let i = firstTokenFrom(this.tokens, start); i < this.tokens.length; i++) {
      const token = this.tokens[i];
      if (token.start >= end) break;
      tokens.push({
        start: Math.max(token.start, start) - start,
        end: Math.min(token.end, end) - start,
        cls: token.cls,
      });
    }

    const overlays: Overlay[] = [];
    for (const overlay of this.overlays()) {
      if (overlay.end <= start || overlay.start >= end) continue;
      overlays.push({
        start: Math.max(overlay.start, start) - start,
        end: Math.min(overlay.end, end) - start,
        cls: overlay.cls,
      });
    }

    // A trailing newline keeps the last line visible while scrolling.
    this.highlighted.innerHTML = renderTokens(source.slice(start, end), tokens, overlays) + '\n';

    // The numbers only change when the window moves, which most keystrokes do
    // not do -- and rebuilding them invalidates layout for nothing.
    if (from !== this.windowFrom || to !== this.windowTo) {
      let numbers = '';
      for (let line = from; line <= to; line++) numbers += `<span>${line + 1}</span>`;
      this.gutterLines.innerHTML = numbers;
      this.windowFrom = from;
      this.windowTo = to;
      this.currentRow = -1;
    }
    this.markCurrentLine();
  }

  /** Search matches and the bracket pair under the caret, in document offsets. */
  private overlays(): Overlay[] {
    const overlays: Overlay[] = [];
    const { query, matches, index } = this.find;

    if (query && !this.findBar.hidden) {
      matches.forEach((start, at) => {
        overlays.push({
          start,
          end: start + query.length,
          cls: at === index ? 'ovl-match ovl-match-current' : 'ovl-match',
        });
      });
    }

    if (this.bracketPair) {
      overlays.push({ start: this.bracketPair[0], end: this.bracketPair[0] + 1, cls: 'ovl-bracket' });
      overlays.push({ start: this.bracketPair[1], end: this.bracketPair[1] + 1, cls: 'ovl-bracket' });
    }

    return overlays;
  }

  /** Returns true when the highlighted pair changed and a repaint is due. */
  private updateBracketPair(): boolean {
    const { selectionStart, selectionEnd } = this.textarea;
    const pair =
      selectionStart === selectionEnd && document.activeElement === this.textarea
        ? matchBracket(this.textarea.value, this.tokens, selectionStart)
        : null;

    const before = this.bracketPair;
    const same = before === pair || (before && pair && before[0] === pair[0] && before[1] === pair[1]);
    this.bracketPair = pair;
    return !same;
  }

  /**
   * Move the overlay and the line numbers to wherever the textarea now is.
   *
   * `read` is false when the caller has already taken fresh metrics; reading
   * them again here, after the overlay has been rewritten, would force a second
   * layout of the whole textarea.
   */
  private syncScroll(read = true): void {
    if (read) this.readMetrics();
    this.renderWindow(false);

    const { scrollLeft, scrollTop } = this.metrics;
    const top = this.windowFrom * this.lineHeight - scrollTop;
    const transform = `translate(${-scrollLeft}px, ${top}px)`;
    if (transform !== this.lastTransform) {
      this.lastTransform = transform;
      this.highlighted.style.transform = transform;
      this.gutterLines.style.transform = `translateY(${top}px)`;
    }

    this.positionActiveLine();
    if (this.active) this.positionPopup();
  }

  /** Everything that depends on where the caret is. */
  private syncCaret(): void {
    this.updateStatus();
    // Moving the caret away from the word being completed invalidates the
    // popup: accepting one then would splice the name in at the old offset.
    if (this.active) {
      const { selectionStart, selectionEnd, value } = this.textarea;
      const typed = value.slice(this.active.start, selectionStart);
      if (
        selectionStart !== selectionEnd ||
        selectionStart < this.active.start ||
        /[^A-Za-z0-9_]/.test(typed)
      ) {
        this.dismiss();
      }
    }
    if (this.updateBracketPair()) {
      this.readMetrics();
      this.renderWindow(true);
      this.syncScroll(false);
      return;
    }
    this.syncScroll();
  }

  private positionActiveLine(): void {
    const { selectionStart, selectionEnd } = this.textarea;
    const collapsed = selectionStart === selectionEnd;
    this.activeLine.hidden = !collapsed;

    if (collapsed) {
      const row = this.rowOf(selectionStart);
      const height = `${this.lineHeight}px`;
      if (this.activeLine.style.height !== height) this.activeLine.style.height = height;
      this.activeLine.style.transform = `translateY(${
        this.paddingTop + row * this.lineHeight - this.metrics.scrollTop
      }px)`;
    }
    this.markCurrentLine();
  }

  private markCurrentLine(): void {
    const row = this.rowOf(this.textarea.selectionStart);
    if (row === this.currentRow) return;

    this.gutterLines.children[this.currentRow - this.windowFrom]?.classList.remove('current');
    this.gutterLines.children[row - this.windowFrom]?.classList.add('current');
    this.currentRow = row;
  }

  private updateStatus(): void {
    const { selectionStart, selectionEnd, value } = this.textarea;
    const { row, column } = this.positionOf(selectionStart);
    const selected = selectionEnd - selectionStart;

    const parts = [`Ln ${row + 1}, Col ${column + 1}`];
    if (selected > 0) {
      const rows = this.rowOf(selectionEnd) - row + 1;
      parts.push(rows > 1 ? `${selected} selected on ${rows} lines` : `${selected} selected`);
    }
    const lines = this.lineOffsets.length;
    parts.push(`${lines} line${lines === 1 ? '' : 's'}`);
    parts.push(`${value.length} chars`);
    this.status.textContent = parts.join('   ·   ');
  }

  /** Scroll the smallest amount that brings an offset into view. */
  private reveal(offset: number): void {
    this.measure();
    const area = this.textarea;
    const { row, column } = this.positionOf(offset);

    const top = this.paddingTop + row * this.lineHeight;
    if (top < area.scrollTop) {
      area.scrollTop = Math.max(0, top - this.lineHeight * 2);
    } else if (top + this.lineHeight > area.scrollTop + area.clientHeight) {
      area.scrollTop = top + this.lineHeight * 3 - area.clientHeight;
    }

    const left = this.paddingLeft + column * this.charWidth;
    if (left < area.scrollLeft + this.paddingLeft) {
      area.scrollLeft = Math.max(0, left - this.charWidth * 8);
    } else if (left > area.scrollLeft + area.clientWidth) {
      area.scrollLeft = left + this.charWidth * 8 - area.clientWidth;
    }

    this.syncScroll();
  }

  // -- find and replace --------------------------------------------------

  /**
   * Shortcuts that must keep working while a find field has focus.
   *
   * The editor's own key handling lives on the textarea, so without this
   * Ctrl+F inside the find box reaches the browser's own search instead.
   * Returns true when the event was handled.
   */
  private findFieldKey(event: KeyboardEvent): boolean {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.closeFind();
      return true;
    }
    if (!(event.ctrlKey || event.metaKey)) return false;

    switch (event.key.toLowerCase()) {
      case 'f':
        event.preventDefault();
        this.findInput.focus();
        this.findInput.select();
        return true;
      case 'h':
        event.preventDefault();
        this.replaceInput.focus();
        this.replaceInput.select();
        return true;
      case 's':
        event.preventDefault();
        this.flush();
        return true;
      default:
        return false;
    }
  }

  private buildFindBar(): void {
    this.findInput = el('input', {
      type: 'text',
      class: 'find-field',
      placeholder: 'Find',
      spellcheck: false,
      oninput: () => {
        this.find.query = this.findInput.value;
        this.find.index = 0;
        this.updateMatches();
        this.gotoMatch(0, false);
      },
      onkeydown: (event: KeyboardEvent) => {
        if (this.findFieldKey(event)) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          this.gotoMatch(event.shiftKey ? -1 : 1);
        }
      },
    }) as HTMLInputElement;

    this.replaceInput = el('input', {
      type: 'text',
      class: 'find-field',
      placeholder: 'Replace with',
      spellcheck: false,
      onkeydown: (event: KeyboardEvent) => {
        if (this.findFieldKey(event)) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          this.replaceCurrent();
        }
      },
    }) as HTMLInputElement;

    this.findCount = el('span', { class: 'find-count muted small' });

    this.caseButton = el('button', {
      class: 'mini',
      text: 'Aa',
      title: 'Match case',
      onclick: () => {
        this.find.caseSensitive = !this.find.caseSensitive;
        this.caseButton.classList.toggle('active', this.find.caseSensitive);
        this.updateMatches();
      },
    }) as HTMLButtonElement;

    this.findBar = el(
      'div',
      { class: 'code-find', hidden: true },
      this.findInput,
      this.caseButton,
      this.findCount,
      el('button', { class: 'mini', text: '↑', title: 'Previous (Shift+Enter)', onclick: () => this.gotoMatch(-1) }),
      el('button', { class: 'mini', text: '↓', title: 'Next (Enter)', onclick: () => this.gotoMatch(1) }),
      this.replaceInput,
      el('button', { class: 'mini', text: 'Replace', onclick: () => this.replaceCurrent() }),
      el('button', { class: 'mini', text: 'All', title: 'Replace every match', onclick: () => this.replaceAll() }),
      el('button', { class: 'mini', text: '✕', title: 'Close (Esc)', onclick: () => this.closeFind() }),
    );
  }

  private openFind(withReplace = false): void {
    const { selectionStart, selectionEnd, value } = this.textarea;
    const selected = value.slice(selectionStart, selectionEnd);
    // Seed from the selection, the way every editor does.
    if (selected && !selected.includes('\n')) {
      this.findInput.value = selected;
      this.find.query = selected;
      this.find.index = 0;
    }

    this.findBar.hidden = false;
    this.updateMatches();
    const field = withReplace ? this.replaceInput : this.findInput;
    field.focus();
    field.select();
  }

  private closeFind(): void {
    this.findBar.hidden = true;
    // Focus first: the bracket overlay only renders for the focused editor.
    this.textarea.focus();
    this.paint();
  }

  /**
   * Recompute where the query occurs.
   *
   * Called from `paint()` as well as from the find bar, because the document
   * can change underneath an open search: a replace driven from offsets
   * recorded before the edit splices at the wrong characters and quietly
   * mangles the file.
   */
  private computeMatches(): void {
    const { query, caseSensitive } = this.find;
    const value = this.textarea.value;
    const matches: number[] = [];

    if (query) {
      const hay = caseSensitive ? value : value.toLowerCase();
      const needle = caseSensitive ? query : query.toLowerCase();
      let at = hay.indexOf(needle);
      while (at !== -1) {
        matches.push(at);
        at = hay.indexOf(needle, at + Math.max(1, needle.length));
      }
    }

    this.find.matches = matches;
    if (this.find.index >= matches.length) this.find.index = 0;
    this.findCount.textContent = query
      ? matches.length
        ? `${this.find.index + 1} of ${matches.length}`
        : 'no matches'
      : '';
  }

  private updateMatches(): void {
    this.computeMatches();
    this.renderWindow(true);
  }

  private gotoMatch(delta: number, wrap = true): void {
    const { matches, query } = this.find;
    if (matches.length === 0) return;

    if (delta !== 0 || wrap) {
      this.find.index = (this.find.index + delta + matches.length) % matches.length;
    }
    const at = matches[this.find.index];
    this.textarea.setSelectionRange(at, at + query.length);
    this.reveal(at);
    this.findCount.textContent = `${this.find.index + 1} of ${matches.length}`;
    this.renderWindow(true);
  }

  private replaceCurrent(): void {
    const { matches, query, index, caseSensitive } = this.find;
    if (!query || matches.length === 0) return;

    const at = matches[index];
    const found = this.textarea.value.slice(at, at + query.length);
    const same = caseSensitive ? found === query : found.toLowerCase() === query.toLowerCase();
    if (!same) {
      // The offset went stale; resynchronise rather than splice blindly.
      this.updateMatches();
      return;
    }

    const replacement = this.replaceInput.value;
    // edit() paints, and paint() recomputes the matches while the bar is open.
    this.edit(at, at + query.length, replacement);

    // Step past what was just written. Without this, replacing `a` with `aa`
    // would find the same place again and never move on.
    const after = at + replacement.length;
    const next = this.find.matches.findIndex((match) => match >= after);
    this.find.index = next === -1 ? 0 : next;

    this.gotoMatch(0, false);
    this.replaceInput.focus();
  }

  private replaceAll(): void {
    const { matches, query } = this.find;
    if (!query || matches.length === 0) return;

    const value = this.textarea.value;
    const replacement = this.replaceInput.value;
    let out = '';
    let at = 0;
    for (const start of matches) {
      out += value.slice(at, start) + replacement;
      at = start + query.length;
    }
    out += value.slice(at);

    const count = matches.length;
    this.edit(0, value.length, out, [0, 0]);
    this.findCount.textContent = `replaced ${count}`;
    this.findInput.focus();
  }

  // -- autocomplete ------------------------------------------------------

  /**
   * Work out what can be completed at the caret.
   *
   * `explicit` means the user asked (Ctrl+Space), which offers everything even
   * with no prefix typed; otherwise a prefix is required so the popup does not
   * appear on every keystroke.
   *
   * Everything here scans backwards from the caret by hand. An anchored regex
   * over `source.slice(0, caret)` copies and rescans the whole file on every
   * keystroke, which is fine at fifty lines and not at two thousand.
   */
  private updateCompletions(explicit: boolean): void {
    const source = this.textarea.value;
    const caret = this.textarea.selectionStart;
    if (caret !== this.textarea.selectionEnd) return this.dismiss();

    let start = caret;
    while (start > 0 && isWordCode(source.charCodeAt(start - 1))) start--;
    // Digits can start the run but not an identifier; that is a number.
    if (start < caret && !isWordStartCode(source.charCodeAt(start))) return this.dismiss();
    const prefix = source.slice(start, caret);

    const inString = isCaretInString(this.tokens, start);
    // Nothing useful to say inside a comment.
    if (!inString && !isCaretInCode(this.tokens, start)) return this.dismiss();

    // The character before the word, skipping blanks.
    let at = start;
    while (at > 0 && isBlank(source.charCodeAt(at - 1))) at--;
    const accessor = at > 0 ? source[at - 1] : '';
    const language = this.language;
    const afterAccessor = !inString && language.memberAccessors.includes(accessor);

    if (!explicit && prefix.length === 0 && !afterAccessor) return this.dismiss();

    let pool: ApiEntry[];
    let callable = true;

    if (inString) {
      // A string that a service call opens only ever takes a service name, so
      // do not bury those few names among every asset in the project.
      const context = source.slice(Math.max(0, start - 48), start);
      const opensService = language.serviceCallPattern.test(context);
      pool = (opensService ? language.serviceNames : this.getAssetNames()).map((name) => ({
        name,
        kind: 'asset' as const,
      }));
      callable = false;
    } else if (afterAccessor) {
      let ownerEnd = at - 1;
      while (ownerEnd > 0 && isBlank(source.charCodeAt(ownerEnd - 1))) ownerEnd--;
      let ownerStart = ownerEnd;
      while (ownerStart > 0 && isWordCode(source.charCodeAt(ownerStart - 1))) ownerStart--;
      const owner = ownerStart < ownerEnd ? source.slice(ownerStart, ownerEnd) : undefined;
      pool = language.membersFor(owner, accessor);
    } else {
      pool = language.globalCompletions;
    }

    const scored: { entry: ApiEntry; rank: number }[] = [];
    const rankAll = (entries: ApiEntry[], cap = Infinity) => {
      for (const entry of entries) {
        // The word being typed is not a useful suggestion for itself.
        if (entry.kind === 'local' && entry.name === prefix) continue;
        const rank = completionRank(entry.name, prefix);
        if (rank >= 0 && scored.push({ entry, rank }) >= cap) return;
      }
    };
    rankAll(pool);
    // Ranked separately rather than concatenated: a big file has thousands of
    // local names, and building one merged array per keystroke is pure waste.
    // Capped, too -- only forty are ever shown, and a file where thousands of
    // identifiers share a prefix should not cost more than one where none do.
    if (pool === language.globalCompletions) rankAll(this.localNames(), 400);
    // Plain comparisons, not localeCompare: these are ASCII identifiers, and a
    // collator over a couple of thousand candidates is the slowest thing here.
    scored.sort(
      (a, b) =>
        b.rank - a.rank ||
        a.entry.name.length - b.entry.name.length ||
        (a.entry.name < b.entry.name ? -1 : a.entry.name > b.entry.name ? 1 : 0),
    );

    const items = scored.slice(0, 40).map((entry) => entry.entry);
    // Nothing to offer, or the only match is exactly what is typed already.
    if (items.length === 0 || (items.length === 1 && items[0].name === prefix)) {
      return this.dismiss();
    }

    this.active = { items, index: 0, start, callable };
    this.renderPopup();
  }

  /**
   * Identifiers already used in this file, so local names complete too.
   *
   * Rebuilt at most twice a second: it is a full scan of the document, and the
   * set of names in a file does not meaningfully change between keystrokes.
   */
  private localNames(): ApiEntry[] {
    const now = performance.now();
    if (this.localsAt && now - this.localsAt < 500) return this.locals;

    const seen = new Set<string>();
    const { keywords, engineNames } = this.language;
    for (const match of this.textarea.value.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const name = match[0];
      if (!keywords.has(name) && !engineNames.has(name)) seen.add(name);
    }

    this.locals = [...seen].map((name) => ({ name, kind: 'local' as const }));
    this.localsAt = now;
    return this.locals;
  }

  /** One line of documentation for whatever is selected, under the list. */
  private showDoc(): void {
    const entry = this.active?.items[this.active.index];
    this.docLine.textContent = entry?.doc ?? '';
    this.docLine.hidden = !entry?.doc;
  }

  private renderPopup(): void {
    if (!this.active) return;
    clear(this.list);

    this.active.items.forEach((entry, index) => {
      this.list.append(
        el(
          'div',
          {
            class: 'complete-item' + (index === this.active!.index ? ' selected' : ''),
            // pointerdown, because the textarea's blur would close us first.
            onpointerdown: (event: PointerEvent) => {
              event.preventDefault();
              this.active!.index = index;
              this.accept();
            },
          },
          el('span', { class: `complete-icon kind-${entry.kind}`, text: ICONS[entry.kind] }),
          el('span', { class: 'complete-name', text: entry.name }),
          entry.signature ? el('span', { class: 'complete-sig', text: entry.signature }) : null,
        ),
      );
    });

    this.popup.hidden = false;
    this.showDoc();
    this.positionPopup();
    this.scrollSelectionIntoView();
  }

  private move(delta: number): void {
    if (!this.active) return;
    const count = this.active.items.length;
    this.active.index = (this.active.index + delta + count) % count;
    for (const [index, node] of [...this.list.children].entries()) {
      node.classList.toggle('selected', index === this.active.index);
    }
    this.showDoc();
    this.scrollSelectionIntoView();
  }

  private scrollSelectionIntoView(): void {
    const node = this.list.children[this.active?.index ?? 0] as HTMLElement | undefined;
    node?.scrollIntoView({ block: 'nearest' });
  }

  /** Does the highlighted suggestion actually extend the word being typed? */
  private acceptsOnEnter(): boolean {
    if (!this.active) return false;
    const entry = this.active.items[this.active.index];
    const typed = this.textarea.value.slice(this.active.start, this.textarea.selectionStart);
    if (!typed) return false;
    // Already typed in full -- `do` offering `do` -- so accepting would add
    // nothing and would eat the newline the user actually asked for.
    if (entry.name === typed && !entry.signature) return false;
    return entry.name.toLowerCase().startsWith(typed.toLowerCase());
  }

  private accept(): void {
    if (!this.active) return;
    const { items, index, start, callable } = this.active;
    const entry = items[index];
    const caret = this.textarea.selectionStart;
    const source = this.textarea.value;

    // Take the whole word, not just what is behind the caret. Accepting with
    // the caret in the middle of `insta|nce` should leave `instance_create()`,
    // not `instance_create()nce`.
    let end = caret;
    while (end < source.length && isWordCode(source.charCodeAt(end))) end++;

    const isCall = callable && (entry.kind === 'function' || entry.kind === 'method');
    const alreadyOpen = source[end] === '(';
    const insert = entry.name + (isCall && !alreadyOpen ? '()' : '');

    // Land the caret between the parentheses when we added them.
    const offset = isCall && !alreadyOpen ? insert.length - 1 : insert.length;

    this.dismiss();
    this.edit(start, end, insert, [start + offset, start + offset]);
  }

  private dismiss(): void {
    this.active = null;
    this.popup.hidden = true;
  }

  /**
   * The font is monospace, so the caret is measurable from row and column.
   *
   * Retried until the editor is in the document: a detached element has no
   * computed style, and caching the nonsense that comes back would leave every
   * later measurement wrong.
   */
  private measure(): void {
    if (this.measured) return;

    const style = getComputedStyle(this.textarea);
    const fontSize = parseFloat(style.fontSize);
    if (!Number.isFinite(fontSize) || !this.element.isConnected) return;

    const canvas = document.createElement('canvas').getContext('2d')!;
    canvas.font = `${style.fontSize} ${style.fontFamily}`;
    this.charWidth = canvas.measureText('0').width || fontSize * 0.6;
    this.lineHeight = parseFloat(style.lineHeight) || fontSize * 1.55;
    this.paddingTop = parseFloat(style.paddingTop) || 10;
    this.paddingLeft = parseFloat(style.paddingLeft) || 14;
    this.measured = this.charWidth > 0 && this.lineHeight > 0;
  }

  private positionPopup(): void {
    if (!this.active) return;
    this.measure();

    const { row, column } = this.positionOf(this.active.start);
    const x = this.paddingLeft + column * this.charWidth - this.metrics.scrollLeft;
    const y = this.paddingTop + (row + 1) * this.lineHeight - this.metrics.scrollTop;

    // From the cached metrics, not getBoundingClientRect: this runs right after
    // the overlay is rewritten, and a rect read there forces another layout.
    const { clientWidth, clientHeight } = this.metrics;
    const width = 340;
    this.popup.style.left = `${Math.max(4, Math.min(x, clientWidth - width - 8))}px`;

    // Flip above the caret when there is no room below.
    const docHeight = this.docLine.hidden ? 0 : 32;
    const height = Math.min(this.active.items.length, MAX_VISIBLE) * 22 + 8 + docHeight;
    if (y + height > clientHeight && y - height - this.lineHeight > 0) {
      this.popup.style.top = `${y - height - this.lineHeight}px`;
    } else {
      this.popup.style.top = `${y}px`;
    }
  }
}
