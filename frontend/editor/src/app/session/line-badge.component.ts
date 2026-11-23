import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideHistory } from '@ng-icons/lucide';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { FadeInDirective } from '@openfolia/ui/smooth';

import { MaintenanceLines } from './maintenance-lines';

/**
 * The product version a revision fixes (#250): shown wherever a revision started on a maintenance
 * line is worked on (the header's picker, the module editor, the review, the content browser).
 * Its product and version in words with an icon, never colour alone, and never the line's branch.
 * Nothing for a revision on `main` (or one whose line is not known yet).
 */
@Component({
  selector: 'of-line-badge',
  imports: [ZardBadgeComponent, NgIcon, TranslocoPipe, FadeInDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideHistory })],
  host: { class: 'contents' },
  template: `
    @if (line(); as l) {
      <span
        z-badge
        zType="info"
        ofFadeIn
        class="max-w-full min-w-0 gap-1 font-normal"
        data-slot="line-badge"
        [attr.title]="
          'editor.maintenance.badgeTitle' | transloco: { line: label() }
        "
      >
        <ng-icon name="lucideHistory" aria-hidden="true" />
        <span class="sr-only">{{
          'editor.maintenance.badgeLabel' | transloco: { line: label() }
        }}</span>
        <span class="min-w-0 truncate" aria-hidden="true">{{ label() }}</span>
      </span>
    }
  `,
})
export class LineBadgeComponent {
  private readonly lines = inject(MaintenanceLines);

  /** The revision's base branch (`baseRef`); nothing is shown for `main` or none. */
  readonly baseRef = input<string | null | undefined>(null);

  protected readonly line = computed(() => this.lines.lineOf(this.baseRef()));
  protected readonly label = computed(() => {
    const line = this.line();
    return line ? this.lines.lineLabel(line) : '';
  });
}
