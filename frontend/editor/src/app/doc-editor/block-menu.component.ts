import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  ViewContainerRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideArrowDown,
  lucideArrowUp,
  lucideBookmarkPlus,
  lucideCopy,
  lucideSquareDashed,
  lucideTrash2,
} from '@ng-icons/lucide';
import type { Editor } from '@tiptap/core';
import { undo, undoDepth } from '@tiptap/pm/history';
import type { EditorView } from '@tiptap/pm/view';
import {
  ZardDropdownImports,
  ZardDropdownMenuContentComponent,
  ZardDropdownService,
} from '@openfolia/ui/dropdown-menu';
import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import {
  blockActions,
  deleteBlock,
  duplicateBlock,
  moveBlock,
  unwrapBlock,
  type BlockActionState,
} from './plugins/block-actions';
import {
  blockMenuPos,
  closeBlockMenu,
  type BlockMenuRequest,
} from './plugins/block-menu';
import { saveAsSnippet, saveSnippetBlocked } from './snippets/save-snippet';

/** The menu open now: the editor, the block and what it offers. */
interface Open {
  readonly view: EditorView;
  readonly pos: number;
  readonly actions: BlockActionState;
  /**
   * "Save as snippet": null when it can run, a translation key saying why not, undefined when the
   * page offers no snippets.
   */
  readonly snippet: string | null | undefined;
}

/**
 * The block actions menu on a block's grip (`plugins/block-menu.ts` says when it opens): Delete,
 * Duplicate, Move up and Move down (as Alt+Up and Alt+Down) and, for a frame around blocks (a
 * variant block), Remove frame with its content kept. Every action is one step that Undo takes
 * back; Delete says so in a toast with Undo, and asks nothing first. It works for any block type,
 * from what the schema allows at the block's place. Placed by the dropdown menu's service
 * (`createTriggerOverlay`), against the grip.
 */
@Component({
  selector: 'of-block-menu',
  imports: [TranslocoPipe, NgIcon, ...ZardDropdownImports],
  changeDetection: ChangeDetectionStrategy.OnPush,
  viewProviders: [
    provideIcons({
      lucideArrowDown,
      lucideArrowUp,
      lucideBookmarkPlus,
      lucideCopy,
      lucideSquareDashed,
      lucideTrash2,
    }),
  ],
  host: { class: 'contents' },
  template: `
    <z-dropdown-menu-content #menu class="w-60">
      @if (current(); as c) {
        <z-dropdown-menu-item
          [zDisabled]="!c.actions.canMoveUp"
          data-action="move-up"
          (click)="run('move-up')"
        >
          <ng-icon name="lucideArrowUp" aria-hidden="true" />
          {{ 'editor.docEditor.blockMenu.moveUp' | transloco }}
          <z-dropdown-menu-shortcut>{{
            'editor.docEditor.blockMenu.moveUpKey' | transloco
          }}</z-dropdown-menu-shortcut>
        </z-dropdown-menu-item>
        <z-dropdown-menu-item
          [zDisabled]="!c.actions.canMoveDown"
          data-action="move-down"
          (click)="run('move-down')"
        >
          <ng-icon name="lucideArrowDown" aria-hidden="true" />
          {{ 'editor.docEditor.blockMenu.moveDown' | transloco }}
          <z-dropdown-menu-shortcut>{{
            'editor.docEditor.blockMenu.moveDownKey' | transloco
          }}</z-dropdown-menu-shortcut>
        </z-dropdown-menu-item>
        <z-dropdown-menu-item
          [zDisabled]="!c.actions.canDuplicate"
          data-action="duplicate"
          (click)="run('duplicate')"
        >
          <ng-icon name="lucideCopy" aria-hidden="true" />
          {{ 'editor.docEditor.blockMenu.duplicate' | transloco }}
        </z-dropdown-menu-item>
        @if (c.actions.canUnwrap) {
          <z-dropdown-menu-item data-action="unwrap" (click)="run('unwrap')">
            <ng-icon name="lucideSquareDashed" aria-hidden="true" />
            {{ 'editor.docEditor.blockMenu.unwrap' | transloco }}
          </z-dropdown-menu-item>
        }
        @if (c.snippet !== undefined) {
          <z-dropdown-menu-item
            [zDisabled]="c.snippet !== null"
            data-action="save-snippet"
            (click)="run('save-snippet')"
          >
            <ng-icon name="lucideBookmarkPlus" aria-hidden="true" />
            <span class="flex min-w-0 flex-col">
              {{ 'editor.docEditor.saveSnippet.action' | transloco }}
              @if (c.snippet) {
                <span
                  class="text-muted-foreground text-xs break-words whitespace-normal"
                  data-slot="save-snippet-reason"
                  >{{ c.snippet | transloco }}</span
                >
              }
            </span>
          </z-dropdown-menu-item>
        }
        <z-dropdown-menu-separator />
        <z-dropdown-menu-item
          zType="destructive"
          [zDisabled]="!c.actions.canDelete"
          data-action="delete"
          (click)="run('delete')"
        >
          <ng-icon name="lucideTrash2" aria-hidden="true" />
          {{ 'editor.docEditor.blockMenu.delete' | transloco }}
        </z-dropdown-menu-item>
      }
    </z-dropdown-menu-content>
  `,
})
export class BlockMenuComponent {
  /** The editor the menu belongs to: its page's settings say whether snippets can be saved. */
  readonly editor = input<Editor | null>(null);
  /** After a move, to announce the block's new place. */
  readonly moved = output<void>();

