import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../stack/stack.ts';

type Tree = { readonly [key: string]: string | Tree };

const cache = new Map<string, Tree>();

/**
 * The editor's own text for `key` (`editor.…`, or `ui.…` for the component library's) in `lang`,
 * its `{name}` arguments filled in: the shots find buttons by the labels a person reads, in either
 * language, from the same files the guide quotes. Plural messages are not supported (none is
 * needed).
 */
export function label(
  lang: string,
  key: string,
  params: Readonly<Record<string, string>> = {},
): string {
  const scope = key.startsWith('ui.') ? 'ui' : 'editor';
  let tree = cache.get(`${scope}/${lang}`);
  if (!tree) {
    tree = JSON.parse(
      readFileSync(join(ROOT, `frontend/${scope}/src/i18n/${lang}.json`), 'utf8'),
    ) as Tree;
    cache.set(`${scope}/${lang}`, tree);
  }
  const value = key
    .replace(/^(editor|ui)\./, '')
    .split('.')
    .reduce<string | Tree | undefined>(
      (node, part) => (typeof node === 'object' ? node[part] : undefined),
      tree,
    );
  if (typeof value !== 'string')
    throw new Error(`No ${lang} text for ${key}`);
  return value.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? (params[name] ?? '') : whole,
  );
}
