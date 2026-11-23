import {
  readXml,
  type XmlElement,
  type XmlLimits,
  XmlReadError,
} from '@openfolia/xml';
import {
  attr,
  DITA_ARCH_NAMESPACE,
  elements,
  isTopic,
  langOf,
  nameOf,
  pushAll,
} from './elements.js';
import { extensionOf } from './paths.js';
import type { DitaReport } from './report.js';

/** The extensions of the files the import reads as DITA. */
const DITA_EXTENSIONS = new Set(['.dita', '.xml', '.ditamap', '.bookmap']);
const DITAVAL_EXTENSION = '.ditaval';

/**
 * What one DITA file may hold: at most 8 Mi characters, elements 64 deep,
 * 1,000,000 nodes, 64 attributes per element. Every file of an import is
 * read within the import's own bounds on the archive too.
 */
export const DITA_XML_LIMITS: XmlLimits = {
  maxLength: 8 * 1024 * 1024,
  maxDepth: 64,
  maxNodes: 1_000_000,
  maxAttributes: 64,
};

export type DocKind = 'topic' | 'map' | 'ditaval';

/** One DITA file, read. */
export interface DitaDoc {
  /** Its path in the archive. */
  readonly path: string;
  /** Its language: its language folder's, else the source language. */
  readonly lang: string;
  /** Its path within its language folder (the whole path without one). */
  readonly rel: string;
  readonly kind: DocKind;
  readonly root: XmlElement;
  /** The topics in it by `@id` (one, or the children of a `<dita>`), with their elements by `@id`. */
  readonly topics: ReadonlyMap<string, TopicIndex>;
  /** The first topic: what a reference to the file without a fragment names. */
  readonly firstTopic: TopicIndex | undefined;
  /** The top-level topics: one module each. */
  readonly modules: readonly TopicIndex[];
}

export interface TopicIndex {
  readonly id: string;
  readonly element: XmlElement;
  /** Its elements by `@id`, not those of a nested topic. */
  readonly byId: ReadonlyMap<string, XmlElement>;
  /** Whether it is a top-level topic (a module of its own) rather than a nested one. */
  readonly topLevel: boolean;
}

/** The archive, read: DITA files by path, the other files, the language folders. */
export interface Project {
  readonly docs: ReadonlyMap<string, DitaDoc>;
  /** Every file by path, as uploaded (images are taken from here). */
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly sourceLanguage: string;
  /** The language folders found (`en` → `en`, `de-de` → `de-DE`), by folder name. */
  readonly languageFolders: ReadonlyMap<string, string>;
  /** Each element's parent, for a conref range's siblings. */
  readonly parents: WeakMap<XmlElement, XmlElement>;
}

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Reads every DITA file of the archive with the strict reader (`readXml`:
 * no DTD read, nothing fetched, no entity expanded, bounded), accepting a
 * DOCTYPE with an external identifier only (every DITA file names its DTD;
 * the import never opens it). A file it cannot read is reported and left
 * out; the rest are imported.
 */
