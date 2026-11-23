// pnpm backlog:create's planner: key markers, the file's checks, the creation order, the
// bodies, and what counts as missing (never a rewrite of what exists).
import { describe, expect, it } from 'vitest';

type IssueState = {
  number: number | null;
  open: boolean;
  parent: number | null;
  blockedBy: number[];
};

import {
  keyOf,
  marker,
  missingFieldValues,
  missingLabels,
  missingLinks,
  planIssues,
  planMilestones,
  renderIssueBody,
} from '@/scripts/backlog-plan.mjs';
import { creationOrder, validateBacklog } from '@/scripts/backlog-validate.mjs';

describe('keyOf', () => {
  it('reads the last marker line outside fenced code', () => {
    expect(keyOf(`text\n${marker('a.b')}\n`)).toBe('a.b');
    expect(keyOf(`${marker('one')}\n${marker('two')}`)).toBe('two');
    expect(
      keyOf(`${marker('real')}\n\`\`\`md\n${marker('quoted')}\n\`\`\``),
    ).toBe('real');
    expect(keyOf(`  ${marker('indented')}`)).toBeNull();
    expect(keyOf(null)).toBeNull();
  });
});

const backlog = {
  milestones: [
    { key: 'sprint-0', title: 'Sprint 0 · Discovery' },
    { key: 'sprint-1', title: 'Sprint 1 · Invoices' },
  ],
  issues: [
    {
      key: 'invoice.build',
      title: 'Build invoice',
      milestone: 'sprint-1',
      waitsFor: ['app.setup'],
    },
    {
      key: 'app.setup',
      title: 'Set up roles and lists',
      milestone: 'sprint-1',
    },
    { key: 'sprint-1.epic', title: 'Epic · Sprint 1', milestone: 'sprint-1' },
  ],
};

describe('labels', () => {
  it('refuses an issue that is its own parent, directly or around a loop', () => {
    const own = validateBacklog({
      milestones: [],
      issues: [{ key: 'a', title: 'A', parent: 'a' }],
    });
    expect(own).toContain('a: its parents loop back to it');
    const loop = validateBacklog({
      milestones: [],
      issues: [
        { key: 'a', title: 'A', parent: 'b' },
        { key: 'b', title: 'B', parent: 'a' },
      ],
    });
    expect(loop).toEqual(
      expect.arrayContaining(['a: its parents loop back to it']),
    );
  });

  it('creates a label with the colour the file defines, whatever its spelling there', () => {
    const made = missingLabels(
      {
        labels: [{ name: 'Bug', color: 'd73a4a' }],
        issues: [{ labels: ['bug'] }],
      },
      [],
    );
    expect(made).toEqual([{ name: 'Bug', color: 'd73a4a', description: '' }]);
  });

  it('refuses a colour with # and a name defined twice, before anything is written', () => {
    const errors = validateBacklog({
      ...backlog,
      labels: [
        { name: 'bug', color: '#d73a4a' },
        { name: 'Bug', color: 'd73a4a' },
      ],
    });
    expect(errors).toContain(
      'the label "bug": colour "#d73a4a" is not 6 hex digits without #',
    );
    expect(errors).toContain('the label "Bug" is defined twice');
  });

  it('creates one label for two spellings of a name GitHub sees as one', () => {
    const issues = [
      { key: 'a', title: 'A', labels: ['Bug'] },
      { key: 'b', title: 'B', labels: ['bug'] },
    ];
    expect(missingLabels({ issues }, []).map((label) => label.name)).toEqual([
      'Bug',
    ]);
    expect(missingLabels({ issues }, ['BUG'])).toEqual([]);
  });
});

