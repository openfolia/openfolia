import type { Route } from '@angular/router';

/** A tab of the Reports page: a route of its own, so the address and Back keep it. */
export interface ReportTab {
  /** The tab's label and the document title (translation keys). */
  readonly label: string;
  readonly path: string;
  /** The tab's page of the user guide, by article ID (#221). */
  readonly help: string;
  readonly load: NonNullable<Route['loadComponent']>;
}

/** The Reports page's tabs, in order (#56). */
export const REPORT_TABS = [
  {
    label: 'editor.reports.tabs.translations',
    path: 'translations',
    help: 'guide.translations.reports',
    load: () =>
      import('./translation-report.page').then((m) => m.TranslationReportPage),
  },
  {
    label: 'editor.reports.tabs.usage',
    path: 'usage',
    help: 'guide.translations.reports',
    load: () => import('./usage-report.page').then((m) => m.UsageReportPage),
  },
] as const satisfies readonly [ReportTab, ...ReportTab[]];
