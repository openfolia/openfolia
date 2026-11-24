import {
  type ConfigUnitImport,
  CURRENT_TRANSLATION_RECORD_VERSION,
  type ManifestUnitImport,
  mergeConfigTranslation,
  mergeManifestTranslation,
  plainTextOf,
  type TranslatablePart,
  type TranslationRecord,
} from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { allows, ANYWHERE } from '../../../access/core/allows.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidContentError,
  NotFoundError,
  UnavailableError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { AbandonChangeSetAction } from '../../../change-sets/core/actions/abandon-change-set.action.js';
import { AcquireLockAction } from '../../../change-sets/core/actions/acquire-lock.action.js';
import {
  CommitWorkingCopiesAction,
  type TranslationRecordWrite,
} from '../../../change-sets/core/actions/commit-working-copies.action.js';
import { CreateChangeSetAction } from '../../../change-sets/core/actions/create-change-set.action.js';
import { SaveWorkingCopyAction } from '../../../change-sets/core/actions/save-working-copy.action.js';
import type { SubjectOf } from '../../../change-sets/core/lock.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import { CONFIG_KEY } from '../config-translations.js';
import { designKey, readDesign } from '../design-translations.js';
import {
  type DesignUnitImport,
  mergeDesignTranslation,
} from '../design-translation-merge.js';
import { manualKey, readManifest } from '../manual-translations.js';
import { readModule } from '../statuses.js';
import { TranslationEvents } from '../translation-events.js';
import {
  countReport,
  newTranslationImportId,
  type SourceChangedDecision,
  TRANSLATION_IMPORT_TTL_MS,
  type TranslationImport,
} from '../translation-import.js';
import {
  type CheckedModule,
  reportOf,
  TranslationImportCheck,
} from '../translation-import-check.js';
import { TranslationImportStore } from '../translation-import-store.js';
import { mergeTranslation } from '../translation-merge.js';
import { TranslationJobs } from '../translation-jobs.js';
import { Sandbox } from '../../../sandbox/core/sandbox.js';

/** How many imports one server checks at once; more are 503 `import-busy`. */
export const MAX_CONCURRENT_TRANSLATION_IMPORTS = 2;

/** What the upload form gave. */
export interface TranslationImportForm {
  readonly bytes: Uint8Array;
  /** The branch to check against and import into; the server's default when left out. */
  readonly baseRef?: string;
}

/** Bounds the checks running at once (they hold an upload and its parse in memory). */
@Injectable()
export class TranslationImportGate {
  #running = 0;

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.#running >= MAX_CONCURRENT_TRANSLATION_IMPORTS) {
      throw new UnavailableError(
        'import-busy',
        'The server is checking other translation imports; try again shortly.',
        5,
      );
    }
    this.#running++;
    try {
      return await work();
    } finally {
      this.#running--;
    }
  }
}

const ownImport = (
  stored: TranslationImport | undefined,
  actor: Actor,
  id: string,
) => {
  if (
    !stored ||
    stored.createdBy.kind !== actor.kind ||
    stored.createdBy.id !== actor.id
  ) {
    throw new NotFoundError(`No translation import "${id}".`);
  }
  return stored;
};

/**
 * Validates a translation import (#51), the dry run of `POST
 * /translations/imports`: reads the upload (an XLIFF document, or a ZIP of
 * them) and decides each unit (`TranslationImportCheck`), and keeps the
 * documents and the report for an hour (`TRANSLATION_IMPORT_TTL_MS`) so it
 * can be applied. Writes nothing else: no change set, no Git object, no
 * row. Needs `translation.manage` (and, through the check, the language in
 * the actor's scope); the form is read only once that is checked, and at
 * most `MAX_CONCURRENT_TRANSLATION_IMPORTS` run at once (503
 * `import-busy`). A full store is 503 `too-many-imports`.
 */
