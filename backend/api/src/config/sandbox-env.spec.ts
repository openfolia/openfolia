import { BackupEnv } from './backup-env.js';
import { validateEnv } from './env.js';
import {
  SANDBOX_REFUSED_SETTINGS,
  type SandboxRefusedSetting,
} from './sandbox-env.js';
import { StartupError } from './startup-error.js';

const base = {
  CCMS_CONTENT_DIR: '/srv/content',
  CCMS_API_TOKEN: 'x'.repeat(32),
  CCMS_DATABASE_URL: 'postgres://ccms:secret@db:5432/ccms',
  CCMS_BLOB_DRIVER: 'fs',
  CCMS_BLOB_FS_ROOT: '/srv/blobs',
};
const sandbox = { ...base, CCMS_AUTH_MODE: 'demo', CCMS_PUBLIC_SANDBOX: 'on' };

/** A value each refused setting would take on a normal instance. */
const VALUES: Record<SandboxRefusedSetting, string> = {
  CCMS_OIDC_ISSUER: 'https://id.example.com',
  CCMS_OIDC_CLIENT_ID: 'openfolia',
  CCMS_OIDC_CLIENT_SECRET: 'secret',
  CCMS_OIDC_REDIRECT_URL: 'https://editor.example.com/api/auth/oidc/callback',
  CCMS_SAML_IDP_METADATA_URL: 'https://id.example.com/saml/metadata',
  CCMS_SAML_IDP_METADATA_FILE: '/run/secrets/idp-metadata.xml',
  CCMS_PASSWORD_SIGN_IN: 'on',
  CCMS_EMAIL_CODE_SIGN_IN: 'on',
  CCMS_FIRST_ADMIN_EMAIL: 'admin@example.com',
  CCMS_MAIL_URL: 'smtp://mail.example.com',
  CCMS_MAIL_USER: 'docs',
  CCMS_MAIL_PASSWORD: 'secret',
  CCMS_MAIL_PASSWORD_FILE: '/run/secrets/mail',
  CCMS_MAIL_FROM: 'docs@example.com',
  CCMS_MAIL_CA_FILE: '/etc/ca.pem',
  CCMS_WEBHOOKS_ALLOW_HTTP: 'true',
  CCMS_WEBHOOKS_ALLOW_PRIVATE: 'true',
  CCMS_STYLE_REVIEW_URL: 'https://model.example.com/v1/chat/completions',
  CCMS_STYLE_REVIEW_API_KEY: 'key',
  CCMS_STYLE_REVIEW_MODEL: 'model',
  CCMS_EMBEDDER_URL: 'https://model.example.com/v1/embeddings',
  CCMS_EMBEDDER_API_KEY: 'key',
  CCMS_EMBEDDER_MODEL: 'model',
  CCMS_EMBEDDER_DIMENSIONS: '384',
  CCMS_AUDIT_SINK_URL: 'syslog+tls://logs.example.com',
  CCMS_AUDIT_SINK_SECRET: `whsec_${'a'.repeat(64)}`,
  CCMS_AUDIT_SINK_CA_FILE: '/etc/ca.pem',
  CCMS_BLOB_DRIVER: 's3',
  CCMS_S3_ENDPOINT: 'https://s3.example.com',
  CCMS_S3_BUCKET: 'openfolia',
  CCMS_S3_ACCESS_KEY_ID: 'id',
  CCMS_S3_SECRET_ACCESS_KEY: 'secret',
};

const problems = (env: Record<string, string>): string => {
  try {
    validateEnv(env);
  } catch (error) {
    if (error instanceof StartupError) return error.message;
    throw error;
  }
  return '';
};

