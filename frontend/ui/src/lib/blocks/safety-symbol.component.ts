import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideImageOff } from '@ng-icons/lucide';

import { injectTranslate } from '../i18n/text.pipe';
import { ZardSkeletonComponent } from '../skeleton/skeleton.component';
import { ZardTooltipImports } from '../tooltip/tooltip.imports';

/**
 * Where a safety symbol's artwork stands: being read (`loading`), there (`shown`), or none to
 * show (`missing`: the repository has none, or it could not be read).
 */
export type SafetySymbolState = 'loading' | 'shown' | 'missing';

/**
 * A safety symbol (#208): its artwork on a white tile, as printed signs are, with the configured
 * label as its text alternative and tooltip. While the artwork is read a skeleton holds the
 * tile's place. Without artwork it shows the label, marked with a crossed-out picture and "No
 * artwork" in its tooltip and for screen readers: never a broken image. A `shown` symbol whose
 * address is empty or does not load counts as missing. `compact` is the small tile of a menu
 * entry, which shows its label beside it: missing, it is the marked tile alone.
 *
 * Show artwork only from an address that runs nothing: an `<img>` never runs an SVG's script,
 * but an SVG opened from a `blob:` URL of the app's origin would, so the app hands in a raster
 * (the editor rasterises SVG artwork to PNG before making its URL).
 */
@Component({
  selector: 'of-safety-symbol',
  imports: [NgIcon, ZardSkeletonComponent, ...ZardTooltipImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideImageOff })],
  host: {
    class: 'inline-flex shrink-0 align-middle',
    '[attr.data-state]': 'shownState()',
  },
  template: `
    @switch (shownState()) {
      @case ('loading') {
        <z-skeleton
          class="block rounded-sm"
          [class]="tileSize()"
          [attr.aria-label]="label()"
          role="img"
        />
      }
      @case ('shown') {
        <span
          class="inline-flex items-center justify-center rounded-sm bg-safety-symbol-background p-0.5 shadow-xs"
          [class]="tileSize()"
          [zTooltip]="label()"
        >
          <img
            class="size-full object-contain"
            draggable="false"
            [src]="src()"
            [alt]="label()"
            (error)="broken.set(true)"
          />
        </span>
      }
      @default {
        @if (compact()) {
          <span
            class="inline-flex items-center justify-center rounded-sm border border-current/40 text-current/70"
            [class]="tileSize()"
            role="img"
            [attr.aria-label]="missingText()"
            [zTooltip]="missingText()"
            data-slot="symbol-missing"
          >
            <ng-icon name="lucideImageOff" size="12" aria-hidden="true" />
          </span>
        } @else {
          <span
            class="inline-flex items-center gap-1 rounded-sm border border-current/40 px-1.5 text-xs font-medium tracking-normal normal-case"
            [zTooltip]="missingText()"
            data-slot="symbol-missing"
          >
            <ng-icon name="lucideImageOff" size="12" aria-hidden="true" />
            <span>{{ label() }}</span>
            <span class="sr-only">({{ noArtwork() }})</span>
          </span>
        }
      }
    }
  `,
})
export class SafetySymbolComponent {
  private readonly t = injectTranslate();

  /** The configured label (the ID when none is configured): the artwork's text alternative. */
  readonly label = input.required<string>();
  /** The artwork's address; read only when `state` is `shown`. */
  readonly src = input('');
  readonly state = input<SafetySymbolState>('loading');
  /** The small tile of a menu entry. */
  readonly compact = input(false);

  /** Set when a shown artwork fails to load; a new address or state tries again. */
  protected readonly broken = linkedSignal({
    source: () => [this.src(), this.state()] as const,
    computation: () => false,
  });

  protected readonly shownState = computed((): SafetySymbolState => {
    const state = this.state();
    if (state !== 'shown') return state;
    return this.src() && !this.broken() ? 'shown' : 'missing';
  });

  protected readonly tileSize = computed(() =>
    this.compact() ? 'size-5' : 'size-7',
  );

  protected readonly noArtwork = computed(() =>
    this.t('ui.blocks.safety.noArtwork'),
  );
  protected readonly missingText = computed(() =>
    this.t('ui.blocks.safety.symbolWithoutArtwork', { label: this.label() }),
  );
}
