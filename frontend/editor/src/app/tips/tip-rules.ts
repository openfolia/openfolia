import { ANY_SCREEN, type Tip, type TipCondition, type TourStep } from './tips';

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
 * Whether the first-run tour starts: tips are on and the person has neither finished nor skipped
 * it. It comes before any tip.
 */
export function tourDue(
  context: Pick<TipContext, 'showTips' | 'tourDone'>,
): boolean {
  return context.showTips && !context.tourDone;
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

/** The tour's steps the person can follow: those without an anchor, and those whose anchor shows. */
export function tourSteps(
  steps: readonly TourStep[],
  anchored: (anchor: string) => boolean,
): readonly TourStep[] {
  return steps.filter((step) => step.anchor === null || anchored(step.anchor));
}
