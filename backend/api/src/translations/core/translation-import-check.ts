import {
  configSourceHashes,
  configUnits,
  designSourceHashes,
  designUnits,
  manifestSourceHashes,
  manifestUnits,
  MAX_COVER_ALT_LENGTH,
  plainTextOf,
  SingleLine,
  sourceHashes,
  textIn,
  translatableUnits,
  type Module,
  type TranslatablePart,
  type TranslatableUnit,
} from '@openfolia/content-model';
import {
  readXliff,
  type ReadFile,
  type ReadUnit,
  type ReadXliff,
  targetParts,
  XliffReadError,
  type XliffRefusal,
  type XliffUnit,
  xliffUnitsOf,
  xliffUnitsOfConfig,
  xliffUnitsOfDesign,
  xliffUnitsOfManifest,
} from '@openfolia/xliff';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../access/core/actor.js';
import { allows, moduleTarget } from '../../access/core/allows.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
} from '../../base/core/errors.js';
import { BRANCH_PREFIX } from '../../change-sets/core/change-set.js';
import { ChangeSetBranches } from '../../change-sets/core/change-set-branches.js';
import { OpenSnapshotAction } from '../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../content/core/readable-content.js';
import { ReadableRefs } from '../../content/core/readable-refs.js';
import { looksLikeZip, readZip } from '../../imports/core/zip-archive.js';
import { managesAll } from './exports.js';
import { visibleJob } from './actions/read-translation-jobs.action.js';
import { readModule } from './statuses.js';
import {
  changesConfig,
  CONFIG_TITLE,
  isConfigKey,
  managesConfigIn,
} from './config-translations.js';
import {
  changesDesigns,
  designIdOf,
  managesDesignIn,
  readDesign,
} from './design-translations.js';
import {
  changesManual,
  managesManualIn,
  manualIdOf,
  readManifest,
  seesManualTranslation,
} from './manual-translations.js';
import {
  type ExchangeEnvelope,
  TranslationExchange,
} from './translation-exchange.js';
import type { TranslationJob, TranslationJobUnit } from './translation-job.js';
import { TranslationJobs } from './translation-jobs.js';
import {
  type ImportDocument,
  type ImportModuleReport,
  type ImportUnitReport,
  MAX_REPORT_TEXT_CHARACTERS,
  MAX_UNIT_TEXT_LENGTH,
  type SourceChangedTexts,
} from './translation-import.js';
import { readTranslation } from './translation-status.js';

/**
 * The documents name no translation job the actor may see (`ccms:job`):
 * 404, as reading that job would be, with a code of its own.
 */
export class UnknownJobError extends NotFoundError {
  override readonly code = 'unknown-job';

  constructor() {
    super('The document names no translation job you may see (its ccms:job).');
  }
}

/** How large an upload is, and what an XLIFF may hold. */
export abstract class TranslationImportSettings {
  /** `CCMS_MAX_UPLOAD_BYTES`: the upload, and every XLIFF in a ZIP together unpacked. */
  abstract readonly maxBytes: number;
}

/** The most XLIFF documents (target languages) one ZIP may hold, and entries in all. */
export const MAX_ZIP_ENTRIES = 100;

/** The deepest an XLIFF may nest its elements (the writer's go 7 deep, inline codes a few more). */
export const MAX_XLIFF_DEPTH = 64;

/** The longest XLIFF document read, in characters, however high `CCMS_MAX_UPLOAD_BYTES` is set. */
export const MAX_XLIFF_LENGTH = 32 * 1024 * 1024;

/** The most nodes (elements and texts) of one XLIFF document: room for `MAX_READ_UNITS` units. */
export const MAX_XLIFF_NODES = 1_000_000;

/** A unit the check read: its report line and, where it can be imported, its text. */
export interface CheckedUnit extends ImportUnitReport {
  /** The translated parts (`ok` and `source-changed` only). */
  readonly parts?: readonly TranslatablePart[];
  /** The source hash the unit was exported with: what its translation record takes. */
  readonly exportedHash?: string;
}

