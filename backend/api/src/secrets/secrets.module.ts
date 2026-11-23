import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretSealer } from '../base/core/secret-sealer.js';
import type { Env } from '../config/env.js';
import { SecretKeyController } from './api/secret-key.controller.js';
import { SecretKeyGate } from './api/secret-key-gate.js';
import { GetSecretKeyAction } from './core/actions/get-secret-key.action.js';
import { OpenSecretKeyAction } from './core/actions/open-secret-key.action.js';
import { InstanceSecretKey } from './core/instance-secret-key.js';
import {
  SealedSecretSources,
  SecretCipher,
  SecretKeyCheck,
  SecretKeyFile,
  SecretKeySettings,
} from './core/secret-key-ports.js';
import { AesSecretCipher } from './repos/aes-secret-cipher.js';
import { DrizzleSecretKeyCheck } from './repos/drizzle-secret-key-check.js';
import { EnvSecretKeySettings } from './repos/env-secret-key-settings.js';
import { FsSecretKeyFile } from './repos/fs-secret-key-file.js';
import { sealedSecretSources } from './sealed-secret-sources.js';

/**
 * The instance secret key (#470): global, so a component that stores
 * secrets injects `SecretSealer` (`base/core/secret-sealer.ts`). The key
 * is opened and checked as the server starts (`SecretKeyGate`); `GET
 * /secret-key` says where it is. See `backend/api/README.md`, "Secrets".
 */
@Global()
@Module({
  controllers: [SecretKeyController],
  providers: [
    {
      provide: SecretKeySettings,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new EnvSecretKeySettings({
          CCMS_CONTENT_DIR: config.get('CCMS_CONTENT_DIR', { infer: true }),
          CCMS_SECRET_KEY: config.get('CCMS_SECRET_KEY', { infer: true }),
          CCMS_WEBHOOKS_SECRET_KEY: config.get('CCMS_WEBHOOKS_SECRET_KEY', {
            infer: true,
          }),
          CCMS_SECRET_KEY_FILE: config.get('CCMS_SECRET_KEY_FILE', {
            infer: true,
          }),
          CCMS_SECRET_KEY_GENERATE: config.get('CCMS_SECRET_KEY_GENERATE', {
            infer: true,
          }),
        }),
    },
    {
      provide: SecretKeyFile,
      inject: [SecretKeySettings],
      useFactory: (settings: SecretKeySettings) =>
        new FsSecretKeyFile(settings.file),
    },
    { provide: SecretCipher, useClass: AesSecretCipher },
    { provide: SecretKeyCheck, useClass: DrizzleSecretKeyCheck },
    {
      provide: SealedSecretSources,
      useFactory: () => new SealedSecretSources(sealedSecretSources()),
    },
    {
      provide: InstanceSecretKey,
      inject: [SecretCipher],
      useFactory: (cipher: SecretCipher) => new InstanceSecretKey(cipher),
    },
    { provide: SecretSealer, useExisting: InstanceSecretKey },
    OpenSecretKeyAction,
    GetSecretKeyAction,
    SecretKeyGate,
  ],
  exports: [SecretSealer, InstanceSecretKey],
})
export class SecretsModule {}
