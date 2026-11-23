import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import {
  highlightCode,
  languageOf,
  type CodeLanguage,
  type CodeToken,
  type CodeTokenKind,
} from './code-highlight';

/** A line the editor marks: a problem found there (1-based line), told in words elsewhere too. */
export interface CodeMarker {
  readonly line: number;
  readonly message: string;
}

/** Where the caret is, 1-based. */
export interface CodeCaret {
  readonly line: number;
  readonly column: number;
}

/** One indent step. */
const INDENT = '  ';
/** The height of a line in pixels (`leading-5`): the gutter, the code and the caret follow it. */
const LINE_HEIGHT = 20;

/** The classes of each kind of token: the theme's colours, never colour alone for meaning. */
const TOKEN_CLASSES: Readonly<Record<CodeTokenKind, string>> = {
  text: '',
  comment: 'text-muted-foreground italic',
  string: 'text-success',
  keyword: 'text-primary font-medium',
  function: 'text-info',
  number: 'text-warning',
  heading: 'text-foreground font-semibold',
  key: 'text-info',
  tag: 'text-primary',
};

/**
 * A code editor for a project's text files (#396): a plain `<textarea>` over the same text drawn
 * with syntax highlighting (Typst, YAML, JSON, XML/SVG; `languageOf` a path), line numbers in a
 * gutter that stays put while the code scrolls sideways, and lines marked where a problem is
 * (`markers`: the line tinted, its number in the destructive colour; the problem itself is told
 * in words beside the editor). What is typed is the textarea's: the browser's own caret,
 * selection, undo, spell check off, and screen readers read a text field.
 *
 * Tab indents (the selected lines, or two spaces), Shift+Tab takes the indent back, Enter keeps
 * the line's indent; Escape and then Tab leaves the editor, as `label`'s hint says. Ctrl/Cmd+S
 * asks to save (`saveRequest`). `revealLine` puts the caret on a line and scrolls it into view.
 * `readonly` keeps the text as it is.
 */
@Component({
  selector: 'of-code-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    'data-slot': 'code-editor',
    class:
      'bg-card focus-within:border-ring focus-within:ring-ring/40 relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border transition-[border-color,box-shadow] duration-150 focus-within:ring-[3px] motion-reduce:transition-none',
  },
  template: `
    <div
      #scroller
      class="relative min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain"
      data-slot="code-editor-scroller"
    >
      <div class="grid w-max min-w-full grid-cols-[auto_minmax(0,1fr)]">
        <div
          class="bg-muted/50 text-muted-foreground sticky left-0 z-10 border-e py-3 ps-3 pe-2.5 text-right font-mono text-[13px] leading-5 tabular-nums select-none"
          aria-hidden="true"
          data-slot="code-editor-gutter"
        >
          @for (line of lines(); track $index) {
            <div
              class="relative min-w-[2ch]"
              [class.text-destructive]="marked().has($index + 1)"
              [class.font-semibold]="marked().has($index + 1)"
              [class.text-foreground]="
                caretLine() === $index + 1 && !marked().has($index + 1)
              "
              [attr.data-marked]="marked().has($index + 1) ? '' : null"
            >
              @if (marked().has($index + 1)) {
                <span
                  class="bg-destructive absolute top-1/2 -left-2 size-1.5 -translate-y-1/2 rounded-full"
                ></span>
              }
              {{ $index + 1 }}
            </div>
          }
        </div>
        <div class="relative grid min-w-0">
          <pre
            class="pointer-events-none col-start-1 row-start-1 m-0 py-3 font-mono text-[13px] leading-5 whitespace-pre [tab-size:2]"
            aria-hidden="true"
            data-slot="code-editor-code"
          ><code class="block">@for (line of lines(); track $index) {<span class="block min-h-5 px-3" [class.bg-destructive-muted]="marked().has($index + 1)" [class.bg-muted]="focused() && caretLine() === $index + 1 && !marked().has($index + 1)" [attr.data-line]="$index + 1">@for (token of line; track $index) {<span [class]="classOf(token)">{{ token.text }}</span>}</span>}</code></pre>
          <textarea
            #area
            class="caret-foreground selection:bg-primary/25 col-start-1 row-start-1 m-0 block size-full min-w-0 resize-none overflow-hidden border-0 bg-transparent px-3 py-3 font-mono text-[13px] leading-5 whitespace-pre text-transparent outline-none [tab-size:2]"
            rows="1"
            cols="1"
            wrap="off"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            data-slot="code-editor-input"
            [attr.aria-label]="label() || null"
            [attr.aria-describedby]="describedBy() || null"
            [attr.aria-invalid]="markers().length > 0 ? 'true' : null"
            [readOnly]="readonly()"
            (input)="typed()"
            (keydown)="key($event)"
            (focus)="focused.set(true); trackCaret()"
            (blur)="focused.set(false)"
            (click)="trackCaret()"
            (keyup)="trackCaret()"
            (select)="trackCaret()"
          ></textarea>
        </div>
      </div>
    </div>
  `,
})
export class CodeEditorComponent {
  private readonly injector = inject(Injector);
  private readonly area =
    viewChild.required<ElementRef<HTMLTextAreaElement>>('area');
  private readonly scroller =
    viewChild.required<ElementRef<HTMLElement>>('scroller');

