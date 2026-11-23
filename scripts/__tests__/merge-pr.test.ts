// `pnpm merge:pr`: the checks and steps (scripts/merge-pr-plan.mjs) and the flow
// (scripts/merge-pr-flow.mjs) end to end against an injected gh and git, so no network and no
// repository: every call is recorded, and a scripted answer stands in for each.
import { describe, expect, it } from 'vitest';

import { mergePr } from '@/scripts/merge-pr-flow.mjs';
import {
  mergeSteps,
  mergeSubject,
  parseMergeArgs,
  prProblem,
  stepLine,
} from '@/scripts/merge-pr-plan.mjs';
import {
  checkedShaFrom,
  leftoverWorktrees,
  othersNote,
  sharedFiles,
} from '@/scripts/merge-pr-report.mjs';

const HEAD = 'abcdef1234567890abcdef1234567890abcdef12';
const CHECKED = '1234567890abcdef1234567890abcdef12345678';
const ROOT = '/repo';
const SLOT = {
  name: 'agent-a',
  branch: 'agent/agent-a',
  worktree: '/repo/.claude/worktrees/agent-a',
};
const PR = {
  number: 12,
  title: 'projects, the reference entity (#5)',
  state: 'OPEN',
  isDraft: false,
  mergeable: 'MERGEABLE',
  headRefOid: HEAD,
  headRefName: 'agent/agent-a',
  baseRefName: 'main',
  isCrossRepository: false,
  closingIssuesReferences: [{ number: 5 }],
  body: `Closes #5\n\n## What ran\n\n- pnpm check on ${CHECKED.slice(0, 12)}: green.`,
  comments: [] as {
    author: { login: string };
    body: string;
    url?: string;
    createdAt?: string;
  }[],
  reviews: [] as {
    id?: string;
    author: { login: string };
    body: string;
    state: string;
    submittedAt?: string;
  }[],
  url: 'https://github.com/acme/app/pull/12',
  // The PR's author: gh's own login, the agents' shared one.
  author: { login: 'octo' },
};

interface Fake {
  pr?: Partial<typeof PR>;
  slots?: (typeof SLOT)[];
  /** git calls (joined, with the dir) that fail. */
  gitFails?: RegExp[];
  /** `status --porcelain` per dir. */
  porcelain?: Record<string, string>;
  slotHead?: string;
  mainBranch?: string;
  /** The repository's default branch (origin/HEAD). */
  defaultBranch?: string;
  env?: Record<string, string>;
  /** run calls (cmd + args joined) that fail. */
  runFails?: RegExp;
  /** The PR's review threads (GraphQL). */
  threads?: { isResolved: boolean; path: string }[];
  /** The review threads over several GraphQL pages. */
  threadPages?: { isResolved: boolean; path: string }[][];
  /** `git worktree list --porcelain`. */
  worktrees?: string;
  /** GitHub no longer has the branch (`ls-remote --exit-code` exits 2). */
  branchGone?: boolean;
  /** What `gh pr view` gives from its second read on (a comment posted meanwhile). */
  laterPr?: Partial<typeof PR>;
  /** gh's own login (GraphQL `viewer`). */
  viewer?: string;
}

function fakeIo(fake: Fake = {}) {
  const calls: string[] = [];
  const out: string[] = [];
  let views = 0;
  const io = {
    root: ROOT,
    env: fake.env ?? { GH_PROJECT_OWNER: 'acme', GH_PROJECT_NUMBER: '3' },
    gh(args: string[]) {
      calls.push(`gh ${args.join(' ')}`);
      if (args[0] === 'pr' && args[1] === 'view') {
        views++;
        const later = views > 1 ? fake.laterPr : {};
        return JSON.stringify({ ...PR, ...fake.pr, ...later });
      }
      if (args[0] === 'api' && args[1] === 'graphql') {
        // One page per entry of threadPages (cursor `p<i>`), else one page of `threads`.
        const pages = fake.threadPages ?? [fake.threads ?? []];
        const after = args
          .find((arg) => arg.startsWith('after='))
          ?.slice('after='.length);
        const at = after ? Number(after.slice(1)) + 1 : 0;
        const hasNextPage = at < pages.length - 1;
        return JSON.stringify({
          data: {
            ...(fake.viewer ? { viewer: { login: fake.viewer } } : {}),
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: pages[at],
                  pageInfo: {
                    hasNextPage,
                    endCursor: hasNextPage ? `p${at}` : null,
                  },
                },
              },
            },
          },
        });
      }
      throw new Error(`unexpected gh ${args.join(' ')}`);
    },
    git(args: string[], cwd = ROOT) {
      const call = `${cwd}: git ${args.join(' ')}`;
      calls.push(call);
      if ((fake.gitFails ?? []).some((re) => re.test(call))) {
        return { ok: false, status: 128, stdout: '' };
      }
      if (args[0] === 'ls-remote' && fake.branchGone)
        return { ok: false, status: 2, stdout: '' };
      if (args[0] === 'status')
        return { ok: true, stdout: fake.porcelain?.[cwd] ?? '' };
      if (args[0] === 'rev-parse')
        return { ok: true, stdout: fake.slotHead ?? HEAD };
      if (
        args[0] === 'symbolic-ref' &&
        args.includes('refs/remotes/origin/HEAD')
      ) {
        return { ok: true, stdout: `origin/${fake.defaultBranch ?? 'main'}` };
      }
      if (args[0] === 'symbolic-ref')
        return { ok: true, stdout: fake.mainBranch ?? 'main' };
      if (args[0] === 'diff' && args[2] === CHECKED.slice(0, 12)) {
        return { ok: true, stdout: 'lib/a.ts\ndocs/en.md' };
      }
      if (args[0] === 'diff' && args[1] === '--name-only') {
        return {
          ok: true,
          stdout: 'lib/a.ts\ndocs/en.md\napp/CLAUDE.md\npnpm-lock.yaml',
        };
      }
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          ok: true,
          stdout: fake.worktrees ?? `worktree ${ROOT}\nHEAD ${HEAD}\n`,
        };
      }
      return { ok: true, stdout: '' };
    },
    run(cmd: string, args: string[], { cwd }: { cwd: string | null }) {
      const call = `${cwd}: ${[cmd, ...args].join(' ')}`;
      calls.push(`RUN ${call}`);
      return fake.runFails?.test(call) ? 3 : 0;
    },
    slots: () => fake.slots ?? [SLOT],
    isOwnTemp: (dir: string) => dir.startsWith('/tmp/merge-pr-'),
    log: (line: string) => out.push(line),
    error: (line: string) => out.push(`ERR ${line}`),
  };
  return { io, calls, out: () => out.join('\n') };
}

