import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardTableImports } from '@openfolia/ui/table';

/** One output language: how many of the manual's modules it lacks (they fall back to the source). */
export interface OutputLanguage {
  readonly lang: string;
  readonly label: string;
  /** Modules of the manual not written in this language; 0 for the source language. */
  readonly missing: number;
  /** Modules of the manual written in it. */
  readonly present: number;
}

export type Coverage = 'complete' | 'partial' | 'none';

export function coverageOf(language: OutputLanguage): Coverage {
  if (language.missing === 0) return 'complete';
  return language.present === 0 ? 'none' : 'partial';
}

/**
 * The outputs of a manual per language (screen 3, "Outputs"): the portal and the PDF, each with
 * how complete that language is (a word, never colour alone), and the variant builds each is made for. Choosing a language is what the
 * preview and the PDF preview show; a note says what falls back to the source language.
 */
@Component({
  selector: 'of-outputs-card',
  imports: [TranslocoPipe, ZardBadgeComponent, ZardTableImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class:
      'flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5',
  },
  template: `
    <h2 class="m-0 text-sm font-medium" id="outputs-heading">
      {{ 'editor.manuals.outputs.heading' | transloco }}
    </h2>
    <div class="min-w-0 overflow-x-auto">
      <table z-table class="text-[0.8125rem]" aria-labelledby="outputs-heading">
        <thead z-table-header>
          <tr z-table-row>
            <th z-table-head>
              {{ 'editor.manuals.outputs.language' | transloco }}
            </th>
            <th z-table-head>
              {{ 'editor.manuals.outputs.portal' | transloco }}
            </th>
            <th z-table-head>{{ 'editor.manuals.outputs.pdf' | transloco }}</th>
          </tr>
        </thead>
        <tbody z-table-body>
          @for (language of languages(); track language.lang) {
            @let coverage = coverageOf(language);
            <tr
              z-table-row
              class="cursor-pointer"
              [attr.data-state]="
                language.lang === selected() ? 'selected' : null
              "
              [attr.data-lang]="language.lang"
              (click)="choose.emit(language.lang)"
            >
              <td z-table-cell class="whitespace-normal break-words">
                <button
                  type="button"
                  class="rounded-sm text-start outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  [class.font-medium]="language.lang === selected()"
                  [attr.aria-pressed]="language.lang === selected()"
                  [attr.aria-label]="
                    'editor.manuals.outputs.choose'
                      | transloco: { language: language.label }
                  "
                  (click)="$event.stopPropagation(); choose.emit(language.lang)"
                >
                  {{ language.label }}
                </button>
              </td>
              @for (kind of outputs; track kind) {
                <td z-table-cell class="whitespace-normal">
                  @switch (coverage) {
                    @case ('complete') {
                      <z-badge zType="success" class="font-normal">{{
                        'editor.manuals.outputs.complete' | transloco
                      }}</z-badge>
                    }
                    @case ('partial') {
                      <z-badge zType="warning" class="font-normal">{{
                        'editor.manuals.outputs.partial' | transloco
                      }}</z-badge>
                    }
                    @default {
                      <z-badge zType="secondary" class="font-normal">{{
                        'editor.manuals.outputs.none' | transloco
                      }}</z-badge>
                    }
                  }
                </td>
              }
            </tr>
          }
        </tbody>
      </table>
    </div>
    @if (variants().length > 0) {
      <p
        class="m-0 text-xs break-words text-muted-foreground"
        data-testid="outputs-variants"
      >
        {{
          'editor.manuals.outputs.variants'
            | transloco
              : { count: variants().length, variants: variants().join(', ') }
        }}
      </p>
    }
    @for (language of fallbacks(); track language.lang) {
      <p class="m-0 text-xs break-words text-muted-foreground">
        {{
          'editor.manuals.outputs.fallback'
            | transloco
              : {
                  language: language.label,
                  count: language.missing,
                  source: sourceLabel(),
                }
        }}
      </p>
    }
  `,
})
export class OutputsCardComponent {
  readonly languages = input.required<readonly OutputLanguage[]>();
  readonly selected = input<string | null>(null);
  readonly sourceLabel = input('');
  /** The variant builds (their labels): each language is built for every one. */
  readonly variants = input<readonly string[]>([]);
  readonly choose = output<string>();

  protected readonly outputs = ['portal', 'pdf'] as const;
  protected readonly coverageOf = coverageOf;
  protected readonly fallbacks = computed(() =>
    this.languages().filter((l) => coverageOf(l) === 'partial'),
  );
}
