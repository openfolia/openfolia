import type { ApiPermission } from '../permissions/me';

/**
 * When a tip applies besides its screen and its anchor: to a person holding a permission (what a
 * role grants, so no role is named here), or once the person has a change set of their own.
 */
export type TipCondition =
  { readonly permission: ApiPermission } | 'after-first-change-set';

/**
 * A tip (#222): data, not code. Shown once per person, beside the element whose `data-tip`
 * attribute is its `anchor`, on its `screen` (the article ID of the screen's guide page, as its
 * route names it in `data.help`, or `*` for any screen of the shell).
 */
export interface Tip {
  /** Stable: what the person's dismissed tips remember (`GET /me/preferences`). */
  readonly id: string;
  /** The `data-tip` value of the element the tip points at. */
  readonly anchor: string;
  readonly screen: string;
  /** Translation keys, written out in full. */
  readonly title: string;
  readonly body: string;
  /** "Learn more": a page of the user guide, by article ID (through the help service). */
  readonly article?: string;
  readonly condition?: TipCondition;
}

/** Any screen in the shell. */
export const ANY_SCREEN = '*';

/** The tips, in the order they are offered. */
export const TIPS: readonly Tip[] = [
  {
    id: 'content.new-module',
    anchor: 'content.new-module',
    screen: 'guide.writing.content-browser',
    title: 'editor.tips.newModule.title',
    body: 'editor.tips.newModule.body',
    article: 'guide.writing.new-module',
    condition: { permission: 'content.edit' },
  },
  {
    id: 'module-editor.preview',
    anchor: 'module-editor.preview',
    screen: 'guide.writing.edit-a-module',
    title: 'editor.tips.preview.title',
    body: 'editor.tips.preview.body',
    article: 'guide.writing.preview',
  },
  {
    id: 'review.filters',
    anchor: 'review.filters',
    screen: 'guide.review.list',
    title: 'editor.tips.review.title',
    body: 'editor.tips.review.body',
    article: 'guide.review.workflow',
  },
  {
    id: 'shell.notifications',
    anchor: 'shell.notifications',
    screen: ANY_SCREEN,
    title: 'editor.tips.notifications.title',
    body: 'editor.tips.notifications.body',
    condition: 'after-first-change-set',
  },
];

/** A step of the first-run tour: like a tip, over the shell; no anchor centres it. */
export interface TourStep {
  readonly id: string;
  readonly anchor: string | null;
  readonly title: string;
  readonly body: string;
}

/**
 * The first-run tour (#222): content, the editor, change sets, review, then search with the
 * palette's key and `/`. A step whose anchor the person has not got (a reader has no review, a
 * narrow window no open sidebar) is left out.
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'tour.content',
    anchor: 'nav.content',
    title: 'editor.tour.content.title',
    body: 'editor.tour.content.body',
  },
  {
    id: 'tour.editor',
    anchor: null,
    title: 'editor.tour.editor.title',
    body: 'editor.tour.editor.body',
  },
  {
    id: 'tour.change-sets',
    anchor: 'shell.change-set',
    title: 'editor.tour.changeSets.title',
    body: 'editor.tour.changeSets.body',
  },
  {
    id: 'tour.review',
    anchor: 'nav.review',
    title: 'editor.tour.review.title',
    body: 'editor.tour.review.body',
  },
  {
    id: 'tour.search',
    anchor: 'shell.search',
    title: 'editor.tour.search.title',
    body: 'editor.tour.search.body',
  },
];

/** The tour's guide page, the "Learn more" of its last step. */
export const TOUR_ARTICLE = 'guide.getting-started.help-and-tour';
