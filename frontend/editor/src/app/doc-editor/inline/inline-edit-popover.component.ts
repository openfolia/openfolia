import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideExternalLink } from '@ng-icons/lucide';
import { TranslocoPipe } from '@jsverse/transloco';
// The full entry, with zod: this file checks links and module IDs with their schemas at run time.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { isLinkHref, ModuleId } from '@openfolia/content-model';
import { ZardButtonComponent } from '@openfolia/ui/button';
import {
  ZardCommandImports,
  type ZardCommandOption,
} from '@openfolia/ui/command';
import { injectTranslate } from '@openfolia/ui/i18n';
import { ZardInputComponent } from '@openfolia/ui/input';
import { ZardPopoverImports } from '@openfolia/ui/popover';

import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

import { documentCallouts } from '../blocks/callouts';
import type {
  DocBlockSettings,
  ModuleContent,
} from '../blocks/doc-blocks-context';
import { captionOf } from '../blocks/image-content';
import type { EditorHandle } from '../editor-handle';
import {
  applyLink,
  blockTargets,
  completeHref,
  docTargets,
  formatKeys,
  parseKeys,
  putAtom,
  referencedModules,
  removeLink,
  type InlineEditor,
  type InlineEditRequest,
  type XrefTarget,
} from './inline-edit';
import { openLink, targetLabel } from './inline-views';

/** A target as the cross-reference list offers it. */
interface TargetOption {
  readonly value: { readonly module: string; readonly block: string | null };
  readonly label: string;
  /** Its kind and place, read after the label. */
  readonly hint: string;
  readonly depth: number;
}

/** A referenced module's targets, as read so far. */
type ModuleTargets =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | { readonly status: 'missing' }
  | { readonly status: 'ready'; readonly content: ModuleContent };

const PICK_OTHER = 'pick-other-module';

/**
 * The popover the inline types are edited in, anchored where the text is (an anchor inside the
 * editor's scroll area, so it follows the text as it scrolls): a link's address and text, a
 * cross-reference's target (this module's sections, figures, tables, procedures and steps, those
 * of the modules it refers to, or another module through the module picker), a text attribute
 * from the configuration, a key combination, a callout reference's callout (this module's images
 * and their callouts, by number and legend, #547). Escape or a click elsewhere closes it; what it
 * applies is one undo step, and the focus goes back to the text.
 */
