import { Module } from '@nestjs/common';
import { PreferencesController } from './api/preferences.controller.js';
import { GetPreferencesAction } from './core/actions/get-preferences.action.js';
import { UpdatePreferencesAction } from './core/actions/update-preferences.action.js';
import { PreferenceStore } from './core/preference-store.js';
import { DrizzlePreferenceStore } from './repos/drizzle-preference-store.js';

/** Each person's own preferences (#222): `/me/preferences`, the editor's tips and tour. */
@Module({
  controllers: [PreferencesController],
  providers: [
    GetPreferencesAction,
    UpdatePreferencesAction,
    { provide: PreferenceStore, useClass: DrizzlePreferenceStore },
  ],
})
export class PreferencesModule {}