const OPTIONS = {
  number: 12,
  reviewed: HEAD.slice(0, 8),
  checked: null,
  dryRun: false,
};
const runs = (calls: string[]) =>
  calls.filter((call) => call.startsWith('RUN ')).map((call) => call.slice(4));

describe('merge:pr arguments', () => {
  it('needs a PR number and the reviewed head', () => {
    expect(parseMergeArgs(['12', '--reviewed', 'ABCDEF12'])).toEqual({
      number: 12,
      reviewed: 'abcdef12',
      checked: null,
      next: null,
      dryRun: false,
    });
    expect(
      parseMergeArgs(['12', '--checked', '1234567', '--reviewed', 'abcdef12']),
    ).toMatchObject({
      number: 12,
      checked: '1234567',
    });
    expect(
      parseMergeArgs(['12', '--reviewed', 'abcdef12', '--checked', 'nope'])
        .error,
    ).toMatch(/--checked takes a SHA/);
    expect(
      parseMergeArgs(['#12', '--reviewed=abcdef12', '--dry-run']),
    ).toMatchObject({
      number: 12,
      dryRun: true,
    });
    expect(parseMergeArgs(['12']).error).toMatch(/--reviewed <SHA>/);
    expect(parseMergeArgs(['12', '--reviewed', 'xyz']).error).toMatch(
      /--reviewed/,
    );
    expect(parseMergeArgs(['--reviewed', 'abcdef12']).error).toMatch(/Usage/);
    expect(
      parseMergeArgs(['12', '13', '--reviewed', 'abcdef12']).error,
    ).toMatch(/Usage/);
  });
});

describe('prProblem', () => {
  it.each([
    [{ state: 'MERGED' }, /merged, not open/],
    [{ isDraft: true }, /draft/],
    [{ mergeable: 'CONFLICTING' }, /conflicts with main/],
    [{ mergeable: 'UNKNOWN' }, /run this again/],
    [{ headRefOid: 'ffff' + HEAD.slice(4) }, /not the reviewed/],
  ])('refuses %o', (change, message) => {
    expect(prProblem({ ...PR, ...change }, HEAD.slice(0, 8))).toMatch(message);
  });

  it('passes an open, mergeable PR whose head is the reviewed one', () => {
    expect(prProblem(PR, HEAD.slice(0, 8))).toBeNull();
    expect(mergeSubject(PR)).toBe(
      'Merge pull request #12: projects, the reference entity (#5)',
    );
  });
});

