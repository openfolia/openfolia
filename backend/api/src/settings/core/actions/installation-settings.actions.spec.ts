import { actorWith } from '../../../../tests/fakes/actors.js';
import { FakeAuditLog } from '../../../../tests/fakes/fake-audit-log.js';
import { FakeInstallationSettingsStore } from '../../../../tests/fakes/fake-installation-settings-store.js';
import { FakeUnitOfWork } from '../../../../tests/fakes/fake-unit-of-work.js';
import { ForbiddenError } from '../../../base/core/errors.js';
import { allowsSelf } from '../../../change-sets/core/self-approval.js';
import { StoredSelfApprovalRule } from '../stored-self-approval-rule.js';
import { GetInstallationSettingsAction } from './get-installation-settings.action.js';
import { UpdateInstallationSettingsAction } from './update-installation-settings.action.js';

const admin = { ...actorWith(['admin.roles']), id: 'admin' };
const reviewer = {
  ...actorWith(['content.read', 'content.review', 'admin.branding']),
  id: 'reviewer',
};

function setup() {
  const store = new FakeInstallationSettingsStore();
  const audit = new FakeAuditLog();
  const unit = new FakeUnitOfWork();
  return {
    store,
    audit,
    get: new GetInstallationSettingsAction(store),
    update: new UpdateInstallationSettingsAction(store, audit, unit),
    rule: new StoredSelfApprovalRule(store),
  };
}

describe('GetInstallationSettingsAction', () => {
  it('answers four eyes before any change', async () => {
    const { get } = setup();
    expect(await get.handle({ actor: admin })).toEqual({
      settings: { selfApproval: 'never' },
      version: 0,
      updatedAt: null,
    });
  });

  it('needs admin.roles', async () => {
    const { get } = setup();
    await expect(get.handle({ actor: reviewer })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });
});

describe('UpdateInstallationSettingsAction', () => {
  it('changes the self-approval rule and audits it, from and to', async () => {
    const { update, audit, rule } = setup();
    const written = await update.handle({
      actor: admin,
      changes: { selfApproval: 'review' },
    });
    expect(written.settings.selfApproval).toBe('review');
    expect(written.version).toBe(1);
    expect(await rule.read()).toBe('review');
    expect(audit.events).toMatchObject([
      {
        action: 'settings.self-approval',
        subject: { type: 'settings', id: 'installation' },
        actor: { kind: 'user', id: 'admin' },
        data: { from: 'never', to: 'review' },
      },
    ]);
  });

  it('records nothing when nothing changes', async () => {
    const { update, audit, store } = setup();
    await update.handle({ actor: admin, changes: { selfApproval: 'never' } });
    await update.handle({ actor: admin, changes: {} });
    expect(audit.events).toEqual([]);
    expect(store.stored.version).toBe(0);
    expect(store.locks).toBe(2);
  });

  it('refuses anyone without admin.roles, writing nothing', async () => {
    const { update, audit, store } = setup();
    await expect(
      update.handle({
        actor: reviewer,
        changes: { selfApproval: 'review-and-sign-off' },
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(audit.events).toEqual([]);
    expect(store.locks).toBe(0);
    expect(store.stored.settings.selfApproval).toBe('never');
  });
});

describe('allowsSelf', () => {
  it('lifts the author check for approve with review, for both with review-and-sign-off', () => {
    expect(allowsSelf('never', 'approve')).toBe(false);
    expect(allowsSelf('never', 'sign-off')).toBe(false);
    expect(allowsSelf('review', 'approve')).toBe(true);
    expect(allowsSelf('review', 'sign-off')).toBe(false);
    expect(allowsSelf('review-and-sign-off', 'approve')).toBe(true);
    expect(allowsSelf('review-and-sign-off', 'sign-off')).toBe(true);
  });
});
