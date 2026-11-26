import type { Item } from '../api';

/** One notification as `GET /me/notifications` sends it. */
export type NotificationItem = Item<'/me/notifications'>;
export type NotificationKind = NotificationItem['attributes']['kind'];

/** Who did something, as a payload names them (`by`). */
export interface Who {
  readonly kind: string;
  readonly id: string;
}

/**
 * Where a notification leads: the route as router commands (segments, which the router encodes
 * once) and its query parameters.
 */
export interface NotificationLink {
  readonly path: readonly string[];
  readonly query: Readonly<Record<string, string>>;
}

/**
 * What a row shows of a notification: its icon, its sentence (a translation key with its
 * parameters; `byFallback` names who did it when their name is not known) and where it leads.
 */
export interface NotificationView {
  readonly icon: string;
  /** A problem (a failed import or build): the icon in the destructive colour, with its word. */
  readonly problem: boolean;
  readonly key: string;
  readonly params: Readonly<Record<string, string | number>>;
  /** The key of a word for whoever did it, used when `params.by` is missing. */
  readonly byFallback: string | null;
  readonly link: NotificationLink | null;
}

/** What `describe` needs from outside: names of people and labels of releases, when known. */
export interface DescribeContext {
  /** A person's name; null when not known (the sentence then names their role). */
  nameOf(who: Who): string | null;
  /** A release's label ("Product 2.1"); null when not known. */
  releaseLabel(id: string): string | null;
}

/** The icons the rows use, by name: register them where they are drawn. */
export const NOTIFICATION_ICONS = [
  'lucideInbox',
  'lucideUndo2',
  'lucideCircleCheck',
  'lucideSignature',
  'lucideGitMerge',
  'lucideLockOpen',
  'lucideLanguages',
  'lucideTriangleAlert',
  'lucidePackage',
] as const;

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const who = (value: unknown): Who | null => {
  if (typeof value !== 'object' || value === null) return null;
  const { kind, id } = value as Record<string, unknown>;
  return typeof kind === 'string' && typeof id === 'string'
    ? { kind, id }
    : null;
};

/** `module/<lang>/<id>`, as a lock break names a locked module. */
const MODULE_SUBJECT = /^module\/([^/]+)\/([^/]+)$/;

/**
 * A notification as a row shows it. The sentence is built here from the kind and the payload,
 * never from text the server wrote; anything the payload lacks falls back to a plainer sentence.
 */