export interface CheckedModule {
  readonly lang: string;
  /** The document's `<file id>`: a module's ID, or a page design's key (#568). */
  readonly moduleId: string;
  /** A page design's region text (#568): the design. */
  readonly designId?: string;
  /** A manual's own text (#656, its cover images' alternative text): the manual. */
  readonly manualId?: string;
  /** The project labels (#731, the `<file id="config.project">`). */
  readonly config?: true;
  readonly title?: string;
  readonly units: readonly CheckedUnit[];
}

/** What a check found: the job, the base and every unit's state. */
export interface Checked {
  readonly job: TranslationJob;
  readonly languages: readonly string[];
  readonly baseRef: string;
  readonly base: ReadableContent;
  readonly modules: readonly CheckedModule[];
}

/** The report of a check, without the text. */
export function reportOf(
  modules: readonly CheckedModule[],
): ImportModuleReport[] {
  return modules.map(
    ({ lang, moduleId, designId, manualId, config, title, units }) => ({
      lang,
      moduleId,
      ...(designId !== undefined && { designId }),
      ...(manualId !== undefined && { manualId }),
      ...(config === true && { config }),
      ...(title !== undefined && { title }),
      units: units.map(({ blockId, state, kind, reason, detail, texts }) => ({
        blockId,
        state,
        ...(kind !== undefined && { kind }),
        ...(reason !== undefined && { reason }),
        ...(detail !== undefined && { detail }),
        ...(texts !== undefined && { texts }),
      })),
    }),
  );
}

/** A unit's parts as plain text, a line each. */
const textOf = (parts: readonly TranslatablePart[]): string =>
  parts.map((p) => plainTextOf(p.content).text).join('\n');

/** At most `MAX_UNIT_TEXT_LENGTH` characters, never splitting a surrogate pair. */
function cut(text: string): { text: string; cut: boolean } {
  if (text.length <= MAX_UNIT_TEXT_LENGTH) return { text, cut: false };
  let end = MAX_UNIT_TEXT_LENGTH;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return { text: text.slice(0, end), cut: true };
}

/**
 * The texts of `source-changed` units, while the report's budget
 * (`MAX_REPORT_TEXT_CHARACTERS`) lasts.
 */
class TextBudget {
  #left = MAX_REPORT_TEXT_CHARACTERS;