@Component({
  selector: 'of-inline-edit-popover',
  imports: [
    NgIcon,
    TranslocoPipe,
    ZardButtonComponent,
    ZardInputComponent,
    ...ZardCommandImports,
    ...ZardPopoverImports,
  ],
  viewProviders: [provideIcons({ lucideExternalLink })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'pointer-events-none absolute top-0 left-0 h-0 w-0' },
  template: `
    <span
      #anchor
      class="absolute block h-px w-px"
      aria-hidden="true"
      zPopover
      zTrigger="click"
      [zContent]="panel"
      [zVisible]="visible()"
      zPlacement="bottom"
      zAlign="start"
      (zVisibleChange)="visibleChanged($event)"
    ></span>
    <ng-template #panel>
      <z-popover
        #panelEl
        class="pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-3"
        role="dialog"
        [attr.aria-label]="title()"
        (keydown.escape)="cancel()"
      >
        @switch (request()?.kind) {
          @case ('link') {
            <form
              class="flex flex-col gap-3"
              (submit)="$event.preventDefault(); applyLinkForm()"
            >
              <div class="flex flex-col gap-1.5">
                <label class="text-xs font-medium" for="inline-link-href">{{
                  'editor.docEditor.link.address' | transloco
                }}</label>
                <input
                  z-input
                  id="inline-link-href"
                  data-autofocus
                  autocomplete="off"
                  spellcheck="false"
                  [placeholder]="
                    'editor.docEditor.link.addressPlaceholder' | transloco
                  "
                  [value]="href()"
                  [attr.aria-invalid]="hrefRefused() || null"
                  aria-describedby="inline-link-hint"
                  (input)="href.set($any($event.target).value)"
                />
                <p
                  id="inline-link-hint"
                  class="m-0 text-xs leading-4 break-words"
                  [class.text-destructive]="hrefRefused()"
                  [class.text-muted-foreground]="!hrefRefused()"
                >
                  {{
                    (hrefRefused()
                      ? 'editor.docEditor.link.refused'
                      : 'editor.docEditor.link.schemes'
                    ) | transloco
                  }}
                </p>
              </div>
              <div class="flex flex-col gap-1.5">
                <label class="text-xs font-medium" for="inline-link-text">{{
                  'editor.docEditor.link.text' | transloco
                }}</label>
                <input
                  z-input
                  id="inline-link-text"
                  autocomplete="off"
                  [placeholder]="
                    'editor.docEditor.link.textPlaceholder' | transloco
                  "
                  [value]="text()"
                  (input)="text.set($any($event.target).value)"
                />
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <button
                  z-button
                  zSize="sm"
                  type="submit"
                  [disabled]="!canApplyLink()"
                >
                  {{ 'editor.docEditor.link.apply' | transloco }}
                </button>
                @if (linked()) {
                  <button
                    z-button
                    zType="outline"
                    zSize="sm"
                    type="button"
                    (click)="unlink()"
                  >
                    {{ 'editor.docEditor.link.remove' | transloco }}
                  </button>
                }
                @if (openable(); as address) {
                  <button
                    z-button
                    zType="ghost"
                    zSize="sm"
                    type="button"
                    class="ms-auto"
                    (click)="openAddress(address)"
                  >
                    <ng-icon name="lucideExternalLink" aria-hidden="true" />
                    {{ 'editor.docEditor.link.open' | transloco }}
                  </button>
                }
              </div>
            </form>
          }
          @case ('xref') {
            <z-command
              class="rounded-none border-0 p-0 shadow-none"
              (zCommandSelected)="chooseTarget($event)"
            >
              <z-command-input
                data-autofocus
                [placeholder]="'editor.docEditor.xref.search' | transloco"
              />
              <z-command-list>
                @if (ownTargets().length > 0) {
                  <z-command-option-group
                    [zLabel]="'editor.docEditor.xref.thisModule' | transloco"
                  >
                    @for (o of ownTargets(); track o.value.block) {
                      <z-command-option [zValue]="o.value" [zLabel]="o.label">
                        <span
                          data-slot="command-option-label"
                          class="flex min-w-0 flex-col"
                          [style.padding-inline-start.rem]="o.depth * 0.75"
                        >
                          <span class="break-words">{{ o.label }}</span>
                          <span class="text-muted-foreground text-xs">{{
                            o.hint
                          }}</span>
                        </span>
                      </z-command-option>
                    }
                  </z-command-option-group>
                }
                @for (group of moduleGroups(); track group.module) {
                  <z-command-option-group [zLabel]="group.title">
                    @switch (group.state.status) {
                      @case ('loading') {
                        <z-command-option
                          [zValue]="null"
                          [zLabel]="'editor.docEditor.xref.loading' | transloco"
                          zDisabled
                        />
                      }
                      @case ('failed') {
                        <z-command-option
                          [zValue]="null"
                          [zLabel]="
                            'editor.docEditor.xref.loadFailed' | transloco
                          "
                          zDisabled
                        />
                      }
                      @case ('missing') {
                        <z-command-option
                          [zValue]="null"
                          [zLabel]="
                            'editor.docEditor.xref.moduleMissing' | transloco
                          "
                          zDisabled
                        />
                      }
                    }
                    @for (o of group.options; track o.value.block ?? '') {
                      <z-command-option [zValue]="o.value" [zLabel]="o.label">
                        <span
                          data-slot="command-option-label"
                          class="flex min-w-0 flex-col"
                          [style.padding-inline-start.rem]="o.depth * 0.75"
                        >
                          <span class="break-words">{{ o.label }}</span>
                          <span class="text-muted-foreground text-xs">{{
                            o.hint
                          }}</span>
                        </span>
                      </z-command-option>
                    }
                  </z-command-option-group>
                }
                <z-command-option-group
                  [zLabel]="'editor.docEditor.xref.elsewhere' | transloco"
                >
                  <z-command-option
                    [zValue]="pickOther"
                    [zLabel]="'editor.docEditor.xref.otherModule' | transloco"
                    [zDisabled]="!canPickModule()"
                  >
                    <span
                      data-slot="command-option-label"
                      class="flex min-w-0 flex-col"
                    >
                      <span>{{
                        'editor.docEditor.xref.otherModule' | transloco
                      }}</span>
                      @if (!canPickModule()) {
                        <span
                          class="text-muted-foreground text-xs break-words"
                          >{{
                            'editor.docEditor.xref.pickerUnavailable'
                              | transloco
                          }}</span
                        >
                      }
                    </span>
                  </z-command-option>
                </z-command-option-group>
              </z-command-list>
            </z-command>
          }
          @case ('calloutRef') {
            @if (calloutGroups().length === 0) {
              <p
                class="text-muted-foreground m-0 text-sm break-words"
                data-autofocus
                tabindex="-1"
              >
                {{ 'editor.docEditor.calloutRef.none' | transloco }}
              </p>
            } @else {
              <z-command
                class="rounded-none border-0 p-0 shadow-none"
                (zCommandSelected)="chooseCallout($event)"
              >
                <z-command-input
                  data-autofocus
                  [placeholder]="
                    'editor.docEditor.calloutRef.search' | transloco
                  "
                />
                <z-command-list>
                  @for (group of calloutGroups(); track group.image) {
                    <z-command-option-group [zLabel]="group.title">
                      @for (o of group.options; track o.value.callout) {
                        <z-command-option [zValue]="o.value" [zLabel]="o.label">
                          <span
                            data-slot="command-option-label"
                            class="flex min-w-0 items-start gap-2"
                          >
                            <span
                              class="mt-0.5 inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full border px-1 text-xs font-semibold tabular-nums"
                              [class.bg-primary]="o.number !== null"
                              [class.text-primary-foreground]="
                                o.number !== null
                              "
                              [class.border-transparent]="o.number !== null"
                              [class.border-dashed]="o.number === null"
                              >{{ o.number ?? '–' }}</span
                            >
                            <span class="flex min-w-0 flex-col">
                              <span class="break-words">{{ o.legend }}</span>
                              @if (o.number === null) {
                                <span class="text-muted-foreground text-xs">{{
                                  'editor.docEditor.calloutRef.hidden'
                                    | transloco
                                }}</span>
                              }
                            </span>
                          </span>
                        </z-command-option>
                      }
                    </z-command-option-group>
                  }
                </z-command-list>
              </z-command>
            }
          }
          @case ('attribute') {
            @if (attributes().length === 0) {
              <p
                class="text-muted-foreground m-0 text-sm break-words"
                data-autofocus
                tabindex="-1"
              >
                {{ 'editor.docEditor.attribute.none' | transloco }}
              </p>
            } @else {
              <z-command
                class="rounded-none border-0 p-0 shadow-none"
                (zCommandSelected)="chooseAttribute($event)"
              >
                <z-command-input
                  data-autofocus
                  [placeholder]="
                    'editor.docEditor.attribute.search' | transloco
                  "
                />
                <z-command-list>
                  @for (a of attributes(); track a.id) {
                    <z-command-option [zValue]="a.id" [zLabel]="a.label">
                      <span
                        data-slot="command-option-label"
                        class="flex min-w-0 flex-col"
                      >
                        <span class="break-words">{{ a.label }}</span>
                        <span
                          class="text-muted-foreground font-mono text-xs break-all"
                          >{{ '{' + a.id + '}' }}</span
                        >
                      </span>
                    </z-command-option>
                  }
                </z-command-list>
              </z-command>
            }
          }
          @case ('kbd') {
            <form
              class="flex flex-col gap-3"
              (submit)="$event.preventDefault(); applyKeys()"
            >
              <div class="flex flex-col gap-1.5">
                <label class="text-xs font-medium" for="inline-kbd-keys">{{
                  'editor.docEditor.kbd.keys' | transloco
                }}</label>
                <input
                  z-input
                  id="inline-kbd-keys"
                  data-autofocus
                  autocomplete="off"
                  spellcheck="false"
                  [placeholder]="'editor.docEditor.kbd.placeholder' | transloco"
                  [value]="keysText()"
                  [attr.aria-invalid]="keysRefused() || null"
                  aria-describedby="inline-kbd-hint"
                  (input)="keysText.set($any($event.target).value)"
                />
                <p
                  id="inline-kbd-hint"
                  class="m-0 text-xs leading-4 break-words"
                  [class.text-destructive]="keysRefused()"
                  [class.text-muted-foreground]="!keysRefused()"
                >
                  {{
                    (keysRefused()
                      ? 'editor.docEditor.kbd.refused'
                      : 'editor.docEditor.kbd.hint'
                    ) | transloco
                  }}
                </p>
              </div>
              <div>
                <button z-button zSize="sm" type="submit" [disabled]="!keys()">
                  {{ 'editor.docEditor.kbd.apply' | transloco }}
                </button>
              </div>
            </form>
          }
        }
      </z-popover>
    </ng-template>
  `,
})
export class InlineEditPopoverComponent implements InlineEditor {
  readonly handle = input<EditorHandle | null>(null);
  readonly settings = input<DocBlockSettings>({});

