import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HOST_CSP, PAGE_CSP } from '../src/lib/csp.ts';

/**
 * A meta tag cannot carry every protection (`frame-ancestors` is ignored there, and
 * `X-Content-Type-Options` is a header only), so the host sends them: the hosting guides name
 * them, with the policy the pages carry.
 */
describe('the headers a host sends', () => {
  const read = (...path: string[]) =>
    readFileSync(join(import.meta.dirname, '..', ...path), 'utf8');

  it("the policy for the host is the pages' own, plus frame-ancestors", () => {
    expect(HOST_CSP).toBe(`${PAGE_CSP}; frame-ancestors 'none'`);
  });

  it.each([
    ['the portal README', ['README.md']],
    ['the deployment guide', ['..', '..', 'deploy', 'README.md']],
    [
      "the portal image's web server",
      ['..', '..', 'deploy', 'docker', 'portal', 'Caddyfile'],
    ],
  ])('%s lists them', (_, path) => {
    const text = read(...path);
    expect(text).toContain(HOST_CSP);
    expect(text).toContain('X-Content-Type-Options');
    expect(text).toContain('nosniff');
    expect(text).toContain('frame-ancestors');
    expect(text).toContain('Content-Disposition');
  });
});
