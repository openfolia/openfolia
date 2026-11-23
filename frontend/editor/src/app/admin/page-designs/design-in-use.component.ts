import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideCircleAlert, lucidePalette } from '@ng-icons/lucide';

import { injectTranslate } from '@openfolia/ui/i18n';

import type { Schema } from '../../api';
import { PermissionService } from '../../permissions/permission.service';
import { ChangeSetUrl } from '../../session/change-set-url';

/** The page design a manual is printed with, as the API names it (`meta.design`, #589). */
export type DesignInUse = Schema<'DesignInUse'>;

const BUILTIN = 'builtin';

/**
 * Names the page design a manual is printed with (#589): "Design: Classic, project default",
 * "Design: Service, this manual's own" or "Design: Built-in design", linked to the design (the
 * list, for the built-in one) for whoever may open Admin › Page design, with a warning when the
 * design named is not in the content (the built-in design is used then).
 */
@Component({
  selector: 'of-design-in-use',
  imports: [RouterLink, TranslocoPipe, NgIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideCircleAlert, lucidePalette })],
  host: {
    class: 'inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5',
    'data-slot': 'design-in-use',
    '[attr.data-design]': 'design().id',
    '[attr.data-source]': 'design().source',
  },
  template: `
    <ng-icon
      name="lucidePalette"
      class="text-muted-foreground shrink-0"
      aria-hidden="true"
    />
    @if (link(); as l) {
      <a
        class="focus-visible:ring-ring/50 min-w-0 rounded-sm break-words underline-offset-4 outline-none hover:underline focus-visible:ring-[3px]"
        [routerLink]="l"
        [queryParams]="query()"
        >{{ text() }}</a
      >
    } @else {
      <span class="min-w-0 break-words">{{ text() }}</span>
    }
    @if (design().missing) {
      <span
        class="text-warning inline-flex min-w-0 items-center gap-1 break-words"
        data-slot="design-missing"
      >
        <ng-icon name="lucideCircleAlert" class="shrink-0" aria-hidden="true" />
        {{ 'editor.designInUse.missing' | transloco }}
      </span>
    }
  `,
})
export class DesignInUseComponent {
  private readonly permissions = inject(PermissionService);
  private readonly csLink = inject(ChangeSetUrl);
  private readonly t = injectTranslate();

  readonly design = input.required<DesignInUse>();

  protected readonly text = computed(() => {
    const d = this.design();
    const name =
      d.name ??
      (d.id === BUILTIN ? this.t('editor.designInUse.builtin') : d.id);
    if (d.source === 'builtin') {
      return this.t('editor.designInUse.label', { name });
    }
    return this.t('editor.designInUse.labelWith', {
      name,
      source: this.t(
        d.source === 'manual'
          ? 'editor.designInUse.own'
          : 'editor.designInUse.project',
      ),
    });
  });

  /** Admin › Page design opens for readers of drafts: the design, or the list for the built-in one. */
  protected readonly link = computed((): string[] | null => {
    if (
      this.permissions.state({ permission: 'content.read.draft' }).kind ===
      'hidden'
    ) {
      return null;
    }
    const d = this.design();
    return d.id === BUILTIN || d.missing
      ? ['/admin', 'page-designs']
      : ['/admin', 'page-designs', d.id];
  });
  protected readonly query = computed(() => this.csLink.params());
}