  private readonly t = injectTranslate();
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly anchor =
    viewChild.required<ElementRef<HTMLElement>>('anchor');
  private readonly panelEl = viewChild('panelEl', { read: ElementRef });

  protected readonly request = signal<InlineEditRequest | null>(null);
  protected readonly visible = signal(false);
  protected readonly pickOther = PICK_OTHER;

  // The link's and the keys' fields.
  protected readonly href = signal('');
  protected readonly text = signal('');
  protected readonly keysText = signal('');

  /** Referenced modules' targets, read once per opening. */
  private readonly moduleStates = signal<ReadonlyMap<string, ModuleTargets>>(
    new Map(),
  );
  private readonly docTargetList = signal<readonly XrefTarget[]>([]);
  private readonly referenced = signal<readonly string[]>([]);
  private openings = 0;

  protected readonly title = computed(() => {
    switch (this.request()?.kind) {
      case 'link':
        return this.t('editor.docEditor.link.title');
      case 'xref':
        return this.t('editor.docEditor.xref.title');
      case 'attribute':
        return this.t('editor.docEditor.attribute.title');
      case 'kbd':
        return this.t('editor.docEditor.kbd.title');
      case 'calloutRef':
        return this.t('editor.docEditor.calloutRef.title');
      default:
        return '';
    }
  });

