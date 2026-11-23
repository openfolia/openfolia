import type { Release } from './release.js';
import type { ReleaseOutput } from './release-output.js';

/**
 * `GET /releases/:id/outputs/archive` (#469): how large a ZIP of a
 * release's files may get (`CCMS_RELEASE_ARCHIVE_MAX_BYTES`).
 */
export abstract class ReleaseArchiveSettings {
  /** The largest archive served, in bytes (headers included); a larger one is 422 `release-archive-too-large`. */
  abstract readonly maxBytes: number;
}

/** `CCMS_RELEASE_ARCHIVE_MAX_BYTES`: its default (2 GiB). Its largest value is `MAX_ZIP_BYTES` (4 GiB less one byte). */
export const DEFAULT_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * One part of a name in the archive: ASCII letters, digits, `.` and `-`
 * (anything else `-`, as `outputFileName` does), never empty and never
 * starting with a dot, so no part is `.` or `..` and none is hidden.
 */
function segment(text: string): string {
  const part = text.replace(/[^A-Za-z0-9.-]+/g, '-').replace(/^\.+/, '-');
  return part === '' ? '-' : part;
}

/**
 * The names of a release's files in its archive, one per output and in
 * their order: `<manual>/<lang>/<variant>.<kind>`, e.g.
 * `operating/en/model-small.pdf`, each part as `segment` makes it. Two
 * outputs whose names would be the same, ignoring case (a file system
 * may), get `-2`, `-3`, … before the extension, the first keeping its
 * name.
 */
export function archiveEntryNames(
  outputs: readonly Pick<
    ReleaseOutput,
    'manualId' | 'variant' | 'lang' | 'kind'
  >[],
): string[] {
  const taken = new Set<string>();
  return outputs.map((o) => {
    const base = [o.manualId, o.lang, o.variant].map(segment).join('/');
    let name = `${base}.${o.kind}`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) {
      name = `${base}-${n}.${o.kind}`;
    }
    taken.add(name.toLowerCase());
    return name;
  });
}

/** The name a release's archive downloads as: `<product>_<revision>.zip`, each part as `segment` makes it. */
export function archiveFileName(
  release: Pick<Release, 'product' | 'revision'>,
): string {
  return `${segment(release.product)}_${segment(release.revision)}.zip`;
}
