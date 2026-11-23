import { readFileSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { validateXML } from 'xmllint-wasm';
import { GRAMMARS_FILE, grammarsProblem } from './fetch-grammars.js';

/** A grammar file's flat name: xmllint's in-memory file system has no folders. */
const flat = (path: string) => path.replaceAll('/', '__');

function resolve(from: string, relative: string): string {
  const parts = from.split('/').slice(0, -1);
  for (const segment of relative.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment !== '.' && segment !== '') parts.push(segment);
  }
  return parts.join('/');
}

/** The OASIS shell grammar of each document type, by root element. */
const SHELLS: Readonly<Record<string, string>> = {
  topic: 'schema-url/technicalContent/xsd/topic.xsd',
  concept: 'schema-url/technicalContent/xsd/concept.xsd',
  task: 'schema-url/technicalContent/xsd/task.xsd',
  reference: 'schema-url/technicalContent/xsd/reference.xsd',
  troubleshooting: 'schema-url/technicalContent/xsd/troubleshooting.xsd',
  glossentry: 'schema-url/technicalContent/xsd/glossentry.xsd',
  map: 'schema-url/technicalContent/xsd/map.xsd',
  bookmap: 'schema-url/bookmap/xsd/bookmap.xsd',
  val: 'schema-url/ditaval/xsd/ditaval.xsd',
};

/**
 * The OASIS XML Schemas (the grammars ZIP's `schema-url/`; the DTDs say the
 * same, but this xmllint is built without DTD validation, and libxml2's
 * RELAX NG cannot compile DITA's constraint overrides), each under a flat
 * name with every relative `schemaLocation` pointing at the flat name of
 * the file it names, and the W3C `xml:` schema at its local copy, so
 * nothing is fetched.
 */
function grammars(): Map<string, string> {
  const zip = unzipSync(new Uint8Array(readFileSync(GRAMMARS_FILE)));
  const files = new Map<string, string>();
  for (const path of Object.keys(zip)) {
    if (!path.startsWith('schema-url/') || !path.endsWith('.xsd')) continue;
    const text = new TextDecoder().decode(zip[path]);
    files.set(
      flat(path),
      text.replace(/schemaLocation="([^"]+)"/g, (_, location: string) =>
        location === 'http://www.w3.org/2001/xml.xsd'
          ? `schemaLocation="${flat('schema-url/base/xsd/xml.xsd')}"`
          : /^[a-z]+:/i.test(location)
            ? `schemaLocation="${location}"`
            : `schemaLocation="${flat(resolve(path, location))}"`,
      ),
    );
  }
  return files;
}

/** The root element of a DITA file's text. */
export function rootOf(contents: string): string | undefined {
  return /<([A-Za-z][\w-]*)[\s>/]/.exec(
    contents.replace(/<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->/g, ''),
  )?.[1];
}

/**
 * Validates DITA files (topics, maps, DITAVAL files; by path) against the
 * OASIS DITA 1.3 XML Schemas, with xmllint and `--nonet`: the errors, and
 * the files checked. Throws when the grammars are not there
 * (`grammarsProblem`), or a file's root is no document type of `SHELLS`.
 */
export async function validateDita(
  documents: ReadonlyMap<string, string>,
): Promise<{ errors: string[]; checked: string[] }> {
  const problem = grammarsProblem();
  if (problem) throw new Error(problem);
  const xsd = grammars();
  const byShell = new Map<string, { fileName: string; contents: string }[]>();
  for (const [path, contents] of documents) {
    const root = rootOf(contents);
    const shell = root && SHELLS[root];
    if (!shell)
      throw new Error(`${path}: <${root}> is no document type checked here`);
    const list = byShell.get(shell) ?? [];
    // The DOCTYPE names a DTD this check does not use; xmllint would try to open it.
    list.push({
      fileName: flat(path),
      contents: contents.replace(/<!DOCTYPE[^>]*>/, ''),
    });
    byShell.set(shell, list);
  }
  const checked: string[] = [];
  const errors: string[] = [];
  for (const [shell, list] of byShell) {
    const result = await validateXML({
      xml: list,
      schema: {
        fileName: flat(shell),
        contents: xsd.get(flat(shell)) as string,
      },
      preload: [...xsd]
        .filter(([name]) => name !== flat(shell))
        .map(([fileName, contents]) => ({ fileName, contents })),
      modifyArguments: (args) => ['--nonet', ...args],
      maxMemoryPages: 16 * 1024,
    });
    errors.push(...result.errors.map((e) => e.rawMessage));
    checked.push(...list.map((d) => d.fileName));
  }
  return { errors, checked };
}
