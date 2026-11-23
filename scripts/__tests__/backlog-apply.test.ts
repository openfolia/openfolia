// pnpm backlog:create end to end against a fake GitHub: the first run makes the milestones,
// labels, issues (in dependency order, with real numbers on the Waits-for line), the links and
// the board values; a second run writes nothing; a dry run writes nothing.
import { describe, expect, it } from 'vitest';

import { applyBacklog } from '@/scripts/backlog-apply.mjs';
import { readProject, setupBoard } from '@/scripts/board-github.mjs';

import { fakeGitHub } from './fake-github';

const backlog = {
  milestones: [
    { key: 'sprint-1', title: 'Sprint 1 · Invoices', description: 'Invoices.' },
  ],
  labels: [{ name: 'triage:cleanup', color: '0e8a16', description: 'Cleanup' }],
  issues: [
    {
      key: 'sprint-1.epic',
      title: 'Epic · Sprint 1',
      milestone: 'sprint-1',
      body: 'Epic.',
    },
    {
      key: 'invoice.build',
      title: 'Build invoice',
      milestone: 'sprint-1',
      parent: 'sprint-1.epic',
      waitsFor: ['app.setup'],
      labels: ['triage:cleanup', 'bug'],
      body: 'Build it.',
      fields: { Priority: 'P1', Size: 'M', Model: 'Opus' },
    },
    {
      key: 'app.setup',
      title: 'Set up roles and lists',
      milestone: 'sprint-1',
      parent: 'sprint-1.epic',
      fields: { Priority: 'P1', Size: 'M', Model: 'Opus' },
    },
  ],
};

function boardFor(fake: ReturnType<typeof fakeGitHub>) {
  setupBoard({
    gh: fake.gh,
    repo: fake.repo,
    owner: 'acme',
    title: 'app',
    dryRun: false,
    log() {},
  });
  fake.state.writes.length = 0;
  return readProject(fake.gh, 'acme', 1);
}

const apply = (fake: ReturnType<typeof fakeGitHub>, dryRun = false) => {
  const lines: string[] = [];
  const notes = applyBacklog({
    gh: fake.gh,
    repo: fake.repo,
    project: readProject(fake.gh, 'acme', 1),
    backlog,
    dryRun,
    log: (line: string) => lines.push(line),
  });
  return { lines, notes };
};

describe('applyBacklog', () => {
  it('makes everything once, and nothing on a second run', () => {
    const fake = fakeGitHub();
    boardFor(fake);
    apply(fake);
    const { issues, milestones, labels } = fake.state;
    expect(milestones).toEqual([
      expect.objectContaining({
        title: 'Sprint 1 · Invoices',
        description: 'Invoices.\n\n<!-- backlog:key sprint-1 -->',
      }),
    ]);
    expect(labels.map((l) => l.name)).toEqual(['bug', 'triage:cleanup']);
    expect(issues.map((i) => [i.number, i.title])).toEqual([
      [100, 'Epic · Sprint 1'],
      [101, 'Set up roles and lists'],
      [102, 'Build invoice'],
    ]);
    const build = issues[2];
    expect(build.body).toBe(
      '**Model:** Opus\n**Waits for:** #101\n\nBuild it.\n\n<!-- backlog:key invoice.build -->\n',
    );
    expect(build).toMatchObject({
      milestone: 1,
      parent: 100,
      blockedBy: [101],
    });
    expect(build.labels).toEqual([fake.state.labels[1].id, 'L0']);
    expect(build.items[0].values).toEqual({
      Status: 'Backlog',
      Priority: 'P1',
      Size: 'M',
      Model: 'Opus',
    });
    expect(issues[0].items[0].values).toEqual({ Status: 'Backlog' });

    const writes = fake.state.writes.length;
    expect(apply(fake).notes).toEqual([]);
    expect(fake.state.writes.length).toBe(writes);
  });

  it('keeps a value someone set and notes the difference', () => {
    const fake = fakeGitHub();
    boardFor(fake);
    apply(fake);
    fake.state.issues[2].items[0].values.Model = 'Sonnet';
    fake.state.issues[2].items[0].values.Status = 'In progress';
    expect(apply(fake).notes).toEqual([
      'invoice.build: Model is Sonnet on the board, the file says Opus',
    ]);
    expect(fake.state.issues[2].items[0].values).toMatchObject({
      Model: 'Sonnet',
      Status: 'In progress',
    });
  });

  it('a dry run writes nothing and names issues not made yet by key', () => {
    const fake = fakeGitHub();
    boardFor(fake);
    const { lines } = apply(fake, true);
    expect(fake.state.writes).toEqual([]);
    expect(lines).toContain(
      'would mark #<invoice.build> blocked by #<app.setup>',
    );
    expect(lines).toContain('would set Model = Opus on #<invoice.build>');
  });

  it('refuses a board without the fields', () => {
    const fake = fakeGitHub();
    boardFor(fake);
    const project = readProject(fake.gh, 'acme', 1)!;
    project.fields = project.fields.filter(
      (f: { name: string }) => f.name !== 'Size',
    );
    expect(() =>
      applyBacklog({
        gh: fake.gh,
        repo: fake.repo,
        project,
        backlog,
        dryRun: true,
        log() {},
      }),
    ).toThrow('the board has no Size field: run pnpm setup:board');
  });
});
