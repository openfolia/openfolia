import guideIndex from '../../../generated/guide-index.json';
import {
  conditionHolds,
  nextTip,
  type TipContext,
  tourDue,
  tourSteps,
} from './tip-rules';
import { TIPS, TOUR_STEPS, type Tip } from './tips';

const tips: readonly Tip[] = [
  {
    id: 'a',
    anchor: 'a',
    screen: 'guide.writing.content-browser',
    title: 't',
    body: 'b',
    condition: { permission: 'content.edit' },
  },
  {
    id: 'b',
    anchor: 'b',
    screen: 'guide.writing.content-browser',
    title: 't',
    body: 'b',
  },
  {
    id: 'c',
    anchor: 'c',
    screen: '*',
    title: 't',
    body: 'b',
    condition: 'after-first-change-set',
  },
];

const context = (overrides: Partial<TipContext> = {}): TipContext => ({
  showTips: true,
  tourDone: true,
  dismissed: new Set(),
  screen: 'guide.writing.content-browser',
  permissions: new Set(['content.read', 'content.edit']),
  hasChangeSet: true,
  shownOnScreen: false,
  anchored: () => true,
  ...overrides,
});

describe('nextTip', () => {
  it('offers the first tip that applies, in catalogue order', () => {
    expect(nextTip(tips, context())?.id).toBe('a');
  });

  it('never offers a dismissed tip', () => {
    expect(nextTip(tips, context({ dismissed: new Set(['a']) }))?.id).toBe('b');
    expect(
      nextTip(tips, context({ dismissed: new Set(['a', 'b', 'c']) })),
    ).toBeNull();
  });

  it('offers nothing while tips are off, or before the tour is done', () => {
    expect(nextTip(tips, context({ showTips: false }))).toBeNull();
    expect(nextTip(tips, context({ tourDone: false }))).toBeNull();
  });

  it('offers at most one per visit of a screen', () => {
    expect(nextTip(tips, context({ shownOnScreen: true }))).toBeNull();
  });

  it('offers a tip only on its screen, or on any for "*"', () => {
    expect(nextTip(tips, context({ screen: 'guide.review.list' }))?.id).toBe(
      'c',
    );
    expect(nextTip(tips, context({ screen: null }))?.id).toBe('c');
  });

  it('skips a tip whose condition fails or whose anchor is not there', () => {
    expect(
      nextTip(tips, context({ permissions: new Set(['content.read']) }))?.id,
    ).toBe('b');
    expect(
      nextTip(
        tips,
        context({ screen: 'guide.review.list', hasChangeSet: false }),
      ),
    ).toBeNull();
    expect(nextTip(tips, context({ anchored: (a) => a === 'c' }))?.id).toBe(
      'c',
    );
  });
});

describe('conditionHolds', () => {
  it('reads a permission or the first change set', () => {
    const who = {
      permissions: new Set(['content.review']),
      hasChangeSet: false,
    };
    expect(conditionHolds(undefined, who)).toBe(true);
    expect(conditionHolds({ permission: 'content.review' }, who)).toBe(true);
    expect(conditionHolds({ permission: 'content.edit' }, who)).toBe(false);
    expect(conditionHolds('after-first-change-set', who)).toBe(false);
  });
});

describe('the tour', () => {
  it('is due while tips are on and it is neither finished nor skipped', () => {
    expect(tourDue({ showTips: true, tourDone: false })).toBe(true);
    expect(tourDue({ showTips: true, tourDone: true })).toBe(false);
    expect(tourDue({ showTips: false, tourDone: false })).toBe(false);
  });

  it('leaves out the steps whose anchor is missing, keeps the centred ones', () => {
    const steps = tourSteps(TOUR_STEPS, (anchor) => anchor !== 'nav.review');
    expect(steps.map((s) => s.id)).toEqual([
      'tour.content',
      'tour.editor',
      'tour.change-sets',
      'tour.search',
    ]);
    expect(tourSteps(TOUR_STEPS, () => false).map((s) => s.id)).toEqual([
      'tour.editor',
    ]);
  });

  it('has four to six steps over the shell', () => {
    expect(TOUR_STEPS.length).toBeGreaterThanOrEqual(4);
    expect(TOUR_STEPS.length).toBeLessThanOrEqual(6);
  });
});

describe('the catalogue', () => {
  it('names each tip once, by a stable ID the API keeps', () => {
    const ids = TIPS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
  });

  it('points at screens and guide pages the guide has', () => {
    const articles = new Set(guideIndex.articles.map((a) => a.id));
    for (const tip of TIPS) {
      if (tip.screen !== '*') expect(articles, tip.id).toContain(tip.screen);
      if (tip.article) expect(articles, tip.id).toContain(tip.article);
    }
  });
});
