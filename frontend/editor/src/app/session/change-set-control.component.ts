import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  Injector,
  signal,
  viewChild,
  ElementRef,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideCheck,
  lucideChevronDown,
  lucideGitBranch,
  lucideLock,
  lucidePencil,
  lucidePlus,
  lucideRotateCcw,
  lucideTriangleAlert,
} from '@ng-icons/lucide';

import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  ZardCommandComponent,
  ZardCommandImports,
} from '@openfolia/ui/command';
import { injectTranslate } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import {
  ZardPopoverDirective,
  ZardPopoverImports,
} from '@openfolia/ui/popover';
import { ZardRadioGroupImports } from '@openfolia/ui/radio-group';
import { FadeInDirective } from '@openfolia/ui/smooth';

import { MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import {
  ChangeSetRenameComponent,
  type ChangeSetRename,
} from './change-set-rename.component';
import {
  ChangeSetSession,
  PUBLISHED,
  TITLE_MAX,
  type ChangeSetOption,
} from './change-set-session';
import { ChangeSetUpdateComponent } from './change-set-update.component';
import { LineBadgeComponent } from './line-badge.component';
import { MaintenanceLines } from './maintenance-lines';

/**
 * The header's change-set control, one control in the top bar: a trigger naming the change set
 * edits happen in (reads follow its branch) opens its menu, a searchable list ("Published
 * content" first, then the open change sets, each with its state as a word, the chosen one
 * ticked, one whose branch is gone from the content repository marked so in words and with an
 * icon, #317) followed by its actions. "Rename change set" (the chosen change set's author, while it
 * is open) and "New change set" (`content.edit`; blocked, with the reason, while one is being
 * started) turn the menu into their form; Escape leaves it as it was.
 * States: loading (placeholder), empty (the list says so), failed with a retry, no access (a
 * refused list).
 */
@Component({
  selector: 'of-change-set-control',
  imports: [
    ZardCommandImports,
    ZardPopoverImports,
    ZardButtonComponent,
    ZardInputComponent,
    FadeInDirective,
    NgIcon,
    TranslocoPipe,
    ChangeSetRenameComponent,
    ChangeSetUpdateComponent,
    LineBadgeComponent,
    ZardRadioGroupImports,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideCheck,
      lucideChevronDown,
      lucideGitBranch,
      lucideLock,
      lucidePencil,
      lucidePlus,
      lucideRotateCcw,
      lucideTriangleAlert,
    }),
  ],
  host: {
    class: 'flex min-w-0 flex-wrap items-center gap-2',
    // The tour's revision step (issue 869) points here, for whoever has the picker.
    '[attr.data-tip]': "visible() ? 'shell.revision' : null",
  },
  template: `
    @if (visible()) {
      @switch (view()) {
        @case ('loading') {
          <!-- The delay on a wrapper: the pulse is an animation of its own. -->
          <span
            class="block w-56 max-w-full"
            ofFadeIn="delayed"
            role="status"
            aria-busy="true"
          >
            <span class="sr-only">{{ 'ui.states.loading' | transloco }}</span>
            <span
              class="bg-muted block h-8 animate-pulse rounded-md motion-reduce:animate-none"
              aria-hidden="true"
            ></span>
          </span>
        }
        @case ('noAccess') {
          <p
            class="text-muted-foreground m-0 flex items-center gap-1.5 text-sm"
            role="status"
          >
            <ng-icon name="lucideLock" size="16" aria-hidden="true" />
            {{ 'editor.changeSet.noAccess' | transloco }}
          </p>
        }
        @case ('failed') {
          <p class="m-0 flex flex-wrap items-center gap-2 text-sm" role="alert">
            {{ 'editor.changeSet.failed' | transloco }}
            <button
              z-button
              zType="outline"
              zSize="sm"
              type="button"
              (click)="session.refresh()"
            >
              <ng-icon
                name="lucideRotateCcw"
                data-icon="inline-start"
                strokeWidth="1.5"
                aria-hidden="true"
              />
              {{ 'ui.states.error.retry' | transloco }}
            </button>
          </p>
        }
        @default {
          <button
            z-button
            zType="outline"
            type="button"
            data-testid="change-set-trigger"
            data-tip="shell.change-set"
            class="w-64 max-w-full justify-between gap-2 font-normal"
            zPopover
            #menuPopover="zPopover"
            [zContent]="menu"
            zPlacement="bottom"
            zAlign="end"
            aria-haspopup="dialog"
            [attr.aria-label]="
              'editor.changeSet.trigger' | transloco: { name: currentName() }
            "
            (zVisibleChange)="menuToggled($event)"
          >
            <ng-icon
              name="lucideGitBranch"
              class="shrink-0 text-muted-foreground"
              strokeWidth="1.5"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1 truncate text-left">{{
              currentLabel()
            }}</span>
            <!-- The product version it fixes, when it is on a maintenance line. -->
            <span class="flex max-w-[45%] min-w-0 shrink-0">
              <of-line-badge [baseRef]="currentOption()?.baseRef" />
            </span>
            <ng-icon
              name="lucideChevronDown"
              class="shrink-0 text-muted-foreground transition-transform duration-200 motion-reduce:transition-none"
              [class.rotate-180]="menuOpen()"
              aria-hidden="true"
            />
          </button>
          @if (session.selectedOption(); as chosen) {
            <of-change-set-update
              [changeSetId]="chosen.id"
              [title]="chosen.title"
              [state]="chosen.state"
              [authorId]="chosen.authorId"
              [version]="session.options()"
            />
          }
        }
      }
      <ng-template #menu>
        <z-popover
          class="w-80 max-w-[calc(100vw-2rem)] p-0"
          [class.p-3]="panel() !== 'list'"
        >
          @switch (panel()) {
            @case ('list') {
              <z-command
                #listCommand="zCommand"
                class="rounded-lg border-0 shadow-none"
                (zCommandSelected)="pick($any($event).value)"
              >
                <z-command-input
                  [label]="'editor.changeSet.search' | transloco"
                  [placeholder]="'editor.changeSet.search' | transloco"
                />
                <z-command-list>
                  <z-command-option
                    [zValue]="published"
                    [zLabel]="'editor.changeSet.published' | transloco"
                  >
                    @if (session.value() === published) {
                      <span
                        data-slot="command-option-trailing"
                        class="flex shrink-0 items-center"
                      >
                        <ng-icon name="lucideCheck" aria-hidden="true" />
                        <span class="sr-only">{{
                          'editor.changeSet.current' | transloco
                        }}</span>
                      </span>
                    }
                  </z-command-option>
                  @for (option of session.options(); track option.id) {
                    @let onLine = lines.lineOf(option.baseRef);
                    <z-command-option
                      [zValue]="option.id"
                      [zLabel]="name(option)"
                      [attr.data-branch-missing]="
                        missing(option) ? 'true' : null
                      "
                    >
                      <span data-slot="command-option-label">{{
                        label(option)
                      }}</span>
                      @if (
                        onLine ||
                        missing(option) ||
                        session.value() === option.id
                      ) {
                        <span
                          data-slot="command-option-trailing"
                          class="flex max-w-[50%] min-w-0 shrink-0 items-center gap-1.5"
                        >
                          <of-line-badge [baseRef]="option.baseRef" />
                          @if (missing(option)) {
                            <!-- The label says it in words; the icon only marks it. -->
                            <ng-icon
                              name="lucideTriangleAlert"
                              class="text-destructive"
                              strokeWidth="1.5"
                              aria-hidden="true"
                            />
                          }
                          @if (session.value() === option.id) {
                            <ng-icon name="lucideCheck" aria-hidden="true" />
                            <span class="sr-only">{{
                              'editor.changeSet.current' | transloco
                            }}</span>
                          }
                        </span>
                      }
                    </z-command-option>
                  } @empty {
                    <p
                      class="m-0 px-2 py-1.5 text-sm text-muted-foreground"
                      data-testid="change-set-empty"
                    >
                      {{ 'editor.changeSet.empty' | transloco }}
                    </p>
                  }
                  @if (renamable() || startState().kind !== 'hidden') {
                    <z-command-divider />
                  }
                  @if (renamable()) {
                    <z-command-option
                      [zValue]="renameAction"
                      [zLabel]="'editor.changeSet.renameAction' | transloco"
                      zIcon="lucidePencil"
                      data-testid="change-set-rename"
                    />
                  }
                  @if (startState(); as state) {
                    @if (state.kind !== 'hidden') {
                      <z-command-option
                        [zValue]="startAction"
                        [zLabel]="'editor.changeSet.start' | transloco"
                        zIcon="lucidePlus"
                        [zDisabled]="state.kind === 'disabled'"
                        data-testid="change-set-start"
                      >
                        <span data-slot="command-option-label">
                          {{ 'editor.changeSet.start' | transloco }}
                          @if (state.kind === 'disabled') {
                            <span class="block text-xs text-muted-foreground">{{
                              state.reason | transloco
                            }}</span>
                          }
                        </span>
                      </z-command-option>
                    }
                  }
                </z-command-list>
              </z-command>
            }
            @case ('rename') {
              @if (renamable(); as option) {
                <div z-popover-header class="mb-3" ofFadeIn>
                  <h3 z-popover-title>
                    {{ 'editor.changeSet.renameTitle' | transloco }}
                  </h3>
                </div>
                <of-change-set-rename
                  [title]="option.title"
                  [description]="option.description"
                  (save)="rename(option.id, $event)"
                  (dismissed)="close()"
                />
              }
            }
            @case ('start') {
              <form
                ofFadeIn
                class="flex flex-col gap-3"
                data-testid="change-set-start-form"
                (submit)="submit($event)"
              >
                <div z-popover-header>
                  <h3 z-popover-title>
                    {{ 'editor.changeSet.startTitle' | transloco }}
                  </h3>
                  <p z-popover-description>
                    {{ 'editor.changeSet.startHint' | transloco }}
                  </p>
                </div>
                @if (lines.open().length > 0) {
                  <!-- Which product version it fixes: main, or an open maintenance line. -->
                  <fieldset
                    class="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
                    data-testid="change-set-start-line"
                  >
                    <legend class="mb-1.5 p-0 text-sm">
                      {{ 'editor.changeSet.lineField' | transloco }}
                    </legend>
                    <z-radio-group
                      class="flex max-h-40 flex-col gap-2 overflow-y-auto"
                      [attr.aria-label]="
                        'editor.changeSet.lineField' | transloco
                      "
                      [value]="lineChoice()"
                      (valueChange)="lineChoice.set($any($event))"
                    >
                      <label class="flex cursor-pointer items-start gap-2.5">
                        <z-radio [value]="''" zId="change-set-line-main" />
                        <span class="text-sm break-words">{{
                          'editor.changeSet.lineMain' | transloco
                        }}</span>
                      </label>
                      @for (l of lines.open(); track l.id) {
                        <label class="flex cursor-pointer items-start gap-2.5">
                          <z-radio
                            [value]="l.id"
                            [zId]="'change-set-line-' + l.id"
                          />
                          <span class="text-sm break-words">{{
                            lines.lineLabel(l)
                          }}</span>
                        </label>
                      }
                    </z-radio-group>
                  </fieldset>
                }
                <label class="flex flex-col gap-1.5 text-sm">
                  {{ 'editor.changeSet.titleField' | transloco }}
                  <input
                    #titleInput
                    z-input
                    required
                    [attr.maxlength]="titleMax"
                    autocomplete="off"
                    [value]="title()"
                    (input)="title.set($any($event.target).value)"
                    (keydown.escape)="$event.preventDefault(); close()"
                  />
                </label>
                <button
                  z-button
                  type="submit"
                  [attr.aria-disabled]="canStart() ? null : 'true'"
                >
                  {{ 'editor.changeSet.startAction' | transloco }}
                </button>
              </form>
            }
          }
        </z-popover>
      </ng-template>
    }
  `,
})
export class ChangeSetControlComponent {
  protected readonly session = inject(ChangeSetSession);
  protected readonly lines = inject(MaintenanceLines);
  private readonly permissions = inject(PermissionService);
  private readonly me = inject(MeService);
  private readonly t = injectTranslate();
  private readonly popover = viewChild<ZardPopoverDirective>('menuPopover');
  private readonly listCommand = viewChild<string, ZardCommandComponent>(
    'listCommand',
    { read: ZardCommandComponent },
  );
  private readonly injector = inject(Injector);
  private readonly input = viewChild<string, ElementRef<HTMLInputElement>>(
    'titleInput',
    { read: ElementRef },
  );

