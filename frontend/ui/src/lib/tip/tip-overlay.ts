import {
  Overlay,
  type OverlayRef,
  type PositionStrategy,
  type ScrollStrategy,
} from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import {
  type ComponentRef,
  DOCUMENT,
  inject,
  Injectable,
  Injector,
  NgZone,
} from '@angular/core';

import { createTriggerOverlay } from '../core/trigger-overlay';
import { buildDropdownPositions } from '../dropdown-menu/dropdown-positions';
import {
  type TipAction,
  TipCardComponent,
  type TipContent,
} from './tip-card.component';

/**
 * How long the card fades and scales in or out (`duration-150` on the card). The overlay is
 * detached after this long, so tests advance timers by this amount.
 */
export const TIP_ANIMATION_MS = 150;

/** Why an open tip went: the person chose on it, pressed Escape, or its anchor scrolled out of view. */
export type TipCloseReason = 'action' | 'escape' | 'hidden' | 'closed';

export interface TipOpenOptions {
  /** The element the card points at; null centres the card near the top of the window. */
  readonly anchor: HTMLElement | null;
  readonly content: TipContent;
  /** A choice on the card. The card stays open: the caller closes it or moves it on. */
  readonly onAction: (action: TipAction) => void;
  /** Called once, when the card starts to go (not for `close()` the caller made itself). */
  readonly onDismiss: (reason: 'escape' | 'hidden') => void;
}

/** An open tip: moved on to another anchor and content (a tour's next step), or closed. */
export interface TipRef {
  /** The card's element while it is attached. */
  readonly element: HTMLElement | null;
  /** Swaps the content and the anchor: the card fades out and in again at its new place. */
  update(anchor: HTMLElement | null, content: TipContent): void;
  /** Closes it (exit animation, then detached); focus goes back where it was before it opened. */
  close(): void;
  readonly closed: boolean;
}

/** The classes the card's enter and exit animations hang on (`data-open`, `data-closed`). */
const MOTION = [
  'duration-150',
  'data-open:animate-in',
  'data-open:fade-in-0',
  'data-open:zoom-in-95',
  'data-closed:animate-out',
  'data-closed:fade-out-0',
  'data-closed:zoom-out-95',
  'motion-reduce:animate-none',
];

/**
 * Shows a tip (#222) beside the element it is about: a `TipCardComponent` in an overlay placed
 * by `createTriggerOverlay` (it follows the element on scroll, flips where there is no room and
 * closes once the element has scrolled out of view), or centred near the top for a tip about
 * the whole page. One at a time: opening another closes the one before.
 *
 * - The card fades and scales in and out (150 ms), at once under reduced motion.
 * - Focus moves into the card as it opens, so it is announced (a dialog named by its title and
 *   described by its text), and goes back where it was when it closes, if it is still in the card
 *   or nowhere.
 * - Escape closes it (`onDismiss('escape')`).
 * - It has no backdrop: the page stays usable around it.
 */
@Injectable({ providedIn: 'root' })
export class TipOverlay {
  private readonly overlay = inject(Overlay);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  private readonly zone = inject(NgZone);

  private current: OpenTip | null = null;

  open(options: TipOpenOptions): TipRef {
    this.current?.close();
    const tip = new OpenTip(this, options);
    this.current = tip;
    return tip;
  }

  /** @internal The open tip ended. */
  ended(tip: OpenTip): void {
    if (this.current === tip) this.current = null;
  }

