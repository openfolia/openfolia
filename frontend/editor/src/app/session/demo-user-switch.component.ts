import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideRotateCcw, lucideUsers } from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import { FadeInDirective } from '@openfolia/ui/smooth';

import { DemoSession } from './demo-session';

/**
 * The demo's user switcher, projected into the account menu. It stands in for sign-in: one menu
 * radio item per seeded user (arrow keys, Enter), the acting user checked. The list scrolls inside
 * its own box. States: loading (placeholder rows), empty, and failed with a retry; "no access"
 * cannot occur, as the list is open to any actor. The caller shows it only in demo mode.
 */
@Component({
  selector: 'of-demo-user-switch',
  imports: [
    ZardDropdownImports,
    ZardButtonComponent,
    FadeInDirective,
    NgIcon,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [provideIcons({ lucideUsers, lucideRotateCcw })],
  host: { class: 'block' },
  template: `
    <z-dropdown-menu-separator />
    <z-dropdown-menu-label class="flex items-center gap-2">
      <ng-icon
        name="lucideUsers"
        class="text-foreground size-4 shrink-0"
        aria-hidden="true"
      />
      {{ 'editor.demo.label' | transloco }}
    </z-dropdown-menu-label>
    @if (session.status() === 'failed') {
      <div
        class="flex flex-col items-start gap-1.5 px-2 pb-2 text-sm"
        role="alert"
      >
        <p class="m-0 break-words">{{ 'editor.demo.failed' | transloco }}</p>
        <button
          z-button
          zType="outline"
          zSize="sm"
          type="button"
          [attr.aria-busy]="session.loading()"
          (click)="session.retry()"
        >
          <ng-icon
            name="lucideRotateCcw"
            data-icon="inline-start"
            strokeWidth="1.5"
            aria-hidden="true"
          />
          {{ 'ui.states.error.retry' | transloco }}
        </button>
      </div>
    } @else if (session.loading() && session.users().length === 0) {
      <div
        class="flex flex-col gap-1.5 px-2 pb-2"
        ofFadeIn="delayed"
        role="status"
        aria-busy="true"
      >
        <span class="sr-only">{{ 'ui.states.loading' | transloco }}</span>
        @for (row of rows; track row) {
          <span
            class="bg-muted h-7 animate-pulse rounded-md motion-reduce:animate-none"
            aria-hidden="true"
          ></span>
        }
      </div>
    } @else if (session.users().length === 0) {
      <p class="text-muted-foreground m-0 px-2 pb-2 text-sm">
        {{ 'editor.demo.empty' | transloco }}
      </p>
    } @else {
      <z-dropdown-menu-radio-group
        class="max-h-48 overflow-y-auto"
        [zValue]="session.userId() ?? undefined"
        (zValueChange)="choose($event)"
        [attr.aria-label]="'editor.demo.label' | transloco"
      >
        @for (user of session.users(); track user.id) {
          <z-dropdown-menu-radio-item [zValue]="user.id" class="h-auto py-1">
            <span class="flex min-w-0 flex-col">
              <span class="break-words">{{ user.name }}</span>
              @if (user.roleIds.length > 0) {
                <span class="text-muted-foreground text-xs break-words">{{
                  user.roleIds.join(', ')
                }}</span>
              }
            </span>
          </z-dropdown-menu-radio-item>
        }
      </z-dropdown-menu-radio-group>
    }
  `,
})
export class DemoUserSwitchComponent {
  protected readonly session = inject(DemoSession);
  protected readonly rows = [1, 2, 3];

  protected choose(id: string | undefined): void {
    if (id) void this.session.switchTo(id);
  }
}
