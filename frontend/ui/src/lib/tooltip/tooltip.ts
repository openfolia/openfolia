import { Directionality, type Direction } from '@angular/cdk/bidi';
import { Overlay, type OverlayRef } from '@angular/cdk/overlay';
import { ComponentPortal } from '@angular/cdk/portal';
import { isPlatformBrowser } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  type ComponentRef,
  computed,
  DestroyRef,
  Directive,
  DOCUMENT,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  numberAttribute,
  type OnDestroy,
  type OnInit,
  output,
  PLATFORM_ID,
  Renderer2,
  runInInjectionContext,
  signal,
  type TemplateRef,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';

import { filter, map, of, Subject, switchMap, tap, timer } from 'rxjs';

import {
  resolveTooltipSide,
  type TooltipPlacement,
  ZardTooltipPositionStrategy,
  type ZardTooltipSide,
} from './tooltip-positions';
import {
  tooltipPositionVariants,
  tooltipVariants,
  type ZardTooltipPositionVariants,
} from './tooltip.variants';
import { ZardIdDirective } from '../core/id.directive';
import { ZardStringTemplateOutletDirective } from '../core/string-template-outlet.directive';
import { mergeClasses } from '../ui/merge-classes';

export type ZardTooltipTriggers = 'click' | 'hover';
export type ZardTooltipType = string | TemplateRef<void> | null;

interface DelayConfig {
  isShow: boolean;
  delay: number;
}

/** Matches the `animate-out` duration applied by `tooltipVariants`. */
const TOOLTIP_EXIT_DURATION = 150;

const throttle = (callback: () => void, wait: number) => {
  let time = Date.now();
  return function () {
    if (time + wait - Date.now() < 0) {
      callback();
      time = Date.now();
    }
  };
};

@Directive({
  // A sidebar menu button has its own `zTooltip` input (it shows the tooltip only while the sidebar
  // is collapsed); the directive must not attach a second tooltip to it.
  selector: '[zTooltip]:not([z-sidebar-menu-button])',
  host: {
    style: 'cursor: pointer',
  },
  exportAs: 'zTooltip',
})
export class ZardTooltipDirective implements OnInit, OnDestroy {
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly elementRef = inject(ElementRef<HTMLElement>);
  private readonly injector = inject(Injector);
  private readonly overlay = inject(Overlay);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly renderer = inject(Renderer2);
  // Optional: the direction of the trigger, which is where the overlay content takes its `dir` from.
  private readonly directionality = inject(Directionality, { optional: true });

  private ariaEffectRef?: ReturnType<typeof effect>;
  private componentRef?: ComponentRef<ZardTooltipComponent>;
  private delaySubject?: Subject<DelayConfig>;
  private detachTimeoutId?: ReturnType<typeof setTimeout>;
  private listenersRefs: (() => void)[] = [];
  private overlayRef?: OverlayRef;
  private positionStrategy?: ZardTooltipPositionStrategy;

  readonly zHideDelay = input(100, { transform: numberAttribute });
  readonly zPosition = input<ZardTooltipSide>('top');
  readonly zPositionOffset = input(4);
  readonly zShowDelay = input(150, { transform: numberAttribute });
  readonly zTrigger = input<ZardTooltipTriggers>('hover');
  readonly zTooltip = input<ZardTooltipType>(null);
  /**
   * Text set from code (a directive on the same element, such as the editor's permission guard),
   * which takes the place of `zTooltip` while it is set.
   */
  readonly text = signal<ZardTooltipType>(null);

  readonly zHide = output<void>();
  readonly zShow = output<void>();

  private readonly tooltipText = computed<string | TemplateRef<void>>(() => {
    let tooltipText = this.text() ?? this.zTooltip();
    if (!tooltipText) {
      return '';
    } else if (typeof tooltipText === 'string') {
      tooltipText = tooltipText.trim();
    }
    return tooltipText;
  });

