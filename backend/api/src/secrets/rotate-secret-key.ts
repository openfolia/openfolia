import type { z } from 'zod';
import { field, text } from '../config/fields.js';
import {
  checkSecretKeyEnv,
  secretKeyBytes,
  SecretKeyEnv,
} from '../config/secret-key-env.js';
import type { Database } from '../database/database.js';
import { DrizzleUnitOfWork } from '../database/drizzle-unit-of-work.js';
import {
  type RotatedSecretKey,
  RotateSecretKeyAction,
} from './core/actions/rotate-secret-key.action.js';
import { OpenSecretKeyAction } from './core/actions/open-secret-key.action.js';
import { SecretKey } from './core/secret-key.js';
import { SealedSecretSources } from './core/secret-key-ports.js';
import { AesSecretCipher } from './repos/aes-secret-cipher.js';
import { DrizzleSecretKeyCheck } from './repos/drizzle-secret-key-check.js';
import { EnvSecretKeySettings } from './repos/env-secret-key-settings.js';
import { FsSecretKeyFile } from './repos/fs-secret-key-file.js';
import { sealedSecretSources } from './sealed-secret-sources.js';

/**
 * What the rotation reads: the key's settings, the content folder (beside
 * which the key file is by default) and the new key, when the operator
 * gives it (`CCMS_SECRET_KEY_NEW`; required for a key set by a variable).
 */
export const RotateSecretKeyEnv = SecretKeyEnv.extend({
  CCMS_CONTENT_DIR: field(text),
  CCMS_SECRET_KEY_NEW: field(secretKeyBytes.optional()),
}).superRefine(checkSecretKeyEnv);
export type RotateSecretKeySettings = z.infer<typeof RotateSecretKeyEnv>;

/**
 * Re-seals every sealed secret in `database` under a new instance key
 * (`RotateSecretKeyAction`), wired as the server wires it. For
 * `rotate-secret-key.main.ts` and its tests.
 */
export function rotateSecretKey(
  env: RotateSecretKeySettings,
  database: Database,
): Promise<RotatedSecretKey> {
  const settings = new EnvSecretKeySettings(env);
  const file = new FsSecretKeyFile(settings.file);
  const cipher = new AesSecretCipher();
  const sources = new SealedSecretSources(sealedSecretSources());
  const check = new DrizzleSecretKeyCheck();
  const unit = new DrizzleUnitOfWork(database);
  const open = new OpenSecretKeyAction(
    settings,
    file,
    cipher,
    sources,
    check,
    unit,
  );
  return new RotateSecretKeyAction(
    open,
    file,
    cipher,
    sources,
    check,
    unit,
  ).handle(
    env.CCMS_SECRET_KEY_NEW
      ? { next: new SecretKey(env.CCMS_SECRET_KEY_NEW) }
      : {},
  );
}
