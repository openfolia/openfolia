import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCheck, lucideCopy, lucideSmartphone } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { translated } from '@openfolia/ui/i18n';
import { FadeInDirective } from '@openfolia/ui/smooth';
import { ToastService } from '@openfolia/ui/toast';

import type { SetUpBegun } from './second-factor-session';

/**
 * A set-up to take into an authenticator app (#611): the QR code to scan, the key to type
 * instead, and a link that opens an app on this device. The code it then shows is typed into
 * what is projected after it.
 */
@Component({
  selector: 'of-second-factor-set-up',
  imports: [TranslocoPipe, NgIcon, ZardButtonComponent, FadeInDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideCheck, lucideCopy, lucideSmartphone })],
  host: { class: 'block min-w-0' },
  template: `
    <ol ofFadeIn class="m-0 flex list-none flex-col gap-5 p-0">
      <li class="flex min-w-0 flex-col gap-3">
        <p class="m-0 flex items-baseline gap-2.5 text-sm font-medium">
          <span [class]="numberClass" aria-hidden="true">1</span>
          <span class="min-w-0 break-words">{{
            'editor.secondFactor.setUp.scan' | transloco
          }}</span>
        </p>
        <div
          class="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:ps-8"
        >
          <!-- The image brings its own white ground and margin: a scanner needs them, in dark mode too. -->
          <img
            class="border-border size-40 shrink-0 rounded-lg border"
            width="160"
            height="160"
            data-testid="second-factor-qr"
            [src]="qrCode()"
            [alt]="
              'editor.secondFactor.setUp.qrCode'
                | transloco: { account: setUp().account }
            "
          />
          <div class="flex w-full min-w-0 flex-col gap-2">
            <p class="text-muted-foreground m-0 text-xs break-words">
              {{ 'editor.secondFactor.setUp.key' | transloco }}
            </p>
            <code
              class="bg-muted text-foreground block rounded-md px-2.5 py-2 font-mono text-xs leading-5 [overflow-wrap:anywhere] select-all"
              data-testid="second-factor-secret"
              [attr.aria-label]="
                'editor.secondFactor.setUp.keyLabel' | transloco
              "
              ><!-- Two even halves: on one line, or one under the other. -->
              @for (half of grouped(); track $index) {
                <span class="inline-block">{{ half }}</span>{{ ' ' }}
              }
            </code>
            <div class="flex flex-wrap gap-2">
              <button
                z-button
                zType="outline"
                zSize="sm"
                type="button"
                (click)="copy()"
              >
                <ng-icon
                  data-icon="inline-start"
                  aria-hidden="true"
                  [name]="copied() ? 'lucideCheck' : 'lucideCopy'"
                />
                {{
                  (copied()
                    ? 'editor.secondFactor.setUp.keyCopied'
                    : 'editor.secondFactor.setUp.keyCopy'
                  ) | transloco
                }}
              </button>
              <!-- On a phone: opens the app that takes such links. -->
              <a
                z-button
                zType="outline"
                zSize="sm"
                class="sm:hidden"
                [href]="setUp().otpauthUrl"
              >
                <ng-icon
                  name="lucideSmartphone"
                  data-icon="inline-start"
                  aria-hidden="true"
                />
                {{ 'editor.secondFactor.setUp.openApp' | transloco }}
              </a>
              <span class="sr-only" aria-live="polite">{{
                copied()
                  ? ('editor.secondFactor.setUp.keyCopied' | transloco)
                  : ''
              }}</span>
            </div>
          </div>
        </div>
      </li>
      <li class="flex min-w-0 flex-col gap-3">
        <p class="m-0 flex items-baseline gap-2.5 text-sm font-medium">
          <span [class]="numberClass" aria-hidden="true">2</span>
          <span class="min-w-0 break-words">{{
            'editor.secondFactor.setUp.enter' | transloco
          }}</span>
        </p>
        <div class="flex min-w-0 flex-col gap-4 sm:ps-8">
          <ng-content />
        </div>
      </li>
    </ol>
  `,
})
export class SecondFactorSetUpComponent {
  readonly setUp = input.required<SetUpBegun>();

  private readonly toast = inject(ToastService);
  protected readonly copied = signal(false);
  protected readonly numberClass =
    'bg-muted text-foreground inline-flex size-5.5 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums';

  /** An image, not markup: the SVG is never part of the page. */
  protected readonly qrCode = computed(
    () => `data:image/svg+xml;utf8,${encodeURIComponent(this.setUp().qrCode)}`,
  );
  /** In fours, as people read it out, four to a line; apps take it with or without the spaces. */
  protected readonly grouped = computed(
    () =>
      this.setUp()
        .secret.replace(/(.{4})(?=.)/g, '$1 ')
        .match(/.{1,19}(?: |$)/g)
        ?.map((half) => half.trim()) ?? [],
  );

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.setUp().secret);
      this.copied.set(true);
    } catch {
      this.toast.error(translated('editor.secondFactor.setUp.copyFailed'));
    }
  }
}
