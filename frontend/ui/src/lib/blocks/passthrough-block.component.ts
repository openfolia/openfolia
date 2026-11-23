import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideChevronDown, lucideFileWarning } from '@ng-icons/lucide';

import { CollapseComponent } from '../collapse/collapse.component';

/** How much of the source the closed box shows, on one line. */
const PREVIEW_CHARS = 120;

/**
 * Content kept verbatim because it could not be converted (an importer's escape hatch): a
 * labelled, read-only box with its source format and the start of its source, which "Show source"
 * opens in full (smoothly; at once under reduced motion). The source is only ever text.
 */
@Component({
  selector: 'of-passthrough-block',
  imports: [NgIcon, TranslocoPipe, CollapseComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideChevronDown, lucideFileWarning })],
  host: {
    role: 'group',
    '[attr.aria-label]': 'label()',
    class:
      'block rounded-md border border-dashed border-border bg-muted/60 px-3 py-2 text-sm',
  },
  template: `
    <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <ng-icon
        name="lucideFileWarning"
        class="shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span class="font-medium">{{ label() }}</span>
      @if (format()) {
        <span
          class="rounded-sm border border-border bg-background px-1.5 font-mono text-xs break-all"
          data-format
          >{{ format() }}</span
        >
      }
      @if (note()) {
        <span class="text-xs text-muted-foreground">{{ note() }}</span>
      }
      <button
        type="button"
        class="ms-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        [attr.aria-expanded]="open()"
        (click)="open.set(!open())"
      >
        {{
          (open() ? 'ui.blocks.passthrough.hide' : 'ui.blocks.passthrough.show')
            | transloco
        }}
        <ng-icon
          name="lucideChevronDown"
          class="transition-transform duration-200 motion-reduce:transition-none"
          [class.rotate-180]="open()"
          aria-hidden="true"
        />
      </button>
    </div>
    @if (!open() && preview()) {
      <p
        class="m-0 mt-1 truncate font-mono text-xs text-muted-foreground"
        data-preview
      >
        {{ preview() }}
      </p>
    }
    <of-collapse [open]="open()">
      <pre
        class="m-0 mt-2 max-h-80 overflow-auto rounded-sm bg-background p-2 font-mono text-xs leading-5 whitespace-pre-wrap [overflow-wrap:anywhere]"
        data-source
        >{{ source() }}</pre>
    </of-collapse>
  `,
})
export class PassthroughBlockComponent {
  /** The block's name ("Unconverted content"). */
  readonly label = input.required<string>();
  /** The source format ("xml"). */
  readonly format = input('');
  /** The source, shown as text. */
  readonly source = input('');
  /** A short note after the label ("Read-only"). */
  readonly note = input('');

  protected readonly open = signal(false);
  protected readonly preview = computed(() => {
    const line = this.source().replace(/\s+/g, ' ').trim();
    return line.length > PREVIEW_CHARS
      ? `${line.slice(0, PREVIEW_CHARS - 1)}…`
      : line;
  });
}
