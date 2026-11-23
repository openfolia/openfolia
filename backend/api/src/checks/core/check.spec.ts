import { readFileSync } from 'node:fs';
import { CHECK_CODES } from './check.js';

describe('CHECK_CODES', () => {
  it('is documented in the README, each code with its severity', () => {
    const readme = readFileSync(
      new URL('../../../README.md', import.meta.url),
      'utf8',
    );
    const documented = new Map(
      [...readme.matchAll(/^\| `([a-z-]+)` +\| (blocking|warning) +\|/gm)].map(
        (m) => [m[1], m[2]],
      ),
    );
    for (const [code, rule] of Object.entries(CHECK_CODES)) {
      expect([code, documented.get(code)]).toEqual([code, rule.severity]);
    }
    expect(documented.size).toBe(Object.keys(CHECK_CODES).length);
  });
});
