import { Injectable } from '@nestjs/common';
import {
  isSnippetType,
  plainTextExcerpt,
  walk,
  type Condition,
  type Deprecation,
  type Module,
  type ProjectConfig,
} from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import { InvalidContentError } from '../../../base/core/errors.js';
import {
  foldedKeywords,
  hasKeywords,
  matchesClassification,
  type ModuleFilter,
} from '../../../content/core/module-filter.js';
import type {
  ReadableContent,
  SeenDeletedModule,
} from '../../../content/core/readable-content.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import { Recent } from '../../../base/core/recent.js';
import { heldInReleased, openReleased } from '../history-lookups.js';
import type { IndexedModule } from '../module-index.js';
import { HISTORY_WINDOW } from '../module-history.js';
import { ReadableModuleIndex } from '../readable-module-index.js';

/** One module across its languages, as a content browser lists it. */
export interface ModuleSummary {
  id: string;
  /** In `lang` when that filter is given, else in the source language (else the first one there is). */
  title: string;
  titleLang: string;
  moduleType: string;
  audience?: string | undefined;
  facets: Record<string, string[]>;
  /** The keywords of the language `title` is in (keywords are per language). */
  keywords: string[];
  /** The languages it exists in, the source language first, the rest sorted. */
  languages: string[];
  /** What its variant blocks are conditioned on: `attr=value`, or `attr>=2.3` for a version. */
  variants: string[];
  /** It differs from the released content in some language, or is not there at all. */
  changed: boolean;
  /** The start of its plain text in the language of `title` (`plainTextExcerpt`, 200 characters). */
  text: string;
  /** Its deprecation (#266): the source-language file's, else (none the reader sees) that of `title`'s language. */
  deprecated?: Deprecation | undefined;
  /**
   * Set for a deleted module (#320): its newest deletion among the languages listed. Its other
   * fields are then those of its last versions, and `languages` the languages deleted.
   */
  deleted?:
    { readonly commit: string; readonly committedAt: string } | undefined;
}

/** Which modules a list holds: those there (the default), those deleted (#320), or both. */
export const SUMMARY_STATUSES = ['current', 'deleted', 'any'] as const;
export type SummaryStatus = (typeof SUMMARY_STATUSES)[number];

/**
 * Type, audience and facets are those of the language shown (`title`'s);
 * keywords those of any language, or of `lang` when it is given: every
 * keyword asked for in one language.
 */
export interface ModuleSummaryFilter extends ModuleFilter {
  /** Only modules that exist in this language; their titles in it. */
  lang?: string | undefined;
  /** True: only modules that differ from the released content; false: only those that do not. */
  changed?: boolean | undefined;
  /** Case-insensitive text in the title (in any language) or the ID. */
  q?: string | undefined;
  /** True: only modules of a snippet type (`snippet: true` in the configuration); false: only others. */
  snippet?: boolean | undefined;
  /**
   * True: only deprecated modules (`ModuleSummary.deprecated`); false: only the others. Not
   * applied to deleted modules (`status`), which are listed either way.
   */
  deprecated?: boolean | undefined;
  /** `current` when not given: the modules there; `deleted`: those deleted; `any`: both. */
  status?: SummaryStatus | undefined;
  /**
   * Only the modules of these IDs (#481): a screen reads the summaries of
   * the modules it shows (a manual's outline), not the whole list.
   */
  ids?: ReadonlySet<string> | undefined;
}

/**
 * One page of the modules the actor may see, one entry per module ID (its
 * languages grouped), filtered and ordered by title. `changed` compares
 * with `released` (the released branch as the same actor reads it): a
 * module is unchanged when every language of it equals the released one.
 * Without `released` (there is none to read), every module counts as
 * changed. Files that cannot be read are left out here (`GET /modules`
 * reports them).
 *
 * The modules there come from the module index as the reader sees it
 * (`ReadableModuleIndex`, #480): filtered and ordered on what the index
 * holds (equal modules by their digest), kept per commit, reader, released
 * branch and `lang`, and only the page's files are read (for `text` and
 * `variants`). So a deep page costs what the first one does.
 *
 * With `status` `deleted` (or `any`, both in one list), the modules deleted
 * on the ref's first-parent line (#320; among its newest `HISTORY_WINDOW`
 * commits) that the actor sees no file of now, summarised from the last
 * versions of their deleted files that the actor may see
 * (`ReadableContent.deletedModules`), so a module outside their scope is
 * never listed or counted, and each one listed has a history to open. A
 * deleted module is changed when the released branch has it.
 *
 * Those last versions are mostly in commits not released, so only a reader
 * of drafts reads them so (`content.read.draft`, #418, as #410 for
 * deleted manuals), and only where their draft scopes show them alike.
 * Anyone else (a reader of released content only, or one whose draft
 * scopes are narrower) is listed a deleted file only when released content
 * (`openReleased`: `main`'s head or a release tag) holds exactly its last
 * version, and summarised from that file as they read it there (judged by
 * that release's configuration and their scope): what they could read
 * anyway. The others are not listed or counted, as if never there.
 */
