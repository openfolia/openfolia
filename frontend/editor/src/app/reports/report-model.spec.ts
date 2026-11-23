import {
  unusedFilter,
  upToDateShare,
  usesOf,
  type UsageItem,
} from './report-model';

const counts = (upToDate: number, total: number) => ({
  total,
  upToDate,
  outdated: total - upToDate,
  atProvider: 0,
  missing: 0,
});

describe('report model', () => {
  it('rounds the share up to date down to a whole percent', () => {
    expect(upToDateShare(counts(3, 4))).toBe(0.75);
    expect(upToDateShare(counts(2, 3))).toBe(0.66);
    expect(upToDateShare(counts(0, 0))).toBe(0);
    expect(upToDateShare(counts(5, 5))).toBe(1);
  });

  it('maps the view to filter[unused]', () => {
    expect(unusedFilter('all')).toBeUndefined();
    expect(unusedFilter('used')).toBe('false');
    expect(unusedFilter('unused')).toBe('true');
  });

  it('splits the uses and counts those not named', () => {
    const item = {
      type: 'ModuleUsage',
      id: 'a',
      attributes: {
        moduleId: 'a',
        title: 'A',
        type: 'concept',
        deprecated: false,
      },
      meta: {
        languages: ['en'],
        usage: { manuals: 3, modules: 1 },
        usedIn: [
          {
            kind: 'manual',
            id: 'm',
            title: 'M',
            direct: true,
            deprecated: false,
          },
          {
            kind: 'module',
            id: 'b',
            title: 'B',
            direct: true,
            deprecated: false,
          },
        ],
      },
    } as UsageItem;
    const uses = usesOf(item);
    expect(uses.manuals.map((u) => u.id)).toEqual(['m']);
    expect(uses.modules.map((u) => u.id)).toEqual(['b']);
    expect(uses.moreManuals).toBe(2);
    expect(uses.moreModules).toBe(0);
  });
});