  texts(
    exported: readonly TranslatablePart[],
    current: readonly TranslatablePart[] | undefined,
    target: readonly TranslatablePart[],
  ): SourceChangedTexts | undefined {
    if (this.#left <= 0) return undefined;
    const a = cut(textOf(exported));
    const b = cut(current ? textOf(current) : '');
    const c = cut(textOf(target));
    const length = a.text.length + b.text.length + c.text.length;
    if (length > this.#left) {
      this.#left = 0;
      return undefined;
    }
    this.#left -= length;
    return {
      exported: a.text,
      current: b.text,
      target: c.text,
      truncated: a.cut || b.cut || c.cut,
    };
  }
}

/**
 * One unit of a document decided against what the job sent (`jobUnit`, and the unit as it was
 * sent: `exported`) and the source on the base now (`hashNow`, `currentParts`): `unknown-block`
 * when the job sent no such unit or the source has it no longer, `broken-markup` when its
 * `ccms:sourceHash` is not the one sent or its target does not match its source
 * (`targetParts`), else `ok` or `source-changed`.
 */
function decide(
  unit: ReadUnit,
  at: {
    readonly lang: string;
    /** What the file is, in a detail (`this module`). */
    readonly what: string;
    readonly jobUnit: TranslationJobUnit | undefined;
    readonly exported: (id: string) => XliffUnit | undefined;
    readonly hashNow: (id: string) => string | undefined;
    readonly currentParts: (
      id: string,
    ) => readonly TranslatablePart[] | undefined;
    readonly budget: TextBudget;
  },
): CheckedUnit {
  const blockId = unit.blockId;
  const { jobUnit } = at;
  const exportedUnit = jobUnit ? at.exported(blockId) : undefined;
  if (!jobUnit || !exportedUnit) {
    return {
      blockId,
      state: 'unknown-block',
      reason: 'not-sent',
      detail: `The job sent no block "${blockId}" of ${at.what} in ${at.lang}.`,
    };
  }
  const kind = exportedUnit.kind;
  if (unit.sourceHash !== jobUnit.sourceHash) {
    return {
      blockId,
      kind,
      state: 'broken-markup',
      reason: 'source-hash',
      detail: 'The unit’s ccms:sourceHash is not the one it was exported with.',
    };
  }
  const target = targetParts(exportedUnit, unit);
  if (!target.ok) {
    return {
      blockId,
      kind,
      state: 'broken-markup',
      reason: target.reason,
      detail: target.detail,
    };
  }
  const hash = at.hashNow(blockId);
  if (hash === undefined) {
    return {
      blockId,
      kind,
      state: 'unknown-block',
      reason: 'removed',
      detail: `The source has no block "${blockId}" any more.`,
    };
  }
  if (hash === jobUnit.sourceHash) {
    return {
      blockId,
      kind,
      state: 'ok',
      parts: target.parts,
      exportedHash: jobUnit.sourceHash,
    };
  }
  const texts = at.budget.texts(
    exportedUnit.parts,
    at.currentParts(blockId),
    target.parts,
  );
  return {
    blockId,
    kind,
    state: 'source-changed',
    ...(texts && { texts }),
    parts: target.parts,
    exportedHash: jobUnit.sourceHash,
  };
}

/** The translatable units of `module` by block ID, read once. */
function unitsById(module: Module): () => Map<string, TranslatableUnit> {
  let units: Map<string, TranslatableUnit> | undefined;
  return () =>
    (units ??= new Map(translatableUnits(module).map((u) => [u.blockId, u])));
}

/** An alternative text, as a cover image takes one: one line, at most `MAX_COVER_ALT_LENGTH`. */
const CoverAlt = SingleLine.max(MAX_COVER_ALT_LENGTH).refine(
  // One line in the PDF too: no control characters, nor Unicode's line and paragraph separators.
  // eslint-disable-next-line no-control-regex
  (text) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text),
);

/**
 * A unit of a manual's own text (#656: a cover image's alternative text; #731: its title, a
 * group's title) or of the project labels (#731) as its text goes in: an imported one (`ok`,
 * `source-changed`) with its text trimmed at its edges, or `broken-markup` (`invalid-content`)
 * when that is not one line of at most `MAX_COVER_ALT_LENGTH` characters (`CoverAlt`). Plain
 * text either way: the source has no inline codes, so its target may have none (`targetParts`).
 * `field` is the part the text goes into (`alt` for a manual's: what its merge reads it as).
 */
function plainText(
  unit: CheckedUnit,
  field: TranslatablePart['field'],
  what: string,
): CheckedUnit {
  if (!unit.parts) return unit;
  const text = unit.parts
    .map((p) => plainTextOf(p.content).text)
    .join(' ')
    .trim();
  if (!CoverAlt.safeParse(text).success) {
    const { parts: _parts, exportedHash: _hash, texts: _texts, ...rest } = unit;
    return {
      ...rest,
      state: 'broken-markup',
      reason: 'invalid-content',
      detail: `${what} is one line of at most ${MAX_COVER_ALT_LENGTH} characters.`,
    };
  }
  return {
    ...unit,
    parts: [{ field, content: [{ type: 'text', text }] }],
  };
}

/** A manual's own text (#656, #731), as `plainText` takes it in. */
const altText = (unit: CheckedUnit): CheckedUnit =>
  plainText(
    unit,
    'alt',
    'A manual’s title, a group’s title or a cover image’s alternative text',
  );

const XLIFF_FILE = /\.(xlf|xliff)$/i;

/**
 * The steps of a translation import before anything is written (#51):
 * reading the upload safely, and deciding each unit against the job it
 * came from and the base branch as the importer sees it. Validating
 * stops there; applying runs it again on the stored documents, so what is
 * written is decided on the base as it is then.
 */
@Injectable()
export class TranslationImportCheck {
  constructor(
    private readonly jobs: TranslationJobs,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly refs: ReadableRefs,
    private readonly branches: ChangeSetBranches,
    private readonly settings: TranslationImportSettings,
    private readonly exchange: TranslationExchange,
  ) {}

