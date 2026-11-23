import {
  computed,
  effect,
  inject,
  Injectable,
  signal,
  untracked,
} from '@angular/core';
import { firstValueFrom } from 'rxjs';

import {
  ToastService,
  translated,
  type ToastCloseReason,
} from '@openfolia/ui/startup';

import {
  ApiClient,
  pageQuery,
  ReadRef,
  toApiError,
  type ApiError,
  type Item,
  type Schema,
} from '../api';
import { MeService, isUnconfirmed } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import { injectFailureText } from './failure-text';
import { isChangeSetId } from './change-set-id';
import { readStored, writeStored } from './stored';

const STORAGE_KEY = 'openfolia.change-set';
/** This tab's choice of none (the released content), kept apart from "nothing stored". */
const NONE = 'none';
/** The picker's value for "no change set": the released content. */
export const PUBLISHED = 'published';
const PENDING = 'pending:';
const PAGE_SIZE = 200;
const MAX_PAGES = 10;
export const TITLE_MAX = 200;
/** The longest description the API takes. */
export const DESCRIPTION_MAX = 10_000;

export type ChangeSetState = Schema<'ChangeSetAttributes'>['state'];
/** A change set as the API answers it. */
export type ChangeSetResource = Schema<'ChangeSetResource'>;

/** The maintenance line a change set starts on (#250): its ID, and its branch for the list. */
export interface StartLine {
  readonly id: string;
  readonly branch: string;
}

/** A change set as the picker lists it. */
export interface ChangeSetOption {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly state: ChangeSetState;
  /** `change-sets/<id>`; null while it is still being started. */
  readonly branch: string | null;
  /**
   * The branch it started from and merges into: `main`, or a maintenance line's (#250; shown as
   * the line's product and version, never by this name). Null when not known (a remembered choice
   * before the list has it).
   */
  readonly baseRef: string | null;
  readonly authorId: string;
  readonly createdAt: string;
  /** Being started: the API has not answered yet. */
  readonly pending: boolean;
  /** Its branch is gone from the content repository (`meta.branchMissing`, #317). */
  readonly branchMissing: boolean;
}

interface Selected {
  readonly id: string;
  readonly title: string;
  readonly branch: string | null;
  /**
   * Who chose it (#706): a remembered choice is shown, and its title named, to that person only;
   * absent in a choice remembered before this was kept, shown to nobody until a list confirms it.
   * '' while nobody is known yet (start-up, `/me` not answered): such a choice is stored only once
   * a confirmed person makes it theirs (#716).
   */
  readonly owner?: string;
}

/** `listFor` of a list read under an identity no person confirmed: nobody's. */
const NOBODY_S_LIST = '\u0000';

/** States a change set is still worked on in; the others are done with. */
const OPEN: readonly ChangeSetState[] = ['draft', 'in-review', 'approved'];

const toOption = (item: Item<'/change-sets'>): ChangeSetOption => ({
  id: item.id,
  title: item.attributes.title,
  description: item.attributes.description,
  state: item.attributes.state,
  branch: item.attributes.branch,
  baseRef: item.attributes.baseRef,
  authorId: item.attributes.author.id,
  createdAt: item.attributes.createdAt,
  pending: false,
  branchMissing: item.meta?.branchMissing === true,
});

/**
 * Who made a choice: the person (the picker, the palette, a start), a link (the address: a link
 * opened, Back or Forward) or the session itself (a change set no longer visible dropped).
 */
export type ChoiceCause = 'person' | 'link' | 'session';

/**
 * The choice to start with: this tab's own (it survives a reload, "none" included), else the last
 * one used in any tab. The address, when it names one, decides over both (`chooseFromLink`).
 */
function readSelected(): Selected | null {
  const tab = readStored(STORAGE_KEY, 'tab');
  if (tab === NONE) return null;
  return parseSelected(tab) ?? parseSelected(readStored(STORAGE_KEY));
}

