// The scale generator's content: the configuration, modules (every block type the editor uses,
// with module references, cross-references and variant blocks), manuals, terms, translations and
// the edits that make the history. Everything is made as content-model objects, checked with the
// content model's own validators and printed with its printers, so the files are what the API
// itself writes ("valid by construction"). Deterministic: the same profile, the same files.

import {
  Module,
  parseConfig,
  ProjectConfig,
  printConfig,
  printManifest,
  printModule,
  printTranslationRecord,
  translationRecordOf,
  validateManifest,
  validateModule,
} from '@openfolia/content-model';
import {
  ADJECTIVES,
  NOUNS,
  Random,
  VERBS,
  capitalise,
  paragraphText,
  pseudoTranslate,
  sentence,
  title,
} from './random.mjs';

export const SOURCE_LANG = 'en';
/** The product facet: releases are cut per product (`release.productFacet`). */
export const PRODUCT_FACET = 'product-line';
export const PRODUCTS = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
const REGIONS = ['north', 'south', 'east', 'west'];
export const MODELS = Array.from({ length: 12 }, (_, i) => `m${(i + 1) * 100}`);
const SOFTWARE = ['1.0', '1.4', '2.0', '2.3', '3.1'];
const SYMBOLS = Array.from(
  { length: 8 },
  (_, i) => `w${String(i + 1).padStart(3, '0')}`,
);
const SEVERITIES = ['danger', 'warning', 'caution', 'notice'];

/** The configuration (`openfolia.yaml`) for a profile's languages. */
export function configOf(profile) {
  return {
    languages: {
      source: SOURCE_LANG,
      targets: Object.keys(profile.translated),
    },
    moduleTypes: [
      { id: 'concept', label: 'Concept' },
      { id: 'procedure', label: 'Procedure' },
      { id: 'reference', label: 'Reference' },
      { id: 'safety', label: 'Safety information' },
      { id: 'snippet', label: 'Snippet', snippet: true },
    ],
    audiences: [
      { id: 'public', label: 'Public' },
      { id: 'partner', label: 'Partners' },
      { id: 'internal', label: 'Internal' },
    ],
    facets: [
      {
        id: PRODUCT_FACET,
        label: 'Product line',
        values: PRODUCTS.map((id) => ({ id, label: capitalise(id) })),
      },
      {
        id: 'region',
        label: 'Region',
        values: REGIONS.map((id) => ({ id, label: capitalise(id) })),
      },
    ],
    variantAttributes: [
      {
        id: 'model',
        label: 'Model',
        kind: 'enum',
        values: MODELS.map((id) => ({ id, label: id.toUpperCase() })),
      },
      { id: 'software', label: 'Software version', kind: 'version' },
    ],
    textAttributes: [
      { id: 'product-name', label: 'Product name' },
      { id: 'model-code', label: 'Model code' },
    ],
    safetySymbols: SYMBOLS.map((id) => ({ id, label: `Symbol ${id}` })),
    release: { productFacet: PRODUCT_FACET },
  };
}

/** A safety symbol's artwork: a plain triangle with a number, invented. */
export function symbolSvg(id) {
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 90">' +
    '<path d="M50 5 L95 85 H5 Z" fill="#f9c900" stroke="#000" stroke-width="7" stroke-linejoin="round"/>' +
    `<text x="50" y="72" font-size="30" text-anchor="middle">${id.slice(1)}</text></svg>\n`
  );
}

const text = (value) => ({ type: 'text', text: value });

/**
 * The content of one profile, kept in memory so the history can edit it: every module in
 * every language, the manuals and the terms.
 */
export class ScaleContent {
  /**
   * @param {import('./profiles.mjs').Profile} profile
   * @param {{ images: object[], pdfs: object[], attachments: object[] }} media the stored files
   *   (`{ sha256, size, contentType, fileName }` each)
   */
  constructor(profile, media) {
    this.profile = profile;
    this.media = media;
    this.random = new Random(profile.seed);
    this.config = configOf(profile);
    this.configYaml = printConfig(ProjectConfig.parse(this.config));
    this.projectConfig = parseConfig(this.configYaml);
    /** @type {Map<string, object>} source modules by ID */
    this.modules = new Map();
    /** @type {Map<string, Map<string, { module: object, record: object | undefined }>>} lang → ID → translation */
    this.translations = new Map(
      this.projectConfig.languages.targets.map((lang) => [lang, new Map()]),
    );
    /** @type {Map<string, object>} manuals by ID */
    this.manuals = new Map();
    this.snippetIds = [];
    this.contentIds = [];
    this.nextBlock = 0;
    this.makeModules();
    this.makeManuals();
  }

