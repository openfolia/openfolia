import { Injectable } from '@nestjs/common';
import { termsToCsv, termsToTbx, type Term } from '@openfolia/content-model';
import type { Actor } from '../../../access/core/actor.js';
import { ActorAction } from '../../../access/core/policy.js';
import type { ReadableContent } from '../../../content/core/readable-content.js';

export const TERM_EXPORT_FORMATS = ['tbx', 'csv'] as const;
export type TermExportFormat = (typeof TERM_EXPORT_FORMATS)[number];

/** An export, ready to send. */
export interface TermExport {
  readonly body: string;
  /** The media type, with its charset. */
  readonly type: string;
  readonly fileName: string;
  /** How many terms it holds. */
  readonly count: number;
}

const TYPES: Record<TermExportFormat, string> = {
  tbx: 'application/x-tbx+xml; charset=utf-8',
  csv: 'text/csv; charset=utf-8; header=present',
};

/**
 * Every term at the snapshot's commit, by ID, as TBX-Basic or CSV
 * (`termsToTbx`, `termsToCsv` in the content model), only in `lang` when
 * given (a term without it is left out). Files that are no term are left
 * out: an export holds terms only. Every reader of the commit reads them.
 */
@Injectable()
export class ExportTermsAction extends ActorAction<
  {
    actor: Actor;
    snapshot: ReadableContent;
    format: TermExportFormat;
    lang?: string | undefined;
  },
  TermExport
> {
  readonly policy = 'content.read';

  protected async run({
    snapshot,
    format,
    lang,
  }: {
    snapshot: ReadableContent;
    format: TermExportFormat;
    lang?: string | undefined;
  }): Promise<TermExport> {
    const [listed, config] = await Promise.all([
      snapshot.terms(),
      snapshot.config(),
    ]);
    const terms: Term[] = listed.flatMap((entry) =>
      'term' in entry ? [entry.term] : [],
    );
    const langs = lang === undefined ? undefined : [lang];
    const exported =
      langs === undefined
        ? terms
        : terms.filter((term) => term.languages[lang as string] !== undefined);
    const body =
      format === 'tbx'
        ? termsToTbx(exported, {
            sourceLang: lang ?? config.languages.source,
            langs,
          })
        : termsToCsv(exported, { langs });
    return {
      body,
      type: TYPES[format],
      fileName: `terms${lang === undefined ? '' : `-${lang}`}.${format}`,
      count: exported.length,
    };
  }
}
