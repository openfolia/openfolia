import { TestBed } from '@angular/core/testing';
import { TranslocoService } from '@jsverse/transloco';

import en from '../../i18n/en.json';
import de from '../../i18n/de.json';
import { notification } from './testing/notifications';
import {
  describe as describeNotification,
  groupOf,
  releaseIdsOf,
  type DescribeContext,
  type NotificationItem,
  type NotificationKind,
} from './notification-model';

const named: DescribeContext = {
  nameOf: (who) => (who.id === 'u-rita' ? 'Rita Reviewer' : null),
  releaseLabel: (id) => (id === 'rel-1' ? 'Pump 2.1' : null),
};
const rita = { kind: 'user', id: 'u-rita' };
const stranger = { kind: 'user', id: 'u-unknown' };
const cs = { changeSetId: 'cs-7', title: 'Battery charging' };

/** The sentence a row shows, in English or German. */
function sentence(item: NotificationItem, lang: 'en' | 'de' = 'en'): string {
  const transloco = TestBed.inject(TranslocoService);
  transloco.setTranslation({ editor: lang === 'en' ? en : de }, lang, {
    merge: true,
  });
  const view = describeNotification(item, named);
  const params: Record<string, unknown> = { ...view.params };
  if (params['by'] === undefined && view.byFallback) {
    params['by'] = transloco.translate(view.byFallback, {}, lang);
  }
  return transloco.translate(view.key, params, lang);
}

