import {
  type EnvironmentProviders,
  makeEnvironmentProviders,
} from '@angular/core';
import { EVENT_MANAGER_PLUGINS } from '@angular/platform-browser';

import { ZardEventManagerPlugin } from './event-manager-plugins/zard-event-manager-plugin';

/**
 * Registers what Zard's templates rely on: the event modifier syntax (`(keydown.{enter,space}.prevent)`,
 * `(click.prevent-with-stop)`). Without it the select, command and dropdown menu receive no keys.
 * Every app that uses these components, and every test that renders them, provides it.
 * (Zard's debounce plugin is not installed: nothing here uses it.)
 */
export function provideZard(): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: EVENT_MANAGER_PLUGINS,
      useClass: ZardEventManagerPlugin,
      multi: true,
    },
  ]);
}
