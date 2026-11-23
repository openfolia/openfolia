import {
  builtInLanguage,
  DEFAULT_CODE_LANGUAGES,
} from '../../doc-editor/blocks/code-languages';
import type { ConfigOption } from './config-model';

/**
 * Settings › Code languages over `codeLanguages`: the code block's picker ships its languages
 * (`DEFAULT_CODE_LANGUAGES`), and a configured entry either adds one of the project's own or,
 * with a shipped ID, renames that one. The shipped list stays in code and is never copied into
 * the configuration: only a renamed one is written.
 */

/** The project's own languages: the configured ones that are not built in, in their order. */
export function ownLanguages(
  configured: readonly ConfigOption[],
): ConfigOption[] {
  return configured.filter((l) => !builtInLanguage(l.id));
}

/**
 * The built-in languages in the picker's order, each under the project's name for it where the
 * configuration renames it (the last entry for it counts, as in the picker).
 */
export function builtInLanguages(
  configured: readonly ConfigOption[],
): ConfigOption[] {
  const renamed = new Map(
    configured.map((l) => [l.id.toLowerCase(), l.label] as const),
  );
  return DEFAULT_CODE_LANGUAGES.map((l) => ({
    id: l.id,
    label: renamed.get(l.id) ?? l.label,
  }));
}

/** The configured list after the own languages changed (order, a name, one fewer). */
export function withOwnLanguages(
  configured: readonly ConfigOption[],
  own: readonly ConfigOption[],
): ConfigOption[] {
  return [...own, ...configured.filter((l) => builtInLanguage(l.id))];
}

/**
 * The configured list with a built-in language under `label`: an entry with its ID where the
 * name differs from the shipped one (in place of any entry it had), none where it is the shipped
 * name or `label` is null (Reset). An ID that is not built in leaves the list as it was.
 */
export function withBuiltInName(
  configured: readonly ConfigOption[],
  id: string,
  label: string | null,
): ConfigOption[] {
  const shipped = builtInLanguage(id);
  if (!shipped) return [...configured];
  const isIt = (l: ConfigOption) => l.id.toLowerCase() === shipped.id;
  const rest = configured.filter((l) => !isIt(l));
  if (label === null || label === shipped.label) return rest;
  const entry = { id: shipped.id, label };
  const at = configured.findIndex(isIt);
  if (at < 0) return [...configured, entry];
  return configured.flatMap((l, i) =>
    i === at ? [entry] : isIt(l) ? [] : [l],
  );
}