@Injectable()
export class ValidateTranslationImportAction extends ActorAction<
  {
    readonly actor: Actor;
    readonly form: () => Promise<TranslationImportForm>;
  },
  TranslationImport
> {
  readonly policy = 'translation.manage';

  constructor(
    private readonly check: TranslationImportCheck,
    private readonly store: TranslationImportStore,
    private readonly gate: TranslationImportGate,
    private readonly sandbox: Sandbox = Sandbox.OFF,
  ) {
    super();
  }

  protected async run({
    actor,
    form,
  }: {
    readonly actor: Actor;
    readonly form: () => Promise<TranslationImportForm>;
  }): Promise<TranslationImport> {
    this.sandbox.refuse('imports');
    // The upload is read before a slot is taken: a slow one holds none.
    const { bytes, baseRef } = await form();
    return this.gate.run(async () => {
      const documents = await this.check.documents(bytes);
      const checked = await this.check.check(actor, documents, baseRef);
      const modules = reportOf(checked.modules);
      const now = Date.now();
      const record: TranslationImport = {
        id: newTranslationImportId(now),
        jobId: checked.job.id,
        languages: checked.languages,
        baseRef: checked.baseRef,
        baseCommit: checked.base.commit,
        state: 'validated',
        createdBy: { kind: actor.kind, id: actor.id },
        createdAt: new Date(now),
        expiresAt: new Date(now + TRANSLATION_IMPORT_TTL_MS),
        counts: countReport(modules),
        modules,
      };
      if (!(await this.store.add({ import: record, documents }))) {
        throw new UnavailableError(
          'too-many-imports',
          'The server keeps as many translation imports as it holds; try again once some are applied or expired.',
          60,
        );
      }
      return record;
    });
  }
}

/** A validated or applied translation import, its uploader's only (404 for anyone else). Needs `translation.manage`. */
@Injectable()
export class GetTranslationImportAction extends ActorAction<
  { readonly actor: Actor; readonly id: string },
  TranslationImport
> {
  readonly policy = 'translation.manage';

  constructor(private readonly store: TranslationImportStore) {
    super();
  }

  protected async run({
    actor,
    id,
  }: {
    readonly actor: Actor;
    readonly id: string;
  }): Promise<TranslationImport> {
    return ownImport((await this.store.find(id))?.import, actor, id);
  }
}

/** A decision on one `source-changed` unit. */
export interface UnitDecision {
  readonly lang: string;
  readonly moduleId: string;
  readonly blockId: string;
  readonly decision: SourceChangedDecision;
}

export interface ApplyTranslationImportInput {
  readonly actor: Actor;
  readonly id: string;
  /** Per `source-changed` unit; one not named is `keep`. */
  readonly decisions: readonly UnitDecision[];
}

const unitKey = (lang: string, moduleId: string, blockId: string) =>
  `${lang}/${moduleId}/${blockId}`;

/** A module of the import, with what goes into it. */
interface Planned {
  readonly subject: SubjectOf<'module'>;
  /** The translated parts by block ID, with the hash each was exported with. */
  readonly units: ReadonlyMap<
    string,
    { readonly parts: readonly TranslatablePart[]; readonly hash: string }
  >;
}

