import { z } from 'zod';
import { proxyEntryProblem } from './proxies.js';

/**
 * The least length of `CCMS_MCP_HTTP_TOKEN` and of different characters in
 * it, and no repeated pattern. These refuse the obvious non-random tokens
 * (`aaaa…`, a word repeated, `0123…0123`) but cannot tell a typed passphrase
 * from a random one: the token must come from a random generator
 * (`openssl rand -hex 32`, 256 bits), as the HTTP transport's lockout does
 * not slow guessing down and the token's entropy is the defence.
 */
export const MIN_HTTP_TOKEN_LENGTH = 32;
export const MIN_HTTP_TOKEN_DISTINCT = 12;

/** Whether `token` is a shorter string repeated (wholly or with a partial end). */
export function isPeriodic(token: string): boolean {
  for (let p = 1; p <= token.length / 2; p++) {
    let periodic = true;
    for (let i = p; i < token.length && periodic; i++) {
      periodic = token[i] === token[i - p];
    }
    if (periodic) return true;
  }
  return false;
}

/** The most hops `CCMS_MCP_HTTP_TRUST_PROXY` may name. */
export const MAX_TRUST_PROXY_HOPS = 10;

const Common = z.object({
  CCMS_MCP_API_URL: z
    .url({
      protocol: /^https?$/,
      error: 'an http(s) URL, e.g. http://127.0.0.1:3000',
    })
    .describe('The content API’s base URL.'),
  CCMS_MCP_API_TOKEN: z
    .string({ error: 'required: a service account token (`ccms_sat_…`)' })
    .min(1, 'required: a service account token (`ccms_sat_…`)'),
});

const Http = Common.extend({
  CCMS_MCP_HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  CCMS_MCP_HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(3200),
  CCMS_MCP_HTTP_TOKEN: z
    .string({ error: 'required for the HTTP transport' })
    .min(
      MIN_HTTP_TOKEN_LENGTH,
      `at least ${MIN_HTTP_TOKEN_LENGTH} characters (e.g. \`openssl rand -hex 32\`)`,
    )
    .refine(
      (token) => new Set(token).size >= MIN_HTTP_TOKEN_DISTINCT,
      `at least ${MIN_HTTP_TOKEN_DISTINCT} different characters: a random token (e.g. \`openssl rand -hex 32\`)`,
    )
    .refine(
      (token) => !isPeriodic(token),
      'no repeated pattern: a random token (e.g. `openssl rand -hex 32`)',
    ),
  CCMS_MCP_HTTP_ALLOWED_ORIGINS: z
    .string()
    .default('')
    .transform((v) =>
      v
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o !== ''),
    ),
  // `none` (the default): the client is the connection; a hop count believes that many proxies'
  // `X-Forwarded-For` (`clientAddress`), from the peers CCMS_MCP_HTTP_PROXY_ADDRESSES names only.
  CCMS_MCP_HTTP_TRUST_PROXY: z
    .string()
    .trim()
    .default('none')
    .transform((value, ctx) => {
      if (value.toLowerCase() === 'none') return 0;
      const hops = /^\d{1,2}$/.test(value) ? Number(value) : NaN;
      if (hops >= 1 && hops <= MAX_TRUST_PROXY_HOPS) return hops;
      ctx.addIssue({
        code: 'custom',
        message: `none, or a hop count from 1 to ${MAX_TRUST_PROXY_HOPS}`,
      });
      return z.NEVER;
    }),
  CCMS_MCP_HTTP_PROXY_ADDRESSES: z
    .string()
    .default('')
    .transform((value, ctx) => {
      const entries = value
        .split(',')
        .map((e) => e.trim())
        .filter((e) => e !== '');
      for (const entry of entries) {
        const problem = proxyEntryProblem(entry);
        if (problem) ctx.addIssue({ code: 'custom', message: problem });
      }
      return entries;
    }),
}).superRefine((settings, ctx) => {
  if (
    settings.CCMS_MCP_HTTP_TRUST_PROXY > 0 &&
    settings.CCMS_MCP_HTTP_PROXY_ADDRESSES.length === 0
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['CCMS_MCP_HTTP_PROXY_ADDRESSES'],
      message:
        'required with CCMS_MCP_HTTP_TRUST_PROXY: the addresses, subnets or host names of the proxies in front',
    });
  }
});

export type StdioSettings = z.infer<typeof Common>;
export type HttpSettings = z.infer<typeof Http>;

/** Settings from the environment (empty values count as unset), or an error naming each bad one, never its value. */
export function loadSettings(
  transport: 'stdio',
  env?: NodeJS.ProcessEnv,
): StdioSettings;
export function loadSettings(
  transport: 'http',
  env?: NodeJS.ProcessEnv,
): HttpSettings;
export function loadSettings(
  transport: 'stdio' | 'http',
  env: NodeJS.ProcessEnv = process.env,
): StdioSettings | HttpSettings {
  const set = Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) => name.startsWith('CCMS_MCP_') && value !== '',
    ),
  );
  const parsed = (transport === 'http' ? Http : Common).safeParse(set);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid settings:\n  ${problems.join('\n  ')}`);
  }
  if (
    transport === 'http' &&
    (parsed.data as HttpSettings).CCMS_MCP_HTTP_TOKEN ===
      parsed.data.CCMS_MCP_API_TOKEN
  ) {
    throw new Error(
      'Invalid settings:\n  CCMS_MCP_HTTP_TOKEN: must differ from CCMS_MCP_API_TOKEN',
    );
  }
  return parsed.data;
}
