import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { firstValueFrom } from 'rxjs';

import {
  labelsIn,
  type LocalizedText,
  withTextIn,
} from '@openfolia/content-model/core';
import { translated, type TranslatedText } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, pageQuery, ReadRef, toApiError } from '../../api';
import { UiTexts } from '../../i18n';
import { MeService } from '../../permissions/me';
import { ChangeSetSession } from '../../session/change-set-session';
import { Generation } from '../../shared/generation';
import {
  idParam,
  injectQueryState,
  intParam,
  oneOfParam,
} from '../../view-state';
import { ConfigDraft } from '../settings/config-draft';
import {
  CONFIG_KEY,
  setVariantAttributes,
  sourceLabel,
  usageKey,
  type ProjectConfig,
  type UsageCount,
  type UsagePlace,
  type VariantAttribute,
} from '../settings/config-model';
import {
  InUseDialogComponent,
  type InUseBuild,
  type InUseRequest,
} from './in-use-dialog.component';
import { USAGE_TABS, VariantDetailComponent } from './variant-detail.component';
import {
  addAttribute,
  addValue,
  findAttribute,
  findValue,
  orderAttributes,
  orderValues,
  removeAttribute,
  removeValue,
  renameAttribute,
  renameValue,
  setArchived,
  valueCondition,
  type VariantSelection,
} from './variant-edits';
import {
  VariantNewDialogComponent,
  type NewVariant,
  type NewVariantKind,
} from './variant-new-dialog.component';
import { VariantTreeComponent } from './variant-tree.component';

/** The usage counts are read this many at a time (the API's largest page). */
const USAGE_PAGE = 200;
const USAGE_PAGES = 5;
/** The most places and builds the in-use decision reads. */
const DECISION_PLACES = 100;
const DECISION_BUILDS = 20;

/** The view in the address: what is chosen, and its usage list's tab and page. */
const VARIANTS_VIEW = {
  attribute: idParam(CONFIG_KEY),
  value: idParam(CONFIG_KEY),
  usage: oneOfParam(USAGE_TABS),
  page: intParam(1),
};

/** A removal waiting for the person's decision, or sent and possibly refused. */
interface PendingRemoval {
  readonly request: InUseRequest;
  /** The value archived instead; null when that is not offered. */
  readonly archive: VariantSelection | null;
}

/**
 * The variant attributes and their values as data (#91, screen 21), standalone: on the left the
 * attributes and their values, in order (reordered by drag or Alt+Arrow keys); on the right the
 * chosen one: its label, key, group, where content uses it (paged, linked) and the builds it
 * appears in. Every change is shown and saved at once into the host's `ConfigDraft`, with Undo.
 * Removing a value content still uses opens its own in-use decision: archive it (it stays valid,
 * pickers hide it) or cancel; removing is not offered while it is used. The Add dialog is its own
 * too (`openNew`). The chosen attribute or value and the usage list's tab and page are in the
 * address. The host provides and loads the `ConfigDraft` and gives the frame around it (the
 * Variants tab; later the settings screen, #318); nothing here assumes a page around it.
 */
