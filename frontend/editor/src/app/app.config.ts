import {
  type ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, TitleStrategy } from '@angular/router';

import { provideI18n, provideZard } from '@openfolia/ui/startup';

import { API_DEMO_USER, provideApi } from './api';
import { routes } from './app.routes';
import { BrandingService } from './branding/branding.service';
import { TranslatedTitleStrategy } from './i18n';
import { provideChangeSetUrl } from './session/change-set-url';
import { provideSessionEnd } from './permissions/me';
import { DemoSession } from './session/demo-session';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    provideApi(),
    // The demo identity: only while the API says it is in demo mode (see `DemoSession`).
    { provide: API_DEMO_USER, useFactory: () => inject(DemoSession).actingAs },
    // A refused call may mean the signed-in session ended (#37): `/me` says.
    provideSessionEnd(),
    // Who is acting and which change set is open are known before the first screen renders.
    // The shell's code (and the components it shares with every screen) is fetched meanwhile,
    // not only once `GET /me` has answered: it is no longer in the initial bundle (#494).
    provideAppInitializer(() => {
      // A failed fetch is left to the route: it imports the chunk again and reports the error.
      import('./shell/shell.layout').catch(() => undefined);
      // The branding (#169) is read meanwhile, and the first screen waits for it, so it shows
      // its name and colours without a flash of the defaults. A failed read keeps the defaults.
      const branding = inject(BrandingService).load();
      return Promise.all([inject(DemoSession).start(), branding]).then(
        () => undefined,
      );
    }),
    // `?cs=` and the session's change set kept together on every screen.
    provideChangeSetUrl(),
    provideZard(),
    // The UI language: `ui` texts from the library, `editor` texts from `src/i18n/`.
    provideI18n({ scopes: ['editor'] }),
    { provide: TitleStrategy, useClass: TranslatedTitleStrategy },
  ],
};
