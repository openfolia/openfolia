import type { ActivatedRouteSnapshot } from '@angular/router';

import type { SidebarMode } from './shell-state';

export interface BreadcrumbItem {
  /** A translation key from route data, or, with `literal`, the text itself (the product name). */
  readonly label: string;
  readonly literal?: boolean;
  /** Router link of a level above the page. */
  readonly link: string;
  /** The page itself (`aria-current="page"`, no link). */
  readonly current?: boolean;
}

/**
 * The trail above a page's title, from the routes that carry `data.breadcrumb`, outermost
 * first. When the page itself carries one (a section such as Content), it ends the trail as the
 * current page, after the product's home ("Docs / Content"). When it does not (an Admin tab,
 * whose own title is the heading), the trail ends at the level the page lives in ("Admin").
 */
export function breadcrumbsOf(
  root: ActivatedRouteSnapshot,
  home: string,
): BreadcrumbItem[] {
  const items: BreadcrumbItem[] = [];
  let url = '';
  let leafLabelled = false;
  for (
    let route: ActivatedRouteSnapshot | null = root;
    route;
    route = route.firstChild
  ) {
    const segment = route.url.map((s) => s.path).join('/');
    if (segment) url += `/${segment}`;
    // The route's own config, not `data`: a child inherits its parent's data.
    const label: unknown = route.routeConfig?.data?.['breadcrumb'];
    const own = typeof label === 'string';
    if (own) items.push({ label, link: url || '/' });
    // A child at the same address (a section's index page) is that section's page.
    if (own || segment) leafLabelled = own;
  }
  const last = items.at(-1);
  if (!leafLabelled || !last) return items;
  const page = { label: last.label, link: '', current: true };
  const above = items.slice(0, -1);
  return above.length === 0
    ? [{ label: home, link: '/', literal: true }, page]
    : [...above, page];
}

/** The innermost `data.sidebar` on the active route path, if any screen declares one. */
export function sidebarModeOf(
  root: ActivatedRouteSnapshot,
): SidebarMode | undefined {
  let mode: SidebarMode | undefined;
  for (
    let route: ActivatedRouteSnapshot | null = root;
    route;
    route = route.firstChild
  ) {
    mode = (route.data['sidebar'] as SidebarMode | undefined) ?? mode;
  }
  return mode;
}
