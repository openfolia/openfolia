import { z } from 'zod';
import {
  ChosenKind,
  type ChosenKind as Kind,
} from '../../../notifications/core/notification.js';
import type { MailLanguage } from '../mail.js';
import type { MailContent } from './layout.js';
import type { MailTemplate, TemplateContext } from './templates.js';

/**
 * Where an item's link goes in the editor (#884): one of the screens a notification opens, with
 * its query. Only these, so a stored param can never point anywhere else.
 */
export const NotificationLinkPath = z
  .string()
  .max(600)
  .regex(
    /^(review|releases|translations|admin\/backups)(\?[A-Za-z0-9=&%._~-]*)?$/,
    'a path of a screen a notification opens',
  );

/** An unsubscribe token (#884, `UnsubscribeTokens`): URL-safe base64. */
export const UnsubscribeToken = z.string().regex(/^[A-Za-z0-9_-]{20,1000}$/);

/** One notification as an email tells it: the words of the bell's sentence, nothing more. */
export const NotificationMailItem = z.strictObject({
  kind: ChosenKind,
  /** A change set's title. */
  title: z.string().min(1).max(300).optional(),
  /** Who did it, by name. */
  by: z.string().min(1).max(200).optional(),
  /** A release's label (product and revision). */
  release: z.string().min(1).max(200).optional(),
  /** How many: locks broken, manuals in a release. */
  count: z.number().int().min(1).max(100_000).optional(),
  /** A backup's limit in hours. */
  hours: z.number().int().min(1).max(100_000).optional(),
  path: NotificationLinkPath.optional(),
});
export type NotificationMailItem = z.infer<typeof NotificationMailItem>;

/** The most items a summary lists; the rest are counted. */
export const MAX_DIGEST_ITEMS = 20;

/** What each kind is called on the settings page and in an email's reason. */
export const KIND_LABELS: Readonly<
  Record<MailLanguage, Readonly<Record<Kind, string>>>
> = {
  en: {
    'change-set.submit': 'review requests',
    'change-set.return': 'changes returned to you',
    'change-set.approve': 'approvals of your changes',
    'change-set.sign-off': 'sign-offs of your changes',
    'change-set.merge': 'your changes being published',
    'lock.break': 'your locks being broken',
    'release.published': 'major releases you read',
    'release.output-failed': 'release files that failed to build',
    'release.output-recovered': 'release files ready after a failure',
    'translation.imported': 'finished translation imports',
    'translation.import-failed': 'failed translation imports',
    'backup.failed': 'failed backups',
    'backup.overdue': 'overdue backups',
  },
  de: {
    'change-set.submit': 'Prüfanfragen',
    'change-set.return': 'an Sie zurückgegebene Änderungen',
    'change-set.approve': 'Freigaben Ihrer Änderungen',
    'change-set.sign-off': 'Abzeichnungen Ihrer Änderungen',
    'change-set.merge': 'die Veröffentlichung Ihrer Änderungen',
    'lock.break': 'aufgehobene Sperren',
    'release.published': 'große Veröffentlichungen, die Sie lesen',
    'release.output-failed':
      'Dateien einer Veröffentlichung, die nicht erstellt werden konnten',
    'release.output-recovered':
      'doch noch erstellte Dateien einer Veröffentlichung',
    'translation.imported': 'abgeschlossene Übersetzungsimporte',
    'translation.import-failed': 'fehlgeschlagene Übersetzungsimporte',
    'backup.failed': 'fehlgeschlagene Backups',
    'backup.overdue': 'überfällige Backups',
  },
};

const quoteEn = (t: string) => `“${t}”`;
const quoteDe = (t: string) => `„${t}“`;