  /** The text. A new value replaces what is shown; what is typed comes out as `valueChange`. */
  readonly value = input('');
  /** The language to colour; by default from `path`'s extension, else plain text. */
  readonly language = input<CodeLanguage | null>(null);
  /** The file's path, for its language. */
  readonly path = input('');
  readonly readonly = input(false);
  /** The field's accessible name. */
  readonly label = input('');
  /** The IDs of what describes the field (the keyboard hint, the problems). */
  readonly describedBy = input('');
  /** Lines with a problem. */
  readonly markers = input<readonly CodeMarker[]>([]);

  readonly valueChange = output<string>();
  readonly caretChange = output<CodeCaret>();
  /** Ctrl/Cmd+S in the editor: the host saves now. */
  readonly saveRequest = output<void>();

  /** The text shown: what was typed, or the last value given. */
  private readonly text = signal('');
  protected readonly focused = signal(false);
  protected readonly caretLine = signal(1);
  /** After Escape, Tab leaves the editor (the keyboard is never trapped). */
  private tabLeaves = false;
  private readonly lang = computed(
    () => this.language() ?? languageOf(this.path()),
  );
  /** The text's lines as tokens: Angular then changes only the lines whose tokens changed. */
  protected readonly lines = computed(() =>
    highlightCode(this.text(), this.lang()),
  );
  protected readonly marked = computed(
    () => new Set(this.markers().map((m) => m.line)),
  );

  constructor() {
    effect(() => {
      const value = this.value();
      untracked(() => {
        const area = this.area().nativeElement;
        if (area.value !== value) {
          area.value = value;
          this.text.set(value);
          this.caretLine.set(1);
        }
      });
    });
  }

  protected classOf(token: CodeToken): string {
    return TOKEN_CLASSES[token.kind];
  }

