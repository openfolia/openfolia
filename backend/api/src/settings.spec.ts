import { Env, validateEnv } from './config/env.js';
import { REGISTERED_SETTINGS } from './settings.js';
import { definedGroups } from '../tests/registered-groups.js';

// Every setting the server read before the components registered their own: the same names
// (the settings reference documents them from `.env.example`). Their defaults and checks are
// held by `config/env.spec.ts`.
const TODAY = [
  'CCMS_API_TOKEN',
  'CCMS_ATTACHMENT_TYPES_ALLOW',
  'CCMS_ATTACHMENT_TYPES_DENY',
  'CCMS_ATTACHMENT_TYPES_OPEN',
  'CCMS_AUDIT_KEEP_DAYS',
  'CCMS_AUDIT_READ_KEEP_DAYS',
  'CCMS_AUDIT_SINK_CA_FILE',
  'CCMS_AUDIT_SINK_POLL_MS',
  'CCMS_AUDIT_SINK_SECRET',
  'CCMS_AUDIT_SINK_TIMEOUT_MS',
  'CCMS_AUDIT_SINK_URL',
  'CCMS_AUTH_FAILURES_MAX',
  'CCMS_AUTH_FAILURES_WINDOW_MS',
  'CCMS_AUTH_MODE',
  'CCMS_BACKUP_WARN_AFTER_HOURS',
  'CCMS_BLOB_DRIVER',
  'CCMS_BLOB_FS_ROOT',
  'CCMS_BUILD_ID',
  'CCMS_CONTENT_CACHE_MB',
  'CCMS_CONTENT_DIR',
  'CCMS_CONTENT_INDEX_CACHE_MB',
  'CCMS_DATABASE_LOCK_TIMEOUT_MS',
  'CCMS_DATABASE_MIGRATE',
  'CCMS_DATABASE_MIGRATE_ATTEMPTS',
  'CCMS_DATABASE_POOL_MAX',
  'CCMS_DATABASE_URL',
  'CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS',
  'CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS',
  'CCMS_DEFAULT_REF',
  'CCMS_DELIVERY_IGNORED_QUERY',
  'CCMS_DELIVERY_MAX_ACCESS',
  'CCMS_DELIVERY_PER_MINUTE',
  'CCMS_DELIVERY_SHARED_MAX_AGE',
  'CCMS_DITA_SENDS_PER_ACTOR',
  'CCMS_DITA_SEND_IDLE_TIMEOUT_MS',
  'CCMS_DITA_SEND_MIN_BYTES_PER_SECOND',
  'CCMS_DITA_SEND_TIMEOUT_MS',
  'CCMS_DOCS_URL',
  'CCMS_EDITOR_ORIGINS',
  'CCMS_EDITOR_URL',
  'CCMS_EMAIL_CODE_MINUTES',
  'CCMS_EMAIL_CODE_SIGN_IN',
  'CCMS_EMBEDDER_API_KEY',
  'CCMS_EMBEDDER_DIMENSIONS',
  'CCMS_EMBEDDER_MIN_SIMILARITY',
  'CCMS_EMBEDDER_MODEL',
  'CCMS_EMBEDDER_TIMEOUT_MS',
  'CCMS_EMBEDDER_URL',
  'CCMS_FIRST_ADMIN_EMAIL',
  'CCMS_FIRST_ADMIN_LINK_LOG',
  'CCMS_FIRST_ADMIN_NAME',
  'CCMS_IMPORT_COMMIT_BYTES',
  'CCMS_IMPORT_COMMIT_FILES',
  'CCMS_IMPORT_CONVERT_MAX_MEMORY_MB',
  'CCMS_IMPORT_CONVERT_TIMEOUT_MS',
  'CCMS_IMPORT_MAX_BYTES',
  'CCMS_IMPORT_MAX_DOCUMENT_BYTES',
  'CCMS_IMPORT_MAX_FILES',
  'CCMS_IMPORT_MAX_JSON_DEPTH',
  'CCMS_IMPORT_MAX_PATH_DEPTH',
  'CCMS_IMPORT_MAX_UNPACKED_BYTES',
  'CCMS_INVITE_DAYS',
  'CCMS_JOBS_POLL_MS',
  'CCMS_JOBS_POOL_MAX',
  'CCMS_MAIL_CA_FILE',
  'CCMS_MAIL_FROM',
  'CCMS_MAIL_LANGUAGE',
  'CCMS_MAIL_PASSWORD',
  'CCMS_MAIL_PASSWORD_FILE',
  'CCMS_MAIL_REQUIRE_TLS',
  'CCMS_MAIL_URL',
  'CCMS_MAIL_USER',
  'CCMS_MAINTENANCE_BRANCH',
  'CCMS_MAX_ATTACHMENT_BYTES',
  'CCMS_MAX_FONT_BYTES',
  'CCMS_MAX_UPLOAD_BYTES',
  'CCMS_NOTIFICATIONS_DIGEST_HOUR',
  'CCMS_NOTIFICATIONS_EMAILS_PER_HOUR',
  'CCMS_NOTIFICATIONS_KEEP_DAYS',
  'CCMS_NOTIFICATIONS_POLL_MS',
  'CCMS_OFFLINE_PACKAGES',
  'CCMS_OIDC_CLIENT_ID',
  'CCMS_OIDC_CLIENT_SECRET',
  'CCMS_OIDC_GROUPS_CLAIM',
  'CCMS_OIDC_ISSUER',
  'CCMS_OIDC_LINK_BY_EMAIL',
  'CCMS_OIDC_NAME',
  'CCMS_OIDC_REDIRECT_URL',
  'CCMS_OIDC_SCOPES',
  'CCMS_PACKAGE_SENDS_PER_ACTOR',
  'CCMS_PACKAGE_SEND_IDLE_TIMEOUT_MS',
  'CCMS_PACKAGE_SEND_MIN_BYTES_PER_SECOND',
  'CCMS_PACKAGE_SEND_TIMEOUT_MS',
  'CCMS_PASSWORD_FAILURES_MAX',
  'CCMS_PASSWORD_FAILURES_WINDOW_MS',
  'CCMS_PASSWORD_SIGN_IN',
  'CCMS_PDF_MEMORY_MB',
  'CCMS_PDF_QUEUE',
  'CCMS_PDF_TIMEOUT_MS',
  'CCMS_PDF_WORKERS',
  'CCMS_PUBLIC_SANDBOX',
  'CCMS_PUBLIC_URL',
  'CCMS_RELEASE_ARCHIVE_MAX_BYTES',
  'CCMS_RELEASE_MAX_OUTPUTS',
  'CCMS_RELEASE_TAG',
  'CCMS_RENDER_CONCURRENCY',
  'CCMS_RENDITION_CONCURRENCY',
  'CCMS_RENDITION_MAX_PIXELS',
  'CCMS_RENDITION_MAX_SOURCE_BYTES',
  'CCMS_RENDITION_TIMEOUT_MS',
  'CCMS_ROLE',
  'CCMS_S3_ACCESS_KEY_ID',
  'CCMS_S3_BUCKET',
  'CCMS_S3_ENDPOINT',
  'CCMS_S3_FORCE_PATH_STYLE',
  'CCMS_S3_REGION',
  'CCMS_S3_SECRET_ACCESS_KEY',
  'CCMS_SAML_EMAIL_ATTRIBUTE',
  'CCMS_SAML_EMAIL_VERIFIED',
  'CCMS_SAML_GROUPS_ATTRIBUTE',
  'CCMS_SAML_IDP_INITIATED',
  'CCMS_SAML_IDP_METADATA_FILE',
  'CCMS_SAML_IDP_METADATA_URL',
  'CCMS_SAML_NAME',
  'CCMS_SAML_NAME_ATTRIBUTE',
  'CCMS_SAML_NAME_ID_FORMAT',
  'CCMS_SAML_SP_ENTITY_ID',
  'CCMS_SANDBOX_END_URL',
  'CCMS_SANDBOX_IDLE_MINUTES',
  'CCMS_SANDBOX_MAX_CHANGE_SETS',
  'CCMS_SANDBOX_MAX_COMMENT_LENGTH',
  'CCMS_SANDBOX_MAX_MANUALS',
  'CCMS_SANDBOX_MAX_MINUTES',
  'CCMS_SANDBOX_MAX_MODULES',
  'CCMS_SANDBOX_MAX_MODULE_BYTES',
  'CCMS_SANDBOX_MAX_WRITE_BYTES',
  'CCMS_SANDBOX_PORTAL_URL',
  'CCMS_SANDBOX_RELEASES_PER_HOUR',
  'CCMS_SANDBOX_RENDER_JOBS',
  'CCMS_SEARCH_ADAPTER',
  'CCMS_SEARCH_CONCURRENCY',
  'CCMS_SEARCH_INDEXES',
  'CCMS_SEARCH_MODEL_KEPT_DAYS',
  'CCMS_SEARCH_PER_MINUTE',
  'CCMS_SEARCH_SWEEP_AFTER_DAYS',
  'CCMS_SEARCH_TIMEOUT_MS',
  'CCMS_SECRET_KEY',
  'CCMS_SECRET_KEY_FILE',
  'CCMS_SECRET_KEY_GENERATE',
  'CCMS_SESSION_IDLE_MINUTES',
  'CCMS_SESSION_MAX_HOURS',
  'CCMS_SOURCE_URL',
  'CCMS_STORAGE_LIMIT_BYTES',
  'CCMS_STORAGE_RECOUNT_HOURS',
  'CCMS_STYLE_REVIEW_API_KEY',
  'CCMS_STYLE_REVIEW_MODEL',
  'CCMS_STYLE_REVIEW_PER_MINUTE',
  'CCMS_STYLE_REVIEW_TIMEOUT_MS',
  'CCMS_STYLE_REVIEW_URL',
  'CCMS_TRUST_PROXY',
  'CCMS_WEBHOOKS_ALLOW_HTTP',
  'CCMS_WEBHOOKS_ALLOW_PRIVATE',
  'CCMS_WEBHOOKS_KEEP_DAYS',
  'CCMS_WEBHOOKS_POLL_MS',
  'CCMS_WEBHOOKS_SECRET_KEY',
  'CCMS_WEBHOOKS_TIMEOUT_MS',
  'CCMS_WORKER_NICE',
  'HOST',
  'PORT',
];