  protected readonly linked = computed(() => {
    const r = this.request();
    return r?.kind === 'link' && r.linked;
  });

  /** The address as it would be stored; empty while nothing is typed. */
  private readonly completed = computed(() => completeHref(this.href()));
  protected readonly hrefRefused = computed(
    () => this.completed() !== '' && !isLinkHref(this.completed()),
  );
  protected readonly canApplyLink = computed(() =>
    isLinkHref(this.completed()),
  );
  /** The link as it is now, to open in a new tab; empty for a new link. */
  protected readonly openable = computed(() => {
    const r = this.request();
    return r?.kind === 'link' && r.linked && isLinkHref(r.href) ? r.href : '';
  });

  protected readonly keys = computed(() => parseKeys(this.keysText()));
  protected readonly keysRefused = computed(
    () => this.keysText().trim() !== '' && this.keys() === null,
  );

  protected readonly attributes = computed(
    () => this.settings().config?.textAttributes ?? [],
  );

  /** The callouts a reference can name: this module's images, each with its callouts. */
  private readonly calloutDoc = signal<ProseMirrorNode | null>(null);
  protected readonly calloutGroups = computed(() => {
    const doc = this.calloutDoc();
    if (!doc) return [];
    const images = documentCallouts(doc, this.settings().variant ?? null);
    return [...images]
      .filter(([, found]) => found.callouts.length > 0)
      .map(([image, found]) => ({
        image,
        title:
          captionOf(found.image) ||
          String(found.image.attrs['alt'] ?? '') ||
          this.t('editor.docEditor.xref.kind.figure'),
        options: found.callouts.map((c) => {
          const legend = c.text || this.t('editor.docEditor.callouts.noLegend');
          return {
            value: { block: image, callout: c.id },
            number: c.number,
            legend,
            label: `${c.number ?? '–'} ${legend}`,
          };
        }),
      }));
  });

