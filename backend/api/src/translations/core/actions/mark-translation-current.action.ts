import {
  markConfigCurrent,
  markDesignCurrent,
  markManifestCurrent,
  sourceHashes,
  walk,
} from '@openfolia/content-model';
import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { allows, moduleTarget } from '../../../access/core/allows.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  ForbiddenError,
  InvalidContentError,
  NotFoundError,
  UnprocessableError,
} from '../../../base/core/errors.js';
import { AcquireLockAction } from '../../../change-sets/core/actions/acquire-lock.action.js';
import { DiscardWorkingCopyAction } from '../../../change-sets/core/actions/discard-working-copy.action.js';
import { CommitWorkingCopiesAction } from '../../../change-sets/core/actions/commit-working-copies.action.js';
import { GetChangeSetAction } from '../../../change-sets/core/actions/get-change-set.action.js';
import { SaveWorkingCopyAction } from '../../../change-sets/core/actions/save-working-copy.action.js';
import {
  type LockSubject,
  type SubjectOf,
  subjectKey,
} from '../../../change-sets/core/lock.js';
import { WorkingCopyStore } from '../../../change-sets/core/working-copy-store.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import {
  changesConfig,
  CONFIG_KEY,
  managesConfigIn,
} from '../config-translations.js';
import {
  changesDesigns,
  designKey,
  managesDesignIn,
  readDesign,
} from '../design-translations.js';
import {
  changesManual,
  managesManualIn,
  manualKey,
  readManifest,
  seesManualTranslation,
} from '../manual-translations.js';
import { readModule } from '../statuses.js';
import { recordWith } from './translation-imports.action.js';

export interface MarkTranslationCurrentInput {
  readonly actor: Actor;
  readonly changeSetId: string;
  /**
   * Exactly one of a module, a page design (#656), a manual (#656, its own text) and the
   * project labels (#731, `config: true`).
   */
  readonly moduleId?: string | undefined;
  readonly designId?: string | undefined;
  readonly manualId?: string | undefined;
  readonly config?: boolean | undefined;
  /** A target language. */
  readonly lang: string;
}

/** What marking a translation current did. */
export interface MarkedCurrent {
  readonly changeSetId: string;
  readonly branch: string;
  readonly lang: string;
  /**
   * The module's ID; a page design's key (`designKey`), a manual's (`manualKey`) or the project
   * labels' (`config.project`).
   */
  readonly moduleId: string;
  readonly designId?: string;
  readonly manualId?: string;
  readonly config?: true;
  /** The save point's commit; null when the record said so already. */
  readonly commit: string | null;
  /** The blocks the record now names as translated from their current source. */
  readonly blocks: number;
}

/**
 * Marks a module's translation into `lang` as current (#51, `POST
 * /translations/mark-current`), for a source fix that needs no new
 * translation: on the change set's branch, the translation record takes
 * the source's current hash for every block the translation has (and the
 * branch head as `sourceCommit`), without changing the translated text,
 * so those blocks become `up-to-date` once merged. A block the
 * translation lacks keeps what its record said (it is still to be
 * translated).
 *
 * Through the change-set actions: `AcquireLockAction` on the translated
 * module, then a save point (`CommitWorkingCopiesAction`) writing only the
 * record, with a `translation.mark-current` audit event in its write
 * transaction. The change set must be the actor's own draft and must hold
 * no working copy of that module (409 `uncommitted-working-copies`). The record's write and the
 * working copies below are based on the head read here (#957): a save point that changed the
 * file since is 409 `stale-working-copy`, never overwritten.
 * Needs `translation.manage` on the module in `lang` (403 otherwise) and
 * `content.edit` (for the lock and the commit). A source module the actor
 * does not see is 404; `lang` that is no target language 422
 * `invalid-parameter`; no translation there 422 `translation-missing`.
 *
 * A page design's region text or a manual's own text (#656: its cover images' alternative
 * text) is marked current the same way, its record being part of its file: the design's or
 * manifest's lock, then a save point of its working copy, which changes only the record.
 * A design needs `translation.manage` in a role restricted by nothing but languages, `lang`
 * among them (`managesDesignIn`), and unrestricted `content.edit` (`changesDesigns`); a manual
 * `translation.manage` over its audience in `lang` (`managesManualIn`) and the right to change
 * its manifest (`changesManual`). Neither may have a working copy in the change set already
 * (409 `uncommitted-working-copies`); without text of its own in `lang`, 422
 * `translation-missing`.
 *
 * The project labels (#731, `config`) likewise: their record is part of `openfolia.yaml`, so the
 * configuration's lock, a working copy changing only its record and a save point. Needs
 * `translation.manage` in a role restricted by nothing but languages, `lang` among them
 * (`managesConfigIn`), and the right to change the configuration (`changesConfig`).
 */
