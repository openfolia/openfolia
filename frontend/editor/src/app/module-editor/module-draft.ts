import { computed, inject, Injectable, signal } from '@angular/core';
import type { JSONContent } from '@tiptap/core';
import {
  ConversionError,
  EditorLimitError,
  TableTooLargeEditorError,
  fromEditor,
  normalizeEditorDoc,
} from '@openfolia/content-editor-model';
import { firstValueFrom } from 'rxjs';

import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, toApiError, type ApiError, type Schema } from '../api';
import { sameJson } from '../content/module-creation';
import { injectFailureText } from '../session/failure-text';
import {
  clearDraft,
  readDraft,
  writeDraft,
  type DraftSubject,
  type LocalDraft,
} from './local-drafts';
import { refusedAssets, refusedFiles, type RefusedFile } from './refused-files';

export type ModuleContent = Schema<'Module'>;
export type ContentIssue = Schema<'Issue'>;

/** The working copy as the server last confirmed it. */
export interface SavedCopy {
  readonly content: ModuleContent;
  readonly version: number;
  readonly baseCommit: string;
}

/**
 * Where the module's text stands:
 * - `saved`: the server holds what the editor shows;
 * - `pending`: edited, saved once typing pauses;
 * - `saving`: a save is under way;
 * - `incomplete`: the text cannot be a module yet (a heading or a list item without text):
 *   kept in this browser, saved once it can be;
 * - `offline`: the server did not answer: kept in this browser, tried again;
 * - `conflict`: the module was saved elsewhere since: kept in this browser until the person
 *   reloads (never overwritten);
 * - `failed`: the server refused it: kept in this browser, saved again on Retry; or, when it
 *   refused a file the module names (`refused`), saved again by itself once no block names it
 *   any more or it was chosen again (`accepted`), never on Retry.
 */
export type DraftState =
  | 'saved'
  | 'pending'
  | 'saving'
  | 'incomplete'
  | 'offline'
  | 'conflict'
  | 'failed';

/** What the page does for the draft: read the server's version again, take the lock again. */
export interface DraftHooks {
  /** Loads the server's version, dropping the browser's: the conflict toast's action. */
  reload(): void;
  /** Takes the module's lock again (after it was lost); resolves whether it holds it now. */
  relock(): Promise<boolean>;
  /** Opens the image dialog on this image block: a refused file's toast action. */
  replaceImage?(blockId: string): void;
  /** Puts the caret at this block: a refused attachment's toast action. */
  showBlock?(blockId: string): void;
}

/** How long typing pauses before the working copy is saved. */
export const AUTOSAVE_MS = 2000;
/** How often a save point commits the working copy while the person edits. */
export const SAVE_POINT_MS = 5 * 60_000;
/** How long after a save that got no answer it is tried again. */
export const RETRY_MS = 10_000;
/** How long a change waits before the browser keeps it. */
const KEEP_MS = 300;

/** Statuses that leave a write's outcome unknown: no answer, or a gateway's. */
const UNKNOWN_OUTCOME = new Set([0, 502, 503, 504]);
/** The change set no longer holds the module's lock (released elsewhere, or taken over). */
const lockGone = (error: ApiError) =>
  error.code === 'lock-required' || error.code === 'locked';
const unknownOutcome = (error: ApiError) =>
  error.kind !== 'unknown' && UNKNOWN_OUTCOME.has(error.status);

/** The blocks a conversion error names, as the editor shows it at its block. */
export interface LocalProblem {
  /** The block it is in, or null (the module itself). */
  readonly blockId: string | null;
  /**
   * `incomplete` (a block without its text), `tooLarge` (over the editor's caps) or
   * `tableTooLarge` (a table past the content model's caps, #686: its block).
   */
  readonly kind: 'incomplete' | 'tooLarge' | 'tableTooLarge';
}

type CommitAnswer =
  Schema<'CommitDocument'> | { meta: { commit: null; head: string } };

