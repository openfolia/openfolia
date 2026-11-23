import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  inject,
} from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBookOpen,
  lucideCheck,
  lucideFileText,
  lucideSettings,
  lucideFileCode,
  lucidePalette,
  lucideTag,
} from '@ng-icons/lucide';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardDialogImports } from '@openfolia/ui/dialog';
import { FadeInDirective } from '@openfolia/ui/smooth';

import { ChangeSetMove, type MoveConflict } from './change-set-move';
import type { UpdateConflict } from './change-set-update';
import { ChangeSetUpdate } from './change-set-update';
import { MaintenanceLines } from './maintenance-lines';

/** One line of the list: what it is and, when the editor can open it, where. */
export interface Row {
  readonly key: string;
  readonly icon: string;
  readonly label: string;
  /** `modules`, `manuals`, `config`, `terms` or `other`, for its kind's text. */
  readonly kind:
    'module' | 'manual' | 'config' | 'term' | 'design' | 'template' | 'other';
  readonly working: boolean;
  /** Whether it can be kept at all: a module, manual, the configuration or a term. */
  readonly keepable: boolean;
  readonly link: {
    commands: unknown[];
    queryParams?: Record<string, string>;
  } | null;
}

/** A line of what a move left: why it was not carried over, and how many blocks to apply again. */
interface MovedRow extends Omit<Row, 'keepable'> {
  readonly reason: string;
  readonly blocks: number;
}

/** Why a file was not carried over, from the kinds the API names (`CarryConflict`). */
export function reasonOf(kinds: readonly string[]): string {
  if (kinds.includes('forbidden'))
    return 'editor.changeSet.move.reason.forbidden';
  if (kinds.includes('locked')) return 'editor.changeSet.move.reason.locked';
  if (kinds.includes('too-many-locks')) {
    return 'editor.changeSet.move.reason.tooManyLocks';
  }
  if (kinds.includes('unknown-asset')) {
    return 'editor.changeSet.move.reason.unknownAsset';
  }
  if (kinds.includes('invalid')) return 'editor.changeSet.move.reason.invalid';
  if (kinds.includes('unsupported') || kinds.includes('binary')) {
    return 'editor.changeSet.move.reason.unsupported';
  }
  return 'editor.changeSet.move.reason.changedOnMain';
}

const rowOf = (c: UpdateConflict): Row => ({
  ...describe(c),
  keepable: c.subject !== undefined,
});

/** A conflict's line: its icon, its name and kind, and where the editor opens it. */
export const describe = (c: UpdateConflict): Omit<Row, 'keepable'> => {
  const working = c.kinds.includes('working-copy');
  const s = c.subject;
  switch (s?.type) {
    case 'module':
      return {
        key: c.path,
        icon: 'lucideFileText',
        label: `${s.moduleId} (${s.lang})`,
        kind: 'module',
        working,
        link: { commands: ['/content', s.lang, s.moduleId] },
      };
    case 'manual':
      return {
        key: c.path,
        icon: 'lucideBookOpen',
        label: s.manualId,
        kind: 'manual',
        working,
        link: { commands: ['/manuals'], queryParams: { manual: s.manualId } },
      };
    case 'config':
      return {
        key: c.path,
        icon: 'lucideSettings',
        label: c.path,
        kind: 'config',
        working,
        link: null,
      };
    case 'term':
      return {
        key: c.path,
        icon: 'lucideTag',
        label: s.termId,
        kind: 'term',
        working,
        link: null,
      };
    case 'design':
      return {
        key: c.path,
        icon: 'lucidePalette',
        label: s.designId,
        kind: 'design',
        working,
        link: null,
      };
    case 'template':
      return {
        key: c.path,
        icon: 'lucideFileCode',
        label: c.path,
        kind: 'template',
        working,
        link: {
          commands: ['/admin/page-designs/templates', s.templateId],
          queryParams: { file: s.path },
        },
      };
    default:
      return {
        key: c.path,
        icon: 'lucideFileText',
        label: c.path,
        kind: 'other',
        working,
        link: null,
      };
  }
};

/**
 * The conflicts an update from the base left (#22), and what moving a change set onto the current
 * main left to apply by hand (#471: each file with why and the blocks to apply again, opening the
 * editor on it; "Done" puts the list away). The update's: the modules and manuals (and any other file)
 * the base changed where the change set changed them too, each opening the editor on it. Each is
 * marked once saved since (as the API says, read whenever the list is shown, and when the window
 * gets the focus back), or the author keeps their version of it as it is ("Keep my version",
 * undone with "Undo"). Only then does "Update again" go, keeping those versions (#437); the API
 * refuses it too. Closing it keeps the conflicts: the update button reads "Resolve conflicts" and
 * opens it again.
 */
