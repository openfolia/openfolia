import { randomUUID } from 'node:crypto';
import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';
import { StableAddressSettings } from './core/stable-address.js';

/**
 * `StableAddressSettings` (`CCMS_PUBLIC_URL`, #450; `CCMS_DELIVERY_MAX_ACCESS` and
 * `CCMS_DELIVERY_IGNORED_QUERY`, #553; `CCMS_DELIVERY_SHARED_MAX_AGE` and `CCMS_BUILD_ID`, #552) for every component: the addresses and
 * the release outputs, whose PDFs can print a QR code of one, without either importing the
 * other's module.
 */
@Global()
@Module({
  providers: [
    {
      provide: StableAddressSettings,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<Env, true>,
      ): StableAddressSettings => ({
        publicUrl: config.get('CCMS_PUBLIC_URL', { infer: true }),
        maxAccess: config.get('CCMS_DELIVERY_MAX_ACCESS', { infer: true }),
        ignoredQuery: config.get('CCMS_DELIVERY_IGNORED_QUERY', {
          infer: true,
        }),
        sharedMaxAge: config.get('CCMS_DELIVERY_SHARED_MAX_AGE', {
          infer: true,
        }),
        // Without one, this process's own: a restart (perhaps a new build) never serves a
        // page for another build's ETag.
        buildId: config.get('CCMS_BUILD_ID', { infer: true }) ?? randomUUID(),
      }),
    },
  ],
  exports: [StableAddressSettings],
})
export class StableAddressSettingsModule {}
