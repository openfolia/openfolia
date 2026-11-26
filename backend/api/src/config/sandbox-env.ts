import { z } from 'zod';
import { MAX_WORKING_COPY_BYTES } from '../change-sets/core/working-copy.js';
import type {
  SandboxLimits,
  SandboxLifetime,
} from '../sandbox/core/sandbox.js';
import { field, wholeNumber } from './fields.js';

/** `CCMS_SANDBOX_*` defaults (#826), sized for one visitor's session of a demo. */
export const SANDBOX_DEFAULTS = {
  CCMS_SANDBOX_IDLE_MINUTES: 30,
  CCMS_SANDBOX_MAX_MINUTES: 90,
  CCMS_SANDBOX_MAX_MODULE_BYTES: 128 * 1024,
  CCMS_SANDBOX_MAX_COMMENT_LENGTH: 2_000,
  CCMS_SANDBOX_MAX_CHANGE_SETS: 20,
  CCMS_SANDBOX_MAX_MODULES: 50,
  CCMS_SANDBOX_MAX_MANUALS: 10,
  CCMS_SANDBOX_RELEASES_PER_HOUR: 4,
  CCMS_SANDBOX_RENDER_JOBS: 1,
  CCMS_SANDBOX_MAX_WRITE_BYTES: 64 * 1024 * 1024,
} as const;

const setting = (name: keyof typeof SANDBOX_DEFAULTS, max: number) =>
  field(wholeNumber(1, max).default(SANDBOX_DEFAULTS[name]));

/**
 * The public sandbox (#826): `CCMS_PUBLIC_SANDBOX=on` turns on a mode a stranger may use without
 * harm to anyone else (`src/sandbox/`), and the `CCMS_SANDBOX_*` caps say how much one sandbox
 * may make. Part of `Env`; `checkSandboxEnv` refuses every setting that would let something
 * leave the instance or reach other people.
 */
export const SandboxEnv = z.object({
  /** `on`: the public sandbox; `off` (default): a normal instance. Only with `CCMS_AUTH_MODE=demo`. */
  CCMS_PUBLIC_SANDBOX: field(
    z
      .string()
      .trim()
      .toLowerCase()
      .pipe(z.enum(['on', 'off'], 'must be on or off'))
      .default('off'),
  ),
  /** A sandbox ends this many minutes after the last request that did something (default 30). */
  CCMS_SANDBOX_IDLE_MINUTES: setting('CCMS_SANDBOX_IDLE_MINUTES', 1_440),
  /** A sandbox ends this many minutes after it started, however busy (default 90). */
  CCMS_SANDBOX_MAX_MINUTES: setting('CCMS_SANDBOX_MAX_MINUTES', 1_440),
  /** The largest module (or other working copy), in bytes of its JSON (default 131072: 128 KiB). */
  CCMS_SANDBOX_MAX_MODULE_BYTES: setting(
    'CCMS_SANDBOX_MAX_MODULE_BYTES',
    MAX_WORKING_COPY_BYTES,
  ),
  /** The longest comment, in characters (default 2,000). */
  CCMS_SANDBOX_MAX_COMMENT_LENGTH: setting(
    'CCMS_SANDBOX_MAX_COMMENT_LENGTH',
    100_000,
  ),
  /** The most revisions (change sets) one sandbox makes (default 20). */
  CCMS_SANDBOX_MAX_CHANGE_SETS: setting('CCMS_SANDBOX_MAX_CHANGE_SETS', 10_000),
  /** The most modules one sandbox makes (default 50). */
  CCMS_SANDBOX_MAX_MODULES: setting('CCMS_SANDBOX_MAX_MODULES', 100_000),
  /** The most manuals one sandbox makes (default 10). */
  CCMS_SANDBOX_MAX_MANUALS: setting('CCMS_SANDBOX_MAX_MANUALS', 10_000),
  /** The most releases one sandbox cuts in any hour (default 4). */
  CCMS_SANDBOX_RELEASES_PER_HOUR: setting(
    'CCMS_SANDBOX_RELEASES_PER_HOUR',
    1_000,
  ),
  /** The most PDFs one sandbox renders at once: its PDF workers (default 1). */
  CCMS_SANDBOX_RENDER_JOBS: setting('CCMS_SANDBOX_RENDER_JOBS', 64),
  /**
   * The most bytes one sandbox writes over its session: every working copy saved, every
   * comment, every commit and every file stored (default 67108864: 64 MiB). It bounds what
   * reaches the database, Git and the disk.
   */
  CCMS_SANDBOX_MAX_WRITE_BYTES: setting(
    'CCMS_SANDBOX_MAX_WRITE_BYTES',
    4 * 1024 * 1024 * 1024,
  ),
  /**
   * The shared read-only portal's address, which the editor's banner links (#837): an https://
   * URL without credentials. A link only: the API never calls it. Unset: no link.
   */
  CCMS_SANDBOX_PORTAL_URL: field(
    z
      .string()
      .trim()
      .refine((value) => {
        try {
          const url = new URL(value);
          return url.protocol === 'https:' && !url.username && !url.password;
        } catch {
          return false;
        }
      }, 'must be an https:// URL without credentials')
      .transform((value) => new URL(value).href)
      .optional(),
  ),
  /**
   * Where the editor's banner ends the sandbox ("End demo", #846): a path on the editor's own
   * origin (`/_demo/api/end`, the launcher's route) or an https:// URL without credentials. The
   * editor posts to it and follows the answer's `next`. Unset: no "End demo".
   */
  CCMS_SANDBOX_END_URL: field(
    z
      .string()
      .trim()
      .refine((value) => {
        if (value.startsWith('/')) return /^\/(?![/\\])[^\s\\]*$/.test(value);
        try {
          const url = new URL(value);
          return url.protocol === 'https:' && !url.username && !url.password;
        } catch {
          return false;
        }
      }, 'must be a path on the editor’s origin (/…) or an https:// URL without credentials')
      .transform((value) =>
        value.startsWith('/') ? value : new URL(value).href,
      )
      .optional(),
  ),
});
export type SandboxSettings = z.infer<typeof SandboxEnv>;

