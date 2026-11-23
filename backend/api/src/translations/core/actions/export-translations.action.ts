import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { AuditLog } from '../../../audit/core/audit-log.js';
import {
  ConflictError,
  UnprocessableError,
  UnprocessableProblems,
} from '../../../base/core/errors.js';
import { UnitOfWork } from '../../../base/core/unit-of-work.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import { ContentRepository } from '../../../content/core/content.repository.js';
import type { RefInfo } from '../../../content/core/content.repository.js';
import { isReleased, RELEASED_BRANCH } from '../../../content/core/released.js';
import {
  deltaConfigUnits,
  deltaDesignUnits,
  deltaManualUnits,
  deltaUnits,
  managesAll,
  subjectDesigns,
  subjectManuals,
  subjectModules,
  subjectTakesConfig,
} from '../exports.js';
import {
  countUnits,
  type ExportSubject,
  newTranslationJobId,
  type TranslationJob,
} from '../translation-job.js';
import { TranslationJobs } from '../translation-jobs.js';

export interface ExportTranslationsInput {
  readonly actor: Actor;
  /** Target languages; each once. */
  readonly languages: readonly string[];
  readonly subject: ExportSubject;
  /** A branch, tag or commit. */
  readonly ref: string;
  /** `YYYY-MM-DD`, or null for none. */
  readonly dueDate: string | null;
  /** Work it all out, write nothing. */
  readonly dryRun: boolean;
}

/** The most units (block × language) one export may send. */
export const MAX_EXPORT_UNITS = 20_000;

/**
 * A delta translation export (#50): per target language, the blocks of
 * the subject's modules (and the region text of its page designs, #568:
 * `subjectDesigns`, `deltaDesignUnits`; its manuals' own text, #656: `subjectManuals`,
 * `deltaManualUnits`; and the project labels, #731: `subjectTakesConfig`, `deltaConfigUnits`) whose source changed since they were last
 * translated (`outdated` or `missing`, and not at a provider already),
 * recorded as a translation job whose units are then `at-provider`.
 *
 * - **Who:** `translation.manage`; every target language must be one the
 *   actor manages (and a configured target language), else 422
 *   `invalid-parameter` before any module is read, so the answer reveals
 *   none. A module counts in a language only where the actor reads it
 *   (`content.read` at `ref`, which opening it needs), would see a
 *   translation in that language and holds `translation.manage` on it
 *   there.
 * - **Nothing to send** (every block up to date or at a provider, or no
 *   module the actor may send): 422 `nothing-to-translate`. More than
 *   `MAX_EXPORT_UNITS` units: 422 `too-many-units`.
 * - **A dry run** answers the job it would record, with its counts, and
 *   writes nothing.
 * - **Otherwise** the job and its units are recorded with a
 *   `translation-job.export` audit event, in one transaction; a unit
 *   another export sent meanwhile is 409 `export-conflict` (try again: the
 *   next one leaves it out).
 */
@Injectable()
export class ExportTranslationsAction extends ActorAction<
  ExportTranslationsInput,
  TranslationJob
> {
  readonly policy = 'translation.manage';

  constructor(
    private readonly snapshots: OpenSnapshotAction,
    private readonly content: ContentRepository,
    private readonly jobs: TranslationJobs,
    private readonly auditLog: AuditLog,
    private readonly unit: UnitOfWork,
  ) {
    super();
  }

  protected async run(input: ExportTranslationsInput): Promise<TranslationJob> {
    const { actor, subject, ref, dueDate, dryRun } = input;
    const snapshot = await this.snapshots.handle({ actor, ref });
    const config = await snapshot.config();
    const { targets } = config.languages;
    const refused = input.languages.flatMap((lang, index) =>
      targets.includes(lang) && managesAll(actor, [lang])
        ? []
        : [
            {
              detail: `"${lang}" is no target language you manage translations into.`,
              pointer: `/data/attributes/languages/${index}`,
            },
          ],
    );
    if (refused.length > 0) {
      throw new UnprocessableProblems(
        'invalid-parameter',
        'Some languages are no target languages you manage translations into.',
        refused,
      );
    }
    const languages = targets.filter((lang) => input.languages.includes(lang));
    const modules = await subjectModules(snapshot, subject, config);
    const designs = await subjectDesigns(snapshot, subject, config);
    const manuals = await subjectManuals(snapshot, subject);
    const units = [
      ...((await subjectTakesConfig(snapshot, subject))
        ? await deltaConfigUnits(snapshot, actor, this.jobs, languages)
        : []),
      ...(await deltaDesignUnits(
        snapshot,
        actor,
        this.jobs,
        designs,
        languages,
      )),
      ...(await deltaManualUnits(
        snapshot,
        actor,
        this.jobs,
        manuals,
        languages,
      )),
      ...(await deltaUnits(snapshot, actor, this.jobs, modules, languages)),
    ];
    if (units.length === 0) {
      throw new UnprocessableError(
        'nothing-to-translate',
        'Every block of what you asked for is up to date or at a provider already in these languages.',
      );
    }
    if (units.length > MAX_EXPORT_UNITS) {
      throw new UnprocessableError(
        'too-many-units',
        `This export would send ${units.length} units; at most ${MAX_EXPORT_UNITS} go in one. Export fewer modules or languages at once.`,
        { units: units.length, max: MAX_EXPORT_UNITS },
      );
    }
    const now = Date.now();
    const job: Omit<TranslationJob, 'counts' | 'perLanguage' | 'state'> = {
      id: newTranslationJobId(now),
      sourceLang: config.languages.source,
      languages,
      subject,
      ref,
      commit: snapshot.commit,
      released: releasedRef(ref, snapshot.commit, await this.content.refs()),
      dueDate,
      createdBy: { kind: actor.kind, id: actor.id },
      createdAt: new Date(now),
    };
    const counted = countUnits(languages, units);
    const result: TranslationJob = { ...job, state: 'sent', ...counted };
    if (dryRun) return result;
    await this.unit.run(async (tx) => {
      if (!(await this.jobs.create(tx, job, units))) {
        throw new ConflictError(
          'export-conflict',
          'Another export sent some of these blocks meanwhile; try again.',
        );
      }
      await this.auditLog.record(tx, actor, {
        action: 'translation-job.export',
        subject: { type: 'translation-job', id: job.id },
        data: {
          languages: [...languages],
          subject:
            subject.type === 'modules'
              ? { type: 'modules', count: subject.moduleIds.length }
              : subject.type === 'designs'
                ? { type: 'designs', designIds: [...subject.designIds] }
                : subject.type === 'manuals'
                  ? { type: 'manuals', manualIds: [...subject.manualIds] }
                  : subject,
          ref,
          commit: job.commit,
          dueDate,
          ...counted.counts,
        },
      });
    });
    return result;
  }
}

/**
 * Whether `ref` named released content: its commit is released and the
 * name is `main`, a tag or the commit's own ID, so the job's `ref` never
 * names a draft branch to a reader without `content.read.draft` (a branch
 * pointing at `main`'s commit is still a draft's name).
 */
function releasedRef(
  ref: string,
  commit: string,
  refs: { branches: readonly RefInfo[]; tags: readonly RefInfo[] },
): boolean {
  return (
    isReleased(commit, refs) &&
    (ref === commit ||
      ref === RELEASED_BRANCH ||
      refs.tags.some((tag) => tag.name === ref && tag.commit === commit))
  );
}
