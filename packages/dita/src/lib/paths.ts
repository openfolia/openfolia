/**
 * Paths inside the uploaded archive. Every reference a DITA file makes
 * (`@href`, `@conref`, a key's target) is resolved against the referring
 * file's path into another key of the archive's map, or into nothing: no
 * reference ever reaches a file system or a network, and one that climbs
 * above the archive's root resolves to nothing.
 */

/** A reference split into its path and its fragment (`a.dita#t/p`), both percent-decoded. */
export interface Reference {
  /** The path part, empty for a same-document reference (`#t/p`). */
  readonly path: string;
  /** The fragment, without `#`; undefined for none. */
  readonly fragment: string | undefined;
}

/** A URI scheme (`https:`, `file:`, `c:`): a reference with one is never a file of the archive. */
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Whether `href` names something outside the archive by a scheme (`https://…`, `mailto:…`). */
export function hasScheme(href: string): boolean {
  return SCHEME.test(href);
}

function decode(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/**
 * `href` split into path and fragment; undefined when it has a scheme, a
 * query, a backslash or an escape that is no UTF-8 (DITA: "Windows paths
 * that contain a backslash are not valid URLs"). A query on a DITA
 * reference may be ignored (DITA 1.3, 2.3.3): it is.
 */
export function splitReference(href: string): Reference | undefined {
  const trimmed = href.trim();
  if (trimmed === '' || hasScheme(trimmed) || trimmed.includes('\\')) {
    return undefined;
  }
  const hash = trimmed.indexOf('#');
  let path = hash === -1 ? trimmed : trimmed.slice(0, hash);
  const query = path.indexOf('?');
  if (query !== -1) path = path.slice(0, query);
  const fragment = hash === -1 ? undefined : trimmed.slice(hash + 1);
  const decodedPath = decode(path);
  const decodedFragment = fragment === undefined ? undefined : decode(fragment);
  if (decodedPath === undefined) return undefined;
  if (fragment !== undefined && decodedFragment === undefined) return undefined;
  return { path: decodedPath, fragment: decodedFragment };
}

/** The folder a file lies in, `''` at the root. */
export function folderOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** The last segment of a path. */
export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** A path without its extension (`topics/a.dita` → `topics/a`). */
export function withoutExtension(path: string): string {
  const base = baseName(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? path : path.slice(0, path.length - (base.length - dot));
}

/** The lowercase extension (`.dita`), `''` for none. */
export function extensionOf(path: string): string {
  const base = baseName(path);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

/**
 * `relative` resolved against the folder of `from`: `.` and `..` segments
 * applied, empty segments dropped. Undefined when it is absolute, or
 * climbs above the archive's root.
 */
export function resolvePath(
  from: string,
  relative: string,
): string | undefined {
  if (relative.startsWith('/')) return undefined;
  const segments = folderOf(from) === '' ? [] : folderOf(from).split('/');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : segments.join('/');
}