  /** @internal */
  reducedMotion(): boolean {
    return (
      this.document.defaultView?.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      ).matches ?? true
    );
  }

  /** @internal The strategies for a card at `anchor`, or centred. */
  strategies(
    anchor: HTMLElement | null,
    onHidden: () => void,
  ): { position: PositionStrategy; scroll: ScrollStrategy } {
    if (!anchor) {
      return {
        position: this.overlay
          .position()
          .global()
          .centerHorizontally()
          .top('15vh'),
        scroll: this.overlay.scrollStrategies.reposition(),
      };
    }
    const rtl = this.document.documentElement.dir === 'rtl';
    const { positionStrategy, scrollStrategy } = createTriggerOverlay(
      this.injector,
      {
        origin: anchor,
        positions: buildDropdownPositions('bottom', 'start', 8, rtl),
        onTriggerHidden: () => this.zone.run(onHidden),
      },
    );
    return { position: positionStrategy, scroll: scrollStrategy };
  }

  /** @internal */
  create(position: PositionStrategy, scroll: ScrollStrategy): OverlayRef {
    const ref = this.overlay.create({
      positionStrategy: position,
      scrollStrategy: scroll,
      hasBackdrop: false,
    });
    ref.addPanelClass(['isolate', 'z-50']);
    return ref;
  }

  /** @internal */
  get doc(): Document {
    return this.document;
  }

  /** @internal */
  get inj(): Injector {
    return this.injector;
  }
}

class OpenTip implements TipRef {
  private overlayRef: OverlayRef | null = null;
  private card: ComponentRef<TipCardComponent> | null = null;
  private subscriptions: { unsubscribe(): void }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly returnFocus: HTMLElement | null;
  closed = false;

  constructor(
    private readonly host: TipOverlay,
    private readonly options: TipOpenOptions,
  ) {
    const active = host.doc.activeElement;
    this.returnFocus =
      active instanceof HTMLElement && active !== host.doc.body ? active : null;
    this.attach(options.anchor, options.content);
  }

  get element(): HTMLElement | null {
    return this.card?.instance.element ?? null;
  }

  update(anchor: HTMLElement | null, content: TipContent): void {
    if (this.closed) return;
    const hadFocus = this.hasFocus();
    this.leave(() => {
      this.detach();
      this.attach(anchor, content, hadFocus);
    });
  }

  close(): void {
    this.end(null);
  }

  private end(reason: 'escape' | 'hidden' | null): void {
    if (this.closed) return;
    this.closed = true;
    this.host.ended(this);
    const hadFocus =
      this.hasFocus() || this.host.doc.activeElement === this.host.doc.body;
    if (reason) this.options.onDismiss(reason);
    this.leave(() => this.detach());
    if (hadFocus && this.returnFocus?.isConnected) {
      this.returnFocus.focus({ preventScroll: true });
    }
  }

  private hasFocus(): boolean {
    const active = this.host.doc.activeElement;
    return !!active && !!this.overlayRef?.overlayElement.contains(active);
  }

  private attach(
    anchor: HTMLElement | null,
    content: TipContent,
    focus = true,
  ): void {
    const { position, scroll } = this.host.strategies(anchor, () =>
      this.end('hidden'),
    );
    const ref = this.host.create(position, scroll);
    this.overlayRef = ref;
    const card = ref.attach(
      new ComponentPortal(TipCardComponent, null, this.host.inj),
    );
    this.card = card;
    card.setInput('content', content);
    const element = card.instance.element;
    element.classList.add(...MOTION);
    element.setAttribute('data-open', '');
    this.subscriptions.push(
      card.instance.action.subscribe((action) => this.options.onAction(action)),
      ref.keydownEvents().subscribe((event) => {
        // The overlay's dispatcher hands it every key of the page: only one in the card counts.
        if (event.key !== 'Escape') return;
        if (!(event.target instanceof Node) || !element.contains(event.target))
          return;
        event.preventDefault();
        event.stopPropagation();
        this.end('escape');
      }),
    );
    card.changeDetectorRef.detectChanges();
    ref.updatePosition();
    if (focus) element.focus({ preventScroll: true });
  }

  /** Plays the exit animation, then `done`; at once under reduced motion. */
  private leave(done: () => void): void {
    clearTimeout(this.timer);
    const element = this.element;
    if (!element || this.host.reducedMotion()) {
      done();
      return;
    }
    element.removeAttribute('data-open');
    element.setAttribute('data-closed', '');
    this.timer = setTimeout(done, TIP_ANIMATION_MS);
  }

  private detach(): void {
    for (const s of this.subscriptions) s.unsubscribe();
    this.subscriptions = [];
    this.overlayRef?.dispose();
    this.overlayRef = null;
    this.card = null;
  }
}
