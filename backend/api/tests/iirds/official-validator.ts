/// <reference lib="dom" />
import { JSDOM } from 'jsdom';
import JSZip from 'jszip';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { VALIDATOR_DIR, validatorProblem } from './fetch-validator.js';

/**
 * The official iiRDS Validation Tool's rules (MIT; fetched when the tests
 * start, pinned and checked, never kept in the repository:
 * `fetch-validator.ts`), run the way the tool runs them: the container
 * rules on the ZIP, then the schema rules on `META-INF/metadata.rdf`,
 * those for the package's `iiRDSVersion` and variant
 * (`formatRestriction`, unrestricted when absent).
 *
 * The rules are browser code: they read the XML with the DOM's
 * `DOMParser` and CSS selectors, which jsdom gives them here (set once on
 * the global object before the rules load, as a browser would have it).
 */
export interface Violation {
  readonly id: string;
  readonly prio: string;
  readonly rule: string;
  /** The offending elements (schema rules) or files (container rules), as text. */
  readonly invalid: readonly string[];
}

export interface ValidationResult {
  readonly iirdsVersion: string | undefined;
  readonly iirdsVariant: string;
  /** How many container and schema rules applied. */
  readonly checked: number;
  readonly violations: readonly Violation[];
}

interface ContainerRule {
  id: string;
  prio: string;
  break: boolean;
  iirdsVariant?: string[];
  assert?: (zip: JSZip, file: { name: string }, buffer: ArrayBuffer) => unknown;
  getInvalid?: (zip: JSZip) => unknown;
  rule: { en: string };
}

interface SchemaRule {
  id: string;
  path: string;
  prio: string;
  version: string[];
  iirdsVariant?: string[];
  assert?: (els: Element[], doc: Document) => unknown;
  getInvalid?: (els: Element[], doc: Document) => unknown;
  rule: { en: string };
}

let loaded: Promise<{ container: ContainerRule[]; schema: SchemaRule[] }>;

function rules() {
  loaded ??= (async () => {
    const { window } = new JSDOM('');
    const g = globalThis as Record<string, unknown>;
    g['DOMParser'] ??= window.DOMParser;
    g['XMLSerializer'] ??= window.XMLSerializer;
    // Rule M6 reads the global `document`, in the browser the tool's own
    // page (so it holds none of the package's elements): the same here.
    // What it means to check (each `is-version-of` names a declared
    // information object) is checked by our own tests (`iirds.spec.ts`).
    g['document'] ??= window.document;
    const problem = validatorProblem();
    if (problem) throw new Error(problem);
    const load = async (path: string): Promise<unknown> =>
      (
        (await import(pathToFileURL(join(VALIDATOR_DIR, path)).href)) as {
          default: unknown;
        }
      ).default;
    const [container, schema] = await Promise.all([
      load('src/config/validation/container-rules.js'),
      load('src/config/validation/schema-rules.js'),
    ]);
    return {
      container: container as ContainerRule[],
      schema: schema as SchemaRule[],
    };
  })();
  return loaded;
}

const describeInvalid = (found: unknown): string[] => {
  if (!Array.isArray(found)) return [];
  return found.map((item: unknown) =>
    typeof item === 'string'
      ? item
      : ((item as Element).outerHTML ?? String(item)).slice(0, 500),
  );
};

/**
 * Validates an iiRDS package (the ZIP's bytes) as the official tool does.
 * `fileName` is the name it would be saved as (rule C3 wants `.iirds`).
 */
export async function validateIirdsPackage(
  bytes: Uint8Array,
  fileName: string,
): Promise<ValidationResult> {
  const { container, schema } = await rules();
  const violations: Violation[] = [];
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const zip = await JSZip.loadAsync(buffer);
  const metadata = zip.files['META-INF/metadata.rdf'];
  const text = metadata
    ? new TextDecoder('utf-8').decode(await metadata.async('uint8array'))
    : '';
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const iirdsVersion =
    doc.querySelector('iiRDSVersion')?.textContent ?? undefined;
  const iirdsVariant =
    doc.querySelector('formatRestriction')?.textContent || 'unrestricted';
  let checked = 0;
  for (const test of container) {
    if (!test.assert) continue;
    if (test.iirdsVariant && !test.iirdsVariant.includes(iirdsVariant))
      continue;
    checked++;
    if (!(await test.assert(zip, { name: fileName }, buffer))) {
      violations.push({
        id: test.id,
        prio: test.prio,
        rule: test.rule.en,
        invalid: describeInvalid(test.getInvalid?.(zip)),
      });
      if (test.break)
        return { iirdsVersion, iirdsVariant, checked, violations };
    }
  }
  for (const test of schema) {
    if (!test.assert) continue;
    if (!test.version.includes(`V${iirdsVersion}`)) continue;
    if (test.iirdsVariant && !test.iirdsVariant.includes(iirdsVariant))
      continue;
    checked++;
    const selection = Array.from(doc.querySelectorAll(test.path));
    if (!test.assert(selection, doc)) {
      violations.push({
        id: test.id,
        prio: test.prio,
        rule: test.rule.en,
        invalid: describeInvalid(test.getInvalid?.(selection, doc)),
      });
    }
  }
  return { iirdsVersion, iirdsVariant, checked, violations };
}
