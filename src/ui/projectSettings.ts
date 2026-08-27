import { reconcileExplorer } from '../project/explorer';
import { LANGUAGES, LANGUAGE_IDS, languageOf, scriptingOf } from '../project/languages';
import type { ProjectStore } from '../project/store';
import type { Paradigm, ScriptLanguage, Scripting } from '../project/types';
import { el, modal } from './dom';

/**
 * Project settings: the choices that shape the whole editor rather than one
 * asset -- the paradigm (how the sidebar is organised) and the scripting
 * language (which engine runs the game and which editor edits it).
 */

/**
 * Switch the scripting language.
 *
 * Nothing is translated: existing scripts keep their text and are simply
 * read by the other engine, which will reject them until rewritten. The
 * dialog says so before the user commits.
 */
export function setLanguage(store: ProjectStore, language: ScriptLanguage): void {
  if (languageOf(store.project.config) === language) return;
  store.commit(
    `switch scripts to ${LANGUAGES[language].label}`,
    () => {
      if (language === 'luau') delete store.project.config.language;
      else store.project.config.language = language;
    },
    true,
  );
}

/**
 * Switch between the text editor and the block editor.
 *
 * Blocks → code keeps every object's generated script and drops nothing --
 * the blocks stay on the objects, dormant, so switching back finds them.
 * Code → blocks opens objects that have blocks in the block editor; objects
 * written by hand keep their code and stay in the text editor until the user
 * starts them again from blocks.
 */
export function setScripting(store: ProjectStore, scripting: Scripting): void {
  if (scriptingOf(store.project.config) === scripting) return;
  store.commit(
    `switch to ${scripting}`,
    () => {
      if (scripting === 'code') delete store.project.config.scripting;
      else store.project.config.scripting = scripting;
    },
    true,
  );
}

/** The scripting-mode radio rows, shared by the New-project and Settings dialogs. */
export function scriptingChooser(current: Scripting): { element: HTMLElement; value: () => Scripting } {
  const options: { id: Scripting; label: string; hint: string }[] = [
    { id: 'code', label: 'Code', hint: 'Type scripts in the text editor.' },
    {
      id: 'blocks',
      label: 'Blocks',
      hint: 'Snap Scratch-style blocks together; they compile to the project’s language, which you can view any time.',
    },
  ];
  const radios = options.map((option) => {
    const input = el('input', { type: 'radio', name: 'scripting', value: option.id, checked: option.id === current }) as HTMLInputElement;
    return {
      input,
      row: el(
        'label',
        { class: 'checkbox-row paradigm-option' },
        input,
        el('span', {}, el('strong', { text: option.label }), el('span', { class: 'muted small', text: option.hint })),
      ),
    };
  });
  return {
    element: el('div', { class: 'paradigm-options' }, ...radios.map((r) => r.row)),
    value: () => (radios.find((r) => r.input.checked)?.input.value as Scripting | undefined) ?? current,
  };
}

/** The language radio rows, shared by the New-project and Settings dialogs. */
export function languageChooser(current: ScriptLanguage): { element: HTMLElement; value: () => ScriptLanguage } {
  const radios = LANGUAGE_IDS.map((id) => {
    const input = el('input', { type: 'radio', name: 'language', value: id, checked: id === current }) as HTMLInputElement;
    const hint =
      id === 'luau'
        ? 'GameMaker-flavoured Luau: `function obj.step(self) … end`. The original engine.'
        : 'The same engine and API in Python: `def step(self): …`. Runs on MicroPython.';
    return {
      input,
      row: el(
        'label',
        { class: 'checkbox-row paradigm-option' },
        input,
        el('span', {}, el('strong', { text: LANGUAGES[id].label }), el('span', { class: 'muted small', text: hint })),
      ),
    };
  });
  return {
    element: el('div', { class: 'paradigm-options' }, ...radios.map((r) => r.row)),
    value: () => (radios.find((r) => r.input.checked)?.input.value as ScriptLanguage | undefined) ?? current,
  };
}

export function paradigmOf(store: ProjectStore): Paradigm {
  return store.project.config.paradigm ?? 'gamemaker';
}

export const PARADIGMS: { id: Paradigm; label: string; hint: string }[] = [
  {
    id: 'gamemaker',
    label: 'GameMaker style',
    hint: 'Five flat lists: sprites, tilesets, objects, rooms, scripts.',
  },
  {
    id: 'roblox',
    label: 'Roblox style',
    hint: 'An Explorer tree: Workspace, StarterRooms, ReplicatedStorage and Assets, with folders you arrange.',
  },
];

/**
 * Switch paradigms in one undoable commit.
 *
 * Nothing is converted: the assets are the same either way, and the Explorer
 * tree is created the first time Roblox style is chosen and kept (dormant)
 * when switching back, so folders survive a round trip.
 */
export function setParadigm(store: ProjectStore, paradigm: Paradigm): void {
  if (paradigmOf(store) === paradigm) return;
  store.commit(
    `switch to ${paradigm} style`,
    () => {
      const project = store.project;
      if (paradigm === 'gamemaker') delete project.config.paradigm;
      else project.config.paradigm = paradigm;
      if (paradigm === 'roblox') reconcileExplorer(project);
    },
    true,
  );
}

/**
 * The paradigm radio rows, shared by the New-project and Settings dialogs.
 * Radios rather than a `<select>`: a dialog with one select is what the tests
 * and the eye expect, and the hints read better beside each choice.
 */
export function paradigmChooser(current: Paradigm): { element: HTMLElement; value: () => Paradigm } {
  const radios = PARADIGMS.map((option) => {
    const input = el('input', {
      type: 'radio',
      name: 'paradigm',
      value: option.id,
      checked: option.id === current,
    }) as HTMLInputElement;
    return {
      input,
      row: el(
        'label',
        { class: 'checkbox-row paradigm-option' },
        input,
        el('span', {}, el('strong', { text: option.label }), el('span', { class: 'muted small', text: option.hint })),
      ),
    };
  });
  return {
    element: el('div', { class: 'paradigm-options' }, ...radios.map((r) => r.row)),
    value: () => (radios.find((r) => r.input.checked)?.input.value as Paradigm | undefined) ?? current,
  };
}

export async function showProjectSettings(store: ProjectStore): Promise<void> {
  const chooser = paradigmChooser(paradigmOf(store));
  const language = languageChooser(languageOf(store.project.config));
  const scripting = scriptingChooser(scriptingOf(store.project.config));
  const hasScripts = store.project.objects.length + store.project.scripts.length > 0;
  const body = el(
    'div',
    { class: 'modal-body project-settings' },
    el('h3', { text: 'Style' }),
    el('p', { class: 'muted small', text: 'How the sidebar organises the project. Switching keeps every asset, script and room exactly as it is; only the arrangement changes, and it can be switched back at any time.' }),
    chooser.element,
    el('h3', { text: 'Scripting language' }),
    el('p', {
      class: 'muted small',
      text: hasScripts
        ? 'Scripts are not translated. After switching, every object and shared script must be rewritten in the new language before the game will run.'
        : 'Which language object scripts are written in.',
    }),
    language.element,
    el('h3', { text: 'Scripting' }),
    el('p', {
      class: 'muted small',
      text: 'Blocks compile to the language above. Switching to Code keeps the generated scripts and the blocks; switching back to Blocks reopens objects that have blocks, while hand-written objects keep their code.',
    }),
    scripting.element,
  );

  if (!(await modal('Project settings', body, 'Apply'))) return;
  setParadigm(store, chooser.value());
  setLanguage(store, language.value());
  setScripting(store, scripting.value());
}
