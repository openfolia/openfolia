import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  IMPORT_DOCUMENT_PATH,
  parseConfig,
  validateImport,
} from '@openfolia/content-model';
import { parse as parseYaml } from 'yaml';
import { bundleFiles, zipFiles } from './bundle.js';
import { convertWikiPages } from './convert.js';
import { readExportFolder } from './export-folder.js';
import { WikiMapping } from './mapping.js';

/**
 * The largest `import.json` the import reads by default, in bytes: the
 * API's `CCMS_IMPORT_MAX_DOCUMENT_BYTES` (8 MiB). A larger one is refused
 * (`document-too-large`), so the command warns before it writes it.
 */
export const DEFAULT_MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;

export const USAGE = `Usage: openfolia-wiki-markup <export folder> --mapping <mapping.yaml> --out <bundle.zip>
       [--config <openfolia.yaml>] [--exported-at <text>] [--max-document-bytes <n>]

Converts the pages of an export folder (<name>.wiki files, their attachments in <name>/)
into an import bundle. Every construct it could not convert is listed, page and block,
and is in the bundle's report. With --config (the target's openfolia.yaml), the bundle is
validated against it too; an invalid bundle exits with 1. It warns when the bundle's
${IMPORT_DOCUMENT_PATH} is larger than the import reads: --max-document-bytes, the target's
CCMS_IMPORT_MAX_DOCUMENT_BYTES (default ${DEFAULT_MAX_DOCUMENT_BYTES}, 8 MiB). Reads and writes
local files only.`;

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** The converter's command line; resolves to its exit code. */
export async function runCli(
  argv: readonly string[],
  io: CliIo,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        mapping: { type: 'string' },
        out: { type: 'string' },
        config: { type: 'string' },
        'exported-at': { type: 'string' },
        'max-document-bytes': { type: 'string' },
        help: { type: 'boolean' },
      },
    });
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  const [dir] = positionals;
  if (!dir || !values.mapping || !values.out || positionals.length > 1) {
    io.err(USAGE);
    return 2;
  }
  const limit = values['max-document-bytes'];
  const maxDocumentBytes =
    limit === undefined
      ? DEFAULT_MAX_DOCUMENT_BYTES
      : /^\d+$/.test(limit)
        ? Number(limit)
        : Number.NaN;
  if (!Number.isSafeInteger(maxDocumentBytes) || maxDocumentBytes <= 0) {
    io.err(
      `--max-document-bytes takes a whole number of bytes, more than 0.\n\n${USAGE}`,
    );
    return 2;
  }
  const mapping = WikiMapping.safeParse(
    parseYaml(await readFile(values.mapping, 'utf8')) ?? {},
  );
  if (!mapping.success) {
    io.err(
      `The mapping ${values.mapping} is not valid:\n${mapping.error.issues.map((i) => `  ${i.path.join('.') || '(top)'}: ${i.message}`).join('\n')}`,
    );
    return 2;
  }
  const folder = await readExportFolder(dir);
  for (const line of folder.skipped) io.err(`skipped ${line}`);
  const conversion = convertWikiPages(folder.pages, mapping.data, {
    ...(values['exported-at'] && { exportedAt: values['exported-at'] }),
  });
  const report = conversion.document.report ?? [];
  for (const entry of report) {
    const where = [entry.module, entry.block].filter(Boolean).join('/');
    io.out(`${entry.sourceId}${where ? ` (${where})` : ''}: ${entry.message}`);
  }
  io.out(
    `${conversion.document.modules.length} pages as modules, ${conversion.assets.size} files, ${[...conversion.counts.values()].reduce((a, b) => a + b, 0)} findings in the report.`,
  );
  const files = bundleFiles(conversion);
  const documentBytes = files.get(IMPORT_DOCUMENT_PATH)?.byteLength ?? 0;
  if (documentBytes > maxDocumentBytes) {
    io.err(
      `warning: the bundle's ${IMPORT_DOCUMENT_PATH} holds ${documentBytes.toLocaleString('en')} bytes, more than the ${maxDocumentBytes.toLocaleString('en')} the import reads (--max-document-bytes); the import will refuse it (document-too-large). Convert the export in parts, a folder of fewer pages each.`,
    );
  }
  let exitCode = 0;
  if (values.config) {
    const config = parseConfig(await readFile(values.config, 'utf8'));
    const validation = await validateImport({ files }, config);
    const issues = [
      ...validation.issues,
      ...validation.items.flatMap((item) => item.issues),
    ].filter((issue) => issue.severity !== 'info');
    for (const issue of issues) {
      io.err(
        `${issue.severity} ${issue.code}${issue.pointer ? ` at ${issue.pointer}` : ''}: ${issue.message}`,
      );
    }
    if (!validation.valid) {
      io.err('The bundle is not valid for this configuration.');
      exitCode = 1;
    }
  }
  await writeFile(values.out, zipFiles(files));
  io.out(`Wrote ${values.out}.`);
  return exitCode;
}
