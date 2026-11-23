import type { Request } from 'express';
import { z } from 'zod';
import type { PageRequest, Paginated } from '../core/paging.js';

/** The JSON:API media type, for requests with a body and every JSON response. */
export const JSON_API = 'application/vnd.api+json';

/**
 * The header a route that takes another body type (`@AcceptsBodyOf`, e.g. an
 * upload as `multipart/form-data`) needs on a request of that type
 * (`CrossSiteRequestGuard`). Any non-empty value: what counts is that a
 * cross-site form cannot send it.
 */
// Compatibility: keeps the working name from before the product was named OpenFolia (`X-Ccms-*`: the API's contract).
export const REQUEST_HEADER = 'X-Ccms-Request';

/**
 * A resource object schema: `{ type, id, attributes?, relationships?, meta? }`.
 * By convention `attributes` holds stored data (what a client could write
 * back) and `meta` what the server derives from it (issues, summaries).
 */
export function resourceObject<T extends string, S extends z.ZodRawShape>(
  type: T,
  members: S,
) {
  return z.object({ type: z.literal(type), id: z.string(), ...members });
}

/** `{ data: { type, id } }`, a to-one relationship. */
export function toOne<T extends string>(type: T) {
  return z.object({
    data: z.object({ type: z.literal(type), id: z.string() }),
  });
}

/** A document with one resource. */
export function singleDocument<R extends z.ZodType>(resource: R) {
  return z.object({ data: resource });
}

export const PageMeta = z
  .object({
    currentPage: z.number().int(),
    lastPage: z.number().int(),
    perPage: z.number().int(),
    total: z.number().int().describe('Resources across all pages.'),
  })
  .meta({ id: 'PageMeta' });

export const PageLinks = z
  .object({
    self: z.string(),
    first: z.string(),
    last: z.string(),
    prev: z.string().nullable(),
    next: z.string().nullable(),
  })
  .meta({ id: 'PageLinks' });

/**
 * A document with one page of resources (`page[number]`, `page[size]`).
 * Every list is paged, however short it usually is.
 */
export function pagedDocument<R extends z.ZodType>(resource: R) {
  return z.object({
    data: z.array(resource),
    meta: z.object({ page: PageMeta }),
    links: PageLinks,
  });
}

/** Builds a paged document; links keep the request's other parameters. */
export function toPagedDocument<T, R>(
  req: Request,
  page: PageRequest,
  { items, total }: Paginated<T>,
  toResource: (item: T) => R,
): {
  data: R[];
  meta: { page: z.infer<typeof PageMeta> };
  links: z.infer<typeof PageLinks>;
} {
  const lastPage = Math.max(1, Math.ceil(total / page.size));
  const link = (number: number) => {
    const url = new URL(req.originalUrl, 'http://localhost');
    url.searchParams.set('page[number]', String(number));
    url.searchParams.set('page[size]', String(page.size));
    return `${url.pathname}${url.search}`;
  };
  return {
    data: items.map(toResource),
    meta: {
      page: {
        currentPage: page.number,
        lastPage,
        perPage: page.size,
        total,
      },
    },
    links: {
      self: link(page.number),
      first: link(1),
      last: link(lastPage),
      prev: page.number > 1 ? link(Math.min(page.number - 1, lastPage)) : null,
      next: page.number < lastPage ? link(page.number + 1) : null,
    },
  };
}

/** One error; a response carries one or more in `errors`. */
export const ErrorObject = z
  .object({
    status: z.string().describe('The HTTP status code, as a string.'),
    title: z.string().describe('The HTTP status text.'),
    detail: z.string().describe('What went wrong, for people.'),
    code: z
      .string()
      .describe('Stable machine-readable code, e.g. `invalid-content`.'),
    source: z
      .object({
        parameter: z
          .string()
          .optional()
          .describe('The query or path parameter at fault.'),
        header: z.string().optional().describe('The request header at fault.'),
        pointer: z
          .string()
          .optional()
          .describe(
            'JSON pointer to the request body member at fault; for working copies being committed, into the working copy: `/module/<lang>/<moduleId>` or `/manual/<manualId>`, then `/blocks/<block ID>` when a block is at fault.',
          ),
      })
      .optional(),
    meta: z
      .record(z.string(), z.unknown())
      .optional()
      .describe(
        'Details, e.g. `path` (the repository file at fault), `retryAfter` (seconds) or `diagnostics` (PDF compiler messages).',
      ),
  })
  .meta({ id: 'ErrorObject' });
export type ErrorObject = z.infer<typeof ErrorObject>;

export const ErrorDocument = z
  .object({ errors: z.array(ErrorObject).min(1) })
  .meta({ id: 'ErrorDocument' });
export type ErrorDocument = z.infer<typeof ErrorDocument>;
