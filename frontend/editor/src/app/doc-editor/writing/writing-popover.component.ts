import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideBookOpen,
  lucideCheck,
  lucideCircleAlert,
  lucideEyeOff,
  lucideSparkles,
  lucideTriangleAlert,
  lucideX,
} from '@ng-icons/lucide';
import type { EditorState, Transaction } from '@tiptap/pm/state';

import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { injectTranslate } from '@openfolia/ui/i18n';
import { ZardPopoverImports } from '@openfolia/ui/popover';

import type { EditorHandle } from '../editor-handle';
import {
  findingMessage,
  findingNote,
  severityLabel,
  shownReplacement,
} from './finding-text';
import type { TermHints, TermInfo } from './term-hints';
import {
  findingAt,
  ignoreFinding,
  type PlacedFinding,
  type PlacedMark,
  replaceFinding,
  suggestionAt,
  writingFindings,
  suggestionMarks,
} from './writing-checks';

/** A page suggestion's words, for its popover (the style review's, #573). */
export interface SuggestionText {
  readonly id: string;
  readonly message: string;
  readonly original: string;
  /** Null: a remark without a change. */
  readonly replacement: string | null;
}

/** What the popover is about. */
export type WritingTarget =
  | { readonly kind: 'finding'; readonly finding: PlacedFinding }
  | { readonly kind: 'suggestion'; readonly mark: PlacedMark }
  | {
      readonly kind: 'term';
      readonly termId: string;
      readonly from: number;
    };

/** Waits this long on a word under the pointer, or the caret resting in one, before peeking. */
export const PEEK_MS = 300;
/** Closes this long after the pointer left both the word and the popover. */
export const LEAVE_MS = 250;

/** The linked term at `pos`, if any: its ID and where its text node starts. */
export function termAt(
  state: EditorState,
  pos: number,
): { termId: string; from: number } | null {
  const type = state.schema.marks['term'];
  const $pos = state.doc.resolve(pos);
  if (!type || !$pos.parent.inlineContent) return null;
  const after = $pos.nodeAfter;
  const before = $pos.nodeBefore;
  const inAfter = after ? type.isInSet(after.marks) : undefined;
  const inBefore = before ? type.isInSet(before.marks) : undefined;
  const mark = inAfter ?? inBefore;
  const termId = mark ? String(mark.attrs['termId'] ?? '') : '';
  if (!termId) return null;
  const from = inAfter ? pos - $pos.textOffset : pos - (before?.nodeSize ?? 0);
  return { termId, from };
}

/** What the popover would show at `pos`: a finding, a page suggestion or a linked term. */
export function targetAt(
  state: EditorState,
  pos: number,
): WritingTarget | null {
  const finding = findingAt(state, pos);
  if (finding) return { kind: 'finding', finding };
  const mark = suggestionAt(state, pos);
  if (mark) return { kind: 'suggestion', mark };
  const term = termAt(state, pos);
  return term ? { kind: 'term', ...term } : null;
}

const keyOf = (t: WritingTarget | null): string =>
  !t
    ? ''
    : t.kind === 'finding'
      ? `f:${t.finding.id}`
      : t.kind === 'suggestion'
        ? `s:${t.mark.id}`
        : `t:${t.termId}`;

/**
 * The writing aids' popover (#247), anchored at the text it is about: a finding of the writing
 * checks (its severity in words, the message, the fix, "Replace" and "Ignore here"), a page
 * suggestion marked in the text (the style review's: its message and change, "Apply" and
 * "Dismiss") or a linked term (its preferred variant and definition). It peeks, without taking
 * the focus, while the pointer rests on such a word or the caret is moved into one; Alt+Enter (or
 * `open`) opens it with the focus on its first button, Escape closes it and puts the focus back
 * in the text. Everything it shows is text, never markup (a style rule's message and a term's
 * definition come from the content).
 */
