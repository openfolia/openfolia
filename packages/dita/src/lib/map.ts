import type {
  AttributeValue,
  Condition,
  Manifest,
  ManifestEntry,
  VariantValues,
} from '@openfolia/content-model';
import type { XmlElement } from '@openfolia/xml';
import {
  attr,
  child,
  collapse,
  elements,
  nameOf,
  pushAll,
  textOf,
} from './elements.js';
import {
  isMapReference,
  keyText,
  type KeySpace,
  referencedMap,
  textWithKeys,
} from './keys.js';
import { ExpansionLimitError } from './conref.js';
import type { DitaDoc, TopicIndex } from './load.js';
import {
  baseName,
  extensionOf,
  hasScheme,
  resolvePath,
  splitReference,
} from './paths.js';
import {
  type Ditaval,
  leastRestricted,
  profileOf,
  variantOf,
} from './profiling.js';
import type { DitaReportCode } from './report.js';
import { type ImportContext, relOf } from './topic.js';

/** Elements of a map that hold entries (`<topicref>` and its specialisations). */
// prettier-ignore
const REFERENCES = new Set([
  'topicref', 'chapter', 'appendix', 'appendices', 'part', 'preface',
  'notices', 'amendments', 'colophon', 'dedication', 'draftintro',
  'bookabstract', 'topichead', 'topicgroup', 'topicset', 'topicsetref',
  'frontmatter', 'backmatter', 'glossref', 'mapref',
]);

/** A bookmap's generated lists: no counterpart (the outputs make their own contents). */
// prettier-ignore
const GENERATED = new Set([
  'booklists', 'toc', 'figurelist', 'tablelist', 'abbrevlist',
  'trademarklist', 'bibliolist', 'glossarylist', 'indexlist', 'booklist',
]);

/** Elements of a map with nothing for a manual. */
const IGNORED = new Set([
  'title',
  'topicmeta',
  'booktitle',
  'bookmeta',
  'keydef',
  'ditavalref',
]);

const and = (a: Condition | undefined, b: Condition | undefined) =>
  a && b ? ({ op: 'all', of: [a, b] } as Condition) : (a ?? b);

/** The most manual entries one import makes, every copy a submap or condition makes included. */
export const MAX_MANUAL_ENTRIES = 200_000;
/** The most characters of entry titles one import's manuals hold (a title is written out with every entry). */
export const MAX_MANUAL_TITLE_CHARS = 16 * 1024 * 1024;
/** The deepest submaps nest (a map in a map in a map...). */
export const MAX_MAP_DEPTH = 32;
/** The most map elements one import's manuals walk, every submap followed included. */
export const MAX_MAP_VISITS = 1_000_000;

/** What a walk of maps cost: entries made, title characters, elements walked. */
export interface ManualCost {
  readonly entries: number;
  readonly chars: number;
  readonly visits: number;
}

/**
 * What one import's manuals may make: a submap named many times is followed
 * every time, so a fan-out of submaps multiplies; past the bound, the manual
 * being made is left out (`expansion-limit`).
 */
export class ManualBudget {
  private entries = 0;
  private chars = 0;
  private visits = 0;

  /** What was charged so far: a submap's expansion cost is the difference. */
  get charged(): ManualCost {
    return { entries: this.entries, chars: this.chars, visits: this.visits };
  }

  /** One map element walked (or `count`, a reused submap's), whatever it yields. */
  visit(count = 1): void {
    this.visits += count;
    if (this.visits > MAX_MAP_VISITS) {
      throw new ExpansionLimitError(
        `The maps of this import have more than ${MAX_MAP_VISITS} elements to walk (all together, submaps followed included).`,
      );
    }
  }

  spend(entries: number, chars = 0): void {
    this.entries += entries;
    this.chars += chars;
    if (this.entries > MAX_MANUAL_ENTRIES) {
      throw new ExpansionLimitError(
        `The maps of this import make more than ${MAX_MANUAL_ENTRIES} manual entries (all its manuals together).`,
      );
    }
    if (this.chars > MAX_MANUAL_TITLE_CHARS) {
      throw new ExpansionLimitError(
        `The entry titles of this import's manuals hold more than ${MAX_MANUAL_TITLE_CHARS} characters (all together).`,
      );
    }
  }
}

/**
 * A root map (or bookmap) as a manual: its title and audience, its
 * `<topicref>`s as entries (a reference with children as a group titled
 * after it, holding its module and then its children; a `<topichead>` as a
 * group; a `<topicgroup>` or other untitled container's children in its
 * place), submaps in place, each reference's condition as its entry's
 * `when`, the DITAVAL files it names (`<ditavalref>`) as its variants, and
 * the text keys it defines as text attribute values.
 */
