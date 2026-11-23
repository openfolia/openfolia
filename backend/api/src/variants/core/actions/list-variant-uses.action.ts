import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { ReadableModuleIndex } from '../../../modules/core/readable-module-index.js';
import { namesVariant } from '../../../modules/core/variant-names.js';
import { compareTitles } from '../../../base/core/compare-titles.js';

/** A manual or a module naming a variant attribute or value. */
export type VariantUse =
  | { readonly kind: 'manual'; readonly id: string; readonly title: string }
  | {
      readonly kind: 'module';
      readonly id: string;
      readonly title: string;
      /** The languages whose files name it, in code-unit order. */
      readonly languages: readonly string[];
    };

interface Input {
  actor: Actor;
  snapshot: ReadableContent;
  /** The variant attribute's ID. */
  attribute: string;
  /** One of its values; undefined: the attribute itself, by any value or comparison. */
  value?: string | undefined;
  page: PageRequest;
}

/**
 * One page of where a variant attribute, or one of its values, is named
 * (#91): the manuals (their variant combinations, the conditions of their
 * entries and text attributes), then the modules (their variant blocks, in
 * any language), each by title, then ID. Read from the module index, so
 * only what the actor may see is listed or counted. Neither is checked
 * against the configuration: a value the configuration no longer holds is
 * still found where content names it.
 */
@Injectable()
export class ListVariantUsesAction extends ActorAction<
  Input,
  Paginated<VariantUse>
> {
  readonly policy = 'content.read';

  constructor(private readonly index: ReadableModuleIndex) {
    super();
  }

  protected async run({
    snapshot,
    attribute,
    value,
    page,
  }: Input): Promise<Paginated<VariantUse>> {
    const [view, config] = await Promise.all([
      this.index.of(snapshot),
      snapshot.config(),
    ]);
    const source = config.languages.source;
    const manuals: VariantUse[] = view.manuals
      .filter((m) => namesVariant(m.variants, attribute, value))
      .map((m) => ({ kind: 'manual', id: m.id, title: m.title ?? m.id }));
    // A module's title: its source-language file's, else its first one's (any readable file).
    const titles = new Map<string, { title: string; lang: string }>();
    // The languages whose files name it.
    const named = new Map<string, string[]>();
    for (const m of view.modules) {
      if (!m.meta) continue;
      const known = titles.get(m.id);
      if (!known || (m.lang === source && known.lang !== source)) {
        titles.set(m.id, { title: m.meta.title, lang: m.lang });
      }
      if (!namesVariant(m.variants, attribute, value)) continue;
      const langs = named.get(m.id);
      if (langs) langs.push(m.lang);
      else named.set(m.id, [m.lang]);
    }
    const byTitle = (a: VariantUse, b: VariantUse) =>
      compareTitles(a.title, b.title) || compare(a.id, b.id);
    const uses: VariantUse[] = [
      ...manuals.sort(byTitle),
      ...[...named]
        .map(([id, languages]): VariantUse => ({
          kind: 'module',
          id,
          title: titles.get(id)?.title ?? id,
          languages: languages.sort(compare),
        }))
        .sort(byTitle),
    ];
    return paginate(uses, page);
  }
}

const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
