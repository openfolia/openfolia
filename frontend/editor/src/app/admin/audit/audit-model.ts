import type { Item } from '../../api';

export type AuditEventItem = Item<'/audit-events'>;
export type AuditActor = AuditEventItem['attributes']['actor'];
export type AuditSubject = AuditEventItem['attributes']['subject'];

/** The permission reading the audit log needs (`GET /audit-events`). */
export const READ_AUDIT_LOG = 'admin.roles';

/** Page sizes of the audit log. */
export const AUDIT_PAGE_SIZES = [25, 50, 100] as const;

/** An actor kind the API records. */
export const ACTOR_KINDS = ['user', 'service'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/** The kinds of event (#877): changes, and the reads of service accounts. */
export const AUDIT_KINDS = ['write', 'read'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

/** `?kind=`: `write` or `read`, as `filter[kind]` takes it. */
export function validKind(value: string): boolean {
  return (AUDIT_KINDS as readonly string[]).includes(value);
}

/** A subject type or action key part: a lowercase key, as the API takes it. */
const KEY = /^[a-z][a-z0-9-]*$/;
const KEY_MAX = 64;

/** `?actor=`: `<kind>` or `<kind>/<id>`, as `filter[actor]` takes it. */
export function validActor(value: string): boolean {
  const slash = value.indexOf('/');
  const kind = slash < 0 ? value : value.slice(0, slash);
  const id = slash < 0 ? undefined : value.slice(slash + 1);
  return (
    value.length <= 210 &&
    (ACTOR_KINDS as readonly string[]).includes(kind) &&
    (id === undefined || (id.length > 0 && id.length <= 200))
  );
}

/** `?type=`: a subject type, a lowercase key. */
export function validSubjectType(value: string): boolean {
  return value.length <= KEY_MAX && KEY.test(value);
}

/** `?action=`: `<subject>.<verb>` in lowercase keys. */
export function validAction(value: string): boolean {
  return (
    value.length <= 100 && /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(value)
  );
}

/** `?from=` / `?to=`: a calendar day, `YYYY-MM-DD`, one that exists, from 1000 to 9998. */
export function validDay(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const [y, m, d] = match.slice(1).map(Number) as [number, number, number];
  // The API takes years 1 to 9999; the day after the last one stays inside.
  if (y < 1000 || y > 9998) return false;
  const day = new Date(y, m - 1, d);
  return (
    day.getFullYear() === y && day.getMonth() === m - 1 && day.getDate() === d
  );
}

/** The start of a calendar day (`YYYY-MM-DD`) in the browser's time zone, `days` later. */
function dayStart(value: string, days = 0): string {
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d + days).toISOString();
}

/**
 * The `filter[from]` and `filter[to]` two calendar days stand for, both included, in the
 * browser's time zone: from the first day's start to the start of the day after the last (the API
 * takes `to` as exclusive).
 */
export function dayRangeFilter(
  from: string | undefined,
  to: string | undefined,
): { 'filter[from]'?: string; 'filter[to]'?: string } {
  return {
    ...(from && validDay(from) ? { 'filter[from]': dayStart(from) } : {}),
    ...(to && validDay(to) ? { 'filter[to]': dayStart(to, 1) } : {}),
  };
}

/** The longest subject ID the API takes. */
export const SUBJECT_ID_MAX = 500;

/**
 * What each action the API records says, as whole translation keys. An action not listed here
 * is shown as its key.
 */
export const ACTION_TEXTS: Readonly<Record<string, string>> = {
  'api.read': 'editor.admin.audit.actions.apiRead',
  'api.read-gap': 'editor.admin.audit.actions.apiReadGap',
  'asset.delete': 'editor.admin.audit.actions.assetDelete',
  'asset.upload': 'editor.admin.audit.actions.assetUpload',
  'audit-log.export': 'editor.admin.audit.actions.auditLogExport',
  'audit-log.prune': 'editor.admin.audit.actions.auditLogPrune',
  'backup-key.create': 'editor.admin.audit.actions.backupKeyCreate',
  'backup-key.rotate': 'editor.admin.audit.actions.backupKeyRotate',
  'backup-settings.update': 'editor.admin.audit.actions.backupSettingsUpdate',
  'backup.request': 'editor.admin.audit.actions.backupRequest',
  'branding.image-delete': 'editor.admin.audit.actions.brandingImageDelete',
  'branding.image-upload': 'editor.admin.audit.actions.brandingImageUpload',
  'branding.update': 'editor.admin.audit.actions.brandingUpdate',
  'change-set.abandon': 'editor.admin.audit.actions.changeSetAbandon',
  'change-set.approve': 'editor.admin.audit.actions.changeSetApprove',
  'change-set.carry-forward':
    'editor.admin.audit.actions.changeSetCarryForward',
  'change-set.commit': 'editor.admin.audit.actions.changeSetCommit',
  'change-set.create': 'editor.admin.audit.actions.changeSetCreate',
  'change-set.edit': 'editor.admin.audit.actions.changeSetEdit',
  'change-set.merge': 'editor.admin.audit.actions.changeSetMerge',
  'change-set.rebase': 'editor.admin.audit.actions.changeSetRebase',
  'change-set.refresh': 'editor.admin.audit.actions.changeSetRefresh',
  'change-set.return': 'editor.admin.audit.actions.changeSetReturn',
  'change-set.revert': 'editor.admin.audit.actions.changeSetRevert',
  'change-set.sign-off': 'editor.admin.audit.actions.changeSetSignOff',
  'change-set.submit': 'editor.admin.audit.actions.changeSetSubmit',
  'comment.create': 'editor.admin.audit.actions.commentCreate',
  'comment.delete': 'editor.admin.audit.actions.commentDelete',
  'comment.edit': 'editor.admin.audit.actions.commentEdit',
  'comment.reopen': 'editor.admin.audit.actions.commentReopen',
  'comment.resolve': 'editor.admin.audit.actions.commentResolve',
  'config.delete': 'editor.admin.audit.actions.configDelete',
  'config.write': 'editor.admin.audit.actions.configWrite',
  'design.delete': 'editor.admin.audit.actions.designDelete',
  'design.write': 'editor.admin.audit.actions.designWrite',
  'group-mapping.create': 'editor.admin.audit.actions.groupMappingCreate',
  'group-mapping.delete': 'editor.admin.audit.actions.groupMappingDelete',
  'import.apply': 'editor.admin.audit.actions.importApply',
  'lock.acquire': 'editor.admin.audit.actions.lockAcquire',
  'lock.break': 'editor.admin.audit.actions.lockBreak',
  'lock.release': 'editor.admin.audit.actions.lockRelease',
  'mail.failed': 'editor.admin.audit.actions.mailFailed',
  'mail.sent': 'editor.admin.audit.actions.mailSent',
  'mail.test': 'editor.admin.audit.actions.mailTest',
  'maintenance-line.close': 'editor.admin.audit.actions.maintenanceLineClose',
  'maintenance-line.start': 'editor.admin.audit.actions.maintenanceLineStart',
  'manual.delete': 'editor.admin.audit.actions.manualDelete',
  'manual.write': 'editor.admin.audit.actions.manualWrite',
  'module.delete': 'editor.admin.audit.actions.moduleDelete',
  'module.rename': 'editor.admin.audit.actions.moduleRename',
  'module.style-review': 'editor.admin.audit.actions.moduleStyleReview',
  'module.write': 'editor.admin.audit.actions.moduleWrite',
  'notification.unsubscribe':
    'editor.admin.audit.actions.notificationUnsubscribe',
  'release.output-retry': 'editor.admin.audit.actions.releaseOutputRetry',
  'release.outputs-plan': 'editor.admin.audit.actions.releaseOutputsPlan',
  'release.publish': 'editor.admin.audit.actions.releasePublish',
  'release.withdraw': 'editor.admin.audit.actions.releaseWithdraw',
  'role.assign': 'editor.admin.audit.actions.roleAssign',
  'role.create': 'editor.admin.audit.actions.roleCreate',
  'role.delete': 'editor.admin.audit.actions.roleDelete',
  'role.unassign': 'editor.admin.audit.actions.roleUnassign',
  'role.update': 'editor.admin.audit.actions.roleUpdate',
  'service-account.create': 'editor.admin.audit.actions.serviceAccountCreate',
  'service-account.deactivate':
    'editor.admin.audit.actions.serviceAccountDeactivate',
  'service-account.reactivate':
    'editor.admin.audit.actions.serviceAccountReactivate',
  'service-account.update': 'editor.admin.audit.actions.serviceAccountUpdate',
  'service-token.issue': 'editor.admin.audit.actions.serviceTokenIssue',
  'service-token.revoke': 'editor.admin.audit.actions.serviceTokenRevoke',
  'scim-group.create': 'editor.admin.audit.actions.scimGroupCreate',
  'scim-group.delete': 'editor.admin.audit.actions.scimGroupDelete',
  'scim-group.update': 'editor.admin.audit.actions.scimGroupUpdate',
  'settings.second-factor': 'editor.admin.audit.actions.settingsSecondFactor',
  'settings.self-approval': 'editor.admin.audit.actions.settingsSelfApproval',
  'storage.limit-change': 'editor.admin.audit.actions.storageLimitChange',
  'storage.upload-refused': 'editor.admin.audit.actions.storageUploadRefused',
  'template.delete': 'editor.admin.audit.actions.templateDelete',
  'template.write': 'editor.admin.audit.actions.templateWrite',
  'term.delete': 'editor.admin.audit.actions.termDelete',
  'term.write': 'editor.admin.audit.actions.termWrite',
  'translation-job.cancel': 'editor.admin.audit.actions.translationJobCancel',
  'translation-job.export': 'editor.admin.audit.actions.translationJobExport',
  'translation.import': 'editor.admin.audit.actions.translationImport',
  'translation.mark-current':
    'editor.admin.audit.actions.translationMarkCurrent',
  'user.create': 'editor.admin.audit.actions.userCreate',
  'user.deactivate': 'editor.admin.audit.actions.userDeactivate',
  'user.email-code-requested':
    'editor.admin.audit.actions.userEmailCodeRequested',
  'user.identity-link': 'editor.admin.audit.actions.userIdentityLink',
  'user.identity-unlink': 'editor.admin.audit.actions.userIdentityUnlink',
  'user.invite': 'editor.admin.audit.actions.userInvite',
  'user.invite-withdraw': 'editor.admin.audit.actions.userInviteWithdraw',
  'user.password-changed': 'editor.admin.audit.actions.userPasswordChanged',
  'user.password-reset-requested':
    'editor.admin.audit.actions.userPasswordResetRequested',
  'user.password-set': 'editor.admin.audit.actions.userPasswordSet',
  'user.reactivate': 'editor.admin.audit.actions.userReactivate',
  'user.second-factor-off': 'editor.admin.audit.actions.userSecondFactorOff',
  'user.second-factor-on': 'editor.admin.audit.actions.userSecondFactorOn',
  'user.second-factor-recovery-codes':
    'editor.admin.audit.actions.userSecondFactorRecoveryCodes',
  'user.second-factor-reset':
    'editor.admin.audit.actions.userSecondFactorReset',
  'settings.single-sign-on': 'editor.admin.audit.actions.settingsSingleSignOn',
  'settings.break-glass': 'editor.admin.audit.actions.settingsBreakGlass',
  'settings.session-limits': 'editor.admin.audit.actions.settingsSessionLimits',
  'settings.sign-ins-ended': 'editor.admin.audit.actions.settingsSignInsEnded',
  'user.break-glass-sign-in': 'editor.admin.audit.actions.userBreakGlassSignIn',
  'user.sign-in': 'editor.admin.audit.actions.userSignIn',
  'user.sign-out': 'editor.admin.audit.actions.userSignOut',
  'user.update': 'editor.admin.audit.actions.userUpdate',
  'webhook.create': 'editor.admin.audit.actions.webhookCreate',
  'webhook.delete': 'editor.admin.audit.actions.webhookDelete',
  'webhook.disable': 'editor.admin.audit.actions.webhookDisable',
  'webhook.retry': 'editor.admin.audit.actions.webhookRetry',
  'webhook.rotate-secret': 'editor.admin.audit.actions.webhookRotateSecret',
  'webhook.test': 'editor.admin.audit.actions.webhookTest',
  'webhook.update': 'editor.admin.audit.actions.webhookUpdate',
};

/** The subject types the API records, as whole translation keys; another is shown as its key. */
export const SUBJECT_TYPE_TEXTS: Readonly<Record<string, string>> = {
  'change-set': 'editor.admin.audit.subjects.changeSet',
  module: 'editor.admin.audit.subjects.module',
  manual: 'editor.admin.audit.subjects.manual',
  config: 'editor.admin.audit.subjects.config',
  term: 'editor.admin.audit.subjects.term',
  design: 'editor.admin.audit.subjects.design',
  comment: 'editor.admin.audit.subjects.comment',
  asset: 'editor.admin.audit.subjects.asset',
  'audit-log': 'editor.admin.audit.subjects.auditLog',
  import: 'editor.admin.audit.subjects.import',
  release: 'editor.admin.audit.subjects.release',
  'release-output': 'editor.admin.audit.subjects.releaseOutput',
  'maintenance-line': 'editor.admin.audit.subjects.maintenanceLine',
  'translation-job': 'editor.admin.audit.subjects.translationJob',
  'translation-import': 'editor.admin.audit.subjects.translationImport',
  role: 'editor.admin.audit.subjects.role',
  user: 'editor.admin.audit.subjects.user',
  'service-account': 'editor.admin.audit.subjects.serviceAccount',
  webhook: 'editor.admin.audit.subjects.webhook',
  storage: 'editor.admin.audit.subjects.storage',
  branding: 'editor.admin.audit.subjects.branding',
  settings: 'editor.admin.audit.subjects.settings',
  mail: 'editor.admin.audit.subjects.mail',
  backup: 'editor.admin.audit.subjects.backup',
  'backup-key': 'editor.admin.audit.subjects.backupKey',
  'backup-request': 'editor.admin.audit.subjects.backupRequest',
  'backup-settings': 'editor.admin.audit.subjects.backupSettings',
  'group-mapping': 'editor.admin.audit.subjects.groupMapping',
  'scim-group': 'editor.admin.audit.subjects.scimGroup',
  route: 'editor.admin.audit.subjects.route',
};

/** Where a subject is shown in the editor, or null when it has no screen of its own. */
export interface SubjectLink {
  readonly commands: readonly string[];
  readonly queryParams?: Readonly<Record<string, string>>;
}

export function subjectLink(subject: AuditSubject): SubjectLink | null {
  switch (subject.type) {
    case 'module': {
      // `<lang>/<moduleId>`: the module editor at the published content.
      const slash = subject.id.indexOf('/');
      if (slash <= 0 || slash === subject.id.length - 1) return null;
      return {
        commands: [
          '/content',
          subject.id.slice(0, slash),
          subject.id.slice(slash + 1),
        ],
      };
    }
    case 'manual':
      return { commands: ['/manuals'], queryParams: { manual: subject.id } };
    case 'change-set':
      return { commands: ['/review'], queryParams: { cs: subject.id } };
    default:
      return null;
  }
}

/** One line of an event's details. */
export interface DataEntry {
  /** The path of the value in `data`, its keys joined by "." (`grant.permissions`). */
  readonly key: string;
  /** The value as text; null for nothing (`null`, an empty list or object). */
  readonly value: string | null;
}

/** Nested objects deeper than this are shown as JSON. */
const MAX_DEPTH = 3;

/**
 * An event's `data` as a readable list: nested objects are flattened to dotted keys, a list of
 * plain values is joined by ", ", anything else (a list of objects, deeper nesting) is JSON.
 */
export function dataEntries(
  data: Readonly<Record<string, unknown>>,
): DataEntry[] {
  const out: DataEntry[] = [];
  const walk = (value: unknown, key: string, depth: number) => {
    if (value === null || value === undefined) {
      out.push({ key, value: null });
    } else if (Array.isArray(value)) {
      if (value.length === 0) out.push({ key, value: null });
      else if (value.every(isPlain)) {
        out.push({ key, value: value.map(String).join(', ') });
      } else out.push({ key, value: JSON.stringify(value) });
    } else if (typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length === 0) out.push({ key, value: null });
      else if (depth >= MAX_DEPTH) {
        out.push({ key, value: JSON.stringify(value) });
      } else {
        for (const [k, v] of entries)
          walk(v, key ? `${key}.${k}` : k, depth + 1);
      }
    } else {
      out.push({ key, value: String(value) });
    }
  };
  for (const [k, v] of Object.entries(data)) walk(v, k, 1);
  return out;
}

