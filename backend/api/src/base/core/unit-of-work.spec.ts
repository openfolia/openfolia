import { FakeUnitOfWork } from '../../../tests/fakes/fake-unit-of-work.js';
import { ContendedError, ConflictError } from './errors.js';
import { runContended } from './unit-of-work.js';

describe('runContended', () => {
  it('runs the work once more when the database broke it off', async () => {
    const unit = new FakeUnitOfWork();
    let runs = 0;
    const result = await runContended(unit, async () => {
      if (++runs === 1) throw new ContendedError();
      return 'done';
    });
    expect(result).toBe('done');
    expect(runs).toBe(2);
    expect(unit.committed).toBe(1);
  });

  it('passes the second contention on, as 409 lock-contended', async () => {
    const unit = new FakeUnitOfWork();
    let runs = 0;
    const failed = runContended(unit, async () => {
      runs++;
      throw new ContendedError();
    });
    await expect(failed).rejects.toBeInstanceOf(ConflictError);
    await expect(failed).rejects.toMatchObject({ code: 'lock-contended' });
    expect(runs).toBe(2);
  });

  it('never runs work again for any other failure', async () => {
    const unit = new FakeUnitOfWork();
    let runs = 0;
    await expect(
      runContended(unit, async () => {
        runs++;
        throw new ConflictError('invalid-state', 'No.');
      }),
    ).rejects.toMatchObject({ code: 'invalid-state' });
    expect(runs).toBe(1);
  });
});
