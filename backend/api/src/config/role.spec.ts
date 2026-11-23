import {
  defaultRenderConcurrencyFor,
  pdfWorkersFor,
  roleOf,
  runsBackground,
  servesHttp,
  workerNiceOf,
} from './role.js';

describe('roles (#527)', () => {
  it('reads CCMS_ROLE, all when unset or not one', () => {
    expect(roleOf({})).toBe('all');
    expect(roleOf({ CCMS_ROLE: 'worker' })).toBe('worker');
    expect(roleOf({ CCMS_ROLE: 'API' })).toBe('api');
    // The settings' validation refuses it, with the message; here only the entry point's choice.
    expect(roleOf({ CCMS_ROLE: 'nonsense' })).toBe('all');
  });

  it('reads the worker’s nice value: 10 by default, 0 to 19', () => {
    expect(workerNiceOf({})).toBe(10);
    expect(workerNiceOf({ CCMS_WORKER_NICE: '' })).toBe(10);
    expect(workerNiceOf({ CCMS_WORKER_NICE: '0' })).toBe(0);
    expect(workerNiceOf({ CCMS_WORKER_NICE: '19' })).toBe(19);
    // Not valid: the settings' validation refuses it; the entry point keeps the default.
    expect(workerNiceOf({ CCMS_WORKER_NICE: '20' })).toBe(10);
  });

  it('says what each role does', () => {
    expect([servesHttp('all'), runsBackground('all')]).toEqual([true, true]);
    expect([servesHttp('api'), runsBackground('api')]).toEqual([true, false]);
    expect([servesHttp('worker'), runsBackground('worker')]).toEqual([
      false,
      true,
    ]);
    expect([servesHttp('backup'), runsBackground('backup')]).toEqual([
      false,
      false,
    ]);
  });

  it('sizes the PDF pool and the release renders by role', () => {
    expect(pdfWorkersFor('api', undefined, 7)).toBe(2);
    expect(pdfWorkersFor('api', undefined, 1)).toBe(1);
    expect(pdfWorkersFor('api', 5, 7)).toBe(5);
    expect(pdfWorkersFor('worker', undefined, 7)).toBe(7);
    expect(pdfWorkersFor('all', undefined, 7)).toBe(7);
    expect(defaultRenderConcurrencyFor('all', 7)).toBe(3);
    expect(defaultRenderConcurrencyFor('all', 1)).toBe(1);
    expect(defaultRenderConcurrencyFor('worker', 7)).toBe(7);
  });
});
