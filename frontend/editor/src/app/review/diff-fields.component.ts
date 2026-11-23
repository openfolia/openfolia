import { NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { StatusBadgeComponent } from '@openfolia/ui/badges';
import {
  DiffDeletedComponent,
  DiffInsertedComponent,
} from '@openfolia/ui/diff-marks';
import { injectTranslate } from '@openfolia/ui/i18n';

import type { FieldDiff } from './meta-diff';

/**
 * The details of an item that changed, as a compact table: the field, its value before and
 * after, with what was taken away struck through and what was added underlined. Each row is a
 * change the navigation visits. On a narrow screen each field's two values stack.
 */
@Component({
  selector: 'of-diff-fields',
  imports: [
    NgTemplateOutlet,
    TranslocoPipe,
    DiffInsertedComponent,
    DiffDeletedComponent,
    StatusBadgeComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'border-border block overflow-hidden rounded-lg border',
    role: 'table',
    '[attr.aria-label]': 'label()',
  },
  template: `
    <div
      class="bg-muted/50 text-muted-foreground border-border hidden grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)] gap-x-4 border-b px-3 py-1.5 text-xs font-medium sm:grid"
      role="row"
    >
      <span role="columnheader">{{
        'editor.review.meta.field.name' | transloco
      }}</span>
      <span role="columnheader">{{
        'editor.review.diff.before' | transloco
      }}</span>
      <span role="columnheader">{{
        'editor.review.diff.after' | transloco
      }}</span>
    </div>
    @for (f of fields(); track f.field) {
      <div
        class="border-border grid scroll-mt-24 grid-cols-1 gap-x-4 gap-y-1 border-b px-3 py-2 text-[0.8125rem] leading-5 outline-none last:border-b-0 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[current]:ring-2 data-[current]:ring-ring data-[current]:ring-inset sm:grid-cols-[8rem_minmax(0,1fr)_minmax(0,1fr)]"
        role="row"
        data-hunk="field"
        tabindex="-1"
      >
        <span role="rowheader" class="font-medium">{{
          f.field | transloco
        }}</span>
        <span role="cell" class="break-words">
          <span class="text-muted-foreground me-1 text-xs sm:hidden">{{
            'editor.review.diff.before' | transloco
          }}</span>
          @if (f.deprecation && f.before.length > 0) {
            <of-status-badge class="me-1.5 align-middle" status="deprecated" />
          }
          <ng-container
            *ngTemplateOutlet="value; context: { $implicit: f.before }"
          />
        </span>
        <span role="cell" class="break-words">
          <span class="text-muted-foreground me-1 text-xs sm:hidden">{{
            'editor.review.diff.after' | transloco
          }}</span>
          @if (f.deprecation && f.after.length > 0) {
            <of-status-badge class="me-1.5 align-middle" status="deprecated" />
          }
          <ng-container
            *ngTemplateOutlet="value; context: { $implicit: f.after }"
          />
        </span>
      </div>
    }

    <ng-template #value let-segments>
      @for (s of segments; track $index) {
        @if (s.op === 'ins') {
          <ins of-diff-inserted>{{ s.text }}</ins>
        } @else if (s.op === 'del') {
          <del of-diff-deleted>{{ s.text }}</del>
        } @else {
          <span>{{ s.text }}</span>
        }
      } @empty {
        <span class="text-muted-foreground">{{
          'editor.review.meta.none' | transloco
        }}</span>
      }
    </ng-template>
  `,
})
export class DiffFieldsComponent {
  private readonly t = injectTranslate();

  readonly fields = input.required<readonly FieldDiff[]>();
  protected readonly label = computed(() => this.t('editor.review.meta.label'));
}
