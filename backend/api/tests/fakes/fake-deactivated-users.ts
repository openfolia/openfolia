import { DeactivatedUsers } from '../../src/access/core/deactivated-users.js';

/** The deactivated users it was given; `asked` records the IDs of each read. */
export class FakeDeactivatedUsers extends DeactivatedUsers {
  readonly asked: (readonly string[])[] = [];

  constructor(private readonly deactivated: readonly string[] = []) {
    super();
  }

  async among(userIds: readonly string[]): Promise<ReadonlySet<string>> {
    this.asked.push(userIds);
    return new Set(userIds.filter((id) => this.deactivated.includes(id)));
  }
}
