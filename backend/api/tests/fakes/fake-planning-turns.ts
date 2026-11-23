import { PlanningTurns } from '../../src/releases/core/planning-turns.js';

/** `PlanningTurns` for unit tests: one process, so the work runs at once; records the turns by product. */
export class FakePlanningTurns extends PlanningTurns {
  readonly taken: string[] = [];

  async take<T>(product: string, work: () => Promise<T>): Promise<T> {
    this.taken.push(product);
    return work();
  }
}