/** The item's sentence, as the bell says it (`frontend/editor` `notifications.kinds`). */
export function sentence(
  item: NotificationMailItem,
  language: MailLanguage,
): string {
  const de = language === 'de';
  const title = item.title ? (de ? quoteDe : quoteEn)(item.title) : '';
  const count = item.count ?? 1;
  if (de) {
    const by = item.by ?? 'Jemand';
    switch (item.kind) {
      case 'change-set.submit':
        return `${by} bittet Sie, ${title || 'Änderungen'} zu prüfen`;
      case 'change-set.return':
        return `${by} hat ${title || 'Ihre Änderungen'} mit Änderungswünschen zurückgegeben`;
      case 'change-set.approve':
        return `${by} hat ${title || 'Ihre Änderungen'} freigegeben`;
      case 'change-set.sign-off':
        return `${by} hat ${title || 'Ihre Änderungen'} abgezeichnet`;
      case 'change-set.merge':
        return `${by} hat ${title || 'Ihre Änderungen'} veröffentlicht`;
      case 'lock.break':
        return `${by} hat ${count === 1 ? 'eine Ihrer Sperren' : `${count} Ihrer Sperren`}${title ? ` in ${title}` : ''} aufgehoben`;
      case 'translation.imported':
        return 'Ihr Übersetzungsimport ist abgeschlossen';
      case 'translation.import-failed':
        return 'Ihr Übersetzungsimport ist fehlgeschlagen';
      case 'release.published':
        return `${item.release ? `Veröffentlichung ${item.release} ist erschienen` : 'Eine Veröffentlichung ist erschienen'}, mit ${count === 1 ? '1 Anleitung, die Sie lesen' : `${count} Anleitungen, die Sie lesen`}`;
      case 'release.output-failed':
        return item.release
          ? `Ein PDF der Veröffentlichung ${item.release} konnte nicht erstellt werden`
          : 'Ein PDF einer Veröffentlichung konnte nicht erstellt werden';
      case 'release.output-recovered':
        return item.release
          ? `Ein PDF der Veröffentlichung ${item.release} ist doch noch erstellt worden`
          : 'Ein PDF einer Veröffentlichung ist doch noch erstellt worden';
      case 'backup.failed':
        return 'Ein Backup ist fehlgeschlagen';
      case 'backup.overdue':
        return `Seit mehr als ${item.hours ?? 26} Stunden kein gutes Backup`;
    }
  }
  const by = item.by ?? 'Someone';
  switch (item.kind) {
    case 'change-set.submit':
      return `${by} asked you to review ${title || 'changes'}`;
    case 'change-set.return':
      return `${by} returned ${title || 'your changes'} with changes requested`;
    case 'change-set.approve':
      return `${by} approved ${title || 'your changes'}`;
    case 'change-set.sign-off':
      return `${by} signed off ${title || 'your changes'}`;
    case 'change-set.merge':
      return `${by} published ${title || 'your changes'}`;
    case 'lock.break':
      return `${by} broke ${count === 1 ? '1 of your locks' : `${count} of your locks`}${title ? ` in ${title}` : ''}`;
    case 'translation.imported':
      return 'Your translation import is done';
    case 'translation.import-failed':
      return 'Your translation import failed';
    case 'release.published':
      return `${item.release ? `Release ${item.release} was published` : 'A release was published'}, with ${count === 1 ? '1 manual' : `${count} manuals`} you read`;
    case 'release.output-failed':
      return item.release
        ? `A PDF of release ${item.release} failed to build`
        : 'A PDF of a release failed to build';
    case 'release.output-recovered':
      return item.release
        ? `A PDF of release ${item.release} that failed to build is ready after all`
        : 'A PDF of a release that failed to build is ready after all';
    case 'backup.failed':
      return 'A backup failed';
    case 'backup.overdue':
      return `No good backup for more than ${item.hours ?? 26} hours`;
  }
}