function parseSelected(raw: string | null): Selected | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      typeof (value as Selected).id === 'string' &&
      typeof (value as Selected).title === 'string' &&
      typeof (value as Selected).branch === 'string' &&
      isChangeSetId((value as Selected).id) &&
      (value as Selected).branch === `change-sets/${(value as Selected).id}`
    ) {
      const { id, title, branch, owner } = value as Selected;
      return typeof owner === 'string'
        ? { id, title, branch, owner }
        : { id, title, branch };
    }
  } catch {
    // Not ours: ignored.
  }
  return null;
}

/**
 * The change set every edit happens in, and the one reads follow. Choosing one points content
 * reads at its branch (`?ref=`, through `ReadRef`) and is remembered across a reload (local
 * storage). Starting one is eager: it is listed and chosen at once, and a refusal takes it back
 * with a toast offering a retry. A choice the signed-in person cannot see (another user, an
 * abandoned change set) is dropped, with a notice, once the list is read.
 */
@Injectable({ providedIn: 'root' })
export class ChangeSetSession {
  private readonly api = inject(ApiClient);
  private readonly me = inject(MeService);
  private readonly permissions = inject(PermissionService);
  private readonly readRef = inject(ReadRef);
  private readonly toast = inject(ToastService);
  private readonly failureText = injectFailureText();

  private readonly chosen = signal<Selected | null>(readSelected());
  private readonly items = signal<readonly ChangeSetOption[]>([]);
  /**
   * Who the list in `items` was read for (#706): nobody else is offered it. Null: none read yet.
   * A list read before anyone was known (start-up, `/me` not answered yet) is the confirmed
   * person's: it was read with the same identity.
   */
  private readonly listFor = signal<string | null>(null);
  private readonly personId = computed(() => this.me.me().id);
  /** Whether the list in `items` is the acting person's (or none was read yet). */
  private readonly listIsMine = computed(() => {
    const listFor = this.listFor();
    return listFor === null || listFor === '' || listFor === this.personId();
  });
  /**
   * The list as the person acting now may be offered it: one read for them, with what was started
   * here since. One read for another person (after a sign-in in the same tab, or before a switch
   * is answered) shows nothing but a start still on its way, until theirs is read (which a change
   * of person starts).
   */
  private readonly listed = computed(() => {
    const items = this.items();
    return this.listIsMine() ? items : items.filter((item) => item.pending);
  });
  private readonly loadState = signal<'idle' | 'loading' | 'ready' | 'error'>(
    'idle',
  );
  private readonly loadError = signal<ApiError | null>(null);
  private readonly startTitle = signal<string | null>(null);
  private runs = 0;
  /** An identity switch is unanswered: nothing is read, chosen or started for anyone meanwhile. */
  private readonly switchPending = signal(false);
  readonly switching = this.switchPending.asReadonly();
  /**
   * The choice (a change set's ID, or null for none) a list read has confirmed the person may
   * see; undefined until one has. Only that is read again after a refused switch.
   */
  private confirmedId: string | null | undefined = undefined;
  /** Counts identity switches: an answer that began under another one no longer applies. */
  private generation = 0;
  /** The generation the list in `items` was read under (-1: none read yet). */
  private listGeneration = -1;
  private pendings = 0;
  /** A change set the address names, waiting for this person's list to say whether they may see it. */
  private readonly wanted = signal<string | null>(null);
  private readonly cause = signal<ChoiceCause>('session');
  private readonly refused = signal<string | null>(null);
  /** Change sets abandoned here whose Undo is still offered, or whose abandon is on its way. */
  private readonly abandoning = signal<ReadonlySet<string>>(new Set());