  /** Puts the caret at `line` (and `column`), 1-based, scrolls it into view and focuses the field. */
  revealLine(line: number, column = 1): void {
    const area = this.area().nativeElement;
    const lines = area.value.split('\n');
    const at = Math.min(Math.max(1, line), lines.length);
    let offset = 0;
    for (let i = 0; i < at - 1; i++) offset += (lines[i]?.length ?? 0) + 1;
    offset += Math.min(Math.max(0, column - 1), lines[at - 1]?.length ?? 0);
    area.focus({ preventScroll: true });
    area.setSelectionRange(offset, offset);
    this.trackCaret();
    const scroller = this.scroller().nativeElement;
    const top = (at - 1) * LINE_HEIGHT;
    const wanted = Math.max(0, top - scroller.clientHeight / 3);
    if (typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({
        top: wanted,
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    } else {
      scroller.scrollTop = wanted;
    }
  }

  /** Focuses the field, the caret where it was. */
  focus(): void {
    this.area().nativeElement.focus({ preventScroll: true });
  }

  protected typed(): void {
    const value = this.area().nativeElement.value;
    this.text.set(value);
    this.valueChange.emit(value);
    this.trackCaret();
  }

  protected trackCaret(): void {
    const area = this.area().nativeElement;
    const before = area.value.slice(0, area.selectionEnd);
    const line = before.split('\n').length;
    const column = before.length - before.lastIndexOf('\n');
    this.caretLine.set(line);
    this.caretChange.emit({ line, column });
    afterNextRender(() => this.keepCaretInView(line), {
      injector: this.injector,
    });
  }

  /** The browser scrolls a field to its caret; this field never scrolls itself, its box does. */
  private keepCaretInView(line: number): void {
    const scroller = this.scroller().nativeElement;
    const top = (line - 1) * LINE_HEIGHT + 12;
    const bottom = top + LINE_HEIGHT;
    if (top < scroller.scrollTop) scroller.scrollTop = top - LINE_HEIGHT;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight + LINE_HEIGHT;
    }
  }

  protected key(event: KeyboardEvent): void {
    // An input method composing (Enter or Tab confirms a candidate): the keys are its own.
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      this.tabLeaves = true;
      return;
    }
    if (event.key === 'Tab' && this.tabLeaves) {
      this.tabLeaves = false;
      return;
    }
    this.tabLeaves = false;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      this.saveRequest.emit();
      return;
    }
    if (this.readonly() || event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }
    if (event.key === 'Tab') {
      event.preventDefault();
      if (event.shiftKey) this.outdent();
      else this.indent();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.newLine();
    }
  }

  private indent(): void {
    const area = this.area().nativeElement;
    const { selectionStart: start, selectionEnd: end, value } = area;
    if (!value.slice(start, end).includes('\n')) {
      this.insert(INDENT, start, end);
      return;
    }
    this.changeLines((line) => INDENT + line);
  }

  private outdent(): void {
    this.changeLines((line) =>
      line.startsWith(INDENT)
        ? line.slice(INDENT.length)
        : line.replace(/^[ \t]/, ''),
    );
  }

  /** Changes each line the selection touches, and selects them. */
  private changeLines(change: (line: string) => string): void {
    const area = this.area().nativeElement;
    const { selectionStart: start, selectionEnd: end, value } = area;
    const from = value.lastIndexOf('\n', start - 1) + 1;
    const stop = value.indexOf('\n', end === start ? end : end - 1);
    const to = stop < 0 ? value.length : stop;
    const block = value.slice(from, to);
    const changed = block.split('\n').map(change).join('\n');
    if (changed === block) return;
    this.insert(changed, from, to);
    area.setSelectionRange(from, from + changed.length);
    this.trackCaret();
  }

  private newLine(): void {
    const area = this.area().nativeElement;
    const { selectionStart: start, selectionEnd: end, value } = area;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const indent = /^[ \t]*/.exec(value.slice(lineStart, start))?.[0] ?? '';
    const opens = /[{[(]\s*$/.test(value.slice(lineStart, start));
    this.insert(`\n${indent}${opens ? INDENT : ''}`, start, end);
  }

  /**
   * Replaces `start`–`end` with `text` as typing would: through the browser's editing, so Undo
   * takes it back; where that is missing, directly, with an input event.
   */
  private insert(text: string, start: number, end: number): void {
    const area = this.area().nativeElement;
    area.setSelectionRange(start, end);
    const typed =
      typeof document.execCommand === 'function' &&
      document.execCommand('insertText', false, text);
    if (!typed) {
      area.setRangeText(text, start, end, 'end');
      area.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