@Component({
  selector: 'of-writing-popover',
  imports: [
    NgIcon,
    TranslocoPipe,
    ZardBadgeComponent,
    ZardButtonComponent,
    ...ZardPopoverImports,
  ],
  viewProviders: [
    provideIcons({
      lucideBookOpen,
      lucideCheck,
      lucideCircleAlert,
      lucideEyeOff,
      lucideSparkles,
      lucideTriangleAlert,
      lucideX,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pointer-events-none absolute top-0 left-0 h-0 w-0' },
  template: `
    <span
      #anchor
      class="absolute block h-px w-px"
      aria-hidden="true"
      zPopover
      [zTrigger]="null"
      [zContent]="panel"
      [zVisible]="visible()"
      zPlacement="bottom"
      zAlign="start"
      (zVisibleChange)="visibleChanged($event)"
    ></span>
    <ng-template #panel>
      <z-popover
        #panelEl
        class="pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2.5"
        role="dialog"
        data-slot="writing-popover"
        [attr.aria-label]="title()"
        [attr.data-kind]="target()?.kind"
        (pointerenter)="stay()"
        (pointerleave)="leave()"
        (keydown.escape)="close()"
      >
        @switch (target()?.kind) {
          @case ('finding') {
            @let f = finding()!;
            <div class="flex items-center gap-2">
              <z-badge
                [zType]="f.severity === 'blocking' ? 'destructive' : 'warning'"
                data-slot="writing-severity"
              >
                <ng-icon
                  [name]="
                    f.severity === 'blocking'
                      ? 'lucideCircleAlert'
                      : 'lucideTriangleAlert'
                  "
                  aria-hidden="true"
                />
                {{ severity(f) | transloco }}
              </z-badge>
            </div>
            <p
              class="m-0 text-sm leading-5 break-words"
              data-slot="writing-message"
            >
              {{ message(f) }}
            </p>
            @if (note(f); as n) {
              <p
                class="text-muted-foreground m-0 text-xs leading-5 break-words"
              >
                {{ n }}
              </p>
            }
            @if (f.replacement !== undefined) {
              <p
                class="m-0 text-sm leading-5 break-words"
                data-slot="writing-fix"
              >
                @if (f.replacement === '') {
                  {{ 'editor.writing.removeFix' | transloco }}
                } @else {
                  {{ 'editor.writing.useFix' | transloco }}
                  <ins
                    class="bg-primary/10 text-foreground rounded-sm px-0.5 no-underline"
                    >{{ replacement(f.replacement) }}</ins
                  >
                }
              </p>
            }
            <div class="flex flex-wrap gap-1.5">
              @if (f.replacement !== undefined) {
                <button
                  z-button
                  zSize="sm"
                  type="button"
                  data-autofocus
                  data-action="replace"
                  (click)="replace(f)"
                >
                  <ng-icon
                    name="lucideCheck"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  {{ 'editor.writing.replace' | transloco }}
                </button>
              }
              <button
                z-button
                zType="outline"
                zSize="sm"
                type="button"
                [attr.data-autofocus]="f.replacement === undefined || null"
                data-action="ignore"
                (click)="ignore(f)"
              >
                <ng-icon
                  name="lucideEyeOff"
                  data-icon="inline-start"
                  aria-hidden="true"
                />
                {{ 'editor.writing.ignore' | transloco }}
              </button>
            </div>
          }
          @case ('suggestion') {
            @let s = suggestion();
            <p
              class="text-muted-foreground m-0 flex items-center gap-1.5 text-xs font-medium"
            >
              <ng-icon name="lucideSparkles" aria-hidden="true" />
              {{ 'editor.writing.styleSuggestion' | transloco }}
            </p>
            @if (s) {
              <p class="m-0 text-sm leading-5 break-words">{{ s.message }}</p>
              @if (s.replacement !== null) {
                <p class="m-0 text-sm leading-5 break-words">
                  <del
                    class="text-muted-foreground decoration-destructive/70 line-through"
                    >{{ replacement(s.original) }}</del
                  >
                  <span aria-hidden="true"> → </span>
                  <span class="sr-only"
                    >{{ 'editor.suggestions.replacement' | transloco }}:
                  </span>
                  <ins
                    class="bg-primary/10 text-foreground rounded-sm px-0.5 no-underline"
                    >{{ replacement(s.replacement) }}</ins
                  >
                </p>
              }
              <div class="flex flex-wrap gap-1.5">
                @if (s.replacement !== null) {
                  <button
                    z-button
                    zSize="sm"
                    type="button"
                    data-autofocus
                    data-action="apply"
                    (click)="act(s.id, 'apply')"
                  >
                    <ng-icon
                      name="lucideCheck"
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    {{ 'editor.suggestions.apply' | transloco }}
                  </button>
                }
                <button
                  z-button
                  zType="ghost"
                  zSize="sm"
                  type="button"
                  [attr.data-autofocus]="s.replacement === null || null"
                  data-action="dismiss"
                  (click)="act(s.id, 'dismiss')"
                >
                  <ng-icon
                    name="lucideX"
                    data-icon="inline-start"
                    aria-hidden="true"
                  />
                  {{ 'editor.suggestions.dismiss' | transloco }}
                </button>
              </div>
            }
          }
          @case ('term') {
            @let info = term();
            <p
              class="text-muted-foreground m-0 flex items-center gap-1.5 text-xs font-medium"
            >
              <ng-icon name="lucideBookOpen" aria-hidden="true" />
              {{ 'editor.writing.linkedTerm' | transloco }}
            </p>
            <p
              class="m-0 text-sm leading-5 font-medium break-words"
              data-slot="term-preferred"
            >
              {{ info?.preferred ?? termId() }}
            </p>
            <p
              class="m-0 text-sm leading-5 break-words"
              [class.text-muted-foreground]="!info?.definition"
              data-slot="term-definition"
              tabindex="-1"
              data-autofocus
            >
              {{
                info
                  ? info.definition
                    ? replacement(info.definition)
                    : ('editor.writing.noDefinition' | transloco)
                  : ('editor.writing.termUnknown' | transloco)
              }}
            </p>
          }
        }
      </z-popover>
    </ng-template>
  `,
})
export class WritingPopoverComponent {
  readonly handle = input<EditorHandle | null>(null);
  /** The terms of the document's language: a linked term's definition. */
  readonly terms = input<TermHints | null>(null);
  /** The page's suggestions' words, by ID (`SuggestionMark` IDs). */
  readonly suggestions = input<ReadonlyMap<string, SuggestionText>>(new Map());
  /** A page suggestion's "Apply" or "Dismiss". */
  readonly suggestionAction = output<{
    readonly id: string;
    readonly action: 'apply' | 'dismiss';
  }>();
  /** Something the person did, for screen readers. */
  readonly announced = output<string>();

  private readonly t = injectTranslate();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly anchor =
    viewChild.required<ElementRef<HTMLElement>>('anchor');
  private readonly panelEl = viewChild('panelEl', { read: ElementRef });

  protected readonly target = signal<WritingTarget | null>(null);
  protected readonly visible = signal(false);
  /** Opened for the keyboard (the focus is in it), not peeked. */
  private focused = false;
  private peekTimer: ReturnType<typeof setTimeout> | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  private openings = 0;

  protected readonly finding = computed(() => {
    const t = this.target();
    return t?.kind === 'finding' ? t.finding : null;
  });
  protected readonly suggestion = computed(() => {
    const t = this.target();
    return t?.kind === 'suggestion'
      ? (this.suggestions().get(t.mark.id) ?? null)
      : null;
  });
  protected readonly termId = computed(() => {
    const t = this.target();
    return t?.kind === 'term' ? t.termId : '';
  });
  protected readonly term = computed((): TermInfo | null =>
    this.termId() ? (this.terms()?.info(this.termId()) ?? null) : null,
  );
  protected readonly title = computed(() => {
    switch (this.target()?.kind) {
      case 'finding':
        return this.t('editor.writing.findingTitle');
      case 'suggestion':
        return this.t('editor.writing.styleSuggestion');
      case 'term':
        return this.t('editor.writing.linkedTerm');
      default:
        return '';
    }
  });

  constructor() {
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => this.clearTimers());
    effect((onCleanup) => {
      const editor = this.handle()?.editor;
      if (!editor) return;
      const dom = editor.view.dom as HTMLElement;
      const over = (event: PointerEvent) => this.pointerOver(event);
      const out = (event: PointerEvent) => {
        const next = event.relatedTarget as Node | null;
        const panel = this.panelEl()?.nativeElement as HTMLElement | undefined;
        if (next && panel?.contains(next)) return;
        if (this.peekTimer && !this.visible()) this.clearPeek();
        if (!this.focused) this.leave();
      };
      const transaction = ({ transaction }: { transaction: Transaction }) =>
        this.transaction(transaction);
      dom.addEventListener('pointerover', over);
      dom.addEventListener('pointerout', out);
      editor.on('transaction', transaction);
      onCleanup(() => {
        dom.removeEventListener('pointerover', over);
        dom.removeEventListener('pointerout', out);
        editor.off('transaction', transaction);
      });
    });
  }

  /** Opens on what is at `pos`, with the focus on its first button; false when there is nothing. */
  open(pos: number): boolean {
    const editor = this.handle()?.editor;
    if (!editor || editor.isDestroyed) return false;
    const target = targetAt(editor.state, pos);
    if (!target) return false;
    this.show(target, true);
    return true;
  }

  /** Closes it, the focus back in the text. */
  close(): void {
    const wasFocused = this.focused;
    this.hide();
    if (wasFocused) this.backToText();
  }

  private pointerOver(event: PointerEvent): void {
    const editor = this.handle()?.editor;
    if (!editor || this.focused) return;
    const el = (event.target as HTMLElement | null)?.closest?.(
      '[data-finding], [data-suggestion], [data-mark="term"]',
    );
    if (!el || !editor.view.dom.contains(el)) return;
    let pos: number;
    try {
      pos = editor.view.posAtDOM(el, 0);
    } catch {
      return;
    }
    const target = targetAt(editor.state, pos);
    if (!target) return;
    this.cancelLeave();
    if (keyOf(target) === keyOf(this.target()) && this.visible()) return;
    this.clearPeek();
    this.peekTimer = setTimeout(() => {
      this.peekTimer = null;
      this.show(target, false);
    }, PEEK_MS);
  }

  private transaction(tr: Transaction): void {
    const editor = this.handle()?.editor;
    if (!editor || editor.isDestroyed) return;
    if (tr.docChanged) {
      // Typing goes on: a peek gets out of the way; one opened for the keyboard follows its target.
      this.clearPeek();
      if (!this.focused) this.hide();
      else this.refresh();
      return;
    }
    if (!tr.selectionSet || this.focused) {
      this.refresh();
      return;
    }
    const { selection } = editor.state;
    const target =
      selection.empty && editor.isFocused
        ? targetAt(editor.state, selection.from)
        : null;
    if (keyOf(target) === keyOf(this.target()) && this.visible()) return;
    this.clearPeek();
    if (!target) {
      this.hide();
      return;
    }
    this.peekTimer = setTimeout(() => {
      this.peekTimer = null;
      this.show(target, false);
    }, PEEK_MS);
  }

  /** The target as the editor holds it now (a finding checked again); gone: closed. */
  private refresh(): void {
    const editor = this.handle()?.editor;
    const shown = this.target();
    if (!editor || !shown || !this.visible()) return;
    if (shown.kind === 'finding') {
      const now = writingFindings(editor.state).find(
        (f) => f.id === shown.finding.id,
      );
      if (!now) this.close();
      else if (now !== shown.finding)
        this.target.set({ kind: 'finding', finding: now });
    } else if (shown.kind === 'suggestion') {
      const now = suggestionMarks(editor.state).find(
        (m) => m.id === shown.mark.id,
      );
      if (!now) this.close();
    }
  }

  private show(target: WritingTarget, focus: boolean): void {
    // A peek still due (the caret just moved in) would take the card from the keyboard.
    this.clearPeek();
    const run = ++this.openings;
    this.focused = focus;
    this.place(
      target.kind === 'finding'
        ? target.finding.from
        : target.kind === 'suggestion'
          ? target.mark.from
          : target.from,
    );
    this.target.set(target);
    this.visible.set(true);
    if (focus) {
      setTimeout(() => {
        if (run === this.openings) this.focusFirst();
      });
    }
  }

  private hide(): void {
    this.openings++;
    this.focused = false;
    this.clearTimers();
    this.visible.set(false);
  }

  private place(pos: number): void {
    const editor = this.handle()?.editor;
    const area = this.host.nativeElement.parentElement;
    if (!editor || !area) return;
    let coords: { left: number; bottom: number };
    try {
      coords = editor.view.coordsAtPos(pos);
    } catch {
      coords = { left: 0, bottom: 0 };
    }
    const box = area.getBoundingClientRect();
    const el = this.anchor().nativeElement;
    el.style.top = `${coords.bottom - box.top + area.scrollTop}px`;
    el.style.left = `${coords.left - box.left + area.scrollLeft}px`;
  }

  private focusFirst(): void {
    const panel = this.panelEl()?.nativeElement as HTMLElement | undefined;
    panel?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
  }

  protected visibleChanged(visible: boolean): void {
    if (visible) return;
    const wasFocused = this.focused;
    this.visible.set(false);
    this.focused = false;
    if (wasFocused) this.backToText();
  }

  private backToText(): void {
    const editor = this.handle()?.editor;
    if (!editor || editor.isDestroyed) return;
    const doc = editor.view.dom.ownerDocument;
    const active = doc.activeElement;
    const panel = this.panelEl()?.nativeElement as HTMLElement | undefined;
    const elsewhere =
      active && active !== doc.body && !(panel?.contains(active) ?? false);
    if (!elsewhere) editor.view.focus();
  }

  protected stay(): void {
    this.cancelLeave();
  }

  protected leave(): void {
    if (this.focused) return;
    this.cancelLeave();
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null;
      const editor = this.handle()?.editor;
      // The caret still rests in it: it stays.
      const caret =
        editor && editor.isFocused && editor.state.selection.empty
          ? targetAt(editor.state, editor.state.selection.from)
          : null;
      if (keyOf(caret) !== keyOf(this.target())) this.hide();
    }, LEAVE_MS);
  }

  protected replace(f: PlacedFinding): void {
    const view = this.handle()?.editor.view;
    if (!view) return;
    const done = replaceFinding(view, f.id);
    this.close();
    this.announced.emit(
      this.t(done ? 'editor.writing.replaced' : 'editor.writing.changed', {
        replacement: f.replacement ?? '',
      }),
    );
  }

  protected ignore(f: PlacedFinding): void {
    const view = this.handle()?.editor.view;
    if (!view) return;
    ignoreFinding(view, f.id);
    this.close();
    this.announced.emit(this.t('editor.writing.ignored'));
  }

  protected act(id: string, action: 'apply' | 'dismiss'): void {
    this.close();
    this.suggestionAction.emit({ id, action });
  }

  protected severity(f: PlacedFinding): string {
    return severityLabel(f);
  }
  protected message(f: PlacedFinding): string {
    return findingMessage(f, this.t);
  }
  protected note(f: PlacedFinding): string | null {
    return findingNote(f);
  }
  protected replacement(value: string): string {
    return shownReplacement(value);
  }

  private clearPeek(): void {
    if (this.peekTimer !== null) clearTimeout(this.peekTimer);
    this.peekTimer = null;
  }
  private cancelLeave(): void {
    if (this.leaveTimer !== null) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
  }
  private clearTimers(): void {
    this.clearPeek();
    this.cancelLeave();
  }
}
