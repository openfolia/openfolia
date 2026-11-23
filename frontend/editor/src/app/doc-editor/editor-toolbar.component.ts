import {
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideAlignCenter,
  lucideAlignLeft,
  lucideAlignRight,
  lucideArrowDown,
  lucideArrowUp,
  lucideBold,
  lucideBookOpen,
  lucideBraces,
  lucideChevronDown,
  lucideCode,
  lucideCodeXml,
  lucideImage,
  lucideInfo,
  lucideItalic,
  lucideLink,
  lucideList,
  lucideListChecks,
  lucideListOrdered,
  lucideMessageCircleQuestionMark,
  lucidePaperclip,
  lucidePlus,
  lucideRedo2,
  lucideSeparatorHorizontal,
  lucideSplit,
  lucideTable,
  lucideTableProperties,
  lucideTextQuote,
  lucideTriangleAlert,
  lucideUndo2,
} from '@ng-icons/lucide';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { ZardCommandImports } from '@openfolia/ui/command';
import { ZardDropdownImports } from '@openfolia/ui/dropdown-menu';
import { injectTranslate } from '@openfolia/ui/i18n';
import {
  ZardPopoverDirective,
  ZardPopoverImports,
} from '@openfolia/ui/popover';
import { ZardSeparatorComponent } from '@openfolia/ui/separator';
import { ZardTooltipImports } from '@openfolia/ui/tooltip';

import {
  CELL_ACTIONS,
  columnAligns,
  alignColumn,
  runCellAction,
  type CellAction,
  TABLE_ACTIONS,
  activeIn,
  demote,
  promote,
  setTextLevel,
  textLevelOf,
  textStyleLabel,
  textStyleRefusal,
  textStyles,
  canMove,
  runTableAction,
  toggleTableHeader,
  type TableAction,
  moveBlock,
  toggleMark,
  toggleWrap,
  wrapActive,
  type Mark,
  type TextLevel,
  type Wrap,
} from './editor-commands';
import {
  insertEntries,
  runInsertEntry,
  FOCUSED_SLASH_ITEMS,
  SLASH_ITEMS,
  type InsertGroup,
  type SlashItem,
} from './slash/slash-items';
import type { EditorHandle } from './editor-handle';
import {
  demoteRefusalAt,
  headingAt,
  promoteRefusalAt,
  refusalText,
} from './plugins/heading-levels';
import {
  canBeHeaderRow,
  columnAlign,
  tableAt,
  tableRoom,
  type ColumnAlign,
} from './plugins/table-editing';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  MAX_TABLE_CELLS,
  MAX_TABLE_COLUMNS,
} from '@openfolia/content-model/core';

/** The Insert menu's group names (translation keys, written out in full). */
const INSERT_GROUP_LABELS: Record<InsertGroup, string> = {
  content: 'editor.docEditor.insert.group.content',
  notices: 'editor.docEditor.insert.group.notices',
  structure: 'editor.docEditor.insert.group.structure',
};

/**
 * The editor's toolbar. A pointer press does not take the focus from the document; a keyboard
 * person tabs here and back, and the remembered selection puts each command where they were.
 * Left and Right move between the controls.
 */