/**
 * A module's working copy while it is edited: eager, optimistic autosave. Every edit shows at
 * once; the working copy is saved (`PUT …/working-copy`) once typing pauses, and on `flush`
 * (blur, leaving, closing the tab). A save that cannot happen now keeps the text in this browser
 * (`local-drafts.ts`), so nothing typed is lost, and says why (`state`). A save point
 * (`savePoint`: leaving the module, every few minutes) commits the working copy to the change
 * set's branch, only when something was saved since the last one, so unchanged content makes no
 * commit. A stale write (409) is never retried over the other: the person reloads.
 *
 * A save whose answer was lost may still have landed: when the next one is then refused as a
 * version conflict, the copy on the server is read, and when it holds exactly what was sent (or
 * the last saved content, after a lost save point), its version is taken and the save goes on.
 */
@Injectable()
export class ModuleDraft {
  private readonly api = inject(ApiClient);
  private readonly toast = inject(ToastService);
  private readonly failureText = injectFailureText();

  private subject: DraftSubject | null = null;
  private person = '';
  private hooks: DraftHooks | null = null;
  private saved: SavedCopy | null = null;
  /** The editor's document as last handed on (no caret gaps). */
  private doc: JSONContent | null = null;
  /** `doc` as a module, when it converts. */
  private current: ModuleContent | null = null;
  /** A save sent whose answer never came: it may be on the server. */
  private uncertain: ModuleContent | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private keepTimer: ReturnType<typeof setTimeout> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pointTimer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  private again = false;
  private committing: Promise<unknown> | null = null;
  private failureToast: number | null = null;
  private stopped = true;
  /** Counts starts and stops: a toast's action from an earlier one does nothing. */
  private generation = 0;
  /** The save point under way: another one waits for it rather than committing twice. */
  private pointRun: Promise<'committed' | 'unchanged' | 'failed'> | null = null;

  private readonly stateSignal = signal<DraftState>('saved');
  private readonly savedAtSignal = signal<Date | null>(null);
  private readonly issuesSignal = signal<readonly ContentIssue[]>([]);
  private readonly problemSignal = signal<LocalProblem | null>(null);
  private readonly keptSignal = signal(true);
  private readonly refusedSignal = signal<readonly RefusedFile[]>([]);
  private readonly failedOnFilesSignal = signal(false);
  /** Something was saved since the last save point (a working copy the branch does not hold). */
  private readonly uncommittedSignal = signal(false);
  private readonly commitsSignal = signal(0);
  /** The files the server refused (`unknown-asset`, `asset-deleted`), as `sha256:…`. */
  private refusedSet = new Set<string>();

  readonly state = this.stateSignal.asReadonly();
  /** Counts the save points this page committed: what is read per save point reads again (#247). */
  readonly commits = this.commitsSignal.asReadonly();
  /** When the working copy was last saved by this page; null before the first save. */
  readonly savedAt = this.savedAtSignal.asReadonly();
  /** The validation issues the server found in the last saved (or read) content. */
  readonly issues = this.issuesSignal.asReadonly();
  /** Why the text cannot be saved as it is, at which block; null when it can. */
  readonly problem = this.problemSignal.asReadonly();
  /** Whether the browser keeps the unsaved text (false: storage blocked or full). */
  readonly kept = this.keptSignal.asReadonly();
  /**
   * The blocks naming a file the server refused to take (a save or a save point): each is
   * uploaded again (`accepted`) or removed. Empty when none.
   */
  readonly refused = this.refusedSignal.asReadonly();
  /** `failed` because of `refused`: saved again by itself once they are dealt with. */
  readonly failedOnFiles = this.failedOnFilesSignal.asReadonly();
  /** Edits not on the server yet: leaving or closing the tab warns. */
  readonly dirty = computed(() => this.stateSignal() !== 'saved');
  /**
   * Changes no save point holds yet: a working copy saved since the last one, or edits not on
   * the server yet. False for a module just opened that nobody edited (#694).
   */
  readonly unsaved = computed(
    () => this.uncommittedSignal() || this.stateSignal() !== 'saved',
  );

