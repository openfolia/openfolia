import { type Inline, plainTextOf } from '@openfolia/content-model/core';

// The terms the editor offers while typing (#247), in the document's language: an approved
// term's preferred variant completes a word typed as its start, an approved term's allowed
// variant typed in full is offered as a link to the term, and a linked term shows its
// definition. Matched without case, as the writing checks match words (NFC, lower case).
// Framework-free.

/** A term as the editor needs it: its file's fields that matter here. */
export interface HintTerm {
  readonly id: string;
  readonly status: string;
  readonly languages: Readonly<
    Record<
      string,
      {
        readonly preferred: string;
        readonly allowed?: readonly { readonly term: string }[];
        readonly definition?: readonly Inline[];
      }
    >
  >;
}

/** A term offered: which, and its preferred variant in the language. */
export interface TermOffer {
  readonly termId: string;
  readonly preferred: string;
}

/** What a linked term's popover shows. */
export interface TermInfo {
  readonly termId: string;
  readonly status: string;
  /** Its preferred variant in the language; null when it has none in it. */
  readonly preferred: string | null;
  /** Its definition as plain text; empty for none. */
  readonly definition: string;
}

/** The shortest start of a word that offers a completion. */
export const MIN_COMPLETION = 3;

export const foldTerm = (s: string): string =>
  s.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ');

/** The terms of one language, indexed for what typing offers. */
export class TermHints {
  readonly lang: string;
  /** Approved terms' preferred variants, folded and sorted, for a start's lookup. */
  private readonly preferred: { folded: string; offer: TermOffer }[] = [];
  private readonly allowed = new Map<string, TermOffer>();
  private readonly byId = new Map<string, TermInfo>();

  constructor(terms: readonly HintTerm[], lang: string) {
    this.lang = lang;
    for (const term of terms) {
      const entry = term.languages[lang];
      this.byId.set(term.id, {
        termId: term.id,
        status: term.status,
        preferred: entry?.preferred ?? null,
        definition: entry?.definition ? plainTextOf(entry.definition).text : '',
      });
      if (!entry || term.status !== 'approved') continue;
      const offer = { termId: term.id, preferred: entry.preferred };
      this.preferred.push({ folded: foldTerm(entry.preferred), offer });
      for (const variant of entry.allowed ?? []) {
        const folded = foldTerm(variant.term);
        if (!this.allowed.has(folded)) this.allowed.set(folded, offer);
      }
    }
    this.preferred.sort((a, b) =>
      a.folded < b.folded ? -1 : a.folded > b.folded ? 1 : 0,
    );
  }

  /** Whether there is anything to offer. */
  get empty(): boolean {
    return this.preferred.length === 0 && this.allowed.size === 0;
  }

  /**
   * The approved term whose preferred variant `typed` starts (without case), and is longer than:
   * the first in order of those. Null below `MIN_COMPLETION` characters.
   */
  completion(typed: string): TermOffer | null {
    const q = foldTerm(typed);
    if ([...q].length < MIN_COMPLETION) return null;
    let lo = 0;
    let hi = this.preferred.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.preferred[mid]?.folded ?? '') < q) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.preferred.length; i++) {
      const found = this.preferred[i];
      if (!found || !found.folded.startsWith(q)) return null;
      if (found.folded.length > q.length) return found.offer;
    }
    return null;
  }

  /** The approved term `phrase` is an allowed variant of (without case); null when none. */
  linkable(phrase: string): TermOffer | null {
    return this.allowed.get(foldTerm(phrase)) ?? null;
  }

  /** A term by its ID, for a link's popover; null when it is not among the terms read. */
  info(termId: string): TermInfo | null {
    return this.byId.get(termId) ?? null;
  }
}
