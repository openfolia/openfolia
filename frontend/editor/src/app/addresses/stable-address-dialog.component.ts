import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  model,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCopy, lucideDownload } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';

import {
  linkText,
  qrFileName,
  StableAddresses,
  type ShownAddress,
} from './stable-addresses';

type Which = 'latest' | 'pinned';

/**
 * A manual's stable addresses in one variant and language (#450): the latest one, to print (it
 * always opens the newest release), and the release's own, pinned for good; each with Copy, and
 * the QR code of the latest with Download as SVG (for print) or PNG. Who may open them is said
 * plainly (`delivery.access`); without `CCMS_PUBLIC_URL` the addresses are paths and there is no
 * QR code, and the dialog says why.
 */
@Component({
  selector: 'of-stable-address-dialog',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    ZardInputComponent,
    ZardSkeletonComponent,
    TranslocoPipe,
    NgIcon,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideCopy, lucideDownload })],
  template: `
    <z-dialog [(zVisible)]="open" class="sm:max-w-[36rem]">
      <z-dialog-header>
        <z-dialog-title class="break-words">{{
          'editor.addresses.title' | transloco: { name: name() }
        }}</z-dialog-title>
        <z-dialog-description>{{
          'editor.addresses.description' | transloco
        }}</z-dialog-description>
      </z-dialog-header>
      @if (open()) {
        @if (address(); as a) {
          <div class="flex min-w-0 flex-col gap-4" data-slot="address-body">
            <p
              class="text-muted-foreground m-0 text-sm break-words"
              data-slot="address-access"
              [attr.data-access]="a.settings.access"
            >
              {{ accessText[a.settings.access] | transloco }}
            </p>
            @for (w of whiches; track w.which) {
              @let which = w.which;
              @let link = a.item.attributes[which].html;
              <div class="flex min-w-0 flex-col gap-1.5">
                <label class="text-sm font-medium" [for]="'address-' + which">{{
                  w.label | transloco
                }}</label>
                <div class="flex min-w-0 gap-2">
                  <input
                    z-input
                    readonly
                    class="min-w-0 flex-1 font-mono text-xs"
                    [id]="'address-' + which"
                    [attr.data-address]="which"
                    [value]="text(link)"
                    (focus)="$any($event.target).select()"
                  />
                  <button
                    z-button
                    zType="outline"
                    type="button"
                    [attr.aria-label]="
                      'editor.addresses.copyLabel'
                        | transloco: { which: (w.label | transloco) }
                    "
                    (click)="copy(text(link))"
                  >
                    <ng-icon
                      name="lucideCopy"
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    {{ 'editor.addresses.copy' | transloco }}
                  </button>
                </div>
                <p class="text-muted-foreground m-0 text-xs break-words">
                  {{ w.hint | transloco }}
                </p>
              </div>
            }
            @if (a.settings.publicUrl === null) {
              <p
                class="text-muted-foreground m-0 text-sm break-words"
                data-slot="address-no-url"
              >
                {{ 'editor.addresses.noPublicUrl' | transloco }}
              </p>
            } @else {
              <div class="flex min-w-0 flex-wrap items-center gap-4">
                <div
                  class="size-36 shrink-0 overflow-hidden rounded-md border border-border bg-safety-symbol-background p-1"
                >
                  @if (qrFailed()) {
                    <p
                      class="text-muted-foreground m-0 p-1 text-xs break-words"
                      role="status"
                      data-slot="address-qr-failed"
                    >
                      {{ 'editor.addresses.qrFailed' | transloco }}
                    </p>
                  } @else if (qr(); as src) {
                    <img
                      class="size-full"
                      data-slot="address-qr"
                      [src]="src"
                      [alt]="
                        'editor.addresses.qrAlt'
                          | transloco
                            : { url: text(a.item.attributes.latest.html) }
                      "
                    />
                  } @else {
                    <z-skeleton class="size-full" />
                  }
                </div>
                <div class="flex min-w-0 flex-col gap-2">
                  <p class="m-0 text-sm font-medium">
                    {{ 'editor.addresses.qr' | transloco }}
                  </p>
                  <div class="flex flex-wrap gap-2">
                    @for (f of formats; track f.format) {
                      @let format = f.format;
                      <button
                        z-button
                        zType="outline"
                        zSize="sm"
                        type="button"
                        [attr.data-download]="format"
                        (click)="save(format)"
                      >
                        <ng-icon
                          name="lucideDownload"
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        {{ f.label | transloco }}
                      </button>
                    }
                  </div>
                  <p class="text-muted-foreground m-0 text-xs break-words">
                    {{ 'editor.addresses.qrHint' | transloco }}
                  </p>
                </div>
              </div>
            }
          </div>
        } @else if (loading()) {
          <div class="flex flex-col gap-3" aria-busy="true">
            <z-skeleton class="h-9 w-full" />
            <z-skeleton class="h-9 w-full" />
          </div>
        } @else {
          <p class="m-0 text-sm break-words" role="status">
            {{ failure() ?? 'editor.addresses.none' | transloco }}
          </p>
        }
      }
      <z-dialog-footer>
        <button z-button zType="ghost" type="button" z-dialog-close>
          {{ 'editor.addresses.close' | transloco }}
        </button>
      </z-dialog-footer>
    </z-dialog>
  `,
})
export class StableAddressDialogComponent {
  private readonly addresses = inject(StableAddresses);

