import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  resource,
  signal,
  untracked,
} from '@angular/core';
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
} from '@tiptap/pm/model';
// The full entry, with zod: a callout's condition is checked with its schema before the picker.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { Condition, MAX_CALLOUTS } from '@openfolia/content-model';
import {
  CalloutOverlayComponent,
  ImageBlockComponent,
  type CalloutOverlayMarker,
  type CalloutOverlayMove,
  type CalloutOverlayPoint,
  type ImageBlockState,
} from '@openfolia/ui/blocks';
import { TranslocoPipe } from '@jsverse/transloco';
import { injectTranslate, translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import type { LegendJson } from './callout-legend-field.component';
import { CalloutPanelComponent } from './callout-panel.component';
import {
  addCallout,
  editorCallouts,
  isManualOrder,
  moveCalloutPoint,
  NUDGE_STEP,
  NUDGE_STEP_LARGE,
  removeCallout,
  reorderCallouts,
  setCalloutLabel,
  setCalloutLegend,
  setCalloutWhen,
  useReadingOrder,
} from './callouts';
import {
  DOC_BLOCKS,
  hoverCallout,
  NODE_VIEW,
  type CalloutKey,
  type ImageChoice,
} from './doc-blocks-context';
import { captionOf, imageContent, oneLine } from './image-content';

/**
 * The image block's node view: the picture (read through the page, `imageSource`; a skeleton
 * meanwhile), its caption and its alt text, at its width. Edit (or a double click) opens the
 * page's image picker (`pickImage`) with the block's image, alt text, caption and width, and puts
 * back what comes out in one step that Undo takes back. An image that can't be found says so in
 * words; one that failed to load offers Retry. Read-only, or without a picker, there is no Edit.
 *
 * Its callouts (#547) show on the picture with their numbers in the chosen variant
 * (`DocBlockSettings.variant`). "Edit callouts" (`of-callout-panel`, under the caption) makes
 * them editable: a click on the picture adds one there, a marker or anchor is dragged or nudged
 * with the arrow keys (`of-callout-overlay`), and the panel edits each legend, condition and
 * leader line, the order, and deletes one (Undo in the toast, or the editor's own). Every change
 * is one step that Undo takes back.
 */
@Component({
  selector: 'of-image-node',
  imports: [
    TranslocoPipe,
    ImageBlockComponent,
    CalloutOverlayComponent,
    CalloutPanelComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block', '(dblclick)': 'dblclick($event)' },
  template: `
    <of-image-block
      [state]="state()"
      [src]="src()"
      [alt]="choice().alt"
      [caption]="choice().caption"
      [width]="choice().width"
      [problem]="problem()"
      [actionLabel]="actionLabel()"
      (action)="edit()"
      (retry)="reload()"
    >
      @if (markers().length > 0 || editing()) {
        <of-callout-overlay
          ofImageOverlay
          data-node-view-control
          [markers]="markers()"
          [editable]="editing()"
          [adding]="editing()"
          [selected]="selected()"
          [highlighted]="highlighted()"
          (hoverChange)="hover($event)"
          [step]="nudgeStep"
          [largeStep]="nudgeStepLarge"
          [label]="'editor.docEditor.callouts.overlay' | transloco"
          (selectedChange)="selected.set($event)"
          (add)="addAt($event)"
          (move)="move($event)"
          (remove)="remove($event)"
        />
      }
      @if (editable()) {
        <of-callout-panel
          class="mt-1"
          [callouts]="callouts()"
          [manual]="manual()"
          [full]="callouts().length >= maxCallouts"
          [focusLegend]="focusLegend()"
          [editing]="editing()"
          (editingChange)="setEditing($event)"
          [(selected)]="selected"
          [highlighted]="highlighted()"
          (hoverChange)="hover($event)"
          (add)="addAt({ x: 0.5, y: 0.5 })"
          (remove)="remove($event)"
          (reorder)="reorder($event)"
          (readingOrder)="readingOrder()"
          (legend)="setLegend($event.id, $event.legend)"
          (legendDone)="focusMarker($event)"
          (conditions)="pickConditions($event)"
          (leader)="setLeader($event.id, $event.on)"
        />
      }
    </of-image-block>
  `,
})
export class ImageNodeComponent {
  private readonly blocks = inject(DOC_BLOCKS);
  private readonly view = inject(NODE_VIEW);
  private readonly t = injectTranslate();
  private readonly toast = inject(ToastService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly nudgeStep = NUDGE_STEP;
  protected readonly nudgeStepLarge = NUDGE_STEP_LARGE;
  protected readonly maxCallouts = MAX_CALLOUTS;

  /** Whether the callouts can be edited here (the document can be changed, and not in a region). */
  protected readonly editable = computed(
    () => this.blocks.editable() && (this.blocks.callouts?.() ?? true),
  );
  /** Whether the callouts are being edited (the picture takes clicks then). */
  protected readonly editingOn = signal(false);
  protected readonly editing = computed(
    () => this.editingOn() && this.editable(),
  );
  /** The selected callout's ID. */
  protected readonly selected = signal<string | null>(null);
  /** The image block's ID, as references name it. */
  private readonly blockId = computed(() =>
    String(this.view.node().attrs['id'] ?? ''),
  );
  /** The callout of this image hovered or focused anywhere in the editor (#549). */
  protected readonly highlighted = computed(() => {
    const key = this.blocks.calloutHover?.();
    return key && key.block === this.blockId() ? key.callout : null;
  });
  /** The callout this image last highlighted itself, so it clears only its own. */
  private hovered: CalloutKey | null = null;

  constructor() {
    // A callout shown from outside (a style suggestion on its legend, #573): the panel opens on it.
    // A request made before this node view was (re)made is not for it.
    let shown = untracked(() => this.blocks.calloutShow?.()?.seq ?? 0);
    effect(() => {
      const request = this.blocks.calloutShow?.();
      if (!request || request.seq === shown) return;
      if (request.block !== this.blockId()) return;
      shown = request.seq;
      untracked(() => this.show(request.callout));
    });
    // A block removed while one of its callouts is highlighted takes the highlight with it.
    inject(DestroyRef).onDestroy(() => this.hover(null));
    // A highlighted callout deleted (its marker or row gone without a leave): no highlight left.
    effect(() => {
      const ids = new Set(this.callouts().map((c) => c.id));
      untracked(() => {
        if (this.hovered && !ids.has(this.hovered.callout)) this.hover(null);
      });
    });
  }

  /** A marker or a panel row is hovered or focused (`id`), or left (null). */
  protected hover(id: string | null): void {
    const key = id ? { block: this.blockId(), callout: id } : null;
    hoverCallout(this.blocks.calloutHover, key, this.hovered);
    this.hovered = key;
  }

  /** A callout just added: its legend takes the focus. */
  protected readonly focusLegend = signal<string | null>(null);

  /** The callouts, in number order, numbered in the chosen variant. */
  protected readonly callouts = computed(() =>
    editorCallouts(this.view.node(), this.blocks.settings().variant ?? null),
  );
  protected readonly manual = computed(() => isManualOrder(this.view.node()));

  protected readonly markers = computed((): CalloutOverlayMarker[] =>
    this.callouts().map((c) => ({
      id: c.id,
      number: c.number,
      anchor: c.anchor,
      label: c.label,
      legend: c.text,
    })),
  );

  /** The block as the picker sees it. */
  protected readonly choice = computed((): ImageChoice => {
    const node = this.view.node();
    const { asset, alt, width } = node.attrs;
    return {
      asset: typeof asset === 'string' ? asset : '',
      alt: typeof alt === 'string' ? alt : '',
      caption: captionOf(node),
      width: typeof width === 'number' ? width : null,
    };
  });

  private readonly asset = computed(() => this.choice().asset);

  /** Read again only when the image changes, not when other settings do. */
  private readonly source = resource({
    params: () => this.asset() || undefined,
    loader: async ({ params }) => {
      const read = untracked(this.blocks.settings).imageSource;
      return read ? await read(params) : undefined;
    },
  });

  protected readonly state = computed((): ImageBlockState => {
    if (!this.asset()) return 'empty';
    if (!this.blocks.settings().imageSource) return 'missing';
    const status = this.source.status();
    if (status === 'error') return 'error';
    if (status !== 'resolved' && status !== 'local') return 'loading';
    return this.source.hasValue() && this.source.value() ? 'shown' : 'missing';
  });

  protected readonly src = computed(() =>
    this.source.hasValue() ? (this.source.value() ?? '') : '',
  );

  /** Without a way to read images (the playground), the block says so instead of "not found". */
  protected readonly problem = computed(() =>
    this.asset() && !this.blocks.settings().imageSource
      ? this.t('editor.docEditor.image.noPreview')
      : '',
  );

  protected readonly actionLabel = computed(() =>
    this.blocks.editable() && this.blocks.settings().pickImage
      ? this.t('editor.docEditor.image.edit')
      : '',
  );

  protected reload(): void {
    this.source.reload();
  }

  protected dblclick(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-node-view-control]')) return;
    void this.edit();
  }

  protected setEditing(on: boolean): void {
    this.editingOn.set(on);
    if (!on) {
      // The panel's rows go: one holding the highlight gives it up.
      this.hover(null);
      this.selected.set(null);
      this.focusLegend.set(null);
    }
  }

  /** Opens the panel on the callout `id`, selected, and scrolls its row into view. */
  private show(id: string): void {
    if (!this.callouts().some((c) => c.id === id)) return;
    if (this.editable()) this.editingOn.set(true);
    this.selected.set(id);
    afterNextRender(
      () => {
        const root = this.host.nativeElement;
        const target =
          root.querySelector<HTMLElement>(
            `[data-callout-row="${CSS.escape(id)}"]`,
          ) ?? root;
        if (typeof target.scrollIntoView !== 'function') return;
        const still = root.ownerDocument.defaultView?.matchMedia?.(
          '(prefers-reduced-motion: reduce)',
        ).matches;
        target.scrollIntoView({
          block: 'nearest',
          behavior: still ? 'auto' : 'smooth',
        });
      },
      { injector: this.injector },
    );
  }

  /** Adds a callout at `point`, selected, its legend focused. */
  protected addAt(point: CalloutOverlayPoint): void {
    let id: string | null = null;
    this.view.change((tr, pos) => {
      id = addCallout(tr, pos, point);
      return id !== null;
    });
    if (!id) return;
    this.focusLegend.set(id);
    this.selected.set(id);
  }

  protected move(move: CalloutOverlayMove): void {
    this.view.change((tr, pos) =>
      moveCalloutPoint(tr, pos, move.id, move.which, move.point),
    );
    this.selected.set(move.id);
  }

  /** Deletes a callout; the toast's Undo puts it back where it was (so does the editor's Undo). */
  protected remove(id: string): void {
    const before = this.callouts().find((c) => c.id === id);
    const node = this.view.node();
    let index = -1;
    node.forEach((child, _offset, i) => {
      if (child.attrs['id'] === id) index = i;
    });
    const removed = before?.node;
    if (!this.view.change((tr, pos) => removeCallout(tr, pos, id))) return;
    if (this.selected() === id) this.selected.set(null);
    this.focusOverlay();
    if (!removed) return;
    this.toast.show(
      translated('editor.docEditor.callouts.deleted', {
        number: before?.number ?? '–',
      }),
      {
        actionLabel: translated('ui.toast.undo'),
        onAction: () => this.restore(removed, index),
      },
    );
  }

  private restore(removed: ProseMirrorNode, index: number): void {
    const id = String(removed.attrs['id'] ?? '');
    this.view.change((tr, pos) => {
      const image = tr.doc.nodeAt(pos);
      if (!image || image.type.name !== 'image') return false;
      let taken = false;
      tr.doc.descendants((n) => {
        if (n.attrs['id'] === id) taken = true;
        return !taken && !n.isTextblock;
      });
      if (taken) return false;
      let at = pos + image.nodeSize - 1;
      image.forEach((_child, offset, i) => {
        if (i === index) at = pos + 1 + offset;
      });
      tr.replace(at, at, new Slice(Fragment.from(removed), 0, 0));
      return true;
    });
  }

  protected reorder(ids: string[]): void {
    this.view.change((tr, pos) => reorderCallouts(tr, pos, ids));
  }

  protected readingOrder(): void {
    this.view.change((tr, pos) => useReadingOrder(tr, pos));
  }

  protected setLegend(id: string, legend: LegendJson): void {
    this.focusLegend.set(null);
    this.view.change((tr, pos) =>
      setCalloutLegend(
        tr,
        pos,
        id,
        Fragment.fromJSON(tr.doc.type.schema, legend),
      ),
    );
  }

  protected setLeader(id: string, on: boolean): void {
    this.view.change((tr, pos) => setCalloutLabel(tr, pos, id, on));
  }

  protected async pickConditions(id: string): Promise<void> {
    const picker = this.blocks.settings().pickVariant;
    const callout = this.callouts().find((c) => c.id === id);
    if (!picker || !callout) return;
    const parsed = Condition.safeParse(callout.when);
    const next = await picker(parsed.success ? parsed.data : null);
    if (!next) return;
    this.view.change((tr, pos) =>
      setCalloutWhen(tr, pos, id, next === 'remove' ? null : next),
    );
  }

  /** The marker of a callout takes the focus (its legend is done: the arrows nudge it now). */
  protected focusMarker(id: string): void {
    this.focusLegend.set(null);
    afterNextRender(
      () =>
        this.host.nativeElement
          .querySelector<HTMLElement>(
            `[data-slot="callout-marker"][data-callout="${CSS.escape(id)}"]`,
          )
          ?.focus(),
      { injector: this.injector },
    );
  }

  /** After a delete: the focus stays in the callouts (the first marker, else the panel). */
  private focusOverlay(): void {
    afterNextRender(
      () => {
        const root = this.host.nativeElement;
        const next =
          root.querySelector<HTMLElement>('[data-slot="callout-marker"]') ??
          root.querySelector<HTMLElement>('[data-action="add-callout"]');
        next?.focus();
      },
      { injector: this.injector },
    );
  }

  protected async edit(): Promise<void> {
    const pick = this.blocks.settings().pickImage;
    if (!pick || !this.blocks.editable()) return;
    const current = this.choice();
    const next = await pick(current);
    if (!next) return;
    const node = this.view.node();
    this.view.replace(
      { asset: next.asset, alt: oneLine(next.alt), width: next.width },
      // A caption left as it was keeps its formatting; a changed one is plain text.
      next.caption === current.caption
        ? undefined
        : imageContent(node.type.schema, next.caption, node),
    );
  }
}