  protected readonly canPickModule = computed(
    () => !!this.settings().pickModule,
  );

  private hintOf(target: XrefTarget): string {
    return targetLabel({ ...target, label: '' }, this.t);
  }

  private optionOf(
    module: string,
    target: XrefTarget,
    depth = 0,
  ): TargetOption {
    return {
      value: { module, block: target.block },
      label: targetLabel(target, this.t),
      hint: this.hintOf(target),
      depth: target.depth + depth,
    };
  }

  protected readonly ownTargets = computed((): TargetOption[] => {
    const own = this.ownModule();
    return this.docTargetList().map((x) => this.optionOf(own, x));
  });

  protected readonly moduleGroups = computed(() =>
    this.referenced().map((module) => {
      const state = this.moduleStates().get(module) ?? { status: 'loading' };
      const options: TargetOption[] =
        state.status === 'ready'
          ? [
              {
                value: { module, block: null },
                label: state.content.title,
                hint: this.t('editor.docEditor.xref.wholeModule'),
                depth: 0,
              },
              ...blockTargets(state.content.blocks).map((x) =>
                this.optionOf(module, x, 1),
              ),
            ]
          : [];
      return {
        module,
        title: state.status === 'ready' ? state.content.title : module,
        state,
        options,
      };
    }),
  );

  private ownModule(): string {
    const doc = this.handle()?.editor.state.doc;
    return String(doc?.attrs['moduleId'] ?? '');
  }

