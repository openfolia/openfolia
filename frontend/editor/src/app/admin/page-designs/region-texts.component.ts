import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import type { JSONContent } from '@tiptap/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucideChevronDown,
  lucideLanguages,
  lucideTrash2,
  lucideTriangleAlert,
  lucideUndo2,
} from '@ng-icons/lucide';

import {
  ConversionError,
  EditorLimitError,
  regionFromEditor,
  regionToEditor,
} from '@openfolia/content-editor-model';
import type { Block } from '@openfolia/content-model/core';
import { ZardBadgeComponent } from '@openfolia/ui/badge';
import { ZardButtonComponent } from '@openfolia/ui/button';
import { CollapseComponent } from '@openfolia/ui/collapse';
import { injectTranslate, LanguageService } from '@openfolia/ui/i18n';
import {
  SegmentedComponent,
  type SegmentedOption,
} from '@openfolia/ui/segmented';

import { languageName, type ProjectConfig } from '../../content/browser-model';
import { BlockEditorComponent } from '../../doc-editor/block-editor.component';
import type {
  DocBlockSettings,
  ImageChoice,
} from '../../doc-editor/blocks/doc-blocks-context';
import type { BlockIssue } from '../../doc-editor/plugins/block-issues';
import { ImageSources } from '../../images/image-sources';
import { InsertImageDialogComponent } from '../../images/insert-image-dialog.component';
import { issueText } from './design-issues';
import type { DesignIssue, PageDesign } from './design-model';
import {
  missingTranslations,
  REGION_HINTS,
  REGION_LABELS,
  regionGroups,
  regionIn,
  regionsOf,
  strayRegions,
  withoutRegion,
  withoutTranslation,
  withRegionText,
  type Regions,
} from './region-text';

/** An issue's place in the design and, after `#`, its block (`regions.footer.en#note`). */
export function issuePlace(issue: DesignIssue): {
  at: string;
  block: string | null;
} {
  const at = issue.at ?? '';
  const hash = at.indexOf('#');
  return hash < 0
    ? { at, block: null }
    : { at: at.slice(0, hash), block: at.slice(hash + 1) || null };
}

/** How long typing in a region waits before the design takes the text (and saves it). */
export const REGION_EDIT_DELAY_MS = 600;

/** One edit not yet handed to the design: a region's blocks in one language. */
interface Pending {
  readonly slot: string;
  readonly lang: string;
  readonly blocks: readonly Block[];
}

/**
 * The title page's and back page's text (#393): each region of the design's preset (and the
 * back page's) in the block editor of a region (`region`: text, Heading 1, lists, images, notes,
 * links, placeholders), in the language chosen above them, which the preview shows too. The
 * source language's text is every language's until a language has its own; a language without
 * its own says so and shows the source language's, which editing turns into its own (the
 * blocks and their IDs kept). Typing is handed to the design shortly after the last key, or at
 * once when the focus leaves the region; Undo on the screen puts back the text before, and the
 * editor shows it. Text in a region the preset does not have is kept, flagged, and can be
 * removed. The design's issues show at their region, and at their block in its editor.
 */