  /**
   * The XLIFF documents of an upload: the file itself, or each `.xlf` or
   * `.xliff` file of a ZIP (read by `readZip`: no path leaves its folder,
   * no links, no bombs; at most `MAX_ZIP_ENTRIES` entries and
   * `maxBytes` unpacked), each UTF-8 text (422 `xliff-unsupported-encoding`
   * otherwise). A ZIP without one is 422 `no-xliff`.
   */
  async documents(bytes: Uint8Array): Promise<ImportDocument[]> {
    if (bytes.byteLength > this.settings.maxBytes) {
      throw new UnprocessableError(
        'too-large',
        `The upload is larger than ${this.settings.maxBytes} bytes (CCMS_MAX_UPLOAD_BYTES).`,
        { max: this.settings.maxBytes },
      );
    }
    if (!looksLikeZip(bytes)) {
      // Longer than any document read could be (4 bytes a character): not decoded at all.
      if (bytes.byteLength > 4 * MAX_XLIFF_LENGTH) {
        throw new UnprocessableError(
          'xliff-too-large',
          `The document is longer than ${MAX_XLIFF_LENGTH} characters.`,
        );
      }
      return [{ xliff: decode(bytes) }];
    }
    const files = await readZip(bytes, {
      maxFiles: MAX_ZIP_ENTRIES,
      maxUnpackedBytes: Math.min(this.settings.maxBytes, MAX_XLIFF_LENGTH),
      maxPathDepth: 4,
    });
    // A translation system's package (#140): only the XLIFF its project descriptions list.
    const returned = this.exchange.unpack(files);
    if (returned !== undefined) {
      if (returned.length === 0) {
        throw new UnprocessableError(
          'no-xliff',
          'The package lists no XLIFF file to import.',
        );
      }
      return returned.map(({ path, bytes: content, envelope }) => ({
        path,
        xliff: decode(content, path),
        envelope,
      }));
    }
    const documents: ImportDocument[] = [];
    for (const [path, content] of [...files].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      // A file a tool adds beside them (macOS's resource forks, hidden files).
      if (
        !XLIFF_FILE.test(name) ||
        name.startsWith('.') ||
        path.startsWith('__MACOSX/')
      ) {
        continue;
      }
      documents.push({ path, xliff: decode(content, path) });
    }
    if (documents.length === 0) {
      throw new UnprocessableError(
        'no-xliff',
        'The ZIP holds no XLIFF file (.xlf or .xliff).',
      );
    }
    return documents;
  }

