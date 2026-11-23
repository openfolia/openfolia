import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

import { ZardButtonComponent } from '../button/button.component';
import { LanguageChoiceComponent } from '../i18n/language-choice.component';
import { LogoComponent } from '../logo/logo.component';
import { ThemeChoiceComponent } from '../theme/theme-choice.component';
import { ToasterComponent } from '../toast/toaster.component';
import { BaseShowcaseComponent } from './base-showcase.component';
import { ComponentsShowcaseComponent } from './components-showcase.component';
import { StatesShowcaseComponent } from './states-showcase.component';

/**
 * The component showcase: every component of this library on one page, in its variants.
 * Add a section here with each new component. Apps mount it on a route (the editor serves it
 * at `/showcase`), so it is built and tested with the rest and needs no extra tooling.
 */
@Component({
  selector: 'of-showcase',
  imports: [
    ZardButtonComponent,
    LogoComponent,
    StatesShowcaseComponent,
    ComponentsShowcaseComponent,
    BaseShowcaseComponent,
    ToasterComponent,
    ThemeChoiceComponent,
    LanguageChoiceComponent,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="mx-auto flex max-w-6xl flex-col gap-8 p-6">
      <header class="flex flex-wrap items-center justify-between gap-4">
        <h1 class="text-2xl font-semibold">
          {{ 'ui.showcase.title' | transloco }}
        </h1>
        <div class="flex flex-wrap items-end gap-4">
          <of-theme-choice />
          <of-language-choice />
        </div>
      </header>

      <section class="flex flex-col gap-3" aria-labelledby="showcase-button">
        <h2 id="showcase-button" class="text-lg font-medium">
          {{ 'ui.showcase.button.heading' | transloco }}
        </h2>
        <div class="flex flex-wrap items-center gap-2">
          @for (type of buttonTypes; track type) {
            <button z-button [zType]="type">
              {{ typeKeys[type] | transloco }}
            </button>
          }
        </div>
        <div class="flex flex-wrap items-center gap-2">
          @for (size of buttonSizes; track size) {
            <button z-button zType="outline" [zSize]="size">
              {{ sizeKeys[size] | transloco }}
            </button>
          }
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <button z-button zLoading>
            {{ 'ui.states.loading' | transloco }}
          </button>
          <button z-button zDisabled>
            {{ 'ui.showcase.base.disabled' | transloco }}
          </button>
        </div>
      </section>

      <section class="flex flex-col gap-3" aria-labelledby="showcase-logo">
        <h2 id="showcase-logo" class="text-lg font-medium">
          {{ 'ui.showcase.logo' | transloco }}
        </h2>
        <div class="flex flex-wrap items-center gap-6">
          <of-logo
            productName="OpenFolia"
            small="assets/brand/openfolia-mark-color-light.svg"
            smallDark="assets/brand/openfolia-mark-color-dark.svg"
          />
          <of-logo
            variant="full"
            productName="OpenFolia"
            small="assets/brand/openfolia-mark-color-light.svg"
            smallDark="assets/brand/openfolia-mark-color-dark.svg"
          />
          <of-logo
            variant="full"
            productName="OpenFolia"
            small="assets/brand/openfolia-mark-color-light.svg"
            smallDark="assets/brand/openfolia-mark-color-dark.svg"
            full="assets/brand/openfolia-lockup-horizontal-color-light.svg"
            fullDark="assets/brand/openfolia-lockup-horizontal-color-dark.svg"
          />
        </div>
      </section>

      <of-states-showcase />
      <of-components-showcase />
      <of-base-showcase />
      <of-toaster />
    </main>
  `,
})
export class ShowcasePage {
  protected readonly buttonTypes = [
    'default',
    'secondary',
    'outline',
    'ghost',
    'destructive',
    'link',
  ] as const;
  protected readonly buttonSizes = ['xs', 'sm', 'default', 'lg'] as const;
  protected readonly typeKeys = {
    default: 'ui.showcase.button.type.default',
    secondary: 'ui.showcase.button.type.secondary',
    outline: 'ui.showcase.button.type.outline',
    ghost: 'ui.showcase.button.type.ghost',
    destructive: 'ui.showcase.button.type.destructive',
    link: 'ui.showcase.button.type.link',
  } as const;
  protected readonly sizeKeys = {
    xs: 'ui.showcase.button.size.xs',
    sm: 'ui.showcase.button.size.sm',
    default: 'ui.showcase.button.size.default',
    lg: 'ui.showcase.button.size.lg',
  } as const;
}
