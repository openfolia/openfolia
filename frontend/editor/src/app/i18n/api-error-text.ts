import type { TranslatedText } from '@openfolia/ui/startup';

import type { ApiError, ApiErrorKind } from '../api';

/**
 * What the person reads about a failed call, by the API's stable `code` and the parameters in
 * its `meta` (and `source.parameter`), never by parsing `detail`: the API's `title` and `detail`
 * stay English, for developers and logs. A code without its own text falls back to its kind's.
 *
 * Every key here is the literal `editor.apiErrors.codes.<code>`, and the i18n test checks that
 * each names a code the API really sends.
 */
const CODES: Readonly<Record<string, string>> = {
  'not-found': 'editor.apiErrors.codes.not-found',
  forbidden: 'editor.apiErrors.codes.forbidden',
  unauthorized: 'editor.apiErrors.codes.unauthorized',
  'invalid-parameter': 'editor.apiErrors.codes.invalid-parameter',
  'unsupported-parameter': 'editor.apiErrors.codes.unsupported-parameter',
  'invalid-body': 'editor.apiErrors.codes.invalid-body',
  'invalid-content': 'editor.apiErrors.codes.invalid-content',
  locked: 'editor.apiErrors.codes.locked',
  'lock-required': 'editor.apiErrors.codes.lock-required',
  'version-conflict': 'editor.apiErrors.codes.version-conflict',
  'too-large': 'editor.apiErrors.codes.too-large',
  'renderer-busy': 'editor.apiErrors.codes.renderer-busy',
  'chunk-sets-busy': 'editor.apiErrors.codes.chunk-sets-busy',
  'render-timeout': 'editor.apiErrors.codes.render-timeout',
  'render-memory-exceeded': 'editor.apiErrors.codes.render-memory-exceeded',
  'template-error': 'editor.apiErrors.codes.template-error',
  'render-failed': 'editor.apiErrors.codes.render-failed',
  'pdf-accessibility': 'editor.apiErrors.codes.pdf-accessibility',
  'expansion-too-large': 'editor.apiErrors.codes.expansion-too-large',
  'table-too-large': 'editor.apiErrors.codes.table-too-large',
  'database-unavailable': 'editor.apiErrors.codes.database-unavailable',
  'shutting-down': 'editor.apiErrors.codes.shutting-down',
  'internal-error': 'editor.apiErrors.codes.internal-error',
  'invalid-state': 'editor.apiErrors.codes.invalid-state',
  'comment-deleted': 'editor.apiErrors.codes.comment-deleted',
  'already-approved': 'editor.apiErrors.codes.already-approved',
  'head-moved': 'editor.apiErrors.codes.head-moved',
  'not-approved': 'editor.apiErrors.codes.not-approved',
  'approval-lapsed': 'editor.apiErrors.codes.approval-lapsed',
  'merge-conflict': 'editor.apiErrors.codes.merge-conflict',
  'refresh-conflict': 'editor.apiErrors.codes.refresh-conflict',
  'refresh-unresolved': 'editor.apiErrors.codes.refresh-unresolved',
  'branch-moved': 'editor.apiErrors.codes.branch-moved',
  'base-moved': 'editor.apiErrors.codes.base-moved',
  'base-missing': 'editor.apiErrors.codes.base-missing',
  'base-rewritten': 'editor.apiErrors.codes.base-rewritten',
  'base-not-rewritten': 'editor.apiErrors.codes.base-not-rewritten',
  'already-superseded': 'editor.apiErrors.codes.already-superseded',
  'no-sign-off-needed': 'editor.apiErrors.codes.no-sign-off-needed',
  'uncommitted-working-copies':
    'editor.apiErrors.codes.uncommitted-working-copies',
  'no-changes': 'editor.apiErrors.codes.no-changes',
  'already-carried-forward': 'editor.apiErrors.codes.already-carried-forward',
  'not-on-maintenance-line': 'editor.apiErrors.codes.not-on-maintenance-line',
  'maintenance-line-exists': 'editor.apiErrors.codes.maintenance-line-exists',
  'invalid-maintenance-branch':
    'editor.apiErrors.codes.invalid-maintenance-branch',
  'no-email-address': 'editor.apiErrors.codes.no-email-address',
  'branch-missing': 'editor.apiErrors.codes.branch-missing',
  'change-set-branch-missing':
    'editor.apiErrors.codes.change-set-branch-missing',
  'database-timeout': 'editor.apiErrors.codes.database-timeout',
  'lock-contended': 'editor.apiErrors.codes.lock-contended',
  'not-changed': 'editor.apiErrors.codes.not-changed',
  'not-restorable': 'editor.apiErrors.codes.not-restorable',
  'unsupported-attachment-type':
    'editor.apiErrors.codes.unsupported-attachment-type',
  'unsupported-font-type': 'editor.apiErrors.codes.unsupported-font-type',
  'too-many-uploads': 'editor.apiErrors.codes.too-many-uploads',
  'storage-limit-reached': 'editor.apiErrors.codes.storage-limit-reached',
  'last-admin': 'editor.apiErrors.codes.last-admin',
  'role-in-use': 'editor.apiErrors.codes.role-in-use',
  'group-mapping-exists': 'editor.apiErrors.codes.group-mapping-exists',
  'term-in-use': 'editor.apiErrors.codes.term-in-use',
  'design-in-use': 'editor.apiErrors.codes.design-in-use',
  'derived-source-outside-scope':
    'editor.apiErrors.codes.derived-source-outside-scope',
  'role-exists': 'editor.apiErrors.codes.role-exists',
  'user-exists': 'editor.apiErrors.codes.user-exists',
  'email-taken': 'editor.apiErrors.codes.email-taken',
  'unknown-role': 'editor.apiErrors.codes.unknown-role',
  'user-deactivated': 'editor.apiErrors.codes.user-deactivated',
  // Password sign-in (#610).
  'invalid-credentials': 'editor.apiErrors.codes.invalid-credentials',
  'wrong-password': 'editor.apiErrors.codes.wrong-password',
  'password-too-short': 'editor.apiErrors.codes.password-too-short',
  'password-too-long': 'editor.apiErrors.codes.password-too-long',
  'password-too-common': 'editor.apiErrors.codes.password-too-common',
  'link-invalid': 'editor.apiErrors.codes.link-invalid',
  'link-expired': 'editor.apiErrors.codes.link-expired',
  'password-sign-in-off': 'editor.apiErrors.codes.password-sign-in-off',
  // Sign-in by a code by email (#634).
  'invalid-code': 'editor.apiErrors.codes.invalid-code',
  'email-code-sign-in-off': 'editor.apiErrors.codes.email-code-sign-in-off',
  'no-password': 'editor.apiErrors.codes.no-password',
  'sign-in-busy': 'editor.apiErrors.codes.sign-in-busy',
  'too-many-failed-attempts': 'editor.apiErrors.codes.too-many-failed-attempts',
  'already-deactivated': 'editor.apiErrors.codes.already-deactivated',
  'not-deactivated': 'editor.apiErrors.codes.not-deactivated',
  'id-mismatch': 'editor.apiErrors.codes.id-mismatch',
  'admin-role-for-service-account':
    'editor.apiErrors.codes.admin-role-for-service-account',
  'role-held-by-service-account':
    'editor.apiErrors.codes.role-held-by-service-account',
  'service-account-exists': 'editor.apiErrors.codes.service-account-exists',
  'service-account-deactivated':
    'editor.apiErrors.codes.service-account-deactivated',
  'too-many-tokens': 'editor.apiErrors.codes.too-many-tokens',
  'invalid-expiry': 'editor.apiErrors.codes.invalid-expiry',
  'already-revoked': 'editor.apiErrors.codes.already-revoked',
  'id-taken': 'editor.apiErrors.codes.id-taken',
  'invalid-id': 'editor.apiErrors.codes.invalid-id',
  'translation-at-provider': 'editor.apiErrors.codes.translation-at-provider',
  'not-renamable': 'editor.apiErrors.codes.not-renamable',
  'not-retryable': 'editor.apiErrors.codes.not-retryable',
  'rate-limited': 'editor.apiErrors.codes.rate-limited',
  'invalid-url': 'editor.apiErrors.codes.invalid-url',
  'release-exists': 'editor.apiErrors.codes.release-exists',
  'release-pending': 'editor.apiErrors.codes.release-pending',
  'invalid-product': 'editor.apiErrors.codes.invalid-product',
  'no-product-facet': 'editor.apiErrors.codes.no-product-facet',
  'invalid-release-name': 'editor.apiErrors.codes.invalid-release-name',
  'invalid-notes': 'editor.apiErrors.codes.invalid-notes',
  'invalid-language': 'editor.apiErrors.codes.invalid-language',
  'release-withdrawn': 'editor.apiErrors.codes.release-withdrawn',
  'retry-limit': 'editor.apiErrors.codes.retry-limit',
  'output-busy': 'editor.apiErrors.codes.output-busy',
  'output-not-failed': 'editor.apiErrors.codes.output-not-failed',
  'output-not-ready': 'editor.apiErrors.codes.output-not-ready',
  'release-archive-empty': 'editor.apiErrors.codes.release-archive-empty',
  'offline-package-too-large':
    'editor.apiErrors.codes.offline-package-too-large',
  'release-archive-too-large':
    'editor.apiErrors.codes.release-archive-too-large',
  'too-many-changes': 'editor.apiErrors.codes.too-many-changes',
  'path-conflict': 'editor.apiErrors.codes.path-conflict',
  'template-too-large': 'editor.apiErrors.codes.template-too-large',
  'unknown-maintenance-line': 'editor.apiErrors.codes.unknown-maintenance-line',
  'nothing-to-translate': 'editor.apiErrors.codes.nothing-to-translate',
  'too-many-units': 'editor.apiErrors.codes.too-many-units',
  'already-resolved': 'editor.apiErrors.codes.already-resolved',
  'not-resolved': 'editor.apiErrors.codes.not-resolved',
  'not-a-thread': 'editor.apiErrors.codes.not-a-thread',
  'invalid-thread': 'editor.apiErrors.codes.invalid-thread',
  'block-not-found': 'editor.apiErrors.codes.block-not-found',
  'too-many-comments': 'editor.apiErrors.codes.too-many-comments',
  'asset-deleted': 'editor.apiErrors.codes.asset-deleted',
  'unknown-asset': 'editor.apiErrors.codes.unknown-asset',
  'asset-in-use': 'editor.apiErrors.codes.asset-in-use',
  'too-many-change-sets': 'editor.apiErrors.codes.too-many-change-sets',
  'too-many-files': 'editor.apiErrors.codes.too-many-files',
  'upload-interrupted': 'editor.apiErrors.codes.upload-interrupted',
  'unprocessable-image': 'editor.apiErrors.codes.unprocessable-image',
  'rendition-busy': 'editor.apiErrors.codes.rendition-busy',
  'rendition-timeout': 'editor.apiErrors.codes.rendition-timeout',
  'blob-store-unavailable': 'editor.apiErrors.codes.blob-store-unavailable',
  'content-unavailable': 'editor.apiErrors.codes.content-unavailable',
  'database-saturated': 'editor.apiErrors.codes.database-saturated',
  'search-busy': 'editor.apiErrors.codes.search-busy',
  // A public sandbox (#826): what it refuses (`meta.refused`) and its caps (`meta.limit`, `max`).
  'sandbox-not-allowed': 'editor.apiErrors.codes.sandbox-not-allowed',
  'sandbox-limit-reached': 'editor.apiErrors.codes.sandbox-limit-reached',
  'branding-image-busy': 'editor.apiErrors.codes.branding-image-busy',
  'branding-image-in-use': 'editor.apiErrors.codes.branding-image-in-use',
  'invalid-branding': 'editor.apiErrors.codes.invalid-branding',
  'insufficient-contrast': 'editor.apiErrors.codes.insufficient-contrast',
  'invalid-backup-settings': 'editor.apiErrors.codes.invalid-backup-settings',
  'secret-key-missing': 'editor.apiErrors.codes.secret-key-missing',
  'invalid-headers': 'editor.apiErrors.codes.invalid-headers',
  'header-name-duplicate': 'editor.apiErrors.codes.header-name-duplicate',
  'header-name-invalid': 'editor.apiErrors.codes.header-name-invalid',
  'header-name-refused': 'editor.apiErrors.codes.header-name-refused',
  'header-value-invalid': 'editor.apiErrors.codes.header-value-invalid',
  'header-value-required': 'editor.apiErrors.codes.header-value-required',
  'headers-too-large': 'editor.apiErrors.codes.headers-too-large',
  'too-many-headers': 'editor.apiErrors.codes.too-many-headers',
  'too-many-webhooks': 'editor.apiErrors.codes.too-many-webhooks',
  'not-configured': 'editor.apiErrors.codes.not-configured',
  'public-url-not-set': 'editor.apiErrors.codes.public-url-not-set',
  'session-expired': 'editor.apiErrors.codes.session-expired',
  'unknown-user': 'editor.apiErrors.codes.unknown-user',
  'demo-mode-off': 'editor.apiErrors.codes.demo-mode-off',
  gone: 'editor.apiErrors.codes.gone',
  'has-changes': 'editor.apiErrors.codes.has-changes',
  'too-many-locks': 'editor.apiErrors.codes.too-many-locks',
  'too-many-working-copies': 'editor.apiErrors.codes.too-many-working-copies',
  'too-many-commits': 'editor.apiErrors.codes.too-many-commits',
  'too-many-subjects': 'editor.apiErrors.codes.too-many-subjects',
  'too-many-outputs': 'editor.apiErrors.codes.too-many-outputs',
  'invalid-working-copy': 'editor.apiErrors.codes.invalid-working-copy',
  'stale-working-copy': 'editor.apiErrors.codes.stale-working-copy',
  'working-copy-changed': 'editor.apiErrors.codes.working-copy-changed',
  'subject-mismatch': 'editor.apiErrors.codes.subject-mismatch',
  'duplicate-subject': 'editor.apiErrors.codes.duplicate-subject',
  'nothing-to-delete': 'editor.apiErrors.codes.nothing-to-delete',
  'not-deletable': 'editor.apiErrors.codes.not-deletable',
  'nothing-to-revert': 'editor.apiErrors.codes.nothing-to-revert',
  'config-in-use': 'editor.apiErrors.codes.config-in-use',
  'unknown-variant': 'editor.apiErrors.codes.unknown-variant',
  'translation-missing': 'editor.apiErrors.codes.translation-missing',
  'translation-record-protected':
    'editor.apiErrors.codes.translation-record-protected',
  'export-conflict': 'editor.apiErrors.codes.export-conflict',
  'branch-exists': 'editor.apiErrors.codes.branch-exists',
  'unrelated-histories': 'editor.apiErrors.codes.unrelated-histories',
  'invalid-commit': 'editor.apiErrors.codes.invalid-commit',
  'invalid-identity': 'editor.apiErrors.codes.invalid-identity',
  'invalid-message': 'editor.apiErrors.codes.invalid-message',
  'invalid-trailer': 'editor.apiErrors.codes.invalid-trailer',
  'render-error': 'editor.apiErrors.codes.render-error',
};