/** What the button says for an item's screen. */
function actionLabel(
  item: NotificationMailItem,
  language: MailLanguage,
): string {
  const de = language === 'de';
  if (item.kind.startsWith('change-set.') || item.kind === 'lock.break') {
    return de ? 'Prüfung öffnen' : 'Open the review';
  }
  if (item.kind.startsWith('release.')) {
    return de ? 'Veröffentlichung öffnen' : 'Open the release';
  }
  if (item.kind.startsWith('translation.')) {
    return de ? 'Übersetzungen öffnen' : 'Open translations';
  }
  return de ? 'Backups öffnen' : 'Open backups';
}

/** A paragraph that tells what to do, per kind. */
function guidance(item: NotificationMailItem, language: MailLanguage): string {
  const de = language === 'de';
  switch (item.kind) {
    case 'change-set.submit':
      return de
        ? 'Öffnen Sie die Prüfung, um die Änderungen zu lesen und sie freizugeben oder mit Kommentaren zurückzugeben.'
        : 'Open the review to read the changes, then approve them or return them with comments.';
    case 'change-set.return':
      return de
        ? 'Die Kommentare der Prüfung sagen, was zu ändern ist. Reichen Sie die Änderungen danach erneut ein.'
        : 'The review’s comments say what to change. Submit the changes again once they are done.';
    case 'lock.break':
      return de
        ? 'Was Sie gespeichert haben, bleibt erhalten. Sperren Sie die Inhalte wieder, bevor Sie weiterarbeiten.'
        : 'What you saved is kept. Lock the content again before you go on editing.';
    case 'release.output-failed':
    case 'backup.failed':
    case 'backup.overdue':
      return de
        ? 'Der Grund steht auf der Seite. Sie können es dort erneut versuchen.'
        : 'The page says why, and lets you try again.';
    case 'translation.import-failed':
      return de
        ? 'Die Übersetzungen zeigen, was am Import nicht gepasst hat.'
        : 'Translations shows what did not fit in the import.';
    default:
      return de
        ? 'Die Einzelheiten finden Sie im Editor.'
        : 'You find the details in the editor.';
  }
}

/** The reason line: which setting sent it. */
function reason(
  kinds: readonly Kind[],
  digest: boolean,
  productName: string,
  language: MailLanguage,
): string {
  const labels = [...new Set(kinds)].map((k) => KIND_LABELS[language][k]);
  const list = new Intl.ListFormat(language === 'de' ? 'de' : 'en-GB').format(
    labels,
  );
  if (language === 'de') {
    return digest
      ? `Sie erhalten diese E-Mail, weil Ihre Einstellungen in ${productName} eine tägliche Zusammenfassung für ${list} vorsehen.`
      : `Sie erhalten diese E-Mail, weil Ihre Einstellungen in ${productName} für ${list} eine E-Mail vorsehen.`;
  }
  return digest
    ? `You get this email because your ${productName} settings put ${list} in a daily summary.`
    : `You get this email because your ${productName} settings send ${list} by email.`;
}

/** The footer's unsubscribe link and the one-click URL. */
function unsubscribe(
  token: string,
  digest: boolean,
  kinds: readonly Kind[],
  link: TemplateContext['link'],
  language: MailLanguage,
): MailContent['unsubscribe'] {
  // The kinds only for the page to name before it asks; what stops is what the token holds.
  const href = link(`unsubscribe#${token}&kinds=${kinds.join(',')}`);
  const oneClick = link(`api/notifications/unsubscribe/${token}`);
  // Queued only with a public URL: without one, nothing to link to.
  if (href === null || oneClick === null) {
    throw new Error('A notification email needs CCMS_PUBLIC_URL.');
  }
  const label =
    language === 'de'
      ? digest
        ? 'Keine tägliche Zusammenfassung mehr'
        : `Keine E-Mails mehr für ${KIND_LABELS.de[kinds[0]!]}`
      : digest
        ? 'Stop the daily summary'
        : `Stop emails about ${KIND_LABELS.en[kinds[0]!]}`;
  return { label, href, oneClick };
}

const at = (link: TemplateContext['link'], path: string | undefined) =>
  path === undefined ? null : link(path);

