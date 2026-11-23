import {
  computed,
  effect,
  inject,
  Injectable,
  Injector,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import {
  ApiClient,
  pageQuery,
  ReadRef,
  toApiError,
  type ApiError,
  type Schema,
} from '../api';
import { MeService } from '../permissions/me';
import { Generation, type Live } from '../shared/generation';
import { ChangeSetMove } from './change-set-move';
import { MaintenanceLines } from './maintenance-lines';
import { ChangeSetSession } from './change-set-session';
import { injectFailureText } from './failure-text';

/** A module, manual, the configuration or a term, as the API names it. */
export type UpdateSubject = Schema<'LockSubject'>;

/** A file an update from the base could not take in by itself. */
export interface UpdateConflict {
  readonly path: string;
  /** What it is the file of; none for a file that is no module, manual, configuration or term. */
  readonly subject?: UpdateSubject;
  /**
   * Git's kinds (`contents`, `modify/delete`, …), or `working-copy`: unsaved changes to a file
   * the base changed.
   */
  readonly kinds: readonly string[];
}

/** The change set an update is about, as the screens know it. */
export interface UpdateTarget {
  readonly id: string;
  readonly title: string;
  /** The branch it is updated from (`main`). */
  readonly baseRef: string;
}

/** The conflicts of a change set's last update, until it goes through. */
export interface UpdateConflicts extends UpdateTarget {
  readonly items: readonly UpdateConflict[];
  /** How many there are in all (the list holds at most 100). */
  readonly total: number;
}

const isSubject = (value: unknown): value is UpdateSubject =>
  typeof value === 'object' &&
  value !== null &&
  ['module', 'manual', 'config', 'term', 'design'].includes(
    (value as { type?: unknown }).type as string,
  );

/** The files a 409 `refresh-unresolved` lists (`meta.unresolved`): kept, but not saved since. */
export function unresolvedOf(error: ApiError): string[] {
  const listed = error.errors[0]?.meta?.['unresolved'];
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((c: unknown) => {
    const path = (c as { path?: unknown }).path;
    return typeof path === 'string' ? [path] : [];
  });
}

/** The most reported conflicts read at once (the API keeps at most 100 per update). */
const RESOLUTIONS_PAGE = 100;

/** The conflicts a 409 `refresh-conflict` lists (`meta.conflicts`). */
export function conflictsOf(error: ApiError): UpdateConflict[] {
  const listed = error.errors[0]?.meta?.['conflicts'];
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((c: unknown): UpdateConflict[] => {
    const item = c as { path?: unknown; subject?: unknown; kinds?: unknown };
    if (typeof item.path !== 'string') return [];
    return [
      {
        path: item.path,
        ...(isSubject(item.subject) ? { subject: item.subject } : {}),
        kinds: Array.isArray(item.kinds)
          ? item.kinds.filter((k): k is string => typeof k === 'string')
          : [],
      },
    ];
  });
}

/**
 * Updating a change set from its base (#22): how far it is behind (`meta.behind` on
 * `GET /change-sets/{id}`), the update (`POST /change-sets/{id}/refresh`) and, when it conflicts,
 * the files to resolve. The conflicts stay (`conflicts`, shown by `ChangeSetConflictsComponent`)
 * while the author opens each in the editor and saves it, or chooses to keep it as it is (#437).
 * Which were saved since the conflict was reported is the API's to say
 * (`GET /change-sets/{id}/refresh-conflicts`, read whenever the list is shown); "Update again"
 * sends the saved ones as `keep` and the chosen ones as `keepMine`, and the API refuses any not
 * saved since (`refresh-unresolved`), whatever this says. Nothing is lost by an update, so it
 * asks nothing first; a choice to keep a file is undone, not confirmed. Everything it holds is the
 * person's acting now: another person (a demo switch, a sign-in) forgets it, and an update or read
 * answered after the change applies to nobody (#716).
 */
@Injectable({ providedIn: 'root' })
export class ChangeSetUpdate {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly session = inject(ChangeSetSession);
  private readonly readRef = inject(ReadRef);
  /** A base by its product version when it is a maintenance line's (#250). */
  private readonly lines = inject(MaintenanceLines);
  private readonly failureText = injectFailureText();
  private readonly injector = inject(Injector);
  private readonly me = inject(MeService).me;
  /** What was read and asked for the person acting: ended when another acts. */
  private readonly person = new Generation();

  private readonly counts = signal<
    ReadonlyMap<
      string,
      {
        readonly behind: number;
        readonly baseRef: string;
        /** Its base was rewritten past where it started (#471): no update, no merge. */
        readonly rewritten: boolean;
      }
    >
  >(new Map());
  /** Reads of a change set on their way (`check`), so two asking at once share one. */
  private readonly checking = new Map<string, Promise<void>>();
  private readonly running = signal<ReadonlySet<string>>(new Set());
  private readonly pending = signal<UpdateConflicts | null>(null);
  private readonly open = signal(false);
  private readonly lastDone = signal<{ readonly id: string } | null>(null);
  /** The paths of the pending conflicts saved since they were reported, as the API last said. */
  private readonly savedPaths = signal<ReadonlySet<string>>(new Set());
  /** The paths the author chose to keep as they are ("Keep my version"), until undone. */
  private readonly chosenPaths = signal<ReadonlySet<string>>(new Set());
  /** Whether the saved paths were read for the pending conflicts. */
  private readonly readSaved = signal(false);
  private reading = 0;

  constructor() {
    // Read before anyone was known (start-up, `/me` not answered): with the identity `/me` then
    // confirms, so theirs, as in `ChangeSetSession`.
    let acting = untracked(() => this.me().id);
    effect(() => {
      const id = this.me().id;
      untracked(() => {
        if (acting !== '' && acting !== id) this.forget();
        acting = id;
      });
    });
  }

  /**
   * A check for a read or an update started now: false once another person acts, already before
   * `forget` has run.
   */
  private forPerson(): Live {
    const joined = this.person.join();
    const who = untracked(() => this.me().id);
    return () =>
      joined() && (who === '' || untracked(() => this.me().id) === who);
  }

  /** Another person acts: nothing read or asked for the one before is kept, or lands later. */
  private forget(): void {
    this.person.end();
    this.reading++;
    this.counts.set(new Map());
    this.checking.clear();
    // An update on its way is the person before's: the next one may update the same change set.
    this.running.set(new Set());
    this.setPending(null);
  }

  /** The last update's conflicts, while unresolved. */
  readonly conflicts = this.pending.asReadonly();
  /** The conflicts are shown (the dialog). */
  readonly dialogOpen = this.open.asReadonly();
  /** Whether an update of any change set is on its way. */
  readonly anyBusy = computed(() => this.running().size > 0);
  /** The change set last updated (a new value each time): screens showing it read it again. */
  readonly done = this.lastDone.asReadonly();
  /** Whether it was read which pending conflicts were saved since (false while it is read first). */
  readonly resolutionsKnown = this.readSaved.asReadonly();
  /**
   * "Update again" can go: every listed module, manual, configuration or term was saved since
   * the conflict was reported, or is kept by choice.
   */
  readonly resolved = computed(() => {
    const pending = this.pending();
    if (!pending) return false;
    return pending.items.every(
      (c) => !c.subject || this.state(c.path) !== 'open',
    );
  });

  /** Where a listed file stands: saved since, kept by choice, or still to resolve. */
  state(path: string): 'saved' | 'chosen' | 'open' {
    if (this.chosenPaths().has(path)) return 'chosen';
    return this.savedPaths().has(path) ? 'saved' : 'open';
  }

  /** "Keep my version": keeps the file as the change set has it, dropping the base's change. */
  choose(path: string): void {
    this.chosenPaths.update((s) => new Set(s).add(path));
  }

  /** Undoes "Keep my version". */
  unchoose(path: string): void {
    this.chosenPaths.update((s) => {
      const next = new Set(s);
      next.delete(path);
      return next;
    });
  }

  /**
   * Reads which of the pending conflicts were saved since they were reported. A failure leaves
   * the last answer (the API decides at "Update again" anyway).
   */
  async readResolutions(): Promise<void> {
    const pending = this.pending();
    if (!pending) return;
    const run = ++this.reading;
    const live = this.forPerson();
    try {
      const doc = await firstValueFrom(
        this.api.get('/change-sets/{changeSetId}/refresh-conflicts', {
          path: { changeSetId: pending.id },
          query: pageQuery({ size: RESOLUTIONS_PAGE }),
        }),
      );
      if (run !== this.reading || !live() || this.pending()?.id !== pending.id)
        return;
      this.savedPaths.set(
        new Set(
          doc.data
            .filter((c) => c.attributes.savedAt !== null)
            .map((c) => c.attributes.path),
        ),
      );
    } catch {
      // The list stays as it was; showing it again reads again.
    } finally {
      if (run === this.reading) this.readSaved.set(true);
    }
  }

  /** How many commits the change set is behind its base, as last read; undefined until read. */
  behind(id: string): number | undefined {
    return this.counts().get(id)?.behind;
  }

  /** The branch the change set is updated from, as last read. */
  baseRef(id: string): string | undefined {
    return this.counts().get(id)?.baseRef;
  }

  /** An update of the change set is on its way. */
  busy(id: string): boolean {
    return this.running().has(id);
  }

  /** The change set's own unresolved conflicts, if any. */
  conflictsOf(id: string): UpdateConflicts | null {
    const pending = this.pending();
    return pending?.id === id ? pending : null;
  }

  /**
   * Whether the change set's base was rewritten past the commit it started from (#471), as last
   * read: it can then be neither updated nor merged, only moved (`ChangeSetMove`).
   */
  rewritten(id: string): boolean {
    return this.counts().get(id)?.rewritten ?? false;
  }

  /** Whether the change set was read (`know`, `check`) since it was last forgotten. */
  known(id: string): boolean {
    return this.counts().has(id);
  }

  /**
   * How far behind the change set is, and whether its base was rewritten, as a screen read it
   * (`meta.behind`, `meta.base.state`; none: not said).
   */
  know(
    id: string,
    behind: number | null | undefined,
    baseRef: string,
    rewritten = false,
  ): void {
    this.counts.update((m) => {
      const next = new Map(m);
      if (rewritten) next.set(id, { behind: 0, baseRef, rewritten });
      else if (behind === undefined || behind === null) next.delete(id);
      else next.set(id, { behind, baseRef, rewritten: false });
      return next;
    });
  }

  /**
   * Reads how far the change set is behind its base, and whether that base was rewritten. A
   * failure leaves the last answer; a read on its way is shared.
   */
  check(id: string): Promise<void> {
    const running = this.checking.get(id);
    if (running) return running;
    const live = this.forPerson();
    const read = (async () => {
      try {
        const doc = await firstValueFrom(
          this.api.get('/change-sets/{changeSetId}', {
            path: { changeSetId: id },
          }),
        );
        if (!live()) return;
        this.know(
          id,
          doc.data.meta?.behind,
          doc.data.attributes.baseRef,
          doc.data.meta?.base?.state === 'rewritten',
        );
      } catch {
        // The button stays as it was; the next check tries again.
      } finally {
        // Forgotten since (another person): a newer check of it may be on its way.
        if (live()) this.checking.delete(id);
      }
    })();
    this.checking.set(id, read);
    return read;
  }

  showConflicts(): void {
    if (!this.pending()) return;
    this.open.set(true);
    void this.readResolutions();
  }

  closeConflicts(): void {
    this.open.set(false);
  }

  /**
   * "Update again" from the conflicts: keeping each conflicting file as the author saved it
   * (`keep`), or as it is where they chose so (`keepMine`).
   */
  updateAgain(): Promise<boolean> {
    const pending = this.pending();
    if (!pending) return Promise.resolve(false);
    const chosen = this.chosenPaths();
    const keep: UpdateSubject[] = [];
    const keepMine: UpdateSubject[] = [];
    for (const c of pending.items) {
      if (c.subject) (chosen.has(c.path) ? keepMine : keep).push(c.subject);
    }
    return this.update(pending, keep, keepMine);
  }

  /**
   * Updates the change set from its base. Resolves true once it went through (the change-set
   * list is read again, and the screens reading at its branch read again: `ReadRef.moves`); a
   * conflict opens the list of files to resolve, any other refusal is a toast saying why (with a
   * retry where trying again may help).
   */
  async update(
    target: UpdateTarget,
    keep: readonly UpdateSubject[] = [],
    keepMine: readonly UpdateSubject[] = [],
  ): Promise<boolean> {
    if (this.running().has(target.id)) return false;
    this.running.update((s) => new Set(s).add(target.id));
    // Answered after another person acts: theirs is a fresh start, nothing of this is said.
    const live = this.forPerson();
    try {
      // A save on its way (the editor flushes on leaving it) is made before the update, so it is
      // never taken for a resolution of a conflict the update reports (#437).
      await this.api.putsSettled();
      const doc = await firstValueFrom(
        this.api.act(
          '/change-sets/{changeSetId}/refresh',
          { path: { changeSetId: target.id } },
          keep.length > 0 || keepMine.length > 0
            ? {
                meta: {
                  ...(keep.length > 0 ? { keep: [...keep] } : {}),
                  ...(keepMine.length > 0 ? { keepMine: [...keepMine] } : {}),
                },
              }
            : undefined,
        ),
      );
      // Its branch has a new head under the same name: screens reading at it read again (#466).
      if (doc.meta.refresh.updated) {
        this.readRef.moved(`change-sets/${target.id}`);
      }
      if (!live()) return false;
      this.counts.update((m) =>
        new Map(m).set(target.id, {
          behind: 0,
          baseRef: target.baseRef,
          rewritten: false,
        }),
      );
      if (this.pending()?.id === target.id) this.setPending(null);
      const params = {
        title: target.title,
        ref: this.lines.label(target.baseRef),
      };
      this.toast.success(
        doc.meta.refresh.updated
          ? translated('editor.changeSet.update.done', params)
          : translated('editor.changeSet.update.upToDate', params),
      );
      this.lastDone.set({ id: target.id });
      void this.session.refresh();
      return true;
    } catch (error) {
      if (!live()) return false;
      const failure = toApiError(error);
      if (failure.code === 'refresh-conflict') {
        const listed = conflictsOf(failure);
        const total = failure.errors[0]?.meta?.['total'];
        // What was kept is still to keep: a conflict listed again only lists what is left.
        const paths = new Set(listed.map((c) => c.path));
        const named = new Set(
          [...keep, ...keepMine].map((s) => JSON.stringify(s)),
        );
        const before = this.conflictsOf(target.id)?.items ?? [];
        const still = before.filter(
          (c) =>
            !paths.has(c.path) &&
            c.subject !== undefined &&
            named.has(JSON.stringify(c.subject)),
        );
        const items = [...listed, ...still];
        this.setPending({
          ...target,
          items,
          total:
            (typeof total === 'number' ? total : listed.length) + still.length,
        });
        this.open.set(true);
        void this.readResolutions();
        return false;
      }
      if (failure.code === 'base-rewritten') {
        // Rewritten since it was read (a race): said in the same words, with the way out.
        this.know(target.id, null, target.baseRef, true);
        this.offerMove(target);
        return false;
      }
      if (
        failure.code === 'refresh-unresolved' &&
        this.pending()?.id === target.id
      ) {
        // Not saved since (or the base changed them again): to save, or to keep by choice.
        const unresolved = new Set(unresolvedOf(failure));
        this.reading++; // a read on its way is older than this answer
        this.readSaved.set(true);
        this.savedPaths.update(
          (s) => new Set([...s].filter((p) => !unresolved.has(p))),
        );
        this.open.set(true);
        this.toast.error(
          this.failureText(
            translated('editor.changeSet.update.failed', {
              title: target.title,
              ref: this.lines.label(target.baseRef),
            }),
            failure,
          ),
        );
        return false;
      }
      this.toast.error(
        this.failureText(
          translated('editor.changeSet.update.failed', {
            title: target.title,
            ref: this.lines.label(target.baseRef),
          }),
          failure,
        ),
        failure.kind === 'unavailable' ||
          failure.kind === 'network' ||
          failure.code === 'database-timeout' ||
          failure.code === 'branch-moved'
          ? {
              actionLabel: translated('editor.session.retry'),
              // Another person acts now: not theirs to retry.
              onAction: () => {
                if (live()) void this.update(target, keep);
              },
            }
          : {},
      );
      return false;
    } finally {
      // Forgotten meanwhile: the set is the next person's, and may hold their own update of it.
      if (live()) {
        this.running.update((s) => {
          const next = new Set(s);
          next.delete(target.id);
          return next;
        });
      }
    }
  }

  /**
   * The refusal `base-rewritten` (of an update, or of a merge): what happened in plain words, with
   * "Move my changes" (`ChangeSetMove`).
   */
  offerMove(target: UpdateTarget, mine = true): void {
    const ref = { ref: this.lines.label(target.baseRef) };
    if (!mine) {
      // Only its author moves it (it closes the change set): said, nothing offered.
      this.toast.error(
        translated('editor.changeSet.rewritten.refusedOther', ref),
      );
      return;
    }
    this.toast.error(translated('editor.changeSet.rewritten.refused', ref), {
      actionLabel: translated('editor.changeSet.rewritten.move'),
      onAction: () => void this.injector.get(ChangeSetMove).move(target),
    });
  }

  /**
   * The conflicts to resolve now (none: resolved). A choice to keep a file stays while it is
   * still listed; which were saved is read again.
   */
  private setPending(next: UpdateConflicts | null): void {
    const same = next !== null && this.pending()?.id === next.id;
    const listed = new Set(next?.items.map((c) => c.path) ?? []);
    this.pending.set(next);
    this.chosenPaths.update((s) =>
      same ? new Set([...s].filter((p) => listed.has(p))) : new Set(),
    );
    if (!same) {
      this.savedPaths.set(new Set());
      this.readSaved.set(false);
    }
    if (!next) this.open.set(false);
  }
}
