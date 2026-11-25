import {
  computed,
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

import { translated } from '@openfolia/ui/i18n';
import {
  pageBusy,
  type TipAction,
  type TipContent,
  TipOverlay,
  type TipRef,
} from '@openfolia/ui/tip';
import { ToastService } from '@openfolia/ui/toast';

import { helpArticleOf, HelpService } from '../help/help.service';
import { MeService } from '../permissions/me';
import { paletteShortcutLabel } from '../search/search-palette.service';
import { ChangeSetSession } from '../session/change-set-session';
import { readStored, writeStored } from '../session/stored';
import { PreferencesService } from './preferences.service';
import {
  nextTip,
  resumeAt,
  screenTipPending,
  tourDue,
  tourFor,
} from './tip-rules';
import { ANY_SCREEN, type Tip, TIPS, TOUR_EDIT, type TourStep } from './tips';

/** How many times to look again for the anchor of a tip of the screen before another goes first. */
export const PENDING_TRIES = 6;
/** How long a screen settles before a tip or the tour is offered on it. */
export const SETTLE_MS = 1200;
/** How long to wait again while the page is busy (a dialog, a menu, someone typing). */
export const RETRY_MS = 1000;
/** How often to wait before giving up until the next screen. */
export const MAX_TRIES = 30;
/** How long the window keeps still after a resize before the tour's card is placed again. */
export const RESIZE_SETTLE_MS = 150;
/**
 * The menu button that opens the sidebar on a narrow screen: where a tour step whose anchor is
 * in the closed sidebar points instead.
 */
export const MENU_ANCHOR = 'shell.menu';

/** Marks the skeleton of a screen's main content while it loads: tips wait for the real thing. */
const LOADING = '[data-tip-loading]';

/** The blocks of a text a person types in: what a card keeps clear of while they edit. */
const BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th';

/** The elements with `data-tip="<anchor>"`. */
const anchorsOf = (doc: Document, anchor: string) =>
  Array.from(
    doc.querySelectorAll<HTMLElement>(`[data-tip="${CSS.escape(anchor)}"]`),
  );

/** The first element with `data-tip="<anchor>"` that can be seen, in the window. */
export function anchorElement(
  doc: Document,
  anchor: string,
): HTMLElement | null {
  for (const element of anchorsOf(doc, anchor)) {
    if (element.closest('[inert], [hidden], [aria-hidden="true"]')) continue;
    if (
      typeof element.checkVisibility === 'function' &&
      !element.checkVisibility({
        visibilityProperty: true,
        opacityProperty: true,
      })
    )
      continue;
    if (!inWindow(doc, element)) continue;
    return element;
  }
  return null;
}

/** Not scrolled out of the window (an element with no box at all counts as in it). */
function inWindow(doc: Document, element: Element): boolean {
  const rect = element.getBoundingClientRect();
  const view = doc.defaultView;
  return !(
    view &&
    rect.height > 0 &&
    (rect.bottom <= 0 || rect.top >= view.innerHeight)
  );
}

/**
 * Whether the person has the element with `data-tip="<anchor>"` at all, seen or not: rendered and
 * not hidden, though perhaps in the closed sidebar of a narrow screen (inert) or scrolled away.
 */
export function anchorPresent(doc: Document, anchor: string): boolean {
  return anchorsOf(doc, anchor).some((element) => !element.closest('[hidden]'));
}

/**
 * Where a tour step points: its anchor where it can be seen; for an anchor in the closed sidebar
 * of a narrow screen, the menu button that opens it; otherwise nowhere (the card centres).
 */
export function stepAnchorElement(
  doc: Document,
  anchor: string | null,
): HTMLElement | null {
  if (anchor === null) return null;
  const seen = anchorElement(doc, anchor);
  if (seen) return seen;
  const inSidebar = anchorsOf(doc, anchor).some(
    (element) => element.closest('[data-sidebar="sidebar"]') !== null,
  );
  return inSidebar ? anchorElement(doc, MENU_ANCHOR) : null;
}

type Open =
  | { readonly kind: 'tip'; readonly tip: Tip; readonly ref: TipRef }
  | { readonly kind: 'tour'; readonly ref: TipRef };

/** The tour under way: its steps and the one the person is at, shown or paused. */
interface Tour {
  steps: readonly TourStep[];
  index: number;
}

/** The step a person's tour is at, kept for this tab: a reload picks up there (#869). */
const tourKey = (person: string) => `openfolia.tour:${person}`;
/**
 * The revision the person's last tour typed into, kept in this browser: a tour taken again (a
 * demo given twice) goes on in it rather than starting another.
 */
const keptRevisionKey = (person: string) => `openfolia.tour-kept:${person}`;
/** Set once the tour started a revision for the person: it starts one per tour, not per module. */
const revisionKey = (person: string) => `openfolia.tour-revision:${person}`;

/**
 * Offers the tips and the first-run tour (#222, #869), for the shell that provides it:
 *
 * - after each screen has settled (`SETTLE_MS`), and again when the preferences change;
 * - the tour first, while it is due, then at most one tip per visit of a screen (`nextTip`);
 * - only while the page is free (`pageBusy`: no dialog, menu or palette open, the focus in no
 *   field but the one a tour step asks the person to type in); while it is not, it waits and looks
 *   again (`RETRY_MS`, up to `MAX_TRIES`);
 * - a dialog, a menu or the palette opening, or the focus going into a field, closes an open tip
 *   without counting it as seen; it is offered again on another screen;
 * - a tip counts as seen (dismissed for good) once the person chose "Got it" or "Turn off tips",
 *   pressed Escape, or went to another screen;
 * - the tour is task-led (#869): the writer's or the reader's (`tourFor`). A task step moves on
 *   when the person does what it asks: opening a module (arriving on its `doneOn` screen) or
 *   typing in it (`stepDone`, from the page). Its main button does the task for them.
 * - leaving the tour's path pauses it: another screen, a click outside the card and the step's
 *   anchor, a dialog, a menu or the palette, the focus in another field. It comes back at the same
 *   step once the page is free (`resumeAt`: the step before, when this screen cannot show it),
 *   also after a reload of the tab; never at the welcome again. It ends for good (`tourDone`) on
 *   its last step's Done, "Not now", × or Escape anywhere;
 * - a step whose anchor is in the closed sidebar of a narrow screen points at the menu button, and
 *   after a resize each step is placed again (`RESIZE_SETTLE_MS`), so no card is left on a hidden
 *   anchor;
 * - "Take the tour" starts it from its first step whether tips are on or not, and leaves "Show
 *   tips" as it is.
 */
@Injectable()
export class TipsController {
  private readonly preferences = inject(PreferencesService);
  private readonly help = inject(HelpService);
  private readonly me = inject(MeService).me;
  private readonly changeSets = inject(ChangeSetSession);
  private readonly overlay = inject(TipOverlay);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);
  private readonly doc = inject(DOCUMENT);

  private open: Open | null = null;
  private tour: Tour | null = null;
  /** The tour started a revision (kept in memory too, for a tab without storage). */
  private revisionClaimed = false;
  private shownOnScreen = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tries = 0;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  /** The path of the screen on show: a change of the query alone is no new screen. */
  private path: string | null = null;
  /**
   * The address a step moved on at while its anchor was late, on its own screen with a query
   * (issue 903): only that query may be dropped for the step, never one the person typed since.
   */
  private waitedAt: string | null = null;
  /** "Take the tour" was chosen: the tour runs even with tips off. */
  private readonly tourRequested = signal(false);
  private readonly atStep = signal<string | null>(null);
  private readonly visit = signal(0);

  /**
   * The step the person's tour is at, shown or paused, while the tour is due; else null. The module
   * editor reads it to start a revision for the person at the "Change a sentence" step (#869).
   */
  readonly tourStep = computed(() =>
    this.preferences.ready() &&
    tourDue({
      ...this.preferences.preferences(),
      requested: this.tourRequested(),
    })
      ? this.atStep()
      : null,
  );

  constructor() {
    this.router.events
      .pipe(
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
        if (!show && this.open?.kind === 'tip') this.closeOpen();
        if (ready) this.schedule();
      });
    });

    const onFocus = (event: FocusEvent) => this.focusMoved(event);
    const onPointer = (event: PointerEvent) => this.pointerDown(event);
    const onKey = (event: KeyboardEvent) => this.keyDown(event);
    const onResize = () => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.repoint(), RESIZE_SETTLE_MS);
    };
    const view = this.doc.defaultView;
    this.doc.addEventListener('focusin', onFocus, true);
    this.doc.addEventListener('pointerdown', onPointer, true);
    this.doc.addEventListener('keydown', onKey);
    view?.addEventListener('resize', onResize, { passive: true });
    inject(DestroyRef).onDestroy(() => {
      this.doc.removeEventListener('focusin', onFocus, true);
      this.doc.removeEventListener('pointerdown', onPointer, true);
      this.doc.removeEventListener('keydown', onKey);
      view?.removeEventListener('resize', onResize);
      clearTimeout(this.timer);
      clearTimeout(this.resizeTimer);
      this.open?.ref.close();
      this.open = null;
    });
  }

  /** "Show tips" in the account menu. */
  setShowTips(show: boolean): void {
    // Tips off also drops a "Take the tour" still pending: nothing comes back unasked.
    if (!show) this.tourRequested.set(false);
    this.preferences.setShowTips(show);
    if (!show) this.closeOpen();
  }

  /** "Take the tour" in the account menu's help: from its first step, "Show tips" unchanged. */
  restartTour(): void {
    this.closeOpen();
    this.forgetTour();
    this.tourRequested.set(true);
    this.preferences.restartTour();
    this.schedule(0);
  }

  /**
   * A tour step's task was done (#869: the person did what the step asked): the tour moves on, if
   * that step is the one it is at, shown or paused. Anything else is ignored, so a page may call it
   * freely.
   */
  stepDone(id: string): void {
    const tour = this.tour;
    if (!tour || !this.tourStep() || tour.steps[tour.index]?.id !== id) return;
    // The change went into the revision chosen now: the tour's, for the next tour too.
    const own = id === TOUR_EDIT ? this.ownRevisionId() : null;
    if (own) writeStored(keptRevisionKey(this.me().id), own);
    this.moveTo(tour.index + 1);
  }

  /** The revision a past tour typed into, if any (the page checks it is still the person's draft). */
  tourRevision(): string | null {
    return readStored(keptRevisionKey(this.me().id));
  }

  /**
   * Whether the tour's "Change a sentence" may start a revision for the person (#869): true once
   * per tour, so a person who opens one module after another does not get one each.
   */
  claimRevision(): boolean {
    const key = revisionKey(this.me().id);
    if (this.revisionClaimed || readStored(key, 'tab') !== null) return false;
    this.revisionClaimed = true;
    writeStored(key, 'started', 'tab');
    return true;
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
    const path = this.pathNow();
    const moved = path !== this.path;
    this.path = path;
    const tour = this.tour;
    if (moved && tour) {
      // Another screen: the tour pauses, or moves on when the step asked for this one.
      if (this.open?.kind === 'tour') this.closeOpen();
      this.arrived(tour);
    }
    this.shownOnScreen = false;
    this.visit.update((n) => n + 1);
  }

  /** On the screen the step asked the person to go to: the tour moves on. */
  private arrived(tour: Tour): void {
    const step = tour.steps[tour.index];
    const screen = helpArticleOf(this.router.routerState.snapshot.root);
    if (!step?.doneOn || step.doneOn !== screen) return;
    if (tour.index + 1 < tour.steps.length) this.setIndex(tour.index + 1);
    else this.endTour(true);
  }

  private schedule(delay = SETTLE_MS): void {
    clearTimeout(this.timer);
    this.tries = 0;
    this.timer = setTimeout(() => this.evaluate(), delay);
  }

  /**
   * Looks again in a while: for a tip up to `MAX_TRIES` times since the last `schedule`; for the
   * tour as long as it waits (a screen that loads slowly never skips a step, issue 869).
   */
  private retry(): void {
    if (++this.tries < MAX_TRIES || this.tour) {
      this.timer = setTimeout(() => this.evaluate(), RETRY_MS);
    }
  }

  private evaluate(): void {
    if (this.open) return;
    if (!this.preferences.ready() || this.me().kind !== 'user') return;
    const prefs = this.preferences.preferences();
    const tour = tourDue({ ...prefs, requested: this.tourRequested() });
    if (!prefs.showTips && !tour) return;
    // Made first, so the field its typing step asks for counts as free (a reload mid-tour).
    if (tour) this.currentTour();
    if (
      this.doc.hidden ||
      pageBusy(this.doc, tour ? this.typingZone() : null)
    ) {
      this.retry();
      return;
    }
    if (tour) {
      if (!this.showTour()) this.retry();
      return;
    }
    // The screen's own content is still coming (its skeleton is up): a tip about a block in it
    // must not lose its turn to one about the shell (#892).
    if (this.doc.querySelector(LOADING)) {
      this.retry();
      return;
    }
    const context = {
      showTips: prefs.showTips,
      tourDone: prefs.tourDone,
      dismissed: this.preferences.dismissed(),
      screen: this.help.screenArticle(),
      permissions: this.me().permissions,
      hasChangeSet: this.changeSets
        .options()
        .some((option) => option.authorId === this.me().id),
      shownOnScreen: this.shownOnScreen,
      anchored: (anchor: string) => anchorElement(this.doc, anchor) !== null,
    };
    const tip = nextTip(TIPS, context);
    // A tip of this screen waits for its anchor a few seconds before a tip of any screen takes
    // its turn (#892).
    if (
      (!tip || tip.screen === ANY_SCREEN) &&
      this.tries < PENDING_TRIES &&
      screenTipPending(TIPS, context)
    ) {
      this.retry();
      return;
    }
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
        params: { keys: paletteShortcutLabel() },
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

  /** The tour under way, made for the person when it starts (at the step this tab kept). */
  private currentTour(): Tour {
    if (this.tour) return this.tour;
    const steps = tourFor(this.me().permissions, (anchor) =>
      anchorPresent(this.doc, anchor),
    );
    const kept = readStored(tourKey(this.me().id), 'tab');
    const index = Math.max(
      0,
      steps.findIndex((step) => step.id === kept),
    );
    const tour: Tour = { steps, index };
    this.tour = tour;
    this.setIndex(index);
    // A reload on the screen its step asked for (the first navigation came before the tour).
    this.arrived(tour);
    return tour;
  }

  /** Shows the tour where it is at; false when this screen cannot show it yet (wait). */
  private showTour(): boolean {
    const tour = this.currentTour();
    this.refreshSteps(tour);
    const index = resumeAt(tour.steps, tour.index, (anchor) =>
      anchorPresent(this.doc, anchor),
    );
    if (index === null) {
      this.unfiltered(tour.steps[tour.index]!);
      return false;
    }
    if (this.loading(tour.steps[index]!)) return false;
    this.setIndex(index);
    this.shownOnScreen = true;
    // Shown: the query it waited at is the person's from now on.
    this.waitedAt = null;
    const ref = this.overlay.open({
      anchor: this.stepAnchor(tour.steps[index]!),
      content: this.stepContent(index),
      spotlight: true,
      // Coming while the person types: the caret stays in the text.
      focus: !this.typing(),
      keepClear: () => this.editedBlock(),
      // The list drew its rows again (issue 903): the step points at the row there is now.
      onAnchorGone: () => this.repoint(),
      onAction: (action) => this.tourAction(action),
      onDismiss: (reason) => {
        this.open = null;
        // Escape ends it, but not one pressed in the text (the editor's own); an anchor gone out
        // of view only pauses it.
        if (reason === 'escape' && !this.typing()) this.endTour(false);
        else this.schedule();
      },
    });
    this.open = { kind: 'tour', ref };
    return true;
  }

  /**
   * The person's steps again, as the shell now has them (an anchor that came after the tour
   * started, such as the revision picker on a slow load), at the same step.
   */
  private refreshSteps(tour: Tour): void {
    const steps = tourFor(this.me().permissions, (anchor) =>
      anchorPresent(this.doc, anchor),
    );
    const index = steps.findIndex(
      (step) => step.id === tour.steps[tour.index]?.id,
    );
    if (index < 0) return;
    tour.steps = steps;
    tour.index = index;
  }

  private tourAction(action: TipAction): void {
    const tour = this.tour;
    if (!tour || this.open?.kind !== 'tour') return;
    const step = tour.steps[tour.index]!;
    if (action === 'skip') {
      this.endTour(false);
      this.closeOpen();
    } else if (action === 'next' && step.task) {
      this.assist(step);
    } else {
      this.moveTo(tour.index + (action === 'back' ? -1 : 1));
    }
  }

  /** On to step `index`: the card moves there, or the tour pauses until its screen comes. */
  private moveTo(index: number): void {
    const tour = this.tour;
    if (!tour || index < 0) return;
    const step = tour.steps[index];
    if (!step) {
      this.endTour(true);
      this.closeOpen();
      return;
    }
    this.setIndex(index);
    const open = this.open?.kind === 'tour' ? this.open : null;
    const absent =
      step.anchor !== null && !anchorPresent(this.doc, step.anchor);
    if (absent || this.loading(step)) {
      // Not on this screen: paused, and off to where the step is when it says. On that screen
      // already, its anchor is only late (a list still loading, issue 903): the step waits there,
      // and the list keeps its query.
      this.closeOpen();
      if (absent && step.route && this.pathNow() !== step.route)
        void this.router.navigateByUrl(step.route);
      this.waitedAt = this.router.url;
      this.schedule();
      return;
    }
    if (open) open.ref.update(this.stepAnchor(step), this.stepContent(index));
    else this.schedule();
  }

  /**
   * A task step's main button: does the task the step asks for, for someone who would rather not
   * reach for it (a keyboard, a screen reader): opens the lit module, or puts the caret at the end
   * of the lit sentence.
   */
  private assist(step: TourStep): void {
    const zone = this.zone();
    if (!zone) return;
    if (step.task === 'open') {
      zone.querySelector<HTMLElement>('a[href]')?.click();
      return;
    }
    const editable = zone.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    if (!editable) return;
    const target = this.stepAnchor(step);
    editable.focus({ preventScroll: true });
    if (target && target !== zone && editable.contains(target)) {
      this.doc.getSelection()?.collapse(target, target.childNodes.length);
    }
  }

  /**
   * The step's anchor (where the person works), of the step the tour is at: on the page, though
   * perhaps scrolled away.
   */
  private zone(): HTMLElement | null {
    const step = this.tour?.steps[this.tour.index];
    return step?.anchor ? this.workArea(step.anchor) : null;
  }

  /**
   * An anchor on the page but scrolled away (the menu button above a long module on a phone):
   * scrolled into view, so the step points at it instead of floating in the middle.
   */
  private scrolledTo(anchor: string | null): HTMLElement | null {
    if (anchor === null) return null;
    const inSidebar = anchorsOf(this.doc, anchor).some(
      (element) => element.closest('[data-sidebar="sidebar"]') !== null,
    );
    const element =
      this.workArea(anchor) ?? (inSidebar ? this.workArea(MENU_ANCHOR) : null);
    if (!element) return null;
    element.scrollIntoView?.({ block: 'nearest' });
    return anchorElement(this.doc, element.dataset['tip'] ?? '') === element
      ? element
      : null;
  }

  /** The first element with `data-tip="<anchor>"` on the page, seen or scrolled away. */
  private workArea(anchor: string): HTMLElement | null {
    return (
      anchorsOf(this.doc, anchor).find(
        (element) => !element.closest('[hidden], [inert]'),
      ) ?? null
    );
  }

  /**
   * Where the person types for the tour: the text of its typing step, from that step on (the
   * steps after it come as they type, and they may go on typing).
   */
  private typingZone(): HTMLElement | null {
    const step = this.typeStep();
    return step?.anchor ? this.workArea(step.anchor) : null;
  }

  /** The tour's typing step, once the tour has reached it. */
  private typeStep(): TourStep | null {
    const tour = this.tour;
    if (!tour) return null;
    for (let i = tour.index; i >= 0; i--) {
      if (tour.steps[i]?.task === 'type') return tour.steps[i]!;
    }
    return null;
  }

  /**
   * The sentence the person changed, which a later step's card keeps clear of (issue 869): the
   * block the caret is in, or the one the typing step lit. None on the typing step itself, whose
   * card points at that sentence.
   */
  private editedBlock(): HTMLElement | null {
    const tour = this.tour;
    const zone = this.typingZone();
    if (!tour || !zone || tour.steps[tour.index]?.task === 'type') return null;
    const node = this.doc.getSelection()?.focusNode ?? null;
    const at = node instanceof Element ? node : (node?.parentElement ?? null);
    const block =
      at && zone.contains(at) ? at.closest<HTMLElement>(BLOCKS) : null;
    if (block && zone.contains(block)) return block;
    const target = this.typeStep()?.target;
    return target ? zone.querySelector<HTMLElement>(target) : null;
  }

  /** Whether the focus is in the field the tour's typing step asks for. */
  private typing(): boolean {
    return this.typingZone()?.contains(this.doc.activeElement) ?? false;
  }

  private setIndex(index: number): void {
    const tour = this.tour;
    if (!tour) return;
    tour.index = index;
    const id = tour.steps[index]?.id ?? null;
    this.atStep.set(id);
    writeStored(tourKey(this.me().id), id, 'tab');
  }

  /** The tour is over for good; `done` (its last step's Done) says where search is. */
  private endTour(done: boolean): void {
    this.forgetTour();
    this.tourRequested.set(false);
    this.preferences.finishTour();
    if (done) {
      this.toast.show(
        translated('editor.tour.done', { keys: paletteShortcutLabel() }),
        { kind: 'success' },
      );
    }
  }

  private forgetTour(): void {
    this.tour = null;
    this.atStep.set(null);
    writeStored(tourKey(this.me().id), null, 'tab');
    writeStored(revisionKey(this.me().id), null, 'tab');
    this.revisionClaimed = false;
  }

  /**
   * Whether the step's anchor is in a list still loading (`aria-busy`, a list frame's reload): its
   * rows may yet move or be drawn again, so the step waits for the answer (issue 903).
   */
  private loading(step: TourStep): boolean {
    const element = step.anchor ? this.workArea(step.anchor) : null;
    return !!element?.closest('[aria-busy="true"]');
  }

  /**
   * On the step's screen, loaded, with a query that leaves its anchor out (a search that found no
   * module): the screen without the query, so the step has something to point at (issue 903).
   * Only the query the step moved on at (`waitedAt`): a search the person makes later is theirs.
   * Nothing while the page still loads, nor on another screen (a pause stays where the person is).
   */
  private unfiltered(step: TourStep): void {
    const url = this.router.url;
    if (this.waitedAt !== url) {
      this.waitedAt = null;
      return;
    }
    if (!step.route || this.pathNow() !== step.route || url === step.route)
      return;
    if (this.doc.querySelector('[aria-busy="true"]')) return;
    this.waitedAt = null;
    void this.router.navigateByUrl(step.route);
  }

  private pathNow(): string {
    return this.router.url.split(/[?#]/)[0] ?? '';
  }

  /**
   * After a resize, or once the open step's anchor left the page: the step points again at what
   * can be seen of its anchor now.
   */
  private repoint(): void {
    const tour = this.tour;
    const open = this.open;
    if (open?.kind !== 'tour' || !tour) return;
    const step = tour.steps[tour.index]!;
    if (
      step.anchor !== null &&
      (!anchorPresent(this.doc, step.anchor) || this.loading(step))
    ) {
      // The row went and none is drawn yet (a list loading again): paused until it is, not
      // centred over the page.
      this.closeOpen();
      this.schedule();
      return;
    }
    const anchor = this.stepAnchor(step);
    if (anchor === open.ref.anchor) return;
    open.ref.update(anchor, this.stepContent(tour.index));
  }

  /** What a step lights up: its anchor (or the menu button), or the part of it `target` names. */
  private stepAnchor(step: TourStep): HTMLElement | null {
    const element =
      stepAnchorElement(this.doc, step.anchor) ?? this.scrolledTo(step.anchor);
    if (!element || !step.target || element.dataset['tip'] !== step.anchor)
      return element;
    // The part scrolled away (typing on, far down a long module): the whole anchor, so the card
    // does not chase it out of view.
    const part = element.querySelector<HTMLElement>(step.target);
    return part && inWindow(this.doc, part) ? part : element;
  }

  /** The title of the revision chosen, when it is the person's own (the one the tour started). */
  private ownRevision(): string | null {
    return this.ownChosen()?.title ?? null;
  }

  private ownRevisionId(): string | null {
    return this.ownChosen()?.id ?? null;
  }

  private ownChosen() {
    const chosen = this.changeSets
      .options()
      .find((option) => option.id === this.changeSets.value());
    return chosen && chosen.authorId === this.me().id ? chosen : null;
  }

  private stepContent(index: number): TipContent {
    const steps = this.tour!.steps;
    const step = steps[index]!;
    const link = step.article ? this.help.link(step.article) : null;
    const name = step.namedBody ? this.ownRevision() : null;
    return {
      id: step.id,
      title: step.title,
      body: name ? step.namedBody! : step.body,
      params: { keys: paletteShortcutLabel(), name: name ?? '' },
      step: {
        index: index + 1,
        total: steps.length,
        next: step.next,
        dismiss: step.dismiss,
        back: false,
      },
      learnMore: link ? { ...link, read: true } : null,
    };
  }

  /**
   * The page took over: the focus went into a field, a dialog or a menu outside the tip (and
   * outside the field a tour step asks the person to type in). A tip goes, not counted as seen; the
   * tour pauses, to come back once the page is free.
   */
  private focusMoved(event: FocusEvent): void {
    const open = this.open;
    if (!open) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (open.ref.element?.contains(target)) return;
    const zone = open.kind === 'tour' ? this.zone() : null;
    const typing = open.kind === 'tour' ? this.typingZone() : null;
    if (zone?.contains(target) || typing?.contains(target)) return;
    const takenOver =
      target.closest('.cdk-overlay-container, [aria-modal="true"], dialog') !==
        null || pageBusy(this.doc, typing);
    if (!takenOver) return;
    this.closeOpen();
    if (open.kind === 'tour') this.schedule();
  }

  /**
   * → and ← on a tour step: its main button, or back a step (a presenter drives it from the
   * keyboard). Only from the card or with nothing focused, so a field, a list or a menu keeps its
   * arrows.
   */
  private keyDown(event: KeyboardEvent): void {
    const open = this.open;
    if (open?.kind !== 'tour' || event.defaultPrevented) return;
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
      return;
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const target = event.target;
    const free =
      target === this.doc.body ||
      target === this.doc.documentElement ||
      (target instanceof Node && !!open.ref.element?.contains(target));
    if (!free) return;
    event.preventDefault();
    this.tourAction(event.key === 'ArrowRight' ? 'next' : 'back');
  }

  /** A click outside the tour's card and its step's anchor: the tour pauses (#869). */
  private pointerDown(event: PointerEvent): void {
    const open = this.open;
    if (open?.kind !== 'tour') return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (open.ref.element?.contains(target)) return;
    if (
      this.zone()?.contains(target) ||
      this.typingZone()?.contains(target) ||
      open.ref.anchor?.contains(target)
    )
      return;
    this.closeOpen();
    this.schedule();
  }

  private closeOpen(): void {
    const open = this.open;
    this.open = null;
    open?.ref.close();
  }
}
