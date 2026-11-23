import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideClock,
  lucidePencilLine,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

/**
 * Where the autosave stands. `draft`: not saved yet because of a normal step of writing (a new
 * block still incomplete), nothing wrong; `not-saved`: a real failure (offline, refused, a
 * conflict), the only state in the destructive colour.
 */
export type SaveStatus = 'saved' | 'saving' | 'draft' | 'not-saved';

const labels: Record<SaveStatus, string> = {
  saved: 'ui.states.save.saved',
  saving: 'ui.states.save.saving',
  draft: 'ui.states.save.draft',
  'not-saved': 'ui.states.save.notSaved',
};
const icons: Record<SaveStatus, string> = {
  saved: 'lucideCheck',
  saving: 'lucideClock',
  draft: 'lucidePencilLine',
  'not-saved': 'lucideTriangleAlert',
};

/**
 * The editor header's autosave state: an icon and a word, never colour alone. A change of state
 * fades the new one in where the old one stood (the colour follows smoothly), so nothing moves
 * around it; at once under reduced motion.
 */
@Component({
  selector: 'of-save-status',
  imports: [NgIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideClock,
      lucidePencilLine,
      lucideTriangleAlert,
    }),
  ],
  host: {
    class:
      'inline-flex items-center gap-1.5 text-sm transition-colors duration-200 ease-out motion-reduce:transition-none',
    '[class.text-foreground]': "status() === 'saved'",
    '[class.text-muted-foreground]':
      "status() === 'saving' || status() === 'draft'",
    '[class.text-destructive]': "status() === 'not-saved'",
    role: 'status',
    '[attr.data-status]': 'status()',
  },
  template: `
    @for (s of [status()]; track s) {
      <span
        class="flex shrink-0"
        [class.text-success]="s === 'saved'"
        animate.enter="of-status-enter"
        aria-hidden="true"
      >
        <ng-icon [name]="icon()" />
      </span>
      <span class="min-w-0 truncate" animate.enter="of-status-enter"
        >{{ label() | transloco }}
        @if (detail()) {
          {{ separated() ? '· ' : '' }}{{ detail() }}
        }
      </span>
    }
  `,
})
export class SaveStatusComponent {
  readonly status = input<SaveStatus>('saved');
  /** When it was saved ("just now"), or why it is not ("offline. Changes are kept in this browser."). */
  readonly detail = input('');
  protected readonly label = computed(() => labels[this.status()]);
  protected readonly icon = computed(() => icons[this.status()]);
  /** A reason follows its word after a dot; a time ("just now") follows "Saved" as it is. */
  protected readonly separated = computed(
    () => this.status() === 'not-saved' || this.status() === 'draft',
  );
}
