import { describe, expect, it } from 'vitest';

import { setupBoard } from '@/scripts/board-github.mjs';
import { rateLimitWait, retryingGh } from '@/scripts/gh-api.mjs';
import { setProjectStatus } from '@/scripts/project-status.mjs';

import { fakeGitHub } from './fake-github';

describe('retryingGh', () => {
  const secondary =
    'gh api failed: HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes.';

  it('waits out the secondary rate limit and tries again', () => {
    let calls = 0;
    const waits: number[] = [];
    const gh = retryingGh(
      () => {
        calls += 1;
        if (calls < 3) throw new Error(secondary);
        return 'ok';
      },
      { sleep: (ms) => waits.push(ms), log: () => {} },
    );
    expect(gh(['api', 'graphql'])).toBe('ok');
    expect(calls).toBe(3);
    expect(waits).toEqual([60_000, 120_000]);
  });

  it('throws every other error at once, and the rate limit after the last retry', () => {
    let calls = 0;
    const failing = (message: string) =>
      retryingGh(
        () => {
          calls += 1;
          throw new Error(message);
        },
        { sleep: () => {}, log: () => {} },
      );
    expect(() =>
      failing('gh api failed: HTTP 404: Not Found')(['api']),
    ).toThrow('404');
    expect(calls).toBe(1);
    calls = 0;
    expect(() => failing(secondary)(['api'])).toThrow('secondary rate limit');
    expect(calls).toBe(5);
  });

  it('reads how long to wait from the answer', () => {
    expect(
      rateLimitWait('HTTP 429: Too Many Requests\nRetry-After: 7', 0),
    ).toBe(7_000);
    expect(rateLimitWait('HTTP 403: forbidden, retry-after 30', 2)).toBe(
      30_000,
    );
    expect(rateLimitWait('HTTP 429: Too Many Requests', 1)).toBe(120_000);
    expect(
      rateLimitWait('was submitted too quickly: secondary rate limit', 0),
    ).toBe(60_000);
    // A plain 403 (no scope) and the hourly quota are no limit to wait out here.
    expect(
      rateLimitWait('HTTP 403: Resource not accessible by integration', 0),
    ).toBeNull();
    expect(
      rateLimitWait('GitHub GraphQL: API rate limit exceeded for user', 0),
    ).toBeNull();
  });
});

describe('setProjectStatus', () => {
  /** A board (project #1 as pnpm setup:board makes it) and two issues, counting calls. */
  function board() {
    const fake = fakeGitHub();
    setupBoard({
      gh: fake.gh,
      repo: fake.repo,
      owner: 'acme',
      title: 'app',
      dryRun: false,
      log() {},
    });
    for (const number of [12, 14]) {
      fake.state.issues.push({
        id: `I${number}`,
        number,
        title: `Issue ${number}`,
        body: '',
        state: 'OPEN',
        milestone: null,
        labels: [],
        parent: null,
        blockedBy: [],
        items: [],
      });
    }
    const calls: string[] = [];
    const gh = (args: string[], input?: string) => {
      const query = input
        ? (JSON.parse(input).query as string)
        : args.join(' ');
      calls.push(query.match(/\{\s*(\w+)/)?.[1] ?? args.join(' '));
      return fake.gh(args, input);
    };
    let stored: Record<string, unknown> = {};
    const cache = {
      read: () => structuredClone(stored),
      write: (d: typeof stored) => (stored = d),
    };
    const status = (value: string, issues: number[]) => {
      calls.length = 0;
      setProjectStatus({
        gh,
        cache,
        owner: 'acme',
        number: 1,
        fieldName: 'Status',
        status: value,
        issues,
        log() {},
      });
      return [...calls];
    };
    const valueOf = (number: number) =>
      fake.state.issues
        .find((i) => i.number === number)!
        .items.map((item) => item.values.Status);
    return { fake, status, valueOf, cache: () => stored };
  }

  it('reads the board once, then each change is one mutation', () => {
    const b = board();
    expect(b.status('In progress', [12])).toEqual([
      'repositoryOwner',
      'repo view --json id,name,owner',
      'repository',
      'addProjectV2ItemById',
      'updateProjectV2ItemFieldValue',
    ]);
    expect(b.valueOf(12)).toEqual(['In progress']);
    expect(b.status('Done', [12])).toEqual(['updateProjectV2ItemFieldValue']);
    expect(b.valueOf(12)).toEqual(['Done']);
    // A new issue: its id and board item once, the project from the cache.
    expect(b.status('Backlog', [14])).toEqual([
      'repository',
      'addProjectV2ItemById',
      'updateProjectV2ItemFieldValue',
    ]);
    expect(Object.keys(b.cache())).toEqual(['acme/1']);
  });

  it('reads the board again for an option the cache lacks, and refuses an unknown one', () => {
    const b = board();
    b.status('Backlog', [12]);
    const status = b.fake.state.projects[0].fields.find(
      (f) => f.name === 'Status',
    )!;
    status.options!.push({
      id: 'oNew',
      name: 'Review',
      color: 'GRAY',
      description: '',
    });
    expect(b.status('Review', [12])).toEqual([
      'repositoryOwner',
      'repo view --json id,name,owner',
      'repository',
      'addProjectV2ItemById',
      'updateProjectV2ItemFieldValue',
    ]);
    expect(() => b.status('Shipped', [12])).toThrow(
      'no option "Shipped" in field "Status" of project 1',
    );
  });

  it('starts afresh once when a cached id is gone', () => {
    const b = board();
    b.status('Backlog', [12]);
    // The item was removed from the board: GitHub no longer knows its cached id.
    b.fake.state.issues.find((i) => i.number === 12)!.items = [];
    expect(b.status('Done', [12])).toEqual([
      'updateProjectV2ItemFieldValue',
      'repositoryOwner',
      'repo view --json id,name,owner',
      'repository',
      'addProjectV2ItemById',
      'updateProjectV2ItemFieldValue',
    ]);
    expect(b.valueOf(12)).toEqual(['Done']);
  });
});
