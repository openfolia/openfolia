import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  checkLanguages,
  checkUsage,
  readableText,
  readScope,
  sourceFiles,
} from '../../ui/tools/translations.mjs';

const at = (path) => fileURLToPath(new URL(path, import.meta.url));
const languages = readScope(at('../src/i18n/'));
const files = sourceFiles([at('../src/app/')]);

const FEED =
  'the change feed (`GET /changes`): read by API clients, never by the editor';
const CHUNKS =
  'the retrieval chunks (`GET /chunks`): read by API clients and the agent server, never by an editor screen (the checks show their own `chunk-set-too-large` check, #710)';
const SERVICE_TOKEN =
  'a service account’s token: the editor acts through a session, never a token';
const CLIENT =
  'the editor’s API client sends what the API asks for (its media types, `X-Ccms-Request`), from its own origin';
const DITA = 'a DITA package route: no editor screen reads one';
const IIRDS = 'an iiRDS package route: no editor screen reads one';
const IIRDS_REPORT =
  'a warning in an iiRDS package’s report, not an error response; no editor screen reads one';
const IMPORTS =
  'the content import (`/imports`, `/importers`): no editor screen starts or reads one';
const SCIM =
  'a SCIM route (`/scim/v2`): a directory’s service account calls it, no editor screen does';
/**
 * The error codes of the API's catalogue that need no text in the editor, each with why: no
 * screen of the editor can meet them. A new code needs a text or a line here.
 */
const EXEMPT = {
  'content-type-required': CLIENT,
  'request-header-required': CLIENT,
  'unsupported-media-type': CLIENT,
  'cross-origin-request': CLIENT,
  'not-acceptable': CLIENT,
  'method-not-allowed': CLIENT,
  'cursor-expired': FEED,
  'cursor-gone': FEED,
  'chunk-set-too-large': CHUNKS,
  'outbox-blocked': FEED,
  'token-expired': SERVICE_TOKEN,
  'token-revoked': SERVICE_TOKEN,
  'user-header-not-accepted':
    'the editor sends `X-Ccms-User` only in demo mode, with the shared token, never with a session or a service account’s token',
  'dita-notices-unsupported': DITA,
  'dita-package-too-large': DITA,
  'iirds-not-configured': IIRDS,
  'iirds-package-too-large': IIRDS,
  'manual-empty': IIRDS_REPORT,
  'missing-asset': IIRDS_REPORT,
  'pdf-not-included': IIRDS_REPORT,
  'unmapped-audience': IIRDS_REPORT,
  'unmapped-facet': IIRDS_REPORT,
  'unmapped-lifecycle-phase': IIRDS_REPORT,
  'unmapped-module-type': IIRDS_REPORT,
  'unmapped-variant-attribute': IIRDS_REPORT,
  'import-expired': IMPORTS,
  'import-failed': IMPORTS,
  'import-not-applicable': IMPORTS,
  'import-outdated': IMPORTS,
  'import-too-large': IMPORTS,
  'importer-gone': IMPORTS,
  'invalid-options': IMPORTS,
  'unknown-importer': IMPORTS,
  'upload-missing': IMPORTS,
  'scim-address-locked': SCIM,
  'scim-group-name-taken': SCIM,
  'scim-invalid-filter': SCIM,
  'scim-invalid-path': SCIM,
  'scim-invalid-syntax': SCIM,
  'scim-invalid-value': SCIM,
  'scim-mutability': SCIM,
  'scim-no-target': SCIM,
  'scim-user-name-taken': SCIM,
};

/**
 * Words the German texts no longer use, each with the word they use instead (the glossary,
 * `frontend/ui/README.md`, "German glossary"), and the "du" form's pronouns: the texts address
 * the reader as "Sie" (#695). Matched as whole words or word starts, case as written.
 */
const REJECTED = [
  [/(?<!\p{L})Release/u, 'Veröffentlichung'],
  [/(?<!\p{L})Abnahme/u, 'Abzeichnung'],
  [/(?<!\p{L})[Aa]bnehmen/u, 'abzeichnen'],
  [/(?<!\p{L})abgenommen(?!\p{L})/u, 'abgezeichnet'],
  [/(?<!\p{L})Sicherungspunkt/u, 'Speicherpunkt'],
  [/(?<!\p{L})ungesichert/u, 'ungespeichert'],
  [/(?<!\p{L})Variantenattribut/u, 'Variantenmerkmal'],
  [/(?<!\p{L})(Bildmarkierung|Callout)/u, 'Positionsnummer'],
  [
    /(?<!\p{L})([Dd]u|[Dd]ein(e[mnrs]?)?|[Dd]ich|[Dd]ir)(?!\p{L})/u,
    'Sie, Ihr, Ihnen',
  ],
];

/**
 * German texts that may keep a rejected word, as `'<key>: <word>'`, each with why. A new
 * exception needs a reason here; one whose text no longer has the word fails the test.
 */
const REJECTED_ALLOWED = {};