/**
 * Applies a validated translation import (#51, `POST
 * /translations/imports/:id/apply`), through the change-set actions an
 * editor's work takes, never around them:
 *
 * 1. The stored documents are checked again against the base as it is
 *    now (`TranslationImportCheck`), so what is written is decided then.
 *    What is imported: `ok` units, and `source-changed` ones unless their
 *    decision is `skip` (`keep` is the default; their translation record
 *    keeps the hash they were exported with, so they stay `outdated`).
 *    Nothing to import is 422 `nothing-to-import`.
 * 2. `CreateChangeSetAction` starts a change set named after the job,
 *    from the import's base; `AcquireLockAction` locks each target module;
 *    `SaveWorkingCopyAction` writes each as a working copy, its units
 *    merged in by block ID (`mergeTranslation`: a block the target lacks
 *    comes from the source's structure; image and attachment references,
 *    variant conditions and IDs of the target stay).
 * 3. `CommitWorkingCopiesAction` makes one save point holding the working
 *    copies and each module's translation record (the source hash each
 *    unit was exported from, the job's commit as `sourceCommit`), and in
 *    its write transaction the job's units become `returned`
 *    (`TranslationJobs.returnUnits`), with one `translation.import` audit
 *    event and a `translation.imported` outbox row.
 *
 * Each step checks what it always does (`content.edit` and the scope of
 * every module, the author, the locks); a failure abandons the change set
 * (nothing of the import is committed) and leaves the import `validated`.
 * Only its uploader, once (409 `invalid-state` while it is being applied
 * or once it is), within the hour. Needs `translation.manage`, and
 * `content.edit` for the change set.
 */
@Injectable()
export class ApplyTranslationImportAction extends ActorAction<
  ApplyTranslationImportInput,
  TranslationImport
