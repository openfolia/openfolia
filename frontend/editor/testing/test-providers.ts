// The providers every unit test of the editor gets (project.json, `providersFile`): the
// translations in English, loaded synchronously, so a component renders its texts at once, and
// the user guide's index the build ships (the `guide-index` target writes it), read without a
// request.
import { provideI18nTesting } from '@openfolia/ui/i18n';

// The library's texts are files, not code: the test reads them where the build copies them from.
// eslint-disable-next-line no-restricted-imports, @nx/enforce-module-boundaries
import ui from '../../ui/src/i18n/en.json';
import editor from '../src/i18n/en.json';
import guideIndex from '../generated/guide-index.json';
import { GUIDE_INDEX_LOADER } from '../src/app/help/help.service';

export default [
  provideI18nTesting({ en: { ui, editor } }),
  { provide: GUIDE_INDEX_LOADER, useValue: () => Promise.resolve(guideIndex) },
];
