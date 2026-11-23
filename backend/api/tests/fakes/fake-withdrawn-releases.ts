import {
  type TagWithdrawal,
  WithdrawnReleases,
} from '../../src/content/core/withdrawn-releases.js';

/** `WithdrawnReleases` in memory: `withdraw` a tag, by its name. */
export class FakeWithdrawnReleases extends WithdrawnReleases {
  readonly byTag = new Map<string, TagWithdrawal>();

  withdraw(
    tag: string,
    withdrawal: TagWithdrawal = {
      by: { kind: 'user', id: 'publisher' },
      at: new Date('2026-01-02T03:04:05Z'),
      reason: 'Wrong values.',
    },
  ): TagWithdrawal {
    this.byTag.set(tag, withdrawal);
    return withdrawal;
  }

  withdrawals(): Promise<ReadonlyMap<string, TagWithdrawal>> {
    return Promise.resolve(new Map(this.byTag));
  }
}
