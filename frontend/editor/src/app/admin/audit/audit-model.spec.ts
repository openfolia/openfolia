import de from '../../../i18n/de.json';
import en from '../../../i18n/en.json';
import {
  ACTION_TEXTS,
  auditLogLink,
  dataEntries,
  dayRangeFilter,
  readFacts,
  SUBJECT_TYPE_TEXTS,
  subjectFilter,
  subjectLink,
  validAction,
  validActor,
  validDay,
  validKind,
  validSubjectType,
  type AuditEventItem,
} from './audit-model';

/** The text of a whole key in one language, or undefined. */
const textOf = (language: object, key: string): string | undefined => {
  let node: unknown = { editor: language };
  for (const part of key.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node))
      return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
};
const has = (key: string): boolean =>
  textOf(en, key) !== undefined && textOf(de, key) !== undefined;

describe('audit model', () => {
  // #877: reads of service accounts, a kind of their own.
  it('takes the kinds the API filters by, and reads a read event’s facts', () => {
    expect(validKind('read')).toBe(true);
    expect(validKind('write')).toBe(true);
    expect(validKind('other')).toBe(false);
    const event = (
      kind: 'read' | 'write',
      data: Record<string, unknown>,
    ): AuditEventItem => ({
      type: 'AuditEvent',
      id: '1',
      attributes: {
        at: '2026-11-25T10:00:00.000Z',
        kind,
        actor: { kind: 'service', id: 'agent' },
        action: kind === 'read' ? 'api.read' : 'role.assign',
        subject: { type: 'route', id: '/chunks' },
        comment: null,
        data,
      },
    });
    expect(
      readFacts(
        event('read', { client: 'mcp/search', ref: 'main', status: 200 }),
      ),
    ).toEqual({ client: 'mcp/search', ref: 'main', aborted: false });
    expect(readFacts(event('read', { status: 404, aborted: true }))).toEqual({
      failedStatus: 404,
      aborted: true,
    });
    expect(readFacts(event('write', { client: 'x' }))).toBeNull();
    expect(
      readFacts({
        ...event('read', { count: 312 }),
        attributes: {
          ...event('read', { count: 312 }).attributes,
          action: 'api.read-gap',
        },
      }),
    ).toEqual({ unrecorded: 312, aborted: false });
  });

  it('names every listed action and subject type with an existing key', () => {
    for (const key of [
      ...Object.values(ACTION_TEXTS),
      ...Object.values(SUBJECT_TYPE_TEXTS),
    ]) {
      expect(has(key), key).toBe(true);
    }
  });

  it('names the group mappings’ actions and subject in English and German (#692)', () => {
    const texts = (key: string | undefined) =>
      key === undefined ? [] : [textOf(en, key), textOf(de, key)];
    expect(texts(ACTION_TEXTS['group-mapping.create'])).toEqual([
      'Group mapping added',
      'Gruppenzuordnung hinzugefügt',
    ]);
    expect(texts(ACTION_TEXTS['group-mapping.delete'])).toEqual([
      'Group mapping removed',
      'Gruppenzuordnung entfernt',
    ]);
    expect(texts(SUBJECT_TYPE_TEXTS['group-mapping'])).toEqual([
      'Group mapping',
      'Gruppenzuordnung',
    ]);
  });

  it('checks the filters as the API takes them', () => {
    expect(validActor('user')).toBe(true);
    expect(validActor('service/portal-build')).toBe(true);
    expect(validActor('user/')).toBe(false);
    expect(validActor('robot/x')).toBe(false);
    expect(validSubjectType('change-set')).toBe(true);
    expect(validSubjectType('Change')).toBe(false);
    expect(validAction('change-set.submit')).toBe(true);
    expect(validAction('submit')).toBe(false);
  });

  it('makes the subject filter from a type and an ID', () => {
    expect(subjectFilter(undefined, 'x')).toBeUndefined();
    expect(subjectFilter('module', '')).toBe('module');
    expect(subjectFilter('module', 'en/intro')).toBe('module/en/intro');
  });

  it('links a module, a manual and a change set; nothing else', () => {
    expect(subjectLink({ type: 'module', id: 'en/battery-charging' })).toEqual({
      commands: ['/content', 'en', 'battery-charging'],
    });
    expect(subjectLink({ type: 'module', id: 'broken' })).toBeNull();
    expect(subjectLink({ type: 'manual', id: 'user-guide' })).toEqual({
      commands: ['/manuals'],
      queryParams: { manual: 'user-guide' },
    });
    expect(subjectLink({ type: 'change-set', id: 'cs-1' })).toEqual({
      commands: ['/review'],
      queryParams: { cs: 'cs-1' },
    });
    expect(subjectLink({ type: 'role', id: 'author' })).toBeNull();
    expect(auditLogLink({ type: 'change-set', id: 'cs-1' })).toEqual({
      commands: ['/admin', 'audit'],
      queryParams: { type: 'change-set', id: 'cs-1' },
    });
  });

  it('flattens data into readable lines', () => {
    expect(
      dataEntries({
        from: 'draft',
        to: 'in-review',
        written: 2,
        recovered: true,
        roleIds: ['author', 'reviewer'],
        none: null,
        empty: [],
        grant: { permissions: ['content.read'], scope: {} },
        outputs: [{ manual: 'm', lang: 'en' }],
      }),
    ).toEqual([
      { key: 'from', value: 'draft' },
      { key: 'to', value: 'in-review' },
      { key: 'written', value: '2' },
      { key: 'recovered', value: 'true' },
      { key: 'roleIds', value: 'author, reviewer' },
      { key: 'none', value: null },
      { key: 'empty', value: null },
      { key: 'grant.permissions', value: 'content.read' },
      { key: 'grant.scope', value: null },
      { key: 'outputs', value: '[{"manual":"m","lang":"en"}]' },
    ]);
  });

  it('shows deep nesting as JSON', () => {
    expect(dataEntries({ a: { b: { c: { d: 1 } } } })).toEqual([
      { key: 'a.b.c', value: '{"d":1}' },
    ]);
  });

  it('takes only calendar days that exist', () => {
    expect(validDay('2026-02-28')).toBe(true);
    expect(validDay('2028-02-29')).toBe(true);
    expect(validDay('2026-02-29')).toBe(false);
    expect(validDay('2026-13-01')).toBe(false);
    expect(validDay('2026-1-01')).toBe(false);
    expect(validDay('yesterday')).toBe(false);
    expect(validDay('9999-12-31')).toBe(false);
    expect(validDay('0999-12-31')).toBe(false);
  });

  it('turns a range of days into the API filter, both days whole', () => {
    expect(dayRangeFilter(undefined, undefined)).toEqual({});
    expect(dayRangeFilter('2026-12-31', '2026-12-31')).toEqual({
      'filter[from]': new Date(2026, 11, 31).toISOString(),
      'filter[to]': new Date(2027, 0, 1).toISOString(),
    });
    expect(dayRangeFilter('nonsense', '2026-01-05')).toEqual({
      'filter[to]': new Date(2026, 0, 6).toISOString(),
    });
  });
});