// The settings of the documentation domain's components, which they now register themselves.
const REGISTERED = {
  imports: [
    'CCMS_IMPORT_MAX_BYTES',
    'CCMS_IMPORT_MAX_FILES',
    'CCMS_IMPORT_MAX_UNPACKED_BYTES',
    'CCMS_IMPORT_MAX_PATH_DEPTH',
    'CCMS_IMPORT_MAX_JSON_DEPTH',
    'CCMS_IMPORT_MAX_DOCUMENT_BYTES',
    'CCMS_IMPORT_CONVERT_MAX_MEMORY_MB',
    'CCMS_IMPORT_CONVERT_TIMEOUT_MS',
    'CCMS_IMPORT_COMMIT_FILES',
    'CCMS_IMPORT_COMMIT_BYTES',
  ],
  'style-review': [
    'CCMS_STYLE_REVIEW_URL',
    'CCMS_STYLE_REVIEW_API_KEY',
    'CCMS_STYLE_REVIEW_MODEL',
    'CCMS_STYLE_REVIEW_PER_MINUTE',
    'CCMS_STYLE_REVIEW_TIMEOUT_MS',
  ],
};

const base = {
  CCMS_CONTENT_DIR: '/srv/content',
  CCMS_API_TOKEN: 'x'.repeat(32),
  CCMS_DATABASE_URL: 'postgres://ccms:secret@db:5432/ccms',
  CCMS_BLOB_DRIVER: 'fs',
  CCMS_BLOB_FS_ROOT: '/srv/blobs',
};