  /** Why starting is blocked right now (a key), or null. */
  protected readonly startBlocked = computed(() =>
    this.session.switching()
      ? 'editor.changeSet.switchingReason'
      : this.session.starting() !== null
        ? 'editor.changeSet.startingReason'
        : null,
  );

  /** Starting a change set: hidden without `content.edit`, blocked with the reason. */
  protected readonly startState = computed(() =>
    this.permissions.state({
      permission: 'content.edit',
      blockedReason: this.startBlocked() ?? undefined,
    }),
  );

  /** What the open menu shows: the list, or the rename or start form in its place. */
  protected readonly panel = signal<'list' | 'rename' | 'start'>('list');
  protected readonly menuOpen = signal(false);

  /** The chosen change set as the list has it, or none. */
  protected readonly currentOption = computed(() => {
    const value = this.session.value();
    return this.session.options().find((o) => o.id === value) ?? null;
  });

  /** The trigger's text: the chosen change set with its state, or published content. */
  protected readonly currentLabel = computed(() => {
    const option = this.currentOption();
    return option ? this.label(option) : this.t('editor.changeSet.published');
  });

  /** The trigger's name: its text, and the product version it fixes when on a line. */
  protected readonly currentName = computed(() => {
    const option = this.currentOption();
    return option ? this.name(option) : this.t('editor.changeSet.published');
  });

