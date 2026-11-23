import { injectTranslate } from '../i18n/text.pipe';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideLink } from '@ng-icons/lucide';

import { ZardSkeletonComponent } from '../skeleton/skeleton.component';
import { ZardTooltipImports } from '../tooltip/tooltip.imports';

/** What of the module is placed: all of it, one block, or a link to it. */
export type ModuleReferenceMode = 'module' | 'block' | 'link';

const modeLabels: Record<ModuleReferenceMode, string> = {
  module: 'ui.blocks.reference.module',
  block: 'ui.blocks.reference.block',
  link: 'ui.blocks.reference.link',
};

/**
 * A card pointing at another module: title, a "shared module" mark, the mode and an Open link.
 * While `loading`, a skeleton stands in for the title; `problem` marks the line under it as one
 * (a module that can't be found); with `actionDisabledReason` the action stays in view, disabled,
 * and says why.
 */
@Component({
  selector: 'of-module-reference-card',
  imports: [NgIcon, ZardSkeletonComponent, ...ZardTooltipImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideLink })],
  host: {
    class:
      'flex items-center gap-3 rounded-xl border border-border bg-card p-3 text-card-foreground',
    '[attr.data-mode]': 'mode()',
  },
  template: `
    <span
      class="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-lg"
      aria-hidden="true"
    >
      <ng-icon name="lucideLink" size="16" strokeWidth="1.5" />
    </span>
    <div class="min-w-0 flex-1">
      @if (loading()) {
        <z-skeleton class="my-0.5 h-4 w-40 max-w-full" />
      } @else {
        <p class="m-0 text-sm font-medium break-words">{{ title() }}</p>
      }
      <p
        class="m-0 mt-0.5 text-xs break-words"
        [class.text-muted-foreground]="!problem()"
        [class.text-destructive]="problem()"
      >
        {{ subtitle() }}
      </p>
    </div>
    @if (href()) {
      <a
        class="inline-flex shrink-0 items-center gap-1 rounded-md px-1 text-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        [href]="href()"
        (click)="open.emit()"
      >
        {{ openText() }}
      </a>
    } @else {
      <button
        type="button"
        class="inline-flex shrink-0 items-center gap-1 rounded-md px-1 text-sm font-medium text-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground aria-disabled:no-underline"
        [attr.aria-disabled]="actionDisabledReason() ? 'true' : null"
        [zTooltip]="actionDisabledReason()"
        (click)="actionDisabledReason() || open.emit()"
      >
        {{ openText() }}
      </button>
    }
  `,
})
export class ModuleReferenceCardComponent {
  readonly title = input.required<string>();
  readonly mode = input<ModuleReferenceMode>('module');
  readonly shared = input(false);
  /** Where "Open" goes. Without it, "Open" is a button that emits `open`. */
  readonly href = input('');
  /** Default: "Open", translated. */
  readonly openLabel = input('');
  /** Default: "Shared module", translated. */
  readonly sharedLabel = input('');
  /** Replaces the default mode word. */
  readonly modeLabel = input('');
  readonly open = output<void>();
  /** The title is still being looked up: a skeleton in its place. */
  readonly loading = input(false);
  /** The line under the title reports a problem (shown in the destructive colour, in words). */
  readonly problem = input(false);
  /** Why the action can't be used now; non-empty disables it and shows the reason as its tooltip. */
  readonly actionDisabledReason = input('');

  /** A line under the title, e.g. "included here, edited in its own place". */
  readonly description = input('');

  private readonly t = injectTranslate();
  protected readonly openText = computed(
    () => this.openLabel() || this.t('ui.blocks.reference.open'),
  );

  /** "Shared module · description", or the mode word when there is nothing else to say. */
  protected readonly subtitle = computed(() =>
    [
      this.shared()
        ? this.sharedLabel() || this.t('ui.blocks.reference.shared')
        : '',
      this.description() || this.modeLabel() || this.t(modeLabels[this.mode()]),
    ]
      .filter(Boolean)
      .join(' · '),
  );
}