describe('the registered settings', () => {
  it('reads exactly the settings there were', () => {
    expect(Object.keys(Env.shape).sort()).toEqual(TODAY);
  });

  it('holds each component’s own, with the component that registers it', () => {
    const byGroup: Record<string, string[]> = {};
    for (const { name, group } of REGISTERED_SETTINGS.names)
      (byGroup[group] ??= []).push(name);
    expect(byGroup).toEqual(REGISTERED);
    for (const { name } of REGISTERED_SETTINGS.names)
      expect(Env.shape[name as keyof typeof Env.shape], name).toBe(
        REGISTERED_SETTINGS.shape[name],
      );
  });

  it('runs each component’s own checks', () => {
    expect(() =>
      validateEnv({ ...base, CCMS_STYLE_REVIEW_MODEL: 'some-model' }),
    ).toThrow(
      'is required when CCMS_STYLE_REVIEW_MODEL or CCMS_STYLE_REVIEW_API_KEY is set',
    );
  });

  it('names each group after the component whose folder defines it, so none passes for another', async () => {
    const groups = await definedGroups('./settings.ts');
    for (const { folder, group } of groups) expect(group).toBe(folder);
    expect(
      groups.flatMap((g) => g.members.map((m) => `${g.group} ${m}`)).sort(),
    ).toEqual(
      REGISTERED_SETTINGS.names.map((s) => `${s.group} ${s.name}`).sort(),
    );
    // Each registered schema is the found group's own, not one of the same name.
    for (const { name, group } of REGISTERED_SETTINGS.names)
      expect(
        groups.find((g) => g.group === group)?.value.shape?.[name],
        name,
      ).toBe(
        REGISTERED_SETTINGS.shape[
          name as keyof typeof REGISTERED_SETTINGS.shape
        ],
      );
  });

  it('never lets a component replace a setting the platform reads', async () => {
    vi.resetModules();
    vi.doMock('./settings.js', () => ({
      REGISTERED_SETTINGS: {
        names: [{ name: 'CCMS_API_TOKEN', group: 'rival' }],
        shape: {},
        checks: [],
      },
    }));
    try {
      await expect(import('./config/env.js')).rejects.toThrow(
        'The setting CCMS_API_TOKEN is registered by rival and read by the platform',
      );
    } finally {
      vi.doUnmock('./settings.js');
      vi.resetModules();
    }
  });

  it('cannot be changed once registered', () => {
    expect(Object.isFrozen(REGISTERED_SETTINGS)).toBe(true);
    expect(Object.isFrozen(REGISTERED_SETTINGS.names)).toBe(true);
    expect(Object.isFrozen(REGISTERED_SETTINGS.shape)).toBe(true);
    expect(Object.isFrozen(REGISTERED_SETTINGS.checks)).toBe(true);
  });
});
