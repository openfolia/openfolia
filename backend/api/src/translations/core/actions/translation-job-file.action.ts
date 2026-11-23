import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import { OpenSnapshotAction } from '../../../content/core/actions/open-snapshot.action.js';
import { jobDocument } from '../exports.js';
import type { TranslationJob } from '../translation-job.js';
import { TranslationJobs } from '../translation-jobs.js';
import { visibleJob } from './read-translation-jobs.action.js';

export interface TranslationJobFileInput {
  readonly actor: Actor;
  readonly id: string;
  /** One language of the job; undefined for every one. */
  readonly lang?: string | undefined;
}

/** One XLIFF document of a job: its target language and the XML. */
export interface TranslationJobFile {
  readonly lang: string;
  readonly xliff: string;
}

/**
 * The XLIFF documents of a translation job (`jobDocument`): made again on
 * every request from the job's commit and units, as the actor reads the
 * content there now (their scope), so a file never holds more than they
 * may read. The job's commit opens as released content when it was when
 * exported (`releasedOnce`), else only with `content.read.draft`.
 *
 * With `lang`, that language's document (404 for a language not in the
 * job, or when nothing of it is left for the actor); without, every
 * language's that has one (404 when none has). A job the actor may not see
 * (`visibleJob`) is 404. Needs `translation.manage`, and `content.read`.
 */
@Injectable()
export class TranslationJobFileAction extends ActorAction<
  TranslationJobFileInput,
  { readonly job: TranslationJob; readonly files: TranslationJobFile[] }
> {
  readonly policy = 'translation.manage';

  constructor(
    private readonly jobs: TranslationJobs,
    private readonly snapshots: OpenSnapshotAction,
  ) {
    super();
  }

  protected async run({ actor, id, lang }: TranslationJobFileInput): Promise<{
    job: TranslationJob;
    files: TranslationJobFile[];
  }> {
    const job = await visibleJob(this.jobs, actor, id);
    const languages = lang === undefined ? job.languages : [lang];
    const missing = () =>
      new NotFoundError(
        `The translation job "${job.id}" has no file${lang === undefined ? '' : ` in "${lang}"`} for you.`,
      );
    if (lang !== undefined && !job.languages.includes(lang)) throw missing();
    const snapshot = await this.snapshots.handle({
      actor,
      ref: job.commit,
      releasedOnce: job.released,
    });
    const files: TranslationJobFile[] = [];
    for (const target of languages) {
      const xliff = await jobDocument(
        snapshot,
        actor,
        job,
        target,
        await this.jobs.unitsOf(job.id, target),
      );
      if (xliff !== undefined) files.push({ lang: target, xliff });
    }
    if (files.length === 0) throw missing();
    return { job, files };
  }
}