  /** The open change sets the person may see, newest first, with the one being started. */
  readonly options = computed(() => {
    const hidden = this.abandoning();
    const list = this.listed().filter((item) => !hidden.has(item.id));
    const chosen = this.chosen();
    // A remembered choice is shown before the list arrives (or when it cannot be read), to whoever
    // chose it only.
    return chosen &&
      chosen.owner === this.me.me().id &&
      !list.some((item) => item.id === chosen.id)
      ? [
          {
            id: chosen.id,
            title: chosen.title,
            description: null,
            state: 'draft' as const,
            branch: chosen.branch,
            baseRef: null,
            authorId: '',
            createdAt: '',
            pending: chosen.branch === null,
            branchMissing: false,
          },
          ...list,
        ]
      : list;
  });
  /** The chosen change set as the list has it (undefined before the list has it). */
  readonly selectedOption = computed(() => {
    const chosen = this.chosen();
    return chosen
      ? this.listed().find((item) => item.id === chosen.id && !item.pending)
      : undefined;
  });
  /**
   * The chosen change set's branch is gone from the content repository (#317): the list says so,
   * or a read at it answered `change-set-branch-missing`. Screens that read at it show that in
   * place of their content; nothing recreates the branch.
   */
  readonly branchMissing = computed(() => {
    const chosen = this.chosen();
    if (!chosen?.branch) return false;
    return (
      this.readRef.missing() === chosen.branch ||
      this.selectedOption()?.branchMissing === true
    );
  });

  constructor() {
    // Another person acts now without a switch (a sign-in in the same tab after a session ended):
    // their list is read. A switch reads it itself (`endSwitch`), and a read on its way when the
    // person changed reads it again when it answers (`load`).
    effect(() => {
      const id = this.personId();
      untracked(() => {
        // Not known yet who acts (another tab's sign-in, #716): its `/me` decides, as a switch's.
        if (id === '' || isUnconfirmed(id)) return;
        this.claimChoice(id);
        // Read before `/me` answered, with the identity it confirmed: theirs. Read under another
        // (a switch begun meanwhile, an identity not confirmed yet): nobody's, read again.
        if (this.listFor() === '') {
          if (!this.switchPending() && this.me.confirmed.id === id) {
            this.listFor.set(id);
            return;
          }
          this.listFor.set(NOBODY_S_LIST);
        }
        if (
          id === '' ||
          this.listIsMine() ||
          this.switchPending() ||
          this.loadState() === 'loading'
        ) {
          return;
        }
        void this.load();
      });
    });
  }
  /**
   * The remembered choice is another person's (#706): it is dropped, so neither its title nor its
   * branch serves the person acting now. One made before anyone was known is the confirmed
   * person's, and only now stored, for this tab and the next ones (#716). While a switch is
   * unanswered nothing is decided: the next person's list decides (`load`).
   */
  private claimChoice(id: string): void {
    const chosen = this.chosen();
    if (
      !chosen ||
      chosen.owner === undefined ||
      chosen.owner === id ||
      this.switchPending()
    ) {
      return;
    }
    if (chosen.owner === '' && this.me.confirmed.id === id) {
      this.chosen.set({ ...chosen, owner: id });
      const stored = JSON.stringify(this.chosen());
      writeStored(STORAGE_KEY, stored, 'tab');
      writeStored(STORAGE_KEY, stored);
      return;
    }
    this.chosen.set(null);
    writeStored(STORAGE_KEY, NONE, 'tab');
    writeStored(STORAGE_KEY, null);
    this.apply();
  }

  /** Its branch is gone: the list says so, or (the chosen one) a read found it gone since. */
  isBranchMissing(option: ChangeSetOption): boolean {
    return (
      option.branchMissing ||
      (option.id === this.chosen()?.id && this.branchMissing())
    );
  }

