import {
  byUrgency,
  createBlocked,
  firstChecks,
  readinessOf,
  type CheckItem,
  type ManualReadiness,
} from './create-release-model';

const manual = (
  id: string,
  blocking: number,
  warning: number,
  failed = false,
): ManualReadiness => ({
  id,
  title: id,
  blocking,
  warning,
  checks: [],
  failed,
});

const check = (id: string, severity: 'blocking' | 'warning') =>
  ({ id, attributes: { severity } }) as CheckItem;

const ok = {
  readiness: { kind: 'read', blocking: 0, warning: 0 },
  warningsConfirmed: false,
  detailsProblem: false,
  notesProblem: false,
  busy: false,
} as const;

describe('create-release-model', () => {
  it('sums the manuals’ checks; one unread manual fails them all', () => {
    expect(readinessOf(null)).toEqual({ kind: 'loading' });
    expect(readinessOf([manual('a', 1, 2), manual('b', 0, 3)])).toEqual({
      kind: 'read',
      blocking: 1,
      warning: 5,
    });
    expect(readinessOf([manual('a', 0, 0, true)])).toEqual({ kind: 'failed' });
  });

  it('lists unread, blocking, warning, then passing manuals', () => {
    expect(
      byUrgency([
        manual('ok', 0, 0),
        manual('warn', 0, 1),
        manual('block', 2, 0),
        manual('unread', 0, 0, true),
      ]).map((m) => m.id),
    ).toEqual(['unread', 'block', 'warn', 'ok']);
  });

  it('says why "Create release" waits: checks first, then details, then notes', () => {
    expect(createBlocked(ok)).toBeNull();
    expect(createBlocked({ ...ok, busy: true })).toBe(
      'editor.releases.create.blocked.busy',
    );
    expect(createBlocked({ ...ok, readiness: { kind: 'loading' } })).toBe(
      'editor.releases.create.blocked.checking',
    );
    expect(createBlocked({ ...ok, readiness: { kind: 'failed' } })).toBe(
      'editor.releases.create.blocked.checksFailed',
    );
    expect(
      createBlocked({
        ...ok,
        readiness: { kind: 'read', blocking: 1, warning: 0 },
        detailsProblem: true,
      }),
    ).toBe('editor.releases.create.blocked.blocking');
    const warned = {
      ...ok,
      readiness: { kind: 'read', blocking: 0, warning: 2 },
    } as const;
    expect(createBlocked(warned)).toBe(
      'editor.releases.create.blocked.warnings',
    );
    expect(createBlocked({ ...warned, warningsConfirmed: true })).toBeNull();
    expect(createBlocked({ ...ok, detailsProblem: true })).toBe(
      'editor.releases.create.blocked.details',
    );
    expect(createBlocked({ ...ok, notesProblem: true })).toBe(
      'editor.releases.create.blocked.notes',
    );
  });

  it('shows the first checks, blocking first', () => {
    expect(
      firstChecks(
        [
          check('w1', 'warning'),
          check('b1', 'blocking'),
          check('w2', 'warning'),
        ],
        2,
      ).map((c) => c.id),
    ).toEqual(['b1', 'w1']);
  });
});
