/** Tiny DOM helpers. The app builds its UI directly; no framework needed. */

type Props = Record<string, unknown> & {
  class?: string;
  text?: string;
  html?: string;
  style?: string;
  title?: string;
  dataset?: Record<string, string>;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'html') node.innerHTML = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key in node) {
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }

  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }

  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** A panel occupying the editor area. */
export interface Panel {
  readonly element: HTMLElement;
  /** Called when the panel becomes visible. */
  activate?(): void;
  /** Called when another panel takes over. */
  deactivate?(): void;
  dispose?(): void;
}

/** Modal dialog with a promise result; used for resize and rename prompts. */
export function modal(title: string, body: HTMLElement, confirmLabel = 'OK'): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ok: boolean) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey);
      resolve(ok);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish(false);
      if (event.key === 'Enter' && event.target instanceof HTMLInputElement) finish(true);
    };

    const box = el(
      'div',
      { class: 'modal-box' },
      el('h2', { text: title }),
      body,
      el(
        'div',
        { class: 'modal-actions' },
        el('button', { text: 'Cancel', onclick: () => finish(false) }),
        el('button', { class: 'primary', text: confirmLabel, onclick: () => finish(true) }),
      ),
    );

    const backdrop = el(
      'div',
      {
        class: 'modal-backdrop',
        onclick: (event: MouseEvent) => {
          if (event.target === backdrop) finish(false);
        },
      },
      box,
    );

    document.body.append(backdrop);
    document.addEventListener('keydown', onKey);
    box.querySelector('input')?.focus();
  });
}
