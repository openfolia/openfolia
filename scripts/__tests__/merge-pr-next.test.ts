// The local merge queue (scripts/merge-pr-next.mjs): which PR's slot is prepared after a merge,
// when a slot is left alone, and that it only merges the base locally and starts the checks:
// never a push, never a PR merge. gh, git and the background start are injected and recorded.
import { describe, expect, it } from 'vitest';

import {
  nextCandidates,
  nextCheckScript,
  nextMergeArgs,
  nextProblem,
  prepareNext,
  processesIn,
  queueEnv,
} from '@/scripts/merge-pr-next.mjs';
import { parseMergeArgs } from '@/scripts/merge-pr-plan.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const MERGED = '9999999999999999999999999999999999999999';
const slotOf = (name: string, change: Record<string, unknown> = {}) => ({
  name,
  branch: `agent/${name}`,
  worktree: `/repo/.claude/worktrees/${name}`,
  ...change,
});
const prOf = (
  number: number,
  name: string,
  change: Record<string, unknown> = {},
) => ({
  number,
  title: `PR ${number}`,
  state: 'OPEN',
  isDraft: false,
  headRefName: `agent/${name}`,
  headRefOid: HEAD,
  baseRefName: 'main',
  ...change,
});

interface Fake {
  prs?: ReturnType<typeof prOf>[];
  slots?: ReturnType<typeof slotOf>[];
  heads?: Record<string, string>;
  branches?: Record<string, string | null>;
  dirty?: Record<string, string>;
  busy?: Record<string, string[] | null>;
  /** git calls (dir + args joined) that fail. */
  gitFails?: RegExp[];
  /** A failed merge leaves a merge in progress (a conflict). */
  conflict?: boolean;
  /** The abort leaves the slot dirty. */
  dirtyAfterAbort?: boolean;
  /** The second idle check finds the agent at work. */
  busyOnSecondLook?: boolean;
  /** startBackground throws. */
  startThrows?: boolean;
  /** The spawn fails: no pid. */
  noPid?: boolean;
}

function fakeIo(fake: Fake = {}) {
  const calls: string[] = [];
  const out: string[] = [];
  const started: { cwd: string; script: string; logFile: string }[] = [];
  const merged = new Set<string>();
  const aborted = new Set<string>();
  const looks: Record<string, number> = {};
  const prs = fake.prs ?? [prOf(13, 'b')];
  const io = {
    root: '/repo',
    gh(args: string[]) {
      calls.push(`gh ${args.join(' ')}`);
      if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(prs);
      if (args[0] === 'pr' && args[1] === 'view') {
        return JSON.stringify(prs.find((pr) => pr.number === Number(args[2])));
      }
      throw new Error(`unexpected gh ${args.join(' ')}`);
    },
    git(args: string[], cwd = '/repo') {
      const call = `${cwd}: git ${args.join(' ')}`;
      calls.push(call);
      if ((fake.gitFails ?? []).some((re) => re.test(call))) {
        return { ok: false, status: 1, stdout: '' };
      }
      if (args[0] === 'rev-parse' && args.includes('MERGE_HEAD')) {
        return {
          ok: Boolean(fake.conflict),
          status: fake.conflict ? 0 : 1,
          stdout: '',
        };
      }
      if (args[0] === 'rev-parse') {
        return {
          ok: true,
          status: 0,
          stdout: merged.has(cwd) ? MERGED : (fake.heads?.[cwd] ?? HEAD),
        };
      }
      if (args[0] === 'symbolic-ref') {
        const name = cwd.split('/').at(-1);
        const branch =
          fake.branches && cwd in fake.branches
            ? fake.branches[cwd]
            : `agent/${name}`;
        return branch
          ? { ok: true, status: 0, stdout: branch }
          : { ok: false, status: 1, stdout: '' };
      }
      if (args.includes('--abort')) aborted.add(cwd);
      if (args.includes('--no-edit')) merged.add(cwd);
      if (args[0] === 'diff')
        return { ok: true, status: 0, stdout: 'lib/a.ts' };
      return { ok: true, status: 0, stdout: '' };
    },
    slots: () => fake.slots ?? [slotOf('b')],
    dirtyIn: (where: string, dir: string) => {
      if (fake.dirtyAfterAbort && aborted.has(dir))
        return `${where} has local changes (x~HEAD).`;
      return fake.dirty?.[dir]
        ? `${where} (${dir}) has local changes (${fake.dirty[dir]}).`
        : null;
    },
    processesIn: (dir: string) => {
      looks[dir] = (looks[dir] ?? 0) + 1;
      if (fake.busyOnSecondLook && looks[dir] > 1) return ['77 vitest'];
      return fake.busy && dir in fake.busy ? fake.busy[dir] : [];
    },
    startBackground(run: { cwd: string; script: string; logFile: string }) {
      if (fake.startThrows)
        throw new Error('ENOENT: no such file or directory');
      if (fake.noPid) return null;
      started.push(run);
      return 4242;
    },
    log: (line: string) => out.push(line),
    error: (line: string) => out.push(`ERR ${line}`),
  };
  return { io, calls, started, out: () => out.join('\n') };
}

