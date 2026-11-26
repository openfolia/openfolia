import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AccessModule } from '../access/access.module.js';
import type { Env } from '../config/env.js';
import { MailModule } from '../mail/mail.module.js';
import { PreferencesController } from './api/preferences.controller.js';
import {
  GetPreferencesAction,
  PreferencesViews,
} from './core/actions/get-preferences.action.js';
import { UpdatePreferencesAction } from './core/actions/update-preferences.action.js';
import {
  FixedNotificationEmailOptions,
  NotificationEmailOptions,
} from './core/notification-email-options.js';
import { PreferenceStore } from './core/preference-store.js';
import { DrizzlePreferenceStore } from './repos/drizzle-preference-store.js';

/**
 * Each person's own preferences (#222): `/me/preferences`, the editor's tips and tour, and how
 * notifications reach them (#884; the notifications component reads them).
 */
@Module({
  imports: [AccessModule, MailModule],
  controllers: [PreferencesController],
  providers: [
    GetPreferencesAction,
    UpdatePreferencesAction,
    PreferencesViews,
    { provide: PreferenceStore, useClass: DrizzlePreferenceStore },
    {
      provide: NotificationEmailOptions,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) =>
        new FixedNotificationEmailOptions(
          config.get('CCMS_NOTIFICATIONS_DIGEST_HOUR', { infer: true }),
          config.get('CCMS_NOTIFICATIONS_EMAILS_PER_HOUR', { infer: true }),
        ),
    },
  ],
  exports: [PreferenceStore, NotificationEmailOptions],
})
export class PreferencesModule {}