  /**
   * Starts on the server's copy. Returns the document the editor opens with: the server's, or
   * the browser's unsaved one for this very copy (same version and base commit), restored.
   * A draft kept for an older copy stays where it is, and a toast offers to bring it back.
   */
  start(
    subject: DraftSubject,
    person: string,
    copy: SavedCopy,
    issues: readonly ContentIssue[],
    serverDoc: JSONContent,
    hooks: DraftHooks,
    /** Drops what this browser keeps for it (the person chose the server's version). */
    discardLocal = false,
  ): { doc: JSONContent; restored: boolean; older: LocalDraft | null } {
    this.stop();
    this.stopped = false;
    this.generation++;
    this.subject = subject;
    this.person = person;
    this.hooks = hooks;
    this.saved = copy;
    this.current = copy.content;
    this.doc = serverDoc;
    this.uncertain = null;
    this.uncommittedSignal.set(copy.version > 0);
    this.issuesSignal.set(issues);
    this.problemSignal.set(null);
    this.forgetRefused();
    this.savedAtSignal.set(null);
    this.stateSignal.set('saved');
    this.keptSignal.set(true);
    this.pointTimer = setInterval(() => void this.periodic(), SAVE_POINT_MS);

    if (discardLocal) {
      clearDraft(person, subject);
      return { doc: serverDoc, restored: false, older: null };
    }
    const stored = readDraft(person, subject);
    // What the browser kept is repaired as the editor would; one that cannot be is dropped.
    let draft: LocalDraft | null = null;
    try {
      draft = stored && {
        ...stored,
        doc: normalizeEditorDoc(stored.doc) as JSONContent,
      };
    } catch {
      clearDraft(person, subject);
    }
    if (!draft) return { doc: serverDoc, restored: false, older: null };
    if (
      draft.version === copy.version &&
      draft.baseCommit === copy.baseCommit
    ) {
      this.edit(draft.doc);
      return { doc: draft.doc, restored: true, older: null };
    }
    return { doc: serverDoc, restored: false, older: draft };
  }

  /** Whether `generation` (from `editing()`) is still the draft being edited. */
  isCurrent(generation: number): boolean {
    return !this.stopped && generation === this.generation;
  }

  /** The draft being edited now, for an action that must not reach a later one. */
  editing(): number {
    return this.generation;
  }

  /** Takes an older draft back over the server's copy (the person chose it): saved over it. */
  adopt(draft: LocalDraft): JSONContent {
    this.edit(draft.doc);
    return draft.doc;
  }

  /** Forgets what the browser keeps for this module (the person chose the saved version). */
  discardLocal(): void {
    if (this.subject) clearDraft(this.person, this.subject);
  }

  /**
   * Stops editing this module: the timers end, its toast goes, and what is pending stays in the
   * browser (unless `forget`: the person chose the server's version). Nothing is saved after.
   */
  stop(forget = false): void {
    if (forget) this.cancelKeep();
    if (this.keepPending) this.keep();
    this.stopped = true;
    this.generation++;
    for (const timer of [this.saveTimer, this.keepTimer, this.retryTimer]) {
      if (timer) clearTimeout(timer);
    }
    if (this.pointTimer) clearInterval(this.pointTimer);
    this.saveTimer = this.keepTimer = this.retryTimer = this.pointTimer = null;
    this.keepPending = false;
    this.dismissFailure();
    this.subject = null;
    this.saved = null;
    this.doc = null;
    this.current = null;
    this.uncertain = null;
    this.uncommittedSignal.set(false);
    this.lockLost = false;
    this.relocked = false;
    this.forgetRefused();
    this.stateSignal.set('saved');
    this.problemSignal.set(null);
  }

  private keepPending = false;