export class MapConverter {
  private readonly seen = new Set<string>();
  /** Each topic's title, made once however many references name it. */
  private readonly titles = new WeakMap<XmlElement, string | undefined>();
  /**
   * Each submap's entries, made once however many references reach it (a
   * DAG of submaps would be walked once per path), and what they cost, charged
   * again at every reuse.
   */
  /** Walks cut short so far (a cycle, the depth bound). */
  private cuts = 0;
  private readonly submaps = new Map<
    string,
    { entries: ManifestEntry[]; cost: ManualCost }
  >();
  /** The root map being made a manual: its own `<ditavalref>`s are its variants. */
  private rootPath = '';

  constructor(
    private readonly ctx: ImportContext,
    private readonly keys: KeySpace,
    private readonly manualId: string,
    private readonly budget: ManualBudget,
  ) {}

  manual(
    map: DitaDoc,
    ditavals: ReadonlyMap<string, Ditaval>,
    everywhere: readonly Ditaval[],
  ): Manifest | undefined {
    this.seen.add(map.path);
    this.rootPath = map.path;
    const entries = this.entries(map.root, map, undefined);
    if (entries.length === 0) {
      this.note(
        'empty-map',
        map,
        map.root,
        'The map references no topic of the archive; no manual is made of it.',
      );
      return undefined;
    }
    const profile = profileOf(map.root, this.ctx.profiling, this.ctx.report, {
      source: map.path,
      kind: map.root.local,
    });
    if (profile.when) {
      this.note(
        'map-entry',
        map,
        map.root,
        'A condition on the map itself has no counterpart; the manual is for every variant.',
      );
    }
    const audience = leastRestricted(profile.audiences, this.ctx.config);
    const variants = this.variants(map, ditavals, everywhere);
    const attributes = this.attributes();
    return {
      schemaVersion: 1,
      id: this.manualId,
      title: titleOf(map),
      ...(audience !== undefined && { audience }),
      variants,
      attributes,
      entries,
    };
  }

  private variants(
    map: DitaDoc,
    ditavals: ReadonlyMap<string, Ditaval>,
    everywhere: readonly Ditaval[],
  ): VariantValues[] {
    const named: Ditaval[] = [];
    for (const ref of elements(map.root).filter(
      (e) => nameOf(e) === 'ditavalref',
    )) {
      const path = this.resolve(map.path, attr(ref, 'href'));
      const found = path === undefined ? undefined : ditavals.get(path);
      if (found) named.push(found);
      else
        this.note(
          'ditaval-variant',
          map,
          ref,
          `The DITAVAL file "${attr(ref, 'href') ?? ''}" is not in the archive.`,
        );
    }
    // Branch filtering: a <ditavalref> below the map's root.
    const stack = elements(map.root).filter((e) => nameOf(e) !== 'ditavalref');
    while (stack.length > 0) {
      const e = stack.pop() as XmlElement;
      if (nameOf(e) === 'ditavalref') {
        this.note(
          'ditaval-branch',
          map,
          e,
          "Branch filtering (a <ditavalref> below the map's root) has no counterpart; it is not applied.",
        );
        continue;
      }
      pushAll(stack, elements(e));
    }
    const all = [...named, ...everywhere.filter((d) => !named.includes(d))];
    const variants: VariantValues[] = [];
    const keys = new Set<string>();
    for (const ditaval of all) {
      const variant = variantOf(
        ditaval,
        this.ctx.profiling,
        this.ctx.config,
        this.ctx.report,
      );
      const key = JSON.stringify(Object.entries(variant).sort());
      if (keys.has(key)) {
        this.note(
          'duplicate-variant',
          map,
          map.root,
          `The DITAVAL file "${ditaval.path}" describes a variant another one does already; it is used once.`,
        );
        continue;
      }
      keys.add(key);
      variants.push(variant);
    }
    return variants.length > 0 ? variants : [{}];
  }

  private attributes(): Record<string, AttributeValue> {
    const out: Record<string, AttributeValue> = {};
    for (const key of this.keys.keys()) {
      const id = Object.hasOwn(this.ctx.mapping.textKeys, key)
        ? this.ctx.mapping.textKeys[key]
        : key;
      if (
        id === undefined ||
        !this.ctx.config.textAttributes.some((a) => a.id === id)
      )
        continue;
      if (Object.hasOwn(out, id)) continue;
      const def = this.keys.get(key);
      const text = def && keyText(def);
      const value = text ? collapse(textOf(text)) : '';
      if (value !== '') out[id] = value;
    }
    return out;
  }

