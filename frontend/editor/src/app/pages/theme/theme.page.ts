import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  signal,
  viewChildren,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { ZardBreadcrumbImports } from '@openfolia/ui/breadcrumb';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { LogoComponent } from '@openfolia/ui/logo';

import { docsConfig } from '../../../docs.config';
import { TOKEN_GROUPS, type TokenGroup } from './theme-tokens';

type Mode = 'light' | 'dark';

/**
 * Screen 0: the theme reference. The logo slots and the main colour tokens with what they are
 * for, as the design draws them; below, every token of `theme.css` with a swatch, its name and its
 * resolved value, in light and dark side by side. Nothing here is
 * hard-coded: values are read from the page's computed style, so changing `theme.css` alone
 * changes this screen.
 */
@Component({
  selector: 'of-theme-page',
  imports: [
    LogoComponent,
    ZardButtonComponent,
    ZardBreadcrumbImports,
    RouterLink,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main class="flex flex-col gap-5 p-4">
      <header class="flex flex-col gap-1">
        <z-breadcrumb
          zSize="sm"
          zSeparator="/"
          [zLabel]="'ui.breadcrumb.label' | transloco"
          class="text-muted-foreground text-xs/5 [&_ol]:gap-1 sm:[&_ol]:gap-1"
        >
          <z-breadcrumb-item>
            <a
              z-breadcrumb-link
              routerLink="/"
              class="focus-visible:ring-ring rounded-sm outline-none focus-visible:ring-2"
              >{{ branding.productName }}</a
            >
          </z-breadcrumb-item>
          <z-breadcrumb-item>
            <span z-breadcrumb-page class="text-muted-foreground">{{
              'editor.theme.reference' | transloco
            }}</span>
          </z-breadcrumb-item>
        </z-breadcrumb>
        <h1 class="text-[1.75rem]/9 font-medium">
          {{ 'editor.theme.title' | transloco }}
        </h1>
        <p class="text-muted-foreground max-w-[760px] text-sm">
          {{ 'editor.theme.intro' | transloco }}
        </p>
      </header>

      <div class="grid gap-4 lg:grid-cols-[minmax(0,569fr)_minmax(0,823fr)]">
        <section
          class="border-border flex flex-col gap-3 rounded-xl border p-4"
          aria-labelledby="theme-logos"
        >
          <h2 id="theme-logos" class="text-xl font-medium">
            {{ 'editor.theme.logos.title' | transloco }}
          </h2>
          <div class="grid gap-4 sm:grid-cols-2">
            @for (slot of logoSlots; track slot.name) {
              <figure class="flex min-w-0 flex-col gap-2">
                <span class="text-muted-foreground text-xs/5">{{
                  slot.label | transloco
                }}</span>
                <div
                  class="border-ring flex h-[120px] items-center justify-center rounded-lg border border-dashed"
                >
                  <of-logo
                    [variant]="slot.variant"
                    [productName]="branding.productName"
                    [small]="branding.logo.small"
                    [smallDark]="branding.logo.smallDark"
                    [full]="branding.logo.full"
                    [fullDark]="branding.logo.fullDark"
                  />
                </div>
                <figcaption class="text-muted-foreground text-xs/5">
                  {{ slot.use | transloco }}
                </figcaption>
              </figure>
            }
          </div>
          <p class="text-muted-foreground text-xs/5 break-words">
            @if (branding.logo.full) {
              {{
                'editor.theme.logos.shownBoth'
                  | transloco
                    : { small: branding.logo.small, full: branding.logo.full }
              }}
            } @else {
              {{
                'editor.theme.logos.shownSmall'
                  | transloco
                    : {
                        small: branding.logo.small,
                        product: branding.productName,
                      }
              }}
            }
          </p>
        </section>

        <section
          class="border-border flex flex-col gap-3 rounded-xl border p-4"
          aria-labelledby="theme-colours"
        >
          <h2 id="theme-colours" class="text-xl font-medium">
            {{ 'editor.theme.colours.title' | transloco }}
          </h2>
          <ul class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            @for (swatch of swatches; track swatch.token) {
              <li class="flex min-w-0 flex-col gap-1.5">
                <span
                  class="ring-border h-12 rounded-lg ring-1 ring-inset"
                  [style.background]="'var(' + swatch.token + ')'"
                  aria-hidden="true"
                ></span>
                <code class="truncate font-mono text-xs/5">{{
                  swatch.token
                }}</code>
                <span class="text-muted-foreground text-xs/5">{{
                  swatch.use | transloco
                }}</span>
              </li>
            }
          </ul>
          <p class="text-muted-foreground text-xs/5">
            {{ 'editor.theme.colours.safetyNote' | transloco }}
          </p>
        </section>
      </div>

      <h2 class="mt-2 text-xl font-medium">
        {{ 'editor.theme.all.title' | transloco }}
      </h2>
      <div class="grid gap-4 lg:grid-cols-2">
        @for (mode of modes; track mode) {
          <section
            #panel
            [attr.data-mode]="mode"
            [class]="
              mode +
              ' ' +
              'flex min-w-0 flex-col gap-5 rounded-xl border border-border bg-background p-4 text-foreground'
            "
            [attr.aria-labelledby]="'theme-' + mode"
          >
            <h3 [id]="'theme-' + mode" class="text-base font-medium">
              {{ modeLabels[mode] | transloco }}
            </h3>

            <div class="flex flex-wrap items-center gap-2">
              <button z-button>
                {{ 'editor.theme.buttons.primary' | transloco }}
              </button>
              <button z-button zType="secondary">
                {{ 'editor.theme.buttons.secondary' | transloco }}
              </button>
              <button z-button zType="outline">
                {{ 'editor.theme.buttons.outline' | transloco }}
              </button>
              <button z-button zType="destructive">
                {{ 'editor.theme.buttons.destructive' | transloco }}
              </button>
            </div>

            <div
              class="flex flex-wrap gap-2"
              [attr.aria-label]="'editor.theme.status.label' | transloco"
            >
              <span
                class="bg-success-muted text-success rounded-md px-2 py-1 text-sm font-medium"
                >{{ 'editor.theme.status.success' | transloco }}</span
              >
              <span
                class="bg-warning-muted text-warning rounded-md px-2 py-1 text-sm font-medium"
                >{{ 'editor.theme.status.warning' | transloco }}</span
              >
              <span
                class="bg-info-muted text-info rounded-md px-2 py-1 text-sm font-medium"
                >{{ 'editor.theme.status.info' | transloco }}</span
              >
              <span
                class="bg-destructive-muted text-destructive rounded-md px-2 py-1 text-sm font-medium"
                >{{ 'editor.theme.status.error' | transloco }}</span
              >
            </div>

            <div
              class="flex flex-wrap gap-2"
              [attr.aria-label]="'editor.theme.safety.label' | transloco"
            >
              <span
                class="bg-safety-danger text-safety-danger-foreground rounded-md px-2 py-1 text-sm font-medium"
                >{{ 'editor.theme.safety.danger' | transloco }}</span
              >
              <span
                class="bg-safety-warning text-safety-warning-foreground rounded-md px-2 py-1 text-sm font-medium"
                >{{ 'editor.theme.safety.warning' | transloco }}</span
              >
              <span
                class="bg-safety-caution text-safety-caution-foreground rounded-md px-2 py-1 text-sm font-medium"
                >{{ 'editor.theme.safety.caution' | transloco }}</span
              >
              <span
                class="bg-safety-notice text-safety-notice-foreground rounded-md px-2 py-1 text-sm font-medium"
                >{{ 'editor.theme.safety.notice' | transloco }}</span
              >
            </div>

            @for (group of groups; track group.title) {
              <div class="flex flex-col gap-2">
                <h4 class="text-sm font-medium">
                  {{ group.title | transloco }}
                </h4>
                <ul
                  class="divide-border border-border flex flex-col divide-y rounded-lg border"
                >
                  @for (token of group.tokens; track token) {
                    <li class="flex items-center gap-3 p-2 text-sm">
                      @switch (group.kind) {
                        @case ('color') {
                          <span
                            class="ring-border size-8 shrink-0 rounded-md ring-1 ring-inset"
                            [style.background]="'var(' + token + ')'"
                            aria-hidden="true"
                          ></span>
                        }
                        @case ('radius') {
                          <span
                            class="border-border bg-muted size-8 shrink-0 border"
                            [style.border-radius]="'var(' + token + ')'"
                            aria-hidden="true"
                          ></span>
                        }
                        @case ('font') {
                          <span
                            class="w-8 shrink-0 text-center text-lg"
                            [style.font-family]="'var(' + token + ')'"
                            aria-hidden="true"
                            >Aa</span
                          >
                        }
                      }
                      <code class="min-w-0 font-mono text-xs break-all">{{
                        token
                      }}</code>
                      <span
                        class="text-muted-foreground ml-auto min-w-0 text-right text-xs break-all"
                        >{{ value(mode, token) }}</span
                      >
                    </li>
                  }
                </ul>
              </div>
            }
          </section>
        }
      </div>
    </main>
  `,
})
export class ThemePage {
  protected readonly branding = docsConfig.branding;
  protected readonly groups: readonly TokenGroup[] = TOKEN_GROUPS;
  protected readonly modes: readonly Mode[] = ['light', 'dark'];
  protected readonly modeLabels: Record<Mode, string> = {
    light: 'ui.theme.light',
    dark: 'ui.theme.dark',
  };
  protected readonly logoSlots = [
    {
      name: 'logo.small',
      label: 'editor.theme.logos.smallLabel',
      variant: 'small' as const,
      use: 'editor.theme.logos.smallUse',
    },
    {
      name: 'logo.full',
      label: 'editor.theme.logos.fullLabel',
      variant: 'full' as const,
      use: 'editor.theme.logos.fullUse',
    },
  ];
  /** The tokens a screen mostly reaches for, with what they are for (translation keys; the full list is below). */
  protected readonly swatches = [
    { token: '--primary', use: 'editor.theme.swatches.primary' },
    {
      token: '--primary-foreground',
      use: 'editor.theme.swatches.primaryForeground',
    },
    { token: '--secondary', use: 'editor.theme.swatches.secondary' },
    { token: '--accent', use: 'editor.theme.swatches.accent' },
    { token: '--background', use: 'editor.theme.swatches.background' },
    { token: '--muted', use: 'editor.theme.swatches.muted' },
    {
      token: '--muted-foreground',
      use: 'editor.theme.swatches.mutedForeground',
    },
    { token: '--border', use: 'editor.theme.swatches.border' },
    { token: '--sidebar', use: 'editor.theme.swatches.sidebar' },
    { token: '--success', use: 'editor.theme.swatches.success' },
    { token: '--warning', use: 'editor.theme.swatches.warning' },
    { token: '--info', use: 'editor.theme.swatches.info' },
    { token: '--destructive', use: 'editor.theme.swatches.destructive' },
    { token: '--safety-danger', use: 'editor.theme.swatches.safetyDanger' },
    { token: '--safety-warning', use: 'editor.theme.swatches.safetyWarning' },
    { token: '--safety-caution', use: 'editor.theme.swatches.safetyCaution' },
  ];

  private readonly panels = viewChildren<ElementRef<HTMLElement>>('panel');
  private readonly resolved = signal<Record<string, string>>({});

  constructor() {
    afterNextRender(() => {
      const values: Record<string, string> = {};
      for (const panel of this.panels()) {
        const el = panel.nativeElement;
        const style = getComputedStyle(el);
        for (const group of TOKEN_GROUPS) {
          for (const token of group.tokens) {
            values[`${el.dataset['mode']}${token}`] = style
              .getPropertyValue(token)
              .trim();
          }
        }
      }
      this.resolved.set(values);
    });
  }

  protected value(mode: Mode, token: string): string {
    return this.resolved()[`${mode}${token}`] ?? '';
  }
}
