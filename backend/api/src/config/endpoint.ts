import { z } from 'zod';

/** An `http://` or `https://` URL without credentials, query or fragment; the message never repeats the value. */
export const endpoint = z
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
      url.hash === ''
    );
  }, 'must be an http:// or https:// URL without credentials, query or fragment');

/** Whether `hostname` (as `URL` gives it) is this machine. */
export function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/.test(hostname)
  );
}