  /**
   * Reads `documents` and decides each unit (`IMPORT_UNIT_STATES`) for
   * `actor`, against the base branch `baseRef` (the server's default when
   * left out) as they see it:
   *
   * 1. Each document is read strictly (`readXliff`): no DTD, no entities,
   *    bounded; one that is not is refused whole (422 `xliff-<reason>`,
   *    `not-xliff`, `invalid-xliff`, `meta.path` naming it in a ZIP).
   * 2. Its target language must be one the actor manages translations into
   *    (403 otherwise, before anything else is looked up), each language
   *    once (422 `duplicate-language`).
   * 3. Every document names the same job (`ccms:job`; 422 `mixed-jobs`),
   *    one the actor sees (`visibleJob`; else 404 `unknown-job`, as for a
   *    job that does not exist), not cancelled (409 `job-not-open`), with
   *    its source language and one of its target languages (422
   *    `language-mismatch`).
   * 4. Each unit is checked against what the job sent, read from the job's
   *    commit as the actor reads it there, and against the base.
   */
  async check(
    actor: Actor,
    documents: readonly ImportDocument[],
    baseRef: string | undefined,
  ): Promise<Checked> {
    const read: {
      path?: string | undefined;
      doc: ReadXliff;
      envelope?: ExchangeEnvelope | undefined;
    }[] = documents.map(({ path, xliff, envelope }) => ({
      path,
      doc: parse(xliff, path, this.settings.maxBytes),
      envelope,
    }));
    const languages = new Set<string>();
    for (const { path, doc } of read) {
      if (!managesAll(actor, [doc.trgLang])) {
        throw new ForbiddenError(
          `You do not manage translations into "${doc.trgLang}".`,
        );
      }
      if (languages.has(doc.trgLang)) {
        throw new UnprocessableError(
          'duplicate-language',
          `Two documents translate into "${doc.trgLang}".`,
          { lang: doc.trgLang, ...(path !== undefined && { path }) },
        );
      }
      languages.add(doc.trgLang);
    }
    for (const { path, doc, envelope } of read) {
      if (envelope) this.matchEnvelope(doc, envelope, path);
    }
    // A package's document names its job in the package; the XLIFF's own must agree (above).
    const jobIds = new Set(
      read.map(({ doc, envelope }) => doc.meta['job'] ?? envelope?.jobId),
    );
    if (jobIds.size > 1) {
      throw new UnprocessableError(
        'mixed-jobs',
        'The documents come from different translation jobs; import one job at a time.',
      );
    }
    const [jobId] = jobIds;
    const job = await this.job(actor, jobId);
    for (const { path, doc } of read) {
      if (
        doc.srcLang !== job.sourceLang ||
        !job.languages.includes(doc.trgLang)
      ) {
        throw new UnprocessableError(
          'language-mismatch',
          `The document translates ${doc.srcLang} into ${doc.trgLang}; the job translates ${job.sourceLang} into ${job.languages.join(', ')}.`,
          { lang: doc.trgLang, ...(path !== undefined && { path }) },
        );
      }
    }
    const branch = await this.base(actor, baseRef);
    const base = await this.openSnapshot.handle({ actor, ref: branch });
    const exported = await this.openSnapshot.handle({
      actor,
      ref: job.commit,
      releasedOnce: job.released,
    });
    const config = await base.config();
    const source = config.languages.source;
    const modules: CheckedModule[] = [];
    const budget = new TextBudget();
    const ordered = [...read].sort(
      (a, b) =>
        job.languages.indexOf(a.doc.trgLang) -
        job.languages.indexOf(b.doc.trgLang),
    );
    for (const { doc } of ordered) {
      const lang = doc.trgLang;
      const sent = new Map(
        (await this.jobs.unitsOf(job.id, lang)).map((u) => [
          `${u.moduleId}/${u.blockId}`,
          u,
        ]),
      );
      const files = [...doc.files].sort((a, b) =>
        a.moduleId < b.moduleId ? -1 : 1,
      );
      for (const file of files) {
        const all = (state: CheckedUnit['state']) => ({
          lang,
          moduleId: file.moduleId,
          units: file.units.map((u) => ({ blockId: u.blockId, state })),
        });
        const designId = designIdOf(file.moduleId);
        if (designId !== undefined) {
          modules.push(
            await this.checkDesign(actor, file, designId, {
              lang,
              base,
              exported,
              source,
              exportedSource: job.sourceLang,
              sent,
              budget,
            }),
          );
          continue;
        }
        if (isConfigKey(file.moduleId)) {
          modules.push(
            await this.checkConfig(actor, file, {
              lang,
              base,
              exported,
              source,
              sent,
              budget,
            }),
          );
          continue;
        }
        const manualId = manualIdOf(file.moduleId);
        if (manualId !== undefined) {
          modules.push(
            await this.checkManual(actor, file, manualId, {
              lang,
              base,
              exported,
              source,
              exportedSource: job.sourceLang,
              sent,
              budget,
            }),
          );
          continue;
        }
        const now = await readModule(base, file.moduleId, source);
        const then = await readModule(exported, file.moduleId, source);
        if (!now || !then) {
          modules.push(all('unknown-module'));
          continue;
        }
        if (
          !allows(
            actor,
            'translation.manage',
            moduleTarget({ ...now.meta, lang }, config),
          ) ||
          !(await readTranslation(base, now, lang))
        ) {
          modules.push(all('outside-scope'));
          continue;
        }
        const hashesNow = sourceHashes(now);
        const current = unitsById(now);
        modules.push({
          lang,
          moduleId: file.moduleId,
          title: now.meta.title,
          units: file.units.map((unit) =>
            decide(unit, {
              lang,
              what: 'this module',
              jobUnit: sent.get(`${file.moduleId}/${unit.blockId}`),
              exported: (id) => xliffUnitsOf(then, new Set([id]))[0],
              hashNow: (id) => hashesNow.get(id),
              currentParts: (id) => current().get(id)?.parts,
              budget,
            }),
          ),
        });
      }
    }
    return {
      job,
      languages: job.languages.filter((lang) => languages.has(lang)),
      baseRef: branch,
      base,
      modules,
    };
  }

