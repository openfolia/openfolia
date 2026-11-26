import { z } from 'zod';
import {
  NOTIFICATION_SUBJECTS,
  REGISTERED_NOTIFICATION_KINDS,
} from '../../notification-kinds.js';
import type { ChosenKindDefinition } from './notification-kind-registry.js';

/**
 * What a notification is about: its kind is the outbox topic it came from,
 * in the order the components registered them (`src/notification-kinds.ts`,
 * each component's `<component>.notification-kinds.ts`). A topic not
 * registered notifies nobody.
 */
export const NOTIFICATION_KINDS = Object.freeze(
  REGISTERED_NOTIFICATION_KINDS.map((k) => k.kind),
);

type Registered = (typeof REGISTERED_NOTIFICATION_KINDS)[number];
/** A registered kind a person chooses about. */
export type RegisteredChosenKind = Extract<Registered, ChosenKindDefinition>;

/** Whether a person chooses about the kind (else it cannot be turned off). */
const isChosen = (k: Registered): k is RegisteredChosenKind =>
  !Object.hasOwn(k, 'chosen');

/** The registered kinds a person chooses about, in order, with their section and default. */
export const REGISTERED_CHOSEN_KINDS = Object.freeze(
  REGISTERED_NOTIFICATION_KINDS.filter(isChosen),
);

/**
 * The kinds a person chooses how to hear of (#884). The others nobody
 * chooses about: their email goes out on its own (`OutboxSignInEvents`, #378).
 */
export const CHOSEN_KINDS = Object.freeze(
  REGISTERED_CHOSEN_KINDS.map((k) => k.kind),
);
export const ChosenKind = z.enum(CHOSEN_KINDS);
export type ChosenKind = z.infer<typeof ChosenKind>;

export const NotificationKind = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** The kinds of thing a notification opens (`src/notification-kinds.ts`). */
export const SUBJECT_TYPES = NOTIFICATION_SUBJECTS;
export const NotificationSubjectType = z.enum(SUBJECT_TYPES);
export type NotificationSubjectType = z.infer<typeof NotificationSubjectType>;

export interface NotificationSubject {
  readonly type: NotificationSubjectType;
  readonly id: string;
}

/** Who caused an event, as the audit log names actors. */
export interface EventActor {
  readonly kind: 'user' | 'service';
  readonly id: string;
}

/** A notification about to be stored: one per outbox row and recipient. */
export interface NewNotification {
  /** The outbox row it came from: with the recipient, what makes it unique. */
  readonly outboxId: number;
  /** A user's ID: only people are notified. */
  readonly recipient: string;
  readonly kind: NotificationKind;
  readonly subject: NotificationSubject;
  /**
   * What a client builds its sentence from (IDs, a title, a state), never
   * text written for people on the server, and nothing the recipient may
   * not read.
   */
  readonly payload: Readonly<Record<string, unknown>>;
  /** When the event happened (its outbox row's time). */
  readonly createdAt: Date;
}

/** A stored notification. */
export interface Notification extends NewNotification {
  /** Decimal text; increasing in the order notifications were stored. */
  readonly id: string;
  /** When its recipient marked it read; undefined while unread. */
  readonly readAt?: Date;
}

/** A notification's ID in requests: a positive whole number, as decimal text. */
export const NotificationId = z
  .string()
  // At most 15 digits: exact as a JavaScript number.
  .regex(/^[1-9][0-9]{0,14}$/, 'a notification ID (a positive whole number)');

/** The most IDs one `POST /me/notifications/read` takes. */
export const MAX_MARKED = 200;
