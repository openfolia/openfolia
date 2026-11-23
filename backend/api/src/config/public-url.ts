import { z } from 'zod';

/**
 * `CCMS_PUBLIC_URL` (#450): where readers reach this deployment, the stable addresses' and QR
 * codes' base (`<url>/d/<product>/…`). An `http://` or `https://` URL without credentials, query
 * or fragment (it is printed on products and labels, so nothing a reader should not see), its
 * path ending in `/` (a deployment under a path, `https://example.com/docs/`, keeps it).
 */
export const publicUrl = z
  .string()
  .trim()
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname !== '' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === '' &&
      // `new URL` drops an empty `?` or `#`; the text itself must not hold one.
      !/[?#]/.test(value)
    );
  }, 'must be an http:// or https:// URL without credentials, query or fragment')
  .transform((value) => {
    const url = new URL(value);
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  });