const B = slotOf('b').worktree;
const changes = (calls: string[]) =>
  calls.filter((call) => / git (fetch|merge|-c)/.test(call));

describe('merge:pr --next / --prepare arguments', () => {
  it('reads --next as a PR number or auto, and --prepare alone', () => {
    expect(
      parseMergeArgs(['12', '--reviewed', 'abcdef12', '--next', 'auto']),
    ).toMatchObject({
      number: 12,
      next: 'auto',
    });
    expect(
      parseMergeArgs(['12', '--reviewed', 'abcdef12', '--next=#13']),
    ).toMatchObject({
      next: 13,
    });
    expect(parseMergeArgs(['12', '--reviewed', 'abcdef12'])).toMatchObject({
      next: null,
    });
    expect(
      parseMergeArgs(['12', '--reviewed', 'abcdef12', '--next', '12']).error,
    ).toMatch(/another PR/);
    expect(
      parseMergeArgs(['12', '--reviewed', 'abcdef12', '--next', 'x']).error,
    ).toMatch(/another PR/);
    expect(parseMergeArgs(['--prepare', '13'])).toEqual({ prepare: 13 });
    expect(parseMergeArgs(['--prepare', '13', '--dry-run']).error).toMatch(
      /--prepare takes/,
    );
    expect(parseMergeArgs(['--prepare']).error).toMatch(/--prepare takes/);
  });
});

describe('nextCandidates', () => {
  it('takes the open, non-draft PRs on the base with a finished slot here, oldest first', () => {
    const prs = [
      prOf(15, 'c'),
      prOf(13, 'b'),
      prOf(14, 'd', { isDraft: true }),
      prOf(16, 'e', { baseRefName: 'sprint-2' }),
      prOf(17, 'nobody'),
      prOf(18, 'f'),
      prOf(12, 'a'),
    ];
    const slots = [
      ...['a', 'b', 'c', 'd', 'e'].map((name) => slotOf(name)),
      slotOf('f', { creating: 123 }),
    ];
    const picked = nextCandidates({ prs, slots, base: 'main', exclude: 12 });
    expect(picked.map(({ pr }) => pr.number)).toEqual([13, 15]);
  });
});

describe('processesIn', () => {
  it('names the processes whose working directory is the folder or inside it', () => {
    const lsof = [
      'p10',
      'cnode',
      `n${B}`,
      'p11',
      'cvitest',
      `n${B}/lib`,
      'p12',
      'czsh',
      `n${B}-other`,
      'p13',
      'cnode',
      'n/repo',
    ].join('\n');
    expect(processesIn(lsof, B)).toEqual(['10 node', '11 vitest']);
  });
});

