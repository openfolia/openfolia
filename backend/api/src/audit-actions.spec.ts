import {
  AUDIT_ACTIONS,
  type AuditActionName,
} from './audit/core/audit-actions.js';
import { REGISTERED_AUDIT_ACTIONS } from './audit-actions.js';
import { definedGroups } from '../tests/registered-groups.js';

// Every action the audit log took before the components registered their own, each with the
// component that writes it. The catalogue is sorted, whatever order the components register in.
// A change here changes what `AuditLog.record` accepts and what the editor's audit log names.
const TODAY: Readonly<Record<string, readonly string[]>> = {
  access: [
    'group-mapping.create',
    'group-mapping.delete',
    'role.assign',
    'role.create',
    'role.delete',
    'role.unassign',
    'role.update',
    'service-account.create',
    'service-account.deactivate',
    'service-account.reactivate',
    'service-account.update',
    'service-token.issue',
    'service-token.revoke',
    'settings.sign-ins-ended',
    'user.break-glass-sign-in',
    'user.create',
    'user.deactivate',
    'user.email-code-requested',
    'user.identity-link',
    'user.invite',
    'user.invite-withdraw',
    'user.password-changed',
    'user.password-reset-requested',
    'user.password-set',
    'user.reactivate',
    'user.second-factor-off',
    'user.second-factor-on',
    'user.second-factor-recovery-codes',
    'user.second-factor-reset',
    'user.sign-in',
    'user.sign-out',
    'user.update',
  ],
  assets: ['asset.delete', 'asset.upload'],
  audit: ['api.read', 'api.read-gap', 'audit-log.export', 'audit-log.prune'],
  backups: [
    'backup-key.create',
    'backup-key.rotate',
    'backup-settings.update',
    'backup.request',
  ],
  branding: [
    'branding.image-delete',
    'branding.image-upload',
    'branding.update',
  ],
  'change-sets': [
    'change-set.abandon',
    'change-set.approve',
    'change-set.carry-forward',
    'change-set.commit',
    'change-set.create',
    'change-set.edit',
    'change-set.merge',
    'change-set.rebase',
    'change-set.refresh',
    'change-set.return',
    'change-set.revert',
    'change-set.sign-off',
    'change-set.submit',
    'config.delete',
    'config.write',
    'design.delete',
    'design.write',
    'lock.acquire',
    'lock.break',
    'lock.release',
    'manual.delete',
    'manual.write',
    'module.delete',
    'module.rename',
    'module.write',
    'template.delete',
    'template.write',
    'term.delete',
    'term.write',
  ],
  comments: [
    'comment.create',
    'comment.delete',
    'comment.edit',
    'comment.reopen',
    'comment.resolve',
  ],
  imports: ['import.apply'],
  mail: ['mail.failed', 'mail.sent', 'mail.test'],
  notifications: ['notification.unsubscribe'],
  releases: [
    'maintenance-line.close',
    'maintenance-line.start',
    'release.output-retry',
    'release.outputs-plan',
    'release.publish',
    'release.withdraw',
  ],
  scim: [
    'scim-group.create',
    'scim-group.delete',
    'scim-group.update',
    'user.identity-unlink',
  ],
  settings: [
    'settings.break-glass',
    'settings.second-factor',
    'settings.self-approval',
    'settings.session-limits',
    'settings.single-sign-on',
  ],
  'storage-usage': ['storage.limit-change', 'storage.upload-refused'],
  'style-review': ['module.style-review'],
  translations: [
    'translation-job.cancel',
    'translation-job.export',
    'translation.import',
    'translation.mark-current',
  ],
  webhooks: [
    'webhook.create',
    'webhook.delete',
    'webhook.disable',
    'webhook.retry',
    'webhook.rotate-secret',
    'webhook.test',
    'webhook.update',
  ],
};