@Injectable()
export class ListModuleSummariesAction extends ActorAction<
  {
    actor: Actor;
    snapshot: ReadableContent;
    released?: ReadableContent | undefined;
    filter: ModuleSummaryFilter;
    page: PageRequest;
  },
  Paginated<ModuleSummary>
> {
  readonly policy = 'content.read';
  /** The modules there, from the module index, per reader, released branch and `lang` (#480). */
  readonly #current = new Recent<readonly Listed[]>(SUMMARY_VIEWS_KEPT);

  constructor(
    private readonly refs: ReadableRefs,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly index: ReadableModuleIndex,
  ) {
    super();
  }

  protected async run({
    actor,
    snapshot,
    released,
    filter,
    page,
  }: {
    actor: Actor;
    snapshot: ReadableContent;
    released?: ReadableContent | undefined;
    filter: ModuleSummaryFilter;
    page: PageRequest;
  }): Promise<Paginated<ModuleSummary>> {
    const status = filter.status ?? 'current';
    const config = await snapshot.config();
    const audiences = config.audiences.map((a) => a.id);
    const sameCommit = released?.commit === snapshot.commit;
    const listed: Listed[] = [];
    // Whether an entry passes the filters but `changed`, which may need reading the released files.
    const passes = (entry: Listed): boolean => {
      const { summary } = entry;
      if (!matches(entry, filter, audiences)) return false;
      // A deleted module is listed whether it was deprecated or not: deprecating comes before
      // deleting, and a list hiding deprecated modules still shows the deleted ones.
      if (
        summary.deleted === undefined &&
        filter.deprecated !== undefined &&
        (summary.deprecated !== undefined) !== filter.deprecated
      ) {
        return false;
      }
      return (
        filter.snippet === undefined ||
        isSnippetType(config, summary.moduleType) === filter.snippet
      );
    };
    const keep = (entry: Listed, isChanged: boolean): void => {
      if (filter.changed !== undefined && isChanged !== filter.changed) return;
      listed.push(
        isChanged === entry.summary.changed
          ? entry
          : { ...entry, summary: { ...entry.summary, changed: isChanged } },
      );
    };
    if (status !== 'deleted') {
      const current = await this.#current.get(
        [
          snapshot.commit,
          snapshot.readingKey,
          released?.commit ?? '',
          released?.readingKey ?? '',
          filter.lang ?? '',
        ].join('|'),
        () => this.current(snapshot, released, config, filter.lang),
      );
      for (const entry of current) {
        // Worked out when the list was made: `changed` is already the summary's.
        if (passes(entry)) keep(entry, entry.summary.changed);
      }
    }
    if (status !== 'current') {
      const files = await this.deleted(actor, snapshot);
      // Newest deletion first, so a module's first file holds its newest deletion.
      const byId = new Map<string, SeenDeletedModule[]>();
      for (const file of files) {
        const list = byId.get(file.id) ?? [];
        list.push(file);
        byId.set(file.id, list);
      }
      const deleted: Listed[] = [];
      for (const [id, found] of byId) {
        const modules = found.map((d) => d.module);
        const newest = found[0] as SeenDeletedModule;
        const metas = modules.map((m) => ({ lang: m.meta.lang, meta: m.meta }));
        const summary = summarize(id, metas, config, filter.lang);
        if (!summary) continue;
        deleted.push({
          summary: {
            ...summary,
            ...details(modules, summary.titleLang),
            deleted: { commit: newest.commit, committedAt: newest.committedAt },
          },
          files: metas,
        });
      }
      for (const entry of deleted) {
        if (!passes(entry)) continue;
        const modules = byId.get(entry.summary.id)?.map((d) => d.module) ?? [];
        keep(
          entry,
          sameCommit
            ? false
            : await releasedHas(entry.summary.id, modules, released),
        );
      }
      // The modules there come ordered already; deleted ones go in among them.
      listed.sort((a, b) => bySummary(a.summary, b.summary));
    }
    const { items, total } = paginate(listed, page);
    return {
      items: await Promise.all(items.map((entry) => complete(entry, snapshot))),
      total,
    };
  }

  /**
   * The modules there, one entry per module ID, from the module index as
   * the reader sees it (#480): no file is read, so the list is made from
   * what Postgres keeps of the commit, and only the page's files are read
   * (`complete`). Ordered as the list is. `changed` compares each file's
   * digest with the released branch's, as the reader sees that.
   */
  private async current(
    snapshot: ReadableContent,
    released: ReadableContent | undefined,
    config: ProjectConfig,
    lang: string | undefined,
  ): Promise<Listed[]> {
    const sameCommit = released?.commit === snapshot.commit;
    const [view, releasedView] = await Promise.all([
      this.index.of(snapshot),
      released && !sameCommit ? this.index.of(released) : undefined,
    ]);
    // What the reader sees on the released branch: each file's digest (null: one that cannot be read).
    const there = new Map<string, string | null>();
    for (const m of releasedView?.modules ?? []) {
      there.set(`${m.lang}/${m.id}`, m.meta ? (m.digest ?? null) : null);
    }
    const differs = (files: readonly IndexedModule[]): boolean =>
      released === undefined ||
      files.some((m) => {
        const digest = there.get(`${m.lang}/${m.id}`);
        return (
          digest === undefined ||
          digest === null ||
          m.digest === undefined ||
          m.digest !== digest
        );
      });
    const listed: Listed[] = [];
    // By ID, then language: a module's files come one after the other.
    const readable = view.modules.filter((m) => m.meta !== undefined);
    for (let start = 0; start < readable.length;) {
      const id = (readable[start] as IndexedModule).id;
      let end = start;
      while (end < readable.length && readable[end]?.id === id) end++;
      const files = readable.slice(start, end);
      start = end;
      const summary = summarize(
        id,
        files.map((m) => ({ lang: m.lang, meta: metaOf(m) })),
        config,
        lang,
      );
      if (!summary) continue;
      listed.push({
        summary: { ...summary, changed: sameCommit ? false : differs(files) },
        files: files.map((m) => ({ lang: m.lang, meta: metaOf(m) })),
        fromIndex: true,
      });
    }
    return listed.sort((a, b) => bySummary(a.summary, b.summary));
  }

  /**
   * The deleted modules' files listed (#418, as #410 lists deleted
   * manuals): each as `deletedModules` gives it to a reader of drafts whose
   * draft scopes show it alike (the ref read as a draft, or
   * `content.read.draft` showing the same last version of that file); the
   * others only when released content holds exactly their last version, as
   * the actor reads it at the newest released commit that does (`main`'s
   * head, then the release tags, newest first). Newest deletion first.
   */
  private async deleted(
    actor: Actor,
    snapshot: ReadableContent,
  ): Promise<SeenDeletedModule[]> {
    const { files } = await snapshot.deletedModules(HISTORY_WINDOW);
    const drafts = snapshot.asDrafts();
    if (drafts === snapshot) return [...files];
    const key = (file: SeenDeletedModule) => `${file.lang}/${file.id}`;
    const asDrafts = new Map(
      (drafts ? (await drafts.deletedModules(HISTORY_WINDOW)).files : []).map(
        (file) => [key(file), file.revision],
      ),
    );
    // Equal revisions, equal files: the draft scope sees this very version.
    const sameAsDraft = (file: SeenDeletedModule): boolean =>
      asDrafts.get(key(file)) === file.revision;
    const rest = files.filter((file) => !sameAsDraft(file));
    const released =
      rest.length === 0
        ? []
        : await openReleased(this.refs, this.openSnapshot, actor);
    const held = await heldInReleased(released, rest, async (content, file) => {
      const module = await content.moduleWithFile(
        file.id,
        file.lang,
        file.revision,
      );
      return module && { ...file, module };
    });
    const found = new Map(
      held.flatMap((file) => (file ? [[key(file), file] as const] : [])),
    );
    return files.flatMap((file) => {
      if (sameAsDraft(file)) return [file];
      const listed = found.get(key(file));
      return listed ? [listed] : [];
    });
  }
}

