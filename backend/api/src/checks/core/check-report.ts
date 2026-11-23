import type { ContentCheckResult } from './actions/check-content.action.js';
import {
  categoryOf,
  countBySeverity,
  severityOf,
  type Check,
} from './check.js';

/** How the CLI check prints what it found. */
export const CHECK_REPORT_FORMATS = ['text', 'json'] as const;
export type CheckReportFormat = (typeof CHECK_REPORT_FORMATS)[number];

/** The CLI check's output and exit code: 1 when any check is blocking, else 0 (#55). */
export interface CheckReport {
  readonly output: string;
  readonly exitCode: 0 | 1;
}

/** Where a check is, as one word: `en/storage#dry`, `manual/operating`, `design/classic`. */
export function whereOf(check: Check): string {
  const { subject } = check;
  const at =
    subject.type === 'module'
      ? `${subject.lang}/${subject.moduleId}`
      : subject.type === 'manual'
        ? `manual/${subject.manualId}`
        : `design/${subject.designId}`;
  return check.blockId === undefined ? at : `${at}#${check.blockId}`;
}

/**
 * Text on one line: line breaks, other control and format characters (bidirectional overrides
 * among them, which could reorder what a CI log shows) and line or paragraph separators as spaces.
 */
const oneLine = (text: string) =>
  text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ');

/**
 * The checks as the CLI prints them: `text`, one line per check (blocking first, as the checks
 * are ordered within a subject) and a count, or `json`, one document with every check and the
 * counts. Warnings never fail it; a blocking check does.
 */
export function reportChecks(
  result: ContentCheckResult,
  format: CheckReportFormat,
): CheckReport {
  const counts = countBySeverity(result.checks);
  const exitCode = counts.blocking > 0 ? 1 : 0;
  if (format === 'json') {
    const document = {
      commit: result.commit,
      counts,
      modules: result.modules.length,
      checks: result.checks.map((check) => ({
        code: check.code,
        severity: severityOf(check),
        category: categoryOf(check),
        subject: check.subject,
        blockId: check.blockId ?? null,
        message: check.message,
        params: check.params,
        variants: check.variants,
        languages: check.languages,
      })),
    };
    return { output: `${JSON.stringify(document, null, 2)}\n`, exitCode };
  }
  const lines = result.checks.map(
    (check) =>
      `${severityOf(check) === 'blocking' ? 'blocking' : 'warning '} ${check.code} ${oneLine(whereOf(check))}: ${oneLine(check.message)}`,
  );
  lines.push(
    `${counts.blocking} blocking, ${counts.warning} warning(s) in ${result.modules.length} module(s) at ${result.commit}.`,
  );
  return { output: `${lines.join('\n')}\n`, exitCode };
}
