import { describe, expect, it } from 'vitest';
import { actorWith } from '../../../tests/fakes/actors.js';
import { CreateServiceAccountAction } from '../../access/core/actions/create-service-account.action.js';
import { CreateUserAction } from '../../access/core/actions/create-user.action.js';
import { IssueServiceTokenAction } from '../../access/core/actions/service-tokens.action.js';
import { CreateSignInLinkAction } from '../../access/core/actions/sign-in-links.action.js';
import { PERMISSIONS } from '../../access/core/permissions.js';
import { UploadAssetAction } from '../../assets/core/actions/upload-asset.action.js';
import {
  CreateBackupKeyAction,
  RequestBackupAction,
  UpdateBackupSettingsAction,
} from '../../backups/core/actions/manage-backups.action.js';
import { UploadBrandingImageAction } from '../../branding/core/actions/upload-branding-image.action.js';
import { SaveWorkingCopyAction } from '../../change-sets/core/actions/save-working-copy.action.js';
import { ApplyImportAction } from '../../imports/core/actions/apply-import.action.js';
import { CreateImportAction } from '../../imports/core/actions/create-import.action.js';
import { SendTestMailAction } from '../../mail/core/actions/mail-settings.actions.js';
import {
  ApplyTranslationImportAction,
  ValidateTranslationImportAction,
} from '../../translations/core/actions/translation-imports.action.js';
import {
  CreateWebhookAction,
  RotateWebhookSecretAction,
  UpdateWebhookAction,
} from '../../webhooks/core/actions/manage-webhooks.action.js';
import {
  RetryWebhookDeliveryAction,
  TestWebhookAction,
} from '../../webhooks/core/actions/test-webhook.action.js';
import {
  Sandbox,
  SandboxNotAllowedError,
  type SandboxRefusal,
} from './sandbox.js';

/** Holds every permission: a refusal is the sandbox's, never a missing permission. */
const EVERYTHING = actorWith([...PERMISSIONS]);

const SANDBOX = Sandbox.on({
  limits: {
    moduleBytes: 1_000,
    commentLength: 100,
    changeSets: 5,
    modules: 5,
    manuals: 5,
    releasesPerHour: 5,
    renderJobs: 1,
    writeBytes: 1_000_000,
  },
  lifetime: { idleMinutes: 30, maxMinutes: 90 },
});

/**
 * A dependency that must not be used: any member read (a store, an outbox, a sender, the unit
 * of work) is recorded, so a refusal is proved to come before anything is read, written or sent.
 */
function tripwire(touched: string[], name: string): unknown {
  return new Proxy(
    {},
    {
      get(_target, member) {
        // A promise check (`await dep`) is no use of it.
        if (member === 'then') return undefined;
        touched.push(`${name}.${String(member)}`);
        throw new Error(`${name}.${String(member)} was used`);
      },
    },
  );
}

type ActionClass = new (...deps: never[]) => {
  handle(input: never): Promise<unknown>;
};

/** The action with a tripwire for each dependency (every parameter but the sandbox, its last). */
function build(Action: ActionClass, touched: string[]) {
  // `length` counts the parameters before the first with a default: the sandbox's.
  const deps = Array.from({ length: Action.length }, (_, i) =>
    tripwire(touched, `${Action.name}#${i}`),
  );
  return new Action(...(deps as never[]), SANDBOX as never);
}

const REFUSED: readonly (readonly [ActionClass, SandboxRefusal, object?])[] = [
  [CreateUserAction, 'users'],
  [CreateServiceAccountAction, 'service-accounts'],
  [IssueServiceTokenAction, 'tokens'],
  [CreateSignInLinkAction, 'invitations'],
  [UploadAssetAction, 'uploads'],
  [UploadBrandingImageAction, 'uploads'],
  [CreateImportAction, 'imports'],
  [ApplyImportAction, 'imports'],
  [ValidateTranslationImportAction, 'imports'],
  [ApplyTranslationImportAction, 'imports'],
  [CreateWebhookAction, 'webhooks'],
  [UpdateWebhookAction, 'webhooks'],
  [RotateWebhookSecretAction, 'webhooks'],
  [TestWebhookAction, 'webhooks'],
  [RetryWebhookDeliveryAction, 'webhooks'],
  [SendTestMailAction, 'mail'],
  [UpdateBackupSettingsAction, 'backups'],
  [CreateBackupKeyAction, 'backups'],
  [RequestBackupAction, 'backups'],
  [
    SaveWorkingCopyAction,
    'templates',
    {
      changeSetId: 'cs-1',
      subject: { type: 'template', templateId: 'own', path: 'main.typ' },
      content: { text: '#set page(width: 1cm)' },
      version: 0,
    },
  ],
];

describe('a public sandbox refuses (#826)', () => {
  it.each(
    REFUSED.map(
      ([Action, what, input]) => [Action.name, Action, what, input] as const,
    ),
  )(
    '%s: 403 sandbox-not-allowed before touching anything',
    async (_name, Action, what, input) => {
      const touched: string[] = [];
      const action = build(Action, touched);
      const error = await action
        .handle({ actor: EVERYTHING, ...input } as never)
        .then(
          () => undefined,
          (thrown: unknown) => thrown,
        );
      expect(error).toBeInstanceOf(SandboxNotAllowedError);
      expect(error).toMatchObject({
        code: 'sandbox-not-allowed',
        meta: { refused: what },
      });
      expect(touched).toEqual([]);
    },
  );

  it('each only once the actor may do it: without the permission, the permission’s 403', async () => {
    const touched: string[] = [];
    const action = build(CreateUserAction, touched);
    await expect(
      action.handle({ actor: actorWith(['content.read']) } as never),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('off, the same actions run on (to their dependencies)', async () => {
    const touched: string[] = [];
    const deps = Array.from({ length: CreateUserAction.length }, (_, i) =>
      tripwire(touched, `dep${i}`),
    );
    const action = new CreateUserAction(
      ...(deps as never as [never, never, never]),
    );
    await action
      .handle({
        actor: EVERYTHING,
        user: { id: 'u', name: 'U', email: null },
        roleIds: [],
      })
      .catch(() => undefined);
    expect(touched.length).toBeGreaterThan(0);
  });
});
