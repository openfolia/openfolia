// The checks of a content repository at a ref, for CI (#55): every check the checks screen shows
// before review and release (validation, references, files, translations, PDFs, terminology and
// style rules), for every module in every language and every manual, printed one per line (or as
// JSON). Exits 1 when any check is blocking, 0 when there are only warnings, 2 when it could not
// check (a bad argument, a ref that is not there).
//
//   pnpm nx run api:check-content -- --content <repository> [--ref <ref>] [--manual <id>] [--format text|json]
//
// `--content` is the content repository (a bare repository or a checkout; default
// `CCMS_CONTENT_DIR`), `--ref` a branch, tag or commit (default `HEAD`), `--manual` one manual's
// checks only. It boots the built API in-process (`in-process-api.mjs`, an in-memory database) and
// reads as the shared API token's reader, who sees every ref. Images and attached files are looked
// up in the blob store the `CCMS_BLOB_*` settings name, if set (else only in the repository's own
// `assets/`), so set them as the server's to check those too.
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { importBuilt, withInProcessApi } from './in-process-api.mjs';

const usage =
  'Usage: check-content [--content <repository>] [--ref <ref>] [--manual <id>] [--format text|json]';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}

let flags;
try {
  ({ values: flags } = parseArgs({
    options: {
      content: { type: 'string' },
      ref: { type: 'string', default: 'HEAD' },
      manual: { type: 'string' },
      format: { type: 'string', default: 'text' },
      help: { type: 'boolean', default: false },
    },
    strict: true,
  }));
} catch (error) {
  fail(`${error.message}\n${usage}`);
}
if (flags.help) {
  process.stdout.write(`${usage}\n`);
  process.exit(0);
}
if (!['text', 'json'].includes(flags.format))
  fail(`--format: text or json.\n${usage}`);
// Relative to where the command was typed (pnpm runs this in backend/api).
const from = process.env.INIT_CWD ?? process.cwd();
const content = flags.content ?? process.env.CCMS_CONTENT_DIR;
if (!content)
  fail(`--content (or CCMS_CONTENT_DIR): the content repository.\n${usage}`);

// The blob store's settings, read before the in-process API clears every `CCMS_` setting.
const blobs = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key.startsWith('CCMS_BLOB_')),
);

// Anything that keeps it from checking (not a repository, a configuration that does not load,
// the API not starting) is exit 2 as well, never 1, which says the content has blocking checks.
process.on('uncaughtException', (error) =>
  fail(`Could not check: ${error?.message ?? error}`),
);
process.on('unhandledRejection', (error) =>
  fail(`Could not check: ${error?.message ?? error}`),
);

let report;
try {
  report = await withInProcessApi(
    async (app) => {
      const { OpenSnapshotAction } = await importBuilt(
        'content/core/actions/open-snapshot.action.js',
      );
      const { CheckContentAction } = await importBuilt(
        'checks/core/actions/check-content.action.js',
      );
      const { API_TOKEN_ACTOR } = await importBuilt(
        'access/core/service-actor.js',
      );
      const { reportChecks } = await importBuilt('checks/core/check-report.js');
      const { NotFoundError } = await importBuilt('base/core/errors.js');
      const actor = API_TOKEN_ACTOR;
      try {
        const snapshot = await app
          .get(OpenSnapshotAction)
          .handle({ actor, ref: flags.ref });
        const result = await app.get(CheckContentAction).handle({
          actor,
          snapshot,
          ...(flags.manual !== undefined && { manualId: flags.manual }),
        });
        return reportChecks(result, flags.format);
      } catch (error) {
        // A ref or manual that is not there: said, after the API is shut down.
        if (error instanceof NotFoundError) return { error: error.message };
        throw error;
      }
    },
    { contentDir: resolve(from, content), env: blobs },
  );
} catch (error) {
  fail(`Could not check: ${error?.message ?? error}`);
}
if ('error' in report) fail(report.error);
process.stdout.write(report.output);
process.exitCode = report.exitCode;