  readonly open = model(false);
  /** What it is the address of, as people read it ("Operating manual, Large · English"). */
  readonly name = input('');
  /** The address shown; null while it is looked up, or when there is none. */
  readonly address = input<ShownAddress | null>(null);
  /** It is being looked up. */
  readonly loading = input(false);
  /** Why it could not be looked up (a translation key); null when nothing failed. */
  readonly failure = input<string | null>(null);

  protected readonly whiches: readonly {
    which: Which;
    label: string;
    hint: string;
  }[] = [
    {
      which: 'latest',
      label: 'editor.addresses.latest',
      hint: 'editor.addresses.latestHint',
    },
    {
      which: 'pinned',
      label: 'editor.addresses.pinned',
      hint: 'editor.addresses.pinnedHint',
    },
  ];
  protected readonly formats = [
    { format: 'svg', label: 'editor.addresses.download.svg' },
    { format: 'png', label: 'editor.addresses.download.png' },
  ] as const;
  protected readonly accessText: Readonly<Record<string, string>> = {
    public: 'editor.addresses.access.public',
    'signed-in': 'editor.addresses.access.signed-in',
    off: 'editor.addresses.access.off',
  };
  protected readonly text = linkText;
  protected readonly qr = signal<string | null>(null);
  protected readonly qrFailed = signal(false);

  private readonly latestPath = computed(() => {
    const a = this.address();
    return this.open() && a && a.settings.publicUrl !== null
      ? a.item.attributes.latest.html.path
      : null;
  });

  constructor() {
    let shown: string | null = null;
    // Each read's number: an answer to an older one (another address, the dialog closed and
    // opened again, or gone) is revoked, never shown.
    let reads = 0;
    const drop = () => {
      reads += 1;
      if (shown) URL.revokeObjectURL(shown);
      shown = null;
      this.qr.set(null);
      this.qrFailed.set(false);
    };
    // The latest address's QR code, read again for another address.
    effect(() => {
      const path = this.latestPath();
      untracked(() => {
        drop();
        if (!path) return;
        const read = reads;
        void this.addresses.preview(path).then(
          (url) => {
            if (read !== reads) {
              URL.revokeObjectURL(url);
              return;
            }
            shown = url;
            this.qr.set(url);
          },
          () => {
            if (read === reads) this.qrFailed.set(true);
          },
        );
      });
    });
    inject(DestroyRef).onDestroy(drop);
  }

  protected copy(text: string): void {
    void this.addresses.copy(text);
  }

  protected save(format: 'svg' | 'png'): void {
    const a = this.address();
    if (!a) return;
    void this.addresses.save(
      a.item.attributes.latest.html.path,
      format,
      qrFileName(a.item, false),
    );
  }
}
