import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBookOpen,
  lucideFileText,
  lucidePalette,
  lucideSettings,
  lucideTag,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';

import { CarryForward } from './carry-forward';
import {
  describe,
  kindLabel,
  reasonOf,
  type Row,
} from './change-set-conflicts.component';
import type { MoveConflict } from './change-set-move';

/** A line of the list: the file, why it was left as `main` has it, and its blocks to fix. */
interface CarriedRow extends Omit<Row, 'keepable'> {
  readonly reason: string;
  /** A module's: its language and ID, to open the editor at each block. */
  readonly module: { readonly lang: string; readonly moduleId: string } | null;
  readonly blockIds: readonly string[];
}

/**
 * What carrying a fix forward to `main` left to do by hand (#250): each module, manual or other
 * file `main` changed differently (or that could not be taken), with why, and for a module the
 * blocks the fix changed, each opening the editor in the new draft at that block. "Later" keeps
 * the list (the review shows it again); "Done" puts it away.
 */
@Component({
  selector: 'of-carry-forward-conflicts',
  imports: [ZardDialogImports, ZardButtonComponent, NgIcon, TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideBookOpen,
      lucideFileText,
      lucidePalette,
      lucideSettings,
      lucideTag,
    }),
  ],
  template: `
    <z-dialog
      [zVisible]="carry.dialogOpen() && !!carry.conflicts()"
      (zVisibleChange)="$event || carry.closeConflicts()"
      class="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-[34rem]"
    >
      @if (carry.conflicts(); as c) {
        <z-dialog-header>
          <z-dialog-title class="break-words">{{
            'editor.carryForward.conflictsTitle' | transloco
          }}</z-dialog-title>
          <z-dialog-description class="break-words">{{
            'editor.carryForward.conflictsHint'
              | transloco: { title: c.title, count: c.total }
          }}</z-dialog-description>
        </z-dialog-header>
        <ul
          data-testid="carry-forward-conflicts"
          class="m-0 flex min-h-0 list-none flex-col gap-1 overflow-y-auto p-0"
        >
          @for (row of rows(); track row.key) {
            <li
              class="flex min-w-0 flex-wrap items-start gap-2 rounded-md px-1 py-1.5"
              data-slot="carried-conflict"
            >
              <ng-icon
                [name]="row.icon"
                class="text-muted-foreground mt-0.5 size-4 shrink-0"
                strokeWidth="1.5"
                aria-hidden="true"
              />
              <div class="flex min-w-0 flex-1 flex-col gap-1">
                <span class="text-sm leading-5 break-words">{{
                  row.label
                }}</span>
                <span
                  class="text-muted-foreground text-xs leading-[1.125rem] break-words"
                >
                  {{ kindOf(row) | transloco }} · {{ row.reason | transloco }}
                </span>
                @if (row.module && row.blockIds.length > 0) {
                  <ul
                    class="m-0 flex list-none flex-wrap gap-1.5 p-0"
                    [attr.aria-label]="
                      'editor.carryForward.blocks'
                        | transloco: { count: row.blockIds.length }
                    "
                  >
                    @for (block of row.blockIds; track block) {
                      <li>
                        <button
                          z-button
                          zType="outline"
                          zSize="sm"
                          type="button"
                          class="font-mono"
                          data-slot="carried-block"
                          [attr.aria-label]="
                            'editor.carryForward.openBlock'
                              | transloco: { block, module: row.label }
                          "
                          (click)="openBlock(row, block)"
                        >
                          {{ block }}
                        </button>
                      </li>
                    }
                  </ul>
                }
              </div>
              @if (row.module && row.blockIds.length === 0) {
                <button
                  z-button
                  zType="ghost"
                  zSize="sm"
                  type="button"
                  class="ml-auto shrink-0"
                  data-slot="carried-open"
                  (click)="openBlock(row, null)"
                >
                  {{ 'editor.changeSet.update.open' | transloco }}
                </button>
              } @else if (!row.module && row.link) {
                <button
                  z-button
                  zType="ghost"
                  zSize="sm"
                  type="button"
                  class="ml-auto shrink-0"
                  data-slot="carried-open"
                  (click)="openOther(row)"
                >
                  {{ 'editor.changeSet.update.open' | transloco }}
                </button>
              }
            </li>
          }
        </ul>
        @if (c.total > c.items.length) {
          <p class="text-muted-foreground m-0 text-xs">
            {{
              'editor.changeSet.update.more'
                | transloco: { count: c.total - c.items.length }
            }}
          </p>
        }
        <z-dialog-footer>
          <button
            z-button
            zType="ghost"
            type="button"
            (click)="carry.closeConflicts()"
          >
            {{ 'editor.changeSet.update.later' | transloco }}
          </button>
          <button
            z-button
            type="button"
            data-testid="carry-forward-done"
            (click)="carry.dismissConflicts()"
          >
            {{ 'editor.changeSet.move.dismiss' | transloco }}
          </button>
        </z-dialog-footer>
      }
    </z-dialog>
  `,
})
export class CarryForwardConflictsComponent {
  protected readonly carry = inject(CarryForward);
  private readonly router = inject(Router);

  protected readonly rows = computed((): CarriedRow[] =>
    (this.carry.conflicts()?.items ?? []).map((c: MoveConflict) => ({
      ...describe(c),
      reason: reasonOf(c.kinds),
      module:
        c.subject?.type === 'module'
          ? { lang: c.subject.lang, moduleId: c.subject.moduleId }
          : null,
      blockIds: c.blockIds ?? [],
    })),
  );

  protected kindOf(row: CarriedRow): string {
    return kindLabel(row);
  }

  /** Opens the editor in the new draft at the block (or at the module); the list stays. */
  protected openBlock(row: CarriedRow, block: string | null): void {
    if (!row.module) return;
    this.carry.openBlock(row.module.lang, row.module.moduleId, block);
  }

  /** A manual (the builder) in the new draft, chosen already as the revision. */
  protected openOther(row: CarriedRow): void {
    if (!row.link) return;
    this.carry.closeConflicts();
    void this.router.navigate(row.link.commands, {
      ...(row.link.queryParams ? { queryParams: row.link.queryParams } : {}),
    });
  }
}
