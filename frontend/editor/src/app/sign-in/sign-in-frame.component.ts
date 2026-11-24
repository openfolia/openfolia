import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';

import { LanguageChoiceComponent } from '@openfolia/ui/i18n';
import { LogoComponent } from '@openfolia/ui/logo';
import { ThemeChoiceComponent } from '@openfolia/ui/theme';
import { ToasterComponent } from '@openfolia/ui/toast';

import { AboutLinksComponent } from '../about/about-links.component';
import { BrandingService } from '../branding/branding.service';
import { SandboxBannerComponent } from '../sandbox/sandbox-banner.component';
import { SandboxSession } from '../sandbox/sandbox-session';

/**
 * The branded frame of the pages before signing in (#610: "Forgot password", the page a
 * one-time link opens): the logo, a card with the heading and what is projected, the theme and
 * language choices, and the source and licence links. The sign-in page itself has its own.
 */
@Component({
  selector: 'of-sign-in-frame',
  imports: [
    LogoComponent,
    ThemeChoiceComponent,
    LanguageChoiceComponent,
    ToasterComponent,
    AboutLinksComponent,
    SandboxBannerComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <main
      class="bg-background text-foreground flex min-h-dvh justify-center overflow-x-hidden px-4 py-10 sm:items-center"
    >
      <div class="flex w-full max-w-md min-w-0 flex-col gap-6">
        @if (sandbox.on()) {
          <of-sandbox-banner />
        }
        <div class="flex justify-center">
          <of-logo
            variant="full"
            [productName]="brand().productName"
            [small]="brand().logo.small"
            [smallDark]="brand().logo.smallDark"
            [full]="brand().logo.full"
            [fullDark]="brand().logo.fullDark"
          />
        </div>
        <section
          class="border-border bg-card text-card-foreground flex flex-col gap-4 rounded-xl border p-6 shadow-sm"
          aria-labelledby="sign-in-frame-title"
          [attr.aria-busy]="busy()"
        >
          <header class="flex flex-col gap-1">
            <h1
              id="sign-in-frame-title"
              class="m-0 text-xl/7 font-medium break-words"
            >
              {{ heading() }}
            </h1>
            @if (intro()) {
              <p class="text-muted-foreground m-0 text-sm break-words">
                {{ intro() }}
              </p>
            }
          </header>
          <ng-content />
        </section>
        <div class="grid gap-4 sm:grid-cols-2">
          <of-theme-choice />
          <of-language-choice />
        </div>
        <of-about-links />
      </div>
    </main>
    <of-toaster />
  `,
})
export class SignInFrameComponent {
  readonly heading = input.required<string>();
  readonly intro = input('');
  readonly busy = input(false);
  protected readonly brand = inject(BrandingService).branding;
  protected readonly sandbox = inject(SandboxSession);
}
