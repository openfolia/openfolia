/**
 * The small part of the library an app needs before its first screen: its providers, the
 * theme, the route fade, toasts and the translation helpers. An app's bootstrap code (its
 * config, its root component and the services those start) imports from `@openfolia/ui/startup`, never
 * from `@openfolia/ui`: the full entry re-exports every component, and the bundler counts every module
 * a barrel re-exports as reached by whoever imports it, so the whole library would land in the
 * initial bundle (frontend/ui/README.md, "Entry points").
 *
 * Each export names its file, not a folder's `index.ts`, for the same reason.
 */
export { provideZard } from './lib/core/provide-zard';
export { provideI18n } from './lib/i18n/provide-i18n';
export {
  injectTranslate,
  translated,
  type Translatable,
  type TranslatedText,
} from './lib/i18n/text.pipe';
export { RouteFadeDirective } from './lib/smooth/route-fade.directive';
export { ThemeService } from './lib/theme/theme.service';
export { ToastService, type ToastCloseReason } from './lib/toast/toast.service';