const KINDS: Readonly<Record<ApiErrorKind, string>> = {
  unauthorized: 'editor.apiErrors.kinds.unauthorized',
  'not-found': 'editor.apiErrors.kinds.not-found',
  invalid: 'editor.apiErrors.kinds.invalid',
  unavailable: 'editor.apiErrors.kinds.unavailable',
  network: 'editor.apiErrors.kinds.network',
  unknown: 'editor.apiErrors.kinds.unknown',
};

const PARAMETER_CODES = new Set(['invalid-parameter', 'unsupported-parameter']);

/**
 * A `meta` value a text selects on (`{refused, select, …}`) in the form an ICU key takes: ICU
 * keys hold no hyphen, so `service-accounts` is selected as `serviceAccounts`.
 */
const SELECTED: Readonly<Record<string, string>> = {
  'sandbox-not-allowed': 'refused',
};
const icuKey = (value: string) =>
  value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** The error as a translatable text, for a toast (`toast.error(apiErrorText(e))`) or a state. */
export function apiErrorText(
  error: Pick<
    ApiError,
    'kind' | 'code' | 'parameter' | 'retryAfter' | 'errors'
  >,
): TranslatedText {
  const meta: Record<string, unknown> = { ...error.errors[0]?.meta };
  const selected = SELECTED[error.code];
  if (selected && typeof meta[selected] === 'string') {
    meta[selected] = icuKey(meta[selected]);
  }
  const params = {
    ...meta,
    parameter: error.parameter ?? '',
    retryAfter: error.retryAfter ?? 0,
  };
  // The parameter codes name the parameter: without one, the kind's text says it better.
  const byCode =
    Object.hasOwn(CODES, error.code) &&
    !(PARAMETER_CODES.has(error.code) && !error.parameter);
  const key = byCode ? CODES[error.code] : KINDS[error.kind];
  return { key: key ?? KINDS.unknown, params };
}

/** The codes with a text of their own (for the i18n test). */
export const API_ERROR_CODES_WITH_TEXT: readonly string[] = Object.keys(CODES);