export function describe(
  item: NotificationItem,
  context: DescribeContext,
): NotificationView {
  const { kind, payload, subject } = item.attributes;
  const title = str(payload['title']) ?? '';
  const byWho = who(payload['by']);
  const by = byWho ? context.nameOf(byWho) : null;
  const params: Record<string, string | number> = { title };
  if (by) params['by'] = by;
  const changeSetId = str(payload['changeSetId']) ?? subject.id;
  // The review lists the change set's state (a returned one is a draft again), so it is marked there.
  const state = str(payload['state']);
  const review: NotificationLink = {
    path: ['/review'],
    query: {
      ...(state === 'draft' || state === 'approved' ? { state } : {}),
      cs: changeSetId,
    },
  };
  const view = (
    icon: string,
    key: string,
    byFallback: string | null,
    link: NotificationLink | null,
    problem = false,
  ): NotificationView => ({ icon, problem, key, params, byFallback, link });

  switch (kind) {
    case 'change-set.submit':
      return view(
        'lucideInbox',
        'editor.notifications.kinds.submit',
        'editor.notifications.someone.author',
        review,
      );
    case 'change-set.return':
      return view(
        'lucideUndo2',
        'editor.notifications.kinds.return',
        'editor.notifications.someone.reviewer',
        review,
      );
    case 'change-set.approve':
      return view(
        'lucideCircleCheck',
        'editor.notifications.kinds.approve',
        'editor.notifications.someone.reviewer',
        review,
      );
    case 'change-set.sign-off':
      return view(
        'lucideSignature',
        'editor.notifications.kinds.signOff',
        'editor.notifications.someone.reviewer',
        review,
      );
    case 'change-set.merge':
      return view(
        'lucideGitMerge',
        'editor.notifications.kinds.merge',
        'editor.notifications.someone.publisher',
        review,
      );
    case 'lock.break': {
      const subjects = Array.isArray(payload['subjects'])
        ? payload['subjects'].filter((s): s is string => typeof s === 'string')
        : [];
      const count =
        typeof payload['count'] === 'number' && payload['count'] > 0
          ? payload['count']
          : Math.max(1, subjects.length);
      const only = count === 1 ? MODULE_SUBJECT.exec(subjects[0] ?? '') : null;
      params['count'] = count;
      if (only) {
        const [, lang = '', moduleId = ''] = only;
        params['subject'] = moduleId;
        return view(
          'lucideLockOpen',
          'editor.notifications.kinds.lockBreakModule',
          'editor.notifications.someone.admin',
          {
            path: ['/content', lang, moduleId],
            query: { cs: changeSetId },
          },
        );
      }
      return view(
        'lucideLockOpen',
        'editor.notifications.kinds.lockBreak',
        'editor.notifications.someone.admin',
        review,
      );
    }
    case 'translation.imported': {
      const into = str(payload['changeSetId']);
      return view(
        'lucideLanguages',
        'editor.notifications.kinds.imported',
        null,
        into
          ? { path: ['/review'], query: { cs: into } }
          : { path: ['/translations'], query: { import: subject.id } },
      );
    }
    case 'translation.import-failed':
      return view(
        'lucideTriangleAlert',
        'editor.notifications.kinds.importFailed',
        null,
        { path: ['/translations'], query: { import: subject.id } },
        true,
      );
    case 'release.published': {
      const label = context.releaseLabel(subject.id);
      const manuals = Array.isArray(payload['manualIds'])
        ? payload['manualIds'].length
        : 0;
      params['count'] = manuals;
      if (label) params['release'] = label;
      return view(
        'lucidePackage',
        label
          ? 'editor.notifications.kinds.published'
          : 'editor.notifications.kinds.publishedUnnamed',
        null,
        { path: ['/releases'], query: { release: subject.id } },
      );
    }
    case 'release.output-failed': {
      const label = context.releaseLabel(subject.id);
      if (label) params['release'] = label;
      return view(
        'lucideTriangleAlert',
        label
          ? 'editor.notifications.kinds.outputFailed'
          : 'editor.notifications.kinds.outputFailedUnnamed',
        null,
        { path: ['/releases'], query: { release: subject.id } },
        true,
      );
    }
    case 'release.output-recovered': {
      const label = context.releaseLabel(subject.id);
      if (label) params['release'] = label;
      return view(
        'lucideCircleCheck',
        label
          ? 'editor.notifications.kinds.outputRecovered'
          : 'editor.notifications.kinds.outputRecoveredUnnamed',
        null,
        { path: ['/releases'], query: { release: subject.id } },
      );
    }
    case 'backup.failed':
      return view(
        'lucideTriangleAlert',
        'editor.notifications.kinds.backupFailed',
        null,
        { path: ['/admin', 'backups'], query: {} },
        true,
      );
    case 'backup.overdue': {
      const hours = payload['warnAfterHours'];
      params['hours'] = typeof hours === 'number' ? hours : 26;
      return view(
        'lucideTriangleAlert',
        'editor.notifications.kinds.backupOverdue',
        null,
        { path: ['/admin', 'backups'], query: {} },
        true,
      );
    }
    case 'sign-in.break-glass':
      return view(
        'lucideTriangleAlert',
        'editor.notifications.kinds.breakGlass',
        'editor.notifications.someone.emergency',
        {
          path: ['/admin', 'audit'],
          query: { action: 'user.break-glass-sign-in' },
        },
        true,
      );
    default:
      // A kind this editor does not know yet: a plain sentence, nothing to open.
      return view(
        'lucideInbox',
        'editor.notifications.kinds.other',
        null,
        null,
      );
  }
}

/** The day a time falls on, in the local time zone: `Today` or `Earlier`. */
export function groupOf(createdAt: string, now: Date): 'today' | 'earlier' {
  const at = new Date(createdAt);
  return at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate()
    ? 'today'
    : 'earlier';
}

/** The release IDs a page of notifications names, to read their labels. */
export function releaseIdsOf(items: readonly NotificationItem[]): string[] {
  return [
    ...new Set(
      items
        .filter((i) => i.attributes.subject.type === 'release')
        .map((i) => i.attributes.subject.id),
    ),
  ];
}
