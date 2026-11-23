import type { Routes } from '@angular/router';

/**
 * Imports the code of every lazily loaded route under `routes` (`loadComponent`, and the routes
 * `loadChildren` gives, down to the last level), so a later navigation finds it loaded.
 *
 * For a spec that navigates the app's own routes: the first navigation to a screen otherwise
 * pays for importing its chunk, which the test runner transforms on first use, inside that
 * test's timeout. On a loaded machine that cold start alone ran past Vitest's 5 s default
 * (#499). Called in a `beforeAll` with a timeout of its own, the cost moves there, once per file.
 */
export async function loadLazyRoutes(routes: Routes): Promise<void> {
  await Promise.all(
    routes.map(async (route) => {
      const [, children] = await Promise.all([
        route.loadComponent?.(),
        route.loadChildren?.(),
      ]);
      await Promise.all([
        loadLazyRoutes(route.children ?? []),
        loadLazyRoutes(Array.isArray(children) ? children : []),
      ]);
    }),
  );
}