  /** The editor's document changed: shown at once, kept in the browser, saved once typing pauses. */
  edit(doc: JSONContent): void {
    if (!this.saved) return;
    this.doc = doc;
    const converted = this.convert(doc);
    this.current = converted;
    if (converted && this.refusedSet.size > 0) this.recheckRefused(converted);
    if (this.saved && converted && sameJson(converted, this.saved.content)) {
      // Back to what the server holds (an undo): nothing to save or keep.
      this.cancelSave();
      this.cancelKeep();
      this.discardLocal();
      this.settle();
      return;
    }
    this.scheduleKeep();
    const state = this.stateSignal();
    if (!converted) {
      this.cancelSave();
      if (state !== 'conflict' && state !== 'failed') {
        this.stateSignal.set('incomplete');
      }
      return;
    }
    // Refused or stale: kept, never sent again by itself (Retry or Reload decides).
    if (state === 'conflict' || state === 'failed') return;
    if (state === 'offline') return; // the retry timer sends the newest text
    if (state !== 'saving') this.stateSignal.set('pending');
    this.scheduleSave(AUTOSAVE_MS);
  }

  /**
   * Saves now what is pending (blur, leaving, the tab hidden). Resolves whether the server holds
   * the editor's text afterwards.
   */
  async flush(): Promise<boolean> {
    this.cancelSave();
    if (this.keepPending) this.keep();
    const state = this.stateSignal();
    if (state === 'pending' || state === 'saving') await this.save();
    return this.stateSignal() === 'saved';
  }

  /**
   * A save point: saves what is pending, then commits the working copy to the change set's
   * branch. Nothing is committed when nothing was saved since the last one. `quiet`: no toast
   * when it fails (the periodic one; the next try says so). Resolves what happened.
   */
  savePoint(quiet = false): Promise<'committed' | 'unchanged' | 'failed'> {
    if (this.pointRun) return this.pointRun;
    const run = this.commitPoint(quiet).finally(() => {
      if (this.pointRun === run) this.pointRun = null;
    });
    this.pointRun = run;
    return run;
  }

  private async commitPoint(
    quiet: boolean,
  ): Promise<'committed' | 'unchanged' | 'failed'> {
    if (!(await this.flush())) return 'failed';
    if (!this.uncommittedSignal() || !this.subject || !this.saved)
      return 'unchanged';
    const subject = this.subject;
    const run = firstValueFrom(
      this.api.post(
        '/change-sets/{changeSetId}/commits',
        {
          data: {
            type: 'Commit',
            attributes: {
              subjects: [
                {
                  type: 'module',
                  lang: subject.lang,
                  moduleId: subject.moduleId,
                },
              ],
            },
          },
        },
        { path: { changeSetId: subject.changeSetId } },
      ),
    ) as Promise<CommitAnswer>;
    this.committing = run.catch(() => undefined);
    try {
      const answer = await run;
      if (this.subject !== subject || !this.saved) return 'failed';
      // The committed working copy is gone: the next save starts over on the new commit.
      const head = 'data' in answer ? answer.data.id : answer.meta.head;
      this.saved = { ...this.saved, version: 0, baseCommit: head };
      this.uncommittedSignal.set(false);
      if ('data' in answer) this.commitsSignal.update((n) => n + 1);
      // Committed: the server took every file the module names.
      this.forgetRefused();
      // What the browser keeps now stands on the new commit: kept again on it.
      if (this.stateSignal() !== 'saved') this.keep();
      return 'data' in answer ? 'committed' : 'unchanged';
    } catch (error) {
      // Another module by now: its draft is none of this answer's business.
      if (this.subject !== subject) return 'failed';
      const failure = toApiError(error);
      const assets = refusedAssets(failure);
      if (assets && this.saved) {
        const shown = this.current ?? this.saved.content;
        // Already edited away (the block removed meanwhile): the save of that and the next save
        // point carry on, with nothing to mark or say.
        if (refusedFiles(shown.blocks, new Set(assets)).length > 0) {
          // The saved copy names a file the server does not take: marked at its blocks, and no
          // quiet save point tries it again until it is dealt with.
          this.refuse(assets, shown, !quiet);
        }
      } else if (this.isStale(failure)) {
        this.conflict();
      } else if (lockGone(failure)) {
        // Nothing waits to be saved, yet the lock went: the next edit would be refused. Taken
        // again now (or the page turns read-only), quiet or not.
        this.lostLock();
      } else if (!quiet) {
        this.dismissFailure();
        this.failureToast = this.toast.error(
          failure.code === 'invalid-working-copy'
            ? translated('editor.moduleEditor.save.commitInvalid', {
                count: failure.errors.length,
              })
            : this.failureText(
                translated('editor.moduleEditor.save.commitFailed'),
                failure,
              ),
          failure.code === 'invalid-working-copy'
            ? {}
            : {
                actionLabel: translated('editor.session.retry'),
                onAction: this.action(() => void this.savePoint()),
              },
        );
      }
      return 'failed';
    } finally {
      this.committing = null;
    }
  }

