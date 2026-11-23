import type { JSONContent } from '@tiptap/core';
import { formatCondition, type Condition } from '@openfolia/content-model/core';

import type { Item, Schema } from '../api';

export type ModuleContent = Schema<'Module'>;
export type ModuleMeta = Schema<'ModuleMeta'>;
export type ManifestEntry = Schema<'ManifestEntry'>;

/** A module as `GET /modules/{lang}/{id}` reads it, in the content model's shape. */
export function contentOf(
  attributes: Schema<'ModuleAttributes'>,
): ModuleContent {
  const meta: ModuleMeta = {
    title: attributes.title,
    type: attributes.moduleType,
    lang: attributes.lang,
    ...(attributes.audience !== undefined
      ? { audience: attributes.audience }
      : {}),
    facets: attributes.facets,
    ...(attributes.keywords !== undefined
      ? { keywords: attributes.keywords }
      : {}),
    ...(attributes.source !== undefined ? { source: attributes.source } : {}),
    ...(attributes.deprecated !== undefined
      ? { deprecated: attributes.deprecated }
      : {}),
  };
  return {
    schemaVersion: attributes.schemaVersion,
    id: attributes.moduleId,
    meta,
    blocks: attributes.blocks,
  };
}

/** The module's metadata as the editor's document holds it (`doc.attrs.meta`). */
export function metaOf(doc: JSONContent): ModuleMeta | null {
  const meta = doc.attrs?.['meta'] as ModuleMeta | null | undefined;
  return meta && typeof meta === 'object' ? meta : null;
}

/**
 * `meta` with `patch` applied; an empty audience or keyword list is left out, as the model does,
 * and so is a deprecation taken away (`deprecated: undefined`).
 */
export function patchMeta(
  meta: ModuleMeta,
  patch: Partial<ModuleMeta>,
): ModuleMeta {
  const next: ModuleMeta = { ...meta, ...patch };
  if (!next.audience) delete next.audience;
  if (!next.keywords?.length) delete next.keywords;
  if (!next.deprecated) delete next.deprecated;
  next.facets = Object.fromEntries(
    Object.entries(next.facets ?? {}).filter(([, values]) => values.length > 0),
  );
  return next;
}

const TEXTBLOCKS = new Set([
  'paragraph',
  'title',
  'itemText',
  'hazard',
  'question',
]);

/** The text of a node and everything in it, on one line; its blocks' texts apart. */
export function textOf(node: JSONContent | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.text ?? '';
  const inline = TEXTBLOCKS.has(node.type ?? '');
  return (node.content ?? [])
    .map(textOf)
    .filter((t) => inline || t !== '')
    .join(inline ? '' : ' · ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** One line of the outline: a block of a flow (the document, a section). */
export interface OutlineEntry {
  readonly id: string;
  /** The block type (the content model's name). */
  readonly type: string;
  /** Its heading or the start of its text; empty when it has none. */
  readonly label: string;
  /** 0 for the module's own blocks, one more per section around it. */
  readonly depth: number;
}

const LABEL_CHARS = 80;

const short = (text: string) =>
  text.length > LABEL_CHARS ? `${text.slice(0, LABEL_CHARS - 1)}…` : text;

/** A referred module's title, when it is known; undefined while it is not. */
export type TitleOf = (moduleId: string) => string | undefined;

/**
 * What a block shows in the outline: a title where it has one, else its text. A module
 * reference shows the referred module's title, its ID only while the title is not known (#793).
 */
function labelOf(node: JSONContent, titleOf: TitleOf): string {
  const content = node.content ?? [];
  const title = content.find((c) => c.type === 'title');
  if (title) return short(textOf(title));
  if (node.type === 'safety') {
    return short(textOf(content.find((c) => c.type === 'hazard')));
  }
  if (node.type === 'faq') {
    return short(textOf(content.find((c) => c.type === 'question')));
  }
  if (node.type === 'moduleRef') {
    const id = String(node.attrs?.['module'] ?? '');
    return short((id && titleOf(id)) || id);
  }
  if (node.type === 'image') return short(String(node.attrs?.['alt'] ?? ''));
  if (node.type === 'attachment')
    return short(String(node.attrs?.['name'] ?? ''));
  return short(textOf(node));
}

/**
 * The module's blocks as an outline: each block of the document and of every section (a
 * section by its heading, then its blocks one level in). Blank lines are left out.
 */
export function outlineOf(
  doc: JSONContent,
  titleOf: TitleOf = () => undefined,
): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const visit = (flow: JSONContent, depth: number) => {
    for (const child of flow.content ?? []) {
      if (child.type === 'title') continue;
      const id = child.attrs?.['id'];
      if (typeof id !== 'string' || !id) continue;
      if (child.type === 'paragraph' && !child.content?.length) continue;
      out.push({
        id,
        type: child.type ?? '',
        label: labelOf(child, titleOf),
        depth,
      });
      if (child.type === 'section') visit(child, depth + 1);
    }
  };
  visit(doc, 0);
  return out;
}

/** The conditions of the module's variant blocks, as people read them, each once. */
export function variantsOf(doc: JSONContent): string[] {
  const out = new Set<string>();
  const visit = (node: JSONContent) => {
    if (node.type === 'variant' && node.attrs?.['when']) {
      try {
        out.add(formatCondition(node.attrs['when'] as Condition));
      } catch {
        // A condition the model cannot read: the validation issues name it.
      }
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
  return [...out];
}

/** Whether a manual's entries include the module, at any depth. */
export function includesModule(
  entries: readonly ManifestEntry[],
  moduleId: string,
): boolean {
  return entries.some((entry) =>
    'module' in entry
      ? entry.module === moduleId
      : includesModule(entry.entries, moduleId),
  );
}

export type ManualItem = Item<'/manuals'>;
