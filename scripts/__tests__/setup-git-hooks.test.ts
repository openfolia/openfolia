import { accessSync, constants, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  HOOK_MARKER,
  HOOK_SOURCE,
  gitHooksPlan,
} from '@/scripts/setup-git-hooks.mjs';
import { GIT_LOCATION_VARS } from '@/scripts/strip-git-env.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SOURCE = `#!/bin/sh\n${HOOK_MARKER}\nexit 0\n`;

describe('setting up the git hooks', () => {
  it('copies only the post-merge hook, when missing or changed', () => {
    expect(
      gitHooksPlan({
        currentHooksPath: '',
        existingHook: null,
        sourceHook: SOURCE,
      }),
    ).toEqual({
      unsetHooksPath: false,
      install: true,
    });
    expect(
      gitHooksPlan({
        currentHooksPath: '',
        existingHook: SOURCE,
        sourceHook: SOURCE,
      }),
    ).toEqual({ unsetHooksPath: false, install: false });
    // An older copy of ours is replaced.
    expect(
      gitHooksPlan({
        currentHooksPath: '',
        existingHook: `#!/bin/sh\n${HOOK_MARKER}\n`,
        sourceHook: SOURCE,
      }).install,
    ).toBe(true);
  });

  it("leaves someone else's post-merge hook alone unless forced", () => {
    const theirs = '#!/bin/sh\necho theirs\n';
    expect(
      gitHooksPlan({
        currentHooksPath: '',
        existingHook: theirs,
        sourceHook: SOURCE,
      }),
    ).toMatchObject({
      install: false,
      reason: expect.stringMatching(/--force/),
    });
    expect(
      gitHooksPlan({
        currentHooksPath: '',
        existingHook: theirs,
        sourceHook: SOURCE,
        force: true,
      }).install,
    ).toBe(true);
  });

  it('never points git at a tracked folder, and removes an older setup that did', () => {
    const plan = (currentHooksPath: string) =>
      gitHooksPlan({
        currentHooksPath,
        existingHook: null,
        sourceHook: SOURCE,
      });
    expect(plan('.githooks').unsetHooksPath).toBe(true);
    expect(plan('').unsetHooksPath).toBe(false);
    expect(plan('/somewhere/else').unsetHooksPath).toBe(false);
    expect(Object.keys(plan(''))).not.toContain('setHooksPath');
  });

  it('is opt-in, not part of pnpm install', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(ROOT, 'package.json'), 'utf8'),
    );
    expect(pkg.scripts.prepare).toBeUndefined();
    expect(pkg.scripts.postinstall).toBeUndefined();
    expect(pkg.scripts['setup:git-hooks']).toBe(
      'node scripts/setup-git-hooks.mjs',
    );
    const script = readFileSync(
      path.join(ROOT, 'scripts/setup-git-hooks.mjs'),
      'utf8',
    );
    expect(script).not.toMatch(/\['config', 'core\.hooksPath', /);
    expect(script).not.toContain('--global');
  });

  it('ships an executable post-merge hook that runs check:changed over the merge and never fails it', () => {
    const hook = path.join(ROOT, HOOK_SOURCE);
    expect(() => accessSync(hook, constants.X_OK)).not.toThrow();
    const source = readFileSync(hook, 'utf8');
    expect(source).toMatch(/^#!\/bin\/sh/);
    expect(source).toContain(HOOK_MARKER);
    // The projects the merge changed: from the commit before it to the merged one.
    expect(source).toContain('pnpm check:changed --base=ORIG_HEAD --head=HEAD');
    expect(source).toMatch(/FAILED/);
    expect(source).not.toMatch(/\bgit (reset|revert|merge --abort)\b/);
    expect(source.trimEnd().endsWith('exit 0')).toBe(true);
  });

  it('unsets the same git location variables the scripts strip (scripts/strip-git-env.mjs)', () => {
    const source = readFileSync(path.join(ROOT, HOOK_SOURCE), 'utf8');
    const list = /for name in ([\s\S]*?); do/.exec(source)?.[1] ?? '';
    expect(
      list.replace(/\\\n/g, ' ').split(/\s+/).filter(Boolean).sort(),
    ).toEqual([...GIT_LOCATION_VARS].sort());
  });
});
