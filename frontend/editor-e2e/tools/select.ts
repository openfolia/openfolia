// Which spec files a change needs (`pnpm check:changed`, README.md "In the checks"). Every spec
// file names the editor areas and API components it covers as tags in its `test.describe`
// titles (`@area:review @api:comments`); a changed file maps to tags here, and a spec runs when
// one of its tags is touched or the spec itself changed. A change the map cannot place (shared
// code: the UI library, the editor's API client, the API's base) runs every flow.

/** The editor's folders under `frontend/editor/src/app/`, by the area they belong to. */
export const EDITOR_AREAS: Readonly<Record<string, string>> = {
  shell: 'shell',
  session: 'shell',
  'sign-in': 'shell',
  about: 'shell',
  // The in-app help and the shortcut overlay (#221), mounted in the shell.
  help: 'shell',
  shortcuts: 'shell',
  // The tips and the first-run tour (#222), run by the shell.
  tips: 'shell',
  // The branding the shell applies (#169); its admin screen is under `admin`.
  branding: 'shell',
  notifications: 'shell',
  pages: 'shell',
  search: 'search',
  content: 'content',
  'view-state': 'content',
  'module-editor': 'module-editor',
  'doc-editor': 'module-editor',
  images: 'module-editor',
  attachments: 'module-editor',
  history: 'module-editor',
  review: 'review',
  checks: 'review',
  manuals: 'manuals',
  preview: 'manuals',
  releases: 'releases',
  translations: 'translations',
  reports: 'translations',
  media: 'media',
  // The public sandbox's banner and notes (#826), mounted in the shell and on every screen.
  sandbox: 'shell',
  terminology: 'terminology',
  admin: 'admin',
  permissions: 'admin',
};

/** API folders under `backend/api/src/` that every flow goes through. */
const API_SHARED = new Set([
  'access',
  'base',
  'config',
  'database',
  'jobs',
  'outbox',
  'content',
  'project',
]);

/** Every flow: a change the map cannot narrow down. */
export const ALL = 'all';

const SPEC_DIR = 'frontend/editor-e2e/specs/';

/** A unit test or the API's own e2e tests: never what the browser flows run. */
function isUnitTest(path: string): boolean {
  return (
    /\.(spec|test)\.[cm]?[jt]s$/.test(path) ||
    path.startsWith('backend/api/tests/')
  );
}

/**
 * What a changed file touches: tags (`@area:x`, `@api:y`), a spec file (`spec:<name>`), `all`,
 * or nothing (documentation, scripts, a unit test).
 */
export function touched(path: string): string | undefined {
  if (path.startsWith(SPEC_DIR)) {
    const name = path.slice(SPEC_DIR.length);
    // A helper next to the specs may be used by any of them.
    return /^[^/]+\.spec\.ts$/.test(name) ? `spec:${name}` : ALL;
  }
  if (path.startsWith('frontend/editor-e2e/')) {
    return /\.(md)$/.test(path) || path.startsWith('frontend/editor-e2e/tools/')
      ? undefined
      : ALL;
  }
  if (isUnitTest(path) || path.endsWith('.md')) return undefined;
  const app = /^frontend\/editor\/src\/app\/([^/]+)\//.exec(path);
  if (app) {
    const area = EDITOR_AREAS[app[1] ?? ''];
    return area ? `@area:${area}` : ALL;
  }
  const api = /^backend\/api\/src\/([^/]+)\//.exec(path);
  if (api) {
    const component = api[1] ?? '';
    return API_SHARED.has(component) ? ALL : `@api:${component}`;
  }
  if (
    /^(frontend\/(editor|ui|theme)|packages|backend\/api)\//.test(path) ||
    path === 'pnpm-lock.yaml'
  ) {
    return ALL;
  }
  return undefined;
}

/** The tags a spec file declares. */
export function tagsOf(source: string): Set<string> {
  return new Set(source.match(/@(area|api):[a-z0-9-]+/g) ?? []);
}

/**
 * The spec files to run for `changed` (repository paths), out of `specs` (file name → source):
 * all of them, or those that changed or share a tag with the change.
 */
export function selectSpecs(
  changed: readonly string[],
  specs: Readonly<Record<string, string>>,
): string[] {
  const hits = new Set(
    changed.map(touched).filter((t): t is string => t !== undefined),
  );
  const names = Object.keys(specs).sort();
  // A tag no spec carries (an API component or editor area without a flow of its own) cannot
  // narrow anything down: run every flow rather than none.
  const tagged = new Set(
    names.flatMap((name) => [...tagsOf(specs[name] ?? '')]),
  );
  const untagged = [...hits].some(
    (hit) => hit.startsWith('@') && !tagged.has(hit),
  );
  if (hits.has(ALL) || untagged) return names;
  return names.filter(
    (name) =>
      hits.has(`spec:${name}`) ||
      [...tagsOf(specs[name] ?? '')].some((tag) => hits.has(tag)),
  );
}