  /**
   * The person may abandon the chosen change set: its author, or an admin (`admin.roles`,
   * reading drafts) once its branch is gone, as the API allows; `content.edit` either way.
   */
  readonly abandonable = computed(() => {
    const option = this.selectedOption();
    if (!option || this.switchPending() || !OPEN.includes(option.state)) {
      return false;
    }
    const may = (
      permission: 'content.edit' | 'admin.roles' | 'content.read.draft',
    ) => this.permissions.state({ permission }).kind === 'enabled';
    if (!may('content.edit')) return false;
    if (option.authorId === this.me.me().id) return true;
    return (
      this.branchMissing() && may('admin.roles') && may('content.read.draft')
    );
  });
  readonly status = this.loadState.asReadonly();
  readonly error = this.loadError.asReadonly();
  /** The title being started, while the API has not answered. */
  readonly starting = this.startTitle.asReadonly();
  /** The picker's value: a change set's ID, or `PUBLISHED`. */
  readonly value = computed(() => this.chosen()?.id ?? PUBLISHED);
  readonly selected = this.chosen.asReadonly();
  /**
   * The chosen change set's ID once the API has made it: null for none and while it is being
   * started, so its placeholder's ID (`pending:<n>`) never reaches a request (#467).
   */
  readonly startedId = computed(() => {
    const chosen = this.chosen();
    return chosen?.branch ? chosen.id : null;
  });
  /** Who made the current choice. */
  readonly chosenBy = this.cause.asReadonly();
  /** A change set from the address is waiting for the list: the choice may still change. */
  readonly resolving = computed(() => this.wanted() !== null);
  /**
   * The change set a link named that the person may not see (none was chosen in its place), until
   * `forgetRefused`: the address drops it rather than asking again.
   */
  readonly refusedLink = this.refused.asReadonly();

  forgetRefused(): void {
    this.refused.set(null);
  }

  /**
   * Reads follow the remembered choice only once the list has confirmed the person may see it
   * (`refresh`), and not while an identity switch is unanswered (`beginSwitch`).
   */
  private apply(): void {
    const ref = this.chosen()?.branch ?? undefined;
    if (this.readRef.ref() !== ref) this.readRef.missing.set(undefined);
    this.readRef.ref.set(ref);
  }

  /** An identity switch begins: the previous person's branch is no longer read, answers in flight are stale. */
  beginSwitch(): void {
    this.switchPending.set(true);
    this.refused.set(null);
    this.generation++;
    this.runs++;
    this.readRef.ref.set(undefined);
  }

  /**
   * The switch is answered. Refused: the previous person (and so their choice) is back, read
   * again at once; confirmed: the new person's list decides what they may read.
   */
  endSwitch(refused: boolean): Promise<boolean> {
    this.switchPending.set(false);
    this.refused.set(null);
    this.generation++;
    // A confirmed switch is a new person: what a list confirmed for the previous one is void.
    if (!refused) this.confirmedId = undefined;
    // Back to the previous person: their choice is read again only if a list had confirmed it.
    if (refused && (this.chosen()?.id ?? null) === this.confirmedId) {
      this.apply();
    }
    return this.load();
  }

  /**
   * Reads the change sets of whoever is acting. Never rejects: the failure is `error`. Does
   * nothing (false) while an identity switch is unanswered: the list would be the previous person's.
   */
  refresh(): Promise<boolean> {
    return this.switchPending() ? Promise.resolve(false) : this.load();
  }

