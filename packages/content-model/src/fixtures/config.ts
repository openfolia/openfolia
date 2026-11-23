import type { z } from 'zod';
import type { ProjectConfig } from '../lib/config.js';

/** A fictional organisation's configuration, used in tests and docs. */
export const sampleConfig: z.input<typeof ProjectConfig> = {
  languages: { source: 'en', targets: ['de', 'fr', 'pt-BR'] },
  moduleTypes: [
    { id: 'concept', label: 'Concept' },
    { id: 'procedure', label: 'Procedure' },
    { id: 'reference', label: 'Reference' },
    { id: 'safety', label: 'Safety', restricted: true, safety: true },
  ],
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'customer', label: 'Customer' },
    { id: 'service', label: 'Service' },
    { id: 'internal', label: 'Internal' },
  ],
  facets: [
    {
      id: 'product-line',
      label: 'Product line',
      values: [
        { id: 'tuggers', label: 'Tuggers' },
        { id: 'lifters', label: 'Lifters' },
      ],
    },
  ],
  variantAttributes: [
    {
      id: 'model',
      label: 'Model',
      kind: 'enum',
      values: [
        { id: 'l-200', label: 'L-200' },
        { id: 'l-400', label: 'L-400' },
      ],
    },
    { id: 'software', label: 'Software version', kind: 'version' },
    {
      id: 'market',
      label: 'Market',
      kind: 'enum',
      values: [
        { id: 'eu', label: 'EU' },
        { id: 'us', label: 'US' },
      ],
    },
  ],
  textAttributes: [
    { id: 'product-name', label: 'Product name' },
    { id: 'rated-load', label: 'Rated load' },
  ],
  safetySymbols: [
    { id: 'w012', label: 'Electricity' },
    { id: 'w026', label: 'Battery charging' },
    { id: 'm002', label: 'Refer to instruction manual' },
  ],
};
