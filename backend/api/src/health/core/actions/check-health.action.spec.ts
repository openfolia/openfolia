import { FakeDatabaseProbe } from '../../../../tests/fakes/fake-database-probe.js';
import { BlobStoreProbe } from '../blob-store-probe.js';
import { CheckHealthAction } from './check-health.action.js';

/** A blob store that answers, or (given a failure) one that does not. */
const blobs = (failure?: Error): BlobStoreProbe => ({
  ping: () => (failure ? Promise.reject(failure) : Promise.resolve()),
});

describe('CheckHealthAction', () => {
  it('is ok when the database answers', async () => {
    expect(
      await new CheckHealthAction(new FakeDatabaseProbe(), blobs()).handle(),
    ).toEqual({ status: 'ok', database: 'ok', pool: 'ok', blobs: 'ok' });
  });

  it('is degraded when the database does not', async () => {
    const action = new CheckHealthAction(
      new FakeDatabaseProbe(new Error('connection refused')),
      blobs(),
    );
    expect(await action.handle()).toEqual({
      status: 'degraded',
      database: 'unavailable',
      pool: 'ok',
      blobs: 'ok',
    });
  });

  it('is degraded when queries wait for a connection, though the database answers', async () => {
    const action = new CheckHealthAction(
      new FakeDatabaseProbe(undefined, true),
      blobs(),
    );
    expect(await action.handle()).toEqual({
      status: 'degraded',
      database: 'ok',
      pool: 'saturated',
      blobs: 'ok',
    });
  });

  it('is degraded when the blob store does not answer', async () => {
    const action = new CheckHealthAction(
      new FakeDatabaseProbe(),
      blobs(new Error('connection refused')),
    );
    expect(await action.handle()).toEqual({
      status: 'degraded',
      database: 'ok',
      pool: 'ok',
      blobs: 'unavailable',
    });
  });
});
