import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateXML } from 'xmllint-wasm';

const schemaFile = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`./schemas/${name}`, import.meta.url)),
    'utf8',
  );

/** Where the core schema imports the W3C schema of the `xml:` attributes from. */
const XML_XSD = 'informativeCopiesOf3rdPartySchemas/w3c/xml.xsd';

/**
 * `xml` checked against the XLIFF 2.0 core schema (OASIS, in `schemas/`,
 * with the W3C schema of the `xml:` attributes it imports): the errors
 * xmllint reports, none when it is valid. xmllint's in-memory file system
 * has no folders, so the import is pointed at a flat name.
 */
export async function xliffSchemaErrors(xml: string): Promise<string[]> {
  const result = await validateXML({
    xml: [{ fileName: 'document.xlf', contents: xml }],
    schema: [
      {
        fileName: 'xliff_core_2.0.xsd',
        contents: schemaFile('xliff_core_2.0.xsd').replace(XML_XSD, 'xml.xsd'),
      },
    ],
    preload: [{ fileName: 'xml.xsd', contents: schemaFile(XML_XSD) }],
  });
  return result.valid ? [] : result.errors.map((e) => e.rawMessage);
}