> {
  readonly policy = 'translation.manage';

  constructor(
    private readonly check: TranslationImportCheck,
    private readonly store: TranslationImportStore,
    private readonly gate: TranslationImportGate,
    private readonly jobs: TranslationJobs,
    private readonly createChangeSet: CreateChangeSetAction,
    private readonly acquireLock: AcquireLockAction,
    private readonly saveWorkingCopy: SaveWorkingCopyAction,
    private readonly commitWorkingCopies: CommitWorkingCopiesAction,
    private readonly abandonChangeSet: AbandonChangeSetAction,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly auditLog: AuditLog,
    private readonly events: TranslationEvents,
    private readonly sandbox: Sandbox = Sandbox.OFF,
  ) {
    super();
  }

  protected async run(
    input: ApplyTranslationImportInput,
  ): Promise<TranslationImport> {
    this.sandbox.refuse('imports');
    const { actor, id } = input;
    const found = ownImport((await this.store.find(id))?.import, actor, id);
    if (!allows(actor, 'content.edit', ANYWHERE)) {
      throw new ForbiddenError(
        'Applying a translation import makes a change set: it needs the content.edit permission too.',
      );
    }
    const stored =
      found.state === 'validated' ? await this.store.claim(id) : undefined;
    if (!stored) {
      throw new ConflictError(
        'invalid-state',
        found.state === 'applied'
          ? 'The import is applied already.'
          : 'The import is being applied now.',
        { state: found.state === 'applied' ? 'applied' : 'applying' },
      );
    }
    let changeSetId: string | undefined;
    try {
      const result = await this.gate.run(async () => {
        const made = await this.apply(
          input,
          stored.documents,
          stored.import.baseRef,
          (made) => {
            changeSetId = made;
          },
        );
        return made;
      });
      // As the store keeps it now (its hour starts again).
      const settled = await this.store.settle(id, result);
      return settled ?? { ...stored.import, ...result, state: 'applied' };
    } catch (error) {
      if (changeSetId !== undefined) await this.abandon(actor, changeSetId);
      await this.store.settle(id, undefined);
      throw error;
    }
  }

  private async apply(
    { actor, id, decisions }: ApplyTranslationImportInput,
    documents: Parameters<TranslationImportCheck['check']>[1],
    baseRef: string,
    started: (changeSetId: string) => void,
  ): Promise<
    Pick<TranslationImport, 'changeSetId' | 'commit' | 'counts' | 'modules'>
  > {
    const checked = await this.check.check(actor, documents, baseRef);
    const { job } = checked;
    const skipped = new Set(
      decisions
        .filter((d) => d.decision === 'skip')
        .map((d) => unitKey(d.lang, d.moduleId, d.blockId)),
    );
    const planned = plan(checked.modules, skipped);
    const designs = planDesigns(checked.modules, skipped);
    const manuals = planManuals(checked.modules, skipped);
    const config = planConfig(checked.modules, skipped);
    if (
      planned.length === 0 &&
      designs.length === 0 &&
      manuals.length === 0 &&
      config === undefined
    ) {
      throw new UnprocessableError(
        'nothing-to-import',
        'No unit of the import can be imported now (each is refused, or skipped).',
      );
    }
    const languages = checked.languages.join(', ');
    const changeSet = await this.createChangeSet.handle({
      actor,
      title: `Translation import of job ${job.id} (${languages})`.slice(0, 200),
      description: `Translations into ${languages} from the translation job ${job.id}, exported from ${job.commit} (import ${id}).`,
      baseRef: checked.baseRef,
    });
    started(changeSet.id);
    const configs = config === undefined ? [] : [config];
    for (const { subject } of [
      ...configs,
      ...designs,
      ...manuals,
      ...planned,
    ]) {
      await this.acquireLock.handle({
        actor,
        changeSetId: changeSet.id,
        subject,
      });
    }
    const head = await this.openSnapshot.handle({
      actor,
      ref: changeSet.branch,
    });
    const headConfig = await head.config();
    const source = headConfig.languages.source;
    if (config !== undefined) {
      // The project labels (#731): one working copy of openfolia.yaml, every language's labels in it.
      let merged = headConfig;
      for (const [lang, units] of config.languages) {
        merged = mergeConfigTranslation(merged, lang, job.commit, units);
      }
      await this.saveWorkingCopy.handle({
        actor,
        changeSetId: changeSet.id,
        subject: config.subject,
        content: merged,
        version: 0,
      });
    }
    for (const { subject, languages: byLang } of designs) {
      const design = await readDesign(head, subject.designId);
      if (!design) {
        throw new ConflictError(
          'source-moved',
          `The page design "${subject.designId}" is gone from the base; validate the import again.`,
          { designId: subject.designId },
        );
      }
      let merged = design;
      for (const [lang, units] of byLang) {
        merged = mergeDesignTranslation(
          merged,
          lang,
          source,
          job.commit,
          units,
        );
      }
      await this.saveWorkingCopy.handle({
        actor,
        changeSetId: changeSet.id,
        subject,
        content: merged,
        version: 0,
      });
    }
    for (const { subject, languages: byLang } of manuals) {
      const manifest = await readManifest(head, subject.manualId);
      if (!manifest) {
        throw new ConflictError(
          'source-moved',
          `The manual "${subject.manualId}" is gone from the base; validate the import again.`,
          { manualId: subject.manualId },
        );
      }
      let merged = manifest;
      for (const [lang, units] of byLang) {
        merged = mergeManifestTranslation(
          merged,
          lang,
          source,
          job.commit,
          units,
        );
      }
      await this.saveWorkingCopy.handle({
        actor,
        changeSetId: changeSet.id,
        subject,
        content: merged,
        version: 0,
      });
    }
    const records: TranslationRecordWrite[] = [];
    for (const { subject, units } of planned) {
      const original = await readModule(head, subject.moduleId, source);
      if (!original) {
        throw new ConflictError(
          'source-moved',
          `The source module "${subject.moduleId}" is gone from the base; validate the import again.`,
          { moduleId: subject.moduleId },
        );
      }
      const target = await readModule(head, subject.moduleId, subject.lang);
      const path = `modules/${subject.lang}/${subject.moduleId}.adoc`;
      if (!target && (await head.sourceForCheck(path)) !== undefined) {
        throw new UnprocessableError(
          'unreadable-translation',
          `The ${subject.lang} translation of "${subject.moduleId}" cannot be read, so nothing is merged into it; fix or remove it first.`,
          { lang: subject.lang, moduleId: subject.moduleId },
        );
      }
      const merged = mergeTranslation(
        target,
        original,
        subject.lang,
        new Map([...units].map(([blockId, u]) => [blockId, u.parts])),
      );
      await this.saveWorkingCopy.handle({
        actor,
        changeSetId: changeSet.id,
        subject,
        content: merged,
        version: 0,
      });
      records.push({
        subject,
        record: recordWith(
          await existingRecord(head, subject),
          job.commit,
          new Map([...units].map(([blockId, u]) => [blockId, u.hash])),
        ),
      });
    }
    const returned = [
      ...configs.flatMap(({ languages: byLang }) =>
        [...byLang].flatMap(([lang, units]) =>
          [...units.keys()].map((blockId) => ({
            lang,
            moduleId: CONFIG_KEY,
            blockId,
          })),
        ),
      ),
      ...designs.flatMap(({ subject, languages: byLang }) =>
        [...byLang].flatMap(([lang, units]) =>
          [...units.keys()].map((blockId) => ({
            lang,
            moduleId: designKey(subject.designId),
            blockId,
          })),
        ),
      ),
      ...manuals.flatMap(({ subject, languages: byLang }) =>
        [...byLang].flatMap(([lang, units]) =>
          [...units.keys()].map((blockId) => ({
            lang,
            moduleId: manualKey(subject.manualId),
            blockId,
          })),
        ),
      ),
      ...planned.flatMap(({ subject, units }) =>
        [...units.keys()].map((blockId) => ({
          lang: subject.lang,
          moduleId: subject.moduleId,
          blockId,
        })),
      ),
    ];
    const modules = reportOf(checked.modules);
    const counts = countReport(modules);
    const kept = returned.length - counts.ok;
    const outcome = await this.commitWorkingCopies.handle({
      actor,
      changeSetId: changeSet.id,
      subjects: [
        ...configs.map((c) => c.subject),
        ...designs.map((d) => d.subject),
        ...manuals.map((m) => m.subject),
        ...planned.map((p) => p.subject),
      ],
      message: `Import translations into ${languages} (job ${job.id})`,
      translationRecords: records,
      after: async (tx, { commit }) => {
        const state = await this.jobs.returnUnits(tx, job.id, returned);
        await this.auditLog.record(tx, actor, {
          action: 'translation.import',
          subject: { type: 'translation-import', id },
          data: {
            jobId: job.id,
            jobState: state ?? null,
            changeSetId: changeSet.id,
            commit: commit ?? null,
            languages: [...checked.languages],
            modules: planned.length,
            designs: designs.length,
            manuals: manuals.length,
            config: config !== undefined,
            units: returned.length,
            kept,
            skipped: counts['source-changed'] - kept,
            refused: counts.units - counts.ok - counts['source-changed'],
          },
        });
        await this.events.emit(tx, {
          topic: 'translation.imported',
          key: id,
          payload: {
            importId: id,
            importer: { kind: actor.kind, id: actor.id },
            actor: { kind: actor.kind, id: actor.id },
            changeSetId: changeSet.id,
            jobId: job.id,
            languages: [...checked.languages],
            // The modules, as many as a reader of the row needs to see.
            modules: planned.slice(0, MAX_EVENT_MODULES).map(({ subject }) => ({
              lang: subject.lang,
              moduleId: subject.moduleId,
            })),
            moduleCount: planned.length,
            // Since #656: the page designs and manuals it changed, per language, as the modules.
            designs: perLanguage(designs, (d) => ({
              designId: d.subject.designId,
            })),
            designCount: designs.length,
            manuals: perLanguage(manuals, (m) => ({
              manualId: m.subject.manualId,
            })),
            manualCount: manuals.length,
            // Since #731: the project labels' languages it changed.
            configLanguages:
              config === undefined ? [] : [...config.languages.keys()],
          },
        });
      },
    });
    return {
      changeSetId: changeSet.id,
      commit: outcome.commit ?? null,
      counts,
      modules,
    };
  }

  /** Abandons the change set a failed apply started; a failure of that is left for its author. */
  private async abandon(actor: Actor, changeSetId: string): Promise<void> {
    try {
      await this.abandonChangeSet.handle({
        actor,
        id: changeSetId,
        comment: 'The translation import failed; nothing of it was committed.',
      });
    } catch {
      // The change set stays a draft of its author's, who may abandon it.
    }
  }
}

