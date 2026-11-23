import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';

/**
 * "Submit for review" for a change set that changes the project configuration (#91): says what
 * its review needs (a configuration change needs the review and the sign-off of every restricted
 * module type, #21) before the change set leaves the person's hands, since a submitted change set
 * comes back only when a reviewer returns it.
 */
@Component({
  selector: 'of-submit-review-dialog',
  imports: [ZardDialogImports, ZardButtonComponent, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <z-dialog
      [zVisible]="open()"
      (zVisibleChange)="$event || closed.emit()"
      class="sm:max-w-[30rem]"
    >
      <z-dialog-header>
        <z-dialog-title class="break-words">{{
          'editor.admin.variants.submit.title'
            | transloco: { title: changeSet() }
        }}</z-dialog-title>
        <z-dialog-description class="break-words">{{
          'editor.admin.variants.submit.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      <ul
        class="m-0 flex list-disc flex-col gap-1 ps-5 text-sm"
        data-slot="submit-needs"
      >
        <li>{{ 'editor.admin.variants.submit.review' | transloco }}</li>
        @for (t of signOffs(); track t) {
          <li class="break-words">
            {{
              'editor.admin.variants.submit.signOff' | transloco: { type: t }
            }}
          </li>
        }
      </ul>
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" (click)="closed.emit()">
          {{ 'editor.admin.cancel' | transloco }}
        </button>
        <button
          z-button
          type="button"
          data-slot="submit-confirm"
          [disabled]="busy()"
          (click)="confirm.emit()"
        >
          {{ 'editor.review.actions.submit' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class SubmitReviewDialogComponent {
  readonly open = input(false);
  /** The change set's title. */
  readonly changeSet = input('');
  /** The labels of the restricted module types: each needs its sign-off. */
  readonly signOffs = input<readonly string[]>([]);
  readonly busy = input(false);

  readonly confirm = output<void>();
  readonly closed = output<void>();
}
