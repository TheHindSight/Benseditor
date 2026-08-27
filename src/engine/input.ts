/**
 * Keyboard and mouse capture.
 *
 * Serialised into one compact string per frame -- `held|pressed|released|mouse`
 * -- because pushing individual key states across the WASM boundary would cost
 * ~90us each. Luau parses it in a few microseconds.
 */

const SPECIAL_KEYS: Record<string, string> = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  Space: 'space',
  Enter: 'enter',
  NumpadEnter: 'enter',
  Escape: 'escape',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  ShiftLeft: 'shift',
  ShiftRight: 'shift',
  ControlLeft: 'ctrl',
  ControlRight: 'ctrl',
  AltLeft: 'alt',
  AltRight: 'alt',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  Comma: 'comma',
  Period: 'period',
};

/** Map a physical key to the name Luau game code uses. */
export function keyName(code: string): string | undefined {
  if (code.startsWith('Key')) return code.slice(3).toLowerCase();
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad') && /^\d$/.test(code.slice(6))) return code.slice(6);
  return SPECIAL_KEYS[code];
}

export class InputCapture {
  private readonly held = new Set<string>();
  private readonly pressed = new Set<string>();
  private readonly released = new Set<string>();

  private mouseX = 0;
  private mouseY = 0;
  private buttons = 0;
  private wheel = 0;

  private readonly listeners: (() => void)[] = [];

  constructor(private readonly canvas: HTMLCanvasElement) {}

  attach(): void {
    const on = <K extends keyof WindowEventMap>(
      target: Window | HTMLCanvasElement,
      type: K,
      handler: (event: WindowEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, handler as EventListener, options);
      this.listeners.push(() => target.removeEventListener(type, handler as EventListener));
    };

    on(window, 'keydown', (event) => {
      const name = keyName(event.code);
      if (!name) return;
      // Arrows and space would otherwise scroll the page.
      if (['left', 'right', 'up', 'down', 'space'].includes(name)) event.preventDefault();
      if (!this.held.has(name)) this.pressed.add(name);
      this.held.add(name);
    });

    on(window, 'keyup', (event) => {
      const name = keyName(event.code);
      if (!name) return;
      this.held.delete(name);
      this.released.add(name);
    });

    // Held keys would otherwise stick when the window loses focus.
    on(window, 'blur', () => {
      this.held.clear();
      this.pressed.clear();
      this.released.clear();
      this.buttons = 0;
    });

    on(this.canvas, 'mousemove', (event) => this.setMouse(event as MouseEvent));
    on(this.canvas, 'mousedown', (event) => {
      this.setMouse(event as MouseEvent);
      this.buttons |= 1 << (event as MouseEvent).button;
    });
    on(window, 'mouseup', (event) => {
      this.buttons &= ~(1 << (event as MouseEvent).button);
    });
    on(this.canvas, 'contextmenu', (event) => event.preventDefault());
    on(this.canvas, 'wheel', (event) => {
      this.wheel = Math.sign(-(event as WheelEvent).deltaY);
    }, { passive: true });
  }

  detach(): void {
    for (const remove of this.listeners) remove();
    this.listeners.length = 0;
  }

  /** Canvas pixels -> room coordinates. */
  private setMouse(event: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.mouseX = (event.clientX - rect.left) * (this.viewWidth / rect.width);
    this.mouseY = (event.clientY - rect.top) * (this.viewHeight / rect.height);
  }

  private viewWidth = 1;
  private viewHeight = 1;

  setView(width: number, height: number): void {
    this.viewWidth = width;
    this.viewHeight = height;
  }

  /** Serialise this frame's input, then clear the one-shot sets. */
  snapshot(): string {
    const parts = [
      [...this.held].join(','),
      [...this.pressed].join(','),
      [...this.released].join(','),
      `${this.mouseX.toFixed(2)},${this.mouseY.toFixed(2)},${this.buttons},${this.wheel}`,
    ];
    this.pressed.clear();
    this.released.clear();
    this.wheel = 0;
    return parts.join('|');
  }
}