@Injectable()
export class MarkTranslationCurrentAction extends ActorAction<
  MarkTranslationCurrentInput,
  MarkedCurrent
> {
  readonly policy = 'translation.manage';

  constructor(
    private readonly getChangeSet: GetChangeSetAction,
    private readonly openSnapshot: OpenSnapshotAction,
    private readonly acquireLock: AcquireLockAction,
    private readonly commitWorkingCopies: CommitWorkingCopiesAction,
    private readonly saveWorkingCopy: SaveWorkingCopyAction,
    private readonly workingCopies: WorkingCopyStore,
    private readonly auditLog: AuditLog,
    private readonly discardWorkingCopy: DiscardWorkingCopyAction,
  ) {
    super();
  }

  protected async run(
    input: MarkTranslationCurrentInput,
  ): Promise<MarkedCurrent> {
    const { actor, changeSetId, lang } = input;
    const named = [
      input.moduleId,
      input.designId,
      input.manualId,
      input.config === true ? true : undefined,
    ].filter((x) => x !== undefined);
    if (named.length !== 1) {
      throw new UnprocessableError(
        'invalid-parameter',
        'Name exactly one of a module, a page design, a manual and the project labels.',
      );
    }
    const changeSet = await this.getChangeSet.handle({
      actor,
      id: changeSetId,
    });
    const head = await this.openSnapshot.handle({
      actor,
      ref: changeSet.branch,
    });
    const config = await head.config();
    if (!config.languages.targets.includes(lang)) {
      throw new UnprocessableError(
        'invalid-parameter',
        `"${lang}" is no configured target language.`,
      );
    }
    const at = { actor, changeSetId, branch: changeSet.branch, head, lang };
    if (input.config === true) return this.config(at);
    if (input.designId !== undefined) return this.design(at, input.designId);
    if (input.manualId !== undefined) return this.manual(at, input.manualId);
    const moduleId = input.moduleId as string;
    const source = await readModule(head, moduleId, config.languages.source);
    if (!source) throw new NotFoundError(`No module "${moduleId}".`);
    if (
      !allows(
        actor,
        'translation.manage',
        moduleTarget({ ...source.meta, lang }, config),
      )
    ) {
      throw new ForbiddenError(
        `You do not manage translations of this module into "${lang}".`,
      );
    }
    const target = await readModule(head, moduleId, lang);
    if (!target) {
      throw new UnprocessableError(
        'translation-missing',
        `The module has no translation into "${lang}" you may read here.`,
      );
    }
    const subject: SubjectOf<'module'> = { type: 'module', lang, moduleId };
    await this.acquireLock.handle({ actor, changeSetId, subject });
    // The target's blocks, items and image callouts (#548: a legend is a unit by its callout's ID).
    const has = new Set(
      [...walk(target.blocks)].flatMap(({ kind, node }) => [
        node.id,
        ...(kind === 'block' && node.type === 'image'
          ? (node.callouts ?? []).map((c) => c.id)
          : []),
      ]),
    );
    const hashes = new Map(
      [...sourceHashes(source)].filter(([blockId]) => has.has(blockId)),
    );
    let record;
    try {
      record = await head.translationRecord(moduleId, lang);
    } catch (error) {
      // A record that cannot be read is replaced.
      if (!(error instanceof InvalidContentError)) throw error;
      record = undefined;
    }
    const outcome = await this.commitWorkingCopies.handle({
      actor,
      changeSetId,
      subjects: [],
      message: `Mark the ${lang} translation of ${moduleId} as current`,
      translationRecords: [
        {
          subject,
          record: recordWith(record, head.commit, hashes),
          // A record changed since it was read here is 409, never overwritten (#957).
          baseCommit: head.commit,
        },
      ],
      after: async (tx, { commit }) => {
        await this.auditLog.record(tx, actor, {
          action: 'translation.mark-current',
          subject: { type: 'module', id: `${lang}/${moduleId}` },
          data: {
            changeSetId,
            commit: commit ?? null,
            sourceCommit: head.commit,
            blocks: hashes.size,
          },
        });
      },
    });
    return {
      changeSetId,
      branch: changeSet.branch,
      lang,
      moduleId,
      commit: outcome.commit ?? null,
      blocks: hashes.size,
    };
  }

  /** The project labels in `lang` (#731). */
  private async config(at: Marking): Promise<MarkedCurrent> {
    const { actor, head, lang } = at;
    if (!managesConfigIn(actor, lang) || !changesConfig(actor)) {
      throw new ForbiddenError(
        `You do not manage translations of the project labels into "${lang}", or may not change the configuration.`,
      );
    }
    const marked = markConfigCurrent(await head.config(), lang, head.commit);
    if (marked.units === 0) {
      throw new UnprocessableError(
        'translation-missing',
        `No project label has text of its own in "${lang}".`,
      );
    }
    return this.markFile(at, { type: 'config' }, marked.config, marked.units, {
      moduleId: CONFIG_KEY,
      config: true,
    });
  }

  /** A page design's region text in `lang` (#656). */
  private async design(at: Marking, designId: string): Promise<MarkedCurrent> {
    const { actor, head, lang } = at;
    const design = await readDesign(head, designId);
    if (!design) throw new NotFoundError(`No page design "${designId}".`);
    if (!managesDesignIn(actor, lang) || !changesDesigns(actor)) {
      throw new ForbiddenError(
        `You do not manage translations of page designs into "${lang}", or may not change them.`,
      );
    }
    const source = (await head.config()).languages.source;
    const marked = markDesignCurrent(design, lang, source, head.commit);
    if (marked.units === 0) {
      throw new UnprocessableError(
        'translation-missing',
        `The page design has no text of its own in "${lang}".`,
      );
    }
    return this.markFile(
      at,
      { type: 'design', designId },
      marked.design,
      marked.units,
      { moduleId: designKey(designId), designId },
    );
  }

  /** A manual's own text in `lang` (#656: its cover images' alternative text). */
  private async manual(at: Marking, manualId: string): Promise<MarkedCurrent> {
    const { actor, head, lang } = at;
    const manifest = await readManifest(head, manualId);
    if (!manifest) throw new NotFoundError(`No manual "${manualId}".`);
    if (
      !(await seesManualTranslation(head, manifest, lang)) ||
      !(await managesManualIn(actor, head, manifest, lang)) ||
      !(await changesManual(actor, head, manualId))
    ) {
      throw new ForbiddenError(
        `You do not manage translations of this manual into "${lang}", or may not change it.`,
      );
    }
    const source = (await head.config()).languages.source;
    const marked = markManifestCurrent(manifest, lang, source, head.commit);
    if (marked.units === 0) {
      throw new UnprocessableError(
        'translation-missing',
        `The manual has no cover image text of its own in "${lang}".`,
      );
    }
    return this.markFile(
      at,
      { type: 'manual', manualId },
      marked.manifest,
      marked.units,
      { moduleId: manualKey(manualId), manualId },
    );
  }

  /**
   * Writes a design's, manifest's or the configuration's new record (`content`, its text unchanged) through the
   * change-set actions: its lock, a working copy (none may be there yet: 409
   * `uncommitted-working-copies`) and a save point of it, with the audit event.
   */
  private async markFile(
    at: Marking,
    subject: SubjectOf<'design'> | SubjectOf<'manual'> | SubjectOf<'config'>,
    content: Parameters<SaveWorkingCopyAction['handle']>[0]['content'],
    units: number,
    named: Pick<MarkedCurrent, 'moduleId' | 'designId' | 'manualId' | 'config'>,
  ): Promise<MarkedCurrent> {
    const { actor, changeSetId, head, lang } = at;
    await this.acquireLock.handle({ actor, changeSetId, subject });
    if (await this.workingCopies.find(changeSetId, subject)) {
      throw new ConflictError(
        'uncommitted-working-copies',
        'Commit or discard the working copy of this subject first.',
        { subjects: [subject as LockSubject] },
      );
    }
    await this.saveWorkingCopy.handle({
      actor,
      changeSetId,
      subject,
      content,
      version: 0,
      // The commit the content was read from (#957): a file a save point changed since is 409
      // `stale-working-copy`, never overwritten with this older text.
      baseCommit: head.commit,
    });
    const { id } = subjectKey(subject as LockSubject);
    // The save point refused (a blocking issue elsewhere, the branch moved): the record's working
    // copy goes again, so neither a retry nor the author's next save point meets it.
    const outcome = await this.commitWorkingCopies
      .handle({
        actor,
        changeSetId,
        subjects: [subject],
        message: `Mark the ${lang} translation of ${subject.type} ${id} as current`,
        after: async (tx, { commit }) => {
          await this.auditLog.record(tx, actor, {
            action: 'translation.mark-current',
            subject: subjectKey(subject as LockSubject),
            data: {
              lang,
              changeSetId,
              commit: commit ?? null,
              sourceCommit: head.commit,
              blocks: units,
            },
          });
        },
      })
      .catch(async (error: unknown) => {
        await this.discardWorkingCopy
          .handle({ actor, changeSetId, subject })
          .catch(() => undefined);
        throw error;
      });
    return {
      changeSetId,
      branch: at.branch,
      lang,
      ...named,
      commit: outcome.commit ?? null,
      blocks: units,
    };
  }
}

/** What marking reads once for every kind. */
interface Marking {
  readonly actor: Actor;
  readonly changeSetId: string;
  readonly branch: string;
  readonly head: ReadableContent;
  readonly lang: string;
}