  /**
   * The product version a new change set fixes (#250): '' for the current one (main), else an
   * open maintenance line's ID. Back to main each time the form opens.
   */
  protected readonly lineChoice = signal('');

  protected readonly published = PUBLISHED;
  protected readonly renameAction = RENAME;
  protected readonly startAction = START;
  protected readonly titleMax = TITLE_MAX;
  protected readonly title = signal('');
  protected readonly canStart = computed(
    () =>
      this.title().trim().length > 0 &&
      this.session.starting() === null &&
      !this.session.switching(),
  );

  /** A role that can neither edit nor read drafts can never use a change set. */
  protected readonly visible = computed(
    () =>
      this.permissions.state({ permission: 'content.edit' }).kind !==
        'hidden' ||
      this.permissions.state({ permission: 'content.read.draft' }).kind !==
        'hidden',
  );

  /** The chosen change set, when the person may rename it: its author, while it is open. */
  protected readonly renamable = computed((): ChangeSetOption | null => {
    if (this.session.switching()) return null;
    const option = this.session
      .options()
      .find((o) => o.id === this.session.value());
    return option &&
      !option.pending &&
      option.authorId === this.me.me().id &&
      OPEN_STATES.includes(option.state)
      ? option
      : null;
  });

  protected readonly view = computed(() => {
    // The previous person's list is not shown to the next one while a switch is unanswered.
    if (this.session.switching()) return 'loading';
    const status = this.session.status();
    if (status === 'error') {
      return this.session.error()?.status === 403 ? 'noAccess' : 'failed';
    }
    return status === 'loading' && this.session.options().length === 0
      ? 'loading'
      : 'ready';
  });

