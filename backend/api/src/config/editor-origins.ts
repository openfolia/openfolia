import { z } from 'zod';

/**
 * A comma-separated list of origins (`https://editor.example.com`,
 * `http://localhost:4200`): scheme, host and optional port, nothing else.
 * The list goes into a `Content-Security-Policy` header, so each entry must
 * be exactly what the URL parser reads as its own origin: no path, no
 * wildcard, no credentials, nothing that could add another directive.
 */
export const editorOrigins = z
  .string()
  .trim()
  .transform((value, ctx): string[] => {
    const origins: string[] = [];
    for (const raw of value.split(',').map((part) => part.trim())) {
      const origin = URL.canParse(raw) ? new URL(raw).origin : undefined;
      if (
        origin === undefined ||
        !/^https?:\/\/([a-z0-9.-]+|\[[0-9a-f:.]+\])(:\d{1,5})?\/?$/i.test(
          raw,
        ) ||
        origin !== raw.replace(/\/$/, '').toLowerCase()
      ) {
        ctx.addIssue({
          code: 'custom',
          message: `"${raw}" must be an origin such as https://editor.example.com (scheme, host and port only)`,
        });
        return z.NEVER;
      }
      if (!origins.includes(origin)) origins.push(origin);
    }
    return origins;
  });
