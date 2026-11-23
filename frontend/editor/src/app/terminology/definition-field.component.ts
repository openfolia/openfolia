import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
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
  lucideBold,
  lucideCode,
  lucideItalic,
  lucideSquareMousePointer,
  lucideSubscript,
  lucideSuperscript,
} from '@ng-icons/lucide';
import { Editor, Extension, Node, type JSONContent } from '@tiptap/core';
import { Placeholder, UndoRedo } from '@tiptap/extensions';
import { createEditorExtensions } from '@openfolia/content-editor-model';

import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate } from '@openfolia/ui/i18n';

import type { Schema } from '../api';

import {
  DEFINITION_MAX,
  definitionLength,
  sameJson,
  type TermDefinition,
} from './terms-model';

type MarkName = 'strong' | 'emphasis' | 'code' | 'ui' | 'sub' | 'sup';
type TextMark = Schema<'Mark'>;

/** The marks the field's toolbar toggles, in the module editor's order; labels are its keys. */
const MARKS: readonly { id: MarkName; label: string; icon: string }[] = [
  { id: 'strong', label: 'editor.docEditor.mark.bold', icon: 'lucideBold' },
  {
    id: 'emphasis',
    label: 'editor.docEditor.mark.italic',
    icon: 'lucideItalic',
  },
  { id: 'code', label: 'editor.docEditor.mark.code', icon: 'lucideCode' },
  {
    id: 'ui',
    label: 'editor.docEditor.mark.ui',
    icon: 'lucideSquareMousePointer',
  },
  { id: 'sub', label: 'editor.docEditor.mark.sub', icon: 'lucideSubscript' },
  { id: 'sup', label: 'editor.docEditor.mark.sup', icon: 'lucideSuperscript' },
];

/** The model's types a definition may hold: text, a line break and the inline marks. */
const KEPT = new Set([
  'text',
  'hardBreak',
  'strong',
  'emphasis',
  'code',
  'ui',
  'sub',
  'sup',
  'link',
  // In the schema only because a link excludes it: a definition holds no term links, and one
  // pasted in is read back as its text (`docToDefinition`).
  'term',
]);

/** One line of inline content: the whole document of the field. */
const DefinitionDoc = Node.create({
  name: 'doc',
  topNode: true,
  content: 'definition',
});
const DefinitionLine = Node.create({
  name: 'definition',
  content: 'inline*',
  parseHTML: () => [{ tag: 'p' }, { tag: 'div' }],
  renderHTML: () => ['p', { class: 'm-0' }, 0],
});

/** Enter makes a line break (a definition has no paragraphs); the marks' shortcuts. */
const DefinitionKeys = Extension.create({
  name: 'definitionKeys',
  addKeyboardShortcuts() {
    const editor = this.editor;
    return {
      Enter: () => editor.commands.insertContent({ type: 'hardBreak' }),
      'Shift-Enter': () => editor.commands.insertContent({ type: 'hardBreak' }),
      'Mod-b': () => editor.commands.toggleMark('strong'),
      'Mod-i': () => editor.commands.toggleMark('emphasis'),
      'Mod-e': () => editor.commands.toggleMark('code'),
      'Mod-,': () => editor.commands.toggleMark('sub'),
      'Mod-.': () => editor.commands.toggleMark('sup'),
      'Mod-Shift-u': () => editor.commands.toggleMark('ui'),
    };
  },
});

/** A definition as the field's document. */
export function definitionToDoc(
  definition: TermDefinition | undefined,
): JSONContent {
  const content: JSONContent[] = (definition ?? []).map((n) =>
    n.type === 'hardBreak'
      ? { type: 'hardBreak' }
      : {
          type: 'text',
          text: n.text,
          ...(n.marks?.length
            ? {
                marks: n.marks.map((m) =>
                  m.type === 'link'
                    ? { type: 'link', attrs: { href: m.href } }
                    : { type: m.type },
                ),
              }
            : {}),
        },
  );
  return {
    type: 'doc',
    content: [{ type: 'definition', ...(content.length ? { content } : {}) }],
  };
}

/**
 * The field's document as a definition: its runs and line breaks; empty (only white space, or
 * nothing): none. Leading and trailing line breaks are left out.
 */
export function docToDefinition(doc: JSONContent): TermDefinition | undefined {
  const nodes: TermDefinition = [];
  for (const node of doc.content?.[0]?.content ?? []) {
    if (node.type === 'hardBreak') {
      nodes.push({ type: 'hardBreak' });
    } else if (node.type === 'text' && node.text) {
      const marks = (node.marks ?? []).flatMap((m): TextMark[] => {
        if (m.type === 'link') {
          const href = m.attrs?.['href'];
          return typeof href === 'string' ? [{ type: 'link', href }] : [];
        }
        return MARKS.some((k) => k.id === m.type)
          ? [{ type: m.type as MarkName }]
          : [];
      });
      nodes.push({
        type: 'text',
        text: node.text,
        ...(marks.length ? { marks } : {}),
      });
    }
  }
  while (nodes[0]?.type === 'hardBreak') nodes.shift();
  while (nodes.at(-1)?.type === 'hardBreak') nodes.pop();
  const hasText = nodes.some((n) => n.type === 'text' && n.text.trim() !== '');
  return hasText ? nodes : undefined;
}

/**
 * A term's definition in one language as a small rich-text field: text with the module editor's
 * inline marks (bold, italic, code, UI label, subscript, superscript; a link is kept) and line
 * breaks, nothing else (a paste brings only these). The toolbar's buttons and the same shortcuts
 * as the module editor set the marks; Enter makes a line break. Every change is handed on at once
 * (`changed`; undefined: no definition): the draft saves one at a time and keeps the latest.
 * Read-only, the definition stands as text.
 */