/** How many lists of module summaries are kept (per commit, reader, released branch and `lang`). */
export const SUMMARY_VIEWS_KEPT = 32;

/** One language of a module: what the list filters and sorts by. */
interface FileMeta {
  readonly lang: string;
  readonly meta: NonNullable<IndexedModule['meta']>;
}

/** A module listed: its summary and its files' metadata, for filtering. */
interface Listed {
  /** For a module there (`fromIndex`), without `text` and `variants` until `complete` reads them. */
  readonly summary: ModuleSummary;
  readonly files: readonly FileMeta[];
  /** Its `text` and `variants` are read from its files once it is on the page. */
  readonly fromIndex?: true;
}

const metaOf = (m: IndexedModule): FileMeta['meta'] =>
  m.meta as FileMeta['meta'];

/** Titles as the list orders them: case and accents aside, then the ID. */
const titles = new Intl.Collator(undefined, { sensitivity: 'base' });
const ids = new Intl.Collator();
const bySummary = (a: ModuleSummary, b: ModuleSummary): number =>
  titles.compare(a.title, b.title) || ids.compare(a.id, b.id);

/** A page's module there, with the start of its text and its variants, read from its files. */
async function complete(
  entry: Listed,
  snapshot: ReadableContent,
): Promise<ModuleSummary> {
  if (!entry.fromIndex) return entry.summary;
  const { id, titleLang } = entry.summary;
  const modules = await Promise.all(
    entry.files.map(async ({ lang }) => {
      try {
        return await snapshot.module(id, lang);
      } catch (error) {
        // The index said it can be read; a file is what it was at the commit.
        if (error instanceof InvalidContentError) return undefined;
        throw error;
      }
    }),
  );
  return {
    ...entry.summary,
    ...details(
      modules.filter((m) => m !== undefined),
      titleLang,
    ),
  };
}

