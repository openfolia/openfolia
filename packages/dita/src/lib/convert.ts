import {
  assetRefOf,
  CURRENT_IMPORT_FORMAT_VERSION,
  DEFAULT_DITA_MAPPING,
  ditaMappingIssues,
  type ImportDocument,
  IMPORT_ASSETS_FOLDER,
  IMPORT_DOCUMENT_PATH,
  type Manifest,
  type Module,
  type ProjectConfig,
  walk,
} from '@openfolia/content-model';
import type { XmlElement } from '@openfolia/xml';
import { Conrefs, ExpansionBudget, ExpansionLimitError } from './conref.js';
import { attr, elements, nameOf, pushAll } from './elements.js';
import { moduleIds } from './ids.js';
import { isMapReference, KeySpace, referencedMap } from './keys.js';
import { type DitaDoc, loadProject, type Project } from './load.js';
import { ManualBudget, MapConverter } from './map.js';
import { extensionOf, resolvePath, splitReference } from './paths.js';
import { type Ditaval, Profiling, readDitaval } from './profiling.js';
import { DitaReport } from './report.js';
import { type ImportContext, TopicConverter, type XrefFixup } from './topic.js';

/** The source system the import names in the bundle and in each module's `meta.source`. */
export const DITA_SOURCE_SYSTEM = 'DITA';

/** The most report entries the bundle carries; the rest are counted in one more entry. */
export const MAX_REPORT_ENTRIES = 5_000;

export interface DitaConversion {
  /** `import.json`, the documented import format. */
  readonly document: ImportDocument;
  /** The files the modules show, by `sha256:<hash>`. */
  readonly assets: ReadonlyMap<string, Uint8Array>;
}

const DITA_EXTENSIONS = new Set([
  '.dita',
  '.xml',
  '.ditamap',
  '.bookmap',
  '.ditaval',
]);

/**
 * A DITA 1.3 project (the files of its archive, by path) as an import
 * bundle's content, against the target's configuration and its DITA mapping
 * (`dita` in `openfolia.yaml`, else the defaults): its top-level topics as
 * modules (translations from folders named as configured languages), its
 * root maps as manuals, its DITAVAL files as their variants, the images its
 * topics show as files. What has no counterpart is in `document.report`.
 * Pure: reads nothing but `files`, and is deterministic, so the same project
 * gives the same bundle (and a second import updates what the first made).
 */