describe('the editor translations', () => {
  it('ship English and German', () => {
    assert.ok(languages.has('en'));
    assert.ok(languages.has('de'));
  });

  it('have the same keys and arguments in every language, as valid ICU', () => {
    assert.deepEqual(checkLanguages(languages), []);
  });

  it('are all used, and every key the code uses exists', () => {
    const { unused, unknown } = checkUsage('editor', languages, files);
    assert.deepEqual(unused, [], 'keys no code uses');
    assert.deepEqual(unknown, [], 'keys the code uses that en.json lacks');
  });

  it('use one German word per term and the "Sie" form (#695)', () => {
    // Only what a person reads: an ICU argument's name (`{dir}`) is none of it.
    const found = [...languages.get('de')].flatMap(([key, message]) => {
      const text = readableText(message);
      return REJECTED.filter(([word]) => word.test(text)).map(
        ([word, instead]) => ({
          at: `${key}: ${text.match(word)[0]}`,
          line: `${key}: “${text.match(word)[0]}”, use “${instead}”`,
        }),
      );
    });
    const unexcused = found
      .filter(({ at }) => !Object.hasOwn(REJECTED_ALLOWED, at))
      .map(({ line }) => line);
    assert.deepEqual(unexcused, [], 'German texts with a rejected word');
    const stale = Object.keys(REJECTED_ALLOWED).filter(
      (at) => !found.some((hit) => hit.at === at),
    );
    assert.deepEqual(stale, [], 'exceptions whose text has no rejected word');
  });

  it('give error texts only for codes the API sends', () => {
    // The API names each code once as a string literal (`new ConflictError('locked', …)`).
    const api = sourceFiles([at('../../../backend/api/src/')])
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const codes = [...languages.get('en').keys()]
      .filter((key) => key.startsWith('apiErrors.codes.'))
      .map((key) => key.slice('apiErrors.codes.'.length));
    assert.ok(codes.length > 0);
    const unknown = codes.filter(
      (code) => !api.includes(`'${code}'`) && !api.includes(`"${code}"`),
    );
    assert.deepEqual(unknown, [], 'codes the API never sends');
  });

  it('give a text for every error code a person can meet in the editor (#694)', () => {
    // The API's catalogue (`error-codes.yaml`, which its own test keeps to the codes the source
    // raises) against the texts: `apiErrors.codes` in every language (the checks above), or a
    // screen's own table (`'<code>': 'editor.…'`, the backups' or the webhooks' for instance).
    const catalogue = [
      ...readFileSync(
        at('../../../backend/api/error-codes.yaml'),
        'utf8',
      ).matchAll(/^([a-z0-9][a-z0-9-]*):/gm),
    ].map((m) => m[1]);
    assert.ok(catalogue.length > 0);
    const texts = new Set(
      [...languages.get('en').keys()]
        .filter((key) => key.startsWith('apiErrors.codes.'))
        .map((key) => key.slice('apiErrors.codes.'.length)),
    );
    const app = files
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
      .map((file) => readFileSync(file, 'utf8'))
      .join('\n');
    const ownTable = (code) => new RegExp(`'${code}':\\s*'editor\\.`).test(app);
    const untold = catalogue.filter(
      (code) =>
        !texts.has(code) && !ownTable(code) && !Object.hasOwn(EXEMPT, code),
    );
    assert.deepEqual(untold, [], 'error codes without a text');
    const stale = Object.keys(EXEMPT).filter(
      (code) => !catalogue.includes(code) || texts.has(code),
    );
    assert.deepEqual(
      stale,
      [],
      'exempt codes the API no longer sends, or with a text',
    );
  });

  it('name every action the API writes to the audit log (#692)', async () => {
    // The API's catalogue (`AuditLog.record` takes only its actions) against the audit log's
    // `ACTION_TEXTS`, whose keys the checks above find in every language. The catalogue reads
    // what each component registers (`backend/api/src/audit-actions.ts`), and the API's sources
    // import each other as `.js`: Node strips the types, and this resolves those to the `.ts`.
    const hooks = registerHooks({
      resolve: (specifier, context, next) =>
        specifier.startsWith('.') &&
        specifier.endsWith('.js') &&
        context.parentURL?.includes('/backend/api/src/')
          ? next(specifier.replace(/\.js$/, '.ts'), context)
          : next(specifier, context),
    });
    const { AUDIT_ACTIONS } = await import(
      at('../../../backend/api/src/audit/core/audit-actions.ts')
    );
    hooks.deregister();
    const model = readFileSync(
      at('../src/app/admin/audit/audit-model.ts'),
      'utf8',
    );
    assert.ok(AUDIT_ACTIONS.length > 0);
    const unnamed = AUDIT_ACTIONS.filter(
      (action) =>
        !new RegExp(
          `'${action.replaceAll('.', '\\.')}':\\s*'editor\\.admin\\.audit\\.actions\\.`,
        ).test(model),
    );
    assert.deepEqual(unnamed, [], 'audit actions without a text');
  });
});
