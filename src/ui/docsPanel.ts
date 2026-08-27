import { clear, el, type Panel } from './dom';
import { highlightLuau } from './luauSyntax';
import { highlightPython } from './pythonSyntax';
import {
  ALL_ENTRIES,
  DOCS,
  methodReceiver,
  type DocBlock,
  type DocEntry,
  type DocLanguage,
  type DocSection,
} from './docsData';

/**
 * The manual, in the editor.
 *
 * Rendered from `docsData.ts`, which the markdown under `docs/` is generated
 * from as well -- so the reference you get offline and the one in the app are
 * the same text. Code samples run through the editor's own highlighter.
 *
 * The panel shows one language at a time: the project's, by default, with a
 * switch in the header for the other. Where the manual has no Python variant
 * of a sample or a sentence the Luau one is shown as it is.
 */

/**
 * Escape, then honour the markdown the manual actually uses: `**bold**`,
 * `*italic*` and `` `code` ``. The text is ours, not a user's, but it is
 * escaped first anyway. Bold is matched before italic so `**` is not read as
 * an empty emphasis.
 */
function inline(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function codeBlock(source: string, language: DocLanguage): HTMLElement {
  const highlight = language === 'python' ? highlightPython : highlightLuau;
  return el('pre', { class: 'doc-code' }, el('code', { class: 'mono', html: highlight(source) }));
}

/** The Python twin when in Python mode, the Luau original otherwise -- or when there is no twin. */
function pick<T>(language: DocLanguage, luau: T | undefined, python: T | undefined): T | undefined {
  return language === 'python' ? (python ?? luau) : luau;
}

function renderBlock(block: DocBlock, language: DocLanguage): HTMLElement {
  const text = pick(language, block.text, block.pythonText);
  const list = pick(language, block.list, block.pythonList);
  const code = pick(language, block.code, block.pythonCode);

  const parts: (HTMLElement | null)[] = [
    block.heading ? el('h4', { text: block.heading }) : null,
    text ? el('p', { html: inline(text) }) : null,
    list ? el('ul', {}, ...list.map((item) => el('li', { html: inline(item) }))) : null,
    block.table
      ? el(
          'div',
          { class: 'doc-table-wrap' },
          el(
            'table',
            { class: 'doc-table' },
            el('thead', {}, el('tr', {}, ...block.table.head.map((h) => el('th', { html: inline(h) })))),
            el(
              'tbody',
              {},
              ...block.table.rows.map((row) =>
                el('tr', {}, ...row.map((cell) => el('td', { html: inline(cell) }))),
              ),
            ),
          ),
        )
      : null,
    code ? codeBlock(code, language) : null,
  ];

  return el('div', { class: 'doc-block' }, ...parts);
}

function renderEntry(entry: DocEntry, language: DocLanguage): HTMLElement {
  const detail = pick(language, entry.detail, entry.pythonDetail);
  const example = pick(language, entry.example, entry.pythonExample);
  return el(
    'div',
    { class: 'doc-entry' },
    el(
      'div',
      { class: 'doc-entry-head' },
      // A method is called on an instance, and how depends on the language.
      entry.origin === 'method'
        ? el('code', { class: 'doc-receiver muted', text: methodReceiver(language) })
        : null,
      el('code', { class: 'doc-name', text: entry.name }),
      entry.signature ? el('code', { class: 'doc-sig', text: entry.signature }) : null,
      entry.returns ? el('span', { class: 'doc-returns', text: `→ ${entry.returns}` }) : null,
    ),
    el('p', { class: 'doc-summary', html: inline(entry.summary) }),
    detail ? el('p', { class: 'doc-detail', html: inline(detail) }) : null,
    example ? codeBlock(example, language) : null,
  );
}

/** Everything searchable about an entry, lowercased once. */
const entryHaystack = (entry: DocEntry) =>
  `${entry.name} ${entry.signature ?? ''} ${entry.summary} ${entry.detail ?? ''} ${entry.pythonDetail ?? ''}`.toLowerCase();

function blockText(block: DocBlock): string {
  return [
    block.heading,
    block.text,
    block.pythonText,
    block.code,
    block.pythonCode,
    ...(block.list ?? []),
    ...(block.pythonList ?? []),
    ...(block.table?.rows.flat() ?? []),
  ]
    .filter(Boolean)
    .join(' ');
}

const sectionHaystack = (section: DocSection) =>
  `${section.title} ${section.blurb} ${section.pythonBlurb ?? ''} ${(section.blocks ?? []).map(blockText).join(' ')}`.toLowerCase();

interface Filtered {
  section: DocSection;
  /** Null means "show the whole section"; otherwise only these entries matched. */
  entries: DocEntry[] | null;
}

function filterSections(query: string): Filtered[] {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return DOCS.flatMap((chapter) =>
      chapter.sections.map((section) => ({ section, entries: null })),
    );
  }

  const found: Filtered[] = [];
  for (const chapter of DOCS) {
    for (const section of chapter.sections) {
      const entries = (section.entries ?? []).filter((entry) =>
        entryHaystack(entry).includes(needle),
      );
      const proseMatches = sectionHaystack(section).includes(needle);
      if (proseMatches) found.push({ section, entries: null });
      else if (entries.length) found.push({ section, entries });
    }
  }
  return found;
}

