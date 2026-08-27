import { GameRuntime } from '../engine/runtime';
import { getScriptHost } from '../engine/scriptHost';
import { languageInfo } from '../project/languages';
import type { ProjectStore } from '../project/store';
import { el, type Panel } from './dom';

/**
 * The play panel.
 *
 * Builds a fresh runtime from the project every time you press Run, so what
 * plays is always the current state of the editors -- no build step.
 */
export class GamePanel implements Panel {
  readonly element: HTMLElement;

  private canvas: HTMLCanvasElement;
  private overlay: HTMLElement;
  private overlayText: HTMLElement;
  private errorBox: HTMLElement;
  private errorText: HTMLElement;
  private errorSource: HTMLElement;
  private statLabel: HTMLElement;
  private runButton: HTMLButtonElement;
  private stopButton: HTMLButtonElement;

  private runtime?: GameRuntime;
  private statsTimer = 0;

  constructor(private readonly store: ProjectStore) {
    this.canvas = el('canvas', { class: 'game-canvas', width: 960, height: 576, tabindex: '0' }) as HTMLCanvasElement;
    this.overlayText = el('p', { class: 'muted', text: 'Press Run to play the current project.' });
    this.overlay = el('div', { class: 'game-overlay' }, this.overlayText);
    this.errorText = el('pre');
    this.errorSource = el('div');
    this.errorBox = el(
      'div',
      { class: 'game-error', hidden: true },
      el('h3', { text: 'The game stopped' }),
      this.errorText,
      this.errorSource,
    );
    this.statLabel = el('span', { class: 'mono muted' });

    this.runButton = el('button', { class: 'primary', text: '▶ Run', onclick: () => void this.run() }) as HTMLButtonElement;
    this.stopButton = el('button', { text: '■ Stop', disabled: true, onclick: () => this.stop() }) as HTMLButtonElement;

    this.element = el(
      'div',
      { class: 'game-panel' },
      el(
        'div',
        { class: 'game-bar' },
        this.runButton,
        this.stopButton,
        el('span', { class: 'grow' }),
        this.statLabel,
      ),
      el('div', { class: 'game-stage' }, el('div', { class: 'game-frame' }, this.canvas, this.overlay), this.errorBox),
    );
  }

  activate(): void {
    this.statsTimer = window.setInterval(() => {
      const ms = this.runtime?.averageFrameMs ?? 0;
      const jspi = 'Suspending' in WebAssembly && 'promising' in WebAssembly;
      this.statLabel.textContent = ms ? `${ms.toFixed(1)} ms/frame · ${jspi ? 'JSPI' : 'Asyncify'}` : '';
    }, 250);
  }

  deactivate(): void {
    clearInterval(this.statsTimer);
    this.stop();
  }

  dispose(): void {
    this.deactivate();
    void this.runtime?.dispose();
  }

  async run(): Promise<void> {
    this.errorBox.hidden = true;
    this.overlay.hidden = false;
    this.overlayText.textContent = `Compiling ${languageInfo(this.store.project.config).label} and building the atlas…`;
    this.runButton.disabled = true;
    this.stopButton.disabled = false;

    // Must complete before a new VM is created, or the old one tears down
    // underneath it.
    await this.runtime?.dispose();
    this.runtime = undefined;

    try {
      this.runtime = await GameRuntime.create(
        this.canvas,
        this.store.project,
        (message) => this.fail(message),
        getScriptHost,
      );
      this.overlay.hidden = true;
      this.runtime.start();
      this.canvas.focus();
    } catch (error) {
      this.fail(describeFailure(error));
    }
  }

  stop(): void {
    this.runtime?.stop();
    this.runButton.disabled = false;
    this.stopButton.disabled = true;
    if (this.errorBox.hidden) {
      this.overlay.hidden = false;
      this.overlayText.textContent = 'Stopped. Press Run to play again.';
    }
  }

  private fail(message: string): void {
    this.errorText.textContent = message;

    // Luau errors carry `[string "obj_thing.luau"]:12:` and Python tracebacks
    // `File "obj_thing.py", line 12`, and the source is right here in the
    // project -- so show the line instead of making the reader go and count.
    this.errorSource.replaceChildren();
    const excerpt = this.sourceExcerpt(message);
    if (excerpt) this.errorSource.append(excerpt);

    this.errorBox.hidden = false;
    this.overlay.hidden = true;
    this.runButton.disabled = false;
    this.stopButton.disabled = true;
  }

  /** Render the offending line of game code, with a little context. */
  private sourceExcerpt(message: string): HTMLElement | null {
    const located = locateError(message);
    if (!located) return null;

    const { name, line } = located;
    const source =
      this.store.object(name)?.source ?? this.store.script(name)?.source ?? null;
    if (!source) return null;

    const lines = source.split('\n');
    const from = Math.max(1, line - 2);
    const to = Math.min(lines.length, line + 2);

    const rows: HTMLElement[] = [];
    for (let n = from; n <= to; n++) {
      rows.push(
        el(
          'div',
          { class: 'error-line' + (n === line ? ' offending' : '') },
          el('span', { class: 'error-lineno', text: String(n) }),
          el('span', { class: 'error-code', text: lines[n - 1] ?? '' }),
        ),
      );
    }

    return el(
      'div',
      { class: 'error-source' },
      el('div', { class: 'error-file', text: `${name}.${languageInfo(this.store.project.config).extension} line ${line}` }),
      ...rows,
    );
  }

  get isRunning(): boolean {
    return this.stopButton.disabled === false;
  }

  get frameMs(): number {
    return this.runtime?.averageFrameMs ?? 0;
  }

  /** Steps the running game has taken; the tests check the rate. */
  get stepCount(): number {
    return this.runtime?.stepCount ?? 0;
  }

  /** The room the running game is in, or '' when nothing runs. */
  room(): Promise<string> {
    return this.runtime?.currentRoom() ?? Promise.resolve('');
  }
}

/**
 * The script and line an engine error points at, for either language.
 *
 * A Python traceback lists every frame, outermost first; the last project
 * file it names is where the fault is.
 */
export function locateError(message: string): { name: string; line: number } | null {
  const luau = /\[string "([^"]+?)(?:\.luau)?"\]:(\d+)/.exec(message);
  if (luau) return { name: luau[1], line: Number(luau[2]) };

  let last: RegExpExecArray | null = null;
  const python = /File "([^"<>]+)\.py", line (\d+)/g;
  for (let match = python.exec(message); match; match = python.exec(message)) last = match;
  return last ? { name: last[1], line: Number(last[2]) } : null;
}

/**
 * What to show for a failed run. A Python exception's message is already a
 * full traceback ending in the script and line, so the JavaScript frames
 * under it would only bury that; a Luau error keeps its stack, which is
 * where the script name and line live.
 */
export function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  if (error.name === 'PythonError') return error.message.trim();
  return error.stack ?? error.message;
}
