import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import { Provider } from './provider';
import { baseOptions } from '@/lib/layout.shared';
import { uiI18n } from '@/lib/ui-i18n';
import { pageTree } from '@/lib/tree';
import type { Lang } from '@/lib/i18n';
import favicon from '@openfolia/theme/brand/favicon.svg';

/** The root layout of a language: `<html lang>`, the theme, the sidebar of that language. */
export function LanguageLayout({
  lang,
  children,
}: {
  lang: Lang;
  children: ReactNode;
}) {
  return (
    <html lang={lang} suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <Provider i18n={uiI18n.provider(lang)}>
          <DocsLayout tree={pageTree(lang)} {...baseOptions(lang)}>
            {children}
          </DocsLayout>
        </Provider>
      </body>
    </html>
  );
}

export const siteMetadata: Metadata = {
  title: { template: '%s | OpenFolia docs', default: 'OpenFolia docs' },
  icons: { icon: typeof favicon === 'string' ? favicon : favicon.src },
};