/** Why a setting cannot be on in a sandbox, for the start-up message. */
const LEAVES = 'something would leave the instance';
const REACHES = 'it would reach other people';

/**
 * The settings a public sandbox refuses at start, each with why: whatever sends something out
 * (email, webhooks to private or plain-HTTP addresses, AI providers, embeddings, the audit sink,
 * S3 storage) or lets people in another way than the demo's (OpenID Connect, SAML, passwords, codes by
 * email, a first admin). Unset (or `off`/`false`) they are fine.
 */
export const SANDBOX_REFUSED_SETTINGS = [
  'CCMS_OIDC_ISSUER',
  'CCMS_OIDC_CLIENT_ID',
  'CCMS_OIDC_CLIENT_SECRET',
  'CCMS_OIDC_REDIRECT_URL',
  'CCMS_SAML_IDP_METADATA_URL',
  'CCMS_SAML_IDP_METADATA_FILE',
  'CCMS_PASSWORD_SIGN_IN',
  'CCMS_EMAIL_CODE_SIGN_IN',
  'CCMS_FIRST_ADMIN_EMAIL',
  'CCMS_MAIL_URL',
  'CCMS_MAIL_USER',
  'CCMS_MAIL_PASSWORD',
  'CCMS_MAIL_PASSWORD_FILE',
  'CCMS_MAIL_FROM',
  'CCMS_MAIL_CA_FILE',
  'CCMS_WEBHOOKS_ALLOW_HTTP',
  'CCMS_WEBHOOKS_ALLOW_PRIVATE',
  'CCMS_STYLE_REVIEW_URL',
  'CCMS_STYLE_REVIEW_API_KEY',
  'CCMS_STYLE_REVIEW_MODEL',
  'CCMS_EMBEDDER_URL',
  'CCMS_EMBEDDER_API_KEY',
  'CCMS_EMBEDDER_MODEL',
  'CCMS_EMBEDDER_DIMENSIONS',
  'CCMS_AUDIT_SINK_URL',
  'CCMS_AUDIT_SINK_SECRET',
  'CCMS_AUDIT_SINK_CA_FILE',
  'CCMS_BLOB_DRIVER',
  'CCMS_S3_ENDPOINT',
  'CCMS_S3_BUCKET',
  'CCMS_S3_ACCESS_KEY_ID',
  'CCMS_S3_SECRET_ACCESS_KEY',
] as const;
export type SandboxRefusedSetting = (typeof SANDBOX_REFUSED_SETTINGS)[number];

/** Why each is refused; a value that is harmless (`off`, `false`, `fs`) is not refused. */
const REFUSED: Record<
  SandboxRefusedSetting,
  { readonly why: string; readonly harmless?: unknown }
