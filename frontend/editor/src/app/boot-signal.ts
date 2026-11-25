import {
  DestroyRef,
  inject,
  provideEnvironmentInitializer,
  type EnvironmentProviders,
} from '@angular/core';
import { NavigationEnd, NavigationError, Router } from '@angular/router';

/** What index.html's start-up error state (#870) listens for. */
export type BootSignal = 'of-boot-failed' | 'of-booted';

export const signalBoot = (name: BootSignal): void => {
  window.dispatchEvent(new Event(name));
};

/**
 * Tells index.html how the first navigation ended: open (`of-booted`, the error state is never
 * shown after it) or failed (`of-boot-failed`: its screen's code did not load, say), which shows
 * the error state instead of an empty page. Subscribed before the router's first navigation.
 */
export function provideBootSignal(): EnvironmentProviders {
  return provideEnvironmentInitializer(() => {
    const events = inject(Router).events.subscribe((event) => {
      if (event instanceof NavigationEnd) signalBoot('of-booted');
      else if (event instanceof NavigationError) signalBoot('of-boot-failed');
      else return;
      events.unsubscribe();
    });
    inject(DestroyRef).onDestroy(() => events.unsubscribe());
  });
}
