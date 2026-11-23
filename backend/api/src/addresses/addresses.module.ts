import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AssetsModule } from '../assets/assets.module.js';
import { ContentModule } from '../content/content.module.js';
import { PreviewModule } from '../preview/preview.module.js';
import type { Env } from '../config/env.js';
import { ReleasesModule } from '../releases/releases.module.js';
import {
  StableAddressesController,
  StableAddressListController,
} from './api/stable-addresses.controller.js';
import { ListStableAddressesAction } from './core/actions/list-stable-addresses.action.js';
import { DeliveryLimit } from './core/delivery-limit.js';
import {
  OpenStableAddressAction,
  StableAddressAccessAction,
  StableAddressPdfAction,
} from './core/actions/open-stable-address.action.js';

/**
 * Stable addresses (#450): `/d/<product>/<manual>/<variant>/<lang>`, a manual at its
 * product's latest release (or a pinned one), its PDF and QR codes, and
 * `GET /stable-addresses`. `StableAddressSettings` comes from
 * `StableAddressSettingsModule` (global), `BlobStore` from `BlobsModule` (global). The rate
 * limit under `/d/` (`DeliveryLimit`, #574) is `CCMS_DELIVERY_PER_MINUTE`.
 */
@Module({
  imports: [ContentModule, ReleasesModule, PreviewModule, AssetsModule],
  controllers: [StableAddressesController, StableAddressListController],
  providers: [
    StableAddressAccessAction,
    OpenStableAddressAction,
    StableAddressPdfAction,
    ListStableAddressesAction,
    {
      provide: DeliveryLimit,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new DeliveryLimit(
          config.get('CCMS_DELIVERY_PER_MINUTE', { infer: true }),
        ),
    },
  ],
})
export class AddressesModule {}
