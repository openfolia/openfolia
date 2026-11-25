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

/** The variant block's header, where its tip points (#892). */
export const VARIANT_TIP_ANCHOR = 'module-editor.variant';

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
  // Where the idea is in use: the first variant block on screen, for a person who may edit it.
  {
    id: VARIANT_TIP_ANCHOR,
    anchor: VARIANT_TIP_ANCHOR,
    screen: 'guide.writing.edit-a-module',
    title: 'editor.tips.variant.title',
    body: 'editor.tips.variant.body',
    article: 'guide.variants.variant-blocks',
    condition: { permission: 'content.edit' },
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
  // Search, once the person knows their way: the tour's Done names its key too (#869).
  {
    id: 'shell.search',
    anchor: 'shell.search',
    screen: ANY_SCREEN,
    title: 'editor.tips.search.title',
    body: 'editor.tips.search.body',
    article: 'guide.getting-started.search',
  },
];

/**
 * What a task step asks the person to do (#869), and what its main button does for someone who
 * would rather not reach for it: `open` follows the link of the lit row, `type` puts the caret in
 * the lit text.
 */
export type TourTask = 'open' | 'type';

/**
 * A step of the first-run tour: like a tip, over the shell. No anchor centres it. A task step
 * moves on when the person does what it asks (`TipsController.stepDone`, or arriving on
 * `doneOn`), not by Next.
 */
export interface TourStep {
  readonly id: string;
  readonly anchor: string | null;
  /**
   * The part of the anchor to light up and point at, a selector inside it (the first paragraph of
   * the text); the anchor itself when nothing matches. The whole anchor is where the person works:
   * clicking or typing there keeps the step open.
   */
  readonly target?: string;
  readonly title: string;
  readonly body: string;
  readonly task?: TourTask;
  /** The main button's label (a translation key): Next, or Done on the last step, without. */
  readonly next?: string;
  /** A quiet button that ends the tour ("Not now"). */
  readonly dismiss?: string;
  /** The screen (its guide article ID, as `data.help` names it) whose arrival does the task. */
  readonly doneOn?: string;
  /** Where the step is, when its anchor is not on the page as it comes: the tour goes there. */
  readonly route?: string;
  /** The guide page the step hands over to, as "Read …" (the last step's). */
  readonly article?: string;
  /**
   * Its anchor is in the shell (the sidebar, the top bar), on every screen for a person who has
   * it: a person without it (no Review, no revision picker for them) goes without the step.
   */
  readonly shell?: boolean;
  /**
   * The text when the person's own revision is chosen, naming it (`{name}`), in place of `body`
   * (issue 869's revision step).
   */
  readonly namedBody?: string;
}

/** The tour's IDs the pages tell the controller about. */
export const TOUR_OPEN_MODULE = 'tour.open-module';
export const TOUR_EDIT = 'tour.edit';
/** The step at the revision picker, and its anchor in the top bar. */
export const TOUR_REVISION = 'tour.revision';
export const REVISION_ANCHOR = 'shell.revision';
/** The picker's button inside it, which the step lights (the picker itself stays closed). */
const REVISION_TRIGGER = '[data-tip="shell.change-set"]';

const WELCOME: TourStep = {
  id: 'tour.welcome',
  anchor: null,
  title: 'editor.tour.welcome.title',
  body: 'editor.tour.welcome.body',
  next: 'editor.tour.welcome.next',
  dismiss: 'editor.tour.welcome.dismiss',
};

/** The content list's screen, and the module editor's. */
const CONTENT_SCREEN = 'guide.writing.content-browser';
const MODULE_SCREEN = 'guide.writing.edit-a-module';

const openModule = (body: string): TourStep => ({
  id: TOUR_OPEN_MODULE,
  anchor: 'content.module',
  title: 'editor.tour.openModule.title',
  body,
  task: 'open',
  next: 'editor.tour.openModule.next',
  doneOn: MODULE_SCREEN,
  route: '/content',
});

/**
 * The first-run tour of a person who may write (#869): what OpenFolia is for, then their first
 * edit (open a module, change a sentence in a revision the tour starts for them), then where it
 * goes for review.
 */
export const WRITER_TOUR: readonly TourStep[] = [
  WELCOME,
  openModule('editor.tour.openModule.body'),
  {
    id: TOUR_EDIT,
    anchor: 'module-editor.text',
    target: 'p',
    title: 'editor.tour.edit.title',
    body: 'editor.tour.edit.body',
    task: 'type',
    next: 'editor.tour.edit.next',
  },
  // Where the change went (issue 869): the person's own revision, apart from the published
  // content, and the picker that switches between them. Not for a contributor (no picker).
  {
    id: TOUR_REVISION,
    anchor: REVISION_ANCHOR,
    target: REVISION_TRIGGER,
    title: 'editor.tour.revision.title',
    body: 'editor.tour.revision.body',
    namedBody: 'editor.tour.revision.namedBody',
    shell: true,
  },
  {
    id: 'tour.review',
    anchor: 'nav.review',
    title: 'editor.tour.review.title',
    body: 'editor.tour.review.body',
    shell: true,
    article: 'guide.getting-started.first-edit',
  },
];

/** The tour of a person who may only read: no revision is made for them. */
export const READER_TOUR: readonly TourStep[] = [
  WELCOME,
  openModule('editor.tour.openModule.readBody'),
  // Only for a reader who may read drafts: the picker is theirs too (the shell drops it otherwise).
  {
    id: TOUR_REVISION,
    anchor: REVISION_ANCHOR,
    target: REVISION_TRIGGER,
    title: 'editor.tour.revision.readTitle',
    body: 'editor.tour.revision.readBody',
    shell: true,
  },
  {
    id: 'tour.manuals',
    anchor: 'nav.manuals',
    title: 'editor.tour.manuals.title',
    body: 'editor.tour.manuals.body',
    shell: true,
    article: 'guide.getting-started.find-your-way',
  },
];

/** The permission that makes the writer's tour. */
export const WRITE_PERMISSION = 'content.edit';
