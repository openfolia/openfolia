import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideExternalLink, lucideLightbulb } from '@ng-icons/lucide';

import { ZardButtonComponent } from '../button/button.component';

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
  /** "Learn more": a page of the user guide (an `http(s)` address), opened in a new tab. */
  readonly learnMore?: { readonly href: string; readonly title: string } | null;
  /** A step of a tour (1-based), with Back, Next (Done on the last) and Skip. */
  readonly step?: { readonly index: number; readonly total: number } | null;
}

/** What the person chose on the card. */
export type TipAction = 'got-it' | 'turn-off' | 'next' | 'back' | 'skip';

/** Numbers the cards, for their title's and text's IDs. */
let cards = 0;

/**
 * The card of a tip or of a tour's step (#222): a title, one or two sentences, an optional
 * "Learn more" link, and its choices: "Got it" and "Turn off tips" for a tip; Skip, Back and
 * Next (Done on the last step) with "2 of 5" for a tour. A non-modal dialog, named by its title
 * and described by its text, so a screen reader announces both when focus moves in
 * (`TipOverlay` moves it). Back keeps its place on the first step (hidden, not removed), so the
 * buttons never move between steps.
 */
@Component({
  selector: 'of-tip-card',
  imports: [ZardButtonComponent, NgIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideLightbulb, lucideExternalLink })],
  host: {
    role: 'dialog',
    'aria-modal': 'false',
    tabindex: '-1',
    'data-slot': 'tip',
    '[attr.data-tip-id]': 'content().id',
    '[attr.aria-labelledby]': 'titleId',
    '[attr.aria-describedby]': 'bodyId',
    class:
      'bg-popover text-popover-foreground ring-foreground/10 flex w-80 max-w-[calc(100vw-1rem)] flex-col gap-3 rounded-lg p-3 text-sm shadow-lg ring-1 outline-hidden focus-visible:ring-2 focus-visible:ring-ring',
  },
  template: `
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
          <a
            data-slot="tip-learn-more"
            class="text-foreground focus-visible:ring-ring inline-flex items-center gap-1 self-start rounded-sm text-sm underline underline-offset-4 outline-none focus-visible:ring-2"
            [href]="more.href"
            target="_blank"
            rel="noopener noreferrer"
            [attr.aria-label]="
              'ui.tip.learnMoreLabel' | transloco: { title: more.title }
            "
          >
            {{ 'ui.tip.learnMore' | transloco }}
            <ng-icon name="lucideExternalLink" size="12" aria-hidden="true" />
          </a>
        }
      </div>
    </div>
    @if (content().step; as step) {
      <div class="flex flex-wrap items-center gap-2">
        <span
          class="text-muted-foreground me-auto text-xs"
          data-slot="tip-step"
        >
          {{
            'ui.tip.step' | transloco: { index: step.index, total: step.total }
          }}
        </span>
        <button
          z-button
          zType="ghost"
          zSize="sm"
          type="button"
          data-action="skip"
          (click)="action.emit('skip')"
        >
          {{ 'ui.tip.skip' | transloco }}
        </button>
        <button
          z-button
          zType="outline"
          zSize="sm"
          type="button"
          data-action="back"
          [class.invisible]="step.index === 1"
          [attr.aria-hidden]="step.index === 1 ? 'true' : null"
          [attr.tabindex]="step.index === 1 ? -1 : null"
          (click)="action.emit('back')"
        >
          {{ 'ui.tip.back' | transloco }}
        </button>
        <button
          z-button
          zSize="sm"
          type="button"
          data-action="next"
          (click)="action.emit('next')"
        >
          {{ (last() ? 'ui.tip.done' : 'ui.tip.next') | transloco }}
        </button>
      </div>
    } @else {
      <div class="flex flex-wrap items-center justify-end gap-2">
        <button
          z-button
          zType="ghost"
          zSize="sm"
          type="button"
          class="me-auto"
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
  `,
})
export class TipCardComponent {
  private readonly uid = ++cards;
  protected readonly titleId = `of-tip-${this.uid}-title`;
  protected readonly bodyId = `of-tip-${this.uid}-body`;

  readonly content = input.required<TipContent>();
  readonly action = output<TipAction>();

  /** The card's own element, which takes the focus when it opens. */
  readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;

  protected readonly last = computed(() => {
    const step = this.content().step;
    return !!step && step.index === step.total;
  });
}