const LANGUAGE_LABELS: Record<DocLanguage, string> = { luau: 'Luau', python: 'Python' };

export class DocsPanel implements Panel {
  readonly element: HTMLElement;

  private readonly search: HTMLInputElement;
  private readonly nav: HTMLElement;
  private readonly content: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly languageButtons: Record<DocLanguage, HTMLButtonElement>;
  private language: DocLanguage;

  /** `language` is the project's; the header switch can show the other on demand. */
  constructor(language: DocLanguage = 'luau') {
    this.language = language;

    this.search = el('input', {
      type: 'text',
      class: 'docs-search',
      placeholder: 'Search the manual',
      spellcheck: false,
      oninput: () => this.render(),
    }) as HTMLInputElement;

    this.languageButtons = {
      luau: this.languageButton('luau'),
      python: this.languageButton('python'),
    };
    const toggle = el(
      'div',
      { class: 'docs-language', role: 'group', title: 'Show samples in' },
      this.languageButtons.luau,
      this.languageButtons.python,
    );

    this.nav = el('nav', { class: 'docs-nav-list' });
    this.content = el('div', { class: 'docs-content' });
    this.summary = el('p', { class: 'muted small docs-count' });

    this.element = el(
      'div',
      { class: 'docs-panel' },
      el(
        'aside',
        { class: 'docs-nav' },
        el('div', { class: 'docs-search-wrap' }, this.search, toggle, this.summary),
        this.nav,
      ),
      this.content,
    );

    this.render();
  }

  private languageButton(language: DocLanguage): HTMLButtonElement {
    return el('button', {
      type: 'button',
      text: LANGUAGE_LABELS[language],
      onclick: () => this.setLanguage(language),
    }) as HTMLButtonElement;
  }

  /** Switch the samples and wording to a language; called when the project's changes, too. */
  setLanguage(language: DocLanguage): void {
    if (language === this.language) {
      this.syncToggle();
      return;
    }
    this.language = language;
    const scroll = this.content.scrollTop;
    this.render();
    this.content.scrollTop = scroll;
  }

  private syncToggle(): void {
    for (const [id, button] of Object.entries(this.languageButtons)) {
      const on = id === this.language;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    }
  }

  activate(): void {
    this.search.focus();
  }

  /** Jump to a section, e.g. from a "what is this?" link elsewhere in the UI. */
  show(sectionId: string): void {
    this.search.value = '';
    this.render();
    this.scrollTo(sectionId);
  }

  private scrollTo(sectionId: string): void {
    const target = this.content.querySelector(`[data-section="${sectionId}"]`);
    target?.scrollIntoView({ block: 'start' });
  }

  private render(): void {
    const language = this.language;
    this.syncToggle();

    const query = this.search.value;
    const matches = filterSections(query);
    const visible = new Set(matches.map((m) => m.section.id));

    clear(this.nav);
    for (const chapter of DOCS) {
      const sections = chapter.sections.filter((section) => visible.has(section.id));
      if (sections.length === 0) continue;

      this.nav.append(el('h3', { text: chapter.title }));
      for (const section of sections) {
        this.nav.append(
          el('button', {
            class: 'docs-nav-item',
            text: section.title,
            onclick: () => this.scrollTo(section.id),
          }),
        );
      }
    }

    clear(this.content);
    if (matches.length === 0) {
      this.content.append(
        el('p', { class: 'muted docs-empty', text: `Nothing in the manual matches “${query}”.` }),
      );
    }

    for (const { section, entries } of matches) {
      const shown = entries ?? section.entries ?? [];
      const blurb = pick(language, section.blurb, section.pythonBlurb) ?? section.blurb;
      this.content.append(
        el(
          'section',
          { class: 'doc-section', dataset: { section: section.id } },
          el('h2', { text: section.title }),
          el('p', { class: 'doc-blurb', html: inline(blurb) }),
          // A partial match lists only the entries that matched, not the prose.
          ...(entries === null
            ? (section.blocks ?? []).map((block) => renderBlock(block, language))
            : []),
          ...shown.map((entry) => renderEntry(entry, language)),
        ),
      );
    }

    const total = query.trim()
      ? matches.reduce((sum, m) => sum + (m.entries ?? m.section.entries ?? []).length, 0)
      : ALL_ENTRIES.length;
    this.summary.textContent = query.trim()
      ? `${matches.length} section${matches.length === 1 ? '' : 's'}, ${total} entries`
      : `${ALL_ENTRIES.length} documented names`;

    this.content.scrollTop = 0;
  }
}
