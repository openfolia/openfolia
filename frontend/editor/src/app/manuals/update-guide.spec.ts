import {
  defaultChoice,
  formOf,
  optionIds,
  parseVersions,
  previewOf,
  putStep,
  removeStep,
  removeVersion,
  reorderSteps,
  restoreStep,
  stepFormProblems,
  stepGroups,
  stepIssues,
  stepOf,
  stepVersions,
  versionRemovable,
  withVersion,
  type UpdateGuide,
} from './update-guide';

const GUIDE: UpdateGuide = {
  attribute: 'software',
  versions: ['1.0', '2.0', '3.0'],
  steps: [
    { module: 'back-up', version: '2.0', phase: 'before' },
    { module: 'install', version: '2.0', phase: 'during' },
    { module: 'check', version: '3.0', phase: 'after', level: 'internal' },
    {
      module: 'drain',
      version: '3.0',
      phase: 'before',
      when: { op: 'in', attr: 'cluster', values: ['yes'] },
    },
    { module: 'stop', version: '2.0', phase: 'before' },
    { module: 'draft', phase: 'before' },
  ],
};

const LEVELS = ['public', 'internal'];

describe('update guide steps (#908)', () => {
  it('lists the steps by version, then phase, and those not placed first', () => {
    const { unplaced, versions } = stepGroups(GUIDE.steps);
    expect(unplaced.map((s) => s.index)).toEqual([5]);
    expect(
      versions.map((v) => ({
        version: v.version,
        count: v.count,
        phases: v.phases.map((p) => [p.phase, p.steps.map((s) => s.index)]),
      })),
    ).toEqual([
      {
        version: '2.0',
        count: 3,
        phases: [
          ['before', [0, 4]],
          ['during', [1]],
        ],
      },
      {
        version: '3.0',
        count: 2,
        phases: [
          ['before', [3]],
          ['after', [2]],
        ],
      },
    ]);
  });

  it('adds a step with a new version in its place, and edits one in place', () => {
    const added = putStep(GUIDE, null, {
      module: 'migrate',
      version: '2.5',
      phase: 'during',
    });
    expect(added.versions).toEqual(['1.0', '2.0', '2.5', '3.0']);
    expect(added.steps.at(-1)?.module).toBe('migrate');
    const edited = putStep(GUIDE, 1, {
      module: 'install',
      version: '3.0',
      phase: 'during',
    });
    expect(edited.steps[1]?.version).toBe('3.0');
    expect(edited.versions).toEqual(GUIDE.versions);
    expect(withVersion(['1.0', '2.0'], '2.0.0')).toEqual(['1.0', '2.0']);
    expect(withVersion(['1.0', '2.0'], '10.1')).toEqual(['1.0', '2.0', '10.1']);
  });

  it('removes a step and puts it back where it was', () => {
    const removed = removeStep(GUIDE, 2);
    expect(removed.steps.map((s) => s.module)).not.toContain('check');
    expect(restoreStep(removed, 2, GUIDE.steps[2]!)).toEqual(GUIDE);
  });

  it('reorders one group in the places its steps held, the others staying', () => {
    // Version 2.0, before: steps 0 and 4, now 4 first.
    const next = reorderSteps(GUIDE, [4, 0]);
    expect(next.steps.map((s) => s.module)).toEqual([
      'stop',
      'install',
      'check',
      'drain',
      'back-up',
      'draft',
    ]);
    expect(
      stepGroups(next.steps).versions[0]?.phases[0]?.steps.map(
        (s) => s.step.module,
      ),
    ).toEqual(['stop', 'back-up']);
  });

  it('takes out only a version no step needs, keeping two', () => {
    const guide = { ...GUIDE, versions: ['1.0', '1.5', '2.0', '3.0'] };
    expect(versionRemovable(guide, '1.5')).toBe(true);
    expect(versionRemovable(guide, '2.0')).toBe(false);
    expect(removeVersion(guide, '1.5').versions).toEqual(GUIDE.versions);
    // Taking out the first would leave the steps of the new first version in no update.
    const later = { ...GUIDE, versions: ['1.0', '2.0', '3.0', '4.0'] };
    expect(versionRemovable(later, '1.0')).toBe(false);
    expect(versionRemovable(guide, '1.0')).toBe(true);
    expect(
      versionRemovable(
        { ...GUIDE, versions: ['1.0', '2.0'], steps: [] },
        '1.0',
      ),
    ).toBe(false);
  });

  it('finds a step’s issues by its place', () => {
    const issues = [
      { code: 'a', at: 'guide.steps.1' },
      { code: 'b', at: 'guide.steps.10' },
      { code: 'c' },
    ];
    expect(stepIssues(issues, 1).map((i) => i.code)).toEqual(['a']);
  });
});

