'use client';
import { useI18n } from 'fumadocs-ui/contexts/i18n';
import {
  ThemeSwitch,
  type ThemeSwitchProps,
} from 'fumadocs-ui/layouts/shared/slots/theme-switch';
import { isLang } from '@/lib/i18n';
import { t } from '@/lib/translations';

/**
 * The sidebar's theme switch with its name beside it: in the sidebar's footer the switch sits at
 * the end of a bordered row that would otherwise be empty (#618). In the phone drawer, a row of
 * icons, the name is left out.
 */
export function LabelledThemeSwitch(props: ThemeSwitchProps) {
  const { locale } = useI18n();
  return (
    <div className="flex items-center md:flex-1">
      <span className="ps-2 text-sm max-md:hidden">
        {t(locale && isLang(locale) ? locale : 'en', 'theme')}
      </span>
      <ThemeSwitch {...props} />
    </div>
  );
}
