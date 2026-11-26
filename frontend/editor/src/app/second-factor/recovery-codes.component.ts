import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideCopy,
  lucideDownload,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate, translated } from '@openfolia/ui/i18n';
import { FadeInDirective } from '@openfolia/ui/smooth';
import { ToastService } from '@openfolia/ui/toast';

import { FocusOnShowDirective } from './focus-on-show.directive';
import { BrandingService } from '../branding/branding.service';

/** Ten recovery codes, shown **once** (#611), to copy or download as a text file. */
@Component({
  selector: 'of-recovery-codes',
  imports: [
    TranslocoPipe,
    NgIcon,
    ZardButtonComponent,
    FadeInDirective,
    FocusOnShowDirective,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideCopy,
      lucideDownload,
      lucideTriangleAlert,
    }),
  ],
  host: { class: 'block min-w-0' },
  template: `
    <section
      ofFadeIn
      ofFocusOnShow
      tabindex="-1"
      class="border-border bg-muted/40 flex min-w-0 flex-col gap-3 rounded-xl border p-4 outline-none"
      [attr.aria-label]="'editor.secondFactor.recovery.label' | transloco"
    >
      <ul
        data-testid="recovery-codes"
        class="bg-background border-border m-0 grid list-none gap-x-4 gap-y-1.5 rounded-md border p-3 font-mono text-[0.8125rem] leading-5 select-all sm:grid-cols-2"
      >
        @for (code of codes(); track code) {
          <li class="whitespace-nowrap tabular-nums">{{ code }}</li>
        }
      </ul>
      <div class="flex flex-wrap items-center gap-2">
        <button
          z-button
          zType="outline"
          type="button"
          data-testid="recovery-codes-copy"
          (click)="copy()"
        >
          <ng-icon
            data-icon="inline-start"
            aria-hidden="true"
            [name]="copied() ? 'lucideCheck' : 'lucideCopy'"
          />
          {{
            (copied()
              ? 'editor.secondFactor.recovery.copied'
              : 'editor.secondFactor.recovery.copy'
            ) | transloco
          }}
        </button>
        <button
          z-button
          zType="outline"
          type="button"
          data-testid="recovery-codes-download"
          (click)="download()"
        >
          <ng-icon
            name="lucideDownload"
            data-icon="inline-start"
            aria-hidden="true"
          />
          {{ 'editor.secondFactor.recovery.download' | transloco }}
        </button>
        <span class="sr-only" aria-live="polite">{{
          copied() ? ('editor.secondFactor.recovery.copied' | transloco) : ''
        }}</span>
      </div>
      <p
        class="text-muted-foreground m-0 flex items-start gap-2 text-xs break-words"
      >
        <ng-icon
          name="lucideTriangleAlert"
          class="text-warning mt-px shrink-0"
          aria-hidden="true"
        />
        <span class="min-w-0">{{
          'editor.secondFactor.recovery.note' | transloco
        }}</span>
      </p>
    </section>
  `,
})
export class RecoveryCodesComponent {
  readonly codes = input.required<readonly string[]>();

  private readonly toast = inject(ToastService);
  private readonly brand = inject(BrandingService).branding;
  private readonly t = injectTranslate();
  protected readonly copied = signal(false);

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.codes().join('\n'));
      this.copied.set(true);
    } catch {
      this.toast.error(translated('editor.secondFactor.recovery.copyFailed'));
    }
  }

  protected download(): void {
    const text = [
      this.t('editor.secondFactor.recovery.fileTitle', {
        product: this.brand().productName,
        address: location.host,
      }),
      '',
      ...this.codes(),
      '',
    ].join('\n');
    const url = URL.createObjectURL(
      new Blob([text], { type: 'text/plain;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.t('editor.secondFactor.recovery.fileName')}.txt`;
    link.hidden = true;
    document.body.append(link);
    link.click();
    link.remove();
    // Some browsers read the file only after the click.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}