  private async load(): Promise<boolean> {
    const run = ++this.runs;
    const who = untracked(() => this.me.me().id);
    const now = () => untracked(() => this.me.me().id);
    // Read for the person before the one acting now: kept for nobody, nothing is decided by it,
    // and the list is read again for the one acting now. One read before anyone was known is
    // theirs (the same identity read `/me`).
    const forOther = () => who !== '' && who !== now();
    this.loadState.set('loading');
    this.loadError.set(null);
    try {
      const all: ChangeSetOption[] = [];
      for (let number = 1; number <= MAX_PAGES; number++) {
        const page = await firstValueFrom(
          this.api.get('/change-sets', {
            query: pageQuery({ number, size: PAGE_SIZE }),
          }),
        );
        all.push(...page.data.map(toOption));
        if (number >= page.meta.page.lastPage) break;
      }
      if (run !== this.runs) return false;
      if (forOther()) return this.load();
      const open = all.filter((item) => OPEN.includes(item.state));
      this.items.update((list) => [
        ...list.filter((item) => item.pending),
        ...open,
      ]);
      this.listFor.set(now());
      this.loadState.set('ready');
      this.listGeneration = this.generation;
      // A branch a read found gone that this list shows as there again (restored) is read again.
      const missing = this.readRef.missing();
      if (
        missing !== undefined &&
        open.some((item) => item.branch === missing && !item.branchMissing)
      ) {
        this.readRef.missing.set(undefined);
      }
      // The address's change set: chosen only now that this person's list says they may see it.
      const wanted = this.wanted();
      if (wanted !== null) this.resolveLink(wanted);
      const chosen = this.chosen();
      if (
        chosen &&
        chosen.branch !== null &&
        !open.some((item) => item.id === chosen.id)
      ) {
        this.choose(null, 'session');
        // Another person's remembered choice goes without a word: its title is not theirs to read.
        if (chosen.owner === now()) {
          this.toast.show(
            translated('editor.changeSet.gone', { title: chosen.title }),
            { kind: 'info' },
          );
        }
      }
      // In this person's list: theirs to come back to (a switch to them, say).
      const kept = this.chosen();
      if (
        kept &&
        kept.branch !== null &&
        kept.owner !== now() &&
        now() !== ''
      ) {
        this.chosen.set({ ...kept, owner: now() });
        writeStored(STORAGE_KEY, JSON.stringify(this.chosen()), 'tab');
      }
      this.confirmedId = this.chosen()?.id ?? null;
      this.apply();
      return true;
    } catch (error) {
      if (run !== this.runs) return false;
      if (forOther()) return this.load();
      this.loadError.set(toApiError(error));
      this.loadState.set('error');
      // No list says whether this person may see the choice kept across a switch: one that is
      // another person's goes (#716).
      const id = now();
      if (id !== '') this.claimChoice(id);
      return false;
    }
  }

  /**
   * Chooses a change set (or `PUBLISHED` / null for none): reads follow its branch at once. The
   * person's choice (the default cause) also becomes the last used one, for new tabs; every choice
   * is this tab's, kept across a reload.
   */
  choose(id: string | null, cause: ChoiceCause = 'person'): void {
    if (this.switchPending()) return;
    // The person decided: a change set the address named is no longer waited for.
    if (cause === 'person') this.wanted.set(null);
    const item =
      id === null || id === PUBLISHED
        ? null
        : this.options().find((option) => option.id === id);
    if (item === undefined || item?.pending) return;
    const chosen: Selected | null = item
      ? {
          id: item.id,
          title: item.title,
          branch: item.branch,
          owner: untracked(() => this.me.me().id),
        }
      : null;
    this.chosen.set(chosen);
    this.cause.set(cause);
    const stored = chosen ? JSON.stringify(chosen) : null;
    // Made before anyone was known: kept here, stored once a person is confirmed; nothing is
    // stored while another tab's sign-in is unconfirmed here (#716).
    if (chosen?.owner !== '' && !isUnconfirmed(untracked(this.personId))) {
      writeStored(STORAGE_KEY, stored ?? NONE, 'tab');
      // A link that did not open (none chosen in its place) is not what the person last used.
      if (cause === 'person' || cause === 'session' || chosen !== null) {
        writeStored(STORAGE_KEY, stored);
      }
    }
    // Picked from the list the person was shown: confirmed. (A remembered choice shown before
    // the list arrived is not in `items`.)
    if (
      id === null ||
      id === PUBLISHED ||
      this.items().some((i) => i.id === id)
    ) {
      this.confirmedId = chosen?.id ?? null;
    }
    this.apply();
  }