describe('mergePr', () => {
  it('merges the reviewed head, then branch, board, slot and sync', () => {
    const { io, calls, out } = fakeIo();
    expect(mergePr(OPTIONS, io)).toBe(0);
    expect(runs(calls)).toEqual([
      `${ROOT}: gh pr merge 12 --merge --match-head-commit ${HEAD} --subject Merge pull request #12: projects, the reference entity (#5)`,
      `${ROOT}: git push origin --delete agent/agent-a`,
      `${ROOT}: bash scripts/set-project-status.sh Done 5`,
      `${ROOT}: node scripts/agent-slot.mjs remove agent-a`,
      `${ROOT}: node scripts/sync-main.mjs --base main`,
    ]);
    // Checked before anything ran: the head contains the fetched base.
    expect(calls).toContain(
      `${ROOT}: git merge-base --is-ancestor origin/main ${HEAD}`,
    );
    expect(out()).toMatch(/PR #12 merged/);
    expect(out()).toMatch(/every other open PR/);
  });

  it('merges a branch without a slot, and removes no slot', () => {
    const { io, calls } = fakeIo({ slots: [] });
    expect(mergePr(OPTIONS, io)).toBe(0);
    expect(runs(calls).some((call) => call.includes('gh pr merge 12'))).toBe(
      true,
    );
    expect(calls.some((call) => call.includes('worktree add'))).toBe(false);
    expect(
      runs(calls).some((call) => call.includes('agent-slot.mjs remove')),
    ).toBe(false);
  });

  it('stops before changing anything when the head lacks the latest base, naming the slot', () => {
    const { io, calls, out } = fakeIo({
      gitFails: [/merge-base --is-ancestor/],
    });
    expect(mergePr(OPTIONS, io)).toBe(1);
    expect(out()).toMatch(/doesn't contain the latest origin\/main/);
    expect(out()).toMatch(
      /slot "agent-a".*pnpm install and pnpm check on that head/,
    );
    expect(out()).toMatch(/Nothing was changed/);
    expect(runs(calls)).toEqual([]);
  });

  it('stops when the slot is ahead of or behind the PR head', () => {
    const { io, calls, out } = fakeIo({ slotHead: 'f'.repeat(40) });
    expect(mergePr(OPTIONS, io)).toBe(1);
    expect(out()).toMatch(/is at f+, not the PR head/);
    expect(runs(calls)).toEqual([]);
  });

  it('stops at local changes in the slot, and never forces the removal', () => {
    const { io, calls, out } = fakeIo({
      porcelain: { [SLOT.worktree]: ' M pnpm-lock.yaml\n' },
    });
    expect(mergePr(OPTIONS, io)).toBe(1);
    expect(out()).toMatch(
      /slot "agent-a" \(.*\) has local changes \(pnpm-lock\.yaml\)/,
    );
    expect(runs(calls)).toEqual([]);
    expect(calls.join('\n')).not.toMatch(/--force/);
  });

  it('merges with local changes in the main checkout, and leaves sync:main as a note', () => {
    const { io, calls, out } = fakeIo({
      porcelain: { [ROOT]: '?? notes.txt\n' },
    });
    expect(mergePr(OPTIONS, io)).toBe(0);
    expect(runs(calls).some((call) => call.includes('gh pr merge'))).toBe(true);
    expect(runs(calls).some((call) => call.includes('sync-main.mjs'))).toBe(
      false,
    );
    expect(out()).toMatch(
      /main checkout[\s\S]*notes\.txt[\s\S]*Then run pnpm sync:main/,
    );
  });

  it.each([
    ['sprint-3', 'main'],
    ['main', 'main'],
    ['trunk', 'trunk'],
  ])(
    'never deletes a base or default head branch: %s (default %s)',
    (head, defaultBranch) => {
      const { io, calls, out } = fakeIo({
        pr: { headRefName: head },
        defaultBranch,
        slots: [],
      });
      expect(mergePr(OPTIONS, io)).toBe(0);
      expect(runs(calls).some((call) => call.includes('--delete'))).toBe(false);
      expect(out()).toMatch(
        new RegExp(`${head} is a base branch.*left on GitHub`),
      );
    },
  );

  it('stops at a refused PR', () => {
    const { io, calls, out } = fakeIo({ pr: { mergeable: 'CONFLICTING' } });
    expect(mergePr(OPTIONS, io)).toBe(1);
    expect(out()).toMatch(/conflicts/);
    expect(runs(calls)).toEqual([]);
  });

  it('a failed merge stops before the branch, the board and the slot', () => {
    const { io, calls, out } = fakeIo({ runFails: /gh pr merge/ });
    expect(mergePr(OPTIONS, io)).toBe(1);
    expect(out()).toMatch(/Nothing was merged/);
    expect(runs(calls)).toHaveLength(1);
  });

  it('after the merge, a failed step says the PR is merged and lists what is left', () => {
    const { io, calls, out } = fakeIo({ runFails: /set-project-status/ });
    expect(mergePr(OPTIONS, io)).toBe(1);
    expect(out()).toMatch(/PR #12 IS merged/);
    expect(out()).toMatch(
      /set-project-status\.sh Done 5[\s\S]*agent-slot\.mjs remove agent-a/,
    );
    expect(
      runs(calls).some((call) => call.includes('agent-slot.mjs remove')),
    ).toBe(false);
  });

  it('--dry-run checks, then prints the steps without running one', () => {
    const { io, calls, out } = fakeIo();
    expect(mergePr({ ...OPTIONS, dryRun: true }, io)).toBe(0);
    expect(runs(calls)).toEqual([]);
    expect(out()).toMatch(/none ran/);
    expect(out()).toMatch(/gh pr merge 12 --merge --match-head-commit/);
  });

  it('--next prepares only after the whole merge, and a dry run only names it', () => {
    const { io, calls, out } = fakeIo();
    io.gh = ((original) => (args: string[]) =>
      args[1] === 'list'
        ? (calls.push(`gh ${args.join(' ')}`), '[]')
        : original(args))(io.gh);
    expect(mergePr({ ...OPTIONS, next: 'auto' }, io)).toBe(0);
    const list = calls.findIndex((call) => call.startsWith('gh pr list'));
    const sync = calls.findIndex((call) => call.includes('sync-main.mjs'));
    expect(sync).toBeGreaterThan(-1);
    expect(list).toBeGreaterThan(sync);
    expect(calls[list]).toMatch(/--state open --base main/);
    expect(out()).toMatch(/no other open PR on main has a slot here/);

    const dry = fakeIo();
    expect(mergePr({ ...OPTIONS, next: 14, dryRun: true }, dry.io)).toBe(0);
    expect(dry.out()).toMatch(
      /Then --next 14: merge origin\/main into that PR's idle slot/,
    );
    expect(runs(dry.calls)).toEqual([]);
  });

  it('skips what it cannot do and says so: no board env, no issue, main on another base', () => {
    const { io, calls, out } = fakeIo({ env: {}, mainBranch: 'sprint-2' });
    expect(mergePr(OPTIONS, io)).toBe(0);
    expect(out()).toMatch(/GH_PROJECT_OWNER.*#5 to Done yourself/);
    expect(out()).toMatch(/isn't on main: run pnpm check on origin\/main/);
    expect(
      runs(calls).some((call) => /set-project-status|sync-main/.test(call)),
    ).toBe(false);
  });

  it('leaves a fork’s branch and an already deleted one alone', () => {
    const fork = fakeIo({ pr: { isCrossRepository: true } });
    mergePr(OPTIONS, fork.io);
    expect(runs(fork.calls).some((call) => call.includes('--delete'))).toBe(
      false,
    );
    const gone = fakeIo({ branchGone: true });
    expect(mergePr(OPTIONS, gone.io)).toBe(0);
    expect(runs(gone.calls).some((call) => call.includes('--delete'))).toBe(
      false,
    );
    expect(gone.out()).toMatch(/agent\/agent-a is already gone on GitHub/);
    // Still the board, the slot and sync:main after it.
    expect(
      runs(gone.calls).some((call) => call.includes('sync-main.mjs')),
    ).toBe(true);
  });

  it('asks GitHub for the branch only after the merge (auto-delete removes it during it)', () => {
    const { io, calls } = fakeIo();
    expect(mergePr(OPTIONS, io)).toBe(0);
    const merge = calls.findIndex((call) => call.includes('gh pr merge'));
    const lsRemote = calls.findIndex((call) => call.includes('ls-remote'));
    expect(merge).toBeGreaterThan(-1);
    expect(lsRemote).toBeGreaterThan(merge);
  });

  it('asks for the exact branch ref, not a suffix match', () => {
    const { io, calls } = fakeIo();
    mergePr(OPTIONS, io);
    const lsRemote = calls.find((call) => call.includes('ls-remote')) ?? '';
    expect(lsRemote).toMatch(
      /ls-remote --exit-code origin refs\/heads\/agent\/agent-a$/,
    );
    expect(lsRemote).not.toMatch(/--heads/);
  });

  it('a failed branch delete warns and goes on: board, slot and sync:main still run', () => {
    const { io, calls, out } = fakeIo({
      gitFails: [/ls-remote/],
      runFails: /push origin --delete/,
    });
    expect(mergePr(OPTIONS, io)).toBe(0);
    expect(runs(calls).some((call) => call.includes('--delete'))).toBe(true);
    expect(
      runs(calls).some((call) => call.includes('set-project-status')),
    ).toBe(true);
    expect(
      runs(calls).some((call) => call.includes('agent-slot.mjs remove')),
    ).toBe(true);
    expect(runs(calls).some((call) => call.includes('sync-main.mjs'))).toBe(
      true,
    );
    expect(out()).toMatch(/failed \(exit 3\); going on without it/);
    expect(out()).toMatch(
      /still to do: delete agent\/agent-a[\s\S]*git push origin --delete/,
    );
  });

  it('a later failure after a failed branch delete lists both as still to do', () => {
    const { io, out } = fakeIo({
      gitFails: [/ls-remote/],
      runFails: /push origin --delete|set-project-status/,
    });
    expect(mergePr(OPTIONS, io)).toBe(1);
    expect(out()).toMatch(/PR #12 IS merged/);
    expect(out()).toMatch(
      /Still to do[\s\S]*git push origin --delete[\s\S]*agent-slot\.mjs remove/,
    );
  });
});

describe('merge:pr around the merge', () => {
  it('holds on an unresolved review thread or an unanswered bot security comment', () => {
    const thread = fakeIo({
      threads: [{ isResolved: false, path: 'lib/x.ts' }],
    });
    expect(mergePr(OPTIONS, thread.io)).toBe(1);
    expect(thread.out()).toMatch(
      /open review findings[\s\S]*lib\/x\.ts[\s\S]*branch owner answers/,
    );
    expect(runs(thread.calls)).toEqual([]);

    const url = `${PR.url}#issuecomment-101`;
    const finding = {
      author: { login: 'security-review[bot]' },
      body: 'Security: SSRF in x',
      url,
    };
    const bot = fakeIo({ pr: { comments: [finding] } });
    expect(mergePr(OPTIONS, bot.io)).toBe(1);
    expect(bot.out()).toMatch(/unanswered comment by security-review\[bot\]/);

    const reply = {
      author: { login: 'octo' },
      body: `${url}: doesn't apply, the URL is fixed.`,
    };
    expect(
      mergePr(OPTIONS, fakeIo({ pr: { comments: [finding, reply] } }).io),
    ).toBe(0);
    expect(
      mergePr(
        OPTIONS,
        fakeIo({ threads: [{ isResolved: true, path: 'x' }] }).io,
      ),
    ).toBe(0);
    const allClear = {
      author: { login: 'security-review[bot]' },
      body: 'Security: no findings.',
    };
    expect(mergePr(OPTIONS, fakeIo({ pr: { comments: [allClear] } }).io)).toBe(
      0,
    );
  });

  it('holds a security comment whoever wrote it: an App login without [bot], a person', () => {
    const url = `${PR.url}#issuecomment-201`;
    // gh's GraphQL gives a GitHub App's login bare.
    const app = {
      author: { login: 'claude' },
      body: '**Security**: SSRF in lib/x.ts',
      url,
    };
    const held = fakeIo({ pr: { comments: [app] } });
    expect(mergePr(OPTIONS, held.io)).toBe(1);
    expect(held.out()).toMatch(/unanswered comment by claude/);
    expect(runs(held.calls)).toEqual([]);
    const answer = {
      author: { login: 'octo' },
      body: `${url}: doesn't apply, fixed URL.`,
    };
    expect(
      mergePr(OPTIONS, fakeIo({ pr: { comments: [app, answer] } }).io),
    ).toBe(0);

    const human = {
      author: { login: 'octo' },
      body: 'Possible injection in the search query.',
      url,
      viewerDidAuthor: true,
    };
    const own = fakeIo({ pr: { comments: [human] } });
    expect(mergePr(OPTIONS, own.io)).toBe(1);
    expect(own.out()).toMatch(/by octo .*\(yours: /);
    const reply = {
      author: { login: 'reviewer' },
      body: `${url} fixed in abc1234.`,
    };
    expect(
      mergePr(OPTIONS, fakeIo({ pr: { comments: [human, reply] } }).io),
    ).toBe(0);

    const allClear = {
      author: { login: 'coderabbitai' },
      body: 'No security findings.',
    };
    expect(mergePr(OPTIONS, fakeIo({ pr: { comments: [allClear] } }).io)).toBe(
      0,
    );
    // A reply linking a comment that wasn't a finding is a finding of its own.
    const note = { author: { login: 'octo' }, body: 'Ready for review.', url };
    const later = {
      author: { login: 'claude' },
      body: `Re ${url}: XSS in lib/y.ts`,
    };
    expect(
      mergePr(OPTIONS, fakeIo({ pr: { comments: [note, later] } }).io),
    ).toBe(1);
  });

  it.each([
    "Missing RLS policy on invoices lets any authenticated user read every tenant's rows",
    'Auth bypass: the admin route skips private.is_admin',
    'IDOR in /api/files/[id]: no owner check',
    'The service_role key reaches the client bundle',
    'Privilege escalation through the role column',
    'Leaks the token in the log',
  ])('holds a finding worded around access, not "security": %j', (body) => {
    const url = `${PR.url}#issuecomment-301`;
    const finding = { author: { login: 'claude' }, body, url };
    expect(mergePr(OPTIONS, fakeIo({ pr: { comments: [finding] } }).io)).toBe(
      1,
    );
  });

  it('matches the finding words as words: "Ready for review", "policyholder" are none', () => {
    const notes = [
      { author: { login: 'octo' }, body: 'Ready for review, rebased.' },
      { author: { login: 'octo' }, body: 'Renamed the policyholder column.' },
    ];
    expect(mergePr(OPTIONS, fakeIo({ pr: { comments: notes } }).io)).toBe(0);
  });

  it('anchors the linked URL: #issuecomment-123 is not answered by a link to -1234', () => {
    const url = `${PR.url}#issuecomment-123`;
    const finding = {
      author: { login: 'claude' },
      body: 'Security: SSRF in x',
      url,
    };
    const other = { author: { login: 'octo' }, body: `${url}4 is fixed.` };
    expect(
      mergePr(OPTIONS, fakeIo({ pr: { comments: [finding, other] } }).io),
    ).toBe(1);
    const exact = {
      author: { login: 'octo' },
      body: `${url} fixed in abc1234`,
    };
    expect(
      mergePr(OPTIONS, fakeIo({ pr: { comments: [finding, exact] } }).io),
    ).toBe(0);
    const end = { author: { login: 'octo' }, body: `False positive: ${url}` };
    expect(
      mergePr(OPTIONS, fakeIo({ pr: { comments: [finding, end] } }).io),
    ).toBe(0);
  });

  it('reads a comment that quotes the finding as no answer', () => {
    const url = `${PR.url}#issuecomment-123`;
    const finding = {
      author: { login: 'claude' },
      body: 'Security: SSRF in lib/x.ts',
      url,
    };
    const quoted = {
      author: { login: 'octo' },
      body: `> Security: SSRF in lib/x.ts\n\n${url} fixed.`,
    };
    expect(
      mergePr(OPTIONS, fakeIo({ pr: { comments: [finding, quoted] } }).io),
    ).toBe(1);
    // The URL only inside a quote links nothing.
    const inQuote = { author: { login: 'octo' }, body: `> ${url}\nfixed` };
    expect(
      mergePr(OPTIONS, fakeIo({ pr: { comments: [finding, inQuote] } }).io),
    ).toBe(1);
  });

  it('reads the reviews: changes requested hold until the same author approves', () => {
    const requested = {
      id: 'PRR_a1',
      author: { login: 'reviewer' },
      body: 'Please rename the helper.',
      state: 'CHANGES_REQUESTED',
      submittedAt: '2026-11-10T10:00:00Z',
    };
    const held = fakeIo({ pr: { reviews: [requested] } });
    expect(mergePr(OPTIONS, held.io)).toBe(1);
    expect(held.out()).toMatch(/a review requesting changes by reviewer/);
    expect(runs(held.calls)).toEqual([]);
    const otherApproves = {
      ...requested,
      id: 'PRR_a2',
      author: { login: 'x' },
      state: 'APPROVED',
    };
    expect(
      mergePr(
        OPTIONS,
        fakeIo({ pr: { reviews: [requested, otherApproves] } }).io,
      ),
    ).toBe(1);
    const approves = {
      ...requested,
      id: 'PRR_a3',
      body: '',
      state: 'APPROVED',
    };
    expect(
      mergePr(OPTIONS, fakeIo({ pr: { reviews: [requested, approves] } }).io),
    ).toBe(0);
  });

  it('reads a review summary: a finding holds until another author names its id later', () => {
    const review = {
      id: 'PRR_kwDOAbc123',
      author: { login: 'claude' },
      body: 'Missing RLS policy on invoices.',
      state: 'COMMENTED',
      submittedAt: '2026-11-10T10:00:00Z',
    };
    const held = fakeIo({ pr: { reviews: [review] } });
    expect(mergePr(OPTIONS, held.io)).toBe(1);
    expect(held.out()).toMatch(
      /unanswered review by claude \(id PRR_kwDOAbc123\)/,
    );
    const answer = {
      author: { login: 'octo' },
      body: 'PRR_kwDOAbc123: fixed in 3f9e2a1c.',
      createdAt: '2026-11-10T11:00:00Z',
    };
    const io = (reviews: (typeof review)[], comments: (typeof answer)[] = []) =>
      fakeIo({ pr: { reviews, comments } }).io;
    expect(mergePr(OPTIONS, io([review], [answer]))).toBe(0);
    // Before the review, without a time, by its own author, or naming a longer id: no answer.
    const before = { ...answer, createdAt: '2026-11-10T09:00:00Z' };
    const noTime = { ...answer, createdAt: undefined as unknown as string };
    const own = { ...answer, author: { login: 'claude' } };
    const longer = { ...answer, body: 'PRR_kwDOAbc1234 fixed in 3f9e2a1c' };
    for (const comment of [before, noTime, own, longer]) {
      expect(mergePr(OPTIONS, io([review], [comment]))).toBe(1);
    }
    // A review without an id can't be named: it holds.
    expect(mergePr(OPTIONS, io([{ ...review, id: '' }], [answer]))).toBe(1);
    // A later review by another author naming it answers it; one raising another doesn't.
    const later = {
      ...review,
      id: 'PRR_b',
      author: { login: 'octo' },
      body: 'PRR_kwDOAbc123: fixed in 3f9e2a1c.',
      submittedAt: '2026-11-10T12:00:00Z',
    };
    expect(mergePr(OPTIONS, io([review, later]))).toBe(0);
    const policy = {
      ...later,
      body: 'PRR_kwDOAbc123: fixed in 3f9e2a1c, but the view still leaks.',
    };
    expect(mergePr(OPTIONS, io([review, policy]))).toBe(1);
    // Submitted at the same time (or before) it answers nothing.
    expect(
      mergePr(
        OPTIONS,
        io([review, { ...later, submittedAt: review.submittedAt }]),
      ),
    ).toBe(1);
    const clean = { ...review, body: 'Looks good.', state: 'APPROVED' };
    expect(mergePr(OPTIONS, io([clean]))).toBe(0);
  });

  it('holds a finding by its shape, without a security word', () => {
    const url = `${PR.url}#issuecomment-401`;
    for (const body of [
      "Finding (high): delete_project lets any signed-in person delete another person's project; it never checks the owner.",
      'High: save_project skips the owner check.',
      'severity: medium, the export runs for any authenticated user',
      "It lets one person overwrite another person's notes.",
    ]) {
      const comment = { author: { login: 'claude' }, body, url };
      expect(
        mergePr(OPTIONS, fakeIo({ pr: { comments: [comment] } }).io),
        body,
      ).toBe(1);
    }
    const notes = [
      { author: { login: 'octo' }, body: 'High time we merged this one.' },
      {
        author: { login: 'octo' },
        body: 'Moved the owner column, tests green.',
      },
    ];
    expect(mergePr(OPTIONS, fakeIo({ pr: { comments: notes } }).io)).toBe(0);
  });

  it('reads a reply that links a finding but raises one as no answer, and reopens it', () => {
    const url = `${PR.url}#issuecomment-100`;
    const finding = {
      author: { login: 'claude' },
      body: 'Security: the RLS policy on projects leaks rows.',
      url,
    };
    const io = (
      ...comments: { author: { login: string }; body: string; url?: string }[]
    ) => fakeIo({ pr: { comments } }).io;
    const notFixed = {
      author: { login: 'octo' },
      body: `${url} is NOT fixed yet, the RLS policy still leaks via the view.`,
      url: `${url}1`,
    };
    expect(mergePr(OPTIONS, io(finding, notFixed))).toBe(1);
    const another = {
      author: { login: 'octo' },
      body: `Re ${url}: also, the share-link token is exposed in logs.`,
      url: `${PR.url}#issuecomment-200`,
    };
    const held = fakeIo({ pr: { comments: [finding, another] } });
    expect(mergePr(OPTIONS, held.io)).toBe(1);
    expect(held.out()).toMatch(/issuecomment-200/);
    // A pure reply answers; a later finding-like comment linking it opens it again.
    const fixed = {
      author: { login: 'octo' },
      body: `${url}: fixed in abc1234.`,
    };
    expect(mergePr(OPTIONS, io(finding, fixed))).toBe(0);
    const reopened = fakeIo({
      pr: { comments: [finding, fixed, { ...notFixed, url: '' }] },
    });
    expect(mergePr(OPTIONS, reopened.io)).toBe(1);
    expect(reopened.out()).toMatch(/issuecomment-100\)/);
    // A review answered, then named again by a comment saying it still holds: held.
    const review = {
      id: 'PRR_x1',
      author: { login: 'claude' },
      body: 'Missing RLS policy on invoices.',
      state: 'COMMENTED',
      submittedAt: '2026-11-10T10:00:00Z',
    };
    const answer = {
      author: { login: 'octo' },
      body: 'PRR_x1: fixed in 3f9e2a1c.',
      createdAt: '2026-11-10T11:00:00Z',
    };
    const still = {
      ...answer,
      body: 'PRR_x1 still open: not fixed.',
      createdAt: '2026-11-10T12:00:00Z',
    };
    expect(
      mergePr(
        OPTIONS,
        fakeIo({ pr: { reviews: [review], comments: [answer] } }).io,
      ),
    ).toBe(0);
    expect(
      mergePr(
        OPTIONS,
        fakeIo({ pr: { reviews: [review], comments: [answer, still] } }).io,
      ),
    ).toBe(1);
  });

  it('reads the findings again right before the merge: one posted meanwhile holds', () => {
    const url = `${PR.url}#issuecomment-501`;
    const late = {
      author: { login: 'claude' },
      body: 'Security: SSRF in lib/x.ts',
      url,
    };
    const { io, calls, out } = fakeIo({ laterPr: { comments: [late] } });
    expect(mergePr(OPTIONS, io)).toBe(1);
    expect(out()).toMatch(
      /unanswered comment by claude[\s\S]*Nothing was merged/,
    );
    expect(runs(calls)).toEqual([]);
    // Nothing new by then: it merges.
    expect(mergePr(OPTIONS, fakeIo({ laterPr: {} }).io)).toBe(0);
  });

  it('reads every page of review threads: an unresolved one past the first 100 holds', () => {
    const resolved = Array.from({ length: 100 }, (_, i) => ({
      isResolved: true,
      path: `f${i}`,
    }));
    const { io, calls, out } = fakeIo({
      threadPages: [resolved, [{ isResolved: false, path: 'lib/late.ts' }]],
    });
    expect(mergePr(OPTIONS, io)).toBe(1);
    expect(out()).toMatch(/unresolved review thread on lib\/late\.ts/);
    expect(calls.some((call) => call.includes('after=p0'))).toBe(true);
    expect(runs(calls)).toEqual([]);
  });

  it('holds when unsure: a later unrelated comment, an all-clear with findings, no URL', () => {
    const url = `${PR.url}#issuecomment-101`;
    const finding = {
      author: { login: 'security-review[bot]' },
      body: 'Security: SSRF in x',
      url,
    };
    const chatter = {
      author: { login: 'octo' },
      body: 'Looks good, merging soon.',
    };
    expect(
      mergePr(OPTIONS, fakeIo({ pr: { comments: [finding, chatter] } }).io),
    ).toBe(1);
    // Its own author linking it answers nothing.
    const selfReply = {
      author: { login: 'security-review[bot]' },
      body: `${url} fixed`,
    };
    expect(
      mergePr(OPTIONS, fakeIo({ pr: { comments: [finding, selfReply] } }).io),
    ).toBe(1);
    // "no findings" inside a comment that has one is not an all-clear.
    const mixed = {
      author: { login: 'security-review[bot]' },
      body: 'Security review: no findings in lib/a.ts. Finding: SSRF in lib/b.ts.',
      url,
    };
    expect(mergePr(OPTIONS, fakeIo({ pr: { comments: [mixed] } }).io)).toBe(1);
    // A finding without a URL can't be linked: it holds.
    const bare = {
      author: { login: 'security-review[bot]' },
      body: 'Security: XSS in y',
    };
    const answer = {
      author: { login: 'octo' },
      body: 'Security: fixed in abc1234.',
    };
    expect(
      mergePr(OPTIONS, fakeIo({ pr: { comments: [bare, answer] } }).io),
    ).toBe(1);
  });

  it('holds every comment by another author until answered, unless an all-clear', () => {
    const url = `${PR.url}#issuecomment-601`;
    const io = (...comments: object[]) =>
      fakeIo({ pr: { comments } as Partial<typeof PR> }).io;
    // No finding word: held all the same, because someone else wrote it.
    const chatty = {
      author: { login: 'reviewer' },
      body: 'Please rename the helper.',
      url,
    };
    const held = fakeIo({ pr: { comments: [chatty] } });
    expect(mergePr(OPTIONS, held.io)).toBe(1);
    expect(held.out()).toMatch(/unanswered comment by reviewer \(.*601\)/);
    expect(
      mergePr(
        OPTIONS,
        io(chatty, {
          author: { login: 'octo' },
          body: `${url} fixed in abc1234.`,
        }),
      ),
    ).toBe(0);
    // Short approvals are all-clears; anything more holds.
    for (const body of [
      'LGTM',
      'LGTM, nice',
      'Looks good to me!',
      'Approved.',
      '👍',
      'ship it 🚀',
    ]) {
      expect(
        mergePr(OPTIONS, io({ author: { login: 'reviewer' }, body, url })),
        body,
      ).toBe(0);
    }
    for (const body of [
      'LGTM, but rename x',
      'LGTM. One thing: the route is open to anyone',
    ]) {
      expect(
        mergePr(OPTIONS, io({ author: { login: 'reviewer' }, body, url })),
        body,
      ).toBe(1);
    }
    // gh's own login (GraphQL viewer) writes plain notes freely; unknown, it is another's.
    const note = {
      author: { login: 'agent-login' },
      body: 'Rebased on main.',
      url,
    };
    expect(
      mergePr(
        OPTIONS,
        fakeIo({ pr: { comments: [note] }, viewer: 'agent-login' }).io,
      ),
    ).toBe(0);
    expect(mergePr(OPTIONS, fakeIo({ pr: { comments: [note] } }).io)).toBe(1);
    expect(mergePr(OPTIONS, io({ ...note, viewerDidAuthor: true }))).toBe(0);
    // Another author's review summary holds too; their later approval clears it.
    const review = {
      id: 'PRR_c1',
      author: { login: 'reviewer' },
      body: 'Please split the file.',
      state: 'COMMENTED',
      submittedAt: '2026-11-10T10:00:00Z',
    };
    expect(mergePr(OPTIONS, fakeIo({ pr: { reviews: [review] } }).io)).toBe(1);
    const approved = { ...review, id: 'PRR_c2', body: '', state: 'APPROVED' };
    expect(
      mergePr(OPTIONS, fakeIo({ pr: { reviews: [review, approved] } }).io),
    ).toBe(0);
  });

  it.each([
    '**Low**: open redirect via unchecked `next` param in /auth/callback.',
    'Path traversal: `../` in the file name reaches other folders in storage.',
    'Race: the quota is checked before the insert, so two requests both pass (TOCTOU).',
    'The upload has no rate limit, so one person can fill the bucket (DoS).',
    'The login form allows email enumeration.',
    'The CSP allows inline scripts; CORS echoes any origin.',
    'Unsafe deserialization of the cookie.',
    'The PDF renderer can escape its sandbox.',
    'Low: the error page echoes the query.',
  ])('holds the viewer’s own comment of every finding class: %j', (body) => {
    const comment = {
      author: { login: 'octo' },
      body,
      url: `${PR.url}#issuecomment-701`,
    };
    expect(mergePr(OPTIONS, fakeIo({ pr: { comments: [comment] } }).io)).toBe(
      1,
    );
  });

  it('reads a reply that names a finding of its own, or keeps it open, as no answer', () => {
    const url = `${PR.url}#issuecomment-801`;
    const finding = {
      author: { login: 'claude' },
      body: 'Security: the share token leaks.',
      url,
    };
    const io = (...comments: object[]) =>
      fakeIo({ pr: { comments } as Partial<typeof PR> }).io;
    for (const body of [
      `${url} fixed in abc1234, but the RLS policy on files now lets anon read every row.`,
      `${url} fixed in abc1234. Separately, the export endpoint leaks other tenants' rows.`,
      `${url} fixed in abc1234; any user could still read it.`,
    ]) {
      const reply = {
        author: { login: 'octo' },
        body,
        url: `${PR.url}#issuecomment-802`,
      };
      expect(mergePr(OPTIONS, io(finding, reply)), body).toBe(1);
    }
    // A chain: a pure reply, then another author's finding linking the reply holds.
    const fixed = {
      author: { login: 'octo' },
      body: `${url} fixed in abc1234`,
      url: `${url}2`,
    };
    const back = {
      author: { login: 'claude' },
      body: `${url}2 the bypass is back in the view`,
    };
    expect(mergePr(OPTIONS, io(finding, fixed))).toBe(0);
    expect(mergePr(OPTIONS, io(finding, fixed, back))).toBe(1);
    // A link's own words (a repository called secure-app) are no finding.
    const repoUrl = 'https://github.com/acme/secure-app/pull/12#issuecomment-9';
    const inRepo = { ...finding, url: repoUrl };
    const answer = {
      author: { login: 'octo' },
      body: `${repoUrl} fixed in abc1234.`,
    };
    expect(mergePr(OPTIONS, io(inRepo, answer))).toBe(0);
  });

  it("reads only a reply saying it is fixed or doesn't apply as an answer", () => {
    const url = `${PR.url}#issuecomment-811`;
    const finding = {
      author: { login: 'coderabbitai' },
      body: 'The RLS policy on notes lets any signed-in user read every row.',
      url,
    };
    const io = (...comments: object[]) =>
      fakeIo({ pr: { comments } as Partial<typeof PR> }).io;
    const reply = (login: string, body: string) => ({
      author: { login },
      body: `${url} ${body}`,
      url: `${PR.url}#issuecomment-812`,
      viewerDidAuthor: login === 'octo',
    });
    for (const body of [
      'Good catch, will fix.',
      'Confirmed — working on a fix now.',
      'Agreed, this needs fixing before merge.',
      '+1',
      'Acknowledged; tracking in #321.',
      'Will address in a follow-up PR.',
      'TODO',
      'Fix pending.',
      "Won't fix.",
      'Not a problem.',
      'fixed in 1234567.',
      'This is not a false positive.',
      "It isn't by design.",
    ]) {
      expect(mergePr(OPTIONS, io(finding, reply('octo', body))), body).toBe(1);
      expect(mergePr(OPTIONS, io(finding, reply('bob', body))), body).toBe(1);
    }
    for (const body of [
      'fixed in 3f9e2a1c',
      'Resolved in 3f9e2a1c.',
      'Fixed by #42.',
      'fixed by https://github.com/acme/app/commit/3f9e2a1c',
      'false positive: the function is service_role only',
      "Doesn't apply: the route is behind the admin guard.",
      'Not applicable here, the table has no rows of people.',
      'By design: the list is public.',
    ]) {
      expect(mergePr(OPTIONS, io(finding, reply('octo', body))), body).toBe(0);
    }
    // A review named with an acknowledgement stays held too.
    const review = {
      id: 'PRR_kwDO1',
      author: { login: 'alice' },
      state: 'COMMENTED',
      body: 'The token is exposed in the URL.',
      submittedAt: '2026-11-10T10:00:00Z',
    };
    const ack = {
      author: { login: 'octo' },
      body: 'PRR_kwDO1 good catch, will fix.',
      createdAt: '2026-11-10T11:00:00Z',
    };
    const reviews = (comment: typeof ack) =>
      fakeIo({ pr: { reviews: [review], comments: [comment] } }).io;
    expect(mergePr(OPTIONS, reviews(ack))).toBe(1);
    expect(
      mergePr(
        OPTIONS,
        reviews({ ...ack, body: 'PRR_kwDO1 fixed in 3f9e2a1c.' }),
      ),
    ).toBe(0);
  });

  it.each([
    'Any user can delete another project: delete_project does not check the caller is an admin.',
    "This lets anyone read other people's invoices.",
    'The new action skips the admin check, so a non-admin can change roles.',
    'Please do not merge yet: the delete is not restricted to admins.',
    'Do not merge: the migration drops the people table data.',
    'Wait — this deletes rows of other offices.',
    "Don't merge, blocking: the role check is gone.",
    'Hold off: this is data loss on rollback.',
  ])(
    'holds the viewer’s own comment that says so in plain words: %j',
    (body) => {
      const comment = {
        author: { login: 'octo' },
        body,
        url: `${PR.url}#issuecomment-821`,
        viewerDidAuthor: true,
      };
      expect(mergePr(OPTIONS, fakeIo({ pr: { comments: [comment] } }).io)).toBe(
        1,
      );
    },
  );

  it('lists what changed since pnpm check (from the body, or --checked), without deciding', () => {
    const { io, out } = fakeIo();
    expect(mergePr({ ...OPTIONS, dryRun: true }, io)).toBe(0);
    expect(out()).toMatch(
      /Since pnpm check ran on 12345678, 2 file\(s\) changed/,
    );
    expect(out()).toMatch(/lib\/a\.ts\n {2}docs\/en\.md/);

    const none = fakeIo({ pr: { body: 'Closes #5' } });
    expect(mergePr(OPTIONS, none.io)).toBe(1);
    expect(none.out()).toMatch(/pass --checked <SHA>/);
    expect(
      mergePr(
        { ...OPTIONS, checked: CHECKED.slice(0, 12) },
        fakeIo({ pr: { body: '' } }).io,
      ),
    ).toBe(0);

    const elsewhere = fakeIo({ gitFails: [/is-ancestor 1234567890/] });
    expect(mergePr(OPTIONS, elsewhere.io)).toBe(1);
    expect(elsewhere.out()).toMatch(/the check ran on another history/);
  });

  it('ends with the note for the running agents, the handover line and the cleanup', () => {
    const { io, calls, out } = fakeIo({
      worktrees: [
        `worktree ${ROOT}`,
        `worktree ${SLOT.worktree}`,
        'worktree /tmp/merge-pr-old',
        '/repo-other',
      ]
        .map((line) =>
          line.startsWith('worktree') ? line : `worktree ${line}`,
        )
        .join('\n\n'),
    });
    expect(mergePr(OPTIONS, io)).toBe(0);
    const text = out();
    expect(text).toMatch(/for the running agents: PR #12 is merged into main/);
    expect(text).toMatch(/git merge origin\/main/);
    expect(text).toMatch(
      /Shared files it changed.*docs\/en\.md, app\/CLAUDE\.md, pnpm-lock\.yaml/,
    );
    expect(text).toMatch(
      /Add to \.claude\/handover\/handover\.md:\n- PR #12 .* at abcdef12, closing #5; slot "agent-a" removed\./,
    );
    // Its own leftover removed; another worktree only listed.
    expect(calls).toContain(
      `${ROOT}: git worktree remove --force /tmp/merge-pr-old`,
    );
    expect(text).toMatch(/Other worktrees[\s\S]*\/repo-other/);
    expect(calls.join('\n')).not.toMatch(/remove --force \/repo-other/);
  });
});

describe('merge-pr-report', () => {
  it('reads the pnpm check SHA from a PR body', () => {
    expect(checkedShaFrom('- `pnpm check` on `1a2b3c4d`: green')).toBe(
      '1a2b3c4d',
    );
    expect(checkedShaFrom('Ran checks on 1a2b3c4d')).toBeNull();
    // check:changed is not the full check.
    expect(
      checkedShaFrom('- `pnpm check:changed` on `1a2b3c4d`: green'),
    ).toBeNull();
    expect(checkedShaFrom(undefined)).toBeNull();
    // A number is no SHA; of several, the one that is a commit here, else the last.
    expect(checkedShaFrom('pnpm check passed (1523406 ms) on 3f9e2a1c')).toBe(
      '3f9e2a1c',
    );
    expect(checkedShaFrom('pnpm check passed in 1523406 ms')).toBeNull();
    expect(checkedShaFrom('pnpm check on abc1234, then on 3f9e2a1c')).toBe(
      '3f9e2a1c',
    );
    expect(
      checkedShaFrom(
        'pnpm check on abc1234, then 3f9e2a1c',
        (sha: string) => sha === 'abc1234',
      ),
    ).toBe('abc1234');
  });

  it('finds the shared files', () => {
    expect(
      sharedFiles([
        'backend/api/package.json',
        'pnpm-lock.yaml',
        'nx.json',
        'tsconfig.base.json',
        'lib/CLAUDE.md',
        '.claude/hooks/guard-rules.mjs',
        '.claude/skills/x/SKILL.md',
        'docs/agent-rules.md',
        'lib/a.ts',
        'apps/web/tsconfig.json',
      ]),
    ).toEqual([
      'backend/api/package.json',
      'pnpm-lock.yaml',
      'nx.json',
      'tsconfig.base.json',
      'lib/CLAUDE.md',
      '.claude/hooks/guard-rules.mjs',
      '.claude/skills/x/SKILL.md',
      'docs/agent-rules.md',
    ]);
  });

  it('tells its own worktrees from the others', () => {
    const porcelain = [
      'worktree /m',
      'worktree /m/.claude/worktrees/a',
      'worktree /m/.claude/worktrees/stray',
      'worktree /t/merge-pr-1',
    ].join('\n\n');
    const own = (dir: string) => dir.startsWith('/t/');
    // A folder under .claude/worktrees/ that no slot names is listed, not passed over.
    expect(
      leftoverWorktrees(porcelain, '/m', own, ['/m/.claude/worktrees/a']),
    ).toEqual({
      own: ['/t/merge-pr-1'],
      others: ['/m/.claude/worktrees/stray'],
    });
  });

  it('quiets a PR without shared files', () => {
    const note = othersNote({ pr: PR, shared: [] }).join('\n');
    expect(note).toMatch(/no shared file/);
    expect(note).toMatch(/pnpm install and pnpm check:changed/);
  });
});

describe('stepLine', () => {
  it('runs the merge first, in the main checkout', () => {
    const [merge] = mergeSteps({
      pr: PR,
      root: ROOT,
      slot: SLOT,
      board: false,
      syncMain: false,
    });
    expect(merge.key).toBe('merge');
    expect(stepLine(merge)).toMatch(
      new RegExp(`^\\(cd '${ROOT}' && gh pr merge 12 `),
    );
  });

  it('quotes what the shell would split', () => {
    const [merge] = mergeSteps({
      pr: PR,
      root: ROOT,
      slot: null,
      board: false,
      syncMain: false,
    });
    expect(stepLine(merge)).toBe(
      `(cd '${ROOT}' && gh pr merge 12 --merge --match-head-commit ${HEAD} --subject 'Merge pull request #12: projects, the reference entity (#5)')`,
    );
  });
});