function isPlain(value: unknown): boolean {
  return (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/** The `filter[subject]` a type and an ID stand for: `<type>`, `<type>/<id>`, or none. */
export function subjectFilter(
  type: string | undefined,
  id: string,
): string | undefined {
  if (!type) return undefined;
  return id ? `${type}/${id}` : type;
}

/** The audit log's address showing only a subject's events (the "Show in audit log" links). */
export function auditLogLink(subject: AuditSubject): {
  readonly commands: readonly string[];
  readonly queryParams: Readonly<Record<string, string>>;
} {
  return {
    commands: ['/admin', 'audit'],
    queryParams: { type: subject.type, id: subject.id },
  };
}

/** What a read event (#877, kind `read`) says beyond its path, as the row shows it. */
export interface ReadFacts {
  /** The client's own name for itself (`mcp/<tool>` for the MCP server). */
  readonly client?: string;
  /** The ref asked for. */
  readonly ref?: string;
  /** The HTTP status, when it was no success (400 and up). */
  readonly failedStatus?: number;
  /** Whether the client went away before the answer was complete. */
  readonly aborted: boolean;
  /** For a gap (`api.read-gap`): how many reads were not recorded one by one. */
  readonly unrecorded?: number;
}

/** A read event's facts from its `data`; null for a change. */
export function readFacts(event: AuditEventItem): ReadFacts | null {
  const a = event.attributes;
  if (a.kind !== 'read') return null;
  const text = (key: string) => {
    const value = a.data[key];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const status = a.data['status'];
  const client = text('client');
  const ref = text('ref');
  const count = a.data['count'];
  return {
    ...(a.action === 'api.read-gap' &&
      typeof count === 'number' && { unrecorded: count }),
    ...(client !== undefined && { client }),
    ...(ref !== undefined && { ref }),
    ...(typeof status === 'number' &&
      status >= 400 && { failedStatus: status }),
    aborted: a.data['aborted'] === true,
  };
}
