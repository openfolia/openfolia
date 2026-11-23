import type { Lang } from './i18n';

/** A site path in a language: English unprefixed, German under `/de`. */
export function href(lang: Lang, path: string): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  if (lang === 'en') return clean;
  return clean === '/' ? '/de' : `/de${clean}`;
}
