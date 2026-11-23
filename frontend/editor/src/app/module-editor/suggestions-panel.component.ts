import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideCircleAlert,
  lucideEyeOff,
  lucideLocateFixed,
  lucideSparkles,
  lucideTriangleAlert,
  lucideX,
} from '@ng-icons/lucide';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective } from '@openfolia/ui/smooth';

import {
  capped,
  MAX_SHOWN_TEXT,
  type SuggestionItem,
} from './suggestion-items';

/** What a suggestion's field is called in the list. */
const FIELD_LABELS: Record<SuggestionItem['field'], string> = {
  content: 'editor.suggestions.field.content',
  title: 'editor.suggestions.field.title',
  alt: 'editor.suggestions.field.alt',
  hazard: 'editor.suggestions.field.hazard',
  question: 'editor.suggestions.field.question',
  name: 'editor.suggestions.field.name',
  description: 'editor.suggestions.field.description',
  legend: 'editor.suggestions.field.legend',
};

/** Where the style review stands: not asked yet, on its way, answered, or off on this server. */
export type StyleReviewState = 'idle' | 'loading' | 'done' | 'off';

/**
 * Where the writing checks stand: their terms and rules being read, not readable, none for this
 * language (`off`), or checking as the person types.
 */
export type WritingChecksState = 'loading' | 'failed' | 'off' | 'ready';

/**
 * The Suggestions tab of the module editor's side panel (#247, #573). First the writing checks'
 * findings while typing (forbidden and deprecated terms, the configured style rules), each with
 * its severity in words, where it is, the message, the fix, "Replace", "Show" (its text selected
 * in the editor) and "Ignore here". Then the style review, when the server has one: "Review style" asks the
 * model-based style review (#248) about the module as saved, and its suggestions are listed, each
 * with where it is (the field: a paragraph, a title, an image callout's legend, …), the model's
 * message, the text it would change and the change. "Apply" makes the change in one step that
 * Undo takes back; "Show" brings its text into view (a legend: in its image's callout panel);
 * "Dismiss" takes it off the list. One that no longer fits the text says so and is only
 * dismissed. Everything the model wrote is shown as text, never as markup. The page owns the
 * state; this shows it and says what the person did.
 */
