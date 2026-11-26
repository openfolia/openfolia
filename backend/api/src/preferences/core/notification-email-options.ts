/**
 * The installation's settings for notification emails (#884), read once at start
 * (`CCMS_NOTIFICATIONS_DIGEST_HOUR`, `CCMS_NOTIFICATIONS_EMAILS_PER_HOUR`).
 */
export abstract class NotificationEmailOptions {
  /** The daily summary's hour for a person who chose none, 0 to 23, in their time zone. */
  abstract readonly digestHour: number;
  /** The most emails at once one person gets in an hour; past it, they wait for the summary. */
  abstract readonly perHour: number;
}

/** Options set by hand (tests, and the module's factory). */
export class FixedNotificationEmailOptions extends NotificationEmailOptions {
  constructor(
    readonly digestHour = 8,
    readonly perHour = 20,
  ) {
    super();
  }
}
