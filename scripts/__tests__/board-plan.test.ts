// pnpm setup:board's planner and applier: the workflow's fields and options are added, a
// person's options and values are kept, a fresh project loses only GitHub's defaults, a second
// run changes nothing, and the settings entry keeps every other key.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { setupBoard } from '@/scripts/board-github.mjs';
import {
  BOARD_FIELDS,
  findProject,
  mergeLocalSettings,
  mergeOptions,
  planBoard,
} from '@/scripts/board-plan.mjs';

import { fakeGitHub } from './fake-github';

const option = (id: string, name: string) => ({
  id,
  name,
  color: 'RED',
  description: 'd',
});
const STATUS = BOARD_FIELDS[0].options!;

describe('mergeOptions', () => {
  it('on a fresh project: the five, GitHub’s "In Progress" and "Done" kept by id, "Todo" dropped', () => {
    const merged = mergeOptions(
      [option('a', 'Todo'), option('b', 'In Progress'), option('c', 'Done')],
      STATUS,
      { dropExtra: true },
    );
    expect(merged.options.map((o) => [o.id, o.name])).toEqual([
      [undefined, 'Backlog'],
      [undefined, 'Ready'],
      ['b', 'In progress'],
      [undefined, 'In review'],
      ['c', 'Done'],
    ]);
    expect(merged).toMatchObject({
      changed: true,
      added: ['Backlog', 'Ready', 'In review'],
      renamed: ['In Progress → In progress'],
      dropped: ['Todo'],
    });
  });

  it('on a board in use: keeps every option, its order, colour and description, appends the missing', () => {
    const merged = mergeOptions(
      [option('x', 'Blocked'), option('d', 'Done')],
      STATUS,
    );
    expect(merged.options.map((o) => o.name)).toEqual([
      'Blocked',
      'Done',
      'Backlog',
      'Ready',
      'In progress',
      'In review',
    ]);
    expect(merged.options[1]).toEqual(option('d', 'Done'));
    expect(merged.kept).toEqual(['Blocked']);
    expect(merged.dropped).toEqual([]);
  });

  it('changes nothing when every option is there', () => {
    const existing = STATUS.map((o, i) => ({ ...o, id: `s${i}` }));
    expect(mergeOptions(existing, STATUS).changed).toBe(false);
  });
});

describe('planBoard', () => {
  it('creates the missing fields with their options', () => {
    const { steps } = planBoard({ fields: [] });
    expect(steps.map((s) => [s.kind, s.name, s.dataType])).toEqual([
      ['createField', 'Status', 'SINGLE_SELECT'],
      ['createField', 'Priority', 'SINGLE_SELECT'],
      ['createField', 'Size', 'SINGLE_SELECT'],
      ['createField', 'Model', 'SINGLE_SELECT'],
      ['createField', 'Review rounds', 'NUMBER'],
      ['createField', 'Stopped', 'TEXT'],
    ]);
  });

  it('refuses to change a field of the wrong type', () => {
    const { steps, problems } = planBoard({
      fields: [
        { id: 'f', name: 'Stopped', dataType: 'SINGLE_SELECT', options: [] },
      ],
    });
    expect(steps.some((s) => s.name === 'Stopped')).toBe(false);
    expect(problems).toEqual([
      expect.stringContaining('"Stopped" is SINGLE_SELECT'),
    ]);
  });
});

describe('findProject', () => {
  const projects = [
    { id: 'a', number: 1, title: 'app', closed: true },
    { id: 'b', number: 2, title: 'app', closed: false },
    { id: 'c', number: 3, title: 'other', closed: false },
  ];

  it('takes the known number first, else the open project with the title', () => {
    expect(
      findProject({ projects, title: 'app', number: '3' }).project?.id,
    ).toBe('c');
    expect(
      findProject({ projects, title: 'app', number: null }).project?.id,
    ).toBe('b');
    expect(
      findProject({ projects, title: 'new', number: '9' }).project,
    ).toBeNull();
  });

  it('asks when two open projects share the title', () => {
    const twice = [
      ...projects,
      { id: 'd', number: 4, title: 'app', closed: false },
    ];
    expect(findProject({ projects: twice, title: 'app' }).problem).toContain(
      '#2, #4',
    );
  });
});

describe('mergeLocalSettings', () => {
  it('sets the two variables and keeps every other key', () => {
    const current = {
      permissions: { allow: ['x'] },
      env: { OTHER: '1', GH_PROJECT_NUMBER: '1' },
    };
    expect(mergeLocalSettings(current, { owner: 'acme', number: 7 })).toEqual({
      permissions: { allow: ['x'] },
      env: { OTHER: '1', GH_PROJECT_OWNER: 'acme', GH_PROJECT_NUMBER: '7' },
    });
    expect(
      mergeLocalSettings(undefined, { owner: 'a', number: 1 }).env
        .GH_PROJECT_NUMBER,
    ).toBe('1');
  });
});

describe('setupBoard against a fake GitHub', () => {
  const run = (fake: ReturnType<typeof fakeGitHub>, dryRun = false) => {
    const lines: string[] = [];
    const result = setupBoard({
      gh: fake.gh,
      repo: fake.repo,
      owner: 'acme',
      title: 'app',
      number: null,
      dryRun,
      log: (line: string) => lines.push(line),
    });
    return { result, lines };
  };

  it('a dry run writes nothing', () => {
    const fake = fakeGitHub();
    const { result, lines } = run(fake, true);
    expect(result.number).toBeNull();
    expect(fake.state.writes).toEqual([]);
    expect(lines[0]).toBe('would create the project "app" for acme/app');
    // As the real run will: GitHub gives a new project its own Status, which is updated.
    expect(
      lines.some(
        (line) => line.includes('"Status"') && /create the field/.test(line),
      ),
    ).toBe(false);
    expect(lines.some((line) => line.includes('"Status"'))).toBe(true);
  });

  it('makes the board once; a second run changes nothing', () => {
    const fake = fakeGitHub();
    expect(run(fake).result).toEqual({ number: 1, problems: [] });
    const fields = fake.state.projects[0].fields;
    expect(fields.map((f) => f.name)).toEqual(BOARD_FIELDS.map((f) => f.name));
    expect(fields[0].options!.map((o) => o.name)).toEqual(
      STATUS.map((o) => o.name),
    );
    const writes = fake.state.writes.length;
    expect(run(fake).lines).toContain(
      'every field and option is there already',
    );
    expect(fake.state.writes.length).toBe(writes);
  });
});

describe('scripts/backlog.schema.json', () => {
  it('names the board’s fields and options', () => {
    const schema = JSON.parse(
      readFileSync(
        path.resolve(__dirname, '..', 'backlog.schema.json'),
        'utf8',
      ),
    );
    const fields = schema.properties.issues.items.properties.fields.properties;
    expect(Object.keys(fields)).toEqual(BOARD_FIELDS.map((f) => f.name));
    for (const field of BOARD_FIELDS) {
      if (field.options)
        expect(fields[field.name].enum).toEqual(
          field.options.map((o) => o.name),
        );
    }
  });
});
