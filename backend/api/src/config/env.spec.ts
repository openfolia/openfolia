import { validateEnv } from './env.js';
import { packageSendSettings } from './package-send-env.js';
import { emailCodeSignInOn, passwordSignInOn } from './sign-in-env.js';

const base = {
  CCMS_CONTENT_DIR: '/srv/content',
  CCMS_API_TOKEN: 'x'.repeat(32),
  CCMS_DATABASE_URL: 'postgres://ccms:secret@db:5432/ccms',
  CCMS_BLOB_DRIVER: 'fs',
  CCMS_BLOB_FS_ROOT: '/srv/blobs',
};

describe('settings', () => {
  it('applies defaults and converts numbers', () => {
    expect(validateEnv({ ...base, PORT: '8080', CCMS_PDF_QUEUE: '0' })).toEqual(
      {
        ...base,
        CCMS_AUTH_MODE: 'token',
        CCMS_DEFAULT_REF: 'HEAD',
        CCMS_CONTENT_CACHE_MB: 64,
        CCMS_CONTENT_INDEX_CACHE_MB: 32,
        CCMS_SEARCH_INDEXES: 16,
        CCMS_PUBLIC_SANDBOX: 'off',
        CCMS_SANDBOX_IDLE_MINUTES: 30,
        CCMS_SANDBOX_MAX_MINUTES: 90,
        CCMS_SANDBOX_MAX_MODULE_BYTES: 131_072,
        CCMS_SANDBOX_MAX_COMMENT_LENGTH: 2_000,
        CCMS_SANDBOX_MAX_CHANGE_SETS: 20,
        CCMS_SANDBOX_MAX_MODULES: 50,
        CCMS_SANDBOX_MAX_MANUALS: 10,
        CCMS_SANDBOX_RELEASES_PER_HOUR: 4,
        CCMS_SANDBOX_RENDER_JOBS: 1,
        CCMS_SANDBOX_MAX_WRITE_BYTES: 67_108_864,
        CCMS_SEARCH_ADAPTER: 'postgres',
        CCMS_SEARCH_TIMEOUT_MS: 5_000,
        CCMS_SEARCH_PER_MINUTE: 120,
        CCMS_SEARCH_CONCURRENCY: 4,
        CCMS_SEARCH_SWEEP_AFTER_DAYS: 7,
        CCMS_SEARCH_MODEL_KEPT_DAYS: 7,
        CCMS_EMBEDDER_TIMEOUT_MS: 10_000,
        CCMS_FIRST_ADMIN_LINK_LOG: true,
        CCMS_EMBEDDER_MIN_SIMILARITY: 50,
        CCMS_RELEASE_TAG: 'release/{product}/{revision}',
        CCMS_MAINTENANCE_BRANCH: 'maintenance/{product}/{revision}',
        CCMS_DOCS_URL: 'https://docs.openfolia.com/',
        CCMS_DELIVERY_MAX_ACCESS: 'public',
        CCMS_DELIVERY_IGNORED_QUERY: ['utm_*'],
        CCMS_DELIVERY_SHARED_MAX_AGE: 300,
        CCMS_TRUST_PROXY: false,
        CCMS_DELIVERY_PER_MINUTE: 60,
        HOST: '127.0.0.1',
        PORT: 8080,
        CCMS_PDF_QUEUE: 0,
        CCMS_MAX_UPLOAD_BYTES: 10 * 1024 * 1024,
        CCMS_NOTIFICATIONS_KEEP_DAYS: 90,
        CCMS_NOTIFICATIONS_POLL_MS: 3000,
        CCMS_AUTH_FAILURES_MAX: 20,
        CCMS_AUTH_FAILURES_WINDOW_MS: 60_000,
        CCMS_PASSWORD_FAILURES_MAX: 10,
        CCMS_PASSWORD_FAILURES_WINDOW_MS: 900_000,
        CCMS_BACKUP_WARN_AFTER_HOURS: 26,
        CCMS_IMPORT_COMMIT_BYTES: 33554432,
        CCMS_IMPORT_COMMIT_FILES: 1000,
        CCMS_IMPORT_MAX_BYTES: 67108864,
        CCMS_IMPORT_MAX_DOCUMENT_BYTES: 8388608,
        CCMS_IMPORT_CONVERT_MAX_MEMORY_MB: 1024,
        CCMS_IMPORT_CONVERT_TIMEOUT_MS: 120000,
        CCMS_IMPORT_MAX_FILES: 5000,
        CCMS_IMPORT_MAX_JSON_DEPTH: 128,
        CCMS_IMPORT_MAX_PATH_DEPTH: 4,
        CCMS_IMPORT_MAX_UNPACKED_BYTES: 268435456,
        CCMS_RELEASE_ARCHIVE_MAX_BYTES: 2 * 1024 * 1024 * 1024,
        CCMS_RELEASE_MAX_OUTPUTS: 20_000,
        CCMS_OFFLINE_PACKAGES: true,
        CCMS_JOBS_POLL_MS: 2000,
        CCMS_JOBS_POOL_MAX: 4,
        CCMS_MAIL_LANGUAGE: 'en',
        CCMS_MAIL_REQUIRE_TLS: true,
        CCMS_MAX_ATTACHMENT_BYTES: 50 * 1024 * 1024,
        CCMS_MAX_FONT_BYTES: 10 * 1024 * 1024,
        CCMS_STORAGE_RECOUNT_HOURS: 24,
        CCMS_RENDITION_MAX_PIXELS: 40_000_000,
        CCMS_RENDITION_TIMEOUT_MS: 10_000,
        CCMS_RENDITION_CONCURRENCY: 2,
        CCMS_RENDITION_MAX_SOURCE_BYTES: 50 * 1024 * 1024,
        CCMS_ATTACHMENT_TYPES_DENY: [],
        CCMS_ATTACHMENT_TYPES_OPEN: [],
        CCMS_DATABASE_MIGRATE: true,
        CCMS_DATABASE_POOL_MAX: 10,
        CCMS_DATABASE_LOCK_TIMEOUT_MS: 10_000,
        CCMS_DATABASE_MIGRATE_ATTEMPTS: 3,
        CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS: 5_000,
        CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS: 30_000,
        CCMS_S3_REGION: 'us-east-1',
        CCMS_S3_FORCE_PATH_STYLE: false,
        CCMS_STYLE_REVIEW_PER_MINUTE: 6,
        CCMS_STYLE_REVIEW_TIMEOUT_MS: 30_000,
        CCMS_WEBHOOKS_POLL_MS: 3_000,
        CCMS_WEBHOOKS_TIMEOUT_MS: 10_000,
        CCMS_WEBHOOKS_KEEP_DAYS: 30,
        CCMS_WEBHOOKS_ALLOW_HTTP: false,
        CCMS_WEBHOOKS_ALLOW_PRIVATE: false,
        CCMS_SECRET_KEY_GENERATE: true,
        CCMS_OIDC_SCOPES: ['openid', 'profile', 'email'],
        CCMS_OIDC_GROUPS_CLAIM: 'groups',
        CCMS_OIDC_LINK_BY_EMAIL: 'pending',
        CCMS_SESSION_IDLE_MINUTES: 480,
        CCMS_SESSION_MAX_HOURS: 168,
        CCMS_INVITE_DAYS: 7,
        CCMS_EMAIL_CODE_MINUTES: 10,
        CCMS_AUDIT_SINK_POLL_MS: 3_000,
        CCMS_AUDIT_SINK_TIMEOUT_MS: 10_000,
        CCMS_ROLE: 'all',
        CCMS_WORKER_NICE: 10,
      },
    );
  });

  it('takes the role (#527): all by default, the known ones in any case, nothing else', () => {
    for (const role of ['all', 'api', 'worker', 'backup']) {
      expect(validateEnv({ ...base, CCMS_ROLE: role })).toMatchObject({
        CCMS_ROLE: role,
      });
    }
    expect(validateEnv({ ...base, CCMS_ROLE: ' Worker ' })).toMatchObject({
      CCMS_ROLE: 'worker',
    });
    expect(validateEnv({ ...base, CCMS_ROLE: '' })).toMatchObject({
      CCMS_ROLE: 'all',
    });
    expect(() => validateEnv({ ...base, CCMS_ROLE: 'workers' })).toThrow(
      /CCMS_ROLE/,
    );
    for (const nice of ['-1', '20', '5.5', 'low']) {
      expect(() => validateEnv({ ...base, CCMS_WORKER_NICE: nice })).toThrow(
        /CCMS_WORKER_NICE/,
      );
    }
  });

  it('bounds the release renders by the PDF workers only where they render (#527)', () => {
    // The api role renders no release file: a setting shared with the workers is no error.
    expect(
      validateEnv({ ...base, CCMS_ROLE: 'api', CCMS_RENDER_CONCURRENCY: '3' }),
    ).toMatchObject({ CCMS_RENDER_CONCURRENCY: 3 });
    expect(() =>
      validateEnv({
        ...base,
        CCMS_ROLE: 'worker',
        CCMS_PDF_WORKERS: '2',
        CCMS_RENDER_CONCURRENCY: '3',
      }),
    ).toThrow(/CCMS_RENDER_CONCURRENCY/);
    expect(
      validateEnv({
        ...base,
        CCMS_ROLE: 'api',
        CCMS_PDF_WORKERS: '4',
        CCMS_RENDER_CONCURRENCY: '3',
      }),
    ).toMatchObject({ CCMS_RENDER_CONCURRENCY: 3 });
  });

  it('bounds the upload limit', () => {
    expect(
      validateEnv({ ...base, CCMS_MAX_UPLOAD_BYTES: '1048576' }),
    ).toMatchObject({ CCMS_MAX_UPLOAD_BYTES: 1_048_576 });
    for (const value of ['0', '1073741825', '1e6', '-1', '10MB']) {
      expect(() =>
        validateEnv({ ...base, CCMS_MAX_UPLOAD_BYTES: value }),
      ).toThrow(/CCMS_MAX_UPLOAD_BYTES/);
    }
  });

  it('bounds the font limit', () => {
    expect(
      validateEnv({ ...base, CCMS_MAX_FONT_BYTES: '2097152' }),
    ).toMatchObject({ CCMS_MAX_FONT_BYTES: 2_097_152 });
    for (const value of ['0', '67108865', '10MB']) {
      expect(() =>
        validateEnv({ ...base, CCMS_MAX_FONT_BYTES: value }),
      ).toThrow(/CCMS_MAX_FONT_BYTES/);
    }
  });

  it('bounds the attachment limit and reads the type lists', () => {
    expect(
      validateEnv({
        ...base,
        CCMS_MAX_ATTACHMENT_BYTES: '1048576',
        CCMS_ATTACHMENT_TYPES_ALLOW: 'application/zip, text/*, .json',
        CCMS_ATTACHMENT_TYPES_OPEN: '.html',
      }),
    ).toMatchObject({
      CCMS_MAX_ATTACHMENT_BYTES: 1_048_576,
      CCMS_ATTACHMENT_TYPES_ALLOW: [
        { kind: 'type', type: 'application/zip' },
        { kind: 'family', top: 'text' },
        { kind: 'extension', extension: '.json' },
      ],
      CCMS_ATTACHMENT_TYPES_OPEN: [{ kind: 'extension', extension: '.html' }],
    });
    expect(validateEnv(base)).not.toHaveProperty('CCMS_ATTACHMENT_TYPES_ALLOW');
    for (const value of ['0', '1073741825', '50MB']) {
      expect(() =>
        validateEnv({ ...base, CCMS_MAX_ATTACHMENT_BYTES: value }),
      ).toThrow(/CCMS_MAX_ATTACHMENT_BYTES/);
    }
    // An allow list of nothing would refuse every file: a mistake, refused.
    expect(() =>
      validateEnv({ ...base, CCMS_ATTACHMENT_TYPES_ALLOW: ' , ,' }),
    ).toThrow(/at least one type[\s\S]*CCMS_ATTACHMENT_TYPES_ALLOW/);
    expect(
      validateEnv({ ...base, CCMS_ATTACHMENT_TYPES_DENY: ',' }),
    ).toMatchObject({ CCMS_ATTACHMENT_TYPES_DENY: [] });
    for (const name of [
      'CCMS_ATTACHMENT_TYPES_ALLOW',
      'CCMS_ATTACHMENT_TYPES_DENY',
      'CCMS_ATTACHMENT_TYPES_OPEN',
    ]) {
      expect(() => validateEnv({ ...base, [name]: 'zip' })).toThrow(
        new RegExp(`"zip" is neither[\\s\\S]*at ${name}`),
      );
    }
  });

  it('bounds the database tuning settings', () => {
    expect(() =>
      validateEnv({ ...base, CCMS_DATABASE_MIGRATE_ATTEMPTS: '0' }),
    ).toThrow(/CCMS_DATABASE_MIGRATE_ATTEMPTS/);
    expect(
      validateEnv({ ...base, CCMS_DATABASE_LOCK_TIMEOUT_MS: '30000' }),
    ).toMatchObject({ CCMS_DATABASE_LOCK_TIMEOUT_MS: 30_000 });
    expect(() =>
      validateEnv({ ...base, CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS: '0' }),
    ).toThrow(/CCMS_DATABASE_WRITE_LOCK_TIMEOUT_MS/);
    expect(() =>
      validateEnv({
        ...base,
        CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS: '700000',
      }),
    ).toThrow(/CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS/);
    expect(
      validateEnv({
        ...base,
        CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS: '2000',
      }),
    ).toMatchObject({ CCMS_DATABASE_WRITE_STATEMENT_TIMEOUT_MS: 2_000 });
  });

  it('reads CCMS_RELEASE_TAG as a pattern with both placeholders as whole components', () => {
    expect(
      validateEnv({ ...base, CCMS_RELEASE_TAG: 'r/{revision}/{product}' }),
    ).toMatchObject({ CCMS_RELEASE_TAG: 'r/{revision}/{product}' });
    for (const bad of [
      'release/{product}',
      'release/{product}/{product}/{revision}',
      'release/{product}-{revision}',
      'release/{product}/{revision}.lock/x',
      'release/../{product}/{revision}',
      'release /{product}/{revision}',
      '/{product}/{revision}',
    ]) {
      expect(() => validateEnv({ ...base, CCMS_RELEASE_TAG: bad })).toThrow(
        /CCMS_RELEASE_TAG/,
      );
    }
  });

  it('reads CCMS_MAINTENANCE_BRANCH as a branch pattern outside the change sets', () => {
    expect(
      validateEnv({
        ...base,
        CCMS_MAINTENANCE_BRANCH: 'fix/{product}/{revision}',
      }),
    ).toMatchObject({ CCMS_MAINTENANCE_BRANCH: 'fix/{product}/{revision}' });
    for (const bad of [
      'maintenance/{product}',
      'maintenance/{product}-{revision}',
      'change-sets/{product}/{revision}',
      'Change-Sets/{product}/{revision}',
      'refs/{product}/{revision}',
      // The release tags' default pattern.
      'release/{product}/{revision}',
    ]) {
      expect(() =>
        validateEnv({ ...base, CCMS_MAINTENANCE_BRANCH: bad }),
      ).toThrow(/CCMS_MAINTENANCE_BRANCH/);
    }
  });

  it('treats blank values as unset', () => {
    expect(validateEnv({ ...base, PORT: '  ', HOST: '' })).toMatchObject({
      PORT: 3100,
      HOST: '127.0.0.1',
    });
  });

  it('lists every problem at once', () => {
    expect(() =>
      validateEnv({
        CCMS_API_TOKEN: 'short',
        CCMS_PDF_WORKERS: '65',
        PORT: '1e3',
      }),
    ).toThrow(
      /CCMS_CONTENT_DIR[\s\S]*CCMS_API_TOKEN[\s\S]*PORT[\s\S]*CCMS_PDF_WORKERS/,
    );
  });

  it('accepts only plain whole numbers in range', () => {
    for (const bad of ['-1', '0x10', '1.5', '70000']) {
      expect(() => validateEnv({ ...base, PORT: bad })).toThrow(/PORT/);
    }
    expect(validateEnv({ ...base, PORT: '0' }).PORT).toBe(0);
  });

  it('needs a Postgres URL, and never repeats it in the message', () => {
    expect(() =>
      validateEnv({ ...base, CCMS_DATABASE_URL: undefined }),
    ).toThrow(/CCMS_DATABASE_URL/);
    for (const bad of [
      'mysql://u:hunter2@db/ccms',
      'postgres://u:hunter2@db',
      'postgres://u:hunter2@/ccms',
      'u:hunter2@db/ccms',
    ]) {
      let message = '';
      try {
        validateEnv({ ...base, CCMS_DATABASE_URL: bad });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/CCMS_DATABASE_URL/);
      expect(message).not.toContain('hunter2');
    }
    expect(
      validateEnv({ ...base, CCMS_DATABASE_URL: ' postgresql://db/ccms ' })
        .CCMS_DATABASE_URL,
    ).toBe('postgresql://db/ccms');
    // A Unix socket, as .env.example shows it.
    expect(
      validateEnv({
        ...base,
        CCMS_DATABASE_URL:
          'postgres:///ccms?host=/var/run/postgresql&user=ccms',
      }).CCMS_DATABASE_URL,
    ).toBe('postgres:///ccms?host=/var/run/postgresql&user=ccms');
  });

  it('reads CCMS_DATABASE_MIGRATE as true or false only', () => {
    expect(
      validateEnv({ ...base, CCMS_DATABASE_MIGRATE: 'FALSE' })
        .CCMS_DATABASE_MIGRATE,
    ).toBe(false);
    expect(
      validateEnv({ ...base, CCMS_DATABASE_MIGRATE: '' }).CCMS_DATABASE_MIGRATE,
    ).toBe(true);
    for (const bad of ['0', 'no', 'yes']) {
      expect(() =>
        validateEnv({ ...base, CCMS_DATABASE_MIGRATE: bad }),
      ).toThrow(/CCMS_DATABASE_MIGRATE/);
    }
  });

  it('reads CCMS_AUTH_MODE as token (default) or demo only', () => {
    expect(validateEnv({ ...base, CCMS_AUTH_MODE: '' }).CCMS_AUTH_MODE).toBe(
      'token',
    );
    expect(
      validateEnv({ ...base, CCMS_AUTH_MODE: ' demo ' }).CCMS_AUTH_MODE,
    ).toBe('demo');
    for (const bad of ['Demo', 'off', 'true']) {
      expect(() => validateEnv({ ...base, CCMS_AUTH_MODE: bad })).toThrow(
        /CCMS_AUTH_MODE/,
      );
    }
  });

  it('takes the shared token as optional, but requires it in demo mode', () => {
    expect(
      validateEnv({ ...base, CCMS_API_TOKEN: '' }).CCMS_API_TOKEN,
    ).toBeUndefined();
    expect(() =>
      validateEnv({ ...base, CCMS_API_TOKEN: '', CCMS_AUTH_MODE: 'demo' }),
    ).toThrow(/demo mode[\s\S]*CCMS_API_TOKEN/);
    expect(() =>
      validateEnv({ ...base, CCMS_AUTH_FAILURES_WINDOW_MS: '10' }),
    ).toThrow(/CCMS_AUTH_FAILURES_WINDOW_MS/);
  });

  describe('blob store', () => {
    const s3 = { ...base, CCMS_BLOB_DRIVER: 's3', CCMS_BLOB_FS_ROOT: '' };

    it('needs a driver, and what that driver needs', () => {
      expect(() =>
        validateEnv({ ...base, CCMS_BLOB_DRIVER: undefined }),
      ).toThrow(/CCMS_BLOB_DRIVER/);
      expect(() => validateEnv({ ...base, CCMS_BLOB_DRIVER: 'gcs' })).toThrow(
        /CCMS_BLOB_DRIVER/,
      );
      expect(() =>
        validateEnv({ ...base, CCMS_BLOB_FS_ROOT: undefined }),
      ).toThrow(/CCMS_BLOB_FS_ROOT/);
      expect(() =>
        validateEnv({ ...base, CCMS_BLOB_FS_ROOT: 'relative/blobs' }),
      ).toThrow(/CCMS_BLOB_FS_ROOT/);
      expect(() => validateEnv(s3)).toThrow(/CCMS_S3_BUCKET/);
    });

    it('reads the S3 settings', () => {
      expect(
        validateEnv({
          ...s3,
          CCMS_S3_BUCKET: 'openfolia-blobs',
          CCMS_S3_ENDPOINT: 'http://127.0.0.1:8333',
          CCMS_S3_FORCE_PATH_STYLE: 'true',
          CCMS_S3_ACCESS_KEY_ID: 'key',
          CCMS_S3_SECRET_ACCESS_KEY: 'secret',
        }),
      ).toMatchObject({
        CCMS_BLOB_DRIVER: 's3',
        CCMS_S3_REGION: 'us-east-1',
        CCMS_S3_FORCE_PATH_STYLE: true,
      });
    });

    it('refuses half the credentials, a bad bucket name or endpoint, without repeating them', () => {
      const bucket = { ...s3, CCMS_S3_BUCKET: 'openfolia-blobs' };
      expect(() =>
        validateEnv({ ...bucket, CCMS_S3_ACCESS_KEY_ID: 'key' }),
      ).toThrow(/CCMS_S3_SECRET_ACCESS_KEY/);
      expect(() =>
        validateEnv({ ...s3, CCMS_S3_BUCKET: 'Not_A_Bucket' }),
      ).toThrow(/CCMS_S3_BUCKET/);
      let message = '';
      try {
        validateEnv({
          ...bucket,
          CCMS_S3_ENDPOINT: 'http://key:hunter2@s3.example',
        });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/CCMS_S3_ENDPOINT/);
      expect(message).not.toContain('hunter2');
    });
  });
});

