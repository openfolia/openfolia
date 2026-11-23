import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import { NotFoundError } from '../../../base/core/errors.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';
import {
  authorizeTranslationStatus,
  getConfigTranslationStatus,
  getDesignTranslationStatus,
  getManualTranslationStatus,
  getTranslationStatus,
} from '../statuses.js';
import { TranslationJobs } from '../translation-jobs.js';
import type { TranslationStatus } from '../translation-status.js';

interface Input {
  actor: Actor;
  snapshot: ReadableContent;
  lang: string;
  /** A source module's ID, or (#568) a page design's ID with `designId` set instead. */
  moduleId?: string;
  designId?: string;
  /** A manual's own text (#656). */
  manualId?: string;
  /** The configuration's labels (#731). */
  config?: boolean;
}

/**
 * One source module's translation status in one target language, block
 * by block, or a page design's region text (#568, `designId`), or a manual's own text (#656,
 * `manualId`), or the configuration's labels (#731, `config`). Not found, exactly like a module that does not exist, when the
 * language is no target language, the source module is not there for the
 * actor, or the actor would not see a translation in that language. Needs
 * `translation.manage` or `content.read.draft` on top of reading content.
 */
@Injectable()
export class GetTranslationStatusAction extends ActorAction<
  Input,
  TranslationStatus
> {
  readonly policy = 'content.read';

  constructor(private readonly jobs: TranslationJobs) {
    super();
  }

  protected async run({
    actor,
    snapshot,
    moduleId,
    designId,
    manualId,
    config,
    lang,
  }: Input): Promise<TranslationStatus> {
    authorizeTranslationStatus(actor);
    const status =
      config === true
        ? await getConfigTranslationStatus(snapshot, this.jobs, lang)
        : designId !== undefined
          ? await getDesignTranslationStatus(
              snapshot,
              this.jobs,
              designId,
              lang,
            )
          : manualId !== undefined
            ? await getManualTranslationStatus(
                snapshot,
                this.jobs,
                manualId,
                lang,
              )
            : await getTranslationStatus(
                snapshot,
                this.jobs,
                moduleId ?? '',
                lang,
              );
    if (!status) {
      throw new NotFoundError(
        config === true
          ? `No translation status of the project labels in "${lang}".`
          : designId !== undefined
            ? `No translation status of page design "${designId}" in "${lang}".`
            : manualId !== undefined
              ? `No translation status of manual "${manualId}" in "${lang}".`
              : `No translation status of module "${moduleId}" in "${lang}".`,
      );
    }
    return status;
  }
}