/** The most modules a `translation.imported` row names one by one. */
export const MAX_EVENT_MODULES = 1_000;

/** What goes into each module: `ok` units, and `source-changed` ones not skipped. */
function plan(
  modules: readonly CheckedModule[],
  skipped: ReadonlySet<string>,
): Planned[] {
  const planned: Planned[] = [];
  for (const { lang, moduleId, designId, manualId, config, units } of modules) {
    // A page design's region text (#568) is `planDesigns`', a manual's own text (#656)
    // `planManuals`', the project labels (#731) `planConfig`'s.
    if (designId !== undefined || manualId !== undefined || config === true) {
      continue;
    }
    const chosen = new Map<
      string,
      { parts: readonly TranslatablePart[]; hash: string }
    >();
    for (const unit of units) {
      if (!unit.parts || unit.exportedHash === undefined) continue;
      if (
        unit.state === 'source-changed' &&
        skipped.has(unitKey(lang, moduleId, unit.blockId))
      ) {
        continue;
      }
      if (unit.state !== 'ok' && unit.state !== 'source-changed') continue;
      chosen.set(unit.blockId, { parts: unit.parts, hash: unit.exportedHash });
    }
    if (chosen.size > 0) {
      planned.push({
        subject: { type: 'module', lang, moduleId },
        units: chosen,
      });
    }
  }
  return planned;
}

