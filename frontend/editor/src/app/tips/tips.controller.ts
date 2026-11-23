import {
  DestroyRef,
  DOCUMENT,
  effect,
  inject,
  Injectable,
  untracked,
  signal,
} from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import {
  pageBusy,
  type TipAction,
  type TipContent,
  TipOverlay,
  type TipRef,
} from '@openfolia/ui/tip';

import { HelpService } from '../help/help.service';
import { MeService } from '../permissions/me';
import { paletteShortcutLabel } from '../search/search-palette.service';
import { ChangeSetSession } from '../session/change-set-session';
import { PreferencesService } from './preferences.service';
import { nextTip, tourDue, tourSteps } from './tip-rules';
import {
  type Tip,
  TIPS,
  TOUR_ARTICLE,
  TOUR_STEPS,
  type TourStep,
} from './tips';

/** How long a screen settles before a tip or the tour is offered on it. */
export const SETTLE_MS = 1200;
/** How long to wait again while the page is busy (a dialog, a menu, someone typing). */
export const RETRY_MS = 1000;
/** How often to wait before giving up until the next screen. */
export const MAX_TRIES = 30;

/** The first element with `data-tip="<anchor>"` that can be seen, in the window. */
export function anchorElement(
  doc: Document,
  anchor: string,
): HTMLElement | null {
  for (const element of Array.from(
    doc.querySelectorAll<HTMLElement>(`[data-tip="${CSS.escape(anchor)}"]`),
  )) {
    if (element.closest('[inert], [hidden], [aria-hidden="true"]')) continue;
    if (
      typeof element.checkVisibility === 'function' &&
      !element.checkVisibility({
        visibilityProperty: true,
        opacityProperty: true,
      })
    )
      continue;
    // Scrolled out of the window (an element with no box at all is left to `checkVisibility`).
    const rect = element.getBoundingClientRect();
    const view = doc.defaultView;
    if (
      view &&
      rect.height > 0 &&
      (rect.bottom <= 0 || rect.top >= view.innerHeight)
    )
      continue;
    return element;
  }
  return null;
}

type Open =
  | { readonly kind: 'tip'; readonly tip: Tip; readonly ref: TipRef }
  | {
      readonly kind: 'tour';
      readonly steps: readonly TourStep[];
      index: number;
      readonly ref: TipRef;
    };

/**
 * Offers the tips and the first-run tour (#222), for the shell that provides it:
 *
 * - after each screen has settled (`SETTLE_MS`), and again when the preferences change;
 * - the tour first, while it is due, then at most one tip per visit of a screen (`nextTip`);
 * - only while the page is free (`pageBusy`: no dialog, menu or palette open, the focus in no
 *   field); while it is not, it waits and looks again (`RETRY_MS`, up to `MAX_TRIES`);
 * - a dialog, a menu or the palette opening, or the focus going into a field, closes an open tip
 *   or the tour without counting it as seen; it is offered again on another screen;
 * - a tip counts as seen (dismissed for good) once the person chose "Got it" or "Turn off tips",
 *   pressed Escape, or went to another screen; the tour once finished or skipped (Escape skips).
 */
@Injectable()
export class TipsController {
  private readonly preferences = inject(PreferencesService);
  private readonly help = inject(HelpService);
  private readonly me = inject(MeService).me;
  private readonly changeSets = inject(ChangeSetSession);
  private readonly overlay = inject(TipOverlay);
  private readonly doc = inject(DOCUMENT);

  private open: Open | null = null;
  private shownOnScreen = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tries = 0;
  private readonly visit = signal(0);

