import {
  type ConsumerBeat,
  JobConsumers,
} from '../../src/jobs/core/job-consumers.js';

/** `JobConsumers` in memory: the beats and leaves, in order. */
export class FakeJobConsumers extends JobConsumers {
  readonly beats: ConsumerBeat[] = [];
  readonly left: string[] = [];

  async beat(beat: ConsumerBeat): Promise<void> {
    this.beats.push(beat);
  }

  async leave(id: string): Promise<void> {
    this.left.push(id);
  }
}
