import {
  computed,
  DestroyRef,
  effect,
  inject,
  untracked,
  type Signal,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import {
  ActivatedRoute,
  Router,
  type ParamMap,
  type Params,
  type UrlTree,
} from '@angular/router';

import { sameList, type QueryParam } from './query-params';

type AnyParam = QueryParam<any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The values a set of parameters stands for. */
export type QueryValues<S extends Record<string, AnyParam>> = {
  readonly [K in keyof S]: S[K] extends QueryParam<infer T> ? T : never;
};

export interface QueryState<S extends Record<string, AnyParam>> {
  /** The values the address holds now (Back and Forward included); the same object while they are. */
  readonly values: Signal<QueryValues<S>>;
  /** One value, as its own signal: it changes only when that value does. */
  get<K extends keyof S>(key: K): Signal<QueryValues<S>[K]>;
  /**
   * Writes a change into the address: a history entry of its own, unless `replace` (or the change
   * is typing; see `QueryParam.typing`). A value equal to the default is left out. Nothing is
   * navigated when nothing changes, nor while the screen is being left.
   */
  set(
    change: Partial<QueryValues<S>>,
    options?: { readonly replace?: boolean },
  ): void;
  /** Every parameter back to its default: one history entry. */
  reset(): void;
}

/**
 * Binds a screen's view state (filters, search, sort, page, tab, selection) to the address's
 * query parameters, so a reload, a copied link and Back/Forward show the same view. Call it in a
 * component's injection context; the names are the parameters' (short, readable: `?type=`,
 * `?q=`, `?page=`). Parameters it does not name (`cs`, another component's) are left alone.
 *
 * - **Reading:** each parameter is parsed and checked; an invalid one is ignored and taken out of
 *   the address (replacing the entry), as is a default written out (`?page=1`).
 * - **Writing:** `set` adds a history entry (Back undoes it), `replace` replaces it; typing
 *   (`textParam`) is one entry per run. Defaults are left out, so a clean screen has a clean
 *   address.
 * - **No reload for the same view:** `values` (and `get`) keep their value while the address
 *   stands for the same one, so an effect reading them does not run again.
 */
/**
 * The address a write builds on: the one a navigation under way on this screen goes to (another
 * write, the change set's, Back), so this one does not undo it; else the address shown.
 */
export function baseTree(router: Router): UrlTree {
  const going = router.currentNavigation();
  const path = (url: string) => url.split(/[?#]/)[0];
  if (going) {
    const target = router.serializeUrl(going.extractedUrl);
    if (path(target) === path(router.url)) return router.parseUrl(target);
  }
  return router.parseUrl(router.url);
}

export function injectQueryState<S extends Record<string, AnyParam>>(
  params: S,
): QueryState<S> {
  const route = inject(ActivatedRoute);
  const router = inject(Router);
  let destroyed = false;
  inject(DestroyRef).onDestroy(() => (destroyed = true));
  const keys = Object.keys(params) as (keyof S & string)[];
  const query = toSignal(route.queryParamMap, { requireSync: true });

  const read = (map: ParamMap): QueryValues<S> => {
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      const param = params[key]!;
      const raw = map.getAll(key);
      out[key] =
        raw.length === 0
          ? param.fallback
          : (param.parse(raw) ?? param.fallback);
    }
    return out as QueryValues<S>;
  };
  const sameValues = (a: QueryValues<S>, b: QueryValues<S>): boolean =>
    keys.every((key) => params[key]!.equal(a[key], b[key]));

  const values = computed(() => read(query()), { equal: sameValues });
  const singles = new Map<keyof S, Signal<unknown>>();

  /** The address's query parameters for these values (ours only; null takes one out). */
  const written = (next: QueryValues<S>): Record<string, string[] | null> => {
    const out: Record<string, string[] | null> = {};
    for (const key of keys) {
      const param = params[key]!;
      const value = next[key];
      const formatted = param.equal(value, param.fallback)
        ? []
        : [...param.format(value)];
      out[key] = formatted.length > 0 ? formatted : null;
    }
    return out;
  };

  /** What a write builds on: the one under way (two quick writes add up), else the address. */
  let pending: QueryValues<S> | null = null;
  /** The address after the last typing write: typing again while it stands replaces the entry. */
  let typedUrl: string | null = null;

  /** The screen is still the one shown (and not being left): it may write the address. */
  const here = (): boolean => {
    if (destroyed) return false;
    const going = router.currentNavigation();
    if (!going) return true;
    const path = (url: string) => url.split(/[?#]/)[0];
    return path(router.serializeUrl(going.extractedUrl)) === path(router.url);
  };

  const navigate = (next: QueryValues<S>, replace: boolean): string => {
    const tree = baseTree(router);
    const merged: Params = { ...tree.queryParams };
    for (const [key, value] of Object.entries(written(next))) {
      if (value === null) delete merged[key];
      else merged[key] = value.length === 1 ? value[0] : value;
    }
    tree.queryParams = merged;
    const url = router.serializeUrl(tree);
    pending = next;
    const done = () => {
      if (pending === next) pending = null;
    };
    router.navigateByUrl(tree, { replaceUrl: replace }).then(done, done);
    return url;
  };

  const set: QueryState<S>['set'] = (change, options = {}) => {
    if (!here()) return;
    const base = pending ?? values();
    const next = { ...base, ...change } as QueryValues<S>;
    const changed = keys.filter(
      (key) => key in change && !params[key]!.equal(base[key], next[key]),
    );
    if (changed.length === 0) return;
    const typing = changed.every((key) => params[key]!.typing);
    const replace =
      options.replace === true || (typing && typedUrl === router.url);
    const url = navigate(next, replace);
    typedUrl = typing ? url : null;
  };

  // An invalid or written-out default parameter is taken out of the address, replacing the entry.
  // Only once no navigation is under way: one could be Back, which this must not undo.
  effect(() => {
    const map = query();
    const shown = values();
    if (router.currentNavigation()) return;
    untracked(() => {
      if (destroyed || pending !== null) return;
      const want = written(shown);
      const dirty = keys.some((key) => {
        const raw = map.getAll(key);
        return !sameList(raw, want[key] ?? []);
      });
      if (dirty) navigate(shown, true);
    });
  });

  return {
    values,
    get: (key) => {
      let s = singles.get(key);
      if (!s) {
        const param = params[key]!;
        s = computed(() => values()[key], {
          equal: (a, b) => param.equal(a, b),
        });
        singles.set(key, s);
      }
      return s as Signal<QueryValues<S>[typeof key]>;
    },
    set,
    reset: () => {
      const defaults: Record<string, unknown> = {};
      for (const key of keys) defaults[key] = params[key]!.fallback;
      set(defaults as Partial<QueryValues<S>>);
    },
  };
}
