import { createTestApp, type TestApp } from '../test-app.js';
import { expectWithin } from './budget.js';

/**
 * #258's acceptance criterion: the designed PDF (theme fonts, tokens, title
 * page) keeps a manual's PDF fast. Cold: the first PDF of a fresh app, worker
 * start, theme and fonts included, under three seconds; another variant then
 * under one second. Run by `api:perf`, never in the default suite.
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());

const MANUAL = '/manuals/operating/variants';
const pdf = (variant: string) =>
  t.get(`${MANUAL}/${variant}/en/pdf`).set('Accept', 'application/pdf');

it('renders a manual as PDF in under three seconds cold, one second warm', async () => {
  const started = performance.now();
  const res = await pdf('model=large');
  const took = performance.now() - started;
  expect(res.status).toBe(200);
  expectWithin('manual PDF, cold', took, 3000);
  const again = performance.now();
  expect((await pdf('model=small')).status).toBe(200);
  expectWithin('manual PDF, another variant', performance.now() - again, 1000);
});