  constructor() {
    inject(Router)
      .events.pipe(
        filter((e) => e instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.navigated());

    effect(() => {
      this.visit();
      const ready = this.preferences.ready();
      const show = this.preferences.showTips();
      this.preferences.tourDone();
      this.me();
      untracked(() => {
        if (!show) this.closeOpen();
        if (ready) this.schedule();
      });
    });

    const onFocus = (event: FocusEvent) => this.focusMoved(event);
    this.doc.addEventListener('focusin', onFocus, true);
    inject(DestroyRef).onDestroy(() => {
      this.doc.removeEventListener('focusin', onFocus, true);
      clearTimeout(this.timer);
      this.open?.ref.close();
      this.open = null;
    });
  }

  /** "Show tips" in the account menu. */
  setShowTips(show: boolean): void {
    this.preferences.setShowTips(show);
    if (!show) this.closeOpen();
  }

  /** "Take the tour" in the account menu's help. */
  restartTour(): void {
    this.closeOpen();
    this.preferences.restartTour();
    this.schedule(0);
  }

  /** "Reset tips" in the account menu's help: every tip shows again. */
  resetTips(): void {
    this.preferences.resetTips();
    this.shownOnScreen = false;
    this.schedule();
  }

  private navigated(): void {
    // Leaving a screen with its tip open: seen.
    if (this.open?.kind === 'tip') {
      this.preferences.dismiss(this.open.tip.id);
      this.closeOpen();
    }
    this.shownOnScreen = false;
    this.visit.update((n) => n + 1);
  }

  private schedule(delay = SETTLE_MS): void {
    clearTimeout(this.timer);
    this.tries = 0;
    this.timer = setTimeout(() => this.evaluate(), delay);
  }

  private evaluate(): void {
    if (this.open) return;
    if (!this.preferences.ready() || this.me().kind !== 'user') return;
    if (!this.preferences.showTips()) return;
    if (this.doc.hidden || pageBusy(this.doc)) {
      if (++this.tries < MAX_TRIES) {
        this.timer = setTimeout(() => this.evaluate(), RETRY_MS);
      }
      return;
    }
    const prefs = this.preferences.preferences();
    if (tourDue(prefs)) {
      this.startTour();
      return;
    }
    const tip = nextTip(TIPS, {
      showTips: prefs.showTips,
      tourDone: prefs.tourDone,
      dismissed: this.preferences.dismissed(),
      screen: this.help.screenArticle(),
      permissions: this.me().permissions,
      hasChangeSet: this.changeSets
        .options()
        .some((option) => option.authorId === this.me().id),
      shownOnScreen: this.shownOnScreen,
      anchored: (anchor) => anchorElement(this.doc, anchor) !== null,
    });
    if (tip) this.showTip(tip);
  }

  private showTip(tip: Tip): void {
    const anchor = anchorElement(this.doc, tip.anchor);
    if (!anchor) return;
    this.shownOnScreen = true;
    const ref = this.overlay.open({
      anchor,
      content: {
        id: tip.id,
        title: tip.title,
        body: tip.body,
        learnMore: tip.article ? this.help.link(tip.article) : null,
      },
      onAction: (action) => this.tipAction(tip, action),
      onDismiss: (reason) => {
        this.open = null;
        if (reason === 'escape') this.preferences.dismiss(tip.id);
      },
    });
    this.open = { kind: 'tip', tip, ref };
  }

  private tipAction(tip: Tip, action: TipAction): void {
    this.preferences.dismiss(tip.id);
    if (action === 'turn-off') this.preferences.setShowTips(false);
    this.closeOpen();
  }

  private startTour(): void {
    const steps = tourSteps(
      TOUR_STEPS,
      (anchor) => anchorElement(this.doc, anchor) !== null,
    );
    this.shownOnScreen = true;
    const first = steps[0];
    if (!first) {
      this.preferences.finishTour();
      return;
    }
    const ref = this.overlay.open({
      anchor: this.stepAnchor(first),
      content: this.stepContent(steps, 0),
      onAction: (action) => this.tourAction(action),
      onDismiss: (reason) => {
        this.open = null;
        // Escape skips; an anchor gone out of view only pauses it.
        if (reason === 'escape') this.preferences.finishTour();
      },
    });
    this.open = { kind: 'tour', steps, index: 0, ref };
  }

  private tourAction(action: TipAction): void {
    const open = this.open;
    if (open?.kind !== 'tour') return;
    const index =
      action === 'next'
        ? open.index + 1
        : action === 'back'
          ? open.index - 1
          : open.steps.length;
    if (index < 0) return;
    const step = open.steps[index];
    if (!step) {
      this.preferences.finishTour();
      this.closeOpen();
      return;
    }
    open.index = index;
    open.ref.update(this.stepAnchor(step), this.stepContent(open.steps, index));
  }

  private stepAnchor(step: TourStep): HTMLElement | null {
    return step.anchor === null ? null : anchorElement(this.doc, step.anchor);
  }

  private stepContent(steps: readonly TourStep[], index: number): TipContent {
    const step = steps[index]!;
    const last = index === steps.length - 1;
    return {
      id: step.id,
      title: step.title,
      body: step.body,
      params: { keys: paletteShortcutLabel() },
      step: { index: index + 1, total: steps.length },
      learnMore: last ? this.help.link(TOUR_ARTICLE) : null,
    };
  }

  /**
   * The page took over: the focus went into a field, a dialog or a menu outside the tip. The tip
   * or tour goes, not counted as seen.
   */
  private focusMoved(event: FocusEvent): void {
    const open = this.open;
    if (!open) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (open.ref.element?.contains(target)) return;
    const takenOver =
      target.closest('.cdk-overlay-container, [aria-modal="true"], dialog') !==
        null || pageBusy(this.doc);
    if (takenOver) this.closeOpen();
  }

  private closeOpen(): void {
    const open = this.open;
    this.open = null;
    open?.ref.close();
  }
}