  /**
   * The address names this change set (`?cs=`; null: none, as Back to an entry without one). It
   * is chosen only from a list read for whoever is acting now, never from one read before an
   * identity switch: at once when that list is here, else when it arrives. One the person may not
   * see (another's, abandoned, merged, unknown) chooses none, with a notice.
   */
  chooseFromLink(id: string | null): void {
    if (id === null) {
      this.wanted.set(null);
      if (!this.switchPending()) this.choose(null, 'link');
      return;
    }
    // Already chosen, by the person acting now: nothing to wait for. Another person's choice of
    // the same change set waits for this person's list like any link (#716).
    const chosen = this.chosen();
    if (
      chosen?.id === id &&
      chosen.branch !== null &&
      !this.switchPending() &&
      chosen.owner === this.personId()
    ) {
      this.wanted.set(null);
      return;
    }
    const listed =
      !this.switchPending() &&
      this.loadState() === 'ready' &&
      this.listGeneration === this.generation &&
      this.listIsMine();
    if (listed) this.resolveLink(id);
    else this.wanted.set(id);
  }

  private resolveLink(id: string): void {
    this.wanted.set(null);
    if (this.listed().some((item) => item.id === id && !item.pending)) {
      this.choose(id, 'link');
      return;
    }
    this.choose(null, 'link');
    this.refused.set(id);
    this.toast.show(translated('editor.changeSet.notFound'), { kind: 'info' });
  }

  /**
   * The change set `fromId` was superseded by `next`, just made by the API (#471: its changes
   * moved onto the current main): `next` joins the list at once and, when `fromId` was chosen, is
   * chosen in its place (as the session's choice, not dropped with a notice once the list is read
   * again without the old one). Then the list is read again.
   */
  supersede(fromId: string, next: ChangeSetResource): Promise<boolean> {
    const option = toOption(next);
    this.items.update((list) => [
      ...list.filter((item) => item.id !== fromId && item.id !== option.id),
      option,
    ]);
    if (this.chosen()?.id === fromId) this.choose(option.id, 'session');
    return this.refresh();
  }

  /**
   * Starts a change set with this title and chooses it, on `main` or, given one, on a maintenance
   * line (#250: fixing an older product version; it merges back into the line). It shows up chosen
   * at once; its branch only becomes the reads' once the API has made it. A refusal takes it back
   * and offers a retry. Resolves the started change set's ID (chosen unless the person chose
   * another meanwhile), or null when it was not started (or another person acts now).
   */
  async start(
    rawTitle: string,
    line?: StartLine | null,
  ): Promise<string | null> {
    const title = rawTitle.trim();
    if (
      !title ||
      title.length > TITLE_MAX ||
      this.startTitle() !== null ||
      this.switchPending()
    ) {
      return null;
    }
    this.wanted.set(null);
    const temporary = `${PENDING}${++this.pendings}`;
    const previous = this.chosen();
    const actor = this.me.me().id;
    const generation = this.generation;
    // What this person had before the first attempt: a retry tells a lost answer's change set
    // from the older ones by this, never by a clock.
    const before = new Set(
      this.items()
        .filter((item) => !item.pending)
        .map((item) => item.id),
    );
    this.startTitle.set(title);
    this.items.update((list) => [
      {
        id: temporary,
        title,
        description: null,
        state: 'draft',
        branch: null,
        baseRef: line?.branch ?? null,
        authorId: actor,
        createdAt: '',
        pending: true,
        branchMissing: false,
      },
      ...list,
    ]);
    this.chosen.set({ id: temporary, title, branch: null, owner: actor });
    // Another person acts now (a switch, or a sign-in in the same tab): nothing of this answer
    // applies to them, nor is its title named to them (#716). Started before anyone was known:
    // with the identity `/me` then confirms.
    const stale = () =>
      this.generation !== generation ||
      (actor !== '' && untracked(() => this.me.me().id) !== actor);
    try {
      const doc = await firstValueFrom(
        this.api.post('/change-sets', {
          data: {
            type: 'ChangeSet',
            attributes: {
              title,
              ...(line ? { maintenanceLine: line.id } : {}),
            },
          },
        }),
      );
      const created = toOption(doc.data);
      const isStale = stale();
      this.items.update((list) => [
        ...(isStale ? [] : [created]),
        ...list.filter(
          (item) => item.id !== temporary && item.id !== created.id,
        ),
      ]);
      // Someone chose another meanwhile: that choice stands.
      if (this.chosen()?.id === temporary) {
        if (isStale) this.chosen.set(previous);
        else this.choose(created.id);
      }
      // Under another identity the list is the one to ask: it has it, or not.
      if (isStale && !this.switchPending()) void this.refresh();
      if (!isStale) {
        this.toast.success(translated('editor.changeSet.started', { title }));
      }
      return isStale ? null : created.id;
    } catch (error) {
      this.items.update((list) => list.filter((item) => item.id !== temporary));
      if (this.chosen()?.id === temporary) this.chosen.set(previous);
      if (stale()) return null;
      const failure = toApiError(error);
      this.toast.error(
        this.failureText(
          translated('editor.changeSet.startFailed', { title }),
          failure,
        ),
        {
          actionLabel: translated('editor.session.retry'),
          onAction: () => {
            if (!stale())
              void this.retryStart(title, actor, before, failure, line);
          },
        },
      );
      return null;
    } finally {
      this.startTitle.set(null);
    }
  }