describe('style review', () => {
  const url = 'https://models.example/v1/chat/completions';

  it('is off by default, and on with a URL and a model', () => {
    expect(validateEnv(base)).not.toHaveProperty('CCMS_STYLE_REVIEW_URL');
    expect(
      validateEnv({
        ...base,
        CCMS_STYLE_REVIEW_URL: url,
        CCMS_STYLE_REVIEW_MODEL: 'some-model',
        CCMS_STYLE_REVIEW_API_KEY: 'sk-secret-value',
        CCMS_STYLE_REVIEW_PER_MINUTE: '3',
        CCMS_STYLE_REVIEW_TIMEOUT_MS: '5000',
      }),
    ).toMatchObject({
      CCMS_STYLE_REVIEW_URL: url,
      CCMS_STYLE_REVIEW_MODEL: 'some-model',
      CCMS_STYLE_REVIEW_PER_MINUTE: 3,
      CCMS_STYLE_REVIEW_TIMEOUT_MS: 5000,
    });
  });

  it('needs the model with the URL, and the URL with a model or a key', () => {
    expect(() => validateEnv({ ...base, CCMS_STYLE_REVIEW_URL: url })).toThrow(
      /CCMS_STYLE_REVIEW_MODEL/,
    );
    expect(() =>
      validateEnv({ ...base, CCMS_STYLE_REVIEW_MODEL: 'm' }),
    ).toThrow(/CCMS_STYLE_REVIEW_URL/);
    expect(() =>
      validateEnv({ ...base, CCMS_STYLE_REVIEW_API_KEY: 'k' }),
    ).toThrow(/CCMS_STYLE_REVIEW_URL/);
  });

  it('sends a key only over https or to this machine, and never repeats it', () => {
    const plain = {
      ...base,
      CCMS_STYLE_REVIEW_MODEL: 'm',
      CCMS_STYLE_REVIEW_API_KEY: 'hunter2-key',
    };
    let message = '';
    try {
      validateEnv({
        ...plain,
        CCMS_STYLE_REVIEW_URL: 'http://models.example/v1',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/CCMS_STYLE_REVIEW_URL/);
    expect(message).not.toContain('hunter2');
    expect(() =>
      validateEnv({
        ...plain,
        CCMS_STYLE_REVIEW_URL: 'http://127.0.0.1:8080/v1',
      }),
    ).not.toThrow();
    expect(() =>
      validateEnv({ ...plain, CCMS_STYLE_REVIEW_URL: 'http://localhost/v1' }),
    ).not.toThrow();
    // Without a key, a self-hosted endpoint on the network is fine.
    expect(() =>
      validateEnv({
        ...base,
        CCMS_STYLE_REVIEW_MODEL: 'm',
        CCMS_STYLE_REVIEW_URL: 'http://models.internal/v1',
      }),
    ).not.toThrow();
  });

  it('refuses a URL with credentials or a query, and limits out of range', () => {
    for (const bad of [
      'https://user:pass@models.example/v1',
      'https://models.example/v1?key=x',
      'ftp://models.example/v1',
      'not a url',
    ]) {
      expect(() =>
        validateEnv({
          ...base,
          CCMS_STYLE_REVIEW_MODEL: 'm',
          CCMS_STYLE_REVIEW_URL: bad,
        }),
      ).toThrow(/CCMS_STYLE_REVIEW_URL/);
    }
    expect(() =>
      validateEnv({ ...base, CCMS_STYLE_REVIEW_PER_MINUTE: '0' }),
    ).toThrow(/CCMS_STYLE_REVIEW_PER_MINUTE/);
    expect(() =>
      validateEnv({ ...base, CCMS_STYLE_REVIEW_TIMEOUT_MS: '10' }),
    ).toThrow(/CCMS_STYLE_REVIEW_TIMEOUT_MS/);
  });
});

describe('CCMS_PASSWORD_SIGN_IN (#610)', () => {
  it('is on by default, off when set so, and never in demo mode', () => {
    const demo = {
      ...base,
      CCMS_AUTH_MODE: 'demo',
      CCMS_API_TOKEN: 'x'.repeat(32),
    };
    expect(passwordSignInOn(validateEnv(base))).toBe(true);
    expect(
      passwordSignInOn(validateEnv({ ...base, CCMS_PASSWORD_SIGN_IN: 'OFF' })),
    ).toBe(false);
    expect(passwordSignInOn(validateEnv(demo))).toBe(false);
  });

  it('refuses on together with demo mode, and anything but on or off', () => {
    expect(() =>
      validateEnv({
        ...base,
        CCMS_AUTH_MODE: 'demo',
        CCMS_API_TOKEN: 'x'.repeat(32),
        CCMS_PASSWORD_SIGN_IN: 'on',
      }),
    ).toThrow(/CCMS_PASSWORD_SIGN_IN/);
    expect(() =>
      validateEnv({ ...base, CCMS_PASSWORD_SIGN_IN: 'yes' }),
    ).toThrow(/must be on or off/);
  });

  it('takes the invite days from 1 to 90', () => {
    expect(validateEnv({ ...base, CCMS_INVITE_DAYS: '3' })).toMatchObject({
      CCMS_INVITE_DAYS: 3,
    });
    expect(() => validateEnv({ ...base, CCMS_INVITE_DAYS: '0' })).toThrow(
      /CCMS_INVITE_DAYS/,
    );
  });
});

describe('emailCodeSignInOn (#634)', () => {
  const mail = { CCMS_AUTH_MODE: 'token', CCMS_MAIL_URL: 'smtp://mail' };

  it('is on with email and passwords, off without email, off when set so, never in demo', () => {
    expect(emailCodeSignInOn(mail)).toBe(true);
    expect(emailCodeSignInOn({ CCMS_AUTH_MODE: 'token' })).toBe(false);
    expect(emailCodeSignInOn({ ...mail, CCMS_EMAIL_CODE_SIGN_IN: 'off' })).toBe(
      false,
    );
    expect(
      emailCodeSignInOn({
        ...mail,
        CCMS_AUTH_MODE: 'demo',
        CCMS_EMAIL_CODE_SIGN_IN: 'on',
      }),
    ).toBe(false);
  });

  it('beside a provider alone, only when set to on: no way around the provider on an upgrade', () => {
    const providerOnly = {
      ...mail,
      CCMS_PASSWORD_SIGN_IN: 'off' as const,
      CCMS_OIDC_ISSUER: 'https://id.example.org',
    };
    expect(emailCodeSignInOn(providerOnly)).toBe(false);
    expect(
      emailCodeSignInOn({ ...providerOnly, CCMS_EMAIL_CODE_SIGN_IN: 'on' }),
    ).toBe(true);
  });

  it('alone, without passwords or a provider, only when set to on (#639)', () => {
    const alone = { ...mail, CCMS_PASSWORD_SIGN_IN: 'off' as const };
    expect(emailCodeSignInOn(alone)).toBe(false);
    expect(emailCodeSignInOn({ ...alone, CCMS_EMAIL_CODE_SIGN_IN: 'on' })).toBe(
      true,
    );
  });
});

describe('CCMS_EMAIL_CODE_SIGN_IN (#639)', () => {
  const alone = {
    ...base,
    CCMS_PASSWORD_SIGN_IN: 'off',
    CCMS_EMAIL_CODE_SIGN_IN: 'on',
  };
  const mail = {
    CCMS_MAIL_URL: 'smtp://mail.example.com',
    CCMS_MAIL_FROM: 'docs@example.com',
  };

  it('accepts codes as the only way to sign in, with email set up', () => {
    expect(validateEnv({ ...alone, ...mail })).toMatchObject({
      CCMS_EMAIL_CODE_SIGN_IN: 'on',
      CCMS_PASSWORD_SIGN_IN: 'off',
    });
  });

  it('refuses them without email, and in demo mode', () => {
    expect(() => validateEnv(alone)).toThrow(
      /needs email \(CCMS_MAIL_URL\)[\s\S]*at CCMS_EMAIL_CODE_SIGN_IN/,
    );
    expect(() =>
      validateEnv({
        ...base,
        ...mail,
        CCMS_EMAIL_CODE_SIGN_IN: 'on',
        CCMS_AUTH_MODE: 'demo',
      }),
    ).toThrow(/demo mode[\s\S]*at CCMS_EMAIL_CODE_SIGN_IN/);
  });
});

describe('CCMS_EDITOR_ORIGINS', () => {
  it('is a list of origins, normalised, and unset by default', () => {
    expect(validateEnv(base)).not.toHaveProperty('CCMS_EDITOR_ORIGINS');
    expect(
      validateEnv({
        ...base,
        CCMS_EDITOR_ORIGINS:
          ' https://Editor.example.com/ , http://localhost:4200,https://editor.example.com',
      }),
    ).toMatchObject({
      CCMS_EDITOR_ORIGINS: [
        'https://editor.example.com',
        'http://localhost:4200',
      ],
    });
  });

  it('refuses anything that is not a plain origin, since it ends up in a header', () => {
    for (const bad of [
      '*',
      'https://*.example.com',
      'https://example.com/path',
      "https://example.com; script-src 'unsafe-inline'",
      'https://example.com https://evil.example',
      'https://user@example.com',
      'ftp://example.com',
      'example.com',
      'https://example.com,',
      "'self'",
    ]) {
      expect(() => validateEnv({ ...base, CCMS_EDITOR_ORIGINS: bad })).toThrow(
        /CCMS_EDITOR_ORIGINS/,
      );
    }
  });
});

describe('CCMS_SOURCE_URL', () => {
  it('is an http or https URL, normalised, and unset by default', () => {
    expect(validateEnv(base)).not.toHaveProperty('CCMS_SOURCE_URL');
    expect(
      validateEnv({ ...base, CCMS_SOURCE_URL: '  ' }).CCMS_SOURCE_URL,
    ).toBeUndefined();
    expect(
      validateEnv({
        ...base,
        CCMS_SOURCE_URL: ' HTTPS://Code.example.org/a b ',
      }),
    ).toMatchObject({ CCMS_SOURCE_URL: 'https://code.example.org/a%20b' });
  });

  it('refuses another scheme (the editor links to it), credentials and non-URLs', () => {
    for (const bad of [
      'javascript:alert(1)',
      'data:text/html,hi',
      'ftp://code.example.org',
      'https://user:secret@code.example.org',
      'code.example.org/source',
      '/source',
    ]) {
      expect(() => validateEnv({ ...base, CCMS_SOURCE_URL: bad })).toThrow(
        /CCMS_SOURCE_URL/,
      );
    }
  });
});

describe('CCMS_PUBLIC_URL', () => {
  it('is an http or https URL ending in a slash, normalised, and unset by default', () => {
    expect(validateEnv(base)).not.toHaveProperty('CCMS_PUBLIC_URL');
    expect(
      validateEnv({ ...base, CCMS_PUBLIC_URL: ' ' }).CCMS_PUBLIC_URL,
    ).toBeUndefined();
    expect(
      validateEnv({ ...base, CCMS_PUBLIC_URL: ' HTTPS://Docs.Example.com ' })
        .CCMS_PUBLIC_URL,
    ).toBe('https://docs.example.com/');
    expect(
      validateEnv({ ...base, CCMS_PUBLIC_URL: 'https://example.com/docs' })
        .CCMS_PUBLIC_URL,
    ).toBe('https://example.com/docs/');
  });

  it('refuses another scheme, credentials, a query, a fragment and non-URLs', () => {
    for (const bad of [
      'javascript:alert(1)',
      'ftp://docs.example.com',
      'https://user:secret@docs.example.com',
      'https://docs.example.com/?a=1',
      'https://docs.example.com/?',
      'https://docs.example.com/#top',
      'docs.example.com',
      '/d',
    ]) {
      expect(() => validateEnv({ ...base, CCMS_PUBLIC_URL: bad })).toThrow(
        /CCMS_PUBLIC_URL/,
      );
    }
  });
});

describe('CCMS_DELIVERY_MAX_ACCESS and CCMS_DELIVERY_IGNORED_QUERY (#553)', () => {
  it('caps nothing and ignores the campaign parameters by default', () => {
    const env = validateEnv(base);
    expect(env.CCMS_DELIVERY_MAX_ACCESS).toBe('public');
    expect(env.CCMS_DELIVERY_IGNORED_QUERY).toEqual(['utm_*']);
    expect(
      validateEnv({ ...base, CCMS_DELIVERY_MAX_ACCESS: ' ' })
        .CCMS_DELIVERY_MAX_ACCESS,
    ).toBe('public');
  });

  it('takes a cap of public, signed-in or off, nothing else', () => {
    for (const access of ['public', 'signed-in', 'off'] as const) {
      expect(
        validateEnv({ ...base, CCMS_DELIVERY_MAX_ACCESS: access })
          .CCMS_DELIVERY_MAX_ACCESS,
      ).toBe(access);
    }
    for (const bad of ['Public', 'signed_in', 'none']) {
      expect(() =>
        validateEnv({ ...base, CCMS_DELIVERY_MAX_ACCESS: bad }),
      ).toThrow(/CCMS_DELIVERY_MAX_ACCESS/);
    }
  });

  it('takes names and prefixes, comma-separated, or none', () => {
    expect(
      validateEnv({
        ...base,
        CCMS_DELIVERY_IGNORED_QUERY: ' utm_* , click_ref,ref.id ,',
      }).CCMS_DELIVERY_IGNORED_QUERY,
    ).toEqual(['utm_*', 'click_ref', 'ref.id']);
    expect(
      validateEnv({ ...base, CCMS_DELIVERY_IGNORED_QUERY: 'none' })
        .CCMS_DELIVERY_IGNORED_QUERY,
    ).toEqual([]);
    for (const bad of ['*', 'utm_*,*', 'a*b', 'a b', 'theme[x]']) {
      expect(() =>
        validateEnv({ ...base, CCMS_DELIVERY_IGNORED_QUERY: bad }),
      ).toThrow(/CCMS_DELIVERY_IGNORED_QUERY/);
    }
  });
});

describe('CCMS_CONTENT_INDEX_CACHE_MB (#552)', () => {
  it('is 32 MiB by default, a whole number from 1 to 4096', () => {
    expect(validateEnv(base).CCMS_CONTENT_INDEX_CACHE_MB).toBe(32);
    expect(
      validateEnv({ ...base, CCMS_CONTENT_INDEX_CACHE_MB: '4096' })
        .CCMS_CONTENT_INDEX_CACHE_MB,
    ).toBe(4096);
    for (const bad of ['0', '4097', '1.5', 'lots']) {
      expect(() =>
        validateEnv({ ...base, CCMS_CONTENT_INDEX_CACHE_MB: bad }),
      ).toThrow(/CCMS_CONTENT_INDEX_CACHE_MB/);
    }
  });
});

describe('CCMS_BUILD_ID (#552)', () => {
  it('is unset by default, else a build’s name', () => {
    expect(validateEnv(base).CCMS_BUILD_ID).toBeUndefined();
    expect(validateEnv({ ...base, CCMS_BUILD_ID: ' ' }).CCMS_BUILD_ID).toBe(
      undefined,
    );
    for (const id of ['3f9e2a1c', 'v1.2.3+build.7', 'sha256:abc-1_2']) {
      expect(validateEnv({ ...base, CCMS_BUILD_ID: id }).CCMS_BUILD_ID).toBe(
        id,
      );
    }
    for (const bad of ['a b', 'x'.repeat(129), 'a/b', 'é']) {
      expect(() => validateEnv({ ...base, CCMS_BUILD_ID: bad })).toThrow(
        /CCMS_BUILD_ID/,
      );
    }
  });
});

describe('CCMS_DELIVERY_SHARED_MAX_AGE (#552)', () => {
  it('is five minutes by default, a whole number of seconds up to a day', () => {
    expect(validateEnv(base).CCMS_DELIVERY_SHARED_MAX_AGE).toBe(300);
    for (const [given, read] of [
      ['0', 0],
      ['60', 60],
      ['86400', 86_400],
    ] as const) {
      expect(
        validateEnv({ ...base, CCMS_DELIVERY_SHARED_MAX_AGE: given })
          .CCMS_DELIVERY_SHARED_MAX_AGE,
      ).toBe(read);
    }
    for (const bad of ['-1', '86401', '1.5', 'five']) {
      expect(() =>
        validateEnv({ ...base, CCMS_DELIVERY_SHARED_MAX_AGE: bad }),
      ).toThrow(/CCMS_DELIVERY_SHARED_MAX_AGE/);
    }
  });
});

describe('CCMS_DOCS_URL', () => {
  it('is the public docs site by default, an http or https URL ending in a slash, or off', () => {
    expect(validateEnv(base).CCMS_DOCS_URL).toBe('https://docs.openfolia.com/');
    expect(validateEnv({ ...base, CCMS_DOCS_URL: ' ' }).CCMS_DOCS_URL).toBe(
      'https://docs.openfolia.com/',
    );
    expect(
      validateEnv({ ...base, CCMS_DOCS_URL: ' https://Docs.example.org/help ' })
        .CCMS_DOCS_URL,
    ).toBe('https://docs.example.org/help/');
    expect(validateEnv({ ...base, CCMS_DOCS_URL: 'OFF' }).CCMS_DOCS_URL).toBe(
      null,
    );
  });

  it('refuses another scheme (the editor links to it), credentials and non-URLs', () => {
    for (const bad of [
      'javascript:alert(1)',
      'ftp://docs.example.org',
      'https://user:secret@docs.example.org',
      'docs.example.org',
      'none',
    ]) {
      expect(() => validateEnv({ ...base, CCMS_DOCS_URL: bad })).toThrow(
        /CCMS_DOCS_URL/,
      );
    }
  });
});

describe('search and the embedder (#54)', () => {
  const url = 'https://embeddings.example/v1/embeddings';
  const on = {
    ...base,
    CCMS_EMBEDDER_URL: url,
    CCMS_EMBEDDER_MODEL: 'some-model',
    CCMS_EMBEDDER_DIMENSIONS: '384',
  };

  it('is the Postgres search without an embedder by default, and memory on request', () => {
    const settings = validateEnv(base);
    expect(settings.CCMS_SEARCH_ADAPTER).toBe('postgres');
    expect(settings).not.toHaveProperty('CCMS_EMBEDDER_URL');
    expect(
      validateEnv({ ...base, CCMS_SEARCH_ADAPTER: 'memory' })
        .CCMS_SEARCH_ADAPTER,
    ).toBe('memory');
    expect(() =>
      validateEnv({ ...base, CCMS_SEARCH_ADAPTER: 'elastic' }),
    ).toThrow(/CCMS_SEARCH_ADAPTER/);
  });

  it('takes the time budget, the per-reader rate and the concurrency of a search, within their ranges (#539)', () => {
    expect(
      validateEnv({
        ...base,
        CCMS_SEARCH_TIMEOUT_MS: '250',
        CCMS_SEARCH_PER_MINUTE: '30',
        CCMS_SEARCH_CONCURRENCY: '2',
      }),
    ).toMatchObject({
      CCMS_SEARCH_TIMEOUT_MS: 250,
      CCMS_SEARCH_PER_MINUTE: 30,
      CCMS_SEARCH_CONCURRENCY: 2,
    });
    for (const [name, value] of [
      ['CCMS_SEARCH_TIMEOUT_MS', '99'],
      ['CCMS_SEARCH_TIMEOUT_MS', '60001'],
      ['CCMS_SEARCH_PER_MINUTE', '0'],
      ['CCMS_SEARCH_PER_MINUTE', '6001'],
      ['CCMS_SEARCH_CONCURRENCY', '0'],
      ['CCMS_SEARCH_CONCURRENCY', '101'],
    ] as const) {
      expect(() => validateEnv({ ...base, [name]: value })).toThrow(
        new RegExp(name),
      );
    }
  });

  it("takes the sweep's grace periods in days, within their range (#540)", () => {
    expect(
      validateEnv({
        ...base,
        CCMS_SEARCH_SWEEP_AFTER_DAYS: '2',
        CCMS_SEARCH_MODEL_KEPT_DAYS: '30',
      }),
    ).toMatchObject({
      CCMS_SEARCH_SWEEP_AFTER_DAYS: 2,
      CCMS_SEARCH_MODEL_KEPT_DAYS: 30,
    });
    for (const name of [
      'CCMS_SEARCH_SWEEP_AFTER_DAYS',
      'CCMS_SEARCH_MODEL_KEPT_DAYS',
    ]) {
      for (const value of ['0', '366', '1.5']) {
        expect(() => validateEnv({ ...base, [name]: value })).toThrow(
          new RegExp(name),
        );
      }
    }
  });

  it('takes an embedder with its model and dimensions, on the Postgres search only', () => {
    expect(
      validateEnv({ ...on, CCMS_EMBEDDER_MIN_SIMILARITY: '70' }),
    ).toMatchObject({
      CCMS_EMBEDDER_URL: url,
      CCMS_EMBEDDER_DIMENSIONS: 384,
      CCMS_EMBEDDER_MIN_SIMILARITY: 70,
    });
    expect(() => validateEnv({ ...on, CCMS_EMBEDDER_DIMENSIONS: '' })).toThrow(
      /CCMS_EMBEDDER_DIMENSIONS/,
    );
    expect(() => validateEnv({ ...on, CCMS_EMBEDDER_MODEL: '' })).toThrow(
      /CCMS_EMBEDDER_MODEL/,
    );
    expect(() => validateEnv({ ...base, CCMS_EMBEDDER_MODEL: 'm' })).toThrow(
      /CCMS_EMBEDDER_URL/,
    );
    expect(() => validateEnv({ ...on, CCMS_SEARCH_ADAPTER: 'memory' })).toThrow(
      /CCMS_SEARCH_ADAPTER=postgres/,
    );
    expect(() =>
      validateEnv({ ...on, CCMS_EMBEDDER_DIMENSIONS: '2001' }),
    ).toThrow(/CCMS_EMBEDDER_DIMENSIONS/);
  });

  it('sends a key only over https or to this machine, and never repeats it', () => {
    let message = '';
    try {
      validateEnv({
        ...on,
        CCMS_EMBEDDER_URL: 'http://embeddings.example/v1',
        CCMS_EMBEDDER_API_KEY: 'hunter2-key',
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/CCMS_EMBEDDER_URL/);
    expect(message).not.toContain('hunter2');
    expect(() =>
      validateEnv({
        ...on,
        CCMS_EMBEDDER_URL: 'http://127.0.0.1:8080/v1/embeddings',
        CCMS_EMBEDDER_API_KEY: 'hunter2-key',
      }),
    ).not.toThrow();
    expect(() =>
      validateEnv({
        ...on,
        CCMS_EMBEDDER_URL: 'https://user:pw@embeddings.example/v1',
      }),
    ).toThrow(/CCMS_EMBEDDER_URL/);
  });
});

describe('sign-in settings (#37)', () => {
  // Without the shared token: it cannot be set with sign-in.
  const { CCMS_API_TOKEN: _token, ...tokenless } = base;
  const oidc = {
    ...tokenless,
    CCMS_OIDC_ISSUER: 'https://idp.example.org',
    CCMS_OIDC_CLIENT_ID: 'docs',
    CCMS_OIDC_REDIRECT_URL: 'https://docs.example.org/api/auth/oidc/callback',
  };

  it('refuses demo mode with sign-in', () => {
    expect(() => validateEnv({ ...oidc, CCMS_AUTH_MODE: 'demo' })).toThrow(
      /cannot be on together[\s\S]*CCMS_OIDC_ISSUER/,
    );
  });

  it('needs the client ID and the redirect URL with an issuer, and an issuer with them', () => {
    expect(() => validateEnv({ ...oidc, CCMS_OIDC_CLIENT_ID: '' })).toThrow(
      /required with CCMS_OIDC_ISSUER[\s\S]*CCMS_OIDC_CLIENT_ID/,
    );
    expect(() => validateEnv({ ...base, CCMS_OIDC_CLIENT_ID: 'docs' })).toThrow(
      /needs CCMS_OIDC_ISSUER/,
    );
  });

  it('keeps the redirect URL on the editor’s origin', () => {
    expect(() =>
      validateEnv({ ...oidc, CCMS_EDITOR_URL: 'https://other.example.org' }),
    ).toThrow(/CCMS_OIDC_REDIRECT_URL/);
    expect(
      validateEnv({
        ...oidc,
        CCMS_EDITOR_URL: 'https://docs.example.org/editor',
      }),
    ).toMatchObject({ CCMS_EDITOR_URL: 'https://docs.example.org/editor/' });
  });

  it('takes https, and http only on a loopback host', () => {
    expect(() =>
      validateEnv({ ...oidc, CCMS_OIDC_ISSUER: 'http://idp.example.org' }),
    ).toThrow(/CCMS_OIDC_ISSUER/);
    expect(
      validateEnv({
        ...oidc,
        CCMS_OIDC_ISSUER: 'http://127.0.0.1:9000',
        CCMS_OIDC_REDIRECT_URL: 'http://localhost:4200/api/auth/oidc/callback',
      }),
    ).toMatchObject({ CCMS_OIDC_ISSUER: 'http://127.0.0.1:9000' });
  });

  it('links by email to users who never signed in, unless set otherwise', () => {
    expect(validateEnv(oidc).CCMS_OIDC_LINK_BY_EMAIL).toBe('pending');
    expect(
      validateEnv({ ...oidc, CCMS_OIDC_LINK_BY_EMAIL: ' Any ' })
        .CCMS_OIDC_LINK_BY_EMAIL,
    ).toBe('any');
    expect(() =>
      validateEnv({ ...oidc, CCMS_OIDC_LINK_BY_EMAIL: 'always' }),
    ).toThrow(/pending, off or any[\s\S]*CCMS_OIDC_LINK_BY_EMAIL/);
  });

  it('refuses the shared token with sign-in, but for a local provider', () => {
    expect(() =>
      validateEnv({ ...oidc, CCMS_API_TOKEN: 'x'.repeat(32) }),
    ).toThrow(/cannot be set with sign-in[\s\S]*CCMS_API_TOKEN/);
    expect(
      validateEnv({
        ...oidc,
        CCMS_API_TOKEN: 'x'.repeat(32),
        CCMS_OIDC_ISSUER: 'http://127.0.0.1:9000',
      }),
    ).toMatchObject({ CCMS_OIDC_ISSUER: 'http://127.0.0.1:9000' });
  });

  it('needs openid among the scopes', () => {
    expect(() =>
      validateEnv({ ...oidc, CCMS_OIDC_SCOPES: 'profile email' }),
    ).toThrow(/openid[\s\S]*CCMS_OIDC_SCOPES/);
  });
});

describe('CCMS_TRUST_PROXY and CCMS_DELIVERY_PER_MINUTE (#574)', () => {
  const trust = (value: string) =>
    validateEnv({ ...base, CCMS_TRUST_PROXY: value }).CCMS_TRUST_PROXY;

  it('trusts no proxy and allows 60 a minute by default', () => {
    const env = validateEnv(base);
    expect(env.CCMS_TRUST_PROXY).toBe(false);
    expect(env.CCMS_DELIVERY_PER_MINUTE).toBe(60);
    expect(trust(' ')).toBe(false);
    expect(trust('none')).toBe(false);
    expect(trust('None')).toBe(false);
  });

  it('takes a hop count, or addresses, subnets and named ranges', () => {
    expect(trust('1')).toBe(1);
    expect(trust('10')).toBe(10);
    expect(
      trust(' 172.16.0.0/12 , ::1,fd00::/16,10.0.0.2 ,::ffff:10.0.0.3'),
    ).toEqual([
      '172.16.0.0/12',
      '::1',
      'fd00::/16',
      '10.0.0.2',
      '::ffff:10.0.0.3',
    ]);
    expect(trust('loopback,uniquelocal,linklocal')).toEqual([
      'loopback',
      'uniquelocal',
      'linklocal',
    ]);
  });

  it('refuses trusting every hop, and anything that is no address', () => {
    for (const bad of [
      'true',
      'false',
      '0',
      '11',
      '-1',
      '*',
      ',',
      'proxy.example.com',
      '10.0.0.0/33',
      '0.0.0.0/0',
      '10.0.0.0/7',
      '::/0',
      '2001::/15',
      '::ffff:10.0.0.1/104',
      '::ffff:0:0/96',
      '::ffff:a00:0/104',
      '::/129',
      '10.0.0.0/8/1',
      '10.0.0.0/x',
      '300.0.0.1',
      'loopback,private',
    ]) {
      expect(() => trust(bad)).toThrow(/CCMS_TRUST_PROXY/);
    }
  });

  it('takes a limit from 0 (none) to 6,000', () => {
    for (const [value, expected] of [
      ['0', 0],
      ['1', 1],
      ['6000', 6_000],
    ] as const) {
      expect(
        validateEnv({ ...base, CCMS_DELIVERY_PER_MINUTE: value })
          .CCMS_DELIVERY_PER_MINUTE,
      ).toBe(expected);
    }
    for (const bad of ['6001', '-1', '1.5', 'many']) {
      expect(() =>
        validateEnv({ ...base, CCMS_DELIVERY_PER_MINUTE: bad }),
      ).toThrow(/CCMS_DELIVERY_PER_MINUTE/);
    }
  });
});

describe('package sends (#654)', () => {
  it('defaults to a minute idle, half an hour in all, 16 KiB a second and one send per reader', () => {
    expect(packageSendSettings(validateEnv(base))).toEqual({
      idleTimeoutMs: 60_000,
      sendTimeoutMs: 1_800_000,
      minBytesPerSecond: 16_384,
      perActor: 1,
    });
  });

  it('reads the CCMS_PACKAGE_SEND_* settings', () => {
    expect(
      packageSendSettings(
        validateEnv({
          ...base,
          CCMS_PACKAGE_SEND_IDLE_TIMEOUT_MS: '5000',
          CCMS_PACKAGE_SEND_TIMEOUT_MS: '60000',
          CCMS_PACKAGE_SEND_MIN_BYTES_PER_SECOND: '1024',
          CCMS_PACKAGE_SENDS_PER_ACTOR: '2',
        }),
      ),
    ).toEqual({
      idleTimeoutMs: 5_000,
      sendTimeoutMs: 60_000,
      minBytesPerSecond: 1_024,
      perActor: 2,
    });
  });

  it('still reads the CCMS_DITA_SEND_* names, their old ones, when the new ones are unset', () => {
    expect(
      packageSendSettings(
        validateEnv({
          ...base,
          CCMS_DITA_SEND_IDLE_TIMEOUT_MS: '5000',
          CCMS_DITA_SEND_TIMEOUT_MS: '60000',
          CCMS_DITA_SEND_MIN_BYTES_PER_SECOND: '1024',
          CCMS_DITA_SENDS_PER_ACTOR: '2',
        }),
      ),
    ).toEqual({
      idleTimeoutMs: 5_000,
      sendTimeoutMs: 60_000,
      minBytesPerSecond: 1_024,
      perActor: 2,
    });
  });

  it('takes an old name beside the new one only with the same value', () => {
    expect(
      packageSendSettings(
        validateEnv({
          ...base,
          CCMS_PACKAGE_SEND_IDLE_TIMEOUT_MS: '5000',
          CCMS_DITA_SEND_IDLE_TIMEOUT_MS: '5000',
        }),
      ).idleTimeoutMs,
    ).toBe(5_000);
    expect(() =>
      validateEnv({
        ...base,
        CCMS_PACKAGE_SENDS_PER_ACTOR: '1',
        CCMS_DITA_SENDS_PER_ACTOR: '2',
      }),
    ).toThrow(/CCMS_DITA_SENDS_PER_ACTOR/);
  });

  it('keeps a turn back from any one reader, and refuses values out of range', () => {
    for (const name of [
      'CCMS_PACKAGE_SENDS_PER_ACTOR',
      'CCMS_DITA_SENDS_PER_ACTOR',
    ]) {
      expect(() => validateEnv({ ...base, [name]: '0' })).toThrow(name);
      expect(() => validateEnv({ ...base, [name]: '4' })).toThrow(name);
    }
    expect(() =>
      validateEnv({ ...base, CCMS_PACKAGE_SEND_IDLE_TIMEOUT_MS: '999' }),
    ).toThrow('CCMS_PACKAGE_SEND_IDLE_TIMEOUT_MS');
    expect(() =>
      validateEnv({ ...base, CCMS_PACKAGE_SEND_MIN_BYTES_PER_SECOND: '0' }),
    ).toThrow('CCMS_PACKAGE_SEND_MIN_BYTES_PER_SECOND');
  });
});
