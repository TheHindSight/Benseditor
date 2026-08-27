import type { ScriptLanguage } from '../project/types';
import type { LanguageSpec } from './languageSpec';
import { LUAU_LANGUAGE } from './luauLanguage';
import { PYTHON_LANGUAGE } from './pythonLanguage';

/** The editor behaviour for a project language. */
export function specFor(language: ScriptLanguage): LanguageSpec {
  return language === 'python' ? PYTHON_LANGUAGE : LUAU_LANGUAGE;
}
