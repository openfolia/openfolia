import {
  defaultSecretKeyFile,
  type SecretKeySettings as SecretKeyEnvSettings,
} from '../../config/secret-key-env.js';
import { SecretKey, type SecretKeyVariable } from '../core/secret-key.js';
import { SecretKeySettings } from '../core/secret-key-ports.js';

/** `SecretKeySettings` from the validated settings (`config/secret-key-env.ts`). */
export class EnvSecretKeySettings extends SecretKeySettings {
  readonly configured:
    | { readonly key: SecretKey; readonly variable: SecretKeyVariable }
    | undefined;
  readonly file: string;
  readonly generate: boolean;

  constructor(env: SecretKeyEnvSettings & { CCMS_CONTENT_DIR: string }) {
    super();
    // The new name first; the old one (the same key, `checkSecretKeyEnv`) when only it is set.
    this.configured = env.CCMS_SECRET_KEY
      ? { key: new SecretKey(env.CCMS_SECRET_KEY), variable: 'CCMS_SECRET_KEY' }
      : env.CCMS_WEBHOOKS_SECRET_KEY
        ? {
            key: new SecretKey(env.CCMS_WEBHOOKS_SECRET_KEY),
            variable: 'CCMS_WEBHOOKS_SECRET_KEY',
          }
        : undefined;
    this.file =
      env.CCMS_SECRET_KEY_FILE ?? defaultSecretKeyFile(env.CCMS_CONTENT_DIR);
    this.generate = env.CCMS_SECRET_KEY_GENERATE;
  }
}
