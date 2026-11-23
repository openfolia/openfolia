import type { Route } from '@angular/router';

import guideIndex from '../../../generated/guide-index.json';
import { SETTINGS_ROUTES } from '../admin/settings/settings.routes';
import { routes } from '../app.routes';
import { HELP_DATA } from './help.service';

/**
 * Screens with no page of the user guide, each with the reason (#221). Anything else the router
 * can show names its guide page (`data.help`), and the guide has that page: this is the drift
 * test that keeps every built screen linked to its help.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  theme: 'the design reference, outside the product’s screens',
  showcase: 'the component showcase, in development builds only',
  'doc-editor': 'the block editor playground, in development builds only',
};

interface Screen {
  /** The route's place: its paths from the root joined (`admin/users`), `(no access) <section>` for a no-access page. */
  readonly key: string;
  /** The article ID it, or the nearest route above it, names. */
  readonly help: string | null;
}

/** Every route that shows a screen, with the help it inherits; settings topics (lazy children) included. */
function screens(
  list: readonly Route[],
  prefix = '',
  inherited: string | null = null,
): Screen[] {
  return list.flatMap((route): Screen[] => {
    const own: unknown = route.data?.[HELP_DATA];
    const help = typeof own === 'string' ? own : inherited;
    const noAccess = route.data?.['noAccess'] as
      { section?: string } | undefined;
    const segment =
      route.path ??
      (noAccess ? `(no access) ${noAccess.section ?? ''}` : '(matcher)');
    const key = [prefix, segment].filter(Boolean).join('/');
    const children = route.loadChildren
      ? // The only lazy children are the project settings' topics.
        SETTINGS_ROUTES
      : (route.children ?? []);
    // A route with children is their frame (the shell, a page with tabs): they are the screens.
    const self: Screen[] =
      (route.loadComponent || route.component) && children.length === 0
        ? [{ key, help }]
        : [];
    return [...self, ...screens(children, key, help)];
  });
}

const all = screens(routes);
const articles = new Set(guideIndex.articles.map((article) => article.id));

describe('every screen’s page of the user guide', () => {
  it('finds the screens, the nested ones too', () => {
    const keys = all.map((s) => s.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'content',
        'content/:lang/:moduleId',
        'admin/users',
        'admin/settings/languages',
        'reports/usage',
        'translations/jobs',
        'sign-in',
      ]),
    );
  });

  it('is named by every screen but the exempt ones', () => {
    const missing = all
      .filter((s) => s.help === null && !(s.key in EXEMPT))
      .map((s) => s.key);
    expect(missing).toEqual([]);
  });

  it('is a page the guide has', () => {
    const unknown = all
      .filter((s) => s.help !== null && !articles.has(s.help))
      .map((s) => `${s.key}: ${s.help}`);
    expect(unknown).toEqual([]);
  });

  it('exempts only screens that exist and have none', () => {
    for (const key of Object.keys(EXEMPT)) {
      const screen = all.find((s) => s.key === key);
      expect(screen, key).toBeDefined();
      expect(screen?.help, key).toBeNull();
    }
  });

  it('is the most specific page on the way to the screen', () => {
    const help = (key: string) => all.find((s) => s.key === key)?.help;
    expect(help('content')).toBe('guide.writing.content-browser');
    expect(help('admin/settings/languages')).toBe(
      'guide.admin.project-settings',
    );
    expect(help('admin/settings/variant-attributes')).toBe(
      'guide.variants.attributes',
    );
    expect(help('admin/page-designs/:designId')).toBe(
      'guide.releases.page-designs',
    );
  });
});