@Component({
  selector: 'of-editor-toolbar',
  imports: [
    NgIcon,
    ZardButtonComponent,
    ZardSeparatorComponent,
    ...ZardTooltipImports,
    ...ZardDropdownImports,
    ...ZardCommandImports,
    ...ZardPopoverImports,
    TranslocoPipe,
  ],
  viewProviders: [
    provideIcons({
      lucideAlignCenter,
      lucideAlignLeft,
      lucideAlignRight,
      lucideArrowDown,
      lucideArrowUp,
      lucideBold,
      lucideBookOpen,
      lucideBraces,
      lucideChevronDown,
      lucideCode,
      lucideCodeXml,
      lucideImage,
      lucideInfo,
      lucideItalic,
      lucideLink,
      lucideList,
      lucideListChecks,
      lucideListOrdered,
      lucideMessageCircleQuestionMark,
      lucidePaperclip,
      lucidePlus,
      lucideRedo2,
      lucideSeparatorHorizontal,
      lucideSplit,
      lucideTable,
      lucideTableProperties,
      lucideTextQuote,
      lucideTriangleAlert,
      lucideUndo2,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'toolbar',
    '[attr.aria-label]': 'label()',
    class:
      'border-border flex flex-wrap items-center gap-0.5 border-b px-2 py-1.5',
    '(keydown)': 'onKeydown($event)',
    '(mousedown)': 'keepFocus($event)',
  },
  template: `
    <button
      z-button
      zType="ghost"
      zSize="icon-sm"
      [attr.aria-label]="'editor.docEditor.toolbar.undo' | transloco"
      [zTooltip]="'editor.docEditor.toolbar.undoTip' | transloco"
      [zDisabled]="!can().undo"
      (click)="history('undo')"
    >
      <ng-icon name="lucideUndo2" aria-hidden="true" />
    </button>
    <button
      z-button
      zType="ghost"
      zSize="icon-sm"
      [attr.aria-label]="'editor.docEditor.toolbar.redo' | transloco"
      [zTooltip]="'editor.docEditor.toolbar.redoTip' | transloco"
      [zDisabled]="!can().redo"
      (click)="history('redo')"
    >
      <ng-icon name="lucideRedo2" aria-hidden="true" />
    </button>

    <!-- Headings are structure: the focused editor (a suggestion) offers text and lists only. -->
    @if (!focused()) {
      <z-separator zOrientation="vertical" class="mx-1 h-5" />

      <button
        z-button
        zType="ghost"
        zSize="sm"
        z-dropdown
        [zDropdownMenu]="styles"
        [attr.aria-label]="'editor.docEditor.toolbar.textStyle' | transloco"
        class="min-w-28 justify-between"
      >
        <span>{{ styleLabel() }}</span>
        <ng-icon name="lucideChevronDown" aria-hidden="true" />
      </button>
      <z-dropdown-menu-content #styles class="w-64">
        @for (style of styleOptions(); track style.level) {
          <z-dropdown-menu-item
            [zDisabled]="!!style.reason"
            [attr.aria-current]="style.level === active().level || null"
            (click)="setStyle(style.level, !!style.reason)"
          >
            <span class="flex min-w-0 flex-col">
              <span [class.font-semibold]="style.level === active().level">{{
                style.label | transloco: style.params
              }}</span>
              @if (style.reason; as reason) {
                <span class="text-muted-foreground text-xs break-words">{{
                  reason.key | transloco: reason.params
                }}</span>
              }
            </span>
          </z-dropdown-menu-item>
        }
        @if (levelMoves(); as moves) {
          <z-dropdown-menu-separator />
          @for (move of moves; track move.id) {
            <z-dropdown-menu-item
              [zDisabled]="!!move.reason"
              (click)="changeLevel(move.id, !!move.reason)"
            >
              <span class="flex min-w-0 flex-1 flex-col">
                <span class="flex items-center justify-between gap-4">
                  <span>{{ move.label | transloco }}</span>
                  <kbd class="text-muted-foreground font-sans text-xs">{{
                    move.key | transloco
                  }}</kbd>
                </span>
                @if (move.reason; as reason) {
                  <span class="text-muted-foreground text-xs break-words">{{
                    reason.key | transloco: reason.params
                  }}</span>
                }
              </span>
            </z-dropdown-menu-item>
          }
        }
      </z-dropdown-menu-content>
    }

    <z-separator zOrientation="vertical" class="mx-1 h-5" />

    @for (mark of marks; track mark.id) {
      <button
        z-button
        zType="ghost"
        zSize="icon-sm"
        [attr.aria-label]="mark.label | transloco"
        [attr.aria-pressed]="active().marks[mark.id]"
        [class.bg-muted]="active().marks[mark.id]"
        [zTooltip]="mark.tip | transloco"
        (click)="toggleMark(mark.id)"
      >
        <ng-icon [name]="mark.icon" aria-hidden="true" />
      </button>
    }

    <z-separator zOrientation="vertical" class="mx-1 h-5" />

    @for (wrap of wraps; track wrap.id) {
      <button
        z-button
        zType="ghost"
        zSize="icon-sm"
        [attr.aria-label]="wrap.label | transloco"
        [attr.aria-pressed]="active().wraps[wrap.id]"
        [class.bg-muted]="active().wraps[wrap.id]"
        [zTooltip]="wrap.label | transloco"
        (click)="toggleWrap(wrap.id)"
      >
        <ng-icon [name]="wrap.icon" aria-hidden="true" />
      </button>
    }

    <z-separator zOrientation="vertical" class="mx-1 h-5" />

    <button
      z-button
      zType="ghost"
      zSize="icon-sm"
      [attr.aria-label]="'editor.docEditor.toolbar.moveUp' | transloco"
      [zTooltip]="'editor.docEditor.toolbar.moveUpTip' | transloco"
      [zDisabled]="!can().up"
      (click)="move(true)"
    >
      <ng-icon name="lucideArrowUp" aria-hidden="true" />
    </button>
    <button
      z-button
      zType="ghost"
      zSize="icon-sm"
      [attr.aria-label]="'editor.docEditor.toolbar.moveDown' | transloco"
      [zTooltip]="'editor.docEditor.toolbar.moveDownTip' | transloco"
      [zDisabled]="!can().down"
      (click)="move(false)"
    >
      <ng-icon name="lucideArrowDown" aria-hidden="true" />
    </button>

    <z-separator zOrientation="vertical" class="mx-1 h-5" />

    @if (!focused() && table(); as at) {
      <button
        z-button
        zType="ghost"
        zSize="icon-sm"
        z-dropdown
        [zDropdownMenu]="tableMenu"
        [attr.aria-label]="'editor.docEditor.table.actions' | transloco"
        [zTooltip]="'editor.docEditor.table.actions' | transloco"
      >
        <ng-icon name="lucideTableProperties" aria-hidden="true" />
      </button>
      <!-- Every entry at once where the window has room (issue 694); else held to the room there. -->
      <z-dropdown-menu-content #tableMenu class="max-h-none w-56">
        <z-dropdown-menu-checkbox-item
          [zChecked]="at.header"
          [zDisabled]="!at.header && !at.canHeader"
          (zCheckedChange)="toggleHeader()"
        >
          {{ 'editor.docEditor.table.headerRow' | transloco }}
        </z-dropdown-menu-checkbox-item>
        @if (!at.header && !at.canHeader) {
          <z-dropdown-menu-label class="text-muted-foreground font-normal">
            {{ 'editor.docEditor.table.headerReason' | transloco }}
          </z-dropdown-menu-label>
        }
        @for (action of tableActions; track action.id) {
          @if (action.id === 'deleteRow') {
            <z-dropdown-menu-separator />
          }
          <z-dropdown-menu-item
            [zType]="action.destructive ? 'destructive' : 'default'"
            [zDisabled]="
              (action.structural && at.merged) ||
              (action.grows !== undefined && !at.room[action.grows])
            "
            (click)="tableAction(action.id)"
          >
            {{ action.label | transloco }}
          </z-dropdown-menu-item>
        }
        @if (at.merged) {
          <z-dropdown-menu-label class="text-muted-foreground font-normal">
            {{ 'editor.docEditor.table.mergedReason' | transloco }}
          </z-dropdown-menu-label>
        } @else if (at.room.cap) {
          <z-dropdown-menu-label
            class="text-muted-foreground font-normal"
            data-testid="table-cap-reason"
          >
            {{
              (at.room.cap === 'columns'
                ? 'editor.docEditor.table.columnCapReason'
                : 'editor.docEditor.table.cellCapReason'
              ) | transloco: caps
            }}
          </z-dropdown-menu-label>
        }
        <z-dropdown-menu-separator />
        @for (action of cellActions; track action.id) {
          <z-dropdown-menu-item
            [zDisabled]="!at.cell[action.id]"
            (click)="cellAction(action.id, !at.cell[action.id])"
          >
            {{ action.label | transloco }}
          </z-dropdown-menu-item>
        }
        <z-dropdown-menu-separator />
        <z-dropdown-menu-label>{{
          'editor.docEditor.table.align' | transloco
        }}</z-dropdown-menu-label>
        @for (align of aligns(); track align.id) {
          <z-dropdown-menu-checkbox-item
            [zChecked]="at.align === align.id"
            (zCheckedChange)="setAlign(align.id, at.align)"
          >
            <ng-icon [name]="align.icon" aria-hidden="true" />
            {{ align.label | transloco }}
          </z-dropdown-menu-checkbox-item>
        }
      </z-dropdown-menu-content>
    }
    <button
      z-button
      zType="ghost"
      zSize="sm"
      zPopover
      #insertTrigger="zPopover"
      [zContent]="insertPanel"
      zPlacement="bottom"
      zAlign="start"
      data-testid="insert-menu"
      class="gap-1 ps-1.5 pe-2"
      [attr.aria-label]="'editor.docEditor.insert.label' | transloco"
      [zTooltip]="'editor.docEditor.insert.tip' | transloco"
      (zVisibleChange)="insertOpen.set($event)"
    >
      <ng-icon name="lucidePlus" aria-hidden="true" />
      {{ 'editor.docEditor.toolbar.insert' | transloco }}
      <ng-icon name="lucideChevronDown" aria-hidden="true" />
    </button>
    <ng-template #insertPanel>
      <z-popover
        class="w-80 max-w-[calc(100vw-2rem)] p-0"
        role="dialog"
        [attr.aria-label]="'editor.docEditor.insert.label' | transloco"
      >
        <z-command
          class="rounded-none border-0 shadow-none"
          (zCommandSelected)="insertEntry($event.value)"
        >
          <z-command-input
            data-autofocus
            [placeholder]="'editor.docEditor.insert.search' | transloco"
          />
          <z-command-list>
            @for (group of insertGroups(); track group.group) {
              <z-command-option-group [zLabel]="group.label">
                @for (entry of group.entries; track entry.item.id) {
                  <z-command-option
                    [zValue]="entry.item.id"
                    [zLabel]="entry.label"
                    [zDisabled]="!!entry.reason"
                    [attr.data-insert]="entry.item.id"
                  >
                    <ng-icon
                      data-slot="command-option-leading"
                      [name]="entry.item.icon"
                      aria-hidden="true"
                    />
                    <span
                      data-slot="command-option-label"
                      class="flex min-w-0 flex-col"
                    >
                      <span>{{ entry.label }}</span>
                      <span class="text-muted-foreground text-xs break-words">{{
                        entry.reason ?? entry.hint
                      }}</span>
                    </span>
                  </z-command-option>
                }
              </z-command-option-group>
            }
          </z-command-list>
        </z-command>
      </z-popover>
    </ng-template>
  `,
})
export class EditorToolbarComponent {
  readonly handle = input.required<EditorHandle>();
  /**
   * The focused editor (a contributor's suggestion, #137): no text styles (headings), no table
   * menu, and the Insert menu's blocks only images and attachments (`FOCUSED_SLASH_ITEMS`).
   */
  readonly focused = input(false);
  /**
   * The document's direction (#458): a column's `left` and `right` are the start and end of
   * its text, so in right-to-left text the alignment menu names and shows each by the side it
   * lands on (`left` as "Align right").
   */
  readonly dir = input<'ltr' | 'rtl'>('ltr');
  /**
   * The blocks the Insert menu offers, when the editor has its own list (a page design region's,
   * #393); null: every block, or the focused editor's.
   */
  readonly blockItems = input<readonly SlashItem[] | null>(null);
  /** The blocks the Insert menu offers. */
  private readonly items = computed(
    () =>
      this.blockItems() ?? (this.focused() ? FOCUSED_SLASH_ITEMS : SLASH_ITEMS),
  );
  /** A move happened; the text says where the block is now, for a screen reader. */
  readonly moved = output<string>();

  private readonly t = injectTranslate();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly label = computed(() =>
    this.t('editor.docEditor.toolbar.label'),
  );
  /** The text styles at the caret: text and Heading 1 to the cap, each with why it can't apply. */
  protected readonly styleOptions = computed(() => {
    const state = this.handle().state();
    return textStyles(state).map((style) => {
      const refusal = textStyleRefusal(state, style.level);
      return {
        ...style,
        reason: refusal ? refusalText(state, refusal, style.level) : null,
      };
    });
  });

  /** In a heading: one level down and up, each with why it can't; null elsewhere. */
  protected readonly levelMoves = computed(() => {
    const state = this.handle().state();
    const heading = headingAt(state);
    if (!heading) return null;
    const down = demoteRefusalAt(state);
    const up = promoteRefusalAt(state);
    return [
      {
        id: 'demote' as const,
        label: 'editor.docEditor.heading.demote',
        key: 'editor.docEditor.heading.demoteKey',
        reason: down ? refusalText(state, down, heading.level + 1) : null,
      },
      {
        id: 'promote' as const,
        label: 'editor.docEditor.heading.promote',
        key: 'editor.docEditor.heading.promoteKey',
        reason: up ? refusalText(state, up, heading.level - 1) : null,
      },
    ];
  });

  protected readonly marks: readonly {
    id: Mark;
    label: string;
    tip: string;
    icon: string;
  }[] = [
    {
      id: 'strong',
      label: 'editor.docEditor.mark.bold',
      tip: 'editor.docEditor.mark.boldTip',
      icon: 'lucideBold',
    },
    {
      id: 'emphasis',
      label: 'editor.docEditor.mark.italic',
      tip: 'editor.docEditor.mark.italicTip',
      icon: 'lucideItalic',
    },
    {
      id: 'code',
      label: 'editor.docEditor.mark.code',
      tip: 'editor.docEditor.mark.codeTip',
      icon: 'lucideCode',
    },
  ];

  protected readonly wraps: readonly {
    id: Wrap;
    label: string;
    icon: string;
  }[] = [
    {
      id: 'bulletList',
      label: 'editor.docEditor.wrap.bulletList',
      icon: 'lucideList',
    },
    {
      id: 'orderedList',
      label: 'editor.docEditor.wrap.orderedList',
      icon: 'lucideListOrdered',
    },
  ];

  /** What the controls show, at the selection where the person was (see EditorHandle.state). */
  protected readonly active = computed(() => {
    const state = this.handle().state();
    return {
      level: textLevelOf(state),
      marks: {
        strong: activeIn(state, 'strong'),
        emphasis: activeIn(state, 'emphasis'),
        code: activeIn(state, 'code'),
      } as Record<Mark, boolean>,
      wraps: {
        bulletList: wrapActive(state, 'bulletList'),
        orderedList: wrapActive(state, 'orderedList'),
      } as Record<Wrap, boolean>,
    };
  });

  protected readonly can = computed(() =>
    this.handle().read((e) => ({
      undo: e.can().undo(),
      redo: e.can().redo(),
      up: canMove(this.handle().state(), true),
      down: canMove(this.handle().state(), false),
    })),
  );

  protected readonly tableActions = TABLE_ACTIONS;
  /** The caps a table grows within (#686), for the reason the menu gives at them. */
  protected readonly caps = {
    columns: MAX_TABLE_COLUMNS,
    cells: MAX_TABLE_CELLS,
  };
  /** Whether the Insert menu is open: its entries are read only then. */
  protected readonly insertOpen = signal(false);
  private readonly insertTrigger = viewChild('insertTrigger', {
    read: ZardPopoverDirective,
  });

  /** The Insert menu at the caret: the "/" menu's blocks by group, each with why it can't go here. */
  protected readonly insertGroups = computed(() => {
    if (!this.insertOpen()) return [];
    const state = this.handle().state();
    const editor = this.handle().editor;
    return insertEntries(state, editor, this.items())
      .filter(({ entries }) => entries.length > 0)
      .map(({ group, entries }) => ({
        group,
        label: this.t(INSERT_GROUP_LABELS[group]),
        entries: entries.map((entry) => ({
          ...entry,
          label: this.t(entry.item.label, entry.item.labelParams),
          hint: this.t(entry.item.hint, entry.item.hintParams),
          reason: entry.reason
            ? this.t(entry.reason.key, entry.reason.params)
            : null,
        })),
      }));
  });

  /** Opens the Insert menu, its search focused (the shortcut does, from the text). */
  openInsert(): boolean {
    const trigger = this.insertTrigger();
    if (!trigger) return false;
    trigger.show();
    setTimeout(() =>
      this.host.nativeElement.ownerDocument
        .querySelector<HTMLElement>(
          '[data-slot="popover-content"] [data-autofocus] input',
        )
        ?.focus(),
    );
    return true;
  }

  protected readonly cellActions = CELL_ACTIONS;
  protected readonly aligns = computed(() => columnAligns(this.dir()));

  /**
   * The table the caret is in: whether it has a header row and merged cells, its column's
   * alignment and what can be done to its cell.
   */
  protected readonly table = computed(() => {
    const state = this.handle().state();
    const at = tableAt(state);
    if (!at) return null;
    return {
      header: at.node.attrs['header'] === true,
      canHeader: canBeHeaderRow(at.node),
      merged: at.merged,
      room: tableRoom(at.node),
      align: columnAlign(at),
      cell: Object.fromEntries(
        CELL_ACTIONS.map((a) => [a.id, a.command(state)]),
      ) as Record<CellAction, boolean>,
    };
  });

  protected readonly styleLabel = computed(() => {
    const { key, params } = textStyleLabel(this.active().level);
    return this.t(key, params);
  });

  protected history(step: 'undo' | 'redo'): void {
    this.handle().run((e) =>
      step === 'undo'
        ? e.chain().focus().undo().run()
        : e.chain().focus().redo().run(),
    );
  }

  protected toggleMark(mark: Mark): void {
    this.handle().run((e) => toggleMark(e, mark));
  }

  protected toggleWrap(wrap: Wrap): void {
    this.handle().run((e) => toggleWrap(e, wrap));
  }

  protected setStyle(level: TextLevel, disabled: boolean): void {
    if (disabled) return;
    this.handle().run((e) => setTextLevel(e, level));
  }

  protected changeLevel(move: 'demote' | 'promote', disabled: boolean): void {
    if (disabled) return;
    this.handle().run((e) => (move === 'demote' ? demote(e) : promote(e)));
  }

  protected insertEntry(id: unknown): void {
    const item = this.items().find((i) => i.id === id);
    this.insertTrigger()?.hide();
    if (!item) return;
    const entry = insertEntries(
      this.handle().state(),
      this.handle().editor,
      this.items(),
    )
      .flatMap((g) => g.entries)
      .find((e) => e.item.id === id);
    if (!entry || entry.reason) return;
    this.handle().run((e) => runInsertEntry(e, item));
  }

  protected tableAction(id: TableAction): void {
    this.handle().run((e) => runTableAction(e, id));
  }

  protected cellAction(id: CellAction, disabled: boolean): void {
    if (disabled) return;
    this.handle().run((e) => runCellAction(e, id));
  }

  protected setAlign(align: ColumnAlign, current: ColumnAlign | null): void {
    this.handle().run((e) => alignColumn(e, align, current));
  }

  protected toggleHeader(): void {
    this.handle().run((e) => toggleTableHeader(e));
  }

  protected move(up: boolean): void {
    const message = this.handle().run((e) => moveBlock(e, up, this.t));
    if (message) this.moved.emit(message);
  }

  /** A pointer press on a control keeps the caret in the document. */
  protected keepFocus(event: MouseEvent): void {
    const target = event.target as HTMLElement | null;
    if (target?.closest('button')) event.preventDefault();
  }

  /** Left and Right step between the toolbar's controls, Home and End go to its ends. */
  protected onKeydown(event: KeyboardEvent): void {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const host = event.currentTarget as HTMLElement;
    const controls = [
      ...host.querySelectorAll<HTMLElement>('button:not([disabled])'),
    ];
    const index = controls.indexOf(
      host.ownerDocument.activeElement as HTMLElement,
    );
    if (index < 0) return;
    event.preventDefault();
    const last = controls.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowRight'
            ? (index + 1) % controls.length
            : (index - 1 + controls.length) % controls.length;
    controls[next]?.focus();
  }
}