/** A page design of the import (#568): per target language, its units by unit key. */
interface PlannedDesign {
  readonly subject: SubjectOf<'design'>;
  readonly languages: ReadonlyMap<
    string,
    ReadonlyMap<string, DesignUnitImport>
  >;
}

/**
 * What goes into each page design (#568), as `plan` chooses a module's units: one subject per
 * design, whatever the languages (a design is one file), its languages in the import's order.
 */
function planDesigns(
  modules: readonly CheckedModule[],
  skipped: ReadonlySet<string>,
): PlannedDesign[] {
  const found = new Map<string, Map<string, Map<string, DesignUnitImport>>>();
  for (const { lang, moduleId, designId, units } of modules) {
    if (designId === undefined) continue;
    for (const unit of units) {
      if (!unit.parts || unit.exportedHash === undefined) continue;
      if (unit.state !== 'ok' && unit.state !== 'source-changed') continue;
      if (
        unit.state === 'source-changed' &&
        skipped.has(unitKey(lang, moduleId, unit.blockId))
      ) {
        continue;
      }
      const byLang = found.get(designId) ?? new Map();
      found.set(designId, byLang);
      const chosen = byLang.get(lang) ?? new Map<string, DesignUnitImport>();
      byLang.set(lang, chosen);
      chosen.set(unit.blockId, { parts: unit.parts, hash: unit.exportedHash });
    }
  }
  return [...found].map(([designId, languages]) => ({
    subject: { type: 'design', designId },
    languages,
  }));
}

/** A manual of the import (#656): per target language, its units by unit key. */
interface PlannedManual {
  readonly subject: SubjectOf<'manual'>;
  readonly languages: ReadonlyMap<
    string,
    ReadonlyMap<string, ManifestUnitImport>
  >;
}

/**
 * What goes into each manual's manifest (#656), as `planDesigns` chooses a design's units: one
 * subject per manual, whatever the languages, each unit's text plain (`altText` made it one
 * line, trimmed).
 */