@Component({
  selector: 'of-change-set-conflicts',
  imports: [
    ZardDialogImports,
    ZardButtonComponent,
    ZardBadgeComponent,
    FadeInDirective,
    NgIcon,
    TranslocoPipe,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideBookOpen,
      lucideCheck,
      lucideFileText,
      lucideSettings,
      lucideFileCode,
      lucidePalette,
      lucideTag,
    }),
  ],
  template: `
    <z-dialog
      [zVisible]="updates.dialogOpen() && !!updates.conflicts()"
      (zVisibleChange)="$event || updates.closeConflicts()"
      class="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-[32rem]"
    >
      @if (updates.conflicts(); as c) {
        <z-dialog-header>
          <z-dialog-title class="break-words">{{
            'editor.changeSet.update.conflictsTitle'
              | transloco: { ref: lines.label(c.baseRef) }
          }}</z-dialog-title>
          <z-dialog-description class="break-words">{{
            'editor.changeSet.update.conflictsHint'
              | transloco
                : {
                    title: c.title,
                    ref: lines.label(c.baseRef),
                    count: c.total,
                  }
          }}</z-dialog-description>
        </z-dialog-header>
        <ul
          data-testid="change-set-conflicts"
          class="m-0 flex min-h-0 list-none flex-col gap-1 overflow-y-auto p-0"
        >
          @for (row of rows(c.items); track row.key) {
            @let state = updates.state(row.key);
            <li
              class="flex min-w-0 flex-wrap items-start gap-2 rounded-md px-1 py-1.5"
              [attr.data-state]="row.keepable ? state : null"
            >
              <ng-icon
                [name]="row.icon"
                class="text-muted-foreground mt-0.5 size-4 shrink-0"
                strokeWidth="1.5"
                aria-hidden="true"
              />
              <div class="flex min-w-0 flex-1 flex-col">
                <span class="text-sm leading-5 break-words">{{
                  row.label
                }}</span>
                <span
                  class="text-muted-foreground text-xs leading-[1.125rem] break-words"
                >
                  {{ kindLabel(row) | transloco }}
                  @if (row.working && state === 'open') {
                    · {{ 'editor.changeSet.update.unsaved' | transloco }}
                  }
                </span>
              </div>
              <div class="ml-auto flex shrink-0 items-center gap-1">
                @if (row.keepable) {
                  @switch (state) {
                    @case ('saved') {
                      <span
                        z-badge
                        zType="success"
                        ofFadeIn
                        data-slot="conflict-saved"
                      >
                        <ng-icon
                          name="lucideCheck"
                          strokeWidth="2"
                          aria-hidden="true"
                        />
                        {{ 'editor.changeSet.update.saved' | transloco }}
                      </span>
                    }
                    @case ('chosen') {
                      <span
                        z-badge
                        zType="info"
                        ofFadeIn
                        data-slot="conflict-chosen"
                        >{{
                          'editor.changeSet.update.keeping' | transloco
                        }}</span
                      >
                      <button
                        z-button
                        zType="ghost"
                        zSize="sm"
                        type="button"
                        data-slot="conflict-undo"
                        [zDisabled]="updates.busy(c.id)"
                        (click)="updates.unchoose(row.key)"
                      >
                        {{ 'editor.changeSet.update.undo' | transloco }}
                      </button>
                    }
                    @default {
                      <button
                        z-button
                        zType="ghost"
                        zSize="sm"
                        type="button"
                        data-slot="conflict-keep-mine"
                        [zDisabled]="updates.busy(c.id)"
                        (click)="updates.choose(row.key)"
                      >
                        {{ 'editor.changeSet.update.keepMine' | transloco }}
                      </button>
                    }
                  }
                }
                @if (row.link) {
                  <button
                    z-button
                    zType="ghost"
                    zSize="sm"
                    type="button"
                    data-slot="conflict-open"
                    (click)="open(row)"
                  >
                    {{ 'editor.changeSet.update.open' | transloco }}
                  </button>
                }
              </div>
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
        <p
          class="text-muted-foreground m-0 min-h-[1.125rem] text-xs leading-[1.125rem] break-words transition-opacity duration-200 motion-reduce:transition-none"
          [class.opacity-0]="updates.resolved() || !updates.resolutionsKnown()"
          [attr.aria-hidden]="updates.resolved() ? 'true' : null"
          data-testid="change-set-conflicts-pending"
        >
          {{ 'editor.changeSet.update.toResolve' | transloco }}
        </p>
        <z-dialog-footer>
          <button
            z-button
            zType="ghost"
            type="button"
            (click)="updates.closeConflicts()"
          >
            {{ 'editor.changeSet.update.later' | transloco }}
          </button>
          <button
            z-button
            type="button"
            data-testid="change-set-update-again"
            [zDisabled]="updates.busy(c.id) || !updates.resolved()"
            [attr.aria-busy]="updates.busy(c.id) ? 'true' : null"
            (click)="updates.updateAgain()"
          >
            {{ 'editor.changeSet.update.again' | transloco }}
          </button>
        </z-dialog-footer>
      }
    </z-dialog>

    <!-- What moving a change set onto the current main left to apply by hand. -->
    <z-dialog
      [zVisible]="moves.dialogOpen() && !!moves.conflicts()"
      (zVisibleChange)="$event || moves.closeConflicts()"
      class="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-[32rem]"
    >
      @if (moves.conflicts(); as c) {
        <z-dialog-header>
          <z-dialog-title class="break-words">{{
            'editor.changeSet.move.conflictsTitle'
              | transloco: { ref: lines.label(c.baseRef) }
          }}</z-dialog-title>
          <z-dialog-description class="break-words">{{
            'editor.changeSet.move.conflictsHint'
              | transloco
                : {
                    title: c.title,
                    ref: lines.label(c.baseRef),
                    count: c.total,
                  }
          }}</z-dialog-description>
        </z-dialog-header>
        <ul
          data-testid="change-set-move-conflicts"
          class="m-0 flex min-h-0 list-none flex-col gap-1 overflow-y-auto p-0"
        >
          @for (row of movedRows(c.items); track row.key) {
            <li
              class="flex min-w-0 flex-wrap items-start gap-2 rounded-md px-1 py-1.5"
            >
              <ng-icon
                [name]="row.icon"
                class="text-muted-foreground mt-0.5 size-4 shrink-0"
                strokeWidth="1.5"
                aria-hidden="true"
              />
              <div class="flex min-w-0 flex-1 flex-col">
                <span class="text-sm leading-5 break-words">{{
                  row.label
                }}</span>
                <span
                  class="text-muted-foreground text-xs leading-[1.125rem] break-words"
                >
                  {{ kindLabel(row) | transloco }} ·
                  {{ row.reason | transloco }}
                  @if (row.blocks > 0) {
                    ·
                    {{
                      'editor.changeSet.move.blocks'
                        | transloco: { count: row.blocks }
                    }}
                  }
                </span>
              </div>
              @if (row.link) {
                <button
                  z-button
                  zType="ghost"
                  zSize="sm"
                  type="button"
                  class="ml-auto shrink-0"
                  data-slot="moved-open"
                  (click)="openMoved(row)"
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
            (click)="moves.closeConflicts()"
          >
            {{ 'editor.changeSet.update.later' | transloco }}
          </button>
          <button
            z-button
            type="button"
            data-testid="change-set-move-done"
            (click)="moves.dismissConflicts()"
          >
            {{ 'editor.changeSet.move.dismiss' | transloco }}
          </button>
        </z-dialog-footer>
      }
    </z-dialog>
  `,
})
export class ChangeSetConflictsComponent {
  protected readonly updates = inject(ChangeSetUpdate);
  protected readonly moves = inject(ChangeSetMove);
  /** A base by its product version when it is a maintenance line's, never by its branch (#250). */
  protected readonly lines = inject(MaintenanceLines);
  private readonly router = inject(Router);

