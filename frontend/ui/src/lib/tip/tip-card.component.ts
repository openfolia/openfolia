import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCompass,
  lucideExternalLink,
  lucideLightbulb,
  lucideX,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '../button/button.component';
import type { TipArrow } from './tip-geometry';

/**
 * What a tip shows. Its texts are translation keys (and their parameters), translated in the
 * card, so an open tip follows a language switch.
 */
export interface TipContent {
  /** The tip's ID, on the card as `data-tip-id`. */
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly params?: Readonly<Record<string, string>>;
  /**
   * "Learn more": a page of the user guide (an `http(s)` address), opened in a new tab. `read`
   * names the page instead ("Read “Your first edit”"), for a step that hands over to it.
   */
  readonly learnMore?: {
    readonly href: string;
    readonly title: string;
    readonly read?: boolean;
  } | null;
  /** A step of a tour (1-based): progress dots, Back and Next (Done on the last), and ×. */
  readonly step?: TipStep | null;
}

/** Where a tour's step stands, and the choices its card offers. */
export interface TipStep {
  readonly index: number;
  readonly total: number;
  /** The main button's label, a translation key: without, Next (Done on the last step). */
  readonly next?: string;
  /** A quiet button before it that ends the tour, as × does ("Not now"), a translation key. */
  readonly dismiss?: string;
  /** False leaves Back out: a task-led tour (#869) moves on by what the person does. */
  readonly back?: boolean;
}

/** What the person chose on the card. `skip` is the tour's × (or its `dismiss` button). */
export type TipAction = 'got-it' | 'turn-off' | 'next' | 'back' | 'skip';

/** Numbers the cards, for their title's and text's IDs. */
let cards = 0;

/** The arrow's place on each edge: half of it outside the card, its two outer sides bordered. */
const ARROW_SIDE: Record<TipArrow['side'], string> = {
  top: '-top-1.5 -translate-x-1/2 border-t border-l',
  bottom: '-bottom-1.5 -translate-x-1/2 border-b border-r',
  left: '-left-1.5 -translate-y-1/2 border-b border-l',
  right: '-right-1.5 -translate-y-1/2 border-t border-r',
};

/** What can take the focus inside the card, in order. */
const FOCUSABLE = 'a[href], button:not([disabled]):not([tabindex="-1"])';

/**
 * The card of a tip or of a tour's step (#222, #868): a title, one or two sentences, an optional
 * "Learn more" link, and its choices.
 *
 * - A tip: a lightbulb, "Got it" and "Turn off tips".
 * - A tour step: its own compass mark, an × that ends the tour, progress dots on the left (the
 *   "2 of 5" for screen readers), Back and Next (Done on the last step) on the right. Tab and
 *   Shift+Tab go round the card's own controls, so the keyboard never wanders off behind the
 *   spotlight; Escape works from anywhere (`TipOverlay`).
 *
 * A centred step (`data-centred`, set by `TipOverlay`: the welcome) is a little wider, so its
 * title breaks well.
 *
 * A non-modal dialog, named by its title and described by its text, so a screen reader announces
 * both when focus moves in (`TipOverlay` moves it). The card itself shows no focus ring when it
 * takes the focus; its controls show theirs for keyboard use. A small arrow on the edge facing
 * the anchor points at it (`arrow`, set by `TipOverlay`). In dark mode it is a raised surface
 * with a lighter edge, so it stands off the page.
 */
