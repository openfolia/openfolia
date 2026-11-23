import { CdkScrollable } from '@angular/cdk/scrolling';
import {
  ApplicationRef,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  EnvironmentInjector,
  ViewEncapsulation,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Editor, type JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { normalizeEditorDoc } from '@openfolia/content-editor-model';
import {
  languageDirection,
  type TextDirection,
} from '@openfolia/content-model/core';

import {
  setDocBlocksContext,
  type CalloutKey,
  type CalloutShowRequest,
  type DocBlockSettings,
  type DocBlocksContext,
} from './blocks/doc-blocks-context';
import { pickAndReplaceImage } from './blocks/doc-blocks';
import { BlockMenuComponent } from './block-menu.component';
import { EditorHandle } from './editor-handle';
import { movedMessage } from './editor-commands';
import { EditorToolbarComponent } from './editor-toolbar.component';
import { createEditorExtensions } from './extensions';
import { isTidy } from './plugins/blank-lines';
import { withCaretGaps, withoutCaretGaps } from './plugins/caret-gaps';
import {
  findBlock,
  setBlockIssues,
  type BlockIssue,
} from './plugins/block-issues';
import { setHeadingCap } from './plugins/heading-levels';
import {
  findTextField,
  imageOfCallout,
  textChange,
  type TextChange,
  type TextChangeRefusal,
} from './text-fields';
import { setSnippets } from './plugins/snippet-suggestions';
import { findingMessage } from './writing/finding-text';
import { setTermHints } from './writing/term-suggestions';
import {
  ignoreFinding,
  type PlacedFinding,
  replaceFinding,
  setSuggestionMarks,
  setWritingRules,
  type SuggestionMark,
  writingFindings,
} from './writing/writing-checks';
import {
  type SuggestionText,
  WritingPopoverComponent,
} from './writing/writing-popover.component';
import { InlineEditPopoverComponent } from './inline/inline-edit-popover.component';
import { setInlineEditor } from './inline/inline-edit';
import { refreshChips } from './inline/inline-views';
import { calloutHoverPlugin, setCalloutHover } from './inline/callout-hover';
import { SelectionBubbleComponent } from './selection-bubble.component';
import {
  FOCUSED_SLASH_ITEMS,
  REGION_SLASH_ITEMS,
  SLASH_ITEMS,
} from './slash/slash-items';
import { REGION_PLACEHOLDER_KEYS } from './inline/placeholders';
import { SlashMenuComponent } from './slash-menu.component';
import { injectTranslate, translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

/**
 * The block editor: TipTap 3 on the content model's schema (`@openfolia/content-editor-model`) in an
 * Angular host, with its toolbar, selection bubble and slash menu. `value` is a document as
 * `toEditor` makes it, read once, when the editor is made, and repaired on the way in
 * (`normalizeEditorDoc`; a document over a cap throws its `EditorLimitError`); another document
 * means a new instance (a new `@for` track or `@if`). Every change hands on the document without
 * the editor's caret gaps, ready for `fromEditor`; mounting alone hands on nothing.
 */
@Component({
  selector: 'of-block-editor',
  imports: [
    CdkScrollable,
    BlockMenuComponent,
    EditorToolbarComponent,
    SelectionBubbleComponent,
    SlashMenuComponent,
    InlineEditPopoverComponent,
    WritingPopoverComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  styleUrls: [
    './block-editor.component.css',
    './container-blocks.css',
    './snippet-suggestions.css',
    './writing/writing-aids.css',
  ],
  host: {
    class:
      'bg-card text-card-foreground border-border flex min-h-0 flex-col rounded-xl border',
  },
  template: `
    @if (handle(); as h) {
      @if (editable()) {
        <of-editor-toolbar
          [handle]="h"
          [dir]="dir()"
          [focused]="focused()"
          [blockItems]="region() ? regionItems : null"
          (moved)="announce($event)"
        />
      }
    }
    <div
      #mount
      cdkScrollable
      data-slot="editor-scroller"
      class="doc-editor-canvas relative min-h-0 flex-1 overflow-y-auto"
    >
      <of-inline-edit-popover [handle]="handle()" [settings]="blocks()" />
      <of-writing-popover
        [handle]="handle()"
        [terms]="writing()?.terms ?? null"
        [suggestions]="suggestionTexts()"
        (suggestionAction)="suggestionAction.emit($event)"
        (announced)="announce($event)"
      />
    </div>
    <of-block-menu
      [editor]="handle()?.editor ?? null"
      (moved)="announceMove()"
    />
    <of-selection-bubble #bubble [handle]="handle()" />
    <of-slash-menu #slash [editorElement]="editorElement()" />
    <span aria-live="polite" class="sr-only">{{ announcement() }}</span>
  `,
})
export class BlockEditorComponent {
  /** The document to edit: read once, when the editor is made. */
  readonly value = input.required<JSONContent>();
  /** An accessible name for the document area; default: "Document", translated. */
  readonly label = input('');
  private readonly t = injectTranslate();
  /** Whether the person may change it; read-only shows the document without the toolbar. */
  readonly editable = input(true);
  /**
   * The focused editor of a contributor's suggestion (#137): the toolbar and "/" offer text,
   * lists, links, images and attachments only (`FOCUSED_SLASH_ITEMS`). Read once, when the
   * editor is made, as `value` is.
   */
  readonly focused = input(false);
  /**
   * A page design region's editor (#393): "/" and the Insert menu offer text, Heading 1 (a
   * region's headings are one level deep), lists, images, notes, links and placeholders
   * (`REGION_SLASH_ITEMS`), and typing `{` offers the region's placeholders
   * (`REGION_PLACEHOLDER_KEYS`). Read once, when the editor is made, as `value` is.
   */
  readonly region = input(false);
  /**
   * What the documentation blocks need from the page: the configuration, the document's language,
   * a module title lookup, opening a module and the pickers (`DocBlockSettings`).
   */
  readonly blocks = input<DocBlockSettings>({});
  /** Problems to show at their blocks (validation issues, a block that cannot be saved yet). */
  readonly issues = input<readonly BlockIssue[]>([]);
  /**
   * The page's suggestions to mark in the text (the style review's, #573), each where its field
   * still reads as when it was made; their popover offers Apply and Dismiss (`suggestionAction`).
   */
  readonly suggestionMarks = input<
    readonly (SuggestionMark & SuggestionText)[]
  >([]);
  /** The writing checks' findings, after each check (#247). */
  readonly findings = output<readonly PlacedFinding[]>();
  /** A marked suggestion's Apply or Dismiss, from its popover. */
  readonly suggestionAction = output<{
    readonly id: string;
    readonly action: 'apply' | 'dismiss';
  }>();
  /** The document after each change, without the editor's own caret gaps. */
  readonly changed = output<JSONContent>();
  /** The focus left the document (and its toolbar and menus): a moment to save. */
  readonly blurred = output<void>();

  /**
   * The document's language (`blocks().lang`) and its direction, as the configuration gives it
   * (#458): set on the document area only, so its text, alignment, lists and grips follow it
   * while the toolbar and menus around it stay left to right. No language: none set.
   */
  private readonly lang = computed(() => this.blocks().lang ?? '');
  protected readonly dir = computed<TextDirection>(() =>
    this.lang() ? languageDirection(this.lang(), this.blocks().config) : 'ltr',
  );

  protected readonly regionItems = REGION_SLASH_ITEMS;
  protected readonly handle = signal<EditorHandle | null>(null);
  protected readonly editorElement = signal<HTMLElement | null>(null);
  protected readonly announcement = signal('');
  /** The callout hovered or focused in this editor (#549), shared by its pictures and chips. */
  private readonly calloutHover = signal<CalloutKey | null>(null);
  /** A callout to show in its image's panel (a suggestion on its legend, #573). */
  private readonly calloutShow = signal<CalloutShowRequest | null>(null);

  private readonly mount = viewChild.required<ElementRef<HTMLElement>>('mount');
  private readonly bubble = viewChild.required(SelectionBubbleComponent);
  private readonly slash = viewChild.required(SlashMenuComponent);
  private readonly inlinePopover = viewChild.required(
    InlineEditPopoverComponent,
  );
  private readonly blockMenu = viewChild.required(BlockMenuComponent);
  private readonly writingPopover = viewChild.required(WritingPopoverComponent);
  /** The writing aids, in an editor that has them: none in a page design region's. */
  protected readonly writing = computed(() =>
    this.region() ? null : (this.blocks().writing ?? null),
  );
  protected readonly suggestionTexts = computed(
    () => new Map(this.suggestionMarks().map((m) => [m.id, m])),
  );
  private readonly toolbar = viewChild(EditorToolbarComponent);

  constructor() {
    const destroyRef = inject(DestroyRef);
    const environment = inject(EnvironmentInjector);
    const appRef = inject(ApplicationRef);
    effect(() => {
      const editable = this.editable();
      this.handle()?.editor.setEditable(editable, false);
    });
    effect(() => {
      const issues = this.issues();
      const editor = this.handle()?.editor;
      if (editor && !editor.isDestroyed) setBlockIssues(editor.view, issues);
    });
    // The heading levels the project allows arrive with its configuration; a region has one.
    effect(() => {
      const cap = this.region() ? 1 : this.blocks().config?.maxHeadingLevel;
      const editor = this.handle()?.editor;
      if (editor && !editor.isDestroyed && cap !== undefined)
        setHeadingCap(editor.view, cap);
    });
    // The snippets to suggest arrive (and change) with the page's settings. None in the focused
    // editor: accepting one puts a module reference or a snippet's blocks in (#137).
    effect(() => {
      const snippets =
        this.focused() || this.region() ? [] : (this.blocks().snippets ?? []);
      const editor = this.handle()?.editor;
      if (editor && !editor.isDestroyed) setSnippets(editor.view, snippets);
    });
    // The writing checks and the terms arrive (and change) with the page's settings (#247).
    effect(() => {
      const aids = this.writing();
      const editor = this.handle()?.editor;
      if (!editor || editor.isDestroyed) return;
      // Untracked: the transaction runs the plugins' view updates, whose callbacks (the findings
      // handed on, the caret announced) read and write signals of their own.
      untracked(() => {
        setWritingRules(editor.view, aids?.rules ?? null);
        setTermHints(editor.view, aids?.terms ?? null);
      });
    });
    effect(() => {
      const marks = this.suggestionMarks();
      const editor = this.handle()?.editor;
      if (editor && !editor.isDestroyed)
        untracked(() => setSuggestionMarks(editor.view, marks));
    });
    // The chips read the configuration (text attributes) and the module lookups from the page,
    // and their words are in the UI language (a translation read here follows a switch).
    effect(() => {
      this.blocks();
      this.t('editor.docEditor.xref.kind.section');
      const editor = this.handle()?.editor;
      if (editor && !editor.isDestroyed) refreshChips(editor.view);
    });
    // The callout hovered or focused anywhere in this editor: its reference chips light up (#549).
    effect(() => {
      const key = this.calloutHover();
      const editor = this.handle()?.editor;
      if (editor && !editor.isDestroyed) setCalloutHover(editor.view, key);
    });
    // The language and direction arrive (and change) with the page's settings.
    effect(() => {
      const attributes = this.contentAttributes();
      const editor = this.handle()?.editor;
      if (editor && !editor.isDestroyed)
        editor.setOptions({ editorProps: { attributes } });
    });
    afterNextRender(() => {
      const context: DocBlocksContext = {
        settings: this.blocks,
        editable: this.editable,
        // A page design region's images carry no callouts (#547 leaves them out).
        callouts: computed(() => !this.region()),
        calloutHover: this.calloutHover,
        calloutShow: this.calloutShow,
      };
      const editor = new Editor({
        editable: this.editable(),
        element: this.mount().nativeElement,
        extensions: createEditorExtensions({
          slashMenu: this.slash(),
          bubble: this.bubble().element,
          onMoved: () => this.announce(movedMessage(editor, this.t)),
          blockMenu: (view, request) => this.blockMenu().open(view, request),
          headingCap: this.region() ? 1 : this.blocks().config?.maxHeadingLevel,
          onInsertMenu: () => this.toolbar()?.openInsert() ?? false,
          slashItems: this.region()
            ? REGION_SLASH_ITEMS
            : this.focused()
              ? FOCUSED_SLASH_ITEMS
              : SLASH_ITEMS,
          ...(this.region() && { placeholders: REGION_PLACEHOLDER_KEYS }),
          placeholder: () => this.t('editor.docEditor.editor.placeholder'),
          titlePlaceholder: () =>
            this.t('editor.docEditor.editor.titlePlaceholder'),
          hazardPlaceholder: () =>
            this.t('editor.docEditor.editor.hazardPlaceholder'),
          blocks: {
            injector: environment,
            appRef,
            context,
          },
          translate: (key, params) => this.t(key, params),
          announce: (text) => this.announce(text),
          writing: {
            onFindings: (findings) => this.findings.emit(findings),
            onCaret: (at) => {
              if (!at || !editor.isFocused) return;
              const message =
                at.kind === 'finding'
                  ? findingMessage(at.finding, this.t)
                  : (this.suggestionTexts().get(at.mark.id)?.message ?? '');
              this.announce(
                this.t('editor.writing.caret', {
                  message,
                  key: this.t('editor.writing.popoverKey'),
                }),
              );
            },
            openAt: (pos) => this.writingPopover().open(pos),
          },
          onSnippetFailed: (title) =>
            this.toast.error(
              translated('editor.docEditor.snippet.failed', { title }),
            ),
        }),
        content: normalizeEditorDoc(withCaretGaps(this.value())),
        editorProps: { attributes: this.contentAttributes() },
      });
      // Commands run on the editor (inserting an image) reach the page's picker through it.
      setDocBlocksContext(editor, context);
      editor.registerPlugin(calloutHoverPlugin(this.calloutHover));
      setInlineEditor(editor, this.inlinePopover());
      editor.on('update', ({ transaction, appendedTransactions }) => {
        // Only blank lines tidied away (by the collapse's timer, or appended to a caret move).
        const changes = [transaction, ...appendedTransactions].filter(
          (tr) => tr.docChanged,
        );
        this.blockMenu().documentChanged(
          editor.view,
          changes.length > 0 && changes.every(isTidy),
        );
        this.changed.emit(withoutCaretGaps(editor.getJSON()));
      });
      editor.on('blur', ({ event }) => {
        // Into the toolbar or a menu of this editor is not leaving it.
        const next = event.relatedTarget as Node | null;
        if (next && this.host.nativeElement.contains(next)) return;
        this.blurred.emit();
      });
      // The bubble plugin makes its element a tab stop; its buttons are reached by the toolbar
      // and the shortcuts, so the bubble itself stays out of the tab order.
      this.bubble().element.tabIndex = -1;
      this.editorElement.set(editor.view.dom as HTMLElement);
      this.handle.set(new EditorHandle(editor));
      destroyRef.onDestroy(() => editor.destroy());
    });
  }

  /** The document area's attributes: its role and name, and its language and direction. */
  private contentAttributes(): Record<string, string> {
    const lang = this.lang();
    return {
      class: 'doc-editor-content',
      role: 'textbox',
      'aria-multiline': 'true',
      'aria-label': this.label() || this.t('editor.docEditor.editor.label'),
      ...(lang && { lang, dir: this.dir() }),
    };
  }

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly toast = inject(ToastService);

  /**
   * Puts the caret at the start of the block with this ID and scrolls it into view (the
   * outline); false when there is none.
   */
  focusBlock(id: string): boolean {
    const editor = this.handle()?.editor;
    if (!editor) return false;
    const found = findBlock(editor.state.doc, id);
    if (!found) return false;
    const { state, view } = editor;
    const selection = TextSelection.near(state.doc.resolve(found.pos + 1));
    view.dispatch(state.tr.setSelection(selection).scrollIntoView());
    view.focus();
    const dom = view.nodeDOM(found.pos);
    if (
      dom instanceof HTMLElement &&
      typeof dom.scrollIntoView === 'function'
    ) {
      const still = dom.ownerDocument.defaultView?.matchMedia?.(
        '(prefers-reduced-motion: reduce)',
      ).matches;
      dom.scrollIntoView({
        block: 'center',
        behavior: still ? 'auto' : 'smooth',
      });
    }
    return true;
  }

  /**
   * Whether `replaceImage(id)` would open the picker: `waiting` until the editor is made,
   * editable and has an image picker; then `ready` when it holds an image block with that ID,
   * else `missing`. Reads the signals it depends on, so an effect calling it runs again as the
   * editor becomes ready.
   */
  replaceImageState(id: string): 'waiting' | 'ready' | 'missing' {
    const editor = this.handle()?.editor;
    if (!editor || !this.editable() || !this.blocks().pickImage)
      return 'waiting';
    return findBlock(editor.state.doc, id)?.node.type.name === 'image'
      ? 'ready'
      : 'missing';
  }

  /**
   * Opens the image picker on the image block with this ID (`pickAndReplaceImage`): resolves to
   * whether its image changed.
   */
  replaceImage(id: string): Promise<boolean> {
    const editor = this.handle()?.editor;
    return editor ? pickAndReplaceImage(editor, id) : Promise.resolve(false);
  }

  /**
   * The plain text of a block's field, as the content model's translatable units name it (a
   * paragraph's `content`, an image callout's `legend` by the callout's ID, …); null when the
   * editor has no such field (`findTextField`).
   */
  textOf(blockId: string, field: string): string | null {
    const editor = this.handle()?.editor;
    if (!editor) return null;
    return findTextField(editor.state.doc, blockId, field)?.plain.text ?? null;
  }

  /**
   * `textOf` as the document reads now, kept: later edits do not change what it answers (the
   * text a style review was asked about, #573).
   */
  textsNow(): (blockId: string, field: string) => string | null {
    const doc = this.handle()?.editor.state.doc;
    return (blockId, field) =>
      doc ? (findTextField(doc, blockId, field)?.plain.text ?? null) : null;
  }

  /**
   * Makes a change to a range of a field's text in one step that Undo takes back, then shows the
   * field (`showText`); refused (nothing changes) when the field is gone or reads otherwise than
   * `change.expected` (`textChange`).
   */
  changeText(change: TextChange): 'applied' | TextChangeRefusal {
    const editor = this.handle()?.editor;
    if (!editor || !this.editable()) return 'missing';
    const result = textChange(editor.state, change);
    if ('refused' in result) return result.refused;
    editor.view.dispatch(result.tr);
    this.showText(change.blockId, change.field);
    return 'applied';
  }

  /**
   * Brings a field into view: an image callout's legend in its image's callout panel (opened on
   * it), any other field by putting the caret in its block. False when there is none.
   */
  showText(blockId: string, field: string): boolean {
    const editor = this.handle()?.editor;
    if (!editor) return false;
    if (field === 'legend') {
      const image = imageOfCallout(editor.state.doc, blockId);
      if (!image) return false;
      this.calloutShow.update((last) => ({
        block: image,
        callout: blockId,
        seq: (last?.seq ?? 0) + 1,
      }));
      return true;
    }
    return this.focusBlock(blockId);
  }

  /**
   * Puts a writing finding's replacement in (one undo step), then shows it; false when it has
   * none, is gone or its text changed (`replaceFinding`).
   */
  replaceFinding(id: string): boolean {
    const editor = this.handle()?.editor;
    if (!editor || !this.editable()) return false;
    return replaceFinding(editor.view, id);
  }

  /** "Ignore here" for a writing finding (this editing session). */
  ignoreFinding(id: string): boolean {
    const editor = this.handle()?.editor;
    return editor ? ignoreFinding(editor.view, id) : false;
  }

  /** Selects a writing finding's text and scrolls it into view; false when it is gone. */
  showFinding(id: string): boolean {
    const editor = this.handle()?.editor;
    if (!editor) return false;
    const found = writingFindings(editor.state).find((f) => f.id === id);
    if (!found) return false;
    const { state, view } = editor;
    view.dispatch(
      state.tr
        .setSelection(TextSelection.create(state.doc, found.from, found.to))
        .scrollIntoView(),
    );
    view.focus();
    return true;
  }

  /** The editor, once made: for a host that needs it (tests, the module editor). */
  get editor(): Editor | null {
    return this.handle()?.editor ?? null;
  }

  /** A move from the block's menu: its new place, as Alt+Up/Down announces it. */
  protected announceMove(): void {
    const editor = this.editor;
    if (editor) this.announce(movedMessage(editor, this.t));
  }

  protected announce(message: string): void {
    // The same words twice in a row are still announced: cleared, rendered, then set again.
    this.announcement.set('');
    setTimeout(() => this.announcement.set(message), 50);
  }
}