  /** Back from another window or tab (where the files may have been saved): read again. */
  @HostListener('window:focus')
  protected onFocus(): void {
    if (this.updates.dialogOpen()) void this.updates.readResolutions();
  }

  protected rows(items: readonly UpdateConflict[]): Row[] {
    return items.map(rowOf);
  }

  protected movedRows(items: readonly MoveConflict[]): MovedRow[] {
    return items.map((c) => ({
      ...describe(c),
      reason: reasonOf(c.kinds),
      blocks: c.blockIds?.length ?? 0,
    }));
  }

  /** Opens the editor on it; the list stays to come back to (the header's button). */
  protected openMoved(row: MovedRow): void {
    if (!row.link) return;
    this.moves.closeConflicts();
    void this.router.navigate(row.link.commands, {
      ...(row.link.queryParams ? { queryParams: row.link.queryParams } : {}),
    });
  }

  protected kindLabel(row: Pick<Row, 'kind'>): string {
    return kindLabel(row);
  }

  /** Opens the editor on it; the list stays to come back to (the update button). */
  protected open(row: Row): void {
    if (!row.link) return;
    this.updates.closeConflicts();
    void this.router.navigate(row.link.commands, {
      ...(row.link.queryParams ? { queryParams: row.link.queryParams } : {}),
    });
  }
}

/** A conflict's kind in words (a key). */
export function kindLabel(row: Pick<Row, 'kind'>): string {
  return {
    module: 'editor.changeSet.update.kind.module',
    manual: 'editor.changeSet.update.kind.manual',
    config: 'editor.changeSet.update.kind.config',
    term: 'editor.changeSet.update.kind.term',
    design: 'editor.changeSet.update.kind.design',
    template: 'editor.changeSet.update.kind.template',
    other: 'editor.changeSet.update.kind.other',
  }[row.kind];
}