describe('validateBacklog', () => {
  it('accepts a sound file', () => {
    expect(validateBacklog(backlog)).toEqual([]);
  });

  it('names every mistake', () => {
    const errors = validateBacklog({
      milestones: [
        { key: 'sprint-0', title: 'S0' },
        { key: 'sprint-1', title: 'S1' },
      ],
      issues: [
        { key: 'a', title: 'A', milestone: 'sprint-0', waitsFor: ['b', 'zzz'] },
        { key: 'b', title: 'B', milestone: 'sprint-1', parent: 'nope' },
        { key: 'a', title: '' },
        {
          key: 'c d',
          title: 'C',
          milestone: 'sprint-9',
          fields: { Model: 'Haiku', Colour: 'x' },
        },
      ],
    });
    expect(errors).toEqual([
      'the key "a" is used twice',
      'a: no title',
      '"c d" is not a key (letters, digits, . _ : -)',
      'a: waits for "b", which is in a later milestone',
      'a: waits for "zzz", which isn\'t in the backlog',
      'b: no parent issue "nope"',
      'c d: no milestone "sprint-9"',
      'c d: "Haiku" is not a Model (Opus, Sonnet)',
      'c d: no board field "Colour"',
    ]);
  });

  it('finds a circle', () => {
    const issues = [
      { key: 'a', title: 'A', waitsFor: ['b'] },
      { key: 'b', title: 'B', waitsFor: ['a'] },
    ];
    expect(validateBacklog({ issues })).toEqual([
      'issues wait for each other in a circle: a → b → a',
    ]);
  });
});

describe('creationOrder', () => {
  it('makes what an issue waits for first, otherwise keeps the file’s order', () => {
    expect(creationOrder(backlog.issues)).toEqual([
      'app.setup',
      'invoice.build',
      'sprint-1.epic',
    ]);
  });
});

describe('renderIssueBody', () => {
  const issue = {
    key: 'invoice.build',
    title: 'Build invoice',
    body: '\nBuild it.\n',
    waitsFor: ['app.setup', 'x'],
    fields: { Model: 'Opus' },
  };

  it('writes the Model and Waits-for lines, the body and the marker', () => {
    expect(
      renderIssueBody(issue, (key: string) => (key === 'app.setup' ? 12 : 13)),
    ).toBe(
      '**Model:** Opus\n**Waits for:** #12, #13\n\nBuild it.\n\n<!-- backlog:key invoice.build -->\n',
    );
  });

  it('names an issue not made yet by its key (a dry run)', () => {
    expect(renderIssueBody(issue, () => null)).toContain(
      '**Waits for:** #<app.setup>, #<x>',
    );
    expect(renderIssueBody({ key: 'k', title: 'T' }, () => null)).toBe(
      '<!-- backlog:key k -->\n',
    );
  });
});

describe('planMilestones', () => {
  it('matches by marker, adopts an unmarked one by its title start, creates the rest', () => {
    const { plan, problems } = planMilestones(backlog.milestones, [
      { number: 1, title: 'Sprint 1 · Old goal', description: '' },
      { number: 2, title: 'Discovery', description: marker('sprint-0') },
    ]);
    expect(problems).toEqual([]);
    expect(plan.map((p) => [p.key, p.action, p.existing?.number])).toEqual([
      ['sprint-0', 'exists', 2],
      ['sprint-1', 'adopt', 1],
    ]);
    expect(
      planMilestones(backlog.milestones, []).plan.map((p) => p.action),
    ).toEqual(['create', 'create']);
  });

  it('adopts by title start only up to its " · ", and never one milestone twice', () => {
    const plain = [{ key: 's1', title: 'Sprint 1' }];
    // "Sprint 10 · Reports" is not "Sprint 1": no start to match without a " · ".
    expect(
      planMilestones(plain, [
        { number: 1, title: 'Sprint 10 · Reports', description: '' },
      ]).plan,
    ).toMatchObject([{ key: 's1', action: 'create' }]);
    const two = [
      { key: 'a', title: 'Sprint 2 · Data' },
      { key: 'b', title: 'Sprint 2 · Data, again' },
    ];
    const { problems } = planMilestones(two, [
      { number: 1, title: 'Sprint 2 · Old', description: '' },
    ]);
    expect(problems).toEqual([
      'a and b would both adopt "Sprint 2 · Old": ask',
    ]);
  });
});

