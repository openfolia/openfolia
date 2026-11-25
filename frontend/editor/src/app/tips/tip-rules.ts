import {
  ANY_SCREEN,
  READER_TOUR,
  type Tip,
  type TipCondition,
  type TourStep,
  WRITE_PERMISSION,
  WRITER_TOUR,
} from './tips';

/** What the scheduling rules read: the person's preferences and where they are. */
export interface TipContext {
  /** "Show tips" is on. */
  readonly showTips: boolean;
  readonly tourDone: boolean;
  readonly dismissed: ReadonlySet<string>;
  /** The active screen's guide article ID (`data.help`), or null. */
  readonly screen: string | null;
  /** The permissions the person holds anywhere. */
  readonly permissions: ReadonlySet<string>;
  /** The person has a change set of their own. */
  readonly hasChangeSet: boolean;
  /** A tip was shown already since the person came to this screen. */
  readonly shownOnScreen: boolean;
  /** Whether an element with this `data-tip` is on the page and can be seen. */
  readonly anchored: (anchor: string) => boolean;
}

/** Whether a tip's condition holds for the person. */
export function conditionHolds(
  condition: TipCondition | undefined,
  context: Pick<TipContext, 'permissions' | 'hasChangeSet'>,
): boolean {
  if (condition === undefined) return true;
  if (condition === 'after-first-change-set') return context.hasChangeSet;
  return context.permissions.has(condition.permission);
}

/**
 * Whether the first-run tour starts: the person has neither finished nor ended it, and tips are
 * on or they asked for it ("Take the tour", `requested`). It comes before any tip.
 */
export function tourDue(
  context: Pick<TipContext, 'showTips' | 'tourDone'> & {
    readonly requested?: boolean;
  },
): boolean {
  return !context.tourDone && (context.showTips || !!context.requested);
}

/**
 * The tip to show now, or null (#222):
 *
 * - none while tips are off or the tour is still to come (it goes first);
 * - at most one per visit of a screen: after one, the next waits for another screen;
 * - never one the person dismissed;
 * - only on its screen (or any, for `*`), when its condition holds and its anchor can be seen;
 * - the first in catalogue order that passes.
 *
 * Whether the page is free for it (no dialog, menu or palette open, nobody typing) the caller
 * checks when it is about to show it (`pageBusy`).
 */
export function nextTip(tips: readonly Tip[], context: TipContext): Tip | null {
  if (!context.showTips || !context.tourDone || context.shownOnScreen) {
    return null;
  }
  for (const tip of tips) {
    if (context.dismissed.has(tip.id)) continue;
    if (tip.screen !== ANY_SCREEN && tip.screen !== context.screen) continue;
    if (!conditionHolds(tip.condition, context)) continue;
    if (!context.anchored(tip.anchor)) continue;
    return tip;
  }
  return null;
}

/**
 * Whether a tip of this very screen applies but for its anchor, which is not there (yet): a block
 * in a document still coming in, a configuration still loading. The caller gives it a moment
 * before offering a tip of any screen in its place, so the order of the catalogue holds however
 * quickly the page fills in (#892).
 */
export function screenTipPending(
  tips: readonly Tip[],
  context: TipContext,
): boolean {
  if (!context.showTips || !context.tourDone || context.shownOnScreen)
    return false;
  return tips.some(
    (tip) =>
      tip.screen !== ANY_SCREEN &&
      tip.screen === context.screen &&
      !context.dismissed.has(tip.id) &&
      conditionHolds(tip.condition, context) &&
      !context.anchored(tip.anchor),
  );
}

/**
 * The tour for the person (#869): the writer's, ending in a first edit, for one who may change
 * content; else the reader's. A step whose anchor is in the shell and not theirs (`present`: on
 * the page, though perhaps in the closed sidebar of a narrow screen) is left out.
 */
export function tourFor(
  permissions: ReadonlySet<string>,
  present: (anchor: string) => boolean,
): readonly TourStep[] {
  const steps = permissions.has(WRITE_PERMISSION) ? WRITER_TOUR : READER_TOUR;
  return steps.filter(
    (step) => !step.shell || step.anchor === null || present(step.anchor),
  );
}

/**
 * Where a paused tour picks up on the screen the person is on (#869), or null to wait for another:
 *
 * - the step it was at, when that step can be shown here (centred, or its anchor on the page);
 * - else the nearest step before it that can, so a person who left the module before typing is
 *   asked to open one again; never the welcome step again once it is past.
 */
export function resumeAt(
  steps: readonly TourStep[],
  index: number,
  present: (anchor: string) => boolean,
): number | null {
  const at = steps[index];
  if (!at) return null;
  if (at.anchor === null) return index;
  for (let i = index; i >= 1; i--) {
    const anchor = steps[i]!.anchor;
    if (anchor !== null && present(anchor)) return i;
  }
  return null;
}