  /**
   * The units of a page design's region text (#568, the `<file id="design.<id>">`), decided as
   * a module's are: against the design as the job's commit had it (what was sent) and as the
   * base has it now. A design not there (at either, or one that cannot be read) is
   * `unknown-module`; one whose translation into `lang` the actor does not manage
   * (`managesDesignIn`), or that they may not change (`changesDesigns`, which writing it
   * through a change set needs), `outside-scope`.
   */
  private async checkDesign(
    actor: Actor,
    file: ReadFile,
    designId: string,
    at: {
      readonly lang: string;
      readonly base: ReadableContent;
      readonly exported: ReadableContent;
      readonly source: string;
      readonly exportedSource: string;
      readonly sent: ReadonlyMap<string, TranslationJobUnit>;
      readonly budget: TextBudget;
    },
  ): Promise<CheckedModule> {
    const { lang } = at;
    const all = (state: CheckedUnit['state']): CheckedModule => ({
      lang,
      moduleId: file.moduleId,
      designId,
      units: file.units.map((u) => ({ blockId: u.blockId, state })),
    });
    const now = await readDesign(at.base, designId);
    const then = await readDesign(at.exported, designId);
    if (!now || !then) return all('unknown-module');
    if (!managesDesignIn(actor, lang) || !changesDesigns(actor)) {
      return all('outside-scope');
    }
    const sentUnits = new Map(
      xliffUnitsOfDesign(then, at.exportedSource).map((u) => [u.blockId, u]),
    );
    const hashesNow = designSourceHashes(now, at.source);
    const current = new Map(
      designUnits(now, at.source).map((u) => [u.blockId, u.parts]),
    );
    return {
      lang,
      moduleId: file.moduleId,
      designId,
      title: now.name,
      units: file.units.map((unit) =>
        decide(unit, {
          lang,
          what: 'this page design',
          jobUnit: at.sent.get(`${file.moduleId}/${unit.blockId}`),
          exported: (id) => sentUnits.get(id),
          hashNow: (id) => hashesNow.get(id),
          currentParts: (id) => current.get(id),
          budget: at.budget,
        }),
      ),
    };
  }

  /**
   * The units of a manual's own text (#656, the `<file id="manual.<id>">`: its cover images'
   * alternative text), decided as a module's are: against the manifest as the job's commit had
   * it (what was sent) and as the base has it now, both as the actor reads them. A manual not
   * there (at either, one they may not see, or one that cannot be read) is `unknown-module`; one
   * they would not read in `lang` (`seesManualTranslation`), whose translation into `lang` they
   * do not manage (`managesManualIn`), or whose manifest they may not change (`changesManual`,
   * which writing it through a change set needs), `outside-scope`. A translation that is no
   * alternative text (more than one line, or longer than `MAX_COVER_ALT_LENGTH`, its edges
   * trimmed) is `broken-markup` (`invalid-content`).
   */
  private async checkManual(
    actor: Actor,
    file: ReadFile,
    manualId: string,
    at: {
      readonly lang: string;
      readonly base: ReadableContent;
      readonly exported: ReadableContent;
      readonly source: string;
      readonly exportedSource: string;
      readonly sent: ReadonlyMap<string, TranslationJobUnit>;
      readonly budget: TextBudget;
    },
  ): Promise<CheckedModule> {
    const { lang } = at;
    const all = (state: CheckedUnit['state']): CheckedModule => ({
      lang,
      moduleId: file.moduleId,
      manualId,
      units: file.units.map((u) => ({ blockId: u.blockId, state })),
    });
    const now = await readManifest(at.base, manualId);
    const then = await readManifest(at.exported, manualId);
    if (!now || !then) return all('unknown-module');
    if (
      !(await seesManualTranslation(at.base, now, lang)) ||
      !(await managesManualIn(actor, at.base, now, lang)) ||
      !(await changesManual(actor, at.base, manualId))
    ) {
      return all('outside-scope');
    }
    const sentUnits = new Map(
      xliffUnitsOfManifest(then, at.exportedSource).map((u) => [u.blockId, u]),
    );
    const hashesNow = manifestSourceHashes(now, at.source);
    const current = new Map(
      manifestUnits(now, at.source).map((u) => [u.blockId, u.parts]),
    );
    return {
      lang,
      moduleId: file.moduleId,
      manualId,
      title: textIn(now.title, at.source, at.source),
      units: file.units.map((unit) =>
        altText(
          decide(unit, {
            lang,
            what: 'this manual',
            jobUnit: at.sent.get(`${file.moduleId}/${unit.blockId}`),
            exported: (id) => sentUnits.get(id),
            hashNow: (id) => hashesNow.get(id),
            currentParts: (id) => current.get(id),
            budget: at.budget,
          }),
        ),
      ),
    };
  }