// The catalogue as it was, in its order.
const CATALOGUE = [
  'api.read',
  'api.read-gap',
  'asset.delete',
  'asset.upload',
  'audit-log.export',
  'audit-log.prune',
  'backup-key.create',
  'backup-key.rotate',
  'backup-settings.update',
  'backup.request',
  'branding.image-delete',
  'branding.image-upload',
  'branding.update',
  'change-set.abandon',
  'change-set.approve',
  'change-set.carry-forward',
  'change-set.commit',
  'change-set.create',
  'change-set.edit',
  'change-set.merge',
  'change-set.rebase',
  'change-set.refresh',
  'change-set.return',
  'change-set.revert',
  'change-set.sign-off',
  'change-set.submit',
  'comment.create',
  'comment.delete',
  'comment.edit',
  'comment.reopen',
  'comment.resolve',
  'config.delete',
  'config.write',
  'design.delete',
  'design.write',
  'group-mapping.create',
  'group-mapping.delete',
  'import.apply',
  'lock.acquire',
  'lock.break',
  'lock.release',
  'mail.failed',
  'mail.sent',
  'mail.test',
  'maintenance-line.close',
  'maintenance-line.start',
  'manual.delete',
  'manual.write',
  'module.delete',
  'module.rename',
  'module.style-review',
  'module.write',
  'notification.unsubscribe',
  'release.output-retry',
  'release.outputs-plan',
  'release.publish',
  'release.withdraw',
  'role.assign',
  'role.create',
  'role.delete',
  'role.unassign',
  'role.update',
  'scim-group.create',
  'scim-group.delete',
  'scim-group.update',
  'service-account.create',
  'service-account.deactivate',
  'service-account.reactivate',
  'service-account.update',
  'service-token.issue',
  'service-token.revoke',
  'settings.break-glass',
  'settings.second-factor',
  'settings.self-approval',
  'settings.session-limits',
  'settings.sign-ins-ended',
  'settings.single-sign-on',
  'storage.limit-change',
  'storage.upload-refused',
  'template.delete',
  'template.write',
  'term.delete',
  'term.write',
  'translation-job.cancel',
  'translation-job.export',
  'translation.import',
  'translation.mark-current',
  'user.break-glass-sign-in',
  'user.create',
  'user.deactivate',
  'user.email-code-requested',
  'user.identity-link',
  'user.identity-unlink',
  'user.invite',
  'user.invite-withdraw',
  'user.password-changed',
  'user.password-reset-requested',
  'user.password-set',
  'user.reactivate',
  'user.second-factor-off',
  'user.second-factor-on',
  'user.second-factor-recovery-codes',
  'user.second-factor-reset',
  'user.sign-in',
  'user.sign-out',
  'user.update',
  'webhook.create',
  'webhook.delete',
  'webhook.disable',
  'webhook.retry',
  'webhook.rotate-secret',
  'webhook.test',
  'webhook.update',
];

describe('the registered audit actions', () => {
  it('yields exactly the actions there were, each with the component that writes it', () => {
    const byGroup: Record<string, string[]> = {};
    for (const { action, group } of REGISTERED_AUDIT_ACTIONS)
      (byGroup[group] ??= []).push(action);
    expect(byGroup).toEqual(TODAY);
  });

  it('names each group after the component whose folder defines it, so none passes for another', async () => {
    const groups = await definedGroups('./audit-actions.ts');
    expect(groups.map((g) => g.folder).sort()).toEqual(
      Object.keys(TODAY).sort(),
    );
    for (const { folder, group } of groups) expect(group).toBe(folder);
    // Each registered action under the group of the file that defines it.
    expect(
      groups.flatMap((g) => g.members.map((m) => `${g.group} ${m}`)).sort(),
    ).toEqual(
      REGISTERED_AUDIT_ACTIONS.map((a) => `${a.group} ${a.action}`).sort(),
    );
  });

  it('gives the audit log the same catalogue, in the same order', () => {
    expect([...AUDIT_ACTIONS]).toEqual(CATALOGUE);
  });

  it('keeps the actions literal, so recording one nobody registered does not compile', () => {
    // @ts-expect-error: no component registers it.
    const unknown: AuditActionName = 'manual.fly';
    expect(AUDIT_ACTIONS).not.toContain(unknown);
  });

  it('cannot be changed once registered', () => {
    expect(Object.isFrozen(REGISTERED_AUDIT_ACTIONS)).toBe(true);
    expect(REGISTERED_AUDIT_ACTIONS.every((a) => Object.isFrozen(a))).toBe(
      true,
    );
    expect(Object.isFrozen(AUDIT_ACTIONS)).toBe(true);
  });
});