  /** Tries a refused or unanswered save again (the toast's Retry, back online). */
  async retry(): Promise<void> {
    if (!this.saved || this.stopped) return;
    const state = this.stateSignal();
    if (state === 'conflict') return;
    // A refused file goes through only once it is uploaded again or its block removed.
    if (state === 'failed' && this.failedOnFilesSignal()) return;
    if (state === 'failed' && this.lockLost) {
      const generation = this.generation;
      const held = await (this.hooks?.relock() ?? Promise.resolve(false)).catch(
        () => false,
      );
      if (!this.isCurrent(generation)) return;
      if (!held) {
        // Still not ours: said again, with the same way to try once more.
        this.dismissFailure();
        this.failureToast = this.toast.error(
          translated('editor.moduleEditor.save.lockLost'),
          {
            actionLabel: translated('editor.session.retry'),
            onAction: this.action(() => void this.retry()),
          },
        );
        return;
      }
      this.lockLost = false;
    }
    if (!this.current) {
      this.stateSignal.set('incomplete');
      return;
    }
    this.stateSignal.set('pending');
    await this.save();
  }

  private lockLost = false;
  /**
   * The lost lock was already taken again by itself since the last save went through: another
   * loss straight after waits for the person's Retry, so two tabs never take it back and forth.
   */
  private relocked = false;

  private convert(doc: JSONContent): ModuleContent | null {
    try {
      const module = fromEditor(doc) as ModuleContent;
      this.problemSignal.set(null);
      return module;
    } catch (error) {
      if (error instanceof ConversionError) {
        this.problemSignal.set({ blockId: error.blockId, kind: 'incomplete' });
      } else if (error instanceof TableTooLargeEditorError) {
        this.problemSignal.set({
          blockId: error.tableId,
          kind: 'tableTooLarge',
        });
      } else if (error instanceof EditorLimitError) {
        this.problemSignal.set({ blockId: null, kind: 'tooLarge' });
      } else {
        this.problemSignal.set({ blockId: null, kind: 'incomplete' });
      }
      return null;
    }
  }