  /**
   * The units of the project labels (#731, the `<file id="config.project">`), decided as a
   * module's are: against the configuration as the job's commit had it (what was sent) and as
   * the base has it now. Every reader of a commit reads its configuration, so none is
   * `unknown-module`; where the actor does not manage the labels' translation into `lang`
   * (`managesConfigIn`), or may not change the configuration (`changesConfig`, which writing it
   * through a change set needs), each is `outside-scope`. A translation that is not one line of
   * at most `MAX_COVER_ALT_LENGTH` characters (its edges trimmed) is `broken-markup`
   * (`invalid-content`).
   */
  private async checkConfig(
    actor: Actor,
    file: ReadFile,
    at: {
      readonly lang: string;
      readonly base: ReadableContent;
      readonly exported: ReadableContent;
      readonly source: string;
      readonly sent: ReadonlyMap<string, TranslationJobUnit>;
      readonly budget: TextBudget;
    },
  ): Promise<CheckedModule> {
    const { lang } = at;
    if (!managesConfigIn(actor, lang) || !changesConfig(actor)) {
      return {
        lang,
        moduleId: file.moduleId,
        config: true,
        units: file.units.map((u) => ({
          blockId: u.blockId,
          state: 'outside-scope',
        })),
      };
    }
    const [now, then] = await Promise.all([
      at.base.config(),
      at.exported.config(),
    ]);
    const sentUnits = new Map(
      xliffUnitsOfConfig(then).map((u) => [u.blockId, u]),
    );
    const hashesNow = configSourceHashes(now);
    const current = new Map(
      configUnits(now, at.source).map((u) => [u.blockId, u.parts]),
    );
    return {
      lang,
      moduleId: file.moduleId,
      config: true,
      title: CONFIG_TITLE,
      units: file.units.map((unit) =>
        plainText(
          decide(unit, {
            lang,
            what: 'the project labels',
            jobUnit: at.sent.get(`${file.moduleId}/${unit.blockId}`),
            exported: (id) => sentUnits.get(id),
            hashNow: (id) => hashesNow.get(id),
            currentParts: (id) => current.get(id),
            budget: at.budget,
          }),
          'title',
          'A label',
        ),
      ),
    };
  }

  /** The job the documents name, as the actor may see it. */
  private async job(
    actor: Actor,
    id: string | undefined,
  ): Promise<TranslationJob> {
    const unknown = () => new UnknownJobError();
    if (id === undefined) throw unknown();
    let job: TranslationJob;
    try {
      job = await visibleJob(this.jobs, actor, id);
    } catch (error) {
      if (error instanceof NotFoundError) throw unknown();
      throw error;
    }
    if (job.state === 'cancelled') {
      throw new ConflictError(
        'job-not-open',
        `The translation job "${job.id}" was cancelled; its blocks may have been sent again since.`,
        { state: job.state },
      );
    }
    return job;
  }

