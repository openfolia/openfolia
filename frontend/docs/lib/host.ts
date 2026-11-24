/**
 * A host as the API reference's server `https://{host}/api` takes it (#858): a name or an IPv4
 * address, or an IPv6 one in brackets, with an optional port. Nothing else (no scheme, path,
 * credentials or spaces), so the code samples and the link stay a URL of that host.
 */
const HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]+\])(?::\d{1,5})?$/;

/** Whether a typed host can go into `https://{host}/api`. */
export function isHost(value: string): boolean {
  return HOST.test(value) && URL.canParse(`https://${value}/api`);
}

/**
 * The host in what a reader typed or pasted: their editor's address too, with its scheme and a
 * trailing `/` or `/api…` dropped. `null` when what is left is no host.
 */
export function hostOf(value: string): string | null {
  const host = value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/(?:api(?:\/.*)?)?$/i, '');
  return isHost(host) ? host : null;
}