/** The start of the text in `lang`, and what the variant blocks of every language are conditioned on. */
function details(
  modules: readonly Module[],
  lang: string,
): Pick<ModuleSummary, 'text' | 'variants'> {
  const variants = new Set<string>();
  for (const module of modules) {
    for (const { kind, node } of walk(module.blocks)) {
      if (kind === 'block' && node.type === 'variant') {
        collect(node.when, variants);
      }
    }
  }
  const shown = modules.find((m) => m.meta.lang === lang);
  return {
    text: shown ? plainTextExcerpt(shown.blocks) : '',
    variants: [...variants].sort(),
  };
}

/** A summary of the module's files, without `text` and `variants` (`details`). */
function summarize(
  id: string,
  files: readonly FileMeta[],
  config: ProjectConfig,
  lang: string | undefined,
): ModuleSummary | undefined {
  const source = config.languages.source;
  const shown =
    (lang === undefined
      ? (files.find((m) => m.lang === source) ?? files[0])
      : files.find((m) => m.lang === lang)) ?? undefined;
  if (!shown) return undefined;
  const deprecated = (files.find((m) => m.lang === source) ?? shown).meta
    .deprecated;
  const languages = files
    .map((m) => m.lang)
    .sort((a, b) =>
      a === source ? -1 : b === source ? 1 : a.localeCompare(b),
    );
  return {
    id,
    title: shown.meta.title,
    titleLang: shown.lang,
    moduleType: shown.meta.type,
    audience: shown.meta.audience,
    facets: shown.meta.facets,
    keywords: [...(shown.meta.keywords ?? [])],
    languages,
    variants: [],
    changed: true,
    text: '',
    ...(deprecated && { deprecated }),
  };
}

function collect(condition: Condition, into: Set<string>): void {
  switch (condition.op) {
    case 'all':
    case 'any':
      condition.of.forEach((c) => collect(c, into));
      return;
    case 'not':
      collect(condition.of, into);
      return;
    case 'in':
      condition.values.forEach((v) => into.add(`${condition.attr}=${v}`));
      return;
    case 'cmp':
      into.add(`${condition.attr}${condition.cmp}${condition.value}`);
  }
}

function matches(
  entry: Listed,
  filter: ModuleSummaryFilter,
  audiences: readonly string[],
): boolean {
  const { summary, files } = entry;
  if (filter.ids !== undefined && !filter.ids.has(summary.id)) {
    return false;
  }
  const shown = {
    type: summary.moduleType,
    audience: summary.audience,
    facets: summary.facets,
  };
  if (!matchesClassification(shown, filter, audiences)) return false;
  if (filter.keywords?.length) {
    const languages =
      filter.lang === undefined
        ? files
        : files.filter((m) => m.lang === filter.lang);
    if (!languages.some((m) => hasKeywords(foldedKeywords(m.meta), filter))) {
      return false;
    }
  }
  if (filter.q !== undefined) {
    const q = filter.q.toLocaleLowerCase();
    return (
      summary.id.includes(q) ||
      files.some((m) => m.meta.title.toLocaleLowerCase().includes(q))
    );
  }
  return true;
}

/**
 * Whether `released` has the deleted module in a language deleted (as the reader sees it there):
 * its deletion is then a change from the released content. Without `released`, every module
 * counts as changed.
 */
async function releasedHas(
  id: string,
  modules: readonly Module[],
  released: ReadableContent | undefined,
): Promise<boolean> {
  if (!released) return true;
  const found = await Promise.all(
    modules.map(async (module) => {
      try {
        return (await released.module(id, module.meta.lang)) !== undefined;
      } catch (error) {
        // A released file that cannot be read is there, and this one is not.
        if (error instanceof InvalidContentError) return true;
        throw error;
      }
    }),
  );
  return found.includes(true);
}