  private readonly dropdown = inject(ZardDropdownService);
  private readonly toast = inject(ToastService);
  private readonly viewContainer = inject(ViewContainerRef);
  private readonly menu =
    viewChild.required<ZardDropdownMenuContentComponent>('menu');

  protected readonly current = signal<Open | null>(null);
  /** The menus the dropdown service had opened when this one opened: a later one replaced it. */
  private generation = -1;
  /** The toast of the last delete, gone once the document changes again. */
  private deletedToast: { id: number; view: EditorView } | null = null;

  constructor() {
    // Closed (Escape, a click elsewhere, an action, another menu): the grip goes back to normal.
    effect(() => {
      const open = this.dropdown.isOpen();
      const generation = this.dropdown.generation();
      const current = untracked(this.current);
      if (!current || (open && generation === this.generation)) return;
      this.current.set(null);
      this.closed(current.view);
    });
    inject(DestroyRef).onDestroy(() => {
      // A delete's Undo can do nothing once the editor is gone.
      if (this.deletedToast) this.toast.dismiss(this.deletedToast.id);
      const current = this.current();
      if (current && this.dropdown.generation() === this.generation)
        this.dropdown.close();
    });
  }

  /** Opens the menu for `request.pos`, against the grip. */
  open(view: EditorView, request: BlockMenuRequest): void {
    this.current.set({
      view,
      pos: request.pos,
      actions: blockActions(view.state, request.pos),
      snippet: this.snippetBlocked(request.pos),
    });
    this.dropdown.open(
      new ElementRef(request.anchor),
      this.menu().contentTemplate(),
      this.viewContainer,
      { side: 'bottom', align: 'start' },
      request.keyboard ? { initialFocus: 'first' } : undefined,
    );
    this.generation = this.dropdown.generation();
  }

  /**
   * The document changed: a delete's toast goes (its Undo would take back something else now).
   */
  documentChanged(view: EditorView, tidied = false): void {
    const toast = this.deletedToast;
    if (!toast || toast.view !== view) return;
    // Blank lines tidied away join the delete's undo step: its Undo still takes back the delete.
    if (tidied) return;
    this.deletedToast = null;
    this.toast.dismiss(toast.id);
  }

  /** Why "Save as snippet" can't run for the block at `pos` (see `Open.snippet`). */
  private snippetBlocked(pos: number): string | null | undefined {
    const editor = this.editor();
    return editor && !editor.isDestroyed
      ? saveSnippetBlocked(editor, pos)
      : undefined;
  }

  protected run(
    action:
      | 'delete'
      | 'duplicate'
      | 'move-up'
      | 'move-down'
      | 'unwrap'
      | 'save-snippet',
  ): void {
    const current = this.current();
    if (!current) return;
    const { view } = current;
    // The document may have turned read-only, or the block gone, while the menu was open; the
    // plugin follows the block through changes, so its position is the one to act on.
    if (view.isDestroyed || !view.editable) return;
    const pos = blockMenuPos(view.state);
    if (pos === null) return;
    view.focus();
    switch (action) {
      case 'delete':
        this.delete(view, pos);
        break;
      case 'duplicate':
        duplicateBlock(view, pos);
        break;
      case 'unwrap':
        unwrapBlock(view, pos);
        break;
      case 'save-snippet': {
        const editor = this.editor();
        if (editor && !editor.isDestroyed) saveAsSnippet(editor, pos);
        break;
      }
      case 'move-up':
      case 'move-down':
        if (moveBlock(view, pos, action === 'move-up')) this.moved.emit();
        break;
    }
  }

  private delete(view: EditorView, pos: number): void {
    if (!deleteBlock(view, pos)) return;
    const record = { id: 0, view };
    const steps = undoDepth(view.state);
    const id = this.toast.success(
      translated('editor.docEditor.blockMenu.deleted'),
      {
        actionLabel: translated('ui.toast.undo'),
        onAction: () => {
          this.deletedToast = null;
          // Only while the delete is still the last change: a later edit dismisses this toast
          // (`documentChanged`), and the depth catches what slipped past; blank lines tidied
          // since join the delete's step and go back with it.
          if (
            view.isDestroyed ||
            !view.editable ||
            undoDepth(view.state) !== steps
          )
            return;
          undo(view.state, view.dispatch);
          view.focus();
        },
      },
    );
    // Dismissed once something else changes the document (from the next change on).
    record.id = id;
    this.deletedToast = record;
  }

  private closed(view: EditorView): void {
    closeBlockMenu(view);
    if (view.isDestroyed) return;
    // Closed from the keyboard (Escape) with the focus nowhere: back to the document.
    const doc = view.dom.ownerDocument;
    const active = doc.activeElement;
    if (!active || active === doc.body) view.focus();
  }
}