describe('the step form (#908)', () => {
  const form = formOf({ module: 'install' });

  it('needs a dotted version after the first, and a phase', () => {
    expect(stepFormProblems(form, GUIDE)).toEqual({
      version: 'editor.manuals.guide.form.versionMissing',
      phase: 'editor.manuals.guide.form.phaseMissing',
    });
    expect(
      stepFormProblems({ ...form, version: 'two', phase: 'during' }, GUIDE),
    ).toEqual({ version: 'editor.manuals.guide.form.versionInvalid' });
    expect(
      stepFormProblems({ ...form, version: '1.0', phase: 'during' }, GUIDE),
    ).toEqual({ version: 'editor.manuals.guide.form.versionTooEarly' });
    expect(
      stepFormProblems({ ...form, version: '0.9', phase: 'during' }, GUIDE),
    ).toEqual({ version: 'editor.manuals.guide.form.versionTooEarly' });
    expect(
      stepFormProblems({ ...form, version: '2.5', phase: 'later' }, GUIDE),
    ).toEqual({ phase: 'editor.manuals.guide.form.phaseMissing' });
    expect(
      stepFormProblems(
        { ...formOf({ module: '' }), version: '2.0', phase: 'after' },
        GUIDE,
      ),
    ).toEqual({ module: 'editor.manuals.guide.form.moduleMissing' });
    expect(
      stepFormProblems({ ...form, version: ' 2.5 ', phase: 'after' }, GUIDE),
    ).toEqual({});
  });

  it('makes the step: the guide’s spelling of the version, level and condition only when set', () => {
    expect(
      stepOf({ ...form, version: '2.0.0', phase: 'during' }, GUIDE),
    ).toEqual({ module: 'install', version: '2.0', phase: 'during' });
    const when = { op: 'in' as const, attr: 'cluster', values: ['yes'] };
    expect(
      stepOf(
        { ...form, version: '3.0', phase: 'after', level: 'internal', when },
        GUIDE,
      ),
    ).toEqual({
      module: 'install',
      version: '3.0',
      phase: 'after',
      level: 'internal',
      when,
    });
    // A step round-trips through its form.
    expect(stepOf(formOf(GUIDE.steps[2]!), GUIDE)).toEqual(GUIDE.steps[2]);
  });

  it('offers every version but the first', () => {
    expect(stepVersions(GUIDE)).toEqual(['2.0', '3.0']);
  });

  it('reads the versions of a new guide: sorted, each once, at least two', () => {
    expect(parseVersions('3.0, 1.0 2.0,2.0.0')).toEqual({
      versions: ['1.0', '2.0', '3.0'],
    });
    expect(parseVersions('2.10, 2.9')).toEqual({ versions: ['2.9', '2.10'] });
    expect(parseVersions('1.0, v2')).toEqual({
      problem: 'editor.manuals.new.versionsInvalid',
      value: 'v2',
    });
    expect(parseVersions('1.0, 1.0.0')).toEqual({
      problem: 'editor.manuals.new.versionsTooFew',
    });
    expect(parseVersions('')).toEqual({
      problem: 'editor.manuals.new.versionsTooFew',
    });
  });
});

describe('the preview (#908)', () => {
  it('resolves the whole guide by default, as a reader of every level without options', () => {
    const result = previewOf(GUIDE, defaultChoice(GUIDE), LEVELS);
    expect(result.status).toBe('resolved');
    if (result.status !== 'resolved') return;
    expect(
      result.phases.map((p) => [p.phase, p.steps.map((s) => s.step.module)]),
    ).toEqual([
      ['before', ['back-up', 'stop']],
      ['during', ['install']],
      ['after', ['check']],
    ]);
    expect(result.count).toBe(4);
  });

  it('narrows to a range, a level and an option', () => {
    const range = previewOf(GUIDE, { from: '2.0', to: '3.0' }, LEVELS);
    expect(range.status === 'resolved' && range.count).toBe(1);
    const publicOnly = previewOf(
      GUIDE,
      { from: '1.0', to: '3.0', level: 'public' },
      LEVELS,
    );
    expect(
      publicOnly.status === 'resolved' &&
        publicOnly.phases.flatMap((p) => p.steps.map((s) => s.step.module)),
    ).toEqual(['back-up', 'stop', 'install']);
    const cluster = previewOf(
      GUIDE,
      { from: '2.0', to: '3.0', options: { cluster: 'yes' } },
      LEVELS,
    );
    expect(
      cluster.status === 'resolved' &&
        cluster.phases.flatMap((p) => p.steps.map((s) => s.step.module)),
    ).toEqual(['drain', 'check']);
    const back = previewOf(GUIDE, { from: '3.0', to: '1.0' }, LEVELS);
    expect(back.status === 'resolved' && back.reason).toBe('not-forward');
  });

  it('offers the options the conditions name', () => {
    expect([...optionIds(GUIDE.steps)]).toEqual(['cluster']);
  });
});