@Component({
  selector: 'of-region-texts',
  imports: [
    TranslocoPipe,
    NgIcon,
    ZardBadgeComponent,
    ZardButtonComponent,
    CollapseComponent,
    SegmentedComponent,
    BlockEditorComponent,
    InsertImageDialogComponent,
  ],
  viewProviders: [
    provideIcons({
      lucideChevronDown,
      lucideLanguages,
      lucideTrash2,
      lucideTriangleAlert,
      lucideUndo2,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'flex min-w-0 flex-col gap-4' },
  template: `
    @if (languages().length > 1) {
      <div class="flex min-w-0 flex-col gap-1.5" data-slot="region-language">
        <span class="text-muted-foreground text-xs" id="pd-region-lang">{{
          'editor.admin.pageDesigns.regions.language' | transloco
        }}</span>
        <of-segmented
          [options]="langOptions()"
          [value]="activeLang()"
          [label]="'editor.admin.pageDesigns.regions.language' | transloco"
          (valueChange)="pickLang($event)"
        />
        <p
          class="text-muted-foreground m-0 text-xs break-words"
          data-slot="region-translation-summary"
          aria-live="polite"
        >
          {{ summary() }}
        </p>
      </div>
    }

    @for (group of groups(); track group.id) {
      <div
        class="flex min-w-0 flex-col gap-2"
        [attr.data-region-group]="group.id"
      >
        <h3 class="m-0 text-sm font-medium">{{ group.title | transloco }}</h3>
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          @for (slot of group.slots; track slot) {
            @let shown = inLang(slot);
            @let open = isOpen(slot);
            <li
              class="flex min-w-0 flex-col rounded-lg border"
              [attr.data-region]="slot"
              [attr.data-state]="shown.state"
            >
              <button
                type="button"
                class="hover:bg-muted/50 focus-visible:ring-ring/50 flex min-w-0 items-start gap-3 rounded-lg px-3 py-2.5 text-start outline-none focus-visible:ring-2"
                [attr.aria-expanded]="open"
                [attr.aria-controls]="'pd-region-' + slot"
                (click)="toggle(slot)"
              >
                <span class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="text-sm font-medium break-words">{{
                    labelOf(slot) | transloco: { slot }
                  }}</span>
                  <span class="text-muted-foreground text-xs break-words">{{
                    hintOf(slot) | transloco
                  }}</span>
                </span>
                <span class="flex shrink-0 items-center gap-2">
                  @if (group.id === 'stray') {
                    <z-badge zType="warning" data-slot="region-stray">{{
                      'editor.admin.pageDesigns.regions.stray' | transloco
                    }}</z-badge>
                  } @else if (shown.state === 'empty') {
                    <z-badge zType="outline" data-slot="region-badge">{{
                      'editor.admin.pageDesigns.regions.empty' | transloco
                    }}</z-badge>
                  } @else if (activeLang() !== source()) {
                    @if (shown.state === 'own') {
                      <z-badge zType="success" data-slot="region-badge">{{
                        'editor.admin.pageDesigns.regions.translated'
                          | transloco
                      }}</z-badge>
                    } @else {
                      <z-badge zType="warning" data-slot="region-badge">{{
                        'editor.admin.pageDesigns.regions.untranslated'
                          | transloco
                      }}</z-badge>
                    }
                  }
                  <ng-icon
                    name="lucideChevronDown"
                    size="16"
                    aria-hidden="true"
                    class="text-muted-foreground transition-transform duration-200 motion-reduce:transition-none"
                    [class.rotate-180]="open"
                  />
                </span>
              </button>
              <of-collapse [open]="open" [attr.id]="'pd-region-' + slot">
                <div class="flex min-w-0 flex-col gap-2 px-3 pb-3">
                  @if (shown.state === 'source' && activeLang() !== source()) {
                    <p
                      class="text-muted-foreground m-0 flex min-w-0 items-start gap-1.5 text-xs break-words"
                      data-slot="region-fallback"
                    >
                      <ng-icon
                        name="lucideLanguages"
                        class="mt-0.5 shrink-0"
                        size="13"
                        aria-hidden="true"
                      />
                      <span>{{
                        'editor.admin.pageDesigns.regions.fallback'
                          | transloco
                            : {
                                language: langLabel(activeLang()),
                                source: langLabel(source()),
                              }
                      }}</span>
                    </p>
                  }
                  @if (mounted().has(slot)) {
                    @for (key of [editorKey(slot)]; track key) {
                      <of-block-editor
                        class="max-h-96 min-h-28"
                        [region]="true"
                        [value]="valueOf(slot)"
                        [editable]="editable()"
                        [blocks]="blockSettings()"
                        [issues]="blockIssues(slot)"
                        [label]="
                          'editor.admin.pageDesigns.regions.editorLabel'
                            | transloco
                              : {
                                  region: (labelOf(slot) | transloco: { slot }),
                                  language: langLabel(activeLang()),
                                }
                        "
                        (changed)="edited(slot, $event)"
                        (blurred)="flush()"
                      />
                    }
                  }
                  @if (incomplete().has(slot)) {
                    <p
                      class="text-muted-foreground m-0 text-xs break-words"
                      data-slot="region-incomplete"
                    >
                      {{
                        'editor.admin.pageDesigns.regions.incomplete'
                          | transloco
                      }}
                    </p>
                  }
                  @let found = issuesOf(slot);
                  @if (found.length > 0) {
                    <ul
                      class="m-0 flex list-none flex-col gap-1 p-0"
                      data-slot="design-issues"
                    >
                      @for (issue of found; track $index) {
                        <li
                          class="flex min-w-0 gap-1.5 text-xs"
                          [class.text-destructive]="issue.severity === 'error'"
                          [attr.data-issue]="issue.code"
                        >
                          <ng-icon
                            name="lucideTriangleAlert"
                            class="mt-0.5 shrink-0"
                            size="13"
                            aria-hidden="true"
                          />
                          <span class="min-w-0 [overflow-wrap:anywhere]">{{
                            describe(issue)
                          }}</span>
                        </li>
                      }
                    </ul>
                  }
                  @if (editable()) {
                    <div class="flex min-w-0 flex-wrap gap-2">
                      @if (shown.state === 'own' && activeLang() !== source()) {
                        <button
                          z-button
                          zType="outline"
                          zSize="sm"
                          type="button"
                          data-slot="region-use-source"
                          (click)="useSource(slot)"
                        >
                          <ng-icon
                            name="lucideUndo2"
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                          {{
                            'editor.admin.pageDesigns.regions.useSource'
                              | transloco: { source: langLabel(source()) }
                          }}
                        </button>
                      }
                      @if (group.id === 'stray') {
                        <button
                          z-button
                          zType="outline"
                          zSize="sm"
                          type="button"
                          data-slot="region-remove"
                          (click)="remove(slot)"
                        >
                          <ng-icon
                            name="lucideTrash2"
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                          {{
                            'editor.admin.pageDesigns.regions.remove'
                              | transloco
                          }}
                        </button>
                      }
                    </div>
                  }
                </div>
              </of-collapse>
            </li>
          }
        </ul>
      </div>
    }

    <of-insert-image-dialog
      [changeSetId]="changeSetId()"
      [lang]="activeLang()"
    />
  `,
})
export class RegionTextsComponent {
  readonly design = input.required<PageDesign>();
  /** The project's languages: the source language first, then the targets. */
  readonly languages = input.required<readonly string[]>();
  /** The language shown and edited (the preview's); the source language when it is none of them. */
  readonly lang = input('');
  readonly config = input<ProjectConfig | null>(null);
  readonly issues = input<readonly DesignIssue[]>([]);
  readonly editable = input(false);
  /** The change set images are uploaded into; null: none can be picked. */
  readonly changeSetId = input<string | null>(null);
  /**
   * Takes the design's regions after an edit. A function, not an output: the edits still waiting
   * when the component goes are handed on then too, after its outputs are gone.
   */
  readonly apply = input.required<(regions: Regions) => void>();
  /** Another language chosen. */
  readonly langChange = output<string>();

  private readonly t = injectTranslate();
  private readonly language = inject(LanguageService);
  private readonly images = inject(ImageSources);
  private readonly imageDialog = viewChild(InsertImageDialogComponent);

  protected readonly source = computed(() => this.languages()[0] ?? '');
  protected readonly activeLang = computed(() => {
    const lang = this.lang();
    return this.languages().includes(lang) ? lang : this.source();
  });
  private readonly regions = computed(() => regionsOf(this.design()));

  protected readonly groups = computed(() => {
    const { titlePage, backPage } = regionGroups(this.design().preset);
    const stray = strayRegions(this.regions(), this.design().preset);
    return [
      {
        id: 'title',
        title: 'editor.admin.pageDesigns.regions.titlePage',
        slots: titlePage,
      },
      {
        id: 'back',
        title: 'editor.admin.pageDesigns.regions.backPage',
        slots: backPage,
      },
      ...(stray.length > 0
        ? [
            {
              id: 'stray',
              title: 'editor.admin.pageDesigns.regions.strayTitle',
              slots: stray,
            },
          ]
        : []),
    ];
  });
  private readonly slots = computed(() =>
    this.groups().flatMap((g) => g.slots),
  );

  protected readonly langOptions = computed((): SegmentedOption[] => {
    const source = this.source();
    const regions = this.regions();
    const slots = this.slots();
    return this.languages().map((lang) => ({
      value: lang,
      label: this.langLabel(lang),
      count:
        lang === source
          ? null
          : missingTranslations(regions, slots, lang, source).length || null,
    }));
  });

  /** Where the chosen language's translations stand, in words. */
  protected readonly summary = computed(() => {
    const lang = this.activeLang();
    const source = this.source();
    if (lang === source)
      return this.t('editor.admin.pageDesigns.regions.summarySource');
    const missing = missingTranslations(
      this.regions(),
      this.slots(),
      lang,
      source,
    ).length;
    return missing === 0
      ? this.t('editor.admin.pageDesigns.regions.summaryDone', {
          language: this.langLabel(lang),
        })
      : this.t('editor.admin.pageDesigns.regions.summaryMissing', {
          count: missing,
          language: this.langLabel(lang),
          source: this.langLabel(source),
        });
  });

  protected readonly blockSettings = computed((): DocBlockSettings => ({
    config: this.config() as DocBlockSettings['config'],
    lang: this.activeLang(),
    imageSource: this.imageSource,
    ...(this.editable() && this.changeSetId()
      ? { pickImage: this.pickImage }
      : {}),
  }));

  // --- Open regions, and their editors ---

  /** The regions open (a person's choice, else those with text when first shown). */
  private readonly opened = signal<ReadonlySet<string> | null>(null);
  /** The regions whose editor was made (it stays once made, so closing keeps its state). */
  protected readonly mounted = signal<ReadonlySet<string>>(new Set());

  protected isOpen(slot: string): boolean {
    return this.opened()?.has(slot) ?? false;
  }

  protected toggle(slot: string): void {
    const next = new Set(this.opened() ?? []);
    if (next.has(slot)) next.delete(slot);
    else {
      next.add(slot);
      this.mounted.update((m) => new Set([...m, slot]));
    }
    this.opened.set(next);
  }

  // --- The text in the editors ---

  /**
   * Per region and language, the text its editor holds (as JSON): what it was made with, then
   * each change typed in it. A design whose text differs while nothing typed waits (Undo, a
   * save refused, a reload) makes the editor again with it.
   */
  private readonly held = new Map<string, string>();
  private readonly versions = signal<ReadonlyMap<string, number>>(new Map());
  private readonly pending = new Map<string, Pending>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  protected readonly incomplete = signal<ReadonlySet<string>>(new Set());

  private keyOf(slot: string, lang = this.activeLang()): string {
    return `${lang}/${slot}`;
  }

  protected inLang(slot: string) {
    return regionIn(this.regions(), slot, this.activeLang(), this.source());
  }

  protected editorKey(slot: string): string {
    const key = this.keyOf(slot);
    return `${key}#${this.versions().get(key) ?? 0}@${this.visit()}`;
  }

  /**
   * Each editor's document, by its editor key: made once, when the editor is (it reads it once),
   * from the design's text then.
   */
  private readonly values = new Map<string, JSONContent>();
  /**
   * The language the editors were last made in, and how often it changed: a language shown
   * again makes its editors again, from the design's text as it is by then.
   */
  private shownLang = '';
  private visits = 0;

  private visit(): number {
    const lang = this.activeLang();
    if (lang !== this.shownLang) {
      this.shownLang = lang;
      this.visits++;
      this.values.clear();
    }
    return this.visits;
  }

  /** The editor's document, made once per editor. */
  protected valueOf(slot: string): JSONContent {
    const editorKey = this.editorKey(slot);
    let value = this.values.get(editorKey);
    if (!value) {
      const blocks = this.inLang(slot).blocks;
      this.held.set(this.keyOf(slot), JSON.stringify(blocks));
      value = regionToEditor(blocks as Block[]) as JSONContent;
      this.values.set(editorKey, value);
    }
    return value;
  }

  constructor() {
    // First shown: the regions with text are open.
    effect(() => {
      if (this.opened() !== null) return;
      const regions = this.regions();
      const withText = new Set(
        untracked(this.slots).filter((s) => Object.hasOwn(regions, s)),
      );
      untracked(() => {
        this.opened.set(withText);
        this.mounted.set(new Set(withText));
      });
    });
    // A text the editor did not make (Undo, a refused save, a reload): its editor shows it.
    effect(() => {
      const regions = this.regions();
      const lang = this.activeLang();
      const source = this.source();
      untracked(() => {
        let bumped: Map<string, number> | null = null;
        for (const slot of this.slots()) {
          const key = this.keyOf(slot, lang);
          if (this.pending.has(key)) continue;
          const held = this.held.get(key);
          if (held === undefined) continue;
          const shown = regionIn(regions, slot, lang, source);
          const now = JSON.stringify(shown.blocks);
          if (now === held) continue;
          // Emptied in a language that now takes the source text again: the empty editor is
          // that, until typed into (a translation retyped from scratch keeps its caret).
          if (held === '[]' && shown.state === 'source') continue;
          bumped ??= new Map(this.versions());
          bumped.set(key, (bumped.get(key) ?? 0) + 1);
          this.held.delete(key);
          this.dropIncomplete(slot);
        }
        if (bumped) this.versions.set(bumped);
      });
    });
    // What waits is handed on when the screen goes (`apply` outlives the outputs).
    inject(DestroyRef).onDestroy(() => this.flush());
  }

  /** A change typed in `slot`'s editor: handed to the design once typing pauses. */
  protected edited(slot: string, doc: JSONContent): void {
    if (!this.editable()) return;
    let blocks: Block[];
    try {
      blocks = regionFromEditor(doc);
    } catch (error) {
      if (
        error instanceof ConversionError ||
        error instanceof EditorLimitError
      ) {
        // Not a region's text yet (an empty paragraph between two, say): kept in the editor.
        this.incomplete.update((s) => new Set([...s, slot]));
        return;
      }
      throw error;
    }
    this.dropIncomplete(slot);
    const lang = this.activeLang();
    const key = this.keyOf(slot, lang);
    const shown = this.inLang(slot);
    // Nothing typed yet in a language taking the source language's text: no text of its own.
    if (
      shown.state === 'source' &&
      JSON.stringify(blocks) === JSON.stringify(shown.blocks)
    ) {
      // Typed and taken back before it was handed on: nothing waits any more.
      this.held.set(key, JSON.stringify(shown.blocks));
      if (this.pending.delete(key) && this.pending.size === 0)
        clearTimeout(this.timer);
      return;
    }
    this.held.set(key, JSON.stringify(blocks));
    this.pending.set(key, { slot, lang, blocks });
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), REGION_EDIT_DELAY_MS);
  }

  /** Hands every waiting edit to the design at once; the regions with them. */
  flush(): Regions {
    clearTimeout(this.timer);
    let regions = this.regions();
    if (this.pending.size === 0) return regions;
    const source = this.source();
    for (const { slot, lang, blocks } of this.pending.values()) {
      regions = withRegionText(regions, slot, lang, source, blocks);
    }
    this.pending.clear();
    this.apply()(regions);
    return regions;
  }

  protected pickLang(lang: string): void {
    if (lang === this.activeLang()) return;
    this.flush();
    this.langChange.emit(lang);
  }

  protected useSource(slot: string): void {
    const regions = this.flush();
    this.apply()(
      withoutTranslation(regions, slot, this.activeLang(), this.source()),
    );
  }

  protected remove(slot: string): void {
    this.apply()(withoutRegion(this.flush(), slot));
  }

  private dropIncomplete(slot: string): void {
    if (!this.incomplete().has(slot)) return;
    this.incomplete.update((s) => {
      const next = new Set(s);
      next.delete(slot);
      return next;
    });
  }

  // --- Words ---

  protected labelOf(slot: string): string {
    return (
      REGION_LABELS[slot] ?? 'editor.admin.pageDesigns.regions.slots.other'
    );
  }

  protected hintOf(slot: string): string {
    return REGION_HINTS[slot] ?? 'editor.admin.pageDesigns.regions.hints.other';
  }

  protected langLabel(lang: string): string {
    return languageName(this.language.locale(), lang);
  }

  /** The design's issues at `slot`, in any language (the text says which). */
  protected issuesOf(slot: string): DesignIssue[] {
    const shared = `regions.${slot}`;
    return this.issues().filter((issue) => {
      const at = issuePlace(issue).at;
      return at === shared || at.startsWith(`${shared}.`);
    });
  }

  /** The issues at blocks of the text shown: the same in every language, or the one shown's. */
  protected blockIssues(slot: string): BlockIssue[] {
    const shared = `regions.${slot}`;
    const own = `${shared}.${this.activeLang()}`;
    return this.issuesOf(slot).flatMap((issue) => {
      const { at, block } = issuePlace(issue);
      return block && (at === shared || at === own)
        ? [{ at: block, severity: issue.severity, text: this.describe(issue) }]
        : [];
    });
  }

  protected describe(issue: DesignIssue): string {
    const text = issueText(issue);
    return this.t(text.key, text.params);
  }

  // --- Images ---

  private readonly imageSource = (asset: string): Promise<string | null> =>
    this.images.source(asset, this.changeSetId());

  private readonly pickImage = (
    current: ImageChoice | null,
    file?: File,
  ): Promise<ImageChoice | null> =>
    this.imageDialog()?.open(current, file) ?? Promise.resolve(null);
}
