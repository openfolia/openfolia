import { Location } from '@angular/common';
import { afterNextRender, effect, inject, Injector } from '@angular/core';
import { Router } from '@angular/router';

/** What a declarative overlay (sheet, dialog, alert dialog) does on Back and Forward. */
export interface OverlayNavigation {
  /**
   * Calls `onPop` on every Back or Forward (the browser's `popstate`, and `hashchange`, as the
   * CDK's `disposeOnNavigation`) until the returned function is called.
   */
  listen(onPop: () => void): () => void;
  /**
   * Calls `run` once the router has taken up the Back or Forward under way, finished it and the
   * page has rendered the new address: a write to the address from `run` (a host closing on
   * `zVisibleChange`) then builds on the new one instead of racing it. Returns a cancel.
   */
  afterSettled(run: () => void): () => void;
}

/**
 * Back and Forward for a declarative overlay, used in place of the CDK's `disposeOnNavigation`.
 * That one disposes the overlay inside the `popstate` without telling the component, which then
 * still says open with nothing on screen; telling it there (`zVisibleChange`) makes a host that
 * writes the address on close do so while the router still handles Back, against the old address.
 *
 * So an overlay closes itself on a pop as on an own close (its exit transition, the focus back)
 * and reports the close only once the navigation has settled, and only if its host still says
 * open then (an address-driven host's binding has followed the address by then).
 *
 * Call it in the component's injection context.
 */
export function injectOverlayNavigation(): OverlayNavigation {
  const location = inject(Location);
  const router = inject(Router);
  const injector = inject(Injector);

  return {
    listen(onPop) {
      const subscription = location.subscribe(() => onPop());
      return () => subscription.unsubscribe();
    },

    afterSettled(run) {
      let cancelled = false;
      let stop = (): void => undefined;
      // The router takes a `popstate` up in a timeout of its own (it subscribed to `Location`
      // before any overlay did, so its timeout runs first): only after it is the navigation
      // under way to be seen.
      const timer = setTimeout(() => {
        const watcher = effect(
          () => {
            if (router.currentNavigation() !== null) return;
            watcher.destroy();
            // After the next render: the host's bindings then hold the new address.
            const render = afterNextRender(
              () => {
                if (!cancelled) run();
              },
              { injector },
            );
            stop = () => render.destroy();
          },
          { injector },
        );
        stop = () => watcher.destroy();
      });

      return () => {
        cancelled = true;
        clearTimeout(timer);
        stop();
      };
    },
  };
}