export async function convertDita(
  files: ReadonlyMap<string, Uint8Array>,
  config: ProjectConfig,
): Promise<DitaConversion> {
  const report = new DitaReport();
  const mapping = config.dita ?? DEFAULT_DITA_MAPPING;
  for (const issue of ditaMappingIssues(mapping, config)) {
    report.add(
      'mapping',
      { source: 'openfolia.yaml', kind: `dita.${issue.path}` },
      `${issue.message} The import uses its default there.`,
    );
  }
  const project = loadProject(files, config.languages, report);
  const assetRefs = new Map<string, string>();
  for (const [path, bytes] of files) {
    if (DITA_EXTENSIONS.has(extensionOf(path))) continue;
    assetRefs.set(path, await assetRefOf(bytes));
  }
  const profiling = new Profiling(mapping, config);
  const usedAssets = new Set<string>();
  const readFiles = new Set<string>();
  const xrefs: XrefFixup[] = [];

  const docs = [...project.docs.values()];
  const topics = docs.filter((d) => d.kind === 'topic');
  const keysOf = (doc: DitaDoc) =>
    doc.modules.length > 1
      ? doc.modules.map((t) => `${doc.rel}#${t.id}`)
      : [doc.rel];
  const ids = moduleIds(topics.flatMap(keysOf));
  const moduleOf = (rel: string, topicId: string | undefined) =>
    (topicId !== undefined ? ids.get(`${rel}#${topicId}`) : undefined) ??
    ids.get(rel);

  const ctx: ImportContext = {
    project,
    config,
    mapping,
    profiling,
    report,
    assetRefs,
    usedAssets,
    readFiles,
    moduleOf,
    xrefs,
  };

  // Maps: the source language's root maps are manuals; any language's give its topics their keys.
  const maps = docs.filter((d) => d.kind === 'map');
  const referenced = new Set<string>();
  for (const map of maps) {
    const stack = elements(map.root);
    while (stack.length > 0) {
      const e = stack.pop() as XmlElement;
      if (isMapReference(e)) {
        const sub = referencedMap(project, map, e);
        if (sub) referenced.add(sub.path);
      }
      pushAll(stack, elements(e));
    }
  }
  const roots = maps.filter((m) => !referenced.has(m.path));
  const spaces = new Map<string, KeySpace>();
  for (const map of roots)
    spaces.set(map.path, new KeySpace(project, map, report));
  // Each topic's key space: the first root map (by path) of its language that references it.
  const topicSpace = new Map<string, KeySpace>();
  for (const map of roots) {
    const space = spaces.get(map.path) as KeySpace;
    for (const m of space.maps) {
      for (const path of referencedTopics(project, m, space)) {
        if (!topicSpace.has(path)) topicSpace.set(path, space);
      }
    }
  }
  const sourceRoots = roots.filter((m) => m.lang === config.languages.source);
  for (const map of roots) {
    if (map.lang !== config.languages.source) {
      report.add(
        'translated-map',
        { source: map.path, kind: map.root.local },
        `A map in "${map.lang}" is no manual of its own (a manual has one title, in the source language); its keys are used for its topics, and its titles are not imported.`,
      );
    }
  }
  const spaceFor = (doc: DitaDoc): KeySpace | undefined => {
    const own = topicSpace.get(doc.path);
    if (own) return own;
    const firstRoot = roots.find((m) => m.lang === doc.lang) ?? sourceRoots[0];
    return firstRoot && spaces.get(firstRoot.path);
  };

  // Modules: the source language first, then the translations.
  const budget = new ExpansionBudget();
  const modules = new Map<string, Module>();
  const anchors = new Map<string, ReadonlyMap<string, string>>();
  const ordered = [...topics].sort((a, b) =>
    a.lang === b.lang
      ? a.path < b.path
        ? -1
        : 1
      : a.lang === config.languages.source
        ? -1
        : b.lang === config.languages.source
          ? 1
          : a.lang < b.lang
            ? -1
            : 1,
  );
  for (const doc of ordered) {
    const keys = spaceFor(doc);
    for (const topic of doc.modules) {
      const id = moduleOf(doc.rel, topic.id);
      if (id === undefined) continue;
      if (
        doc.lang !== config.languages.source &&
        !modules.has(`${config.languages.source}/${id}`)
      ) {
        report.add(
          'translation-without-source',
          { source: doc.path, kind: topic.element.local, module: id },
          `There is no "${doc.rel}" in the source language "${config.languages.source}"; the translation is left out.`,
        );
        continue;
      }
      budget.startModule();
      try {
        const expanded = new Conrefs(project, keys, report, budget).expand(
          topic.element,
          doc,
          topic,
        );
        const converter = new TopicConverter(ctx, doc, id, keys, budget);
        const module = converter.module(topic, expanded);
        modules.set(`${doc.lang}/${id}`, module);
        anchors.set(`${doc.lang}/${id}`, converter.anchors);
      } catch (error) {
        if (!(error instanceof ExpansionLimitError)) throw error;
        report.add(
          'expansion-limit',
          { source: doc.path, kind: topic.element.local, module: id },
          `${error.message} The topic is left out.`,
        );
      }
    }
  }

  // Translations keep their source's blocks.
  for (const [key, module] of modules) {
    if (module.meta.lang === config.languages.source) continue;
    const source = modules.get(`${config.languages.source}/${module.id}`);
    if (!source) continue;
    const own = new Set([...walk(module.blocks)].map((n) => n.node.id));
    const theirs = new Set([...walk(source.blocks)].map((n) => n.node.id));
    const missing = [...theirs].filter((id) => !own.has(id)).length;
    const extra = [...own].filter((id) => !theirs.has(id)).length;
    if (missing > 0 || extra > 0) {
      report.add(
        'translation-structure',
        { source: key, kind: 'topic', module: module.id },
        `The translation's structure differs from its source's (${missing} blocks of the source it lacks, ${extra} of its own): those blocks are not matched as translations of each other. Give their elements the same @id in both languages.`,
      );
    }
  }

  // Cross-references to blocks, now every module's blocks are known:
  // by module ID, each language's anchors (in the order converted).
  const anchorsByModule = new Map<string, ReadonlyMap<string, string>[]>();
  for (const [key, own] of anchors) {
    const id = key.slice(key.indexOf('/') + 1);
    const list = anchorsByModule.get(id) ?? [];
    list.push(own);
    anchorsByModule.set(id, list);
  }
  for (const fix of xrefs) {
    const key =
      fix.elementId === undefined
        ? fix.topicId
        : `${fix.topicId}/${fix.elementId}`;
    const found = (anchorsByModule.get(fix.node.module) ?? [])
      .map((a) => a.get(key))
      .find((b) => b !== undefined);
    if (found !== undefined) {
      (fix.node as { block?: string }).block = found;
    } else {
      report.add(
        'unresolved-xref',
        fix.place,
        `The link names "${key}", which is no block of the module "${fix.node.module}" (an inline element, or one left out); it links to the module.`,
      );
    }
  }

  // DITAVAL files, and which maps name them.
  const ditavals = new Map<string, Ditaval>();
  for (const doc of docs) {
    if (doc.kind === 'ditaval')
      ditavals.set(doc.path, readDitaval(doc.path, doc.root, report));
  }
  const named = new Set<string>();
  for (const map of maps) {
    const stack = elements(map.root);
    while (stack.length > 0) {
      const e = stack.pop() as XmlElement;
      if (nameOf(e) === 'ditavalref') {
        const ref = splitReference(attr(e, 'href') ?? '');
        const path =
          ref && ref.path !== '' ? resolvePath(map.path, ref.path) : undefined;
        if (path !== undefined) named.add(path);
      }
      pushAll(stack, elements(e));
    }
  }
  const unnamed = [...ditavals.values()].filter((d) => !named.has(d.path));
  if (mapping.ditavalDefault === 'none') {
    for (const d of unnamed) {
      report.add(
        'ditaval-unreferenced',
        { source: d.path, kind: 'val' },
        'No map names this DITAVAL file (<ditavalref>), so it is not applied. Name it in a map, or set "dita.ditavalDefault: all" to make it a variant of every manual.',
      );
    }
  }
  const everywhere = mapping.ditavalDefault === 'all' ? unnamed : [];

  // Manuals.
  const manualIds = moduleIds(sourceRoots.map((m) => m.rel));
  const manuals: Manifest[] = [];
  const manualBudget = new ManualBudget();
  for (const map of sourceRoots) {
    const id = manualIds.get(map.rel) as string;
    try {
      const manual = new MapConverter(
        ctx,
        spaces.get(map.path) as KeySpace,
        id,
        manualBudget,
      ).manual(map, ditavals, everywhere);
      if (manual) manuals.push(manual);
    } catch (error) {
      if (!(error instanceof ExpansionLimitError)) throw error;
      report.add(
        'expansion-limit',
        { source: map.path, kind: map.root.local },
        `${error.message} The manual is left out.`,
      );
    }
  }

  // Files nothing uses.
  const unused = [...assetRefs.entries()]
    .filter(([path, ref]) => !usedAssets.has(ref) && !readFiles.has(path))
    .map(([path]) => path);
  if (unused.length > 0) {
    report.add(
      'unused-file',
      { source: 'archive', kind: 'file' },
      `${unused.length} files of the archive are no DITA file and no image a topic shows; they are not imported: ${unused.slice(0, 20).join(', ')}${unused.length > 20 ? ', …' : ''}.`,
    );
  }

  const assets = new Map<string, Uint8Array>();
  for (const [path, ref] of assetRefs) {
    if (usedAssets.has(ref) && !assets.has(ref))
      assets.set(ref, files.get(path) as Uint8Array);
  }
  const entries = report.toEntries();
  const kept = entries.slice(0, MAX_REPORT_ENTRIES);
  if (entries.length > kept.length) {
    kept.push({
      sourceId: 'archive',
      message: `[report] ${entries.length - kept.length} more report entries are left out.`,
    });
  }
  const document: ImportDocument = {
    formatVersion: CURRENT_IMPORT_FORMAT_VERSION,
    source: {
      system: DITA_SOURCE_SYSTEM,
      description: `A DITA project read as DITA 1.3: ${modules.size} topics, ${manuals.length} maps.`,
    },
    modules: [...modules.values()],
    manuals,
    report: kept,
  };
  return { document, assets };
}

