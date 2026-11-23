import type { ProjectConfig } from '@openfolia/content-model/core';

/** A language the code block's picker offers: the word stored on the block and its name. */
export interface CodeLanguage {
  readonly id: string;
  readonly label: string;
}

/**
 * The languages the picker ships with, in this order (Plain text, no language, is its own entry).
 * A project adds more, or renames one, with `codeLanguages` in its configuration.
 */
export const DEFAULT_CODE_LANGUAGES: readonly CodeLanguage[] = [
  { id: 'bash', label: 'Bash / Shell' },
  { id: 'json', label: 'JSON' },
  { id: 'yaml', label: 'YAML' },
  { id: 'xml', label: 'XML' },
  { id: 'html', label: 'HTML' },
  { id: 'css', label: 'CSS' },
  { id: 'javascript', label: 'JavaScript' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'python', label: 'Python' },
  { id: 'java', label: 'Java' },
  { id: 'c', label: 'C' },
  { id: 'c++', label: 'C++' },
  { id: 'c#', label: 'C#' },
  { id: 'go', label: 'Go' },
  { id: 'rust', label: 'Rust' },
  { id: 'php', label: 'PHP' },
  { id: 'sql', label: 'SQL' },
  { id: 'powershell', label: 'PowerShell' },
  { id: 'ini', label: 'INI' },
  { id: 'toml', label: 'TOML' },
  { id: 'markdown', label: 'Markdown' },
  { id: 'asciidoc', label: 'AsciiDoc' },
  { id: 'diff', label: 'Diff' },
];

/** The shipped language with this ID (case does not matter, as for the picker), or undefined. */
export function builtInLanguage(id: string): CodeLanguage | undefined {
  const lower = id.toLowerCase();
  return DEFAULT_CODE_LANGUAGES.find((l) => l.id === lower);
}

/** A source language as the content model takes it: one word, e.g. "yaml" or "c++". */
const LANGUAGE = /^[A-Za-z0-9][A-Za-z0-9+#._-]*$/;
/** Long enough for any language name; the picker refuses more. */
export const MAX_LANGUAGE = 32;

/** A language as typed: trimmed; empty for none; null when the model would refuse it. */
export function parseLanguage(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.length <= MAX_LANGUAGE && LANGUAGE.test(trimmed)
    ? trimmed
    : null;
}

/** The picker's list: the shipped languages, then the configured ones (which may rename one). */
export function codeLanguages(
  config: Pick<ProjectConfig, 'codeLanguages'> | null | undefined,
): CodeLanguage[] {
  const configured = Array.isArray(config?.codeLanguages)
    ? config.codeLanguages
    : [];
  const byId = new Map(configured.map((l) => [l.id.toLowerCase(), l]));
  const shipped = DEFAULT_CODE_LANGUAGES.map((l) => byId.get(l.id) ?? l);
  const shippedIds = new Set(DEFAULT_CODE_LANGUAGES.map((l) => l.id));
  return [
    ...shipped,
    ...configured.filter((l) => !shippedIds.has(l.id.toLowerCase())),
  ];
}

/** The name the picker shows for a stored language: its listed name, else the word itself. */
export function languageName(
  id: string,
  languages: readonly CodeLanguage[],
): string {
  return (
    languages.find((l) => l.id.toLowerCase() === id.toLowerCase())?.label ?? id
  );
}
