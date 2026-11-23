import type { ProjectConfig } from '../content/browser-model';
import {
  addMatter,
  audienceLevel,
  exclude,
  gatheredLevels,
  gatheredTypeIds,
  gatheringOf,
  include,
  levelRows,
  inVariant,
  mayGatherFrom,
  newRule,
  originOf,
  removeMatter,
  ruleIssues,
  setGathering,
  setGrouping,
  setLevels,
  setTypes,
} from './derived-rule';

const CONFIG = {
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  moduleTypes: [
    { id: 'concept', label: 'Concept' },
    { id: 'hazard', label: 'Hazard', safety: true },
  ],
  variantAttributes: [
    { id: 'model', label: 'Model', kind: 'enum', values: [] },
    { id: 'software', label: 'Software', kind: 'version' },
  ],
} as unknown as ProjectConfig;

describe('derived-rule (#669)', () => {
  it('orders audiences as readers are let in: none is the most restricted', () => {
    expect(audienceLevel('public', CONFIG)).toBe(0);
    expect(audienceLevel('internal', CONFIG)).toBe(1);
    expect(audienceLevel(undefined, CONFIG)).toBe(1);
    expect(audienceLevel('gone', CONFIG)).toBe(2);
  });

  it('gathers only from an assembled manual for its audience or a wider one', () => {
    const leaflet = { id: 'leaflet', audience: 'internal' };
    expect(
      mayGatherFrom({ id: 'op', audience: 'public' }, leaflet, CONFIG),
    ).toBe(true);
    expect(mayGatherFrom({ id: 'op' }, leaflet, CONFIG)).toBe(true);
    expect(
      mayGatherFrom({ id: 'other', kind: 'derived' }, leaflet, CONFIG),
    ).toBe(false);
    expect(mayGatherFrom({ id: 'leaflet' }, leaflet, CONFIG)).toBe(false);
    expect(
      mayGatherFrom(
        { id: 'op', audience: 'internal' },
        { id: 'l', audience: 'public' },
        CONFIG,
      ),
    ).toBe(false);
  });

  it('changes the rule: types, exclusions, front and back matter', () => {
    const rule = newRule('op');
    expect(rule).toEqual({ source: 'op', exclude: [], front: [], back: [] });
    expect(gatheredTypeIds(rule, CONFIG)).toEqual(['hazard']);
    const typed = setTypes(rule, ['concept', 'concept']);
    expect(typed.moduleTypes).toEqual(['concept']);
    expect(setTypes(typed, [])).toEqual(rule);
    const out = exclude(exclude(rule, 'crush'), 'crush');
    expect(out.exclude).toEqual(['crush']);
    expect(include(out, 'crush').exclude).toEqual([]);
    const front = addMatter(rule, 'front', 'intro');
    expect(addMatter(front, 'back', 'intro')).toBe(front);
    expect(originOf(front, 'intro')).toBe('front');
    expect(originOf(front, 'crush')).toBe('gathered');
    expect(removeMatter(front, 'front', 'intro').front).toEqual([]);
  });

  it('tells which rows a variant has, versions compared as versions', () => {
    const when = {
      op: 'cmp' as const,
      attr: 'software',
      cmp: '>=' as const,
      value: '2.10',
    };
    expect(inVariant({ when }, { software: '2.9' }, CONFIG)).toBe(false);
    expect(inVariant({ when }, { software: '2.10.0' }, CONFIG)).toBe(true);
    expect(inVariant({}, { software: '1' }, CONFIG)).toBe(true);
    const listed = { op: 'in' as const, attr: 'software', values: ['2.3'] };
    expect(inVariant({ when: listed }, { software: '2.3.0' }, CONFIG)).toBe(
      true,
    );
  });

  it('keeps the issues about the rule, blocking ones first', () => {
    const issues = ruleIssues([
      {
        severity: 'warning',
        code: 'safety-module-excluded',
        message: '',
        at: 'x',
      },
      { severity: 'error', code: 'unknown-audience', message: '' },
      { severity: 'error', code: 'derived-source', message: '' },
    ]);
    expect(issues.map((i) => i.code)).toEqual([
      'derived-source',
      'safety-module-excluded',
    ]);
  });

  describe('notice gathering (#676)', () => {
    it('switches between whole modules and notices, leaving no notices member for modules', () => {
      const rule = newRule('op', ['concept']);
      expect(gatheringOf(rule)).toBe('modules');
      expect(setGathering(rule, 'modules')).toBe(rule);
      const notices = setGathering(rule, 'notices');
      expect(notices).toEqual({ ...rule, notices: { groupBy: 'module' } });
      expect(gatheringOf(notices)).toBe('notices');
      expect(setGathering(notices, 'notices')).toBe(notices);
      const back = setGathering(notices, 'modules');
      expect(back).toEqual(rule);
      expect('notices' in back).toBe(false);
    });

    it('groups by level, and changes nothing of a rule gathering whole modules', () => {
      const rule = newRule('op');
      expect(setGrouping(rule, 'level')).toBe(rule);
      const notices = setGathering(rule, 'notices');
      expect(setGrouping(notices, 'level').notices).toEqual({
        groupBy: 'level',
      });
      expect(setGrouping(notices, 'module')).toBe(notices);
    });

    it('names the levels only when they are not every level, most severe first', () => {
      const notices = setGathering(newRule('op'), 'notices');
      const two = setLevels(notices, ['warning', 'danger', 'warning']);
      expect(two.notices).toEqual({
        groupBy: 'module',
        levels: ['warning', 'danger'],
      });
      expect(setLevels(two, [])).toBe(two);
      const every = setLevels(two, ['danger', 'warning', 'caution', 'notice']);
      expect(every.notices).toEqual({ groupBy: 'module' });
      expect('levels' in (every.notices ?? {})).toBe(false);
      const reordered = setLevels(two, [
        'notice',
        'danger',
        'warning',
        'caution',
      ]);
      expect(reordered.notices?.levels).toEqual([
        'notice',
        'danger',
        'warning',
        'caution',
      ]);
      expect(setLevels(newRule('op'), ['danger'])).toEqual(newRule('op'));
    });

    it('lists every level, the gathered ones first in their order', () => {
      expect(levelRows({})).toEqual([
        { id: 'danger', gathered: true },
        { id: 'warning', gathered: true },
        { id: 'caution', gathered: true },
        { id: 'notice', gathered: true },
      ]);
      const rows = levelRows({ levels: ['caution', 'danger'] });
      expect(rows).toEqual([
        { id: 'caution', gathered: true },
        { id: 'danger', gathered: true },
        { id: 'warning', gathered: false },
        { id: 'notice', gathered: false },
      ]);
      expect(gatheredLevels(rows)).toEqual(['caution', 'danger']);
    });
  });
});
