import { z } from 'zod';
import { proxyEntryProblem } from './proxies.js';

/** The most hops `CCMS_MCP_HTTP_TRUST_PROXY` may name. */
export const MAX_TRUST_PROXY_HOPS = 10;

/** The start-up refusal of the shared token removed in v0.0.5 (#922), naming no value. */
export const REMOVED_SHARED_TOKEN =
  'CCMS_MCP_HTTP_TOKEN (or CCMS_MCP_HTTP_TOKEN_FILE) is removed (v0.0.5, #922): the MCP server no longer takes one token for every caller. Unset it and give each caller a service account token of its own: see /guides/mcp on the docs site.';

const ApiUrl = z
  .url({
    protocol: /^https?$/,
    error: 'an http(s) URL, e.g. http://127.0.0.1:3000',
  })
  .describe('The content API’s base URL.');
const ApiToken = z
  .string({ error: 'required: a service account token (`ccms_sat_…`)' })
  .min(1, 'required: a service account token (`ccms_sat_…`)');

const Common = z.object({
  CCMS_MCP_API_URL: ApiUrl,
  CCMS_MCP_API_TOKEN: ApiToken,
});

// Over HTTP, callers bring their own service account tokens (#861); the server has none of its own.
const Http = z
  .object({
    CCMS_MCP_API_URL: ApiUrl,
    CCMS_MCP_API_TOKEN: ApiToken.optional(),
    CCMS_MCP_HTTP_HOST: z.string().min(1).default('127.0.0.1'),
    CCMS_MCP_HTTP_PORT: z.coerce.number().int().min(0).max(65535).default(3200),
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
  })
  .superRefine((settings, ctx) => {
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
  if (
    set.CCMS_MCP_HTTP_TOKEN !== undefined ||
    set.CCMS_MCP_HTTP_TOKEN_FILE !== undefined
  )
    throw new Error(REMOVED_SHARED_TOKEN);
  const parsed = (transport === 'http' ? Http : Common).safeParse(set);
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    );
    throw new Error(`Invalid settings:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}
