import type { ScriptLanguage, Scripting } from './types';

/**
 * What differs between the two scripting languages at the project level.
 *
 * Everything that reads or writes a script file, or creates a fresh one,
 * consults this table rather than assuming `.luau`. The engines themselves
 * live behind `src/engine/scriptHost.ts`; the editor's syntax and completion
 * behaviour behind `src/ui/languageSpec.ts`.
 */

export interface LanguageInfo {
  id: ScriptLanguage;
  label: string;
  /** File extension without the dot. */
  extension: string;
  /** What an object with a missing script file behaves as. */
  objectFallback: string;
  newObjectSource: (name: string) => string;
  newScriptSource: (name: string) => string;
}

export const LANGUAGES: Record<ScriptLanguage, LanguageInfo> = {
  luau: {
    id: 'luau',
    label: 'Luau',
    extension: 'luau',
    objectFallback: 'local obj = {}\n\nreturn obj\n',
    newObjectSource: (name) =>
      `--!strict\n-- ${name}\n\nlocal obj = {}\n\nfunction obj.create(self)\nend\n\nfunction obj.step(self)\nend\n\nreturn obj\n`,
    newScriptSource: (name) =>
      `--!strict\n-- ${name}: shared helpers, loaded before object scripts.\n\nfunction ${name}_example()\nend\n`,
  },
  python: {
    id: 'python',
    label: 'Python',
    extension: 'py',
    objectFallback: '',
    newObjectSource: (name) =>
      `# ${name}\n\n\ndef create(self):\n    pass\n\n\ndef step(self):\n    pass\n`,
    newScriptSource: (name) =>
      `# ${name}: shared helpers, loaded before object scripts.\n\n\ndef ${name}_example():\n    pass\n`,
  },
};

export const LANGUAGE_IDS: ScriptLanguage[] = ['luau', 'python'];

/** The language a project's scripts are in; absent means Luau. */
export function languageOf(config: { language?: ScriptLanguage }): ScriptLanguage {
  return config.language ?? 'luau';
}

export function languageInfo(config: { language?: ScriptLanguage }): LanguageInfo {
  return LANGUAGES[languageOf(config)];
}

/** How the project's scripts are authored; absent means the text editor. */
export function scriptingOf(config: { scripting?: Scripting }): Scripting {
  return config.scripting ?? 'code';
}