@Component({
  selector: 'of-variant-editor',
  imports: [
    TranslocoPipe,
    InUseDialogComponent,
    VariantDetailComponent,
    VariantNewDialogComponent,
    VariantTreeComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0' },
  template: `
    <div
      class="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]"
    >
      <of-variant-tree
        class="lg:sticky lg:top-4"
        [attributes]="sourceAttributes()"
        [selection]="selection()"
        [editable]="editable()"
        [counts]="counts()"
        (choose)="select($event)"
        (reorderAttributes)="reorderAttributes($event)"
        (reorderValues)="reorderValues($event.attribute, $event.ids)"
        (newAttribute)="openNew('attribute')"
      />
      @if (selectedAttribute(); as a) {
        <of-variant-detail
          [attribute]="a"
          [value]="selectedValue()"
          [editable]="editable()"
          [languages]="config()?.languages ?? null"
          [count]="selectedCount()"
          [tab]="view.get('usage')() ?? 'content'"
          [page]="view.get('page')()"
          [reloadKey]="draft.commits()"
          (rename)="rename($event)"
          (relabel)="relabel($event)"
          (archive)="archiveSelected(true)"
          (restore)="archiveSelected(false)"
          (remove)="removeSelected()"
          (addValue)="openNew('value')"
          (tabChange)="view.set({ usage: $event, page: 1 }, { replace: true })"
          (pageChange)="view.set({ page: $event })"
        />
      } @else {
        <p
          class="border-border text-muted-foreground m-0 rounded-xl border p-5 text-sm"
        >
          {{ 'editor.admin.variants.detail.none' | transloco }}
        </p>
      }
    </div>

    <of-in-use-dialog
      [request]="decision()?.request ?? null"
      (archive)="archiveDecided()"
      (closed)="decision.set(null)"
    />
    <of-variant-new-dialog
      [kind]="newKind()"
      [attributes]="sourceAttributes()"
      [startGroup]="selection()?.attribute"
      (add)="add($event)"
      (closed)="newKind.set(null)"
    />
  `,
})
export class VariantEditorComponent {
  protected readonly draft = inject(ConfigDraft);
  private readonly changeSets = inject(ChangeSetSession);
  private readonly api = inject(ApiClient);
  private readonly texts = inject(UiTexts);
  private readonly me = inject(MeService);
  private readonly readRef = inject(ReadRef);
  private readonly toast = inject(ToastService);

  protected readonly view = injectQueryState(VARIANTS_VIEW);

  protected readonly config = this.draft.config;
  protected readonly editable = computed(
    () => this.draft.mode().kind === 'edit' && this.draft.status() === 'ready',
  );
  private readonly readReason = computed(() => {
    const m = this.draft.mode();
    return m.kind === 'read' && m.reason
      ? m.reason
      : 'editor.admin.settings.blocked.readOnly';
  });

  protected readonly attributes = computed(
    () => this.config()?.variantAttributes ?? [],
  );
  /** The attributes with their labels in the source language, as the list and the dialog name them. */
  protected readonly sourceAttributes = computed(() => {
    const c = this.config();
    return c ? labelsIn(c, c.languages.source).variantAttributes : [];
  });

  /** A label in the source language (#731). */
  private src(label: LocalizedText): string {
    const c = this.config();
    return c ? sourceLabel(c, label) : typeof label === 'string' ? label : '';
  }

  /** What is shown: the address's choice while it exists, else its attribute, else the first. */
  protected readonly selection = computed((): VariantSelection | null => {
    const attributes = this.attributes();
    const a =
      findAttribute(attributes, this.view.get('attribute')()) ?? attributes[0];
    if (!a) return null;
    const value = findValue(attributes, a.id, this.view.get('value')());
    return { attribute: a.id, value: value?.id };
  });
  protected readonly selectedAttribute = computed(() =>
    findAttribute(this.attributes(), this.selection()?.attribute),
  );
  protected readonly selectedValue = computed(() => {
    const s = this.selection();
    return findValue(this.attributes(), s?.attribute, s?.value);
  });
  protected readonly selectedCount = computed((): UsageCount | null => {
    const s = this.selection();
    if (!s) return null;
    return (
      this.counts().get(
        usageKey(
          s.value === undefined
            ? { kind: 'variantAttribute', valueId: s.attribute }
            : {
                kind: 'variantValue',
                valueId: s.value,
                parentId: s.attribute,
              },
        ),
      ) ?? null
    );
  });

  /** Usage counts by `usageKey`, read at the change set's branch. */
  protected readonly counts = signal<ReadonlyMap<string, UsageCount>>(
    new Map(),
  );
  /** The decision open now (a value in use), or null. */
  protected readonly decision = signal<PendingRemoval | null>(null);
  /** The last removal sent: a refusal of it offers its archive. */
  private lastRemoval: PendingRemoval | null = null;
  protected readonly newKind = signal<NewVariantKind | null>(null);
  private readonly countReads = new Generation();
  private removals = 0;

  constructor() {
    effect(() => {
      this.readRef.ref();
      this.readRef.moves();
      this.me.me();
      this.draft.commits();
      // A switch unanswered: what was asked for the person before lands for nobody (#716).
      if (this.changeSets.switching()) {
        this.countReads.end();
        return;
      }
      untracked(() => void this.readCounts());
    });
    // A refusal by the API: the decision names where the value is used.
    effect(() => {
      const refusal = this.draft.refusal();
      if (!refusal) return;
      untracked(() => {
        const last = this.lastRemoval;
        const same = last?.request.what === refusal.what;
        this.decision.set({
          request: {
            what: refusal.what,
            count: same ? last.request.count : null,
            filter: null,
            places: refusal.places,
            total: refusal.total,
            canArchive: same && !!last.archive,
            ...(same && last.request.builds && { builds: last.request.builds }),
          },
          archive: same ? last.archive : null,
        });
        this.draft.refusal.set(null);
      });
    });
  }

  private async readCounts(): Promise<void> {
    const live = this.countReads.start();
    const found = new Map<string, UsageCount>();
    try {
      for (let page = 1; page <= USAGE_PAGES; page++) {
        const doc = await firstValueFrom(
          this.api.get('/config/usages', {
            query: pageQuery({ number: page, size: USAGE_PAGE }),
          }),
        );
        if (!live()) return;
        for (const r of doc.data) found.set(r.id, r.meta);
        if (page >= doc.meta.page.lastPage) break;
      }
      this.counts.set(found);
    } catch {
      // Counts are a help, not a condition: without them the API's check still refuses.
      if (live()) this.counts.set(new Map());
    }
  }

  protected select(s: VariantSelection): void {
    this.view.set({ attribute: s.attribute, value: s.value, page: 1 });
  }

  /** Opens the Add dialog (a value, or an attribute when there is no set of values yet). */
  openNew(kind: NewVariantKind): void {
    if (!this.editable()) {
      this.toast.show(translated(this.readReason()), { kind: 'info' });
      return;
    }
    if (kind === 'value' && !this.attributes().some((a) => a.kind === 'enum')) {
      this.newKind.set('attribute');
      return;
    }
    this.newKind.set(kind);
  }

  // --- Changes: shown and saved at once, with Undo. ---

  /**
   * Saves `next` as the variant attributes. With `done`, a toast says so and offers Undo, which
   * puts back what was there as long as nothing changed the attributes since.
   */
  private save(
    next: readonly VariantAttribute[],
    what: TranslatedText,
    done?: TranslatedText,
  ): boolean {
    const c = this.config();
    if (!c) return false;
    const before = c.variantAttributes;
    const changed: ProjectConfig = setVariantAttributes(c, next);
    if (!this.draft.change(changed, what)) return false;
    if (done) {
      this.toast.success(done, {
        actionLabel: translated('ui.toast.undo'),
        onAction: () => {
          const now = this.config();
          if (now?.variantAttributes !== changed.variantAttributes) {
            this.toast.show(translated('editor.admin.variants.undoLate'), {
              kind: 'info',
            });
            return;
          }
          this.draft.change(
            setVariantAttributes(now, before),
            translated('editor.admin.variants.undo'),
          );
        },
      });
    }
    return true;
  }

  /** The source language's label renamed (#731): the other languages' stay as they are. */
  protected rename(label: string): void {
    const s = this.selection();
    const source = this.config()?.languages.source;
    const before =
      this.selectedValue()?.label ?? this.selectedAttribute()?.label;
    if (!s || !source || before === undefined) return;
    this.relabel(
      withTextIn(before, source, source, label),
      translated('editor.admin.settings.changes.rename', { label }),
    );
  }

  /** The label in every language (#731). */
  protected relabel(label: LocalizedText, what?: TranslatedText): void {
    const s = this.selection();
    const c = this.config();
    if (!s || !c) return;
    const attributes = this.attributes();
    const before =
      this.selectedValue()?.label ?? this.selectedAttribute()?.label;
    this.save(
      s.value === undefined
        ? renameAttribute(attributes, s.attribute, label)
        : renameValue(attributes, s.attribute, s.value, label),
      what ??
        translated('editor.admin.settings.changes.relabel', {
          label: this.src(before ?? label),
        }),
    );
  }

  protected reorderAttributes(ids: readonly string[]): void {
    this.save(
      orderAttributes(this.attributes(), ids),
      translated('editor.admin.settings.changes.reorder'),
    );
  }

  protected reorderValues(attribute: string, ids: readonly string[]): void {
    this.save(
      orderValues(this.attributes(), attribute, ids),
      translated('editor.admin.settings.changes.reorder'),
    );
  }

  protected add(request: NewVariant): void {
    this.newKind.set(null);
    if (request.kind === 'value') {
      const done = this.save(
        addValue(this.attributes(), request.attribute, {
          id: request.id,
          label: request.label,
        }),
        translated('editor.admin.settings.changes.add', {
          label: request.label,
        }),
        translated('editor.admin.variants.done.add', { label: request.label }),
      );
      if (done) {
        this.view.set({
          attribute: request.attribute,
          value: request.id,
          page: 1,
        });
      }
      return;
    }
    const { attribute } = request;
    const done = this.save(
      addAttribute(this.attributes(), attribute),
      translated('editor.admin.settings.changes.add', {
        label: attribute.label,
      }),
      translated('editor.admin.variants.done.add', { label: attribute.label }),
    );
    if (done) {
      this.view.set({ attribute: attribute.id, value: undefined, page: 1 });
    }
  }

  /** Archives (or restores) the chosen value at once, with Undo. */
  protected archiveSelected(archived: boolean): void {
    const s = this.selection();
    const value = this.selectedValue();
    if (!s || s.value === undefined || !value) return;
    this.archive(
      { attribute: s.attribute, value: s.value },
      this.src(value.label),
      archived,
    );
  }

  private archive(
    target: VariantSelection,
    label: string,
    archived: boolean,
  ): void {
    if (target.value === undefined) return;
    this.save(
      setArchived(this.attributes(), target.attribute, target.value, archived),
      translated(
        archived
          ? 'editor.admin.settings.changes.archive'
          : 'editor.admin.settings.changes.restore',
        { label },
      ),
      translated(
        archived
          ? 'editor.admin.variants.done.archive'
          : 'editor.admin.variants.done.restore',
        { label },
      ),
    );
  }

  /** The decision's Archive: the value stays, archived. */
  protected archiveDecided(): void {
    const pending = this.decision();
    this.decision.set(null);
    if (!pending?.archive) return;
    const label = this.src(
      findValue(
        this.attributes(),
        pending.archive.attribute,
        pending.archive.value,
      )?.label ?? '',
    );
    this.archive(pending.archive, label, true);
  }

  /**
   * Removes the chosen value or attribute: at once, with Undo, when nothing the person can see
   * uses it (the API checks again, past their scope); else the decision opens with where it is
   * used, offering to archive a value instead.
   */
  protected async removeSelected(): Promise<void> {
    const s = this.selection();
    const a = this.selectedAttribute();
    if (!s || !a) return;
    const value = this.selectedValue();
    const label = this.src(value ? value.label : a.label);
    const read = ++this.removals;
    const usage = await this.usageOf(s);
    if (read !== this.removals || !this.editable()) return;
    // Something else was chosen meanwhile, or it is gone: nothing is removed.
    const now = this.selection();
    if (
      now?.attribute !== s.attribute ||
      now.value !== s.value ||
      !findAttribute(this.attributes(), s.attribute) ||
      (s.value !== undefined &&
        !findValue(this.attributes(), s.attribute, s.value))
    ) {
      return;
    }
    const count =
      this.counts().get(
        usageKey(
          s.value === undefined
            ? { kind: 'variantAttribute', valueId: s.attribute }
            : {
                kind: 'variantValue',
                valueId: s.value,
                parentId: s.attribute,
              },
        ),
      ) ?? null;
    const archivable =
      s.value !== undefined && !!value && !value.archived ? s : null;
    const pending: PendingRemoval = {
      request: {
        what: translated('editor.admin.settings.changes.remove', { label }),
        count,
        filter: null,
        places: usage.places,
        total: usage.total,
        canArchive: !!archivable,
        ...(usage.builds && { builds: usage.builds }),
      },
      archive: archivable,
    };
    const used =
      usage.total > 0 ||
      (usage.builds?.total ?? 0) > 0 ||
      (!!count && count.modules + count.manuals > 0);
    if (used) {
      this.decision.set(pending);
      return;
    }
    this.lastRemoval = pending;
    const attributes = this.attributes();
    const saved = this.save(
      s.value === undefined
        ? removeAttribute(attributes, s.attribute)
        : removeValue(attributes, s.attribute, s.value),
      pending.request.what,
      translated('editor.admin.variants.done.remove', { label }),
    );
    if (saved) {
      this.view.set({
        attribute: s.value === undefined ? undefined : s.attribute,
        value: undefined,
        page: 1,
      });
    }
  }

  /**
   * Where the person can see a value or attribute used: the modules and manuals naming it (the
   * first `DECISION_PLACES`) and, for a value, the builds it appears in. A read that fails counts
   * as none: the API's own usage check still refuses a removal that breaks content.
   */
  private async usageOf(s: VariantSelection): Promise<{
    places: UsagePlace[];
    total: number;
    builds?: { total: number; items: InUseBuild[] };
  }> {
    const issue =
      s.value === undefined
        ? 'unknown-variant-attribute'
        : 'unknown-variant-value';
    const [uses, builds] = await Promise.all([
      firstValueFrom(
        this.api.get('/variants/{attributeId}/usages', {
          path: { attributeId: s.attribute },
          query: {
            ...(s.value === undefined ? {} : { 'filter[value]': s.value }),
            ...pageQuery({ number: 1, size: DECISION_PLACES }),
          },
        }),
      ).catch(() => null),
      s.value === undefined
        ? Promise.resolve(null)
        : firstValueFrom(
            this.api.get('/variants/matches', {
              query: {
                when: valueCondition(s.attribute, s.value),
                ...pageQuery({ number: 1, size: DECISION_BUILDS }),
              },
            }),
          ).catch((error: unknown) => {
            // Not on the branch yet (added in this working copy): in no build.
            const e = toApiError(error);
            return e.status === 422
              ? { data: [], meta: { page: { total: 0 } } }
              : null;
          }),
    ]);
    const places: UsagePlace[] = (uses?.data ?? []).flatMap(
      (u): UsagePlace[] =>
        u.attributes.kind === 'manual'
          ? [
              {
                subject: { type: 'manual', manualId: u.attributes.manualId },
                issue,
                title: this.texts.text(u.attributes.title),
              },
            ]
          : u.attributes.languages.map((lang) => ({
              subject: {
                type: 'module' as const,
                lang,
                moduleId: (u.attributes as { moduleId: string }).moduleId,
              },
              issue,
              title: u.attributes.title,
            })),
    );
    const listed = uses?.data.length ?? 0;
    const total = (uses?.meta.page.total ?? 0) - listed + places.length;
    return {
      places,
      total,
      ...(builds && {
        builds: {
          total: builds.meta.page.total,
          items: builds.data.map((b) => ({
            manualId: b.relationships.manual.data.id,
            manualTitle: b.meta.manualTitle,
            slug: b.meta.slug,
            label: b.meta.label,
          })),
        },
      }),
    };
  }
}
