import {
  OLDER_SEGMENT,
  type SnapshotManual,
  type SnapshotOlderRelease,
  type SnapshotRelease,
  type SnapshotVariant,
} from './snapshot.ts';

// Where the pages are under the language's site: shared by the pages (`site.ts`) and the build,
// which checks the start page's links against them (`start.ts`).

/** A built release: a product's newest (at the addresses readers have always used) or an older one (#896). */
export type BuiltRelease = SnapshotRelease | SnapshotOlderRelease;

export const isOlder = (
  release: BuiltRelease,
): release is SnapshotOlderRelease => 'segment' in release;

/** Where a release's pages are under the language's site: `<product>/`, an older one's `<product>/v/<release>/`. */
export const releaseRoot = (release: BuiltRelease) =>
  isOlder(release)
    ? `${release.product}/${OLDER_SEGMENT}/${release.segment}/`
    : `${release.product}/`;

export const manualPath = (
  release: BuiltRelease,
  manual: SnapshotManual,
  variant: SnapshotVariant,
) => `${releaseRoot(release)}${manual.id}/${variant.slug}/`;

/** An update guide's page: one per guide, whatever its variants. */
export const guidePath = (release: BuiltRelease, manual: SnapshotManual) =>
  `${releaseRoot(release)}${manual.id}/`;

/** Where a list links a manual: its first variant's page, an update guide's own page. */
export const entryPath = (release: BuiltRelease, manual: SnapshotManual) =>
  manual.guide
    ? guidePath(release, manual)
    : manualPath(release, manual, manual.variants[0]!);
