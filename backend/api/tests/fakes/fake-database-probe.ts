import { DatabaseProbe } from '../../src/health/core/database-probe.js';

/** A database that answers, or (given a failure) one that does not. */
export class FakeDatabaseProbe extends DatabaseProbe {
  constructor(
    private readonly failure?: Error,
    private readonly full = false,
  ) {
    super();
  }

  saturated(): boolean {
    return this.full;
  }

  async ping(): Promise<void> {
    if (this.failure) throw this.failure;
  }
}
