import {
  ConflictError,
  UnprocessableError,
} from '../../src/base/core/errors.js';
import {
  DEFAULT_RELEASE_TAG,
  type ReleaseTag,
  ReleaseTags,
  releaseTagName,
} from '../../src/releases/core/release-tags.js';
import { fakeCommitId } from './fake-content.js';

/**
 * Release tags in memory, named by the same pattern rule as the Git
 * adapter: created once, never moved (`release-exists` for a name in use,
 * in any case, as Git on a case-insensitive file system would see it).
 */
export class FakeReleaseTags extends ReleaseTags {
  /** Tag name → the tag. */
  readonly tags = new Map<
    string,
    ReleaseTag & { message: string; taggedAt: Date }
  >();
  /** When set, `create` fails with it after (`'after'`) or before writing. */
  failure?: { error: unknown; when: 'before' | 'after' };

  constructor(private readonly pattern = DEFAULT_RELEASE_TAG) {
    super();
  }

  nameOf(product: string, revision: string): string {
    const name = releaseTagName(this.pattern, product, revision);
    if (name === undefined) {
      throw new UnprocessableError('invalid-release-name', 'invalid name');
    }
    return name;
  }

  async find(name: string) {
    return this.tags.get(name);
  }

  async create(request: Parameters<ReleaseTags['create']>[0]) {
    const name = this.nameOf(request.product, request.revision);
    if (this.failure?.when === 'before') throw this.failure.error;
    if (
      [...this.tags.keys()].some((n) => n.toLowerCase() === name.toLowerCase())
    ) {
      throw new ConflictError('release-exists', `${name} exists`);
    }
    const tag = { name, tag: fakeCommitId(), commit: request.commit };
    const taggedAt = new Date(
      Math.floor((request.date ?? new Date()).getTime() / 1000) * 1000,
    );
    this.tags.set(name, { ...tag, message: request.message.trim(), taggedAt });
    if (this.failure?.when === 'after') throw this.failure.error;
    return tag;
  }
}
