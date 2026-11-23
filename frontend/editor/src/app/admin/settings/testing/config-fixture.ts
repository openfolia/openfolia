import type { ProjectConfig } from '../config-model';

/** A small configuration for the settings' tests. */
export const CONFIG: ProjectConfig = {
  languages: { source: 'en', targets: ['de'] },
  moduleTypes: [
    { id: 'concept', label: 'Concept', restricted: false, snippet: false },
  ],
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'service', label: 'Service' },
  ],
  facets: [],
  variantAttributes: [],
  textAttributes: [],
  safetySymbols: [],
  outputLabels: {},
  maxHeadingLevel: 3,
  codeLanguages: [],
  pdf: { standard: 'ua-1' },
  delivery: {
    access: 'signed-in',
    missingLanguage: 'picker',
    pdfQrCode: 'none',
    manuals: {},
  },
};