  /**
   * Renames a change set (its title and description; null clears the description). The picker
   * shows the new title at once; a refusal puts the old one back, with a toast offering a retry.
   * Resolves the change set as the API now has it, or null when it was refused.
   */
  async rename(
    id: string,
    change: { readonly title: string; readonly description: string | null },
    /** Told of the change set renamed, by a retry from the toast too. */
    onRenamed?: (renamed: ChangeSetResource) => void,
  ): Promise<ChangeSetResource | null> {
    const title = change.title.trim();
    if (!title || title.length > TITLE_MAX) return null;
    const before = this.items().find((item) => item.id === id);
    const chosenBefore = this.chosen();
    const show = (shown: { title: string; description: string | null }) => {
      this.items.update((list) =>
        list.map((item) => (item.id === id ? { ...item, ...shown } : item)),
      );
      const chosen = this.chosen();
      if (chosen?.id === id && chosen.title !== shown.title) {
        this.chosen.set({ ...chosen, title: shown.title });
        // Kept across a reload under its new name.
        writeStored(STORAGE_KEY, JSON.stringify(this.chosen()), 'tab');
      }
    };
    show({ title, description: change.description });
    let doc: { data: ChangeSetResource };
    try {
      doc = await firstValueFrom(
        this.api.patch(
          '/change-sets/{changeSetId}',
          { path: { changeSetId: id } },
          {
            data: {
              type: 'ChangeSet',
              id,
              attributes: { title, description: change.description },
            },
          },
        ),
      );
    } catch (error) {
      if (before) {
        show({ title: before.title, description: before.description });
      } else if (chosenBefore?.id === id) {
        show({ title: chosenBefore.title, description: null });
      }
      const failure = toApiError(error);
      this.toast.error(
        this.failureText(
          translated('editor.changeSet.renameFailed', {
            title: before?.title ?? chosenBefore?.title ?? title,
          }),
          failure,
        ),
        failure.kind === 'unavailable' ||
          failure.kind === 'network' ||
          failure.code === 'database-timeout'
          ? {
              actionLabel: translated('editor.session.retry'),
              onAction: () => void this.rename(id, change, onRenamed),
            }
          : {},
      );
      return null;
    }
    show({
      title: doc.data.attributes.title,
      description: doc.data.attributes.description,
    });
    // Outside the try: a caller's own failure is no failed rename.
    onRenamed?.(doc.data);
    return doc.data;
  }

