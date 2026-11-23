import type { ChangeSetAuthor } from '../../change-sets/core/change-set.js';

/** A release's annotated tag in the content repository. */
export interface ReleaseTag {
  /** The tag's name, without `refs/tags/` (`release/<product>/<revision>`). */
  readonly name: string;
  /** The annotated tag object. */
  readonly tag: string;
  /** The commit it points to. */
  readonly commit: string;
}

/**
 * Port: releases as annotated tags. A tag is created on an exact commit
 * and is immutable: never moved, never re-created.
 */
export abstract class ReleaseTags {
  /**
   * Tags `commit` as the release `revision` of `product`, under the name
   * the configured pattern gives (`releaseTagName`), with `actor` as the
   * tagger and trailers naming the product, the revision and the actor.
   * Throws `ConflictError` (`release-exists`) when a tag of that name (or
   * a branch or tag clashing with it) exists, and `UnprocessableError`
   * (`invalid-release-name`, `invalid-commit`, `invalid-message`) when the
   * request can never succeed; nothing is written then.
   */
  abstract create(request: {
    readonly product: string;
    readonly revision: string;
    readonly commit: string;
    readonly message: string;
    readonly actor: ChangeSetAuthor;
    /** The tagger date (whole seconds are kept); default now. */
    readonly date?: Date;
  }): Promise<ReleaseTag>;

  /**
   * The tag name of `product` at `revision` by the configured pattern
   * (`releaseTagName`). Throws `UnprocessableError`
   * (`invalid-release-name`) when they cannot be part of one.
   */
  abstract nameOf(product: string, revision: string): string;

  /**
   * The annotated tag named exactly `name`, as recorded: the commit it
   * points to, its tagger date and its message without trailers. Undefined
   * when there is none (or only a lightweight one).
   */
  abstract find(name: string): Promise<RecordedReleaseTag | undefined>;
}

/** A tag read back (`ReleaseTags.find`). */
export interface RecordedReleaseTag extends ReleaseTag {
  readonly taggedAt: Date;
  /** The message without its trailers, trimmed. */
  readonly message: string;
}

/** The trailers a release tag carries. */
export const PRODUCT_TRAILER = 'Product';
export const REVISION_TRAILER = 'Revision';

/** The default release tag pattern (`CCMS_RELEASE_TAG`). */
export const DEFAULT_RELEASE_TAG = 'release/{product}/{revision}';

/**
 * A product or revision as it may appear in a tag name: one ref component
 * of `A-Za-z0-9._-`, starting with a letter, digit or `_`, not ending in
 * `.` or `.lock`, at most 100 characters.
 */
export function isReleasePart(value: string): boolean {
  return (
    /^[A-Za-z0-9_][A-Za-z0-9._-]{0,99}$/.test(value) &&
    !value.includes('..') &&
    !value.endsWith('.') &&
    !value.endsWith('.lock')
  );
}

/**
 * Whether `pattern` is a release tag pattern: `{product}` and `{revision}`
 * exactly once each, and otherwise only `A-Za-z0-9._/-`, with each
 * placeholder a whole path component (so a value can never run into the
 * literal text around it).
 */
export function isReleaseTagPattern(pattern: string): boolean {
  const count = (p: string) => pattern.split(p).length - 1;
  if (count('{product}') !== 1 || count('{revision}') !== 1) return false;
  const components = pattern.split('/');
  return (
    pattern.length <= 100 &&
    components[0]?.toLowerCase() !== 'refs' &&
    components.includes('{product}') &&
    components.includes('{revision}') &&
    components.every(
      (c) => c === '{product}' || c === '{revision}' || isReleasePart(c),
    )
  );
}

/**
 * The tag name of a release by `pattern`; undefined when the product or
 * revision cannot be part of one (`isReleasePart`).
 */
export function releaseTagName(
  pattern: string,
  product: string,
  revision: string,
): string | undefined {
  if (!isReleaseTagPattern(pattern)) {
    throw new Error(`invalid release tag pattern "${pattern}"`);
  }
  if (!isReleasePart(product) || !isReleasePart(revision)) return undefined;
  const name = pattern
    .split('/')
    .map((c) =>
      c === '{product}' ? product : c === '{revision}' ? revision : c,
    )
    .join('/');
  // Git names under `refs/` differently; the writer takes at most 256.
  return name.split('/')[0]?.toLowerCase() === 'refs' || name.length > 256
    ? undefined
    : name;
}
