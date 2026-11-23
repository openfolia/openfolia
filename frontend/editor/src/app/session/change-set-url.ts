import {
  computed,
  effect,
  inject,
  Injectable,
  Injector,
  provideEnvironmentInitializer,
  untracked,
  type EnvironmentProviders,
} from '@angular/core';
import {
  NavigationEnd,
  NavigationStart,
  Router,
  type ActivatedRouteSnapshot,
  type Routes,
} from '@angular/router';
import { filter } from 'rxjs';

import { baseTree } from '../view-state/query-state';
import { isChangeSetId } from './change-set-id';
import { ChangeSetSession } from './change-set-session';

/** The query parameter that names the change set a screen shows. */
export const CHANGE_SET_PARAM = 'cs';

/**
 * What `cs` means on a route (`data.changeSetParam`, the deepest route that says wins):
 * `session`, the change set the session reads and edits in (kept in the address by
 * `ChangeSetUrl`); `own`, the screen's own selection (the review screen's change set under
 * review), which `ChangeSetUrl` leaves alone. Routes that say nothing (sign-in) have no `cs`.
 */
export type ChangeSetParamMode = 'session' | 'own';

const INVALID = Symbol('invalid');

/** The first path segments of the routes whose `cs` is their own. */
function ownPaths(routes: Routes, out = new Set<string>()): Set<string> {
  for (const route of routes) {
    if (route.data?.['changeSetParam'] === 'own' && route.path) {
      out.add(route.path.split('/')[0] ?? '');
    }
    if (route.children) ownPaths(route.children, out);
  }
  return out;
}

/** What `cs` means on the active route (`data.changeSetParam`, the deepest that says wins). */
export function changeSetModeOf(
  root: ActivatedRouteSnapshot,
): ChangeSetParamMode | undefined {
  let mode: ChangeSetParamMode | undefined;
  for (
    let node: ActivatedRouteSnapshot | null = root;
    node;
    node = node.firstChild
  ) {
    const own = node.routeConfig?.data?.['changeSetParam'] as
      ChangeSetParamMode | undefined;
    if (own) mode = own;
  }
  return mode;
}

/**
 * Keeps `?cs=` and the session's change set together on every screen whose route says `session`.
 * The address wins: a link with `cs` chooses that change set (from this person's list only; one
 * they may not see falls back to the released content, with a notice), Back or Forward to an entry
 * without `cs` chooses none. Without `cs`, the session's choice (this tab's, else the last used)
 * is written into the address, replacing the entry. A choice the person makes (the picker, the
 * palette, a start) adds a history entry; any other change replaces it. Invalid values are
 * dropped; none chosen is left out.
 */
@Injectable({ providedIn: 'root' })
export class ChangeSetUrl {
  private readonly router = inject(Router);
  private readonly session = inject(ChangeSetSession);
  private readonly injector = inject(Injector);
  private started = false;
  /** The navigation that ended last came from Back or Forward. */
  private popped = false;
  /** The session's choice as last agreed with the address (undefined: not yet). */
  private synced: string | null | undefined = undefined;

  /**
   * For app links (`[queryParams]`, `router.navigate`): the session's change set, so a link
   * keeps it, also when copied or opened in a new tab.
   */
  readonly params = computed((): Record<string, string> => {
    const chosen = this.session.selected();
    return chosen?.branch ? { [CHANGE_SET_PARAM]: chosen.id } : {};
  });

  /**
   * `params` for a link to this path, or none when `cs` means something else there (`own`, the
   * review screen's change set under review).
   */
  paramsFor(link: string | readonly unknown[]): Record<string, string> {
    const path = typeof link === 'string' ? link : link.join('/');
    const first = path.split(/[/?#]/).find((s) => s !== '') ?? '';
    return ownPaths(this.router.config).has(first) ? {} : this.params();
  }

  /** Starts keeping them together (once; `provideChangeSetUrl` does it at start-up). */
  start(): void {
    if (this.started) return;
    this.started = true;
    let trigger: NavigationStart['navigationTrigger'];
    this.router.events
      .pipe(
        filter(
          (e): e is NavigationStart | NavigationEnd =>
            e instanceof NavigationStart || e instanceof NavigationEnd,
        ),
      )
      .subscribe((e) => {
        if (e instanceof NavigationStart) {
          trigger = e.navigationTrigger;
          return;
        }
        this.popped = trigger === 'popstate';
        this.reconcile(e.id);
        this.popped = false;
      });
    effect(
      () => {
        this.session.selected();
        this.session.switching();
        this.session.status();
        this.session.refusedLink();
        untracked(() => this.reconcile());
      },
      { injector: this.injector },
    );
  }

  /** `ended`: the navigation whose end this is (still the current one while it ends). */
  private reconcile(ended?: number): void {
    if (changeSetModeOf(this.router.routerState.snapshot.root) !== 'session') {
      // Elsewhere the address says nothing about the session: back on a screen that keeps it, the
      // address decides first (Back included), not a choice made meanwhile.
      this.synced = undefined;
      return;
    }
    // Nothing is decided while another person's list is on its way, a change set is being started
    // (no ID yet) or a navigation is under way (its end reconciles).
    const going = this.router.currentNavigation();
    if (this.session.switching() || (going && going.id !== ended)) return;
    const selected = this.session.selected();
    if (selected && selected.branch === null) return;
    const chosen = selected?.id ?? null;
    const raw = this.router
      .parseUrl(this.router.url)
      .queryParamMap.getAll(CHANGE_SET_PARAM);
    const url =
      raw.length === 0
        ? null
        : raw.length === 1 && isChangeSetId(raw[0])
          ? raw[0]
          : INVALID;

    // The session moved (the picker, a link resolved, a change set dropped): into the address.
    if (this.synced !== undefined && chosen !== this.synced) {
      this.synced = chosen;
      // A refused link has been answered (none chosen, the address follows): never again by it.
      this.session.forgetRefused();
      if (url !== chosen) {
        this.write(chosen, this.session.chosenBy() !== 'person');
      }
      return;
    }
    // Otherwise the address decides.
    if (url === chosen) {
      this.synced = chosen;
      return;
    }
    if (url === null && this.popped) {
      // Back or Forward to an entry without `cs`: none was chosen there.
      this.session.chooseFromLink(null);
      this.synced = this.session.selected()?.id ?? null;
      return;
    }
    if (url === null || url === INVALID) {
      // No `cs` (or not a valid one): the session's choice goes into the address.
      this.synced = chosen;
      this.write(chosen, true);
      return;
    }
    if (url === this.session.refusedLink()) {
      // A link the person may not see: none was chosen in its place, and the address says so.
      this.synced = chosen;
      this.session.forgetRefused();
      this.write(chosen, true);
      return;
    }
    // Another change set: chosen once this person's list allows it. When that changes the
    // session, the session moved (above), and the address follows if it fell back to none.
    this.synced = chosen;
    this.session.chooseFromLink(url);
  }

  private write(id: string | null, replace: boolean): void {
    const tree = baseTree(this.router);
    const query = { ...tree.queryParams };
    if (id === null) delete query[CHANGE_SET_PARAM];
    else query[CHANGE_SET_PARAM] = id;
    tree.queryParams = query;
    void this.router.navigateByUrl(tree, { replaceUrl: replace });
  }
}

/** Keeps `?cs=` and the session's change set together from start-up (`ChangeSetUrl`). */
export function provideChangeSetUrl(): EnvironmentProviders {
  return provideEnvironmentInitializer(() => inject(ChangeSetUrl).start());
}