  /** Its branch is gone (`ChangeSetSession.isBranchMissing`). */
  protected missing(option: ChangeSetOption): boolean {
    return this.session.isBranchMissing(option);
  }

  /** The title and the state as a word, so the state is never only a colour or position. */
  protected label(option: ChangeSetOption): string {
    const state = this.t(STATE_KEYS[option.state]);
    if (option.pending) {
      return this.t('editor.changeSet.pendingLabel', { title: option.title });
    }
    return this.t(
      this.missing(option)
        ? 'editor.changeSet.optionLabelBranchMissing'
        : 'editor.changeSet.optionLabel',
      { title: option.title, state },
    );
  }

  /** Its label, with the product version it fixes when it is on a line: for search and names. */
  protected name(option: ChangeSetOption): string {
    const line = this.lines.lineOf(option.baseRef);
    return line
      ? this.t('editor.changeSet.optionOnLine', {
          label: this.label(option),
          line: this.lines.lineLabel(line),
        })
      : this.label(option);
  }

  /** A list entry: a change set to choose, or the rename or start form. */
  protected pick(value: string): void {
    if (value === RENAME) {
      if (this.renamable()) this.panel.set('rename');
      return;
    }
    if (value === START) {
      if (this.startState().kind !== 'enabled') return;
      this.lineChoice.set('');
      this.panel.set('start');
      setTimeout(() => this.input()?.nativeElement.focus());
      return;
    }
    this.close();
    this.session.choose(value);
  }

  protected menuToggled(open: boolean): void {
    this.menuOpen.set(open);
    // Opened again, the menu starts at the list (after its closing animation, never during it),
    // with the focus in its search field.
    if (!open) return;
    // The lines the form offers, read while the person looks at the list.
    if (this.startState().kind !== 'hidden') this.lines.ensure();
    this.panel.set('list');
    afterNextRender(() => this.listCommand()?.focus(), {
      injector: this.injector,
    });
  }

  protected close(): void {
    this.popover()?.hide();
  }

  protected rename(id: string, change: ChangeSetRename): void {
    this.close();
    void this.session.rename(id, change);
  }

  protected submit(event: Event): void {
    event.preventDefault();
    if (!this.canStart()) return;
    const title = this.title();
    const line = this.lines.open().find((l) => l.id === this.lineChoice());
    this.title.set('');
    this.close();
    void this.session.start(
      title,
      line ? { id: line.id, branch: line.attributes.branch } : null,
    );
  }
}

/** The list's action entries: values no change set ID can take (IDs are UUIDs). */
const RENAME = ':rename';
const START = ':start';

const OPEN_STATES: readonly ChangeSetOption['state'][] = [
  'draft',
  'in-review',
  'approved',
];

/** A change set's state as people read it (a translation key). */
export const STATE_KEYS: Record<ChangeSetOption['state'], string> = {
  draft: 'editor.changeSet.state.draft',
  'in-review': 'editor.changeSet.state.inReview',
  approved: 'editor.changeSet.state.approved',
  merged: 'editor.changeSet.state.merged',
  abandoned: 'editor.changeSet.state.abandoned',
};
