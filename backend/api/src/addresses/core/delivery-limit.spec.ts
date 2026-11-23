import { TooManyRequestsError } from '../../base/core/errors.js';
import { WINDOW_MS } from '../../base/core/rate-limit.js';
import { READER } from '../../../tests/fakes/actors.js';
import { DeliveryLimit } from './delivery-limit.js';

const refused = (run: () => void) => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TooManyRequestsError);
    return (error as TooManyRequestsError).retryAfterSeconds;
  }
  throw new Error('not refused');
};

describe('DeliveryLimit (#574)', () => {
  it('counts takes per address, refuses past the limit, and checks without counting', () => {
    let now = 0;
    const limit = new DeliveryLimit(2, () => now);
    const reader = { address: '203.0.113.7' };
    limit.check(reader);
    limit.check(reader);
    limit.take(reader);
    limit.take(reader);
    now = 20_000;
    expect(refused(() => limit.check(reader))).toBe(40);
    expect(refused(() => limit.take(reader))).toBe(40);
    // Another address has its own budget.
    limit.take({ address: '203.0.113.8' });
    now = WINDOW_MS + 1;
    limit.check(reader);
    limit.take(reader);
  });

  it('keys a reader with a token by their actor, apart from every address', () => {
    const now = 0;
    const limit = new DeliveryLimit(1, () => now);
    limit.take({ address: '203.0.113.7' });
    limit.take({ actor: READER });
    expect(refused(() => limit.take({ actor: READER }))).toBe(60);
    // The same ID of another kind is another actor.
    limit.take({ actor: { ...READER, kind: 'service' as const } });
    expect(
      refused(() => limit.check({ address: '203.0.113.7' })),
    ).toBeGreaterThan(0);
  });

  it('limits nothing at 0', () => {
    const limit = new DeliveryLimit(0);
    for (let i = 0; i < 100; i++) limit.take({ address: '203.0.113.7' });
    limit.check({ address: '203.0.113.7' });
  });
});
