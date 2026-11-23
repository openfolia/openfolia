import {
  type Block,
  type Manifest,
  manifestAssets,
  type PageDesign,
  pageDesignAssets,
  walk,
} from '@openfolia/content-model';
import { UnprocessableError } from '../../base/core/errors.js';
import { isSha256 } from '../../blobs/core/blob-store.js';

/** The most distinct files one working copy may name (image and attachment blocks). */
export const MAX_FILES_PER_WORKING_COPY = 200;

/**
 * The hashes of the files `blocks` name as an image or attachment block's
 * `asset` (`sha256:<64 hex>`; another form names no stored file), each
 * once, sorted. Only real references: text that merely mentions a hash
 * names nothing. More than `MAX_FILES_PER_WORKING_COPY` is 422
 * `too-many-files` (`meta.max`).
 */
export function fileReferences(blocks: readonly Block[]): string[] {
  const found = new Set<string>();
  for (const { kind, node } of walk(blocks)) {
    if (kind !== 'block') continue;
    if (node.type !== 'image' && node.type !== 'attachment') continue;
    const hash = node.asset.startsWith('sha256:')
      ? node.asset.slice('sha256:'.length)
      : '';
    if (isSha256(hash)) found.add(hash);
  }
  if (found.size > MAX_FILES_PER_WORKING_COPY) {
    throw new UnprocessableError(
      'too-many-files',
      `A module names at most ${MAX_FILES_PER_WORKING_COPY} different images and attachments.`,
      { max: MAX_FILES_PER_WORKING_COPY },
    );
  }
  return [...found].sort();
}

/**
 * The hashes of the files a page design names (#390): its logo, fonts,
 * cover images and the images and attachments of its regions
 * (`pageDesignAssets`), each once, sorted; another form than
 * `sha256:<64 hex>` names no stored file. More than
 * `MAX_FILES_PER_WORKING_COPY` is 422 `too-many-files`.
 */
export function designFileReferences(design: PageDesign): string[] {
  const found = new Set<string>();
  for (const { asset } of pageDesignAssets(design)) {
    const hash = asset.startsWith('sha256:')
      ? asset.slice('sha256:'.length)
      : '';
    if (isSha256(hash)) found.add(hash);
  }
  if (found.size > MAX_FILES_PER_WORKING_COPY) {
    throw new UnprocessableError(
      'too-many-files',
      `A page design names at most ${MAX_FILES_PER_WORKING_COPY} different files.`,
      { max: MAX_FILES_PER_WORKING_COPY },
    );
  }
  return [...found].sort();
}

/**
 * The hashes of the files a manifest names (#394): its cover images (`manifestAssets`), each
 * once, sorted; another form than `sha256:<64 hex>` names no stored file. At most
 * `MAX_COVER_VARIANTS` + 1 places, so no cap of its own.
 */
export function manifestFileReferences(
  manifest: Pick<Manifest, 'coverImage'>,
): string[] {
  const found = new Set<string>();
  for (const { asset } of manifestAssets(manifest)) {
    const hash = asset.startsWith('sha256:')
      ? asset.slice('sha256:'.length)
      : '';
    if (isSha256(hash)) found.add(hash);
  }
  return [...found].sort();
}

/** The files a working copy's content names: a module's, a manual's or a page design's; nothing for other subjects. */
export function subjectFileReferences(
  type: string,
  content: unknown,
): string[] {
  if (type === 'module') {
    return fileReferences((content as { blocks: Block[] }).blocks);
  }
  if (type === 'design') return designFileReferences(content as PageDesign);
  if (type === 'manual') return manifestFileReferences(content as Manifest);
  return [];
}