  /**
   * A document of a package (#140) as its package describes it: the same job (422
   * `coti-job-mismatch` when the XLIFF's `ccms:job` names another) and the same languages
   * (422 `language-mismatch`), compared as the exchange writes languages.
   */
  private matchEnvelope(
    doc: ReadXliff,
    envelope: ExchangeEnvelope,
    path: string | undefined,
  ): void {
    const job = doc.meta['job'];
    if (job !== undefined && job !== envelope.jobId) {
      throw new UnprocessableError(
        'coti-job-mismatch',
        `${path ?? 'The document'} belongs to another translation job than its package names.`,
        path === undefined ? undefined : { path },
      );
    }
    const same = (tag: string, code: string) =>
      this.exchange.languageCode(tag).toLowerCase() === code.toLowerCase();
    if (
      !same(doc.srcLang, envelope.sourceLanguage) ||
      !same(doc.trgLang, envelope.targetLanguage)
    ) {
      throw new UnprocessableError(
        'language-mismatch',
        `${path ?? 'The document'} translates ${doc.srcLang} into ${doc.trgLang}; its package says ${envelope.sourceLanguage} into ${envelope.targetLanguage}.`,
        { lang: doc.trgLang, ...(path !== undefined && { path }) },
      );
    }
  }

  /** The base branch, as the actor may know of it; 422 `invalid-base` otherwise (as an import's). */
  private async base(
    actor: Actor,
    requested: string | undefined,
  ): Promise<string> {
    const name = requested ?? (await this.branches.defaultBase());
    if (name === undefined) {
      throw new UnprocessableError(
        'invalid-base',
        'Give baseRef: the server’s default ref (CCMS_DEFAULT_REF) names no branch.',
      );
    }
    if (name.startsWith(BRANCH_PREFIX)) {
      throw new UnprocessableError(
        'invalid-base',
        'An import goes into a new change set, which cannot start from another change set’s branch.',
      );
    }
    const branch = await this.refs.branch(actor, name);
    if (!branch) {
      throw new UnprocessableError(
        'invalid-base',
        requested === undefined
          ? 'The server’s default ref (CCMS_DEFAULT_REF) names no branch to import into; give baseRef.'
          : `There is no branch "${name}" to import into.`,
      );
    }
    return branch.name;
  }
}

/** UTF-8 text (a byte-order mark allowed), else 422 `xliff-unsupported-encoding`. */
function decode(bytes: Uint8Array, path?: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new UnprocessableError(
      'xliff-unsupported-encoding',
      `${path ?? 'The file'} is not UTF-8 text.`,
      path === undefined ? undefined : { path },
    );
  }
}

/** The code each refusal of an XLIFF file is answered with (`error-codes.yaml`). */
const XLIFF_CODES = {
  'not-xliff': 'not-xliff',
  'invalid-xliff': 'invalid-xliff',
  'not-well-formed': 'xliff-not-well-formed',
  'dtd-forbidden': 'xliff-dtd-forbidden',
  'too-large': 'xliff-too-large',
  'too-deep': 'xliff-too-deep',
  'too-many-nodes': 'xliff-too-many-nodes',
  'too-many-attributes': 'xliff-too-many-attributes',
  'unsupported-encoding': 'xliff-unsupported-encoding',
} as const satisfies Record<XliffRefusal, string>;

/** The document read strictly; a refusal as 422 with its stable code. */
function parse(
  xliff: string,
  path: string | undefined,
  maxLength: number,
): ReadXliff {
  try {
    return readXliff(xliff, {
      // Fixed bounds, whatever the upload limit (which images share).
      maxLength: Math.min(maxLength, MAX_XLIFF_LENGTH),
      maxDepth: MAX_XLIFF_DEPTH,
      maxNodes: MAX_XLIFF_NODES,
      maxAttributes: 64,
    });
  } catch (error) {
    if (!(error instanceof XliffReadError)) throw error;
    throw new UnprocessableError(
      XLIFF_CODES[error.reason],
      path === undefined ? error.message : `${path}: ${error.message}`,
      path === undefined ? undefined : { path },
    );
  }
}
