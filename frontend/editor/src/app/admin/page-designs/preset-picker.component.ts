import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import type { PageDesignPreset } from '@openfolia/content-model/core';

import { PRESETS } from './design-model';

const PRESET_TEXTS: Readonly<
  Record<PageDesignPreset, { name: string; hint: string }>
> = {
  classic: {
    name: 'editor.admin.pageDesigns.layout.presets.classic',
    hint: 'editor.admin.pageDesigns.layout.presets.classicHint',
  },
  'image-led': {
    name: 'editor.admin.pageDesigns.layout.presets.imageLed',
    hint: 'editor.admin.pageDesigns.layout.presets.imageLedHint',
  },
  minimal: {
    name: 'editor.admin.pageDesigns.layout.presets.minimal',
    hint: 'editor.admin.pageDesigns.layout.presets.minimalHint',
  },
};

/**
 * The layout presets as thumbnails (#392): a sketch of each title page in the design's own
 * colours, picked as a radio group (arrow keys move and choose, as a radio group does).
 */
@Component({
  selector: 'of-preset-picker',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-3"
      role="radiogroup"
      [attr.aria-label]="'editor.admin.pageDesigns.layout.title' | transloco"
      (keydown)="move($event)"
    >
      @for (p of presets; track p) {
        @let chosen = p === value();
        <button
          type="button"
          role="radio"
          class="border-border bg-card hover:bg-muted/50 focus-visible:ring-ring/50 flex min-w-0 gap-3 rounded-lg border p-2 text-start outline-none transition-colors duration-150 focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-60 sm:flex-col motion-reduce:transition-none"
          [class.border-foreground]="chosen"
          [class.ring-1]="chosen"
          [class.ring-foreground]="chosen"
          [attr.aria-checked]="chosen"
          [attr.tabindex]="chosen || (!isPreset(value()) && $first) ? 0 : -1"
          [attr.data-preset]="p"
          [disabled]="disabled()"
          (click)="choose(p)"
        >
          <span
            class="relative block aspect-[210/297] w-16 shrink-0 overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-black/10 sm:mx-auto sm:w-24"
            aria-hidden="true"
          >
            @switch (p) {
              @case ('classic') {
                <span
                  class="absolute start-[12%] top-[8%] h-[5%] w-[28%] rounded-[1px]"
                  [style.background]="primary()"
                ></span>
                <span
                  class="absolute start-[12%] top-[36%] h-[6%] w-[70%] rounded-[1px] bg-neutral-800"
                ></span>
                <span
                  class="absolute start-[12%] top-[45%] h-[1.2%] w-[30%]"
                  [style.background]="accent()"
                ></span>
                <span
                  class="absolute start-[12%] top-[51%] h-[2.5%] w-[45%] rounded-[1px] bg-neutral-300"
                ></span>
                <span
                  class="absolute start-[12%] top-[56%] h-[2.5%] w-[38%] rounded-[1px] bg-neutral-300"
                ></span>
                <span
                  class="absolute start-[12%] bottom-[7%] h-[2.5%] w-[60%] rounded-[1px] bg-neutral-300"
                ></span>
              }
              @case ('image-led') {
                <span
                  class="absolute inset-x-0 top-0 h-[50%] bg-neutral-300"
                ></span>
                <span
                  class="absolute inset-x-0 top-[50%] h-[22%]"
                  [style.background]="primary()"
                ></span>
                <span
                  class="absolute start-[12%] top-[55%] h-[5%] w-[65%] rounded-[1px] bg-white"
                ></span>
                <span
                  class="absolute start-[12%] top-[63%] h-[2.5%] w-[40%] rounded-[1px] bg-white/70"
                ></span>
                <span
                  class="absolute start-[12%] bottom-[7%] h-[2.5%] w-[60%] rounded-[1px] bg-neutral-300"
                ></span>
              }
              @default {
                <span
                  class="absolute start-[12%] top-[62%] h-[5%] w-[62%] rounded-[1px] bg-neutral-800"
                ></span>
                <span
                  class="absolute start-[12%] top-[70%] h-[2.5%] w-[36%] rounded-[1px] bg-neutral-300"
                ></span>
                <span
                  class="absolute start-[12%] bottom-[7%] h-[2.5%] w-[50%] rounded-[1px] bg-neutral-300"
                ></span>
              }
            }
          </span>
          <span class="flex min-w-0 flex-col gap-0.5 px-0.5">
            <span class="text-sm font-medium break-words">{{
              texts[p].name | transloco
            }}</span>
            <span class="text-muted-foreground text-xs break-words">{{
              texts[p].hint | transloco
            }}</span>
          </span>
        </button>
      }
    </div>
  `,
})
export class PresetPickerComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly value = input.required<string>();
  readonly primary = input('#1f4e79');
  readonly accent = input('#b45309');
  readonly disabled = input(false);
  readonly valueChange = output<PageDesignPreset>();

  protected readonly presets = PRESETS;
  protected readonly texts = PRESET_TEXTS;

  protected isPreset(value: string): boolean {
    return (PRESETS as readonly string[]).includes(value);
  }

  protected choose(preset: PageDesignPreset): void {
    if (this.disabled() || preset === this.value()) return;
    this.valueChange.emit(preset);
  }

  /** Arrow keys move to the next preset and choose it, as in a radio group. */
  protected move(event: KeyboardEvent): void {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0 || this.disabled()) return;
    event.preventDefault();
    const at = Math.max(0, PRESETS.indexOf(this.value() as PageDesignPreset));
    const next = PRESETS[(at + step + PRESETS.length) % PRESETS.length];
    if (!next) return;
    this.choose(next);
    queueMicrotask(() =>
      this.host.nativeElement
        .querySelector<HTMLButtonElement>(`[data-preset="${next}"]`)
        ?.focus(),
    );
  }
}
