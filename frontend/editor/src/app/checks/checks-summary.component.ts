import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCircleCheck,
  lucideCircleX,
  lucideTriangleAlert,
} from '@ng-icons/lucide';
import { firstValueFrom } from 'rxjs';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardSkeletonComponent } from '@openfolia/ui/skeleton';
import { FadeInDirective, RefreshingDirective } from '@openfolia/ui/smooth';

import { ApiClient, pageQuery } from '../api';
import { MeService } from '../permissions/me';

type Counts = { readonly blocking: number; readonly warning: number };

/**
 * A change set's checks in short, for the review screen: how many block it and how many warn,
 * and "Run checks", which opens them (`/checks?changeSet=`, which leaves the
 * person's own change set as it is). Read again for each change
 * set and person; a failed read says so, and the link still leads to the checks.
 */
@Component({
  selector: 'of-checks-summary',
  imports: [
    RouterLink,
    TranslocoPipe,
    NgIcon,
    FadeInDirective,
    RefreshingDirective,
    ZardButtonComponent,
    ZardSkeletonComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({ lucideCircleCheck, lucideCircleX, lucideTriangleAlert }),
  ],
  host: {
    '[class]':
      "compact() ? 'inline-flex' : 'border-border flex flex-col gap-2.5 rounded-xl border p-3.5'",
    '[attr.role]': "compact() ? null : 'region'",
    '[attr.aria-labelledby]': 'compact() ? null : headingId',
  },
  template: `
    @if (compact()) {
      <a
        class="border-border hover:bg-muted focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs outline-none focus-visible:ring-2"
        [routerLink]="['/checks']"
        [queryParams]="{ changeSet: changeSetId() }"
        [ofRefreshing]="loading()"
      >
        <span class="sr-only"
          >{{ 'editor.checks.panel.title' | transloco }}:</span
        >
        @if (counts(); as c) {
          @if (c.blocking > 0) {
            <ng-icon
              name="lucideCircleX"
              class="text-destructive"
              aria-hidden="true"
            />
            {{
              'editor.checks.group.blocking' | transloco: { count: c.blocking }
            }}
          } @else if (c.warning > 0) {
            <ng-icon
              name="lucideTriangleAlert"
              class="text-warning"
              aria-hidden="true"
            />
            {{
              'editor.checks.group.warnings' | transloco: { count: c.warning }
            }}
          } @else {
            <ng-icon
              name="lucideCircleCheck"
              class="text-success"
              aria-hidden="true"
            />
            {{ 'editor.checks.empty.title' | transloco }}
          }
        } @else if (failed()) {
          {{ 'editor.checks.panel.failed' | transloco }}
        } @else {
          <z-skeleton class="h-3 w-20" aria-hidden="true" />
        }
      </a>
    } @else {
      <h2 [id]="headingId" class="m-0 text-sm leading-5 font-medium">
        {{ 'editor.checks.panel.title' | transloco }}
      </h2>
      @if (counts(); as c) {
        <p
          ofFadeIn
          [ofRefreshing]="loading()"
          class="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem] leading-5"
        >
          @if (c.blocking + c.warning === 0) {
            <span class="flex items-center gap-1.5">
              <ng-icon
                name="lucideCircleCheck"
                class="text-success"
                aria-hidden="true"
              />
              {{ 'editor.checks.empty.title' | transloco }}
            </span>
          } @else {
            <span class="flex items-center gap-1.5">
              <ng-icon
                name="lucideCircleX"
                class="text-destructive"
                aria-hidden="true"
              />
              {{
                'editor.checks.group.blocking'
                  | transloco: { count: c.blocking }
              }}
            </span>
            <span class="flex items-center gap-1.5">
              <ng-icon
                name="lucideTriangleAlert"
                class="text-warning"
                aria-hidden="true"
              />
              {{
                'editor.checks.group.warnings' | transloco: { count: c.warning }
              }}
            </span>
          }
        </p>
      } @else if (failed()) {
        <p class="text-muted-foreground m-0 text-[0.8125rem] leading-5">
          {{ 'editor.checks.panel.failed' | transloco }}
        </p>
      } @else {
        <z-skeleton ofFadeIn="delayed" class="h-5 w-40" aria-hidden="true" />
      }
      <a
        z-button
        zType="outline"
        zSize="sm"
        class="self-start"
        [routerLink]="['/checks']"
        [queryParams]="{ changeSet: changeSetId() }"
        >{{ 'editor.checks.panel.run' | transloco }}</a
      >
    }
  `,
})
export class ChecksSummaryComponent {
  private static nextId = 0;
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);

  readonly changeSetId = input.required<string>();
  /** One line, a chip linking to the checks (the review's header), in place of the card. */
  readonly compact = input(false);

  protected readonly headingId = `of-checks-summary-${ChecksSummaryComponent.nextId++}`;
  protected readonly counts = signal<Counts | null>(null);
  protected readonly failed = signal(false);
  protected readonly loading = signal(false);
  private runs = 0;

  constructor() {
    effect(() => {
      const id = this.changeSetId();
      this.me.me();
      untracked(() => void this.load(id));
    });
  }

  private async load(id: string): Promise<void> {
    const run = ++this.runs;
    // Another change set's counts stay, dimmed, until these arrive.
    this.loading.set(true);
    this.failed.set(false);
    try {
      const doc = await firstValueFrom(
        this.api.get('/change-sets/{changeSetId}/checks', {
          path: { changeSetId: id },
          query: pageQuery({ number: 1, size: 1 }),
        }),
      );
      if (run !== this.runs) return;
      this.counts.set(doc.meta.counts);
    } catch {
      if (run !== this.runs) return;
      this.counts.set(null);
      this.failed.set(true);
    }
    this.loading.set(false);
  }
}
