import { closeWorkerPool } from '@openfolia/render-typst';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { createTestApp, type TestApp } from './test-app.js';

// Own file: closing the PDF pool affects every later request in the process.
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());

it('answers PDF requests with 503 and Retry-After once the PDF pool is closed', async () => {
  await closeWorkerPool();
  const res = await t.get('/manuals/operating/variants/model=large/de/pdf');
  expect(res.status).toBe(503);
  expect(res.headers['retry-after']).toBe('5');
  expect(ErrorDocument.parse(res.body).errors[0]?.code).toBe('shutting-down');
  // Other routes keep working until the server itself stops.
  expect((await t.get('/config')).status).toBe(200);
});
