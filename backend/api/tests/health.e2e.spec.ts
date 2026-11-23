import { Logger } from '@nestjs/common';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { Health } from '../src/health/api/health.controller.js';
import { createTestDatabase, PgliteDatabase } from './database.js';
import { FakeBlobStore } from './fakes/fake-blob-store.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * A database that no longer answers its health check. (A real one
 * underneath: starting reads it, e.g. the secret key's check.)
 */
class DownDatabase extends PgliteDatabase {
  override async ping(): Promise<void> {
    throw new Error('connection terminated');
  }
}

/** A database that answers while every pool connection is taken. */
class FullPoolDatabase extends PgliteDatabase {
  override async ping(): Promise<void> {
    // Answers: the ping uses a connection of its own.
  }
  override saturated(): boolean {
    return true;
  }
}

describe('GET /health', () => {
  describe('with the database up', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp();
    });
    afterAll(() => t?.close());

    it('reports the database ok', async () => {
      const res = await t.anonymous().get('/health');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(Health.parse(res.body)).toEqual({
        status: 'ok',
        database: 'ok',
        pool: 'ok',
        blobs: 'ok',
      });
    });

    it('is ready', async () => {
      const res = await t.anonymous().get('/health/ready');
      expect(res.status).toBe(200);
      expect(Health.parse(res.body)).toEqual({
        status: 'ok',
        database: 'ok',
        pool: 'ok',
        blobs: 'ok',
      });
    });
  });

  describe('with the pool exhausted', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp(
        {},
        {
          database: new FullPoolDatabase((await createTestDatabase()).client),
        },
      );
    });
    afterAll(() => t?.close());

    it('stays live but is not ready', async () => {
      const live = await t.anonymous().get('/health');
      expect(live.status).toBe(200);
      expect(Health.parse(live.body)).toEqual({
        status: 'degraded',
        database: 'ok',
        pool: 'saturated',
        blobs: 'ok',
      });
      const ready = await t.anonymous().get('/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.headers['retry-after']).toBe('5');
      expect(ErrorDocument.parse(ready.body).errors[0]?.code).toBe(
        'database-saturated',
      );
    });
  });

  describe('with the database down', () => {
    let t: TestApp;
    beforeAll(async () => {
      t = await createTestApp(
        {},
        {
          database: new DownDatabase((await createTestDatabase()).client),
        },
      );
    });
    afterAll(() => t?.close());

    it('reports it unavailable, logging why but not saying it', async () => {
      const warn = vi
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const res = await t.anonymous().get('/health');
      expect(res.status).toBe(200);
      expect(Health.parse(res.body)).toEqual({
        status: 'degraded',
        database: 'unavailable',
        pool: 'ok',
        blobs: 'ok',
      });
      expect(JSON.stringify(res.body)).not.toContain('terminated');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('terminated'));
      warn.mockRestore();
    });

    it('is not ready, as a JSON:API error without the reason', async () => {
      const res = await t.anonymous().get('/health/ready');
      expect(res.status).toBe(503);
      expect(res.headers['content-type']).toBe(JSON_API);
      expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe(
        'database-unavailable',
      );
      expect(JSON.stringify(res.body)).not.toContain('terminated');
    });
  });

  describe('with the blob store down', () => {
    let t: TestApp;
    const blobs = new FakeBlobStore();
    beforeAll(async () => {
      t = await createTestApp({}, { blobs });
      blobs.down = true;
    });
    afterAll(() => t?.close());

    it('stays live but is not ready', async () => {
      const live = await t.anonymous().get('/health');
      expect(live.status).toBe(200);
      expect(Health.parse(live.body)).toEqual({
        status: 'degraded',
        database: 'ok',
        pool: 'ok',
        blobs: 'unavailable',
      });
      const ready = await t.anonymous().get('/health/ready');
      expect(ready.status).toBe(503);
      expect(ready.headers['retry-after']).toBe('5');
      expect(ErrorDocument.parse(ready.body).errors[0]?.code).toBe(
        'blob-store-unavailable',
      );
    });
  });
});
