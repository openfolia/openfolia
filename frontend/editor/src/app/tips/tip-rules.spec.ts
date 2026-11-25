import guideIndex from '../../../generated/guide-index.json';
import {
  conditionHolds,
  nextTip,
  type TipContext,
  resumeAt,
  screenTipPending,
  tourDue,
  tourFor,
} from './tip-rules';
import { READER_TOUR, TIPS, type Tip, WRITER_TOUR } from './tips';

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

  it('is due with tips off once the person asked for it, until it is done (#868)', () => {
    expect(tourDue({ showTips: false, tourDone: false, requested: true })).toBe(
      true,
    );
    expect(tourDue({ showTips: false, tourDone: true, requested: true })).toBe(
      false,
    );
  });

  it('is the writer’s for a person who may change content, else the reader’s (#869)', () => {
    const all = () => true;
    expect(tourFor(new Set(['content.edit']), all).map((s) => s.id)).toEqual([
      'tour.welcome',
      'tour.open-module',
      'tour.edit',
      'tour.revision',
      'tour.review',
    ]);
    expect(tourFor(new Set(['content.read']), all).map((s) => s.id)).toEqual([
      'tour.welcome',
      'tour.open-module',
      'tour.revision',
      'tour.manuals',
    ]);
  });

  it('goes without the revision picker’s step for someone who has no picker: a contributor, a reader of the released content only (#869)', () => {
    const noPicker = (anchor: string) => anchor !== 'shell.revision';
    expect(
      tourFor(new Set(['content.edit']), noPicker).map((s) => s.id),
    ).toEqual(['tour.welcome', 'tour.open-module', 'tour.edit', 'tour.review']);
    expect(
      tourFor(new Set(['content.read']), noPicker).map((s) => s.id),
    ).toEqual(['tour.welcome', 'tour.open-module', 'tour.manuals']);
  });

  it('leaves out a step about the shell the person has not got, never a task (#869)', () => {
    const steps = tourFor(
      new Set(['content.edit']),
      (anchor) => anchor === 'nav.content',
    );
    expect(steps.map((s) => s.id)).toEqual([
      'tour.welcome',
      'tour.open-module',
      'tour.edit',
    ]);
  });

  it('resumes at the step it was at, or the nearest before it this screen shows; never the welcome again (#869)', () => {
    const on =
      (...anchors: string[]) =>
      (anchor: string) =>
        anchors.includes(anchor);
    // On the module editor: the step it was at.
    expect(
      resumeAt(WRITER_TOUR, 2, on('module-editor.text', 'nav.review')),
    ).toBe(2);
    // Back on the list before typing: open a module again.
    expect(resumeAt(WRITER_TOUR, 2, on('content.module', 'nav.review'))).toBe(
      1,
    );
    // Elsewhere: wait.
    expect(resumeAt(WRITER_TOUR, 2, on('nav.review'))).toBeNull();
    expect(resumeAt(WRITER_TOUR, 1, on())).toBeNull();
    // The welcome is centred: shown anywhere, while it is the step.
    expect(resumeAt(WRITER_TOUR, 0, on())).toBe(0);
    // Review is in the shell: on every screen.
    expect(resumeAt(WRITER_TOUR, 4, on('nav.review'))).toBe(4);
    expect(resumeAt(READER_TOUR, 3, on('nav.manuals'))).toBe(3);
    // The revision picker is in the top bar: on every screen too.
    expect(resumeAt(WRITER_TOUR, 3, on('shell.revision'))).toBe(3);
    expect(resumeAt(WRITER_TOUR, 9, on())).toBeNull();
  });
});

describe('the tour’s steps (#869)', () => {
  it('end the writer’s tour on Review and the reader’s on the manuals, with a guide page', () => {
    const articles = new Set(guideIndex.articles.map((a) => a.id));
    for (const steps of [WRITER_TOUR, READER_TOUR]) {
      expect(steps.length).toBeGreaterThanOrEqual(3);
      expect(steps.length).toBeLessThanOrEqual(5);
      const last = steps.at(-1)!;
      expect(last.task).toBeUndefined();
      expect(articles).toContain(last.article);
      for (const step of steps) {
        if (step.doneOn) expect(articles, step.id).toContain(step.doneOn);
      }
    }
    expect(WRITER_TOUR.at(-1)!.anchor).toBe('nav.review');
    expect(READER_TOUR.at(-1)!.anchor).toBe('nav.manuals');
  });
});

describe('the variant tip (#892)', () => {
  const variant = TIPS.find((t) => t.id === 'module-editor.variant')!;
  const here = context({ screen: 'guide.writing.edit-a-module' });
  const only = (c: TipContext) => nextTip([variant], c)?.id ?? null;

  it('shows in the module editor, once its block is on screen, to a person who may edit', () => {
    expect(only(here)).toBe('module-editor.variant');
    expect(only({ ...here, anchored: () => false })).toBeNull();
    expect(
      only({ ...here, screen: 'guide.writing.content-browser' }),
    ).toBeNull();
  });

  it('is not for a reader, nor during the tour, nor once dismissed or with tips off', () => {
    expect(
      only({ ...here, permissions: new Set(['content.read']) }),
    ).toBeNull();
    expect(only({ ...here, tourDone: false })).toBeNull();
    expect(only({ ...here, dismissed: new Set([variant.id]) })).toBeNull();
    expect(only({ ...here, showTips: false })).toBeNull();
  });
});

describe('screenTipPending', () => {
  const none = (a: string) => a === 'c';

  it('waits while a tip of this screen lacks only its anchor', () => {
    expect(screenTipPending(tips, context({ anchored: none }))).toBe(true);
  });

  it('does not wait for a tip that is dismissed, not allowed, of another screen, or anchored', () => {
    const base = { anchored: none };
    expect(
      screenTipPending(tips, context({ ...base, anchored: () => true })),
    ).toBe(false);
    expect(
      screenTipPending(
        tips,
        context({ ...base, dismissed: new Set(['a', 'b']) }),
      ),
    ).toBe(false);
    expect(
      screenTipPending(
        tips,
        context({
          ...base,
          permissions: new Set(['content.read']),
          dismissed: new Set(['b']),
        }),
      ),
    ).toBe(false);
    expect(
      screenTipPending(tips, context({ ...base, screen: 'guide.review.list' })),
    ).toBe(false);
    expect(screenTipPending(tips, context({ ...base, showTips: false }))).toBe(
      false,
    );
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
