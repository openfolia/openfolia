import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The second factor (#611) and enforced single sign-on (#378) hold because every sign-in, whichever
 * way in, starts its session in one place: `beginSession` asks the session policy in the sign-in's
 * transaction, and only `SessionStart` calls it. A new way in that started a session itself would
 * walk around both.
 */
describe('starting a session', () => {
  const root = join(import.meta.dirname, '../src');
  const sources = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .map((file) => ({ file, text: readFileSync(join(root, file), 'utf8') }));
  const having = (pattern: RegExp) =>
    sources
      .filter(({ text }) => pattern.test(text))
      .map(({ file }) => file)
      .sort();

  it('is SessionStart’s alone, through beginSession', () => {
    expect(having(/\bbeginSession\(/)).toEqual([
      'access/core/begin-session.ts',
      'access/core/session-start.ts',
    ]);
    expect(having(/\bmintSessionToken\(/)).toEqual([
      'access/core/begin-session.ts',
      'access/core/sessions.ts',
    ]);
    expect(having(/\bsessions\.create\(/)).toEqual([
      'access/core/begin-session.ts',
    ]);
    // The table itself: written by its store alone.
    expect(having(/\binsert\(sessions\)/)).toEqual([
      'access/repos/drizzle-sign-in.ts',
    ]);
  });

  it('asks the session policy, in the sign-in’s transaction', () => {
    const [begin] = sources.filter(
      ({ file }) => file === 'access/core/begin-session.ts',
    );
    expect(begin?.text).toMatch(
      /maySignIn\(\s*session\.userId,\s*session\.provider,\s*tx,?\s*\)/,
    );
  });

  it('without a second step is the second step’s and a provider’s alone', () => {
    expect(having(/\bstart\.finish\(/)).toEqual([
      // OpenID Connect and SAML: the second factor is the provider's.
      'access/core/actions/complete-sign-in.action.ts',
      'access/core/actions/second-factor-sign-in.action.ts',
    ]);
  });
});