  private scheduleSave(ms: number): void {
    this.cancelSave();
    if (this.stopped) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, ms);
  }

  private cancelSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
  }

  private scheduleKeep(): void {
    this.keepPending = true;
    if (this.keepTimer) return;
    this.keepTimer = setTimeout(() => {
      this.keepTimer = null;
      this.keep();
    }, KEEP_MS);
  }

  private cancelKeep(): void {
    if (this.keepTimer) clearTimeout(this.keepTimer);
    this.keepTimer = null;
    this.keepPending = false;
  }

  /** Keeps the editor's document in the browser, on the copy it was edited on. */
  private keep(): void {
    this.keepPending = false;
    if (!this.subject || !this.saved || !this.doc) return;
    this.keptSignal.set(
      writeDraft(this.person, this.subject, {
        doc: this.doc,
        version: this.saved.version,
        baseCommit: this.saved.baseCommit,
        at: new Date().toISOString(),
      }),
    );
  }

  /** Nothing differs from the server: saved. */
  private settle(): void {
    this.stateSignal.set('saved');
    this.failedOnFilesSignal.set(false);
    // A refusal the saved text no longer names is over (so periodic save points go on).
    if (
      this.refusedSet.size > 0 &&
      this.current &&
      refusedFiles(this.current.blocks, this.refusedSet).length === 0
    ) {
      this.forgetRefused();
    }
    this.dismissFailure();
  }

  /** One save at a time; a change while one runs is saved right after it. */
  private save(): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.saveOnce();
        } while (this.again && this.stateSignal() === 'pending');
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async saveOnce(): Promise<void> {
    if (this.committing) await this.committing;
    const subject = this.subject;
    const saved = this.saved;
    const content = this.current;
    if (!subject || !saved || this.stopped) return;
    if (!content) {
      this.stateSignal.set('incomplete');
      return;
    }
    if (sameJson(content, saved.content)) {
      this.discardLocal();
      this.settle();
      return;
    }
    this.stateSignal.set('saving');
    try {
      const answer = await this.put(subject, content, saved);
      if (this.subject !== subject) return;
      this.uncertain = null;
      this.saved = {
        content,
        version: answer.data.attributes.version,
        baseCommit: answer.data.attributes.baseCommit,
      };
      this.uncommittedSignal.set(true);
      this.relocked = false;
      this.issuesSignal.set(answer.data.meta.issues);
      this.savedAtSignal.set(new Date());
      if (this.current && sameJson(this.current, content)) {
        this.cancelKeep();
        this.discardLocal();
        this.settle();
      } else {
        // Edited while it was saved: the newer text goes next (kept in the browser meanwhile).
        this.keep();
        this.stateSignal.set(this.current ? 'pending' : 'incomplete');
        this.dismissFailure();
        if (this.current) this.again = true;
      }
    } catch (error) {
      if (this.subject !== subject) return;
      this.failed(toApiError(error), content);
    }
  }

  private async put(
    subject: DraftSubject,
    content: ModuleContent,
    saved: SavedCopy,
    recovering = false,
  ): Promise<Schema<'ModuleWorkingCopyDocument'>> {
    const path = {
      changeSetId: subject.changeSetId,
      lang: subject.lang,
      moduleId: subject.moduleId,
    };
    try {
      return await firstValueFrom(
        this.api.put(
          '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
          { path },
          {
            data: { type: 'WorkingCopy', attributes: { content } },
            meta: { version: saved.version, baseCommit: saved.baseCommit },
          },
        ),
      );
    } catch (error) {
      const failure = toApiError(error);
      if (unknownOutcome(failure) && this.subject === subject) {
        this.uncertain = content;
      }
      if (recovering || failure.code !== 'version-conflict') throw failure;
      // A save (or save point) whose answer was lost may have landed: the copy there then holds
      // exactly what was sent or last saved. Take its version and save again, once.
      const there = await firstValueFrom(
        this.api.get(
          '/change-sets/{changeSetId}/modules/{lang}/{moduleId}/working-copy',
          { path },
        ),
      ).catch(() => null);
      // Another module by now: nothing here is its business.
      if (this.subject !== subject) throw failure;
      const theirs = there?.data.attributes;
      const ours = [this.uncertain, saved.content].filter(
        (c): c is ModuleContent => c !== null,
      );
      if (!theirs || !ours.some((c) => sameJson(theirs.content, c))) {
        throw failure;
      }
      const adopted: SavedCopy = {
        content: theirs.content,
        version: theirs.version,
        baseCommit: theirs.baseCommit,
      };
      this.saved = adopted;
      this.uncertain = null;
      if (sameJson(theirs.content, content) && there) return there;
      return this.put(subject, content, adopted, true);
    }
  }

  private isStale(failure: ApiError): boolean {
    return (
      failure.code === 'version-conflict' ||
      failure.code === 'stale-working-copy' ||
      failure.code === 'working-copy-changed'
    );
  }

  private failed(failure: ApiError, content: ModuleContent): void {
    this.keep();
    if (this.isStale(failure)) {
      this.conflict();
      return;
    }
    if (unknownOutcome(failure) || failure.kind === 'network') {
      this.uncertain = content;
      this.stateSignal.set('offline');
      this.scheduleRetry();
      if (this.failureToast === null) {
        this.failureToast = this.toast.error(
          translated('editor.moduleEditor.save.offline'),
          {
            actionLabel: translated('editor.session.retry'),
            onAction: this.action(() => void this.retry()),
          },
        );
      }
      return;
    }
    const assets = refusedAssets(failure);
    if (assets) {
      this.lockLost = false;
      const refused = new Set(assets);
      const now = this.current;
      if (
        now &&
        refusedFiles(content.blocks, refused).length > 0 &&
        refusedFiles(now.blocks, refused).length === 0
      ) {
        // Edited away while it was sent: the newer text goes next.
        this.stateSignal.set('pending');
        this.scheduleSave(AUTOSAVE_MS);
        return;
      }
      // Nothing goes out while the text still names it (an autosave set up meanwhile neither).
      this.cancelSave();
      this.stateSignal.set('failed');
      this.failedOnFilesSignal.set(true);
      this.refuse(assets, now ?? content, true);
      return;
    }
    if (lockGone(failure)) {
      this.lostLock();
      return;
    }
    this.lockLost = false;
    this.stateSignal.set('failed');
    this.failedOnFilesSignal.set(false);
    this.dismissFailure();
    const retryable = ![
      'too-large',
      'invalid-body',
      'subject-mismatch',
      // #686: the module's tables past the caps; saving it again never helps.
      'table-too-large',
    ].includes(failure.code);
    this.failureToast = this.toast.error(
      this.failureText(translated('editor.moduleEditor.save.failed'), failure),
      retryable
        ? {
            actionLabel: translated('editor.session.retry'),
            onAction: this.action(() => void this.retry()),
          }
        : {},
    );
  }

  /**
   * The change set no longer holds the module's lock (released elsewhere, or taken over): what
   * is typed stays in this browser, and the lock is taken again by itself, once (`retry`). When
   * someone else holds it now, the page turns read-only (its `relock`); else the text is saved.
   * Lost again straight after, it waits for the person's Retry.
   */
  private lostLock(): void {
    // The newest text goes once the lock is back (`retry`), never before.
    this.cancelSave();
    this.lockLost = true;
    this.stateSignal.set('failed');
    this.failedOnFilesSignal.set(false);
    this.dismissFailure();
    if (!this.relocked) {
      this.relocked = true;
      void this.retry();
      return;
    }
    this.failureToast = this.toast.error(
      translated('editor.moduleEditor.save.lockLost'),
      {
        actionLabel: translated('editor.session.retry'),
        onAction: this.action(() => void this.retry()),
      },
    );
  }

  /** Saved elsewhere since: never overwritten. The text stays here until the person reloads. */
  private conflict(): void {
    this.cancelSave();
    this.stateSignal.set('conflict');
    this.dismissFailure();
    this.failureToast = this.toast.error(
      translated('editor.moduleEditor.save.conflict'),
      {
        actionLabel: translated('editor.moduleEditor.save.reload'),
        onAction: this.action(() => this.hooks?.reload()),
      },
    );
  }

  private scheduleRetry(): void {
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.stateSignal() === 'offline') void this.retry();
    }, RETRY_MS);
  }

  /** Back online: an unanswered save goes again at once. */
  online(): void {
    if (this.stateSignal() !== 'offline') return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.retry();
  }

  /** A toast's action: only for the draft it was shown for, and its toast is gone. */
  private action(run: () => void): () => void {
    const generation = this.generation;
    return () => {
      // Its own toast is gone; another one shown since stays tracked.
      if (this.isCurrent(generation)) {
        this.failureToast = null;
        run();
      }
    };
  }

  private dismissFailure(): void {
    if (this.failureToast !== null) this.toast.dismiss(this.failureToast);
    this.failureToast = null;
  }

  /**
   * A file was chosen for an image or attachment block (the image or attachment dialog, which
   * uploads it into the change set): no longer refused. Once nothing refused is left, a save
   * refused for it goes again.
   */
  accepted(asset: string): void {
    if (!this.refusedSet.delete(asset)) return;
    const files = this.current
      ? refusedFiles(this.current.blocks, this.refusedSet)
      : [];
    if (files.length > 0) this.refusedSignal.set(files);
    else this.resume();
  }

  /** The module changed: its refused files are those it still names. */
  private recheckRefused(content: ModuleContent): void {
    const files = refusedFiles(content.blocks, this.refusedSet);
    if (files.length > 0) this.refusedSignal.set(files);
    else this.resume();
  }

  /** Nothing refused is named any more: a save refused for it goes again (after a pause). */
  private resume(): void {
    const failedOnFiles = this.failedOnFilesSignal();
    this.forgetRefused();
    if (!failedOnFiles || this.stateSignal() !== 'failed') return;
    this.dismissFailure();
    if (!this.current) {
      this.stateSignal.set('incomplete');
      return;
    }
    this.stateSignal.set('pending');
    this.scheduleSave(AUTOSAVE_MS);
  }

  private forgetRefused(): void {
    this.refusedSet = new Set();
    this.refusedSignal.set([]);
    this.failedOnFilesSignal.set(false);
  }

  /**
   * The server refused files `content` names: marked at their blocks and, unless `quiet`, said
   * in a toast naming them, with a way on (the image dialog, or the block). Never Retry: the same
   * content is refused the same way.
   */
  private refuse(
    assets: readonly string[],
    content: ModuleContent,
    loud: boolean,
  ): void {
    this.refusedSet = new Set(assets);
    const files = refusedFiles(content.blocks, this.refusedSet);
    this.refusedSignal.set(files);
    if (!loud) return;
    this.dismissFailure();
    const first = files[0];
    const message =
      files.length > 1
        ? translated('editor.moduleEditor.save.refused.several', {
            count: files.length,
          })
        : !first
          ? translated('editor.moduleEditor.save.refused.other')
          : first.kind === 'attachment'
            ? translated('editor.moduleEditor.save.refused.attachment', {
                name: first.label,
              })
            : first.label
              ? translated('editor.moduleEditor.save.refused.image', {
                  name: first.label,
                })
              : translated('editor.moduleEditor.save.refused.imageUnnamed');
    const hooks = this.hooks;
    const replace =
      files.length === 1 && first?.kind === 'image' && hooks?.replaceImage;
    this.failureToast = this.toast.error(
      message,
      !first
        ? {}
        : replace
          ? {
              actionLabel: translated(
                'editor.moduleEditor.save.refused.replace',
              ),
              onAction: this.action(() => hooks.replaceImage?.(first.blockId)),
            }
          : hooks?.showBlock
            ? {
                actionLabel: translated(
                  'editor.moduleEditor.save.refused.show',
                ),
                onAction: this.action(() => hooks.showBlock?.(first.blockId)),
              }
            : {},
    );
  }

  /** Every few minutes: a quiet save point, when there is something to commit. */
  private async periodic(): Promise<void> {
    if (this.stopped || !this.uncommittedSignal()) return;
    // Refused for a file it names: tried again once the person dealt with it, never on a timer.
    if (this.refusedSet.size > 0) return;
    const state = this.stateSignal();
    if (state !== 'saved' && state !== 'pending') return;
    await this.savePoint(true);
  }
}