describe('the public sandbox’s settings (#826)', () => {
  it('starts in demo mode with none of the refused settings, defaults sized for a demo', () => {
    const env = validateEnv(sandbox);
    expect(env).toMatchObject({
      CCMS_PUBLIC_SANDBOX: 'on',
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
    });
  });

  it('takes an https portal address for the banner, and refuses any other (#837)', () => {
    expect(validateEnv(sandbox).CCMS_SANDBOX_PORTAL_URL).toBeUndefined();
    expect(
      validateEnv({ ...sandbox, CCMS_SANDBOX_PORTAL_URL: ' ' })
        .CCMS_SANDBOX_PORTAL_URL,
    ).toBeUndefined();
    expect(
      validateEnv({
        ...sandbox,
        CCMS_SANDBOX_PORTAL_URL: 'https://manuals.example.org',
      }).CCMS_SANDBOX_PORTAL_URL,
    ).toBe('https://manuals.example.org/');
    for (const value of [
      'http://manuals.example.org/',
      'javascript:alert(1)',
      'manuals.example.org',
      'https://user:pass@manuals.example.org/',
    ]) {
      expect(problems({ ...sandbox, CCMS_SANDBOX_PORTAL_URL: value })).toMatch(
        /must be an https:\/\/ URL without credentials\n\s*→ at CCMS_SANDBOX_PORTAL_URL/,
      );
    }
  });

  it('takes a same-origin path or an https address to end the sandbox at, and refuses any other (#846)', () => {
    expect(validateEnv(sandbox).CCMS_SANDBOX_END_URL).toBeUndefined();
    expect(
      validateEnv({ ...sandbox, CCMS_SANDBOX_END_URL: ' /_demo/api/end ' })
        .CCMS_SANDBOX_END_URL,
    ).toBe('/_demo/api/end');
    expect(
      validateEnv({
        ...sandbox,
        CCMS_SANDBOX_END_URL: 'https://demo.example.org/_demo/api/end',
      }).CCMS_SANDBOX_END_URL,
    ).toBe('https://demo.example.org/_demo/api/end');
    for (const value of [
      '//evil.example/end',
      '/\\evil.example/end',
      '/a b',
      'http://demo.example.org/_demo/api/end',
      'javascript:alert(1)',
      'end',
      'https://user:pass@demo.example.org/end',
    ]) {
      expect(
        problems({ ...sandbox, CCMS_SANDBOX_END_URL: value }),
        value,
      ).toMatch(/→ at CCMS_SANDBOX_END_URL/);
    }
  });

  it('is off by default, and takes only on or off', () => {
    expect(validateEnv(base).CCMS_PUBLIC_SANDBOX).toBe('off');
    expect(problems({ ...sandbox, CCMS_PUBLIC_SANDBOX: 'yes' })).toMatch(
      /must be on or off\n\s*→ at CCMS_PUBLIC_SANDBOX/,
    );
  });

  it('refuses to start without demo mode, naming the setting', () => {
    expect(problems({ ...sandbox, CCMS_AUTH_MODE: 'token' })).toMatch(
      /only with CCMS_AUTH_MODE=demo[^\n]*\n\s*→ at CCMS_PUBLIC_SANDBOX/,
    );
  });

  it('refuses to start as one role of several: its counts are one process’s', () => {
    expect(problems({ ...sandbox, CCMS_ROLE: 'api' })).toMatch(
      /must be all in a public sandbox[^\n]*\n\s*→ at CCMS_ROLE/,
    );
    expect(() => validateEnv({ ...sandbox, CCMS_ROLE: 'all' })).not.toThrow();
  });

  it.each(SANDBOX_REFUSED_SETTINGS)(
    'refuses to start with %s, naming it',
    (name) => {
      const message = problems({ ...sandbox, [name]: VALUES[name] });
      expect(message).toContain(name);
      expect(message).toMatch(
        new RegExp(
          `cannot be set in a public sandbox[^\\n]*\\n\\s*→ at ${name}(?:\\n|$)`,
        ),
      );
    },
  );

  it('lets the harmless values of a refused setting through', () => {
    expect(() =>
      validateEnv({
        ...sandbox,
        CCMS_PASSWORD_SIGN_IN: 'off',
        CCMS_EMAIL_CODE_SIGN_IN: 'off',
        CCMS_WEBHOOKS_ALLOW_HTTP: 'false',
        CCMS_WEBHOOKS_ALLOW_PRIVATE: 'false',
        CCMS_BLOB_DRIVER: 'fs',
        // Blank is unset.
        CCMS_MAIL_URL: ' ',
      }),
    ).not.toThrow();
  });

  it('runs at most CCMS_SANDBOX_RENDER_JOBS PDF workers and renders, and opens stable addresses only inside', () => {
    const env = validateEnv({
      ...sandbox,
      CCMS_PDF_WORKERS: '8',
      CCMS_RENDER_CONCURRENCY: '4',
      CCMS_SANDBOX_RENDER_JOBS: '2',
    });
    expect(env.CCMS_PDF_WORKERS).toBe(2);
    expect(env.CCMS_RENDER_CONCURRENCY).toBe(2);
    expect(env.CCMS_DELIVERY_MAX_ACCESS).toBe('signed-in');
    expect(env.CCMS_RELEASE_MAX_OUTPUTS).toBe(50);
    expect(
      validateEnv({ ...sandbox, CCMS_DELIVERY_MAX_ACCESS: 'off' })
        .CCMS_DELIVERY_MAX_ACCESS,
    ).toBe('off');
    // Off, nothing changes.
    const normal = validateEnv({ ...base, CCMS_PDF_WORKERS: '8' });
    expect(normal.CCMS_PDF_WORKERS).toBe(8);
    expect(normal.CCMS_DELIVERY_MAX_ACCESS).toBe('public');
    expect(normal.CCMS_RELEASE_MAX_OUTPUTS).toBe(20_000);
  });

  it('keeps the backup service from starting in a sandbox', () => {
    const backup = {
      CCMS_DATABASE_URL: base.CCMS_DATABASE_URL,
      CCMS_CONTENT_DIR: base.CCMS_CONTENT_DIR,
      CCMS_BLOB_FS_ROOT: base.CCMS_BLOB_FS_ROOT,
    };
    expect(BackupEnv.safeParse(backup).success).toBe(true);
    const refused = BackupEnv.safeParse({
      ...backup,
      CCMS_PUBLIC_SANDBOX: 'on',
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues).toContainEqual(
      expect.objectContaining({ path: ['CCMS_PUBLIC_SANDBOX'] }),
    );
  });
});
