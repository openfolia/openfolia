import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strToU8, zipSync, type Zippable } from 'fflate';

const EXAMPLE = join(
  import.meta.dirname,
  '../../../packages/content-model/src/fixtures/import-example',
);

/**
 * The import format's example bundle (`packages/content-model/src/fixtures/import-example`) as a
 * ZIP, its configuration values mapped onto the sample content's (as the API's import tests do)
 * and its module and manual IDs ending in `suffix` (unless empty): a flow that imports gets IDs of
 * its own, so no two flows (nor a retry) take the same locks. `change` edits `import.json` first.
 */
export function exampleBundle(
  suffix: string,
  change?: (doc: Record<string, unknown[]>) => void,
): Buffer {
  const text = readFileSync(join(EXAMPLE, 'import.json'), 'utf8')
    .replaceAll('"customer"', '"public"')
    .replaceAll('"product-line"', '"region"')
    .replaceAll('"lifters"', '"north"')
    .replaceAll('"reference"', '"concept"')
    .replaceAll('"m002"', '"w001"')
    .replaceAll('"l-200"', '"small"')
    // One pass, so a suffix never meets another ID's name.
    .replace(/\b(tank-filling|pressure-limits|pump-guide)\b/g, (id) =>
      suffix ? `${id}-${suffix}` : id,
    );
  const doc = JSON.parse(text) as Record<string, unknown[]>;
  change?.(doc);
  const files: Zippable = {
    'import.json': strToU8(JSON.stringify(doc)),
  };
  for (const name of readdirSync(join(EXAMPLE, 'assets'))) {
    files[`assets/${name}`] = new Uint8Array(
      readFileSync(join(EXAMPLE, 'assets', name)),
    );
  }
  return Buffer.from(zipSync(files));
}

/**
 * A DITA project (for the `dita` importer) of two topics in the source language, named after
 * `suffix`: `rest-<suffix>`, a short concept, and `huge-<suffix>`, a concept larger than a module
 * may be (more than 512 KiB as a working copy), which the import refuses (`too-large`) while
 * nothing else needs it.
 */
export function ditaProject(suffix: string): Buffer {
  const topic = (id: string, text: string) =>
    strToU8(
      `<?xml version="1.0" encoding="UTF-8"?>\n<concept id="${id}" xml:lang="en"><title>${id}</title><conbody><p>${text}</p></conbody></concept>\n`,
    );
  return Buffer.from(
    zipSync({
      [`en/rest-${suffix}.dita`]: topic('rest', 'A short topic.'),
      [`en/huge-${suffix}.dita`]: topic(
        'huge',
        'A very long sentence. '.repeat(30_000),
      ),
    }),
  );
}
