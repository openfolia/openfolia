import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GitRepo,
  GitWriter,
  RefConflictError,
  WriteError,
} from '@openfolia/content-repo';
import { ConflictError, UnprocessableError } from '../../base/core/errors.js';
import type { ChangeSetAuthor } from '../../change-sets/core/change-set.js';
import { ACTOR_TRAILER } from '../../change-sets/core/commit.js';
import { gitIdentity } from '../../change-sets/repos/git-change-set-branches.js';
import type { Env } from '../../config/env.js';
import {
  PRODUCT_TRAILER,
  type RecordedReleaseTag,
  type ReleaseTag,
  ReleaseTags,
  releaseTagName,
  REVISION_TRAILER,
} from '../core/release-tags.js';

/** Write errors refused before anything is written, every time; any other is a bug, and stays a 500. */
const CLIENT_WRITE_ERRORS = new Set([
  'invalid-commit',
  'invalid-message',
  // From the actor's ID: refused before anything is written, every time.
  'invalid-identity',
  'invalid-trailer',
]);

/**
 * `ReleaseTags` over the content repository (`CCMS_CONTENT_DIR`), through
 * `GitWriter.createTag`: a tag is only ever created ("must not exist"),
 * never moved or deleted. Names follow `CCMS_RELEASE_TAG`.
 */
@Injectable()
export class GitReleaseTags extends ReleaseTags {
  private readonly writer: GitWriter;
  private readonly repo: GitRepo;
  private readonly pattern: string;

  constructor(config: ConfigService<Env, true>) {
    super();
    const dir = config.get('CCMS_CONTENT_DIR', { infer: true });
    this.writer = new GitWriter(dir);
    // Only `for-each-ref` (`tag`): no long-running process to close.
    this.repo = new GitRepo(dir);
    this.pattern = config.get('CCMS_RELEASE_TAG', { infer: true });
  }

  nameOf(product: string, revision: string): string {
    const name = releaseTagName(this.pattern, product, revision);
    if (name === undefined) {
      throw new UnprocessableError(
        'invalid-release-name',
        'A product and a revision may hold only letters, digits, ".", "_" and "-".',
      );
    }
    return name;
  }

  async find(name: string): Promise<RecordedReleaseTag | undefined> {
    const tag = await this.repo.tag(name);
    return (
      tag && {
        name: tag.name,
        tag: tag.tag,
        commit: tag.commit,
        taggedAt: tag.taggedAt,
        message: tag.message,
      }
    );
  }

  async create(request: {
    readonly product: string;
    readonly revision: string;
    readonly commit: string;
    readonly message: string;
    readonly actor: ChangeSetAuthor;
    readonly date?: Date;
  }): Promise<ReleaseTag> {
    const name = this.nameOf(request.product, request.revision);
    try {
      const result = await this.writer.createTag({
        name,
        commit: request.commit,
        message: request.message,
        tagger: gitIdentity(request.actor),
        ...(request.date !== undefined && { date: request.date }),
        trailers: [
          { key: PRODUCT_TRAILER, value: request.product },
          { key: REVISION_TRAILER, value: request.revision },
          {
            key: ACTOR_TRAILER,
            value: `${request.actor.kind}/${request.actor.id}`,
          },
        ],
      });
      return { name, tag: result.tag, commit: result.commit };
    } catch (error) {
      if (error instanceof RefConflictError) {
        throw new ConflictError(
          'release-exists',
          `The release tag "${name}" exists already.`,
        );
      }
      if (error instanceof WriteError) {
        // The name is well-formed (`releaseTagName`), so the writer refuses
        // it only as clashing with an existing branch or tag (the same name
        // in another case, or one name a folder of the other).
        if (error.code === 'invalid-ref') {
          throw new ConflictError(
            'release-exists',
            `A branch or tag clashing with "${name}" exists already.`,
          );
        }
        if (CLIENT_WRITE_ERRORS.has(error.code)) {
          throw new UnprocessableError(error.code, error.message);
        }
      }
      throw error;
    }
  }
}
