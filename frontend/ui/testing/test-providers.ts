// The providers every unit test of this library gets (project.json, `providersFile`): the
// translations in English, loaded synchronously, so a component renders its texts at once.
import { provideI18nTesting } from '../src/lib/i18n/provide-i18n';
import ui from '../src/i18n/en.json';

export default [provideI18nTesting({ en: { ui } })];
