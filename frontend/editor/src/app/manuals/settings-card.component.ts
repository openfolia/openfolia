import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideSettings2 } from '@ng-icons/lucide';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';

import type { ProjectConfig } from '../content/browser-model';
import { issuesFor, type Issue, type ManualSettings } from './manual-settings';

/**
 * The manual's settings in brief (screen 3, beside Outputs): its audience, how many variant
 * builds it has and how many of the configured text attributes are set, with a count of the
 * content model's issues about them (a word, never colour alone). Its button opens the settings
 * panel, to change them or, read-only, to see them.
 */
@Component({
  selector: 'of-settings-card',
  imports: [TranslocoPipe, NgIcon, ZardBadgeComponent, ZardButtonComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideSettings2 })],
  host: {
    class:
      'flex flex-col gap-2.5 rounded-xl border border-border bg-card p-3.5',
  },
  template: `
    <div class="flex min-w-0 items-center justify-between gap-2">
      <h2 class="m-0 text-sm font-medium" id="settings-heading">
        {{ 'editor.manuals.settings.heading' | transloco }}
      </h2>
      @if (issueCount() > 0) {
        <z-badge
          zType="destructive"
          class="font-normal"
          data-testid="settings-issues"
          >{{
            'editor.manuals.settings.issues'
              | transloco: { count: issueCount() }
          }}</z-badge
        >
      }
    </div>
    <dl
      class="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-[0.8125rem]"
      aria-labelledby="settings-heading"
    >
      <dt class="text-muted-foreground">
        {{ 'editor.manuals.settings.audience.heading' | transloco }}
      </dt>
      <dd class="m-0 break-words" data-testid="card-audience">
        {{
          audience() || ('editor.manuals.settings.audience.none' | transloco)
        }}
      </dd>
      <dt class="text-muted-foreground">
        {{ 'editor.manuals.settings.card.variants' | transloco }}
      </dt>
      <dd class="m-0 break-words" data-testid="card-variants">
        {{ settings()?.variants?.length ?? 0 }}
      </dd>
      <dt class="text-muted-foreground">
        {{ 'editor.manuals.settings.cover.card' | transloco }}
      </dt>
      <dd class="m-0 break-words" data-testid="card-cover">
        {{ coverKey() | transloco: { count: ownCovers() } }}
      </dd>
      @if (config().textAttributes.length > 0) {
        <dt class="text-muted-foreground">
          {{ 'editor.manuals.settings.attributes.heading' | transloco }}
        </dt>
        <dd class="m-0 break-words" data-testid="card-attributes">
          {{
            'editor.manuals.settings.card.attributesSet'
              | transloco
                : {
                    set: attributesSet(),
                    total: config().textAttributes.length,
                  }
          }}
        </dd>
      }
    </dl>
    <button
      z-button
      zType="outline"
      zSize="sm"
      type="button"
      class="self-start"
      data-testid="settings-open"
      [zDisabled]="!settings()"
      (click)="open.emit()"
    >
      <ng-icon
        name="lucideSettings2"
        data-icon="inline-start"
        aria-hidden="true"
      />
      {{
        (editable()
          ? 'editor.manuals.settings.edit'
          : 'editor.manuals.settings.view'
        ) | transloco
      }}
    </button>
  `,
})
export class SettingsCardComponent {
  readonly settings = input<ManualSettings | null>(null);
  readonly config = input.required<ProjectConfig>();
  readonly issues = input<readonly Issue[]>([]);
  readonly editable = input(false);
  readonly open = output<void>();

  protected readonly audience = computed(() => {
    const id = this.settings()?.audience;
    if (id === undefined) return '';
    return this.config().audiences.find((a) => a.id === id)?.label ?? id;
  });

  protected readonly attributesSet = computed(() => {
    const set = this.settings()?.attributes ?? {};
    return this.config().textAttributes.filter((a) => set[a.id] !== undefined)
      .length;
  });

  /** How many variants have a cover image of their own (#394). */
  protected readonly ownCovers = computed(
    () => this.settings()?.coverImage?.variants.length ?? 0,
  );
  /** The manual's cover image in brief: its own, some variants' own, or the design's. */
  protected readonly coverKey = computed(() => {
    const cover = this.settings()?.coverImage;
    if (cover?.variants.length)
      return 'editor.manuals.settings.cover.cardVariants';
    return cover?.default
      ? 'editor.manuals.settings.cover.cardOwn'
      : 'editor.manuals.settings.cover.cardNone';
  });

  /** The issues the panel shows beside a field. */
  protected readonly issueCount = computed(() => {
    const issues = this.issues();
    const settings = this.settings();
    if (!settings) return 0;
    const about = new Set<Issue>([
      ...issuesFor(issues, { kind: 'audience' }),
      ...issuesFor(issues, { kind: 'variants' }),
      ...settings.variants.flatMap((_, index) =>
        issuesFor(issues, { kind: 'variant', index }),
      ),
      ...Object.keys(settings.attributes).flatMap((id) =>
        issuesFor(issues, { kind: 'attribute', id }),
      ),
      ...issuesFor(issues, { kind: 'cover' }),
    ]);
    return about.size;
  });
}