describe('notification texts', () => {
  it('builds each change set kind from the payload, naming who did it', () => {
    const at = (kind: NotificationKind) =>
      sentence(notification('n', kind, { ...cs, by: rita }));
    expect(at('change-set.submit')).toBe(
      'Rita Reviewer asked you to review “Battery charging”',
    );
    expect(at('change-set.return')).toBe(
      'Rita Reviewer returned “Battery charging” with changes requested',
    );
    expect(at('change-set.approve')).toBe(
      'Rita Reviewer approved “Battery charging”',
    );
    expect(at('change-set.sign-off')).toBe(
      'Rita Reviewer signed off “Battery charging”',
    );
    expect(at('change-set.merge')).toBe(
      'Rita Reviewer published “Battery charging”',
    );
  });

  it('names the role when the person is not known', () => {
    expect(
      sentence(notification('n', 'change-set.return', { ...cs, by: stranger })),
    ).toBe('A reviewer returned “Battery charging” with changes requested');
    expect(
      sentence(notification('n', 'change-set.submit', { ...cs, by: stranger })),
    ).toBe('An author asked you to review “Battery charging”');
  });

  it('opens the review of the change set', () => {
    const view = describeNotification(
      notification('n', 'change-set.return', {
        ...cs,
        by: rita,
        state: 'draft',
      }),
      named,
    );
    expect(view.link).toEqual({
      path: ['/review'],
      query: { state: 'draft', cs: 'cs-7' },
    });
    const submitted = describeNotification(
      notification('n', 'change-set.submit', { ...cs, state: 'in-review' }),
      named,
    );
    expect(submitted.link).toEqual({
      path: ['/review'],
      query: { cs: 'cs-7' },
    });
    expect(view.icon).toBe('lucideUndo2');
  });

  it('opens the module of a single broken lock, else the change set', () => {
    const one = notification('n', 'lock.break', {
      ...cs,
      by: stranger,
      count: 1,
      subjects: ['module/en/battery-faq'],
    });
    expect(sentence(one)).toBe(
      'An administrator broke your lock on battery-faq in “Battery charging”',
    );
    expect(describeNotification(one, named).link).toEqual({
      path: ['/content', 'en', 'battery-faq'],
      query: { cs: 'cs-7' },
    });
    const many = notification('n', 'lock.break', {
      ...cs,
      by: rita,
      count: 3,
      subjects: ['module/en/a', 'module/en/b', 'manual/m'],
    });
    expect(sentence(many)).toBe(
      'Rita Reviewer broke 3 of your locks in “Battery charging”',
    );
    expect(describeNotification(many, named).link?.path).toEqual(['/review']);
  });

  it('tells of imports, and opens the change set an import committed into', () => {
    const done = notification(
      'n',
      'translation.imported',
      { importId: 'imp-1', changeSetId: 'cs-9' },
      { subject: { type: 'import', id: 'imp-1' } },
    );
    expect(sentence(done)).toBe('Your translation import is done');
    expect(describeNotification(done, named).link).toEqual({
      path: ['/review'],
      query: { cs: 'cs-9' },
    });
    const failed = notification(
      'n',
      'translation.import-failed',
      { importId: 'imp-2' },
      { subject: { type: 'import', id: 'imp-2' } },
    );
    expect(sentence(failed)).toBe('Your translation import failed');
    const view = describeNotification(failed, named);
    expect(view.problem).toBe(true);
    expect(view.link).toEqual({
      path: ['/translations'],
      query: { import: 'imp-2' },
    });
  });

  it('names a release by its label once read, and plainly before', () => {
    const published = notification(
      'n',
      'release.published',
      { releaseId: 'rel-1', level: 'major', manualIds: ['a', 'b'] },
      { subject: { type: 'release', id: 'rel-1' } },
    );
    expect(sentence(published)).toBe(
      'Release Pump 2.1 was published, with 2 manuals you read',
    );
    const unknown = notification(
      'n',
      'release.output-failed',
      { releaseId: 'rel-2', manualId: 'a' },
      { subject: { type: 'release', id: 'rel-2' } },
    );
    expect(sentence(unknown)).toBe('A PDF of a release failed to build');
    expect(describeNotification(unknown, named).link).toEqual({
      path: ['/releases'],
      query: { release: 'rel-2' },
    });
    expect(releaseIdsOf([published, unknown, published])).toEqual([
      'rel-1',
      'rel-2',
    ]);
  });

  it('says a PDF told failed is ready after all, named or plainly (#551)', () => {
    const recovered = notification(
      'n',
      'release.output-recovered',
      { releaseId: 'rel-1', manualId: 'a' },
      { subject: { type: 'release', id: 'rel-1' } },
    );
    expect(sentence(recovered)).toBe(
      'A PDF of release Pump 2.1 that failed to build is ready after all',
    );
    const view = describeNotification(recovered, named);
    expect(view.link).toEqual({
      path: ['/releases'],
      query: { release: 'rel-1' },
    });
    expect(view.problem).toBe(false);
    const unknown = notification(
      'n',
      'release.output-recovered',
      { releaseId: 'rel-2', manualId: 'a' },
      { subject: { type: 'release', id: 'rel-2' } },
    );
    expect(sentence(unknown)).toBe(
      'A PDF of a release that failed to build is ready after all',
    );
  });

  it('speaks German too', () => {
    expect(
      sentence(
        notification('n', 'change-set.return', { ...cs, by: stranger }),
        'de',
      ),
    ).toBe(
      'Eine Prüferin oder ein Prüfer hat „Battery charging“ mit Änderungswünschen zurückgegeben',
    );
  });

  it('never fails on a payload that is not what its kind writes', () => {
    const odd = notification('n', 'change-set.approve', {
      by: 'nobody',
      title: 42,
    });
    expect(sentence(odd)).toBe('A reviewer approved “”');
    expect(describeNotification(odd, named).link).toEqual({
      path: ['/review'],
      query: { cs: 'cs-1' },
    });
  });

  it('groups by the local day', () => {
    const now = new Date(2026, 10, 19, 15, 0);
    expect(groupOf(new Date(2026, 10, 19, 0, 5).toISOString(), now)).toBe(
      'today',
    );
    expect(groupOf(new Date(2026, 10, 18, 23, 55).toISOString(), now)).toBe(
      'earlier',
    );
  });

  it('tells the backup holders of a failed or overdue backup, opening the backups', () => {
    const failed = notification(
      'n',
      'backup.failed',
      { runId: 'r1' },
      { subject: { type: 'backup', id: 'r1' } },
    );
    expect(sentence(failed)).toBe('A backup failed');
    const view = describeNotification(failed, named);
    expect(view.problem).toBe(true);
    expect(view.link).toEqual({ path: ['/admin', 'backups'], query: {} });
    const overdue = notification(
      'n',
      'backup.overdue',
      { warnAfterHours: 30 },
      { subject: { type: 'backup', id: 'none' } },
    );
    expect(sentence(overdue)).toBe('No good backup for more than 30 hours');
    expect(sentence(overdue, 'de')).toBe(
      'Seit mehr als 30 Stunden kein gutes Backup',
    );
  });
});