@Component({
  selector: 'of-suggestions-panel',
  imports: [
    NgTemplateOutlet,
    TranslocoPipe,
    NgIcon,
    ZardBadgeComponent,
    ZardButtonComponent,
    ZardSkeletonComponent,
    FadeInDirective,
  ],
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideCircleAlert,
      lucideEyeOff,
      lucideLocateFixed,
      lucideSparkles,
      lucideTriangleAlert,
      lucideX,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  styles: `
    @media (prefers-reduced-motion: no-preference) {
      .of-suggestion-leave {
        pointer-events: none;
        animation: of-suggestion-out 180ms ease-in forwards;
      }
    }
    @keyframes of-suggestion-out {
      to {
        opacity: 0;
        transform: translateX(0.5rem);
      }
    }
  `,
  template: `
    <ng-template #row let-item let-writing="writing">
      <li
        ofFadeIn
        animate.leave="of-suggestion-leave"
        class="border-border flex flex-col gap-2 rounded-xl border p-3"
        data-slot="suggestion"
        [attr.data-kind]="item.kind"
        [attr.data-field]="item.field"
        [attr.data-block]="item.blockId"
      >
        <div class="flex flex-wrap items-center gap-2">
          @if (item.severity; as severity) {
            <z-badge
              [zType]="severity === 'blocking' ? 'destructive' : 'warning'"
              data-slot="suggestion-severity"
            >
              <ng-icon
                [name]="
                  severity === 'blocking'
                    ? 'lucideCircleAlert'
                    : 'lucideTriangleAlert'
                "
                aria-hidden="true"
              />
              {{
                (severity === 'blocking'
                  ? 'editor.writing.severity.blocking'
                  : 'editor.writing.severity.warning'
                ) | transloco
              }}
            </z-badge>
          }
          <p class="text-muted-foreground m-0 text-xs leading-4 font-medium">
            {{ fieldLabel(item) | transloco }}
          </p>
        </div>
        <p class="m-0 text-sm leading-5 break-words">
          {{ item.message }}
        </p>
        <p
          class="m-0 text-sm leading-5 break-words"
          data-slot="suggestion-change"
        >
          <span class="sr-only"
            >{{ 'editor.suggestions.original' | transloco }}:
          </span>
          <del
            class="text-muted-foreground decoration-destructive/70 line-through"
            >{{ shown(item.original) }}</del
          >
          @if (item.replacement !== null) {
            <span aria-hidden="true"> → </span>
            <span class="sr-only"
              >{{ 'editor.suggestions.replacement' | transloco }}:
            </span>
            @if (item.replacement === '') {
              <span class="text-muted-foreground italic">{{
                'editor.suggestions.removed' | transloco
              }}</span>
            } @else {
              <ins
                class="bg-primary/10 text-foreground rounded-sm px-0.5 no-underline"
                >{{ shown(item.replacement) }}</ins
              >
            }
          }
        </p>
        @if (item.expected === null) {
          <p
            class="text-muted-foreground m-0 text-xs leading-5 break-words"
            data-slot="suggestion-stale"
          >
            {{ 'editor.suggestions.stale' | transloco }}
          </p>
        }
        <div class="flex flex-wrap gap-1.5">
          @if (item.replacement !== null && item.expected !== null) {
            <button
              z-button
              zSize="sm"
              type="button"
              data-action="apply"
              [zDisabled]="!editable()"
              (click)="apply.emit(item)"
            >
              <ng-icon
                name="lucideCheck"
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{
                (writing
                  ? 'editor.writing.replace'
                  : 'editor.suggestions.apply'
                ) | transloco
              }}
            </button>
          }
          @if (item.expected !== null) {
            <button
              z-button
              zType="outline"
              zSize="sm"
              type="button"
              data-action="show"
              (click)="show.emit(item)"
            >
              <ng-icon
                name="lucideLocateFixed"
                data-icon="inline-start"
                aria-hidden="true"
              />
              {{ 'editor.suggestions.show' | transloco }}
            </button>
          }
          <button
            z-button
            zType="ghost"
            zSize="sm"
            type="button"
            data-action="dismiss"
            (click)="dismiss.emit(item)"
          >
            <ng-icon
              [name]="writing ? 'lucideEyeOff' : 'lucideX'"
              data-icon="inline-start"
              aria-hidden="true"
            />
            {{
              (writing ? 'editor.writing.ignore' : 'editor.suggestions.dismiss')
                | transloco
            }}
          </button>
        </div>
      </li>
    </ng-template>

    <section
      class="border-border bg-card mb-3 flex flex-col gap-3 rounded-2xl border p-3.5"
      data-slot="writing-checks-panel"
      aria-labelledby="of-writing-checks-heading"
    >
      <div class="flex flex-col gap-1">
        <h2
          id="of-writing-checks-heading"
          class="m-0 text-sm leading-5 font-medium"
        >
          {{ 'editor.writing.heading' | transloco }}
        </h2>
        <p
          class="text-muted-foreground m-0 text-[0.8125rem] leading-5 break-words"
        >
          {{ 'editor.writing.hint' | transloco }}
        </p>
      </div>
      @if (checks().length > 0) {
        <ul
          class="m-0 flex list-none flex-col gap-2 p-0"
          data-slot="writing-checks"
          [attr.aria-label]="'editor.writing.list' | transloco"
        >
          @for (item of checks(); track item.id) {
            <ng-container
              *ngTemplateOutlet="
                row;
                context: { $implicit: item, writing: true }
              "
            />
          }
        </ul>
      } @else {
        @switch (checksState()) {
          @case ('loading') {
            <div
              ofFadeIn="delayed"
              class="flex flex-col gap-2"
              role="status"
              aria-busy="true"
              [attr.aria-label]="'editor.writing.loading' | transloco"
            >
              <z-skeleton class="h-4 w-2/3" />
            </div>
          }
          @case ('failed') {
            <p
              ofFadeIn
              class="text-muted-foreground m-0 text-sm leading-5 break-words"
              data-slot="writing-checks-failed"
            >
              {{ 'editor.writing.failed' | transloco }}
            </p>
          }
          @case ('off') {
            <p
              ofFadeIn
              class="text-muted-foreground m-0 text-sm leading-5 break-words"
              data-slot="writing-checks-off"
            >
              {{ 'editor.writing.off' | transloco }}
            </p>
          }
          @default {
            <p
              ofFadeIn
              class="text-muted-foreground m-0 text-sm leading-5 break-words"
              data-slot="writing-checks-none"
            >
              {{ 'editor.writing.none' | transloco }}
            </p>
          }
        }
      }
    </section>

    @if (state() !== 'off') {
      <section
        class="border-border bg-card flex flex-col gap-3 rounded-2xl border p-3.5"
        data-slot="suggestions-panel"
        aria-labelledby="of-style-review-heading"
      >
        <div class="flex flex-col gap-1">
          <h2
            id="of-style-review-heading"
            class="m-0 text-sm leading-5 font-medium"
          >
            {{ 'editor.suggestions.heading' | transloco }}
          </h2>
          <p
            class="text-muted-foreground m-0 text-[0.8125rem] leading-5 break-words"
          >
            {{ 'editor.suggestions.hint' | transloco }}
          </p>
        </div>
        <button
          z-button
          zType="outline"
          type="button"
          class="self-start"
          data-slot="style-review-run"
          [zLoading]="state() === 'loading'"
          [zDisabled]="state() === 'loading' || !!blocked()"
          (click)="review.emit()"
        >
          @if (state() !== 'loading') {
            <ng-icon
              name="lucideSparkles"
              data-icon="inline-start"
              aria-hidden="true"
            />
          }
          {{
            (state() === 'loading'
              ? 'editor.suggestions.reviewing'
              : state() === 'done'
                ? 'editor.suggestions.reviewAgain'
                : 'editor.suggestions.review'
            ) | transloco
          }}
        </button>
        @if (blocked(); as reason) {
          <p class="text-muted-foreground m-0 text-xs leading-5 break-words">
            {{ reason | transloco }}
          </p>
        }
        @if (error(); as message) {
          <p
            class="text-destructive m-0 text-xs leading-5 break-words"
            role="alert"
          >
            {{ message }}
          </p>
        }
        @if (state() === 'loading' && items().length === 0) {
          <div
            ofFadeIn="delayed"
            class="flex flex-col gap-2"
            role="status"
            aria-busy="true"
            [attr.aria-label]="'editor.suggestions.reviewing' | transloco"
          >
            @for (r of [1, 2]; track r) {
              <div
                class="border-border flex flex-col gap-2 rounded-xl border p-3"
              >
                <z-skeleton class="h-3 w-20" />
                <z-skeleton class="h-4 w-full" />
                <z-skeleton class="h-4 w-2/3" />
              </div>
            }
          </div>
        } @else if (state() === 'done' && items().length === 0) {
          <p
            ofFadeIn
            class="text-muted-foreground m-0 text-sm leading-5 break-words"
            data-slot="style-review-empty"
          >
            {{ 'editor.suggestions.none' | transloco }}
          </p>
        }
        @if (items().length > 0) {
          <ul
            class="m-0 flex list-none flex-col gap-2 p-0"
            [attr.aria-label]="'editor.suggestions.list' | transloco"
            [attr.aria-busy]="state() === 'loading' || null"
          >
            @for (item of items(); track item.id) {
              <ng-container
                *ngTemplateOutlet="
                  row;
                  context: { $implicit: item, writing: false }
                "
              />
            }
          </ul>
        }
      </section>
    }
    <div aria-live="polite" class="sr-only">{{ announcement() }}</div>
  `,
})
export class SuggestionsPanelComponent {
  readonly state = input<StyleReviewState>('idle');
  readonly items = input<readonly SuggestionItem[]>([]);
  /** The writing checks' findings, in document order (#247). */
  readonly checks = input<readonly SuggestionItem[]>([]);
  readonly checksState = input<WritingChecksState>('loading');
  /** Why "Review style" cannot run now (a translation key: the text not saved yet), or null. */
  readonly blocked = input<string | null>(null);
  /** Whether suggestions can be applied (the module is edited). */
  readonly editable = input(true);
  /** Why the last review failed, for people; null when it did not. */
  readonly error = input<string | null>(null);
  /** What a screen reader hears after a review or a change ("3 suggestions"). */
  readonly announcement = input('');

  readonly review = output<void>();
  readonly apply = output<SuggestionItem>();
  readonly show = output<SuggestionItem>();
  readonly dismiss = output<SuggestionItem>();

  protected fieldLabel(item: SuggestionItem): string {
    return FIELD_LABELS[item.field];
  }

  protected shown(value: string): string {
    return capped(value, MAX_SHOWN_TEXT);
  }
}
