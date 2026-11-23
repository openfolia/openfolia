import { Injectable, inject } from '@angular/core';
import { walk, type Block } from '@openfolia/content-model/core';
import { firstValueFrom } from 'rxjs';

import { ApiClient, toApiError } from '../api';
import type { MediaItem } from './media-model';

/** At most this many modules using a file are read for its details. */
export const MAX_MODULES = 8;
/** At most this many module reads at once. */
const READS = 4;

/** One block using the file in one language, or the same block showing another image there. */
export interface UsageRow {
  readonly lang: string;
  readonly moduleId: string;
  readonly title: string;
  /** The block (an image or attachment block); null when it was not found in the module. */
  readonly blockId: string | null;
  /** An image block's alt text in that language; null for an attachment or a block not found. */
  readonly alt: string | null;
  /** `same`: the block uses this file; `other`: the same block shows another image there. */
  readonly kind: 'same' | 'other';
  /** The other image (`sha256:<hash>`), for `other`. */
  readonly otherAsset: string | null;
}

export interface MediaUsage {
  /** By language (in `languages` order, then any other), then module, then block. */
  readonly rows: readonly UsageRow[];
  /** Uses (a module in a language) not shown: past `MAX_MODULES`, or past the 50 the list names. */
  readonly more: number;
}

/** A module in one language as far as the details need it; null when it is not there. */
export interface ModuleBlocks {
  readonly title: string;
  readonly blocks: readonly Block[];
}

type ReadModule = (
  lang: string,
  moduleId: string,
) => Promise<ModuleBlocks | null>;

interface FileBlock {
  readonly id: string;
  readonly type: 'image' | 'attachment';
  readonly asset: string;
  readonly alt: string | null;
}

/** The image and attachment blocks of a module, in document order. */
function fileBlocks(blocks: readonly Block[]): FileBlock[] {
  const out: FileBlock[] = [];
  for (const { kind, node } of walk(blocks)) {
    if (kind !== 'block') continue;
    if (node.type === 'image')
      out.push({
        id: node.id,
        type: 'image',
        asset: node.asset,
        alt: node.alt,
      });
    else if (node.type === 'attachment')
      out.push({
        id: node.id,
        type: 'attachment',
        asset: node.asset,
        alt: null,
      });
  }
  return out;
}

/**
 * Where a file is used, per language: for the first `MAX_MODULES` modules the list names, each
 * language's module is read (`read`, at the branch shown) for the blocks using the file and an
 * image's alt text there. A translation shares its source's block IDs, so the same block in a
 * language whose module shows another image is an `other` row ("Other image in <language>"). A
 * module that can't be read in a language using the file still gets its row, without a block.
 */
export async function readUsage(
  item: MediaItem,
  languages: readonly string[],
  read: ReadModule,
): Promise<MediaUsage> {
  const reference = item.attributes.reference;
  const byModule = new Map<string, Map<string, string>>();
  for (const use of item.meta.usedIn) {
    const langs = byModule.get(use.moduleId) ?? new Map<string, string>();
    langs.set(use.lang, use.title);
    byModule.set(use.moduleId, langs);
  }
  const modules = [...byModule.entries()].slice(0, MAX_MODULES);
  const shown = modules.reduce((n, [, langs]) => n + langs.size, 0);
  const more = Math.max(0, item.meta.usedInCount - shown);

  const queue: (() => Promise<void>)[] = [];
  const rows: UsageRow[] = [];
  for (const [moduleId, using] of modules) {
    queue.push(async () => {
      const langs = [...new Set([...using.keys(), ...languages])];
      const found = new Map<string, ModuleBlocks | null>();
      await Promise.all(
        langs.map(async (lang) => {
          found.set(lang, await read(lang, moduleId));
        }),
      );
      // The blocks using the file, in the languages the list says use it.
      const ids = new Set<string>();
      for (const [lang, title] of using) {
        const module = found.get(lang);
        const blocks = module
          ? fileBlocks(module.blocks).filter((b) => b.asset === reference)
          : [];
        for (const block of blocks) ids.add(block.id);
        if (blocks.length === 0) {
          rows.push({
            lang,
            moduleId,
            title: module?.title || title || moduleId,
            blockId: null,
            alt: null,
            kind: 'same',
            otherAsset: null,
          });
        }
        for (const block of blocks) {
          rows.push({
            lang,
            moduleId,
            title: module?.title || title || moduleId,
            blockId: block.id,
            alt: block.type === 'image' ? block.alt : null,
            kind: 'same',
            otherAsset: null,
          });
        }
      }
      // The same blocks in the other languages, where they show another image.
      for (const lang of langs) {
        if (using.has(lang)) continue;
        const module = found.get(lang);
        if (!module) continue;
        for (const block of fileBlocks(module.blocks)) {
          if (!ids.has(block.id) || block.asset === reference) continue;
          rows.push({
            lang,
            moduleId,
            title: module.title || moduleId,
            blockId: block.id,
            alt: block.alt,
            kind: 'other',
            otherAsset: block.asset,
          });
        }
      }
    });
  }
  await runLimited(queue, READS);

  const order = (lang: string) => {
    const at = languages.indexOf(lang);
    return at < 0 ? languages.length : at;
  };
  const moduleOrder = new Map(modules.map(([id], i) => [id, i]));
  rows.sort(
    (a, b) =>
      order(a.lang) - order(b.lang) ||
      a.lang.localeCompare(b.lang) ||
      (moduleOrder.get(a.moduleId) ?? 0) - (moduleOrder.get(b.moduleId) ?? 0),
  );
  return { rows, more };
}

/** Runs the jobs, at most `limit` at once. */
async function runLimited(
  jobs: readonly (() => Promise<void>)[],
  limit: number,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await job?.();
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, jobs.length) }, worker),
  );
}

/**
 * Reads where a file is used per language through the API, at the chosen change set's branch:
 * `GET /modules/{lang}/{id}` for each module and language (`readUsage`). A module not there in a
 * language (404), or not for this person (403), is none.
 */
@Injectable()
export class MediaUsageReader {
  private readonly api = inject(ApiClient);

  read(item: MediaItem, languages: readonly string[]): Promise<MediaUsage> {
    return readUsage(item, languages, (lang, id) => this.module(lang, id));
  }

  private async module(lang: string, id: string): Promise<ModuleBlocks | null> {
    try {
      const doc = await firstValueFrom(
        this.api.get('/modules/{lang}/{id}', { path: { lang, id } }),
      );
      const { title, blocks } = doc.data.attributes;
      return { title, blocks: blocks as unknown as readonly Block[] };
    } catch (error) {
      if ([403, 404].includes(toApiError(error).status)) return null;
      throw error;
    }
  }
}