describe('planIssues', () => {
  const gh = (
    number: number,
    title: string,
    key: string | null,
    milestone = 2,
  ) => ({
    number,
    title,
    body: key ? `x\n${marker(key)}` : 'x',
    milestone,
  });

  it('finds issues by key, reports differences and look-alikes, never adopts by title', () => {
    const { plan, problems, notes } = planIssues(
      backlog.issues,
      [
        gh(5, 'Build invoices', 'invoice.build', 1),
        gh(6, 'Set up roles and lists', null),
        gh(7, 'Gone', 'old.key'),
      ],
      () => 2,
    );
    expect(problems).toEqual([]);
    expect(plan.map((p) => [p.key, p.action])).toEqual([
      ['invoice.build', 'exists'],
      ['app.setup', 'create'],
      ['sprint-1.epic', 'create'],
    ]);
    expect(notes).toEqual([
      '#5 (invoice.build): titled "Build invoices", the file says "Build invoice"',
      '#5 (invoice.build): in another milestone than sprint-1',
      '#6 "Set up roles and lists" has no key marker: not adopted',
      '#7 carries the key old.key, which the file no longer names',
    ]);
  });

  it('stops on one key on two issues', () => {
    const twice = [
      gh(5, 'Build invoice', 'invoice.build'),
      gh(8, 'Build invoice', 'invoice.build'),
    ];
    expect(planIssues(backlog.issues, twice, () => 2).problems).toEqual([
      '#5 and #8 both carry the key invoice.build: which one stays?',
    ]);
  });
});

describe('missingLabels', () => {
  it('lists used labels the repo lacks, with the file’s colour or grey', () => {
    const file = {
      labels: [{ name: 'triage:stopped', color: 'b60205' }],
      issues: [
        { labels: ['triage:stopped', 'Bug', 'infra'] },
        { labels: ['infra'] },
      ],
    };
    expect(missingLabels(file, ['bug'])).toEqual([
      { name: 'triage:stopped', color: 'b60205', description: '' },
      { name: 'infra', color: 'ededed', description: '' },
    ]);
  });
});

describe('missingLinks and missingFieldValues', () => {
  const issues = [
    { key: 'epic', title: 'E' },
    {
      key: 'a',
      title: 'A',
      parent: 'epic',
      waitsFor: ['b'],
      fields: { Priority: 'P1', Model: 'Sonnet' },
    },
    { key: 'b', title: 'B', parent: 'epic' },
    { key: 'c', title: 'C', parent: 'epic', waitsFor: ['b'] },
  ];
  const states: Record<string, IssueState> = {
    epic: { number: 1, open: true, parent: null, blockedBy: [] },
    a: { number: 2, open: true, parent: null, blockedBy: [] },
    b: { number: 3, open: true, parent: 9, blockedBy: [] },
    c: { number: 4, open: false, parent: null, blockedBy: [] },
  };
  const state = (key: string) => states[key];

  it('adds what is missing, leaves another parent and closed issues alone', () => {
    expect(missingLinks(issues, state)).toEqual([
      { kind: 'subIssue', parent: 'epic', child: 'a' },
      { kind: 'blockedBy', issue: 'a', blocking: 'b' },
      { kind: 'note', text: 'b has another parent than epic: left as it is' },
    ]);
    const linked: Record<string, IssueState> = {
      ...states,
      a: { number: 2, open: true, parent: 1, blockedBy: [3] },
    };
    expect(missingLinks(issues.slice(0, 2), (k: string) => linked[k])).toEqual(
      [],
    );
  });

  it('sets only empty values on open issues; a person’s value stays and is noted', () => {
    const values: Record<string, Record<string, string>> = {
      a: { Status: 'Ready', Model: 'Opus' },
    };
    const { set, notes } = missingFieldValues(
      issues,
      state,
      (k: string) => values[k] ?? {},
    );
    expect(set).toEqual([
      { key: 'epic', field: 'Status', value: 'Backlog' },
      { key: 'a', field: 'Priority', value: 'P1' },
      { key: 'b', field: 'Status', value: 'Backlog' },
    ]);
    expect(notes).toEqual([
      'a: Model is Opus on the board, the file says Sonnet',
    ]);
  });
});