  /**
   * Abandons a change set, Undo instead of a confirm: it leaves the list at once (and the reads,
   * when it is the chosen one: back to the published content), and a toast offers Undo. The
   * request (`POST /change-sets/{id}/abandon`) is sent only once the toast ends (its time ran
   * out, or it was closed), and only while the same person acts. Undo keeps it and chooses it
   * again. A refusal brings it back into the list, with a toast saying why.
   */
  abandon(id: string): void {
    if (this.switchPending() || this.abandoning().has(id)) return;
    const item = this.items().find((i) => i.id === id && !i.pending);
    if (!item) return;
    const person = this.me.me().id;
    const wasChosen = this.chosen()?.id === id;
    this.abandoning.update((set) => new Set(set).add(id));
    if (wasChosen) this.choose(null);
    this.toast.success(
      translated('editor.changeSet.abandoned', { title: item.title }),
      {
        actionLabel: translated('ui.toast.undo'),
        onAction: () => {
          this.keep(id);
          if (wasChosen && this.chosen() === null && !this.switchPending()) {
            this.choose(id);
          }
        },
        onClose: (reason: ToastCloseReason) => {
          if (reason === 'action') return;
          void this.sendAbandon(item, person);
        },
      },
    );
  }

  private keep(id: string): void {
    this.abandoning.update((set) => {
      const next = new Set(set);
      next.delete(id);
      return next;
    });
  }

  private async sendAbandon(
    item: ChangeSetOption,
    person: string,
  ): Promise<void> {
    // Someone else acts now, or a switch is unanswered: not theirs to abandon; it stays.
    // (A refused switch keeps the same person, so their abandon still goes.)
    if (this.switchPending() || this.me.me().id !== person) {
      this.keep(item.id);
      return;
    }
    try {
      await firstValueFrom(
        this.api.act('/change-sets/{changeSetId}/abandon', {
          path: { changeSetId: item.id },
        }),
      );
      this.items.update((list) => list.filter((i) => i.id !== item.id));
      this.keep(item.id);
    } catch (error) {
      this.keep(item.id);
      this.toast.error(
        this.failureText(
          translated('editor.changeSet.abandonFailed', { title: item.title }),
          toApiError(error),
        ),
      );
      // It may have moved on meanwhile (merged, abandoned elsewhere): the list says where.
      void this.refresh();
    }
  }

  /**
   * The retry of a start. When the answer may have been lost (no answer, a server error, a
   * timeout) the change set may exist anyway: read the list and look for a new one of this title
   * first, and ask again only when the list could be read and has none, so a retry never starts a
   * second one.
   */
  private async retryStart(
    title: string,
    actor: string,
    before: ReadonlySet<string>,
    failure: ApiError,
    line?: StartLine | null,
  ): Promise<void> {
    const generation = this.generation;
    // Another person acts now (or a switch is unanswered): nothing of this retry applies.
    const stale = () =>
      this.generation !== generation ||
      this.switchPending() ||
      (actor !== '' && untracked(() => this.me.me().id) !== actor);
    if (stale()) return;
    const ambiguous =
      failure.status === 0 || failure.status >= 500 || failure.status === 408;
    if (ambiguous) {
      const read = await this.refresh();
      if (stale()) return;
      if (!read) {
        this.toast.error(
          this.failureText(
            translated('editor.changeSet.startFailed', { title }),
            this.loadError() ?? failure,
          ),
          {
            actionLabel: translated('editor.session.retry'),
            onAction: () =>
              void this.retryStart(title, actor, before, failure, line),
          },
        );
        return;
      }
      const mine = this.items().find(
        (item) =>
          !item.pending &&
          item.title === title &&
          item.authorId === actor &&
          (!line || item.baseRef === line.branch) &&
          !before.has(item.id),
      );
      if (mine) {
        this.choose(mine.id);
        this.toast.success(translated('editor.changeSet.started', { title }));
        return;
      }
    }
    await this.start(title, line);
  }

  /**
   * A change set the API just made for this person elsewhere (#250: a fix carried forward to
   * `main`) joins the list and is chosen, as the person's choice. Then the list is read again.
   */
  adopt(made: ChangeSetResource): Promise<boolean> {
    if (this.switchPending()) return Promise.resolve(false);
    const option = toOption(made);
    this.items.update((list) => [
      option,
      ...list.filter((item) => item.id !== option.id),
    ]);
    this.choose(option.id);
    return this.refresh();
  }
}