  private entries(
    container: XmlElement,
    map: DitaDoc,
    outer: Condition | undefined,
  ): ManifestEntry[] {
    const out: ManifestEntry[] = [];
    for (const element of elements(container)) {
      this.budget.visit();
      const name = nameOf(element);
      if (name === 'ditavalref' && map.path !== this.rootPath) {
        this.note(
          'ditaval-branch',
          map,
          element,
          `A <ditavalref> in the submap "${map.path}" filters a branch, which has no counterpart; it is not applied.`,
        );
        continue;
      }
      if (name !== undefined && IGNORED.has(name)) continue;
      if (name === 'reltable') {
        this.note(
          'reltable',
          map,
          element,
          'Relationship tables have no counterpart; the links they make are left out.',
        );
        continue;
      }
      if (name !== undefined && GENERATED.has(name)) {
        this.note(
          'generated-list',
          map,
          element,
          `<${element.local}> asks for a generated list; the outputs make their own contents, so it is left out.`,
        );
        continue;
      }
      if (name === undefined || !REFERENCES.has(name)) {
        this.note(
          'map-entry',
          map,
          element,
          `<${element.local}> in a map has no counterpart; it is left out.`,
        );
        continue;
      }
      pushAll(out, this.reference(element, name, map, outer));
    }
    return out;
  }

  private reference(
    element: XmlElement,
    name: string,
    map: DitaDoc,
    outer: Condition | undefined,
  ): ManifestEntry[] {
    if (attr(element, 'processing-role') === 'resource-only') return [];
    const profile = profileOf(element, this.ctx.profiling, this.ctx.report, {
      source: map.path,
      kind: element.local,
    });
    if (profile.audiences.length > 0) {
      this.note(
        'audience-condition',
        map,
        element,
        "An audience on a map entry has no counterpart (a module's audience is its own); it is left out.",
      );
    }
    const when = profile.when;
    if (isMapReference(element)) {
      const sub = referencedMap(this.ctx.project, map, element);
      if (!sub) {
        this.note(
          'map-entry',
          map,
          element,
          `The map "${attr(element, 'href') ?? ''}" is not in the archive.`,
        );
        return [];
      }
      if (this.seen.size > MAX_MAP_DEPTH) {
        this.note(
          'map-entry',
          map,
          element,
          `Submaps nest more than ${MAX_MAP_DEPTH} deep; "${sub.path}" is not followed.`,
        );
        this.cuts++;
        return [];
      }
      if (this.seen.has(sub.path)) {
        this.note(
          'map-entry',
          map,
          element,
          `The map "${sub.path}" references itself; it is not followed again.`,
        );
        this.cuts++;
        return [];
      }
      const inner = this.submap(sub);
      if (when) this.budget.spend(inner.length);
      return withWhen(inner, when);
    }
    const children = this.entries(element, map, undefined);
    const modules = this.modules(element, map);
    const title = navtitle(element, this.keys) ?? modules.title;
    const own: ManifestEntry[] = [
      ...modules.ids.map((module) => ({ module }) as ManifestEntry),
      ...children,
    ];
    if (own.length === 0) return [];
    this.budget.spend(modules.ids.length);
    const grouped =
      (modules.ids.length > 0 && children.length > 0) ||
      (modules.ids.length === 0 &&
        title !== undefined &&
        name !== 'topicgroup' &&
        name !== 'frontmatter' &&
        name !== 'backmatter');
    if (grouped && title !== undefined) {
      this.budget.spend(1, title.length);
      return [{ title, entries: own, ...(when && { when }) }];
    }
    if (when) this.budget.spend(own.length);
    return withWhen(own, when);
  }

  private submap(sub: DitaDoc): ManifestEntry[] {
    const cached = this.submaps.get(sub.path);
    if (cached) {
      // A reuse costs exactly what walking it again would.
      this.budget.visit(cached.cost.visits);
      this.budget.spend(cached.cost.entries, cached.cost.chars);
      return cached.entries;
    }
    const before = this.budget.charged;
    const cutsBefore = this.cuts;
    this.seen.add(sub.path);
    const entries = this.entries(sub.root, sub, undefined);
    this.seen.delete(sub.path);
    // A walk cut short (a cycle, the depth) depends on the path to it: walked again, never reused.
    if (this.cuts !== cutsBefore) return entries;
    const after = this.budget.charged;
    this.submaps.set(sub.path, {
      entries,
      cost: {
        entries: after.entries - before.entries,
        chars: after.chars - before.chars,
        visits: after.visits - before.visits,
      },
    });
    return entries;
  }

  private topicTitle(topic: XmlElement): string | undefined {
    if (!this.titles.has(topic)) {
      this.titles.set(topic, topicTitleOf(topic, this.keys));
    }
    return this.titles.get(topic);
  }