  // -- Modules -------------------------------------------------------------------------------

  makeModules() {
    const random = this.random.fork('modules');
    const { modules, snippets } = this.profile;
    for (let i = 0; i < modules; i++) {
      const number = String(i + 1).padStart(5, '0');
      const id = `${random.pick(NOUNS)}-${random.pick(VERBS)}-${number}`;
      if (i < snippets) this.snippetIds.push(id);
      else this.contentIds.push(id);
    }
    const imageUse = this.spread(this.media.images, random.fork('images'));
    const fileUse = this.spread(
      [...this.media.pdfs, ...this.media.attachments],
      random.fork('files'),
    );
    for (const id of this.snippetIds) {
      this.modules.set(id, this.snippet(id, random.fork(id)));
    }
    this.contentIds.forEach((id, index) => {
      const r = random.fork(id);
      const type = r.weighted([
        ['concept', 40],
        ['procedure', 35],
        ['reference', 18],
        ['safety', 7],
      ]);
      const module = this.contentModule(id, type, r, {
        images: imageUse(index, this.contentIds.length),
        files: fileUse(index, this.contentIds.length),
      });
      this.modules.set(id, this.checked(module));
    });
  }

  /**
   * Hands out `items` over the modules: about one in three modules shows one or two of them,
   * and every item is used at least once while there are modules for it.
   */
  spread(items, random) {
    return (index, count) => {
      if (items.length === 0) return [];
      const own = Math.floor((index * items.length) / count);
      const next = Math.floor(((index + 1) * items.length) / count);
      const result = [];
      for (let k = own; k < next; k++) result.push(items[k]);
      if (result.length === 0 && random.chance(0.15)) {
        result.push(random.pick(items));
      }
      return result.slice(0, 3);
    };
  }

  blockId(prefix = 'b') {
    this.nextBlock += 1;
    return `${prefix}${this.nextBlock.toString(36)}`;
  }

  snippet(id, random) {
    return this.checked({
      schemaVersion: 1,
      id,
      meta: {
        title: title(random),
        type: 'snippet',
        lang: SOURCE_LANG,
        audience: random.pick(['public', 'public', 'partner']),
        facets: {},
      },
      blocks: [
        {
          type: 'paragraph',
          id: this.blockId(),
          content: [text(sentence(random))],
        },
      ],
    });
  }

  paragraph(random, { attribute = false, xref = false } = {}) {
    const content = [text(paragraphText(random))];
    if (attribute) {
      content.push(text(' Applies to the '), {
        type: 'attribute',
        name: 'product-name',
      });
      content.push(text('.'));
    }
    if (xref && this.contentIds.length > 1) {
      content.push(text(' See '), {
        type: 'xref',
        module: random.pick(this.contentIds),
      });
      content.push(text('.'));
    }
    return { type: 'paragraph', id: this.blockId(), content };
  }

  items(random, min, max) {
    return Array.from({ length: random.int(min, max) }, () => ({
      id: this.blockId('i'),
      content: [text(sentence(random))],
      blocks: [],
    }));
  }

  image(file, random) {
    return {
      type: 'image',
      id: this.blockId('img'),
      asset: `sha256:${file.sha256}`,
      alt: `The ${random.pick(ADJECTIVES)} ${random.pick(NOUNS)}`,
      ...(random.chance(0.4) && { title: [text(title(random))] }),
    };
  }

  attachment(file, random) {
    return {
      type: 'attachment',
      id: this.blockId('file'),
      asset: `sha256:${file.sha256}`,
      name: `${capitalise(random.pick(NOUNS))} ${file.contentType === 'application/pdf' ? 'data sheet' : 'settings'}`,
      fileName: file.fileName,
      mediaType: file.contentType,
      size: file.size,
    };
  }

