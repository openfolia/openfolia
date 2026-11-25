import { bootstrapApplication } from '@angular/platform-browser';

import { App } from './app/app';
import { appConfig } from './app/app.config';
import { signalBoot } from './app/boot-signal';

bootstrapApplication(App, appConfig).catch((error: unknown) => {
  console.error(error);
  // index.html shows its start-up error state (#870) instead of an empty page.
  signalBoot('of-boot-failed');
});
