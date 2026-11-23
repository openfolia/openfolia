import { plainTextOf, walk, type Block } from '@openfolia/content-model/core';

import type { ApiError } from '../api';

/** An image or attachment block naming a file the server refused to take. */
export interface RefusedFile {
  /** The block that names it. */
  readonly blockId: string;
  readonly kind: 'image' | 'attachment';
  /** How the person knows it: an image's alt text (else its caption), an attachment's name. */
  readonly label: string;
}

/**
 * Codes that refuse a save or a save point for the files it names (`meta.assets`, `sha256:…`):
 * `unknown-asset` (422, a file the editor may not use) and `asset-deleted` (409, being deleted
 * as unused). Neither goes through on Retry: the block's file is uploaded again, or the block
 * removed.
 */
const REFUSING = new Set(['unknown-asset', 'asset-deleted']);

/** The files a refusal names, or null when it is no refusal of files (or names none). */
export function refusedAssets(
  failure: Pick<ApiError, 'code' | 'errors'>,
): string[] | null {
  if (!REFUSING.has(failure.code)) return null;
  const named = failure.errors.flatMap((e) => {
    const assets = e.meta?.['assets'];
    return Array.isArray(assets)
      ? assets.filter((a): a is string => typeof a === 'string')
      : [];
  });
  // A refusal naming no file is answered as any other refusal (with Retry): nothing to mark.
  return named.length > 0 ? [...new Set(named)] : null;
}

/** The image and attachment blocks of `blocks` naming one of `assets`, in document order. */
export function refusedFiles(
  blocks: readonly unknown[],
  assets: ReadonlySet<string>,
): RefusedFile[] {
  if (assets.size === 0) return [];
  const out: RefusedFile[] = [];
  for (const { kind, node } of walk(blocks as readonly Block[])) {
    if (kind !== 'block') continue;
    if (node.type === 'image' && assets.has(node.asset)) {
      out.push({
        blockId: node.id,
        kind: 'image',
        label: oneLine(node.alt) || oneLine(plainTextOf(node.title ?? []).text),
      });
    } else if (node.type === 'attachment' && assets.has(node.asset)) {
      out.push({
        blockId: node.id,
        kind: 'attachment',
        label: oneLine(node.name) || oneLine(node.fileName),
      });
    }
  }
  return out;
}

const oneLine = (text: string | undefined) =>
  (text ?? '').replace(/\s+/g, ' ').trim();