  /** Opens on `request`, anchored at its start. */
  open(request: InlineEditRequest): void {
    const editor = this.handle()?.editor;
    if (!editor || editor.isDestroyed) return;
    const run = ++this.openings;
    this.place(request.from);
    this.request.set(request);
    if (request.kind === 'link') {
      this.href.set(request.href);
      this.text.set(request.text);
    } else if (request.kind === 'kbd') {
      this.keysText.set(formatKeys(request.current));
    } else if (request.kind === 'xref') {
      this.loadTargets(run);
    } else if (request.kind === 'calloutRef') {
      this.calloutDoc.set(editor.state.doc);
    }
    // A popover still open for another request closes first; it opens again next frame.
    if (this.visible()) this.visible.set(false);
    setTimeout(() => {
      if (run !== this.openings) return;
      this.visible.set(true);
      setTimeout(() => this.focusFirst());
    });
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

  private loadTargets(run: number): void {
    const editor = this.handle()?.editor;
    if (!editor) return;
    const doc = editor.state.doc;
    const own = this.ownModule();
    this.docTargetList.set(docTargets(doc));
    const modules = referencedModules(doc).filter(
      (m) => m !== own && ModuleId.safeParse(m).success,
    );
    this.referenced.set(modules);
    const read = this.settings().moduleContent;
    const states = new Map<string, ModuleTargets>();
    for (const module of modules)
      states.set(module, read ? { status: 'loading' } : { status: 'failed' });
    this.moduleStates.set(states);
    if (!read) return;
    for (const module of modules) {
      read(module).then(
        (content) =>
          this.setModule(
            run,
            module,
            content ? { status: 'ready', content } : { status: 'missing' },
          ),
        () => this.setModule(run, module, { status: 'failed' }),
      );
    }
  }

  private setModule(run: number, module: string, state: ModuleTargets): void {
    if (run !== this.openings) return;
    this.moduleStates.update((states) => new Map(states).set(module, state));
  }

  private focusFirst(): void {
    const panel = this.panelEl()?.nativeElement as HTMLElement | undefined;
    const target =
      panel?.querySelector<HTMLElement>('[data-autofocus] input') ??
      panel?.querySelector<HTMLElement>('[data-autofocus]');
    target?.focus();
  }

  /** Closed: by Escape or a click elsewhere. */
  protected visibleChanged(visible: boolean): void {
    if (visible) return;
    const wasOpen = this.visible();
    this.visible.set(false);
    if (wasOpen) this.backToText();
  }

  protected cancel(): void {
    this.close();
  }

  private close(): void {
    this.openings += 1;
    this.visible.set(false);
    this.backToText();
  }

  /** The focus back in the text, unless it went somewhere else of its own. */
  private backToText(): void {
    const editor = this.handle()?.editor;
    if (!editor || editor.isDestroyed) return;
    const active = editor.view.dom.ownerDocument.activeElement;
    const panel = this.panelEl()?.nativeElement as HTMLElement | undefined;
    const elsewhere =
      active &&
      active !== editor.view.dom.ownerDocument.body &&
      !(panel?.contains(active) ?? false);
    if (!elsewhere) editor.view.focus();
  }

  protected applyLinkForm(): void {
    const r = this.request();
    const editor = this.handle()?.editor;
    if (r?.kind !== 'link' || !editor || !this.canApplyLink()) return;
    if (applyLink(editor, r, this.completed(), this.text())) this.close();
  }

  protected unlink(): void {
    const r = this.request();
    const editor = this.handle()?.editor;
    if (r?.kind !== 'link' || !editor) return;
    removeLink(editor, r);
    this.close();
  }

  protected openAddress(address: string): void {
    const editor = this.handle()?.editor;
    if (editor) openLink(editor.view, address);
  }

  protected chooseTarget(option: ZardCommandOption): void {
    const r = this.request();
    const editor = this.handle()?.editor;
    if (r?.kind !== 'xref' || !editor) return;
    if (option.value === PICK_OTHER) {
      void this.pickOtherModule(r);
      return;
    }
    const value = option.value as TargetOption['value'] | null;
    if (!value) return;
    putAtom(editor, r, { module: value.module, block: value.block });
    this.close();
  }

  /** The module picker, for a link only: the cross-reference goes to the chosen module. */
  private async pickOtherModule(
    r: Extract<InlineEditRequest, { kind: 'xref' }>,
  ): Promise<void> {
    const pick = this.settings().pickModule;
    const editor = this.handle()?.editor;
    if (!pick || !editor) return;
    this.openings += 1;
    this.visible.set(false);
    const answer = await pick(r.current?.module ?? null, { linkOnly: true });
    if (!answer || editor.isDestroyed || !editor.isEditable) {
      if (!editor.isDestroyed) editor.view.focus();
      return;
    }
    putAtom(editor, r, { module: answer.module, block: null });
  }

  protected chooseCallout(option: ZardCommandOption): void {
    const r = this.request();
    const editor = this.handle()?.editor;
    const value = option.value as { block?: unknown; callout?: unknown } | null;
    if (
      r?.kind !== 'calloutRef' ||
      !editor ||
      typeof value?.block !== 'string' ||
      typeof value.callout !== 'string'
    )
      return;
    putAtom(editor, r, { block: value.block, callout: value.callout });
    this.close();
  }

  protected chooseAttribute(option: ZardCommandOption): void {
    const r = this.request();
    const editor = this.handle()?.editor;
    if (r?.kind !== 'attribute' || !editor || typeof option.value !== 'string')
      return;
    putAtom(editor, r, { name: option.value });
    this.close();
  }

  protected applyKeys(): void {
    const r = this.request();
    const editor = this.handle()?.editor;
    const keys = this.keys();
    if (r?.kind !== 'kbd' || !editor || !keys) return;
    putAtom(editor, r, { keys });
    this.close();
  }
}