  ngOnInit() {
    if (isPlatformBrowser(this.platformId)) {
      const positionStrategy = new ZardTooltipPositionStrategy(
        this.elementRef.nativeElement,
        this.side(),
        this.zPositionOffset(),
      );
      this.positionStrategy = positionStrategy;
      this.overlayRef = this.overlay.create({
        positionStrategy,
        direction: this.direction(),
      });

      // The direction changed (a `[dir]` switch): drop the tooltip, it reopens with the new direction.
      this.directionality?.change
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => {
          this.overlayRef?.setDirection(this.direction());
          if (this.componentRef) {
            this.delay(false, 0);
          }
        });

      runInInjectionContext(this.injector, () => {
        toObservable(this.zTrigger)
          .pipe(
            tap(() => {
              this.setupDelayMechanism();
              this.cleanupTriggerEvents();
              this.initTriggers();
            }),
            filter(() => !!this.overlayRef),
            switchMap(() =>
              (this.overlayRef as OverlayRef).outsidePointerEvents(),
            ),
            filter(
              (event) => !this.elementRef.nativeElement.contains(event.target),
            ),
            takeUntilDestroyed(this.destroyRef),
          )
          .subscribe(() => this.delay(false, 0));
      });
    }
  }

  ngOnDestroy(): void {
    // Clean up any pending effect
    if (this.ariaEffectRef) {
      this.ariaEffectRef.destroy();
      this.ariaEffectRef = undefined;
    }

    if (this.detachTimeoutId !== undefined) {
      clearTimeout(this.detachTimeoutId);
      this.detachTimeoutId = undefined;
    }

    this.delaySubject?.complete();
    this.cleanupTriggerEvents();
    this.overlayRef?.dispose();
  }

  /** Closes the tooltip now and cancels one that is about to open (the trigger was activated). */
  dismiss(): void {
    this.delay(false, 0);
  }

  private direction(): Direction {
    return this.directionality?.value ?? 'ltr';
  }

  private side() {
    return resolveTooltipSide(this.zPosition(), this.direction() === 'rtl');
  }

  private initTriggers() {
    this.initScrollListener();
    this.initClickListeners();
    this.initHoverListeners();
  }

  private initClickListeners(): void {
    if (this.zTrigger() !== 'click') {
      return;
    }

    this.listenersRefs = [
      ...this.listenersRefs,
      this.renderer.listen(this.elementRef.nativeElement, 'click', () => {
        const shouldShowTooltip = !this.overlayRef?.hasAttached();
        const delay = shouldShowTooltip ? this.zShowDelay() : this.zHideDelay();
        this.delay(shouldShowTooltip, delay);
      }),
    ];
  }

  private initHoverListeners(): void {
    if (this.zTrigger() !== 'hover') {
      return;
    }

    this.listenersRefs = [
      ...this.listenersRefs,
      this.renderer.listen(this.elementRef.nativeElement, 'mouseenter', () =>
        this.delay(true, this.zShowDelay()),
      ),
      this.renderer.listen(this.elementRef.nativeElement, 'mouseleave', () =>
        this.delay(false, this.zHideDelay()),
      ),
      this.renderer.listen(this.elementRef.nativeElement, 'focus', () =>
        this.delay(true, this.zShowDelay()),
      ),
      this.renderer.listen(this.elementRef.nativeElement, 'blur', () =>
        this.delay(false, this.zHideDelay()),
      ),
      // WCAG 1.4.13: dismissible without moving the focus or the pointer.
      this.renderer.listen(
        this.elementRef.nativeElement,
        'keydown',
        (event: KeyboardEvent) => {
          if (event.key === 'Escape' && this.componentRef) this.delay(false, 0);
        },
      ),
    ];
  }

  private initScrollListener(): void {
    // Captured on the document, so a scroll in any container (the shell's main area, a list)
    // is heard, not only a scroll of the window.
    const onScroll = throttle(() => {
      // Moving the focus to the trigger can scroll the page: a focused trigger keeps its
      // tooltip, repositioned, instead of losing it to the scroll it caused.
      if (this.document.activeElement === this.elementRef.nativeElement) {
        this.overlayRef?.updatePosition();
      } else {
        this.delay(false, 0);
      }
    }, 100);
    this.document.addEventListener('scroll', onScroll, true);
    this.listenersRefs = [
      ...this.listenersRefs,
      () => this.document.removeEventListener('scroll', onScroll, true),
    ];
  }

  private cleanupTriggerEvents(): void {
    for (const eventRef of this.listenersRefs) {
      eventRef();
    }
    this.listenersRefs = [];
  }

  private delay(isShow: boolean, delay = -1): void {
    this.delaySubject?.next({ isShow, delay });
  }

  private setupDelayMechanism(): void {
    this.delaySubject?.complete();
    this.delaySubject = new Subject<DelayConfig>();

    this.delaySubject
      .pipe(
        switchMap((config) =>
          config.delay < 0
            ? of(config)
            : timer(config.delay).pipe(map(() => config)),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((config) => {
        if (config.isShow) {
          this.show();
        } else {
          this.hide();
        }
      });
  }

  private show() {
    if (!this.tooltipText()) {
      return;
    }

    // Re-entering the trigger while the exit animation is running: keep the
    // same overlay and animate it back in instead of detaching it.
    if (this.componentRef) {
      if (this.detachTimeoutId !== undefined) {
        clearTimeout(this.detachTimeoutId);
        this.detachTimeoutId = undefined;
        this.componentRef.instance.state.set('open');
      }
      return;
    }

    const tooltipPortal = new ComponentPortal(ZardTooltipComponent);
    if (this.positionStrategy) {
      this.positionStrategy.preferred = this.side();
      this.positionStrategy.offset = this.zPositionOffset();
    }
    this.componentRef = this.overlayRef?.attach(tooltipPortal);
    const instance = this.componentRef?.instance;
    if (this.positionStrategy && instance) {
      this.positionStrategy.onPlaced = (placement) => instance.place(placement);
    }
    this.componentRef?.onDestroy(() => {
      this.componentRef = undefined;
    });
    this.componentRef?.instance.state.set('open');
    this.componentRef?.instance.setProps(this.tooltipText(), this.side());
    runInInjectionContext(this.injector, () => {
      this.ariaEffectRef = effect(() => {
        const tooltipId = this.componentRef?.instance.uniqueId()?.id();
        if (tooltipId) {
          this.renderer.setAttribute(
            this.elementRef.nativeElement,
            'aria-describedby',
            tooltipId,
          );
          this.ariaEffectRef?.destroy();
          this.ariaEffectRef = undefined;
        }
      });
    });
    this.zShow.emit();
  }

  private hide() {
    if (!this.componentRef || this.detachTimeoutId !== undefined) {
      return;
    }

    // Clean up any pending effect
    if (this.ariaEffectRef) {
      this.ariaEffectRef.destroy();
      this.ariaEffectRef = undefined;
    }

    this.renderer.removeAttribute(
      this.elementRef.nativeElement,
      'aria-describedby',
    );
    this.componentRef.instance.state.set('closed');
    this.zHide.emit();

    // Detach only once the exit animation has played out.
    this.detachTimeoutId = setTimeout(() => {
      this.detachTimeoutId = undefined;
      this.overlayRef?.detach();
    }, TOOLTIP_EXIT_DURATION);
  }
}

@Component({
  selector: 'z-tooltip',
  imports: [ZardStringTemplateOutletDirective, ZardIdDirective],
  template: `
    <ng-container
      *zStringTemplateOutlet="tooltipText()"
      zardId="tooltip"
      #z="zardId"
      >{{ tooltipText() }}</ng-container
    >

    <span [class]="arrowClasses()" [style]="arrowStyle()">
      <svg
        class="bg-foreground fill-foreground z-50 block size-2.5 translate-y-[calc(-50%-2px)] rotate-45 rounded-[2px]"
        width="10"
        height="5"
        viewBox="0 0 30 10"
        preserveAspectRatio="none"
      >
        <polygon points="0,0 30,0 15,10" />
      </svg>
    </span>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  host: {
    '[class]': 'classes()',
    '[attr.id]': 'tooltipId()',
    '[attr.data-side]': 'position()',
    '[attr.data-state]': 'state()',
    'data-slot': 'tooltip-content',
    role: 'tooltip',
  },
  exportAs: 'zTooltip',
})
export class ZardTooltipComponent {
  protected readonly arrowClasses = computed(() =>
    mergeClasses(tooltipPositionVariants({ position: this.position() })),
  );

  protected readonly classes = computed(() => mergeClasses(tooltipVariants()));
  protected readonly position = signal<ZardTooltipPositionVariants>('top');
  /** Px from the body's start edge to the arrow's centre, once placed: it follows the trigger, not the body. */
  private readonly arrowOffset = signal<number | null>(null);
  protected readonly arrowStyle = computed(() => {
    const offset = this.arrowOffset();
    if (offset === null) {
      return null;
    }
    // The arrow is 10px wide: its centre sits at `offset`.
    const start = `${offset - 5}px`;
    return ['top', 'bottom'].includes(this.position())
      ? { left: start }
      : { top: start };
  });
  readonly state = signal<'closed' | 'open'>('closed');
  readonly uniqueId = viewChild<ZardIdDirective>('z');
  protected readonly tooltipText = signal<ZardTooltipType>(null);
  protected readonly tooltipId = computed(
    () => this.uniqueId()?.id() ?? 'tooltip',
  );

  /** Takes the side the placement chose (it may differ from the one asked for) and aims the arrow. */
  place(placement: TooltipPlacement) {
    this.position.set(placement.side);
    this.arrowOffset.set(placement.arrow);
  }

  setProps(
    tooltipText: ZardTooltipType,
    position: ZardTooltipPositionVariants,
  ) {
    if (tooltipText) {
      this.tooltipText.set(tooltipText);
    }
    this.position.set(position);
  }
}
