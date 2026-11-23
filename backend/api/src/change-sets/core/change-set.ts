import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Where a change set is in its life: `draft` → `in-review` (submitted) →
 * `approved` → `merged`, back to `draft` when a reviewer returns it, and
 * `abandoned` from any open state (`core/workflow.ts`).
 */
export const CHANGE_SET_STATES = [
  'draft',
  'in-review',
  'approved',
  'merged',
  'abandoned',
] as const;
export const ChangeSetState = z.enum(CHANGE_SET_STATES);
export type ChangeSetState = z.infer<typeof ChangeSetState>;

/** A count of 0 for every state, to add to. */
export function noneInEachState(): Record<ChangeSetState, number> {
  return Object.fromEntries(CHANGE_SET_STATES.map((s) => [s, 0])) as Record<
    ChangeSetState,
    number
  >;
}

/** The states a change set can still be abandoned from. */
export const OPEN_STATES: readonly ChangeSetState[] = [
  'draft',
  'in-review',
  'approved',
];

/** Who started a change set: the actor's kind and ID, as the audit log names it. */
export interface ChangeSetAuthor {
  readonly kind: 'user' | 'service';
  readonly id: string;
}

/**
 * A draft of content changes on its own Git branch. The branch is named by
 * the server from the ID (`changeSetBranch`), never by the client.
 */
export interface ChangeSet {
  readonly id: string;
  readonly title: string;
  readonly description: string | null;
  readonly author: ChangeSetAuthor;
  /** The branch it started from, and will be merged back into. */
  readonly baseRef: string;
  /** The commit `baseRef` pointed to when it started. */
  readonly baseCommit: string;
  /**
   * Whether `baseCommit` was released content when it started. Only then
   * does its branch open for its author without `content.read.draft`
   * (#126): a branch started from a draft holds others' unreleased work.
   */
  readonly baseReleased: boolean;
  readonly branch: string;
  readonly state: ChangeSetState;
  /**
   * The commit of its branch submitted for review: set on submit, cleared
   * when it is returned to draft. Approvals are of this commit, and a merge
   * merges exactly it (undefined while a draft).
   */
  readonly reviewHead?: string;
  /** Where its base branch was once it was merged (the merge commit). */
  readonly mergeCommit?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Which change sets to list; every field optional. */
export interface ChangeSetFilter {
  readonly state?: ChangeSetState;
  /** The author's ID (user and service IDs never look alike). */
  readonly author?: string;
  /** The author's kind, with `author`: an actor's own change sets. */
  readonly authorKind?: ChangeSetAuthor['kind'];
}

/** Every change-set branch lies under this prefix, and nothing else does. */
export const BRANCH_PREFIX = 'change-sets/';

/** The branch of the change set `id`. */
export const changeSetBranch = (id: string): string => `${BRANCH_PREFIX}${id}`;

/**
 * A change set's ID: a UUID version 7 in its canonical lowercase form. Its
 * first 48 bits are the creation time in milliseconds, so the reconciler
 * can tell an orphaned branch from one whose change set is still being
 * recorded (`createdAtOf`).
 */
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const isChangeSetId = (value: string): boolean => UUID_V7.test(value);

/** A new change-set ID for a change set created at `now`. */
export function newChangeSetId(
  now: number = Date.now(),
  random: Uint8Array = randomBytes(10),
): string {
  if (!Number.isSafeInteger(now) || now < 0 || now >= 2 ** 48) {
    throw new RangeError(`not a time for a UUID version 7: ${now}`);
  }
  if (random.length !== 10) throw new RangeError('needs 10 random bytes');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 6; i++) {
    bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) % 256;
  }
  bytes.set(random, 6);
  bytes[6] = 0x70 | ((bytes[6] ?? 0) & 0x0f); // version 7
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f); // RFC 9562 variant
  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** When the change set `id` was created (its UUID's time), in milliseconds. */
export function createdAtOf(id: string): number | undefined {
  if (!isChangeSetId(id)) return undefined;
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/** The ID in a change-set branch's name, if it is one. */
export function idOfBranch(branch: string): string | undefined {
  if (!branch.startsWith(BRANCH_PREFIX)) return undefined;
  const id = branch.slice(BRANCH_PREFIX.length);
  return isChangeSetId(id) ? id : undefined;
}

/**
 * Whether `text` holds a control character (C0, DEL, C1) other than those
 * in `allowed`, a line or paragraph separator, or a bidirectional override
 * or isolate: Postgres cannot store U+0000, and the others make text that
 * reads differently from what it holds.
 */
export function hasControl(text: string, allowed = ''): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x2028 ||
      code === 0x2029 ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    if (control && !allowed.includes(char)) return true;
  }
  return false;
}

/** A change set's title: one line, 1 to 200 characters after trimming. */
export const ChangeSetTitle = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((s) => !hasControl(s), 'one line of text');

/** Its description: optional, up to 10,000 characters. */
export const ChangeSetDescription = z
  .string()
  .trim()
  .min(1)
  .max(10_000)
  .refine((s) => !hasControl(s, '\t\n\r'), 'no control characters');

/** Why a change set was abandoned, for the audit log. */
export const AbandonComment = ChangeSetDescription;

/** The comment on a workflow transition (submit, return, approve, …), for the audit log. */
export const TransitionComment = ChangeSetDescription;