describe('nextProblem', () => {
  const pr = prOf(13, 'b');
  const slot = slotOf('b');
  const ok = {
    pr,
    slot,
    slotHead: HEAD,
    slotBranch: 'agent/b',
    dirty: null,
    busy: [] as string[] | null,
  };

  it('passes an idle slot at the PR head', () => {
    expect(nextProblem(ok)).toBeNull();
  });

  it.each([
    [{ slot: null }, /has no slot here/],
    [{ slot: slotOf('b', { creating: 1 }) }, /still being created/],
    [{ slotBranch: null }, /detached HEAD/],
    [{ slotBranch: 'agent/other' }, /agent\/other checked out/],
    [{ slotHead: 'f'.repeat(40) }, /still at work/],
    [{ dirty: 'The slot "b" has local changes' }, /local changes/],
    [{ busy: ['77 vitest'] }, /Processes work in the slot "b" \(77 vitest\)/],
    [{ busy: null }, /Couldn't tell/],
    [{ pr: prOf(13, 'b', { isDraft: true }) }, /draft/],
    [{ pr: prOf(13, 'b', { state: 'MERGED' }) }, /merged, not open/],
  ])('leaves the slot alone: %o', (change, message) => {
    expect(nextProblem({ ...ok, ...change })).toMatch(message);
  });
});

describe('prepareNext', () => {
  it('merges the base into the idle slot locally, then starts its checks there', () => {
    const { io, calls, started, out } = fakeIo({
      gitFails: [/merge-base --is-ancestor/],
    });
    expect(prepareNext({ which: 'auto', base: 'main', exclude: 12 }, io)).toBe(
      0,
    );
    expect(calls).toContain(
      `gh pr list --state open --base main --limit 200 --json ${'number,title,state,isDraft,headRefName,headRefOid,baseRefName'}`,
    );
    expect(calls).toContain(`${B}: git fetch origin main`);
    expect(calls).toContain(`${B}: git ${nextMergeArgs('main').join(' ')}`);
    expect(started).toEqual([
      expect.objectContaining({
        cwd: B,
        script: nextCheckScript(),
        logFile: '/repo/.claude/stacks/b/merge-queue.log',
      }),
    ]);
    // Never a push, never a PR merge, never the main checkout.
    expect(calls.join('\n')).not.toMatch(/\bpush\b|pr merge/);
    expect(calls.some((call) => call.startsWith('/repo:'))).toBe(false);
    expect(out()).toMatch(/abcdef12 → 99999999 \(local only, not pushed\)/);
    expect(out()).toMatch(/pid 4242/);
  });

  it('merges without hooks or an editor; the checks install, then run the full check', () => {
    expect(nextMergeArgs('sprint-2')).toEqual([
      '-c',
      'core.hooksPath=/dev/null',
      'merge',
      '--no-edit',
      'origin/sprint-2',
    ]);
    const script = nextCheckScript();
    expect(script).toMatch(
      /^pnpm install --frozen-lockfile && pnpm check; status=\$\?;/,
    );
    expect(script).toMatch(/merge-queue: finished, exit \$status/);
    expect(script).toMatch(/exit \$status$/);
    expect(script).not.toMatch(/push|merge:pr/);
  });

  it('aborts a conflicting merge, checks the slot is as it was, and goes on to the next PR', () => {
    const { io, calls, started, out } = fakeIo({
      prs: [prOf(13, 'b'), prOf(14, 'c')],
      slots: [slotOf('b'), slotOf('c')],
      gitFails: [/merge-base --is-ancestor/, /b: git .*--no-edit/],
      conflict: true,
    });
    expect(prepareNext({ which: 'auto', base: 'main' }, io)).toBe(0);
    expect(calls).toContain(`${B}: git merge --abort`);
    expect(out()).toMatch(
      /PR #13: .*doesn't merge cleanly.*conflicts: lib\/a\.ts.*the slot is as it was/,
    );
    expect(started.map((run) => run.cwd)).toEqual([slotOf('c').worktree]);
  });

  it('a merge that never began is no conflict: nothing to abort', () => {
    const { io, calls, out } = fakeIo({
      gitFails: [/merge-base --is-ancestor/, /--no-edit/],
    });
    expect(prepareNext({ which: 13 }, io)).toBe(1);
    expect(calls.some((call) => call.includes('--abort'))).toBe(false);
    expect(out()).toMatch(/failed before it began.*the slot is as it was/);
  });

  it('says loudly when the slot is not as it was after the abort', () => {
    const { io, out } = fakeIo({
      gitFails: [/merge-base --is-ancestor/, /--no-edit/],
      conflict: true,
      dirtyAfterAbort: true,
    });
    expect(prepareNext({ which: 13 }, io)).toBe(1);
    expect(out()).toMatch(/NOT as it was.*x~HEAD.*yourself/);
  });

  it('looks again right before the merge, and leaves a slot whose agent started meanwhile', () => {
    const { io, calls, started, out } = fakeIo({
      gitFails: [/merge-base --is-ancestor/],
      busyOnSecondLook: true,
    });
    expect(prepareNext({ which: 13 }, io)).toBe(1);
    expect(calls.some((call) => call.includes('--no-edit'))).toBe(false);
    expect(started).toEqual([]);
    expect(out()).toMatch(/Processes work in the slot/);
  });

  it('starts nothing when the slot already has the latest base', () => {
    const { io, calls, started, out } = fakeIo();
    expect(prepareNext({ which: 13 }, io)).toBe(0);
    expect(calls.some((call) => call.includes('--no-edit'))).toBe(false);
    expect(started).toEqual([]);
    expect(out()).toMatch(/already has the latest origin\/main/);
  });

  it('skips a busy slot and prepares the next ready one', () => {
    const { io, started, out } = fakeIo({
      prs: [prOf(13, 'b'), prOf(14, 'c')],
      slots: [slotOf('b'), slotOf('c')],
      busy: { [B]: ['77 vitest'] },
      gitFails: [/merge-base --is-ancestor/],
    });
    expect(prepareNext({ which: 'auto', base: 'main' }, io)).toBe(0);
    expect(out()).toMatch(
      /PR #13 not prepared: Processes work in the slot "b"/,
    );
    expect(started.map((run) => run.cwd)).toEqual([slotOf('c').worktree]);
  });

  it('touches nothing when no slot is ready: dirty, ahead, or none', () => {
    const { io, calls, started, out } = fakeIo({
      dirty: { [B]: 'lib/x.ts' },
      gitFails: [/merge-base --is-ancestor/],
    });
    expect(prepareNext({ which: 'auto', base: 'main' }, io)).toBe(0);
    expect(out()).toMatch(/local changes \(lib\/x\.ts\)/);
    expect(changes(calls)).toEqual([]);
    expect(started).toEqual([]);

    const ahead = fakeIo({ heads: { [B]: 'f'.repeat(40) } });
    expect(prepareNext({ which: 13 }, ahead.io)).toBe(1);
    expect(ahead.out()).toMatch(/still at work/);
    expect(changes(ahead.calls)).toEqual([]);

    const none = fakeIo({ prs: [] });
    expect(prepareNext({ which: 'auto', base: 'main' }, none.io)).toBe(0);
    expect(none.out()).toMatch(/nothing prepared/);
  });

  it('never throws: checks that fail to start after the merge say what was merged and how to undo it', () => {
    const { io, out } = fakeIo({
      gitFails: [/merge-base --is-ancestor/],
      startThrows: true,
    });
    expect(prepareNext({ which: 13 }, io)).toBe(1);
    expect(out()).toMatch(
      /ERR merge:pr --next: PR #13: origin\/main IS merged .*abcdef12 → 99999999.*ENOENT.*reset --hard abcdef1234/,
    );
  });

  it('a spawn that fails (no pid) is no prepared slot either', () => {
    const { io, out } = fakeIo({
      gitFails: [/merge-base --is-ancestor/],
      noPid: true,
    });
    expect(prepareNext({ which: 13 }, io)).toBe(1);
    expect(out()).toMatch(/IS merged .*didn't start \(no process started\)/);
    expect(out()).not.toMatch(/for the agent of PR/);
  });

  it('a failed slot stops the auto queue, so its report is not buried', () => {
    const { io, started, out } = fakeIo({
      prs: [prOf(13, 'b'), prOf(14, 'c')],
      slots: [slotOf('b'), slotOf('c')],
      gitFails: [/merge-base --is-ancestor/, /--no-edit/],
      conflict: true,
      dirtyAfterAbort: true,
    });
    expect(prepareNext({ which: 'auto', base: 'main' }, io)).toBe(1);
    expect(started).toEqual([]);
    expect(out()).not.toMatch(/PR #14/);
  });

  it('looks at the PR again before the merge: closed or moved meanwhile, it is left alone', () => {
    for (const later of [
      { state: 'CLOSED' },
      { headRefOid: 'f'.repeat(40) },
      { baseRefName: 'sprint-3' },
    ]) {
      const { io, calls, out } = fakeIo({
        gitFails: [/merge-base --is-ancestor/],
      });
      let views = 0;
      io.gh = ((original) => (args: string[]) => {
        if (args[1] === 'view' && ++views > 1)
          return JSON.stringify({ ...prOf(13, 'b'), ...later });
        return original(args);
      })(io.gh);
      expect(prepareNext({ which: 13 }, io)).toBe(1);
      expect(calls.some((call) => call.includes('--no-edit'))).toBe(false);
      expect(out()).toMatch(
        /closed, not open|head or base moved meanwhile|still at work/,
      );
    }
  });
});

describe('queueEnv', () => {
  it("drops what names another place or run: git's repository, the package manager's run, tests", () => {
    expect(
      queueEnv({
        PATH: '/bin',
        HOME: '/h',
        GIT_DIR: '/repo/.git',
        BASE_BRANCH: 'main',
        INIT_CWD: '/repo',
        npm_lifecycle_event: 'merge:pr',
        npm_config_user_agent: 'pnpm/11',
        pnpm_config_verify_deps_before_run: 'false',
        PNPM_SCRIPT_SRC_DIR: '/repo',
        TEST_CLOCK: 'late',
        PORT: '3000',
        HOST: '0.0.0.0',
        GIT_SSH_COMMAND: 'ssh',
      }),
    ).toEqual({ PATH: '/bin', HOME: '/h', GIT_SSH_COMMAND: 'ssh' });
  });
});