  safety(random) {
    return {
      type: 'safety',
      id: this.blockId('s'),
      severity: random.pick(SEVERITIES),
      hazard: [
        text(
          `${capitalise(random.pick(ADJECTIVES))} ${random.pick(NOUNS)} can move`,
        ),
      ],
      symbols: random.sample(SYMBOLS, random.int(1, 2)),
      blocks: [this.paragraph(random)],
    };
  }

  variantBlock(random) {
    return {
      type: 'variant',
      id: this.blockId('v'),
      when: {
        op: 'in',
        attr: 'model',
        values: random.sample(MODELS, random.int(1, 4)),
      },
      blocks: [this.paragraph(random)],
    };
  }

  table(random) {
    const columns = random.int(3, 5);
    const rows = random.int(4, 16);
    const cell = (value) => ({
      blocks: [
        { type: 'paragraph', id: this.blockId('c'), content: [text(value)] },
      ],
    });
    return {
      type: 'table',
      id: this.blockId('t'),
      title: [text(`${capitalise(random.pick(NOUNS))} values`)],
      columns: Array.from({ length: columns }, () => ({
        width: random.int(1, 3),
      })),
      header: true,
      rows: [
        {
          cells: Array.from({ length: columns }, (_, c) =>
            cell(c === 0 ? 'Part' : capitalise(random.pick(ADJECTIVES))),
          ),
        },
        ...Array.from({ length: rows }, () => ({
          cells: Array.from({ length: columns }, (_, c) =>
            cell(
              c === 0
                ? random.pick(NOUNS)
                : `${random.int(1, 900)} ${random.pick(['mm', 'Nm', 'V', 'A', 'kg', 'min'])}`,
            ),
          ),
        })),
      ],
    };
  }

  contentModule(id, type, random, { images, files }) {
    const blocks = [this.paragraph(random, { attribute: random.chance(0.4) })];
    if (random.chance(0.3) && this.snippetIds.length > 0) {
      blocks.push({
        type: 'moduleRef',
        id: this.blockId('ref'),
        module: random.pick(this.snippetIds),
      });
    }
    if (type === 'safety' || random.chance(0.15))
      blocks.push(this.safety(random));
    const sectionBlocks = [];
    switch (type) {
      case 'procedure':
        blocks.push({
          type: 'procedure',
          id: this.blockId('p'),
          title: [text(title(random))],
          steps: this.items(random, 3, 12),
        });
        break;
      case 'reference':
        blocks.push(this.table(random));
        break;
      default: {
        // Sections come last: at module level nothing may follow one (the content model's rule).
        const sections = random.int(1, 3);
        for (let s = 0; s < sections; s++) {
          const inner = [this.paragraph(random, { xref: random.chance(0.2) })];
          if (random.chance(0.4)) {
            inner.push({
              type: 'list',
              id: this.blockId('l'),
              ordered: random.chance(0.3),
              items: this.items(random, 2, 6),
            });
          }
          if (random.chance(0.3)) inner.push(this.paragraph(random));
          sectionBlocks.push({
            type: 'section',
            id: this.blockId('sec'),
            title: [text(title(random))],
            blocks: inner,
          });
        }
      }
    }
    for (const file of images) blocks.push(this.image(file, random));
    for (const file of files) blocks.push(this.attachment(file, random));
    if (random.chance(0.25)) blocks.push(this.variantBlock(random));
    if (random.chance(0.2)) {
      blocks.push({
        type: 'admonition',
        id: this.blockId('a'),
        kind: random.pick(['note', 'tip', 'important']),
        blocks: [this.paragraph(random)],
      });
    }
    if (random.chance(0.05)) {
      blocks.push({
        type: 'literal',
        id: this.blockId('lit'),
        text: `setting.${random.pick(NOUNS)} = ${random.int(1, 99)}\nmode = ${random.pick(VERBS)}`,
      });
    }
    blocks.push(...sectionBlocks);
    const facets = {
      [PRODUCT_FACET]: random.sample(PRODUCTS, random.int(1, 2)),
    };
    if (random.chance(0.3))
      facets.region = random.sample(REGIONS, random.int(1, 2));
    return {
      schemaVersion: 1,
      id,
      meta: {
        title: title(random),
        type,
        lang: SOURCE_LANG,
        audience: random.weighted([
          ['public', 70],
          ['partner', 15],
          ['internal', 15],
        ]),
        facets,
        keywords: random.sample(NOUNS, random.int(0, 3)),
      },
      blocks,
    };
  }

