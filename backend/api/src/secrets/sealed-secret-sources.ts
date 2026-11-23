import type { SealedSecretSource } from '../base/core/secret-sealer.js';
import {
  BackupIdentitySealedSecretSource,
  BackupS3SealedSecretSource,
} from '../backups/repos/sealed-backup-secrets.js';
import { MailSealedSecretSource } from '../mail/repos/drizzle-mail-store.js';
import {
  WebhookHeaderSealedSecretSource,
  WebhookSealedSecretSource,
} from '../webhooks/repos/sealed-webhook-secrets.js';

/**
 * Every kind of sealed secret the database holds, checked against the
 * instance key at start-up and re-sealed by its rotation (#470). A
 * component that stores sealed secrets (`SecretSealer`) adds its
 * `SealedSecretSource` here, or a lost key would go unnoticed for its
 * values and a rotation would leave them unreadable.
 */
export function sealedSecretSources(): SealedSecretSource[] {
  return [
    new WebhookSealedSecretSource(),
    new WebhookHeaderSealedSecretSource(),
    new BackupS3SealedSecretSource(),
    new BackupIdentitySealedSecretSource(),
    new MailSealedSecretSource(),
  ];
}
