import { z } from 'zod';
import {
  type ChangeSetAuthor,
  hasControl,
  isChangeSetId,
  newChangeSetId,
} from '../../change-sets/core/change-set.js';
import { isReleasePart } from './release-tags.js';

/**
 * A release (#40): the whole of `main` at one commit, tagged with an
 * annotated tag and tied to a product (a value of the configured product
 * facet) and a revision. Immutable: never changed, never re-created under
 * the same name. The tag is the source of truth; this record makes
 * releases listable and holds what the tag cannot be queried by.
 */
export interface Release {
  /** A UUID version 7, made by the server. */
  readonly id: string;
  /** The product: a value of `productFacet`. */
  readonly product: string;
  /** The facet the product is a value of, as configured at the release. */
  readonly productFacet: string;
  readonly revision: string;
  /** The tag's name, without `refs/tags/`: what reads take as `?ref=`. */
  readonly tag: string;
  /** The annotated tag object. */
  readonly tagObject: string;
  /** The commit tagged. */
  readonly commit: string;
  /** The publisher's summary, plain text; null when none was given. */
  readonly notes: string | null;
  /** Summaries per language (#138), by language tag; empty for none. */
  readonly notesByLanguage: Readonly<Record<string, string>>;
  /** Whether the publisher marked it a major change (#138). */
  readonly major: boolean;
  readonly publishedBy: ChangeSetAuthor;
  /** When it was tagged (the tagger date, to the second). */
  readonly publishedAt: Date;
  /** Set once it is withdrawn (#138); its tag stays. */
  readonly withdrawal: ReleaseWithdrawal | null;
}

/** What a release is cut with: everything but its tag object and withdrawal. */
export type NewRelease = Omit<Release, 'tagObject' | 'withdrawal'>;

/**
 * A release taken back (#138): who, when and why. The tag stays (tags are
 * immutable) and reads at it keep working; a withdrawn release no longer
 * counts as a module's latest release, and the changelog shows it so.
 */
export interface ReleaseWithdrawal {
  readonly by: ChangeSetAuthor;
  readonly at: Date;
  readonly reason: string;
}

/** Which releases to list; every field optional. */
export interface ReleaseFilter {
  readonly product?: string;
  /** Only major releases (true) or only the others (false). */
  readonly major?: boolean;
  /** Only withdrawn releases (true) or only those that stand (false). */
  readonly withdrawn?: boolean;
}

/** A new release ID: a UUID version 7, its first 48 bits the time. */
export const newReleaseId = newChangeSetId;
export const isReleaseId = isChangeSetId;

/** The longest release notes, in characters. */
export const MAX_NOTES = 10_000;

/**
 * The longest tag message a release's notes make, all languages together
 * (`releaseMessage`), in characters: below what Git's writer takes (64 KiB)
 * with room for the trailers.
 */
export const MAX_MESSAGE = 60_000;

/** The longest reason for withdrawing a release, in characters. */
export const MAX_REASON = 2_000;

/** A line opening a language's notes in the tag message (`releaseMessage`). */
const LANGUAGE_HEADING = /^\[notes:([^\]\n]*)\]$/m;

/**
 * A revision as a release names it: one tag-name component of
 * `A-Za-z0-9._-` (`isReleasePart`), e.g. `2.1` or `2026-03`.
 */
export const ReleaseRevision = z.string().refine(isReleasePart, {
  message:
    '1 to 100 characters of A-Za-z0-9._-, starting with a letter, digit or "_", without "..", not ending in "." or ".lock"',
});

/**
 * Release notes: plain text with line breaks, as the tag message keeps it
 * (line breaks as `\n`, trimmed), 1 to `MAX_NOTES` characters; no control
 * characters but tabs and line breaks, and no line starting with `---`
 * (git ends a message's text there).
 */
export const ReleaseNotes = z
  .string()
  .transform((text) => text.replace(/\r\n?/g, '\n').trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(MAX_NOTES)
      .refine((text) => !hasControl(text, '\n\t'), {
        message: 'no control characters but tabs and line breaks',
      })
      .refine((text) => !/^---/m.test(text), {
        message: 'no line starting with "---"',
      })
      .refine((text) => !LANGUAGE_HEADING.test(text), {
        message: 'no line of the form "[notes:<language>]"',
      }),
  );

/**
 * Why a release is withdrawn: plain text with line breaks, trimmed, 1 to
 * `MAX_REASON` characters, no control characters but tabs and line breaks.
 */
export const WithdrawalReason = z
  .string()
  .transform((text) => text.replace(/\r\n?/g, '\n').trim())
  .pipe(
    z
      .string()
      .min(1)
      .max(MAX_REASON)
      .refine((text) => !hasControl(text, '\n\t'), {
        message: 'no control characters but tabs and line breaks',
      }),
  );

/** The first line of a release's tag message. */
export const releaseTitle = (
  product: string,
  revision: string,
  major = false,
): string => `Release ${product} ${revision}${major ? ' (major)' : ''}`;

/** What a release's tag message holds besides its name. */
export interface ReleaseText {
  readonly notes: string | null;
  readonly notesByLanguage: Readonly<Record<string, string>>;
  readonly major: boolean;
}

/**
 * The tag message of a release, so the tag alone reproduces what it says:
 * its title (` (major)` for a major one), then the notes (if any), then
 * each language's notes (by language tag) after a line `[notes:<lang>]`.
 * Notes never hold such a line, nor one starting with `---`
 * (`ReleaseNotes`), so `releaseTextOf` reads it back exactly.
 */
export function releaseMessage(
  product: string,
  revision: string,
  text: ReleaseText,
): string {
  const parts = [releaseTitle(product, revision, text.major)];
  if (text.notes !== null) parts.push(text.notes);
  for (const lang of Object.keys(text.notesByLanguage).sort()) {
    parts.push(`[notes:${lang}]\n${text.notesByLanguage[lang]}`);
  }
  return parts.join('\n\n');
}

/**
 * What `releaseMessage` wrote into a release's tag message (without
 * trailers); undefined when the message is no release message of `product`
 * at `revision`.
 */
export function releaseTextOf(
  message: string,
  product: string,
  revision: string,
): ReleaseText | undefined {
  for (const major of [false, true]) {
    const title = releaseTitle(product, revision, major);
    if (message === title) return { notes: null, notesByLanguage: {}, major };
    if (!message.startsWith(`${title}\n\n`)) continue;
    const body = message.slice(title.length + 2);
    const sections = body.split(/^(?=\[notes:[^\]\n]*\]$)/m);
    const first = sections[0] ?? '';
    const notes = LANGUAGE_HEADING.test(first) ? null : first.trim() || null;
    const notesByLanguage: Record<string, string> = {};
    for (const section of notes === null ? sections : sections.slice(1)) {
      const match = /^\[notes:([^\]\n]*)\]\n/.exec(section);
      if (!match?.[1]) return undefined;
      notesByLanguage[match[1]] = section.slice(match[0].length).trim();
    }
    return { notes, notesByLanguage, major };
  }
  return undefined;
}