/** A bundle's `import.json` past the largest an import reads (`bundleFiles`' `maxDocumentBytes`). */
export class DocumentTooLargeError extends Error {
  constructor(readonly max: number) {
    super(`The import document is larger than ${max} bytes.`);
    this.name = 'DocumentTooLargeError';
  }
}

/**
 * The bundle of a conversion: `import.json` and `assets/<sha256>`, as the
 * import reads it. With `maxDocumentBytes`, a larger `import.json` is a
 * `DocumentTooLargeError`, refused before it is encoded.
 */
export function bundleFiles(
  conversion: DitaConversion,
  { maxDocumentBytes }: { maxDocumentBytes?: number } = {},
): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const json = JSON.stringify(conversion.document);
  // A character is at least one byte: past the bound in characters, past it in bytes.
  if (maxDocumentBytes !== undefined && json.length > maxDocumentBytes) {
    throw new DocumentTooLargeError(maxDocumentBytes);
  }
  const document = new TextEncoder().encode(json);
  if (maxDocumentBytes !== undefined && document.length > maxDocumentBytes) {
    throw new DocumentTooLargeError(maxDocumentBytes);
  }
  files.set(IMPORT_DOCUMENT_PATH, document);
  for (const [ref, bytes] of conversion.assets) {
    files.set(`${IMPORT_ASSETS_FOLDER}${ref.slice('sha256:'.length)}`, bytes);
  }
  return files;
}

/** The topic files a map references, directly or by key. */
function referencedTopics(
  project: Project,
  map: DitaDoc,
  keys: KeySpace,
): string[] {
  const out: string[] = [];
  const stack = [...elements(map.root)].reverse();
  while (stack.length > 0) {
    const e = stack.pop() as XmlElement;
    if (isMapReference(e)) continue;
    const href = attr(e, 'href');
    const keyref = attr(e, 'keyref');
    let path: string | undefined;
    if (href !== undefined) {
      const ref = splitReference(href);
      path =
        ref && ref.path !== '' ? resolvePath(map.path, ref.path) : undefined;
    } else if (keyref !== undefined) {
      path = keys.get(keyref)?.target?.path;
    }
    if (path !== undefined && project.docs.get(path)?.kind === 'topic')
      out.push(path);
    pushAll(stack, [...elements(e)].reverse());
  }
  return out;
}
