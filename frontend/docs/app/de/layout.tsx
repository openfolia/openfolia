import '@openfolia/theme/theme.css';
import '../global.css';
import { LanguageLayout } from '@/components/language-layout';
import type { ReactNode } from 'react';

export { siteMetadata as metadata } from '@/components/language-layout';

export default function Layout({ children }: { children: ReactNode }) {
  return <LanguageLayout lang="de">{children}</LanguageLayout>;
}