> = {
  CCMS_OIDC_ISSUER: { why: REACHES },
  CCMS_OIDC_CLIENT_ID: { why: REACHES },
  CCMS_OIDC_CLIENT_SECRET: { why: REACHES },
  CCMS_OIDC_REDIRECT_URL: { why: REACHES },
  CCMS_SAML_IDP_METADATA_URL: { why: REACHES },
  CCMS_SAML_IDP_METADATA_FILE: { why: REACHES },
  CCMS_PASSWORD_SIGN_IN: { why: REACHES, harmless: 'off' },
  CCMS_EMAIL_CODE_SIGN_IN: { why: LEAVES, harmless: 'off' },
  CCMS_FIRST_ADMIN_EMAIL: { why: REACHES },
  CCMS_MAIL_URL: { why: LEAVES },
  CCMS_MAIL_USER: { why: LEAVES },
  CCMS_MAIL_PASSWORD: { why: LEAVES },
  CCMS_MAIL_PASSWORD_FILE: { why: LEAVES },
  CCMS_MAIL_FROM: { why: LEAVES },
  CCMS_MAIL_CA_FILE: { why: LEAVES },
  CCMS_WEBHOOKS_ALLOW_HTTP: { why: LEAVES, harmless: false },
  CCMS_WEBHOOKS_ALLOW_PRIVATE: { why: LEAVES, harmless: false },
  CCMS_STYLE_REVIEW_URL: { why: LEAVES },
  CCMS_STYLE_REVIEW_API_KEY: { why: LEAVES },
  CCMS_STYLE_REVIEW_MODEL: { why: LEAVES },
  CCMS_EMBEDDER_URL: { why: LEAVES },
  CCMS_EMBEDDER_API_KEY: { why: LEAVES },
  CCMS_EMBEDDER_MODEL: { why: LEAVES },
  CCMS_EMBEDDER_DIMENSIONS: { why: LEAVES },
  CCMS_AUDIT_SINK_URL: { why: LEAVES },
  CCMS_AUDIT_SINK_SECRET: { why: LEAVES },
  CCMS_AUDIT_SINK_CA_FILE: { why: LEAVES },
  CCMS_BLOB_DRIVER: { why: LEAVES, harmless: 'fs' },
  CCMS_S3_ENDPOINT: { why: LEAVES },
  CCMS_S3_BUCKET: { why: LEAVES },
  CCMS_S3_ACCESS_KEY_ID: { why: LEAVES },
  CCMS_S3_SECRET_ACCESS_KEY: { why: LEAVES },
};

/**
 * The checks of a public sandbox, for `Env.superRefine`: only in demo mode (the demo's people,
 * switched with the demo sign-in), and none of `SANDBOX_REFUSED_SETTINGS` set, each named.
 */
export function checkSandboxEnv(
  env: SandboxSettings & {
    readonly CCMS_AUTH_MODE: string;
    readonly CCMS_ROLE?: string;
  } & Partial<Record<SandboxRefusedSetting, unknown>>,
  ctx: z.RefinementCtx,
): void {
  if (env.CCMS_PUBLIC_SANDBOX !== 'on') return;
  if (env.CCMS_AUTH_MODE !== 'demo') {
    ctx.addIssue({
      code: 'custom',
      path: ['CCMS_PUBLIC_SANDBOX'],
      message:
        'is allowed only with CCMS_AUTH_MODE=demo: a public sandbox has the demo’s people only.',
    });
  }
  if (env.CCMS_ROLE !== undefined && env.CCMS_ROLE !== 'all') {
    ctx.addIssue({
      code: 'custom',
      path: ['CCMS_ROLE'],
      message:
        'must be all in a public sandbox (CCMS_PUBLIC_SANDBOX=on): its caps and its clock are one process’s.',
    });
  }
  for (const name of SANDBOX_REFUSED_SETTINGS) {
    const value = env[name];
    const { why, harmless } = REFUSED[name];
    if (value === undefined || value === harmless) continue;
    ctx.addIssue({
      code: 'custom',
      path: [name],
      message: `cannot be set in a public sandbox (CCMS_PUBLIC_SANDBOX=on): ${why}. Unset it.`,
    });
  }
}

/** The sandbox's caps, from the settings. */
export function sandboxLimitsOf(env: SandboxSettings): SandboxLimits {
  return {
    moduleBytes: env.CCMS_SANDBOX_MAX_MODULE_BYTES,
    commentLength: env.CCMS_SANDBOX_MAX_COMMENT_LENGTH,
    changeSets: env.CCMS_SANDBOX_MAX_CHANGE_SETS,
    modules: env.CCMS_SANDBOX_MAX_MODULES,
    manuals: env.CCMS_SANDBOX_MAX_MANUALS,
    releasesPerHour: env.CCMS_SANDBOX_RELEASES_PER_HOUR,
    renderJobs: env.CCMS_SANDBOX_RENDER_JOBS,
    writeBytes: env.CCMS_SANDBOX_MAX_WRITE_BYTES,
  };
}

/** The reader portal's address the banner links, from the settings; none when unset. */
export function sandboxPortalUrlOf(env: SandboxSettings): string | undefined {
  return env.CCMS_SANDBOX_PORTAL_URL;
}

/** Where the banner ends the sandbox, from the settings; none when unset. */
export function sandboxEndUrlOf(env: SandboxSettings): string | undefined {
  return env.CCMS_SANDBOX_END_URL;
}

/** The sandbox's lifetime, from the settings. */
export function sandboxLifetimeOf(env: SandboxSettings): SandboxLifetime {
  return {
    idleMinutes: env.CCMS_SANDBOX_IDLE_MINUTES,
    maxMinutes: env.CCMS_SANDBOX_MAX_MINUTES,
  };
}
