import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import lockupLight from '@openfolia/theme/brand/openfolia-lockup-horizontal-color-light.svg';
import lockupDark from '@openfolia/theme/brand/openfolia-lockup-horizontal-color-dark.svg';
import { LabelledThemeSwitch } from '@/components/theme-switch';
import type { Lang } from './i18n';
import { href } from './links';
import { docsSettings } from '../scripts/lib/settings.mjs';

const { repositoryUrl } = docsSettings(process.env);

const src = (image: string | { src: string }) =>
  typeof image === 'string' ? image : image.src;

export function baseOptions(lang: Lang): BaseLayoutProps {
  return {
    i18n: true,
    // Fumadocs shows it as the GitHub icon, in the sidebar and in the phone's navigation bar.
    githubUrl: repositoryUrl,
    slots: { themeSwitch: LabelledThemeSwitch },
    nav: {
      url: href(lang, '/'),
      title: (
        <>
          {/* The brand's lockup, the light one on light backgrounds and the dark one on dark. */}
          <img
            src={src(lockupLight)}
            alt="OpenFolia"
            height={24}
            className="h-6 w-auto dark:hidden"
          />
          <img
            src={src(lockupDark)}
            alt="OpenFolia"
            height={24}
            className="hidden h-6 w-auto dark:block"
          />
        </>
      ),
    },
  };
}
