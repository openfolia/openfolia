import { createHash } from 'node:crypto';
import type { StableAddress } from '../core/stable-address.js';

/** What a stable address's page is made from (#552): everything its bytes depend on. */
export interface PageInputs {
  /** The build serving it (`CCMS_BUILD_ID`): the renderer's code and the page's stylesheets. */
  readonly buildId: string;
  /** The ETags of the stylesheets it links: a new build's styles change it even under one `buildId`. */
  readonly files: readonly string[];
  /** The release's commit, read at its tag. */
  readonly commit: string;
  /** The manual's ID at the release. */
  readonly manualId: string;
  /** The address in its canonical form, and pinned to the release: the page's links. */
  readonly address: StableAddress;
  readonly pinned: StableAddress;
  /** What the reader may see at the commit (`ReadableContent.readingKey`). */
  readonly readingKey: string;
  readonly theme: string;
  /** The page's way back to the root (`relativeRoot`), which its links start with. */
  readonly root: string;
}

/**
 * The ETag of a stable address's page (#552), known before it is rendered, so a revalidation
 * is a 304 without rendering the manual: the hash of its inputs, quoted. The same inputs
 * render the same bytes; anything that changes them (a new release, another reader's scope,
 * the theme, a new build) changes the ETag.
 */
export function pageEtag(inputs: PageInputs): string {
  const hash = createHash('sha256').update(
    JSON.stringify([
      'page',
      inputs.buildId,
      inputs.files,
      inputs.commit,
      inputs.manualId,
      inputs.address,
      inputs.pinned,
      inputs.readingKey,
      inputs.theme,
      inputs.root,
    ]),
  );
  return `"${hash.digest('hex')}"`;
}