@Component({
  selector: 'of-definition-field',
  imports: [NgIcon, TranslocoPipe, ZardButtonComponent],
  viewProviders: [
    provideIcons({
      lucideBold,
      lucideCode,
      lucideItalic,
      lucideSquareMousePointer,
      lucideSubscript,
      lucideSuperscript,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-1.5' },
  template: `
    <div
      class="flex min-w-0 flex-col"
      [class]="
        editable()
          ? 'focus-within:border-ring focus-within:ring-ring/50 dark:bg-input/30 rounded-md border bg-transparent shadow-xs transition-[color,box-shadow] duration-150 focus-within:ring-[3px] motion-reduce:transition-none ' +
            (tooLong() ? 'border-destructive' : 'border-input')
          : ''
      "
    >
      @if (editable()) {
        <div
          class="border-border flex flex-wrap gap-0.5 border-b p-1"
          role="toolbar"
          [attr.aria-label]="
            'editor.terminology.definition.toolbar' | transloco
          "
          [attr.aria-controls]="inputId()"
        >
          @for (m of marks; track m.id) {
            <button
              z-button
              zType="ghost"
              zSize="icon-sm"
              type="button"
              class="data-[active]:bg-muted"
              [attr.data-mark]="m.id"
              [attr.data-active]="active().includes(m.id) ? '' : null"
              [attr.aria-pressed]="active().includes(m.id)"
              [attr.aria-label]="m.label | transloco"
              [attr.title]="m.label | transloco"
              (mousedown)="$event.preventDefault()"
              (click)="toggle(m.id)"
            >
              <ng-icon [name]="m.icon" aria-hidden="true" />
            </button>
          }
        </div>
      }
      <div
        #mount
        class="min-w-0 text-sm break-words [&_.ProseMirror]:min-h-[inherit] [&_.ProseMirror]:outline-none [&_[data-mark=ui]]:font-medium [&_code]:bg-muted [&_code]:rounded-sm [&_code]:px-1 [&_.is-empty:first-child]:before:text-muted-foreground [&_.is-empty:first-child]:before:pointer-events-none [&_.is-empty:first-child]:before:float-start [&_.is-empty:first-child]:before:h-0 [&_.is-empty:first-child]:before:content-[attr(data-placeholder)]"
        [class.px-3]="editable()"
        [class.py-2]="editable()"
        [class.min-h-14]="editable()"
        [attr.lang]="lang() || null"
      ></div>
    </div>
    @if (tooLong()) {
      <p class="text-destructive m-0 text-xs" aria-live="polite">
        {{ 'editor.terminology.definition.tooLong' | transloco: { max } }}
      </p>
    }
  `,
})
export class DefinitionFieldComponent {
  private readonly t = injectTranslate();

  readonly value = input<TermDefinition | undefined>(undefined);
  /** The field's accessible name. */
  readonly label = input.required<string>();
  readonly inputId = input.required<string>();
  readonly lang = input('');
  readonly editable = input(false);
  readonly changed = output<TermDefinition | undefined>();

  protected readonly marks = MARKS;
  protected readonly max = DEFINITION_MAX;
  protected readonly active = signal<readonly MarkName[]>([]);
  protected readonly tooLong = signal(false);
  private readonly mount = viewChild.required<ElementRef<HTMLElement>>('mount');
  private editor: Editor | null = null;
  /** The definition last handed on (or shown): an echo of it changes nothing. */
  private last: TermDefinition | undefined;

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      this.last = this.value();
      const editor = new Editor({
        element: this.mount().nativeElement,
        editable: this.editable(),
        extensions: [
          DefinitionDoc,
          DefinitionLine,
          ...createEditorExtensions().filter((e) => KEPT.has(e.name)),
          UndoRedo,
          DefinitionKeys,
          Placeholder.configure({
            placeholder: () =>
              this.t('editor.terminology.definition.placeholder'),
          }),
        ],
        content: definitionToDoc(this.value()),
        editorProps: {
          attributes: {
            id: this.inputId(),
            role: 'textbox',
            'aria-multiline': 'true',
            'aria-label': this.label(),
          },
        },
        onSelectionUpdate: () => this.readMarks(),
        onTransaction: () => this.readMarks(),
        // Every change at once: the draft saves one at a time and keeps the latest, so nothing
        // waits here to be lost when the field goes without a blur.
        onUpdate: () => this.flush(),
      });
      this.editor = editor;
      destroyRef.onDestroy(() => editor.destroy());
    });
    // A newer definition from outside (another term, a reload, a refused save): shown.
    effect(() => {
      const value = this.value();
      untracked(() => {
        const editor = this.editor;
        if (!editor || sameJson(value ?? null, this.last ?? null)) return;
        this.last = value;
        editor.commands.setContent(definitionToDoc(value), {
          emitUpdate: false,
        });
        this.tooLong.set(false);
      });
    });
    effect(() => {
      const editable = this.editable();
      untracked(() => this.editor?.setEditable(editable, false));
    });
  }

  protected toggle(mark: MarkName): void {
    this.editor?.chain().focus().toggleMark(mark).run();
  }

  private readMarks(): void {
    const editor = this.editor;
    if (!editor) return;
    this.active.set(
      MARKS.filter((m) => editor.isActive(m.id)).map((m) => m.id),
    );
  }

  /** Hands the definition on, if it changed and fits. */
  private flush(): void {
    const editor = this.editor;
    if (!editor || !this.editable()) return;
    const next = docToDefinition(editor.getJSON());
    if (next && definitionLength(next) > DEFINITION_MAX) {
      this.tooLong.set(true);
      return;
    }
    this.tooLong.set(false);
    if (sameJson(next ?? null, this.last ?? null)) return;
    this.last = next;
    this.changed.emit(next);
  }
}
