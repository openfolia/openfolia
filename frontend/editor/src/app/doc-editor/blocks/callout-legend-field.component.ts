import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Editor, Extension, type JSONContent } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideBold, lucideCode, lucideItalic } from '@ng-icons/lucide';
import { TranslocoPipe } from '@jsverse/transloco';
import { createEditorExtensions } from '@openfolia/content-editor-model';
import { ZardButtonComponent } from '@openfolia/ui/button';

import { NODE_VIEW } from './doc-blocks-context';

/** The marks the legend field's buttons toggle (the others have their shortcuts only). */
const FIELD_MARKS = [
  { id: 'strong', label: 'editor.docEditor.mark.bold', icon: 'lucideBold' },
  {
    id: 'emphasis',
    label: 'editor.docEditor.mark.italic',
    icon: 'lucideItalic',
  },
  { id: 'code', label: 'editor.docEditor.mark.code', icon: 'lucideCode' },
] as const;

/** The legend's inline content as JSON (what the image's callout node holds). */
export type LegendJson = JSONContent[];

/** The inline content of every text block of a document, one line: blocks joined by a space. */
function oneLineOf(doc: ProseMirrorNode): LegendJson {
  const out: LegendJson = [];
  doc.descendants((node) => {
    if (!node.isTextblock) return true;
    if (out.length > 0 && node.childCount > 0)
      out.push({ type: 'text', text: ' ' });
    node.forEach((child) =>
      out.push(
        child.type.name === 'hardBreak'
          ? { type: 'text', text: ' ' }
          : (child.toJSON() as JSONContent),
      ),
    );
    return false;
  });
  return out;
}

const docOf = (legend: LegendJson): JSONContent => ({
  type: 'doc',
  content: [
    { type: 'paragraph', ...(legend.length ? { content: legend } : {}) },
  ],
});

/**
 * A callout's legend, edited in place: one line of text with marks (Mod+B, I, E, Shift+U,
 * comma, full stop, and buttons for bold, italic and code), in an editor of its own on the
 * content model's schema. Each change goes to the document at once (`legendChange`, the inline
 * content as JSON); what the document holds comes back in through `legend` (an Undo there shows
 * here). It keeps no history: Mod+Z and Shift+Mod+Z (Mod+Y) are the document's Undo and Redo, so
 * a legend typed here is undone like any other text. Enter and Escape end the editing (`done`),
 * a line break is not taken, and pasted blocks become one line.
 */
@Component({
  selector: 'of-callout-legend-field',
  imports: [NgIcon, TranslocoPipe, ZardButtonComponent],
  viewProviders: [provideIcons({ lucideBold, lucideCode, lucideItalic })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'flex min-w-0 items-start gap-1',
    'data-node-view-control': '',
  },
  template: `
    <div
      #field
      class="border-input bg-background focus-within:ring-ring/50 min-h-8 min-w-0 flex-1 rounded-md border px-2 py-1 text-sm focus-within:ring-2 [overflow-wrap:anywhere]"
      data-slot="callout-legend"
    ></div>
    <div class="flex shrink-0 gap-0.5" (mousedown)="$event.preventDefault()">
      @for (mark of marks; track mark.id) {
        <button
          z-button
          type="button"
          zType="ghost"
          zSize="icon-sm"
          tabindex="-1"
          [attr.aria-label]="mark.label | transloco"
          [attr.aria-pressed]="active()[mark.id] === true"
          [class.bg-muted]="active()[mark.id]"
          (click)="toggle(mark.id)"
        >
          <ng-icon [name]="mark.icon" aria-hidden="true" />
        </button>
      }
    </div>
  `,
})
export class CalloutLegendFieldComponent {
  private readonly view = inject(NODE_VIEW);
  private readonly field = viewChild.required<ElementRef<HTMLElement>>('field');

  /** What the document holds now. */
  readonly legend = input.required<LegendJson>();
  /** The field's accessible name. */
  readonly label = input.required<string>();
  /** Focus the field as soon as it is there (a callout just added). */
  readonly autofocus = input(false);

  readonly legendChange = output<LegendJson>();
  /** Enter or Escape: the person is done with the legend. */
  readonly done = output<void>();

  protected readonly marks = FIELD_MARKS;
  protected readonly active = signal<Record<string, boolean>>({});

  private editor: Editor | null = null;

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => this.mount());
    destroyRef.onDestroy(() => {
      this.editor?.destroy();
      this.editor = null;
    });
    // The callout's number can change (a move, a reorder): its name follows.
    effect(() => {
      const label = this.label();
      untracked(() => this.editor?.view.dom.setAttribute('aria-label', label));
    });
    // The document changed under the field (an Undo): show what it holds.
    effect(() => {
      const legend = this.legend();
      untracked(() => {
        const editor = this.editor;
        if (!editor || editor.isDestroyed) return;
        if (
          JSON.stringify(oneLineOf(editor.state.doc)) === JSON.stringify(legend)
        )
          return;
        editor.commands.setContent(docOf(legend), { emitUpdate: false });
        editor.commands.focus('end', { scrollIntoView: false });
      });
    });
  }

  private mount(): void {
    const view = this.view;
    const done = () => {
      this.done.emit();
      return true;
    };
    const keys = Extension.create({
      name: 'calloutLegendKeys',
      addKeyboardShortcuts() {
        const editor = this.editor;
        return {
          Enter: done,
          'Shift-Enter': () => true,
          'Mod-Enter': () => true,
          Escape: done,
          'Mod-z': () => view.history('undo') || true,
          'Mod-Shift-z': () => view.history('redo') || true,
          'Mod-y': () => view.history('redo') || true,
          'Mod-b': () => editor.commands.toggleMark('strong'),
          'Mod-i': () => editor.commands.toggleMark('emphasis'),
          'Mod-e': () => editor.commands.toggleMark('code'),
          'Mod-Shift-u': () => editor.commands.toggleMark('ui'),
          'Mod-,': () => editor.commands.toggleMark('sub'),
          'Mod-.': () => editor.commands.toggleMark('sup'),
        };
      },
    });
    const editor = new Editor({
      element: this.field().nativeElement,
      extensions: [...createEditorExtensions(), keys],
      content: docOf(this.legend()),
      editorProps: {
        attributes: {
          role: 'textbox',
          'aria-multiline': 'false',
          'aria-label': this.label(),
          class: 'outline-none [&_p]:m-0',
        },
      },
      onUpdate: ({ editor: e }) => {
        const legend = oneLineOf(e.state.doc);
        // Pasted blocks: one line again.
        if (e.state.doc.childCount > 1)
          e.commands.setContent(docOf(legend), { emitUpdate: false });
        this.legendChange.emit(legend);
      },
      onSelectionUpdate: () => this.readMarks(),
      onTransaction: () => this.readMarks(),
    });
    this.editor = editor;
    if (this.autofocus()) editor.commands.focus('end');
  }

  private readMarks(): void {
    const editor = this.editor;
    if (!editor) return;
    this.active.set(
      Object.fromEntries(FIELD_MARKS.map((m) => [m.id, editor.isActive(m.id)])),
    );
  }

  /** Focuses the field, the caret at the end. */
  focus(): void {
    this.editor?.commands.focus('end');
  }

  protected toggle(mark: string): void {
    this.editor?.chain().focus().toggleMark(mark).run();
  }
}
