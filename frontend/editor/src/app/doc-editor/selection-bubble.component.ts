import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBookmarkPlus,
  lucideBold,
  lucideCode,
  lucideItalic,
  lucideKeyboard,
  lucideLink,
  lucideSquareMousePointer,
  lucideSubscript,
  lucideSuperscript,
} from '@ng-icons/lucide';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate, translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';
import { ZardTooltipImports } from '@openfolia/ui/tooltip';

import { toggleMark, type Mark } from './editor-commands';
import type { EditorHandle } from './editor-handle';
import {
  canInsertInline,
  canMark,
  linkRequest,
  newAtomRequest,
  openInlineEdit,
} from './inline/inline-edit';
import { saveAsSnippet, saveSnippetBlocked } from './snippets/save-snippet';
import { TranslocoPipe } from '@jsverse/transloco';

/** The marks the bubble toggles, in its order; each label is a translation key. */
const BUBBLE_MARKS: readonly { id: Mark; label: string; icon: string }[] = [
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

/** The marks the bubble offers (for the coverage test: every mark has a way to set it). */
export const BUBBLE_MARK_IDS: readonly Mark[] = BUBBLE_MARKS.map((m) => m.id);

/**
 * The marks over a text selection, floating above it, and the link and the key combination made
 * of it. TipTap's bubble menu plugin shows, hides and positions the element; this component only
 * fills it. Keyboard users reach the same through the shortcuts (Mod+B, I, E, Shift+U, comma,
 * full stop, K) and the "/" menu.
 */
@Component({
  selector: 'of-selection-bubble',
  imports: [NgIcon, ZardButtonComponent, ZardTooltipImports, TranslocoPipe],
  viewProviders: [
    provideIcons({
      lucideBookmarkPlus,
      lucideBold,
      lucideCode,
      lucideItalic,
      lucideKeyboard,
      lucideLink,
      lucideSquareMousePointer,
      lucideSubscript,
      lucideSuperscript,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'toolbar',
    '[attr.aria-label]': 'label()',
    class:
      'bg-popover text-popover-foreground border-border z-50 flex gap-0.5 rounded-lg border p-1 shadow-md',
    // Hidden until the plugin first shows it; from then on the plugin owns these styles.
    style: 'visibility: hidden; position: fixed; top: 0; left: 0',
    '(mousedown)': '$event.preventDefault()',
  },
  template: `
    @if (handle()) {
      @for (mark of marks; track mark.id) {
        <button
          z-button
          zType="ghost"
          zSize="icon-sm"
          tabindex="-1"
          [attr.aria-label]="mark.label | transloco"
          [attr.aria-pressed]="active()[mark.id]"
          [attr.data-mark]="mark.id"
          [class.bg-muted]="active()[mark.id]"
          [disabled]="!allowed()[mark.id]"
          (click)="toggle(mark.id)"
        >
          <ng-icon [name]="mark.icon" aria-hidden="true" />
        </button>
      }
      <span
        class="bg-border mx-0.5 w-px self-stretch"
        aria-hidden="true"
      ></span>
      <button
        z-button
        zType="ghost"
        zSize="icon-sm"
        tabindex="-1"
        data-action="link"
        [attr.aria-label]="'editor.docEditor.mark.link' | transloco"
        [attr.aria-pressed]="active().link"
        [class.bg-muted]="active().link"
        [disabled]="!canLink()"
        (click)="link()"
      >
        <ng-icon name="lucideLink" aria-hidden="true" />
      </button>
      <button
        z-button
        zType="ghost"
        zSize="icon-sm"
        tabindex="-1"
        data-action="kbd"
        [attr.aria-label]="'editor.docEditor.mark.kbd' | transloco"
        [disabled]="!canKbd()"
        (click)="kbd()"
      >
        <ng-icon name="lucideKeyboard" aria-hidden="true" />
      </button>
      @if (snippet() !== undefined) {
        <span
          class="bg-border mx-0.5 w-px self-stretch"
          aria-hidden="true"
        ></span>
        <!-- Refused, it stays enabled (a disabled button shows no tooltip): its tooltip and its
             description say why, and so does a click. -->
        <button
          z-button
          zType="ghost"
          zSize="icon-sm"
          tabindex="-1"
          data-action="save-snippet"
          [attr.aria-label]="'editor.docEditor.saveSnippet.action' | transloco"
          [attr.data-blocked]="snippet() !== null || null"
          [attr.aria-description]="snippetReason()"
          [class.opacity-50]="snippet() !== null"
          [zTooltip]="
            snippetReason() ??
            ('editor.docEditor.saveSnippet.action' | transloco)
          "
          (click)="saveSnippet()"
        >
          <ng-icon name="lucideBookmarkPlus" aria-hidden="true" />
        </button>
      }
    }
  `,
})
export class SelectionBubbleComponent {
  /** The element TipTap's bubble menu shows and positions. */
  readonly element = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  readonly handle = input<EditorHandle | null>(null);
  private readonly t = injectTranslate();
  private readonly toast = inject(ToastService);
  protected readonly label = computed(() =>
    this.t('editor.docEditor.bubble.label'),
  );

  protected readonly marks = BUBBLE_MARKS;

  protected readonly active = computed(() => {
    const handle = this.handle();
    const out = { link: false } as Record<Mark | 'link', boolean>;
    for (const m of BUBBLE_MARKS) out[m.id] = false;
    if (!handle) return out;
    return handle.read((e) => {
      for (const m of BUBBLE_MARKS) out[m.id] = e.isActive(m.id);
      out.link = e.isActive('link');
      return { ...out };
    });
  });

  /** A mark the text at the selection may carry (a title takes no link of its own, and so on). */
  protected readonly allowed = computed(() => {
    const handle = this.handle();
    const out = {} as Record<Mark, boolean>;
    for (const m of BUBBLE_MARKS)
      out[m.id] = !!handle && handle.read((e) => canMark(e.state, m.id));
    return out;
  });

  protected readonly canLink = computed(() => {
    const handle = this.handle();
    return !!handle && handle.read((e) => linkRequest(e.state) !== null);
  });

  protected readonly canKbd = computed(() => {
    const handle = this.handle();
    return !!handle && handle.read((e) => canInsertInline(e.state, 'kbd'));
  });

  /**
   * "Save as snippet" for the selected blocks: null when it can run, the reason (a translation
   * key) when not, undefined when the page offers no snippets (not shown).
   */
  protected readonly snippet = computed(() => {
    const handle = this.handle();
    if (!handle) return undefined;
    return handle.read((e) =>
      e.state.selection.empty ? undefined : saveSnippetBlocked(e),
    );
  });
  protected readonly snippetReason = computed(() => {
    const reason = this.snippet();
    return reason ? this.t(reason) : null;
  });

  protected saveSnippet(): void {
    const reason = this.snippet();
    if (reason) {
      this.toast.error(translated(reason));
      return;
    }
    if (reason === null) this.handle()?.run((e) => saveAsSnippet(e));
  }

  protected toggle(mark: Mark): void {
    this.handle()?.run((e) => toggleMark(e, mark));
  }

  protected link(): void {
    this.handle()?.run((e) => openInlineEdit(e, linkRequest(e.state)));
  }

  protected kbd(): void {
    this.handle()?.run((e) =>
      openInlineEdit(e, newAtomRequest(e.state, 'kbd')),
    );
  }
}
