import {
  designTemplateDir,
  MAX_TEMPLATE_BYTES,
  MAX_TEMPLATE_FILES,
} from '@openfolia/content-model';
import { InvalidContentError } from '../../base/core/errors.js';

/** How many files a page design template's folder holds, and how many bytes together. */
export interface TemplateFolderSize {
  readonly files: number;
  readonly bytes: number;
}

/** The caps of a template's folder (#396), as an error's or a listing's `meta`. */
export const TEMPLATE_CAPS = {
  maxFiles: MAX_TEMPLATE_FILES,
  maxBytes: MAX_TEMPLATE_BYTES,
} as const;

/**
 * The size of a template's folder (#803) from its committed listing and its drafts' lengths
 * (UTF-8 bytes, by path): a draft's length in place of its file's, and each draft no file has
 * counted as one more. Nothing is read.
 */
export function templateFolderSize(
  listed: readonly { readonly path: string; readonly size: number }[],
  drafts: ReadonlyMap<string, number>,
): TemplateFolderSize {
  let files = 0;
  let bytes = 0;
  for (const { path, size } of listed) {
    if (drafts.has(path)) continue;
    files += 1;
    bytes += size;
  }
  for (const size of drafts.values()) {
    files += 1;
    bytes += size;
  }
  return { files, bytes };
}

/** Whether a folder of `size` is past `MAX_TEMPLATE_FILES` or `MAX_TEMPLATE_BYTES`. */
export const pastTemplateCaps = (size: TemplateFolderSize): boolean =>
  size.files > MAX_TEMPLATE_FILES || size.bytes > MAX_TEMPLATE_BYTES;

/**
 * Throws what the repository throws for a template folder past the caps (`InvalidContentError`
 * at `templates/<id>`, as the snapshot's `designTemplate` does), when `size` is past them.
 */
export function refusePastTemplateCaps(
  id: string,
  size: TemplateFolderSize,
): void {
  if (!pastTemplateCaps(size)) return;
  throw new InvalidContentError(
    designTemplateDir(id),
    `the template holds ${size.files} files and ${size.bytes} bytes; at most ${MAX_TEMPLATE_FILES} files and ${MAX_TEMPLATE_BYTES} bytes`,
  );
}
