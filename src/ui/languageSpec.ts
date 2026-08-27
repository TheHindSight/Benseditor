/**
 * Everything the code editor needs to know about a language, in one object.
 *
 * `CodeEditor` itself is a textarea with a highlight overlay, line commands,
 * find and replace and a completion popup; none of that cares which language
 * is in the box. What does -- the tokeniser, the indent string, which keys
 * open a block, what a comment looks like, which names to complete -- comes
 * through this interface, so a second language is a second spec and not a
 * second editor.
 */
import type { ApiEntry } from './apiSurface';
import type { Token } from './syntaxCore';

/**
 * What the editor knows when Enter is pressed.
 *
 * Offsets are into `source`. The selection is what Enter replaces -- usually
 * collapsed, so `selectionStart === selectionEnd`. The line fields describe
 * the line the selection starts on, which is the one whose indentation and
 * trailing keyword decide what the next line looks like.
 */
export interface NewlineContext {
  /** The whole document. */
  source: string;
  /** Tokens of the whole document, from `LanguageSpec.tokenize`. */
  tokens: Token[];
  selectionStart: number;
  selectionEnd: number;
  /** Offset where the caret's line starts. */
  lineStart: number;
  /** The caret's line from its start up to the caret. */
  textToCaret: string;
  /** Leading blanks (tabs and spaces) of that line. */
  indent: string;
  /** The character right after the selection, or '' at the end of the file. */
  nextChar: string;
  /** The rest of the line after the selection, up to but excluding its newline. */
  rest: string;
  /** Offset of that line's newline, or the end of the file. */
  lineEnd: number;
}

/** What Enter should do: replace the selection with `text`, put the caret at `caret`. */
export interface NewlineEdit {
  text: string;
  /** Document offset of the caret after the edit. */
  caret: number;
}

export interface LanguageSpec {
  /** Short machine name, e.g. `luau`. */
  id: string;
  /** Shown in the editor header, e.g. `Luau`. */
  label: string;
  /** File extension without the dot, e.g. `luau`. */
  extension: string;

  /** What Tab inserts and one indent level is, e.g. `\t`. */
  indent: string;
  /** Typing an opener inserts its partner; typing the closer steps over it. */
  pairs: Record<string, string>;
  /** Marker a line comment starts with, e.g. `--` or `#`. */
  lineComment: string;

  /** Split `source` into tokens; see the invariants in `syntaxCore.ts`. */
  tokenize(source: string): Token[];

  /**
   * What Enter inserts, and where the caret lands.
   *
   * The spec decides whether the line opened a block, whether a closer should
   * be written on the line after, and what to do between a freshly typed
   * pair. The editor only performs the edit.
   */
  newline(ctx: NewlineContext): NewlineEdit;

  /**
   * Matched against the current line up to the caret after each typed
   * character. Group 1 is the indentation to shorten by one character and
   * group 2 is the word that earned it, so `\tend` pulls back to `end`.
   */
  dedentPattern: RegExp;

  /** Everything completable at the top level of a script. */
  globalCompletions: ApiEntry[];
  /** The characters that, written after a receiver, ask for its members. */
  memberAccessors: readonly string[];
  /** Members offered after one of `memberAccessors`; `owner` is the receiver. */
  membersFor(owner: string | undefined, accessor: string): ApiEntry[];
  /**
   * Matched against the text before a string literal's opening quote; when it
   * hits, `serviceNames` are offered instead of asset names.
   */
  serviceCallPattern: RegExp;
  serviceNames: readonly string[];

  /** Reserved words, excluded from the local names a file offers for completion. */
  keywords: ReadonlySet<string>;
  /** The language's own builtins, e.g. `math`, `print`. */
  builtins: ReadonlySet<string>;
  /** Engine-provided globals, excluded from local names as well. */
  engineNames: ReadonlySet<string>;

  /** Pull the script name and line out of a runtime error message. */
  parseError(message: string): { name: string; line: number } | null;
  /** Shown in the game panel while a build is running. */
  compilingText: string;
}