  /**
   * The module, after the content model's schema read it (structure included) and its
   * validator found no error in it; throws otherwise.
   */
  checked(module) {
    const parsed = Module.safeParse(module);
    if (!parsed.success) {
      throw new Error(
        `perf: generated module ${module.id} does not parse: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
      );
    }
    const errors = validateModule(module, this.projectConfig).filter(
      (issue) => issue.severity === 'error',
    );
    if (errors.length > 0) {
      throw new Error(
        `perf: generated module ${module.id} is invalid: ${errors.map((e) => `${e.code} ${e.message}`).join('; ')}`,
      );
    }
    return module;
  }

  // -- Manuals -------------------------------------------------------------------------------

  makeManuals() {
    const random = this.random.fork('manuals');
    const ids = this.contentIds;
    for (let i = 0; i < this.profile.manuals; i++) {
      const r = random.fork(`manual-${i}`);
      const id = `manual-${String(i + 1).padStart(4, '0')}`;
      // The first manual is the big one (the manual builder's case); the others hold 10 to 60.
      const count = i === 0 ? this.profile.bigManualModules : r.int(10, 60);
      // Manuals draw from a band of the modules, so neighbouring manuals share some.
      const start = Math.floor((i / this.profile.manuals) * ids.length);
      const band = [];
      for (let k = 0; k < Math.min(ids.length, count * 2); k++) {
        band.push(ids[(start + k) % ids.length]);
      }
      const chosen = i === 0 ? ids.slice(0, count) : r.sample(band, count);
      const entries = [];
      for (let c = 0; c < chosen.length; c += 12) {
        const chapter = chosen.slice(c, c + 12).map((module) =>
          r.chance(0.05)
            ? {
                module,
                when: {
                  op: 'in',
                  attr: 'model',
                  values: r.sample(MODELS, 3),
                },
              }
            : { module },
        );
        entries.push({ title: title(r), entries: chapter });
      }
      const models = r.sample(MODELS, r.int(1, 4));
      const variants = models.map((model) =>
        r.chance(0.3) ? { model, software: r.pick(SOFTWARE) } : { model },
      );
      const manual = {
        schemaVersion: 1,
        id,
        title: `${capitalise(r.pick(ADJECTIVES))} ${r.pick(NOUNS)} manual ${i + 1}`,
        audience: r.weighted([
          ['public', 70],
          ['partner', 15],
          ['internal', 15],
        ]),
        variants,
        attributes: {
          'product-name': models.map((model, k) =>
            k === models.length - 1
              ? { value: `Unit ${model.toUpperCase()}` }
              : {
                  value: `Unit ${model.toUpperCase()}`,
                  when: { op: 'in', attr: 'model', values: [model] },
                },
          ),
          'model-code': `MC-${r.int(100, 999)}`,
        },
        entries,
      };
      const errors = validateManifest(manual, this.projectConfig).filter(
        (issue) => issue.severity === 'error',
      );
      if (errors.length > 0) {
        throw new Error(
          `perf: generated manual ${id} is invalid: ${errors.map((e) => e.message).join('; ')}`,
        );
      }
      this.manuals.set(id, manual);
    }
  }

  /** The manual that holds `bigManualModules` modules. */
  get bigManualId() {
    return 'manual-0001';
  }

  // -- Translations --------------------------------------------------------------------------

  /** A translation of `source` into `lang` (pseudo-text, the same structure and files). */
  translate(source, lang) {
    const walk = (value, key) => {
      if (Array.isArray(value)) return value.map((v) => walk(v, key));
      if (value === null || typeof value !== 'object') {
        return typeof value === 'string' &&
          (key === 'text' ||
            key === 'alt' ||
            key === 'name' ||
            key === 'description')
          ? pseudoTranslate(value, lang)
          : value;
      }
      // Literals and passthroughs are never translated; an attribute's name is configuration.
      if (
        value.type === 'literal' ||
        value.type === 'passthrough' ||
        value.type === 'attribute'
      ) {
        return value;
      }
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, walk(v, k)]),
      );
    };
    return {
      ...source,
      meta: {
        ...source.meta,
        title: pseudoTranslate(source.meta.title, lang),
        lang,
        keywords: (source.meta.keywords ?? []).map((k) =>
          pseudoTranslate(k, lang),
        ),
      },
      blocks: walk(source.blocks, 'blocks'),
    };
  }

  /**
   * The first translations: per target language its share of the modules, in commits of at
   * most `perCommit` files, each made from the source as it is at `sourceCommit`.
   */
  *initialTranslations(sourceCommitOf, perCommit = 400) {
    const random = this.random.fork('translations');
    const ids = [...this.snippetIds, ...this.contentIds];
    for (const lang of this.projectConfig.languages.targets) {
      const share = this.profile.translated[lang] ?? 0;
      const chosen = ids.filter(() => random.chance(share));
      for (let i = 0; i < chosen.length; i += perCommit) {
        const batch = chosen.slice(i, i + perCommit);
        const sourceCommit = sourceCommitOf();
        yield {
          message: `Translate ${batch.length} modules into ${lang}`,
          changes: batch.flatMap((id) =>
            this.writeTranslation(id, lang, sourceCommit),
          ),
        };
      }
    }
  }

  writeTranslation(id, lang, sourceCommit) {
    const source = this.modules.get(id);
    const module = this.checked(this.translate(source, lang));
    const record = sourceCommit
      ? translationRecordOf(source, sourceCommit)
      : undefined;
    this.translations.get(lang).set(id, { module, record });
    return [
      { path: `modules/${lang}/${id}.adoc`, content: printModule(module) },
      ...(record
        ? [
            {
              path: `modules/${lang}/${id}.translation.yaml`,
              content: printTranslationRecord(record),
            },
          ]
        : []),
    ];
  }

  // -- Files ---------------------------------------------------------------------------------

  /** The files of the first commit: configuration, symbols, terms, every source module and manual. */
  initialFiles() {
    const files = [{ path: 'openfolia.yaml', content: this.configYaml }];
    for (const id of SYMBOLS)
      files.push({ path: `symbols/${id}.svg`, content: symbolSvg(id) });
    for (const [id, content] of this.terms())
      files.push({ path: `terms/${id}.yaml`, content });
    for (const module of this.modules.values()) {
      files.push({
        path: `modules/${SOURCE_LANG}/${module.id}.adoc`,
        content: printModule(module),
      });
    }
    for (const manual of this.manuals.values()) {
      files.push({
        path: `manuals/${manual.id}.yaml`,
        content: printManifest(manual),
      });
    }
    return files;
  }

  /** The terms: `[id, yaml]`, with an approved, proposed or deprecated status and translations. */
  terms() {
    const random = this.random.fork('terms');
    const result = [];
    const used = new Set();
    for (let i = 0; i < this.profile.terms; i++) {
      const noun = NOUNS[i % NOUNS.length];
      const adjective =
        ADJECTIVES[Math.floor(i / NOUNS.length) % ADJECTIVES.length];
      const preferred = i < NOUNS.length ? noun : `${adjective} ${noun}`;
      const id =
        preferred.replace(/ /g, '-') +
        (i >= NOUNS.length * ADJECTIVES.length ? `-${i}` : '');
      if (used.has(id)) continue;
      used.add(id);
      const status = random.weighted([
        ['approved', 80],
        ['proposed', 15],
        ['deprecated', 5],
      ]);
      const lines = [
        'schemaVersion: 1',
        `status: ${status}`,
        `domain: ${random.pick(['mechanics', 'power', 'controls', 'safety'])}`,
        'languages:',
        '  en:',
        `    preferred: ${preferred}`,
      ];
      if (random.chance(0.3)) {
        lines.push('    forbidden:', `      - term: ${preferred} unit`);
      }
      lines.push(
        `    definition: The ${preferred} of the unit, as fitted at the factory.`,
      );
      for (const lang of random.sample(
        this.projectConfig.languages.targets,
        random.int(0, 3),
      )) {
        lines.push(
          `  ${lang}:`,
          `    preferred: ${pseudoTranslate(preferred, lang)}`,
        );
      }
      result.push([id, `${lines.join('\n')}\n`]);
    }
    return result;
  }

  // -- History -------------------------------------------------------------------------------

  /**
   * One commit of the history after the first ones: mostly an edit of one to four source
   * modules, sometimes a translation brought up to date, a manual's order changed or a new
   * module added to a manual. `sourceCommit` is what a translation made now is recorded as
   * made from (a commit already on `main`).
   */
  historyCommit(index, sourceCommit) {
    const random = this.random.fork(`history-${index}`);
    const kind = random.weighted([
      ['edit', 70],
      ['translate', 22],
      ['manual', 5],
      ['add', 3],
    ]);
    if (kind === 'translate') {
      const lang = random.pick(this.projectConfig.languages.targets);
      const ids = [...this.translations.get(lang).keys()];
      if (ids.length > 0) {
        const id = random.pick(ids);
        return {
          message: `Update the ${lang} translation of ${id}`,
          changes: this.writeTranslation(id, lang, sourceCommit),
        };
      }
    }
    if (kind === 'manual') {
      const manual = this.manuals.get(random.pick([...this.manuals.keys()]));
      const chapter = random.pick(manual.entries);
      chapter.entries = random.sample(chapter.entries, chapter.entries.length);
      chapter.title = title(random);
      return {
        message: `Reorder a chapter of ${manual.id}`,
        changes: [
          { path: `manuals/${manual.id}.yaml`, content: printManifest(manual) },
        ],
      };
    }
    if (kind === 'add') {
      const number = String(this.modules.size + 1).padStart(5, '0');
      const id = `${random.pick(NOUNS)}-${random.pick(VERBS)}-${number}`;
      const module = this.checked(
        this.contentModule(id, random.pick(['concept', 'procedure']), random, {
          images: [],
          files: [],
        }),
      );
      this.modules.set(id, module);
      this.contentIds.push(id);
      const manual = this.manuals.get(random.pick([...this.manuals.keys()]));
      manual.entries[manual.entries.length - 1].entries.push({ module: id });
      return {
        message: `Add ${id}`,
        changes: [
          {
            path: `modules/${SOURCE_LANG}/${id}.adoc`,
            content: printModule(module),
          },
          { path: `manuals/${manual.id}.yaml`, content: printManifest(manual) },
        ],
      };
    }
    const ids = random.sample(this.contentIds, random.int(1, 4));
    return {
      message:
        ids.length === 1
          ? `Edit ${ids[0]}`
          : `Edit ${ids.length} modules (${ids[0]}, …)`,
      changes: ids.map((id) => {
        const module = this.edited(this.modules.get(id), random);
        this.modules.set(id, module);
        return {
          path: `modules/${SOURCE_LANG}/${id}.adoc`,
          content: printModule(module),
        };
      }),
    };
  }

  /** A module with one paragraph's text rewritten, or a paragraph added. */
  edited(module, random) {
    const blocks = [...module.blocks];
    const paragraphs = blocks
      .map((block, i) => [block, i])
      .filter(([block]) => block.type === 'paragraph');
    if (paragraphs.length > 0 && random.chance(0.75)) {
      const [block, i] = random.pick(paragraphs);
      blocks[i] = { ...block, content: [text(paragraphText(random))] };
    } else {
      // Before the first section: nothing may follow one at module level.
      const firstSection = blocks.findIndex(
        (block) => block.type === 'section',
      );
      const end = firstSection === -1 ? blocks.length : firstSection;
      blocks.splice(random.int(1, Math.max(1, end)), 0, this.paragraph(random));
    }
    return this.checked({ ...module, blocks });
  }

  /** How many translations are up to date with their source, per language (for the summary). */
  translationSummary() {
    return Object.fromEntries(
      [...this.translations].map(([lang, byId]) => [lang, byId.size]),
    );
  }
}