export function loadProject(
  files: ReadonlyMap<string, Uint8Array>,
  languages: { source: string; targets: readonly string[] },
  report: DitaReport,
): Project {
  const configured = new Map(
    [languages.source, ...languages.targets].map((tag) => [
      tag.toLowerCase(),
      tag,
    ]),
  );
  // Top-level folders named as a configured language, among those holding DITA files.
  const languageFolders = new Map<string, string>();
  for (const path of files.keys()) {
    const ext = extensionOf(path);
    if (!DITA_EXTENSIONS.has(ext) && ext !== DITAVAL_EXTENSION) continue;
    const slash = path.indexOf('/');
    if (slash === -1) continue;
    const folder = path.slice(0, slash);
    const tag = configured.get(folder.toLowerCase());
    if (tag !== undefined) languageFolders.set(folder, tag);
  }
  const parents = new WeakMap<XmlElement, XmlElement>();
  const docs = new Map<string, DitaDoc>();
  const paths = [...files.keys()].sort();
  for (const path of paths) {
    const ext = extensionOf(path);
    if (!DITA_EXTENSIONS.has(ext) && ext !== DITAVAL_EXTENSION) continue;
    const slash = path.indexOf('/');
    const folder = slash === -1 ? undefined : path.slice(0, slash);
    const folderLang =
      folder === undefined ? undefined : languageFolders.get(folder);
    const lang = folderLang ?? languages.source;
    const rel = folderLang === undefined ? path : path.slice(slash + 1);
    const root = parse(path, files.get(path) as Uint8Array, report);
    if (!root) continue;
    const kind = kindOf(root);
    if (!kind) {
      // A `.xml` file may be anything (an image's metadata, a config).
      if (ext !== '.xml') {
        report.add(
          'not-dita',
          { source: path, kind: root.local },
          `The root element <${root.local}> is no DITA topic, map or DITAVAL; the file is left out.`,
        );
      }
      continue;
    }
    const version = root.attributes.get(
      `{${DITA_ARCH_NAMESPACE}}DITAArchVersion`,
    );
    if (version !== undefined && !/^1\.[0-3]$/.test(version.trim())) {
      report.add(
        'dita-version',
        { source: path, kind: root.local },
        `The file declares DITA ${version.trim()}; it is read as DITA 1.3 (elements DITA 1.3 does not have are reported).`,
      );
    }
    const declared = langOf(root);
    if (
      kind !== 'ditaval' &&
      declared !== undefined &&
      declared.toLowerCase() !== lang.toLowerCase() &&
      declared.split('-')[0]?.toLowerCase() !== lang.toLowerCase()
    ) {
      report.add(
        'language',
        { source: path, kind: root.local },
        folderLang === undefined
          ? `The file is in "${declared}" (xml:lang) but lies in no language folder; it is imported as the source language "${lang}". Put translations in folders named as their languages (e.g. "de/").`
          : `The file is in "${declared}" (xml:lang) but lies in the "${folder}" folder; it is imported as "${lang}".`,
      );
    }
    indexParents(root, parents);
    const { topics, modules } = indexTopics(root, kind);
    docs.set(path, {
      path,
      lang,
      rel,
      kind,
      root,
      topics,
      firstTopic: modules[0],
      modules,
    });
  }
  return {
    docs,
    files,
    sourceLanguage: languages.source,
    languageFolders,
    parents,
  };
}

function parse(
  path: string,
  bytes: Uint8Array,
  report: DitaReport,
): XmlElement | undefined {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    report.add(
      'unsupported-encoding',
      { source: path, kind: 'file' },
      'The file is not UTF-8; it is left out. Save it as UTF-8.',
    );
    return undefined;
  }
  try {
    return readXml(text, DITA_XML_LIMITS, { doctype: 'external-id' });
  } catch (error) {
    if (!(error instanceof XmlReadError)) throw error;
    const code =
      error.reason === 'dtd-forbidden'
        ? 'dtd-subset'
        : error.reason === 'unsupported-encoding'
          ? 'unsupported-encoding'
          : error.reason === 'not-well-formed'
            ? 'not-well-formed'
            : 'too-large';
    report.add(
      code,
      { source: path, kind: 'file' },
      `The file is left out: ${error.message}`,
    );
    return undefined;
  }
}

function kindOf(root: XmlElement): DocKind | undefined {
  const name = nameOf(root);
  if (name === 'val') return 'ditaval';
  if (
    name === 'map' ||
    name === 'bookmap' ||
    attr(root, 'class')?.includes(' map/map ')
  ) {
    return 'map';
  }
  if (name === 'dita' || isTopic(root)) return 'topic';
  return undefined;
}

function indexParents(
  root: XmlElement,
  parents: WeakMap<XmlElement, XmlElement>,
): void {
  const stack = [root];
  while (stack.length > 0) {
    const element = stack.pop() as XmlElement;
    for (const c of elements(element)) {
      parents.set(c, element);
      stack.push(c);
    }
  }
}

function indexTopics(
  root: XmlElement,
  kind: DocKind,
): { topics: Map<string, TopicIndex>; modules: TopicIndex[] } {
  const topics = new Map<string, TopicIndex>();
  const modules: TopicIndex[] = [];
  if (kind !== 'topic') return { topics, modules };
  const tops =
    nameOf(root) === 'dita' ? elements(root).filter(isTopic) : [root];
  const visit = (topic: XmlElement, topLevel: boolean) => {
    const byId = new Map<string, XmlElement>();
    const nested: XmlElement[] = [];
    const stack = [...elements(topic)].reverse();
    while (stack.length > 0) {
      const element = stack.pop() as XmlElement;
      if (isTopic(element)) {
        nested.push(element);
        continue;
      }
      const id = attr(element, 'id');
      if (id !== undefined && !byId.has(id)) byId.set(id, element);
      pushAll(stack, [...elements(element)].reverse());
    }
    const id = attr(topic, 'id') ?? '';
    const index: TopicIndex = { id, element: topic, byId, topLevel };
    if (!topics.has(id)) topics.set(id, index);
    if (topLevel) modules.push(index);
    for (const n of nested) visit(n, false);
  };
  for (const top of tops) visit(top, true);
  return { topics, modules };
}