@Component({
  selector: 'of-tip-card',
  imports: [ZardButtonComponent, NgIcon, NgTemplateOutlet, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideLightbulb,
      lucideCompass,
      lucideExternalLink,
      lucideX,
    }),
  ],
  host: {
    role: 'dialog',
    'aria-modal': 'false',
    tabindex: '-1',
    'data-slot': 'tip',
    '[attr.data-tip-id]': 'content().id',
    '[attr.data-tour]': 'content().step ? "" : null',
    '[attr.aria-labelledby]': 'titleId',
    '[attr.aria-describedby]': 'bodyId',
    '(keydown)': 'keydown($event)',
    class:
      'bg-popover text-popover-foreground ring-foreground/10 dark:bg-muted dark:ring-foreground/15 relative flex max-w-[calc(100vw-2rem)] flex-col rounded-xl text-sm shadow-lg ring-1 outline-none data-tour:w-[22rem] data-tour:data-centred:w-[26rem] data-tour:gap-4 data-tour:p-4 not-data-tour:w-80 not-data-tour:gap-3 not-data-tour:p-3',
  },
  template: `
    @if (arrow(); as a) {
      <span
        data-slot="tip-arrow"
        [attr.data-side]="a.side"
        aria-hidden="true"
        class="bg-popover border-foreground/10 dark:bg-muted dark:border-foreground/15 pointer-events-none absolute size-3 rotate-45"
        [class]="arrowSide[a.side]"
        [style.left.px]="
          a.side === 'top' || a.side === 'bottom' ? a.offset : null
        "
        [style.top.px]="
          a.side === 'left' || a.side === 'right' ? a.offset : null
        "
      ></span>
    }
    @if (content().step; as step) {
      <div class="flex items-start gap-3">
        <span
          class="bg-primary/10 text-primary dark:bg-primary/15 grid size-8 shrink-0 place-items-center rounded-lg"
          aria-hidden="true"
        >
          <ng-icon name="lucideCompass" size="16" strokeWidth="1.75" />
        </span>
        <div class="flex min-w-0 flex-1 flex-col gap-1 pt-1">
          <p
            [id]="titleId"
            class="m-0 text-base/5 font-medium text-balance break-words"
          >
            {{ content().title | transloco: content().params }}
          </p>
          <p
            [id]="bodyId"
            class="text-muted-foreground m-0 text-sm/relaxed text-pretty break-words"
          >
            {{ content().body | transloco: content().params }}
          </p>
          @if (content().learnMore; as more) {
            <ng-container
              [ngTemplateOutlet]="learnMore"
              [ngTemplateOutletContext]="{ $implicit: more }"
            />
          }
        </div>
        <button
          z-button
          zType="ghost"
          zSize="icon-sm"
          type="button"
          data-action="skip"
          class="text-muted-foreground hover:bg-foreground/8 hover:text-foreground dark:hover:bg-foreground/10 -me-1.5 -mt-1.5"
          [attr.aria-label]="'ui.tip.close' | transloco"
          (click)="action.emit('skip')"
        >
          <ng-icon name="lucideX" size="16" aria-hidden="true" />
        </button>
      </div>
      <div class="flex min-h-7 items-center gap-2">
        <span class="sr-only" data-slot="tip-step">{{
          'ui.tip.step' | transloco: { index: step.index, total: step.total }
        }}</span>
        <span
          class="me-auto flex items-center gap-1.5"
          aria-hidden="true"
          data-slot="tip-dots"
        >
          @for (dot of dots(); track $index) {
            <span
              class="h-1.5 rounded-full"
              [class]="
                $index + 1 === step.index
                  ? 'bg-primary w-4'
                  : $index + 1 < step.index
                    ? 'bg-primary/40 w-1.5'
                    : 'bg-foreground/15 w-1.5'
              "
            ></span>
          }
        </span>
        @if (step.dismiss; as dismiss) {
          <button
            z-button
            zType="ghost"
            zSize="sm"
            type="button"
            data-action="dismiss"
            class="hover:bg-foreground/8 dark:hover:bg-foreground/10"
            (click)="action.emit('skip')"
          >
            {{ dismiss | transloco }}
          </button>
        }
        @if (step.index > 1 && step.back !== false) {
          <button
            z-button
            zType="ghost"
            zSize="sm"
            type="button"
            data-action="back"
            class="hover:bg-foreground/8 dark:hover:bg-foreground/10"
            (click)="action.emit('back')"
          >
            {{ 'ui.tip.back' | transloco }}
          </button>
        }
        <button
          z-button
          zSize="sm"
          type="button"
          data-action="next"
          class="min-w-16"
          (click)="action.emit('next')"
        >
          {{
            step.next ?? (last() ? 'ui.tip.done' : 'ui.tip.next') | transloco
          }}
        </button>
      </div>
    } @else {
      <div class="flex items-start gap-2.5">
        <ng-icon
          name="lucideLightbulb"
          class="text-muted-foreground mt-0.5 shrink-0"
          size="16"
          strokeWidth="1.75"
          aria-hidden="true"
        />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <p [id]="titleId" class="m-0 font-medium break-words">
            {{ content().title | transloco: content().params }}
          </p>
          <p [id]="bodyId" class="text-muted-foreground m-0 break-words">
            {{ content().body | transloco: content().params }}
          </p>
          @if (content().learnMore; as more) {
            <ng-container
              [ngTemplateOutlet]="learnMore"
              [ngTemplateOutletContext]="{ $implicit: more }"
            />
          }
        </div>
      </div>
      <div class="flex flex-wrap items-center justify-end gap-2">
        <button
          z-button
          zType="ghost"
          zSize="sm"
          type="button"
          class="hover:bg-foreground/8 dark:hover:bg-foreground/10 me-auto"
          data-action="turn-off"
          (click)="action.emit('turn-off')"
        >
          {{ 'ui.tip.turnOff' | transloco }}
        </button>
        <button
          z-button
          zSize="sm"
          type="button"
          data-action="got-it"
          (click)="action.emit('got-it')"
        >
          {{ 'ui.tip.gotIt' | transloco }}
        </button>
      </div>
    }
    <ng-template #learnMore let-more>
      <a
        data-slot="tip-learn-more"
        class="text-foreground focus-visible:ring-ring inline-flex items-center gap-1 self-start rounded-sm text-sm underline underline-offset-4 outline-none focus-visible:ring-2"
        [href]="more.href"
        target="_blank"
        rel="noopener noreferrer"
        [attr.aria-label]="
          (more.read ? 'ui.tip.readLabel' : 'ui.tip.learnMoreLabel')
            | transloco: { title: more.title }
        "
      >
        {{
          (more.read ? 'ui.tip.read' : 'ui.tip.learnMore')
            | transloco: { title: more.title }
        }}
        <ng-icon name="lucideExternalLink" size="12" aria-hidden="true" />
      </a>
    </ng-template>
  `,
})
export class TipCardComponent {
  private readonly uid = ++cards;
  protected readonly titleId = `of-tip-${this.uid}-title`;
  protected readonly bodyId = `of-tip-${this.uid}-body`;
  protected readonly arrowSide = ARROW_SIDE;

  readonly content = input.required<TipContent>();
  readonly action = output<TipAction>();
  /** The arrow toward the anchor, or none (a centred card, or one over its anchor). */
  readonly arrow = signal<TipArrow | null>(null);

  /** The card's own element, which takes the focus when it opens. */
  readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly last = computed(() => {
    const step = this.content().step;
    return !!step && step.index === step.total;
  });

  protected readonly dots = computed(() =>
    Array.from({ length: this.content().step?.total ?? 0 }),
  );

  /** A tour step keeps Tab and Shift+Tab inside the card. */
  protected keydown(event: KeyboardEvent): void {
    if (event.key !== 'Tab' || !this.content().step) return;
    const controls = Array.from(
      this.element.querySelectorAll<HTMLElement>(FOCUSABLE),
    );
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) return;
    const active = this.element.ownerDocument.activeElement;
    if (event.shiftKey && (active === first || active === this.element)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }
}
