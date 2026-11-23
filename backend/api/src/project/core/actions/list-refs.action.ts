import { Injectable } from '@nestjs/common';
import type { Actor } from '../../../access/core/actor.js';
import { allows, ANYWHERE } from '../../../access/core/allows.js';
import { ActorAction } from '../../../access/core/policy.js';
import {
  paginate,
  type PageRequest,
  type Paginated,
} from '../../../base/core/paging.js';
import {
  ContentRepository,
  type RefInfo,
} from '../../../content/core/content.repository.js';
import { ReadableRefs } from '../../../content/core/readable-refs.js';
import { releasedRefs } from '../../../content/core/released.js';
import type { TagWithdrawal } from '../../../content/core/withdrawn-releases.js';

export type Ref = RefInfo &
  (
    | { kind: 'branch' }
    | {
        kind: 'tag';
        /** Set when the tag is a withdrawn release's (#330); null while it stands. */
        withdrawal: TagWithdrawal | null;
      }
  );

/**
 * One page of branches and tags (branches first), with the commits they
 * point to: the refs the actor may open, so only `main` and the tags
 * without `content.read.draft`. A withdrawn release's tag carries its
 * withdrawal (#330): released content, as `GET /releases` shows it.
 */
@Injectable()
export class ListRefsAction extends ActorAction<
  { actor: Actor; page: PageRequest },
  Paginated<Ref>
> {
  readonly policy = 'content.read';

  constructor(
    private readonly content: ContentRepository,
    private readonly readable: ReadableRefs,
  ) {
    super();
  }

  protected async run({
    actor,
    page,
  }: {
    actor: Actor;
    page: PageRequest;
  }): Promise<Paginated<Ref>> {
    const [all, withdrawals] = await Promise.all([
      this.content.refs(),
      this.readable.withdrawals(),
    ]);
    const { branches, tags } = allows(actor, 'content.read.draft', ANYWHERE)
      ? all
      : releasedRefs(all);
    return paginate(
      [
        ...branches.map((ref) => ({ ...ref, kind: 'branch' as const })),
        ...tags.map((ref) => ({
          ...ref,
          kind: 'tag' as const,
          withdrawal: withdrawals.get(ref.name) ?? null,
        })),
      ],
      page,
    );
  }
}