function planManuals(
  modules: readonly CheckedModule[],
  skipped: ReadonlySet<string>,
): PlannedManual[] {
  const found = new Map<string, Map<string, Map<string, ManifestUnitImport>>>();
  for (const { lang, moduleId, manualId, units } of modules) {
    if (manualId === undefined) continue;
    for (const unit of units) {
      if (!unit.parts || unit.exportedHash === undefined) continue;
      if (unit.state !== 'ok' && unit.state !== 'source-changed') continue;
      if (
        unit.state === 'source-changed' &&
        skipped.has(unitKey(lang, moduleId, unit.blockId))
      ) {
        continue;
      }
      const byLang = found.get(manualId) ?? new Map();
      found.set(manualId, byLang);
      const chosen = byLang.get(lang) ?? new Map<string, ManifestUnitImport>();
      byLang.set(lang, chosen);
      chosen.set(unit.blockId, {
        text: unit.parts.map((p) => plainTextOf(p.content).text).join(' '),
        hash: unit.exportedHash,
      });
    }
  }
  return [...found].map(([manualId, languages]) => ({
    subject: { type: 'manual', manualId },
    languages,
  }));
}

/** The project labels of the import (#731): per target language, their units by unit key. */
interface PlannedConfig {
  readonly subject: SubjectOf<'config'>;
  readonly languages: ReadonlyMap<
    string,
    ReadonlyMap<string, ConfigUnitImport>
  >;
}

/**
 * What goes into the project labels (#731), as `planManuals` chooses a manual's units: one
 * subject (`openfolia.yaml`) whatever the languages, each unit's text plain (`plainText` made it one
 * line, trimmed); undefined when there is none.
 */
function planConfig(
  modules: readonly CheckedModule[],
  skipped: ReadonlySet<string>,
): PlannedConfig | undefined {
  const languages = new Map<string, Map<string, ConfigUnitImport>>();
  for (const { lang, moduleId, config, units } of modules) {
    if (config !== true) continue;
    for (const unit of units) {
      if (!unit.parts || unit.exportedHash === undefined) continue;
      if (unit.state !== 'ok' && unit.state !== 'source-changed') continue;
      if (
        unit.state === 'source-changed' &&
        skipped.has(unitKey(lang, moduleId, unit.blockId))
      ) {
        continue;
      }
      const chosen = languages.get(lang) ?? new Map<string, ConfigUnitImport>();
      languages.set(lang, chosen);
      chosen.set(unit.blockId, {
        text: unit.parts.map((p) => plainTextOf(p.content).text).join(' '),
        hash: unit.exportedHash,
      });
    }
  }
  return languages.size === 0
    ? undefined
    : { subject: { type: 'config' }, languages };
}

/** Each planned subject in each of its languages, as an event names it, at most `MAX_EVENT_MODULES`. */
function perLanguage<
  T extends { readonly languages: ReadonlyMap<string, unknown> },
>(
  planned: readonly T[],
  name: (subject: T) => Record<string, string>,
): Record<string, string>[] {
  return planned
    .flatMap((p) =>
      [...p.languages.keys()].map((lang) => ({ lang, ...name(p) })),
    )
    .slice(0, MAX_EVENT_MODULES);
}

/** The target's translation record as committed; a broken one counts as none. */
async function existingRecord(
  head: ReadableContent,
  subject: SubjectOf<'module'>,
): Promise<TranslationRecord | undefined> {
  try {
    return await head.translationRecord(subject.moduleId, subject.lang);
  } catch (error) {
    if (error instanceof InvalidContentError) return undefined;
    throw error;
  }
}

/** `record` (or none) with `hashes` (block ID → the source hash it was translated from) taken in. */
export function recordWith(
  record: TranslationRecord | undefined,
  sourceCommit: string,
  hashes: ReadonlyMap<string, string>,
): TranslationRecord {
  const blocks: Record<string, string> = {};
  for (const [blockId, hash] of Object.entries(record?.blocks ?? {})) {
    if (blockId !== '__proto__') blocks[blockId] = hash;
  }
  for (const [blockId, hash] of hashes) {
    if (blockId !== '__proto__') blocks[blockId] = hash;
  }
  return {
    schemaVersion: CURRENT_TRANSLATION_RECORD_VERSION,
    sourceCommit,
    blocks,
  };
}