/** One notification, or a burst of the same on the same item, by email at once (#884). */
export const NOTIFICATION_MAIL: MailTemplate<{
  item: NotificationMailItem;
  repeats: number;
  token: string;
}> = {
  name: 'notification',
  params: z.strictObject({
    item: NotificationMailItem,
    /** How many events of this kind on this item the email stands for (a burst). */
    repeats: z.number().int().min(1).max(10_000),
    token: UnsubscribeToken,
  }),
  texts: Object.fromEntries(
    (['en', 'de'] as const).map((language) => [
      language,
      (
        p: { item: NotificationMailItem; repeats: number; token: string },
        { productName, link }: TemplateContext,
      ): Omit<MailContent, 'footer'> => {
        const words = sentence(p.item, language);
        const href = at(link, p.item.path);
        const repeated =
          p.repeats > 1
            ? language === 'de'
              ? `Das ist in den letzten Minuten ${p.repeats}-mal geschehen.`
              : `This happened ${p.repeats} times in the last few minutes.`
            : null;
        return {
          subject: words,
          heading: words,
          paragraphs: [
            ...(repeated ? [repeated] : []),
            guidance(p.item, language),
          ],
          action: href ? { label: actionLabel(p.item, language), href } : null,
          reason: reason([p.item.kind], false, productName, language),
          unsubscribe: unsubscribe(
            p.token,
            false,
            [p.item.kind],
            link,
            language,
          ),
        };
      },
    ]),
  ) as MailTemplate<{
    item: NotificationMailItem;
    repeats: number;
    token: string;
  }>['texts'],
};

/** The daily summary (#884): what came since the last one, at most `MAX_DIGEST_ITEMS` listed. */
export const NOTIFICATION_DIGEST_MAIL: MailTemplate<{
  items: NotificationMailItem[];
  more: number;
  kinds: Kind[];
  token: string;
}> = {
  name: 'notification-digest',
  params: z.strictObject({
    items: z.array(NotificationMailItem).min(1).max(MAX_DIGEST_ITEMS),
    /** How many more there were than listed. */
    more: z.number().int().min(0).max(100_000),
    /** The kinds of all of them, listed or not: the token's. */
    kinds: z.array(ChosenKind).min(1),
    token: UnsubscribeToken,
  }),
  texts: Object.fromEntries(
    (['en', 'de'] as const).map((language) => [
      language,
      (
        p: {
          items: NotificationMailItem[];
          more: number;
          kinds: Kind[];
          token: string;
        },
        { productName, link }: TemplateContext,
      ): Omit<MailContent, 'footer'> => {
        const total = p.items.length + p.more;
        const de = language === 'de';
        const home = link('');
        return {
          subject: de
            ? `Ihre tägliche Zusammenfassung: ${total === 1 ? '1 Neuigkeit' : `${total} Neuigkeiten`}`
            : `Your daily summary: ${total === 1 ? '1 update' : `${total} updates`}`,
          heading: de
            ? 'Seit Ihrer letzten Zusammenfassung'
            : 'Since your last summary',
          paragraphs: [
            de
              ? `Hier ist, was Sie in ${productName} betrifft.`
              : `Here is what concerns you in ${productName}.`,
          ],
          items: [
            ...p.items.map((item) => ({
              text: sentence(item, language),
              href: at(link, item.path),
            })),
            ...(p.more > 0
              ? [
                  {
                    text: de
                      ? `und ${p.more} weitere im Editor`
                      : `and ${p.more} more in the editor`,
                    href: null,
                  },
                ]
              : []),
          ],
          action: home
            ? {
                label: de ? `${productName} öffnen` : `Open ${productName}`,
                href: home,
              }
            : null,
          reason: reason(p.kinds, true, productName, language),
          unsubscribe: unsubscribe(p.token, true, p.kinds, link, language),
        };
      },
    ]),
  ) as MailTemplate<{
    items: NotificationMailItem[];
    more: number;
    kinds: Kind[];
    token: string;
  }>['texts'],
};
