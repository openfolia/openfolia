import { z } from 'zod';

/**
 * `CCMS_SOURCE_URL` (#370): where this deployment's source code is, as AGPL-3.0 section 13 asks a
 * network service to offer it to its users. `GET /about` hands it to clients, and the editor
 * links to it, so only an `http://` or `https://` URL without credentials (never `javascript:` or
 * another scheme a link would run), normalised by the URL parser.
 */
export const sourceUrl = z
  .string()
  .trim()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === ''
    );
  }, 'must be an http:// or https:// URL without credentials')
  .transform((value) => new URL(value).href);
