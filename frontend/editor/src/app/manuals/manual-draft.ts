import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
  type LocalizedText,
  sameText,
  withTextIn,
} from '@openfolia/content-model/core';

import { translated, type TranslatedText } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError, type ApiError, type Schema } from '../api';
import { UiTexts } from '../i18n';
import { MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import { injectFailureText } from '../session/failure-text';
import { toEntries, toRows, type OutlineRow } from './manual-outline';
import type { ManualSettings, SettingsPatch } from './manual-settings';
import { summarizeVariants } from './manual-variants';

type DraftManifest = Schema<'DraftManifest'>;
/** A derived manual's rule (#451): where it gathers from, what and between which modules. */
export type DerivedRule = NonNullable<DraftManifest['rule']>;
export type VariantSummary = Schema<'VariantSummary'>;
export type Issue = Schema<'Issue'>;
type Deprecation = Schema<'Deprecation'>;

/** The change set the manual is read in (and changed in, when the person may). */
export interface DraftChangeSet {
  readonly id: string;
  readonly branch: string;
  readonly state: string;
  /** Who started it; empty while unknown (the API then decides). */
  readonly authorId: string;
}

/** Whether the outline can be changed now, and if not, why (a key; null: the role never can). */
export type DraftMode =
  | { readonly kind: 'edit' }
  | { readonly kind: 'read'; readonly reason: string | null };

/** What the page shows about the manual besides its outline. */
export interface ManualInfo {
  readonly id: string;
  /** One text, or one per language (#731). */
  readonly title: LocalizedText;
  readonly variants: readonly VariantSummary[];
  /**
   * Whether its file is on the branch read. A new manual with no entries yet is only a working
   * copy (a manifest needs an entry to be committed); its variants are labelled by their values.
   */
  readonly committed: boolean;
  /** The manual is deprecated (#266): as committed, or as its working copy holds it. */
  readonly deprecated?: Deprecation | undefined;
}

/** How long the outline stays unchanged before its working copy becomes a save point. */
export const SAVE_POINT_DELAY_MS = 30_000;

/** Statuses that leave a write's outcome unknown: no answer, or a gateway's. */
const UNKNOWN_OUTCOME = new Set([0, 502, 503, 504]);

/**
 * One manual's outline as the manual builder edits it, provided per page. Reads the manual in the
 * chosen change set: its working copy when the person may change it there (a draft they
 * started, with `content.edit`, not locked by another change set), else what is committed,
 * read-only with the reason.
 *
 * Saving is eager: a change shows at once (`rows`) and is saved into the working copy (taking the
 * manual's lock first), one save at a time with the newest outline; a refusal puts back the
 * last saved outline and offers a retry. After a quiet `SAVE_POINT_DELAY_MS`, when building a
 * preview and when the page is left (`leave`), the working copy becomes a save point (a commit on the
 * change set's branch), once the outline has an entry (a manifest without one cannot be stored).
 * A manual not on the branch is read from the person's working copy (a new manual not committed
 * yet). The title is changed like the outline (`rename`). Nothing of an earlier `load` (another
 * manual, change set or person) applies after a new one, nor after `reset`.
 */
@Injectable()
export class ManualDraft {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly permissions = inject(PermissionService);
  private readonly toast = inject(ToastService);
  private readonly failureText = injectFailureText();
  private readonly texts = inject(UiTexts);

  readonly status = signal<'idle' | 'loading' | 'ready' | 'error'>('idle');
  readonly error = signal<ApiError | null>(null);
  readonly manual = signal<ManualInfo | null>(null);
  /**
   * The project's source language, as the page read it: a rename in place changes the title in
   * it (#731), and a chapter's row is named by it. Undefined until known: a title is then one text.
   */
  source: string | undefined;
  readonly rows = signal<readonly OutlineRow[]>([]);
  readonly mode = signal<DraftMode>({ kind: 'read', reason: null });
  /** The working copy's state since this page changed it; null before the first change. */
  readonly saveState = signal<'saved' | 'saving' | 'not-saved' | null>(null);
  readonly issues = signal<readonly Issue[]>([]);
  /** The manual's audience, variants and text attributes as shown (null before it is read). */
  readonly settings = signal<ManualSettings | null>(null);
  /** Counts the saves of the working copy (what a live view of it renders again after). */
  readonly revision = signal(0);
  /**
   * A derived manual's rule (#451, `kind: derived`), as shown; null for an assembled manual. Its
   * outline is what the rule gathers (`rows`), read from the API, never edited as entries.
   */
  readonly rule = signal<DerivedRule | null>(null);
  /** Whether the manual is a derived one (its rule may still be missing in a broken draft). */
  readonly derived = signal(false);
  /** What a derived manual gathers is being read again after a change of its rule. */
  readonly gathering = signal(false);
  /** Reading what a derived manual gathers failed (its last outline stays); null otherwise. */
  readonly gatherError = signal<ApiError | null>(null);

  private generation = 0;
  /** Counts the reads of what a derived manual gathers: only the newest one's answer applies. */
  private gathers = 0;
  private manualId = '';
  private changeSet: DraftChangeSet | null = null;
  private header: Omit<DraftManifest, 'entries'> | null = null;
  /** The header last saved (or read): what a refusal puts back. */
  private confirmedHeader: Omit<DraftManifest, 'entries'> | null = null;
  private version = 0;
  private baseCommit = '';
  private lockHeld = false;
  /** Saved into the working copy since the last save point. */
  private uncommitted = false;
  /** The outline last saved (or read): what a refusal puts back. */
  private confirmed: readonly OutlineRow[] = [];
  /** The newest outline not sent yet. */
  private target: readonly OutlineRow[] | null = null;
  private draining = false;
  /** Every write runs after the one before. */
  private chain: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Counts changes: a Retry offered before a newer change has nothing left to do. */
  private edits = 0;
  private destroyed = false;

  constructor() {
    // Leaving the page makes a save point first (the page's route guard, `leave`).
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      // Whatever is still running belongs to no page any more.
      this.generation++;
      clearTimeout(this.timer);
    });
  }

  /** Reads `manualId` in `changeSet` (null: the released content). Never rejects. */
  async load(
    manualId: string,
    changeSet: DraftChangeSet | null,
  ): Promise<void> {
    if (this.destroyed) return;
    const generation = ++this.generation;
    clearTimeout(this.timer);
    const same = manualId === this.manualId;
    this.manualId = manualId;
    this.changeSet = changeSet;
    this.target = null;
    this.draining = false;
    this.lockHeld = false;
    this.uncommitted = false;
    this.chain = Promise.resolve();
    this.saveState.set(null);
    this.status.set('loading');
    this.error.set(null);
    this.gathers++;
    this.gathering.set(false);
    this.gatherError.set(null);
    if (!same) {
      this.manual.set(null);
      this.rows.set([]);
      this.issues.set([]);
      this.settings.set(null);
      this.rule.set(null);
      this.derived.set(false);
    }
    const stale = () => generation !== this.generation;
    try {
      const canEdit =
        this.permissions.state({ permission: 'content.edit' }).kind !==
        'hidden';
      const reason = this.readReason(canEdit, changeSet);
      const doc = await firstValueFrom(
        this.api.get('/manuals/{id}', {
          path: { id: manualId },
          ...(changeSet ? { query: { ref: changeSet.branch } } : {}),
        }),
      ).catch((error: unknown) => {
        const failure = toApiError(error);
        // Not on the branch: a new manual may be in the person's working copy only.
        if (failure.status === 404 && reason === undefined && changeSet) {
          return null;
        }
        throw failure;
      });
      if (stale()) return;
      if (!doc) {
        await this.loadNew(manualId, changeSet as DraftChangeSet, stale);
        return;
      }
      const info: ManualInfo = {
        id: manualId,
        title: doc.data.attributes.title,
        variants: doc.data.meta.variants,
        committed: true,
        deprecated: doc.data.attributes.deprecated,
      };
      const committedSettings: ManualSettings = {
        audience: doc.data.attributes.audience,
        variants: doc.data.attributes.variants,
        attributes: doc.data.attributes.textAttributes,
        // The manifest's own design: the API names it only as the one in use (#589).
        // (Absent from an answer of an older API: then none of its own.)
        design:
          doc.data.meta.design?.source === 'manual'
            ? doc.data.meta.design.id
            : undefined,
        coverImage: doc.data.attributes.coverImage,
      };
      const committedKind = {
        derived: doc.data.attributes.kind === 'derived',
        rule: doc.data.attributes.rule ?? null,
      };
      if (reason !== undefined || !changeSet) {
        this.header = null;
        this.confirmedHeader = null;
        this.showKind(committedKind);
        this.show(
          info,
          toRows(doc.data.attributes.entries, undefined, this.source),
          {
            kind: 'read',
            reason: reason ?? null,
          },
        );
        this.settings.set(committedSettings);
        this.issues.set(doc.data.meta.issues);
        return;
      }
      const [copy, locks] = await Promise.all([
        firstValueFrom(
          this.api.get(
            '/change-sets/{changeSetId}/manuals/{manualId}/working-copy',
            { path: { changeSetId: changeSet.id, manualId } },
          ),
        ).catch((error: unknown) => {
          const failure = toApiError(error);
          // Not theirs to change (another author's): read what is committed.
          if (failure.status === 403 || failure.status === 404) return null;
          throw failure;
        }),
        firstValueFrom(
          this.api.get('/locks', {
            query: { 'filter[subject]': `manual/${manualId}` },
          }),
        ).catch(() => null),
      ]);
      if (stale()) return;
      if (!copy) {
        this.header = null;
        this.confirmedHeader = null;
        this.showKind(committedKind);
        this.show(
          info,
          toRows(doc.data.attributes.entries, undefined, this.source),
          {
            kind: 'read',
            reason: 'editor.manuals.blocked.notAuthor',
          },
        );
        this.settings.set(committedSettings);
        this.issues.set(doc.data.meta.issues);
        return;
      }
      const lock = locks?.data[0];
      const lockedElsewhere =
        !!lock && lock.relationships.changeSet.data.id !== changeSet.id;
      this.lockHeld = !!lock && !lockedElsewhere;
      const { entries, ...header } = copy.data.attributes.content;
      // A derived manual shows what its working copy's rule gathers, read before it is shown.
      const gathered =
        header.kind === 'derived'
          ? await this.readGathered(manualId, changeSet)
          : null;
      if (stale()) return;
      this.header = header;
      this.confirmedHeader = header;
      this.version = copy.data.attributes.version;
      this.baseCommit = copy.data.attributes.baseCommit;
      this.uncommitted = copy.data.meta.saved;
      this.show(
        { ...info, title: header.title },
        toRows(
          gathered?.data.attributes.entries ?? entries,
          undefined,
          this.source,
        ),
        lockedElsewhere
          ? { kind: 'read', reason: 'editor.manuals.blocked.locked' }
          : { kind: 'edit' },
      );
      // The working copy's variants, which may differ from those committed.
      this.showHeader(header);
      this.issues.set(gathered?.data.meta.issues ?? copy.data.meta.issues);
      // A working copy left from before is made a save point after a quiet while too.
      if (this.uncommitted && !lockedElsewhere) this.schedule();
    } catch (error) {
      if (stale()) return;
      this.error.set(toApiError(error));
      this.status.set('error');
    }
  }

  /** A manual not on the branch, from the person's working copy (404 when there is none either). */
  private async loadNew(
    manualId: string,
    changeSet: DraftChangeSet,
    stale: () => boolean,
  ): Promise<void> {
    const [copy, locks] = await Promise.all([
      firstValueFrom(
        this.api.get(
          '/change-sets/{changeSetId}/manuals/{manualId}/working-copy',
          { path: { changeSetId: changeSet.id, manualId } },
        ),
      ),
      firstValueFrom(
        this.api.get('/locks', {
          query: { 'filter[subject]': `manual/${manualId}` },
        }),
      ).catch(() => null),
    ]);
    if (stale()) return;
    const lock = locks?.data[0];
    const lockedElsewhere =
      !!lock && lock.relationships.changeSet.data.id !== changeSet.id;
    this.lockHeld = !!lock && !lockedElsewhere;
    const { entries, ...header } = copy.data.attributes.content;
    const gathered =
      header.kind === 'derived'
        ? await this.readGathered(manualId, changeSet)
        : null;
    if (stale()) return;
    this.header = header;
    this.confirmedHeader = header;
    this.version = copy.data.attributes.version;
    this.baseCommit = copy.data.attributes.baseCommit;
    this.uncommitted = copy.data.meta.saved;
    this.show(
      {
        id: manualId,
        title: header.title,
        variants: summarizeVariants(header.variants, null),
        committed: false,
      },
      toRows(
        gathered?.data.attributes.entries ?? entries,
        undefined,
        this.source,
      ),
      lockedElsewhere
        ? { kind: 'read', reason: 'editor.manuals.blocked.locked' }
        : { kind: 'edit' },
    );
    this.showHeader(header);
    this.issues.set(gathered?.data.meta.issues ?? copy.data.meta.issues);
    if (this.uncommitted && !lockedElsewhere) this.schedule();
  }

  /**
   * What a derived manual's working copy gathers (#669): `GET /manuals/:id` on the change set's
   * branch with its author's working copies in place of their files, so the rule as saved now
   * is gathered from the source as the change set holds it, by the API's own rules (only from a
   * source the person may see).
   */
  private readGathered(manualId: string, changeSet: DraftChangeSet) {
    return firstValueFrom(
      this.api.get('/manuals/{id}', {
        path: { id: manualId },
        query: { ref: changeSet.branch, workingCopy: 'true' },
      }),
    );
  }

  /**
   * Reads again what the derived manual gathers, after its rule was saved: the outline and the
   * issues stay (dimmed by the page) until the answer; a failure keeps them and says so.
   */
  private async regather(generation: number): Promise<void> {
    const changeSet = this.changeSet;
    if (!changeSet || generation !== this.generation) return;
    const run = ++this.gathers;
    this.gathering.set(true);
    this.gatherError.set(null);
    try {
      const doc = await this.readGathered(this.manualId, changeSet);
      if (run !== this.gathers || generation !== this.generation) return;
      const rows = toRows(doc.data.attributes.entries, undefined, this.source);
      this.confirmed = rows;
      this.rows.set(rows);
      this.issues.set(doc.data.meta.issues);
    } catch (error) {
      if (run !== this.gathers || generation !== this.generation) return;
      this.gatherError.set(toApiError(error));
    } finally {
      if (run === this.gathers) this.gathering.set(false);
    }
  }

  /** Reads again what the derived manual gathers (the preview's Retry). */
  retryGather(): void {
    if (this.derived() && this.header) void this.regather(this.generation);
  }

  /** Shows nothing: what was loaded no longer applies (the manual was deleted). */
  reset(): void {
    this.generation++;
    clearTimeout(this.timer);
    this.manualId = '';
    this.changeSet = null;
    this.header = null;
    this.confirmedHeader = null;
    this.target = null;
    this.draining = false;
    this.chain = Promise.resolve();
    this.manual.set(null);
    this.rows.set([]);
    this.issues.set([]);
    this.settings.set(null);
    this.rule.set(null);
    this.derived.set(false);
    this.gathers++;
    this.gathering.set(false);
    this.gatherError.set(null);
    this.saveState.set(null);
    this.mode.set({ kind: 'read', reason: null });
    this.status.set('idle');
  }

  /**
   * The manifest as saved once the saves queued now are done (null: none was read, or a newer
   * `load` came first); what deleting the manual keeps for its undo.
   */
  async settled(): Promise<DraftManifest | null> {
    const generation = this.generation;
    return this.enqueue(async () => {
      if (generation !== this.generation || !this.confirmedHeader) return null;
      // A derived manual's rows are gathered by its rule: never written as entries (#669).
      const entries =
        this.confirmedHeader.kind === 'derived'
          ? []
          : toEntries(this.confirmed);
      return { ...this.confirmedHeader, entries };
    });
  }

  /** Why the outline is read-only in this change set (a key), null if the role never edits, undefined if it may. */
  private readReason(
    canEdit: boolean,
    changeSet: DraftChangeSet | null,
  ): string | null | undefined {
    if (!canEdit) return null;
    if (!changeSet) return 'editor.manuals.blocked.needsChangeSet';
    if (changeSet.state !== 'draft') return 'editor.manuals.blocked.notDraft';
    if (changeSet.authorId !== '' && changeSet.authorId !== this.me.me().id) {
      return 'editor.manuals.blocked.notAuthor';
    }
    return undefined;
  }

  private show(
    info: ManualInfo,
    rows: readonly OutlineRow[],
    mode: DraftMode,
  ): void {
    this.manual.set(info);
    this.confirmed = rows;
    this.rows.set(rows);
    this.mode.set(mode);
    this.status.set('ready');
  }

  /**
   * What the draft edits now: the manual and the change set it was last loaded for. An answer
   * that comes later (an undo, a late picker) applies only while this is unchanged.
   */
  scope(): string {
    return `${this.manualId}\n${this.changeSet?.id ?? ''}`;
  }

  /**
   * Shows `next` at once and saves it into the working copy (only once it is read, to edit). A
   * derived manual's outline is what its rule gathers: never changed as entries (#669).
   */
  change(next: readonly OutlineRow[]): void {
    if (this.derived()) return;
    this.save(next);
  }

  /**
   * Changes a derived manual's rule (#451) and saves it like the outline; what it gathers is then
   * read again. Nothing for an assembled manual.
   */
  changeRule(rule: DerivedRule): void {
    if (this.destroyed || this.status() !== 'ready') return;
    if (this.mode().kind !== 'edit' || !this.header || !this.derived()) return;
    this.showHeader({ ...this.header, rule });
    this.save(this.rows());
  }

  /** Shows `next` and saves it with the header shown now. */
  private save(next: readonly OutlineRow[]): void {
    if (this.destroyed || this.status() !== 'ready') return;
    if (this.mode().kind !== 'edit' || !this.header) return;
    clearTimeout(this.timer);
    this.edits++;
    this.rows.set(next);
    this.target = next;
    this.saveState.set('saving');
    if (!this.draining) {
      this.draining = true;
      const generation = this.generation;
      void this.enqueue(() => this.drain(generation));
    }
  }

  /**
   * Changes the manual's title in the source language (one line, not empty; its other languages'
   * stay, #731) and saves it like the outline.
   */
  rename(title: string): void {
    const next = title.trim().replace(/\s+/g, ' ');
    if (!this.header || next === '') return;
    const source = this.source;
    this.setTitle(
      source ? withTextIn(this.header.title, source, source, next) : next,
    );
  }

  /** Changes the manual's title in every language (#731) and saves it like the outline. */
  setTitle(title: LocalizedText): void {
    if (this.destroyed || this.status() !== 'ready') return;
    if (this.mode().kind !== 'edit' || !this.header) return;
    if (sameText(title, this.header.title)) return;
    this.showHeader({ ...this.header, title });
    this.save(this.rows());
  }

  /**
   * Deprecates the manual (#266), or takes its deprecation back (`undefined`), and saves it like
   * the outline: it holds once the change set is merged.
   */
  deprecate(deprecated: Deprecation | undefined): void {
    if (this.destroyed || this.status() !== 'ready') return;
    if (this.mode().kind !== 'edit' || !this.header) return;
    const { deprecated: _before, ...rest } = this.header;
    this.showHeader(deprecated ? { ...rest, deprecated } : rest);
    this.save(this.rows());
  }

  /**
   * Changes the manual's audience, variants, text attributes, page design or cover images (the
   * fields `patch` names; `audience`, `design` or `coverImage` undefined clears it) and saves them like the
   * outline. A manifest keeps one variant at least: a patch leaving none is ignored.
   */
  changeSettings(patch: SettingsPatch): void {
    if (this.destroyed || this.status() !== 'ready') return;
    if (this.mode().kind !== 'edit' || !this.header) return;
    if (patch.variants && patch.variants.length === 0) return;
    const next: Omit<DraftManifest, 'entries'> = { ...this.header };
    if ('audience' in patch) {
      if (patch.audience === undefined) delete next.audience;
      else next.audience = patch.audience;
    }
    if ('design' in patch) {
      if (patch.design === undefined) delete next.design;
      else next.design = patch.design;
    }
    if ('coverImage' in patch) {
      if (patch.coverImage === undefined) delete next.coverImage;
      else next.coverImage = patch.coverImage;
    }
    if (patch.variants) next.variants = patch.variants.map((v) => ({ ...v }));
    if (patch.attributes) next.attributes = { ...patch.attributes };
    this.showHeader(next);
    this.save(this.rows());
  }

  /** Shows `header` as the manual's title and settings (the page's name, variants and panel). */
  private showHeader(header: Omit<DraftManifest, 'entries'>): void {
    this.header = header;
    this.showKind({
      derived: header.kind === 'derived',
      rule: header.rule ?? null,
    });
    const variantsChanged =
      JSON.stringify(this.manual()?.variants.map((v) => v.values)) !==
      JSON.stringify(header.variants);
    this.manual.update((m) =>
      m
        ? {
            ...m,
            title: header.title,
            deprecated: header.deprecated,
            // Labelled from the configuration by the page (the API's labels stay while unchanged).
            ...(variantsChanged
              ? { variants: summarizeVariants(header.variants, null) }
              : {}),
          }
        : m,
    );
    this.settings.set({
      audience: header.audience,
      variants: header.variants,
      attributes: header.attributes,
      design: header.design,
      coverImage: header.coverImage,
    });
  }

  private showKind(kind: { derived: boolean; rule: DerivedRule | null }): void {
    this.derived.set(kind.derived);
    this.rule.set(kind.derived ? kind.rule : null);
  }

  /** Makes the saved working copy a save point now (after the saves before it); resolves whether there is nothing left uncommitted. */
  savePoint(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.destroyed) return Promise.resolve(false);
    const generation = this.generation;
    return this.enqueue(() => this.commit(generation));
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    if (this.destroyed) return;
    this.timer = setTimeout(() => void this.savePoint(), SAVE_POINT_DELAY_MS);
  }

  private async drain(generation: number): Promise<void> {
    const stale = () => generation !== this.generation;
    const changeSet = this.changeSet;
    if (!changeSet) return;
    while (this.target && !stale()) {
      const sending = this.target;
      const header = this.header as Omit<DraftManifest, 'entries'>;
      this.target = null;
      try {
        if (!this.lockHeld) {
          await this.takeLock(changeSet);
          if (stale()) return;
          this.lockHeld = true;
        }
        const doc = await firstValueFrom(
          this.api.put(
            '/change-sets/{changeSetId}/manuals/{manualId}/working-copy',
            { path: { changeSetId: changeSet.id, manualId: this.manualId } },
            {
              data: {
                type: 'WorkingCopy',
                attributes: {
                  // A derived manual's file is its rule: its entries are gathered, never sent.
                  content: {
                    ...header,
                    entries:
                      header.kind === 'derived' ? [] : toEntries(sending),
                  },
                },
              },
              meta: { version: this.version, baseCommit: this.baseCommit },
            },
          ),
        );
        if (stale()) return;
        this.version = doc.data.attributes.version;
        this.baseCommit = doc.data.attributes.baseCommit;
        this.confirmed = sending;
        this.confirmedHeader = header;
        this.uncommitted = true;
        // A derived manual's issues are the gathering's too: read with what it gathers.
        if (header.kind === 'derived') void this.regather(generation);
        else this.issues.set(doc.data.meta.issues);
        this.revision.update((n) => n + 1);
      } catch (error) {
        if (stale()) return;
        this.draining = false;
        this.refused(sending, header, toApiError(error));
        return;
      }
    }
    if (stale()) return;
    this.draining = false;
    this.saveState.set('saved');
    this.schedule();
  }

  /** A save was refused: the last saved outline comes back, and the person is told why. */
  private refused(
    sending: readonly OutlineRow[],
    header: Omit<DraftManifest, 'entries'>,
    failure: ApiError,
  ): void {
    this.target = null;
    this.rows.set(this.confirmed);
    if (this.confirmedHeader) this.showHeader(this.confirmedHeader);
    this.saveState.set('not-saved');
    const what = translated('editor.manuals.save.failed', {
      title: this.titleText(),
    });
    // The lock was broken or released meanwhile: the next save takes it again.
    if (failure.code === 'lock-required') this.lockHeld = false;
    if (failure.code === 'locked') {
      this.mode.set({ kind: 'read', reason: 'editor.manuals.blocked.locked' });
      this.toast.error(this.failureText(what, failure));
      return;
    }
    if (
      failure.code === 'version-conflict' ||
      failure.code === 'stale-working-copy' ||
      // The save may have landed after all: the next one would not fit; read it again.
      UNKNOWN_OUTCOME.has(failure.status)
    ) {
      this.toast.error(translated('editor.manuals.save.reloaded'));
      void this.load(this.manualId, this.changeSet);
      return;
    }
    const generation = this.generation;
    const edits = this.edits;
    this.toast.error(this.failureText(what, failure), {
      actionLabel: translated('editor.session.retry'),
      onAction: () => {
        // A newer change since is saved on its own: retrying would undo it.
        if (generation === this.generation && edits === this.edits) {
          this.showHeader(header);
          this.save(sending);
        }
      },
    });
  }

  /** Takes the manual's lock for the change set (saves and save points need it). */
  private async takeLock(changeSet: DraftChangeSet): Promise<void> {
    await firstValueFrom(
      this.api.post(
        '/change-sets/{changeSetId}/locks',
        {
          data: {
            type: 'Lock',
            attributes: {
              subject: { type: 'manual', manualId: this.manualId },
            },
          },
        },
        { path: { changeSetId: changeSet.id } },
      ),
    );
  }

  private async commit(generation: number): Promise<boolean> {
    const changeSet = this.changeSet;
    if (generation !== this.generation || !changeSet) return false;
    if (!this.uncommitted) return true;
    // A manifest needs an entry to be stored: a new manual's empty one stays in the working copy
    // (a committed manual emptied is refused, and says so).
    if (
      !this.derived() &&
      this.confirmed.length === 0 &&
      this.manual()?.committed === false
    ) {
      return true;
    }
    try {
      if (!this.lockHeld) {
        await this.takeLock(changeSet);
        if (generation !== this.generation) return false;
        this.lockHeld = true;
      }
      const doc = (await firstValueFrom(
        this.api.post(
          '/change-sets/{changeSetId}/commits',
          {
            data: {
              type: 'Commit',
              attributes: {
                subjects: [{ type: 'manual', manualId: this.manualId }],
                message: `Update manual ${this.manualId}`,
              },
            },
          },
          { path: { changeSetId: changeSet.id } },
        ),
      )) as Schema<'CommitDocument'> | Schema<'NoCommitDocument'>;
      if (generation !== this.generation) return false;
      // The working copy is gone: the next save starts over on the commit.
      this.baseCommit = 'data' in doc ? doc.data.id : doc.meta.head;
      this.version = 0;
      this.uncommitted = false;
      // A new manual is on the branch from its first save point on.
      this.manual.update((m) =>
        m && !m.committed ? { ...m, committed: true } : m,
      );
      return true;
    } catch (error) {
      if (generation !== this.generation) return false;
      const failure = toApiError(error);
      if (failure.code === 'locked') {
        this.mode.set({
          kind: 'read',
          reason: 'editor.manuals.blocked.locked',
        });
        this.toast.error(this.failureText(this.savePointText(), failure));
        return false;
      }
      if (failure.code === 'lock-required') this.lockHeld = false;
      // The lock is gone (a commit takes none) or the working copy moved: read it again, which
      // shows whether the manual can still be edited here.
      if (
        failure.code === 'lock-required' ||
        failure.code === 'version-conflict' ||
        failure.code === 'stale-working-copy'
      ) {
        this.toast.error(translated('editor.manuals.save.reloaded'));
        void this.load(this.manualId, this.changeSet);
        return false;
      }
      this.toast.error(this.failureText(this.savePointText(), failure), {
        actionLabel: translated('editor.session.retry'),
        onAction: () => void this.savePoint(),
      });
      return false;
    }
  }

  /** The manual's title for a message, in the interface language (#731). */
  private titleText(): string {
    const title = this.manual()?.title;
    return title === undefined
      ? this.manualId
      : this.texts.text(title, this.source) || this.manualId;
  }

  private savePointText(): TranslatedText {
    return translated('editor.manuals.save.savePointFailed', {
      title: this.titleText(),
    });
  }
}