  /** The modules a reference names (all of a `<dita>` document's without a fragment), and their title. */
  private modules(
    element: XmlElement,
    map: DitaDoc,
  ): { ids: string[]; title?: string } {
    let href = attr(element, 'href');
    const base = map.path;
    // A key's target is a path already (decoded, resolved): never parsed again.
    let keyed:
      { readonly path: string; readonly fragment?: string } | undefined;
    const keyref = attr(element, 'keyref');
    if (keyref !== undefined) {
      const def = this.keys.get(keyref);
      if (def?.target) {
        href = def.target.path;
        keyed = def.target;
      } else if (href === undefined) {
        this.note(
          'unresolved-key',
          map,
          element,
          `The key "${keyref}" names no topic; the entry is left out.`,
        );
        return { ids: [] };
      }
    }
    if (href === undefined) return { ids: [] };
    const format = attr(element, 'format');
    if (attr(element, 'scope') === 'external' || hasScheme(href)) {
      this.note(
        'map-entry',
        map,
        element,
        `"${href}" lies outside the archive; the entry is left out.`,
      );
      return { ids: [] };
    }
    const ref = keyed ?? splitReference(href);
    const path = keyed ? keyed.path : ref && resolvePath(base, ref.path);
    const doc =
      path === undefined ? undefined : this.ctx.project.docs.get(path);
    if (!doc || doc.kind !== 'topic') {
      const other =
        (format !== undefined && format !== 'dita') ||
        (path !== undefined && !['.dita', '.xml'].includes(extensionOf(path)));
      this.note(
        'map-entry',
        map,
        element,
        other && path !== undefined && this.ctx.project.files.has(path)
          ? `"${href}" is no DITA topic; the entry is left out.`
          : `The topic "${href}" is not in the archive; the entry is left out.`,
      );
      return { ids: [] };
    }
    const rel = relOf(this.ctx.project, doc.path);
    if (ref?.fragment === undefined) {
      const ids = doc.modules
        .map((t) => this.ctx.moduleOf(rel, t.id))
        .filter((id): id is string => id !== undefined);
      const first = doc.modules[0];
      return {
        ids,
        ...(first && { title: this.topicTitle(first.element) }),
      };
    }
    const topicId = ref.fragment.split('/')[0] ?? '';
    const top = topLevelById(doc).get(topicId);
    if (!top) {
      this.note(
        'map-entry',
        map,
        element,
        `"${href}" names a nested topic; the entry is its whole module.`,
      );
    }
    const module = this.ctx.moduleOf(rel, (top ?? doc.modules[0])?.id);
    const titled = top ?? doc.modules[0];
    return {
      ids: module === undefined ? [] : [module],
      ...(titled && { title: this.topicTitle(titled.element) }),
    };
  }

  private resolve(from: string, href: string | undefined): string | undefined {
    if (href === undefined) return undefined;
    const ref = splitReference(href);
    return ref && ref.path !== '' ? resolvePath(from, ref.path) : undefined;
  }

  private note(
    code: DitaReportCode,
    map: DitaDoc,
    element: XmlElement,
    message: string,
  ): void {
    this.ctx.report.add(
      code,
      {
        source: `${map.path}${attr(element, 'id') ? `#${attr(element, 'id')}` : ''}`,
        kind: element.local,
      },
      message,
    );
  }
}

function withWhen(
  entries: ManifestEntry[],
  when: Condition | undefined,
): ManifestEntry[] {
  if (!when) return entries;
  return entries.map((e) => ({ ...e, when: and(when, e.when) as Condition }));
}

/** A document's top-level topics by ID (the first of an ID), made once per document. */
const TOP_LEVEL = new WeakMap<DitaDoc, Map<string, TopicIndex>>();
function topLevelById(doc: DitaDoc): Map<string, TopicIndex> {
  let found = TOP_LEVEL.get(doc);
  if (!found) {
    found = new Map();
    for (const topic of doc.modules) {
      if (!found.has(topic.id)) found.set(topic.id, topic);
    }
    TOP_LEVEL.set(doc, found);
  }
  return found;
}

/** A reference's own title: `<topicmeta><navtitle>`, else `@navtitle`. */
function navtitle(element: XmlElement, keys: KeySpace): string | undefined {
  const meta = child(element, 'topicmeta');
  const nav = meta && child(meta, 'navtitle');
  const text = collapse(
    nav ? textWithKeys(nav, keys) : (attr(element, 'navtitle') ?? ''),
  );
  return text === '' ? undefined : text;
}

function topicTitleOf(topic: XmlElement, keys: KeySpace): string | undefined {
  const title = child(topic, 'title');
  const text = title ? collapse(textWithKeys(title, keys)) : '';
  return text === '' ? undefined : text;
}

/** A map's title: a bookmap's main title, else `<title>`, else `@title`, else its file name. */
export function titleOf(map: DitaDoc): string {
  const booktitle = child(map.root, 'booktitle');
  const main = booktitle && child(booktitle, 'mainbooktitle');
  const title = child(map.root, 'title');
  const text = collapse(
    main
      ? textOf(main)
      : title
        ? textOf(title)
        : (attr(map.root, 'title') ?? ''),
  );
  return text === '' ? baseName(map.path) : text;
}
