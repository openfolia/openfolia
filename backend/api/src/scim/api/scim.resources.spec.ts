import { ScimInvalidValueError } from '../core/scim-errors.js';
import { MAX_CPU_MS } from '../core/scim-work.js';
import { project, toListResponse } from './scim.resources.js';

describe('a selection of attributes', () => {
  it('is bounded, however many paths it names', { timeout: 120_000 }, () => {
    const resource = { id: 'u', x: Array.from({ length: 5000 }, () => ({})) };
    const listed = {
      total: 200,
      startIndex: 1,
      items: Array.from({ length: 200 }, () => resource),
    };
    const paths = Array.from({ length: 1900 }, () => 'x.v').join();
    for (const [attributes, excluded] of [
      [paths, undefined],
      [undefined, paths],
    ]) {
      const start = process.threadCpuUsage();
      expect(() =>
        toListResponse(listed, (r) => project(r, attributes, excluded)),
      ).toThrow(ScimInvalidValueError);
      const { user, system } = process.threadCpuUsage(start);
      expect((user + system) / 1000).toBeLessThan(2.5 * MAX_CPU_MS);
    }
  });

  it('answers what a directory asks for', () => {
    const resource = {
      schemas: ['s'],
      id: 'g',
      displayName: 'G',
      members: [{ value: 'u', display: 'U' }],
    };
    expect(project(resource, 'displayName,members.value', undefined)).toEqual({
      schemas: ['s'],
      id: 'g',
      displayName: 'G',
      members: [{ value: 'u' }],
    });
    expect(project(resource, undefined, 'members')).toEqual({
      schemas: ['s'],
      id: 'g',
      displayName: 'G',
    });
  });
});
