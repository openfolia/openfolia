// Writes import-format.schema.json from the built package's Zod schema
// (`nx run content-model:import-schema`, which builds first). A test fails
// when the committed file and the schema drift.
import { writeFileSync } from 'node:fs';
import { importFormatJsonSchema } from '../dist/index.js';

const target = new URL('../import-format.schema.json', import.meta.url);
writeFileSync(target, JSON.stringify(importFormatJsonSchema(), null, 2) + '\n');
console.log(`wrote ${target.pathname}`);
