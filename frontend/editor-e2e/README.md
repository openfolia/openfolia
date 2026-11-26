# `frontend/editor-e2e` (`editor-e2e`)

The editor's real-browser end-to-end suite: [Playwright](https://playwright.dev) (Chromium) on
the **built editor** against the **real API**, on a fresh database and a fresh copy of the
sample content for every run. The editor's component specs render one screen in a simulated DOM
against a faked API; the API's e2e tests speak HTTP. This suite is what runs the two together, in
a real browser with real layout, real permissions and real data.

## Run

```sh
pnpm nx run editor-e2e:e2e                  # every flow (builds the API and the editor first)
pnpm nx run editor-e2e:e2e -- specs/review.spec.ts --project=desktop   # arguments go to playwright test
cd frontend/editor-e2e && node run.ts -g "diff view"   # without Nx, on the last builds
```

- **The browser:** the `browsers` target (a dependency of `e2e`) runs
  `playwright install --only-shell chromium`, which downloads Chromium's headless shell once into
  Playwright's cache (`~/Library/Caches/ms-playwright`, `~/.cache/ms-playwright` on Linux) and is
  a no-op afterwards. Playwright itself is a pinned dev dependency of this package.
- **In the checks:** `pnpm check` runs every flow (`scripts/check.mjs`: after test, lint,
  typecheck and build, before the speed criteria). `pnpm check:changed` runs only the flows the
  change touches (below). The target is cached like a test: same inputs, no second run.
- **Workers:** 4 by default, `E2E_WORKERS=<n>` for another number.

## What a run starts (`stack/`)

`globalSetup` (`stack/global-setup.ts`, `stack/stack.ts`) starts, once per run:

1. **a database:** an in-memory PGlite (the API's test database) on a free loopback port, in a
   process of its own (`stack/db.mjs`); migrated (`db-migrate`) and seeded with the example roles
   and users (`db-seed --example`). Its queue keeps each connection's extended query and
   transaction together, so the API's pool and the job queue can share it;
2. **the sample content** as `api:setup-local` makes it (bare repository, snippets, terms,
   right-to-left languages, the sample page design templates) and a
   blob folder, in `.local/editor-e2e/run-<pid>-<time>/` (removed after the run unless
   `E2E_KEEP_STACK=1`);
3. **the API** (`backend/api/dist/main.js`) in demo mode with a random token, on a free port, with
   a clean environment: nothing from the shell or `.env.local` reaches it;
4. **the editor** (`frontend/editor/dist/browser`) on another free port (`stack/editor-server.mjs`),
   with `/api` proxied to the API as a deployment's reverse proxy does it: the token added there,
   never in the browser, and a request from another origin refused. A request it could not pass
   on (the browser gets a 502, or an answer cut short) is named in the stack's log.
5. **for the sign-in flows** (#37, `specs/sign-in.spec.ts`): a local OpenID Connect provider
   (`backend/api/scripts/mock-oidc.ts`: a login name, no password; its people are
   `OIDC_ACCOUNTS` in `stack/stack.ts`), a second API on the same database with sign-in on
   (`CCMS_ROLE=api`, so it does no background work of its own), and a second editor in front of
   it whose proxy adds no token (`E2E_SIGN_IN_URL`), as a deployment with sign-in has it. They
   start beside the first API and editor, adding about two seconds to the stack's start: cheaper
   than a Playwright project of their own, which would need a second database and content.
6. **for the public sandbox flows** (#826, `specs/sandbox.spec.ts`; the suite passes
   `sandbox: true`): a third API with `CCMS_PUBLIC_SANDBOX=on` in demo mode, on a database,
   content and blob folder of its own (a sandbox runs every role in one process, so its
   background jobs must never take the other APIs'), its session a day long
   (`SANDBOX_MINUTES`, so a long run never sees it end), and a third editor in front of it with
   the token (`E2E_SANDBOX_URL`). Its database and content are made while the first API starts.

**No fixed ports:** the operating system hands them out (never 3100 or 4310, the person's own
servers), so a run in an agent slot and one in the main checkout never meet, and a running
`serve-local` is not disturbed. The API's log of the last run is `.local/editor-e2e/stack.log`.

**Other users of the stack.** The demo set-up for the landing page videos (`scripts/demo/`,
`docs/demo-videos.md`) starts the same stack with `startStack`'s options:

- `repository`: builds its own content repository in place of the sample;
- `seedFile`: its own people and roles;
- `ports`: fixed ports, refused if they are 3100, 4310 or 4320;
- `signIn: false`: no provider, second API or second editor;
- `sandbox: true`: the public sandbox's API and editor (6.); off unless asked for, so the demo
  and the guide's screenshots go without;
- `startPage: true`: the editor server answers `GET /__start?lang=&user=&theme=` with a page that
  sets those three in the browser's storage, each checked against a pattern, then opens the
  editor. The suite itself never sets it.

## Writing a flow (`specs/`)

One spec file per screen area, each with the main path and at least one error path.

- **Tags** in the `test.describe` title say what the file covers: `@area:<editor area>` (the
  folders of `frontend/editor/src/app/`, mapped in `tools/select.ts`) and `@api:<component>`
  (the folders of `backend/api/src/`). `@narrow` runs the describe at phone width too.
- **`test` and helpers** come from `src/fixtures.ts`:
  - `signIn(page, USERS.author)`: act as a seeded demo user from the first page load (the
    sign-in page's own flow is in `shell.spec.ts`); `switchUser(page, from, to)` switches in the
    account menu;
  - `api(USERS.x)`: make the state a flow needs **through the API, not the UI** (`src/api.ts`:
    change sets, new modules, edits of modules and manuals, save points, transitions, comments,
    releases). The change sets it starts are abandoned after the test, so their locks never hold
    up another test or a retry; not before the page's requests to the API are answered and
    500 ms have passed without one (up to 10 s; one still open then is named in `console.txt`).
    Reads count too: the editor often writes once a read is answered (a reload takes the lock
    again after its reads, #516);
  - `src/database.ts`: the few states no route makes, written into the run's database
    (`E2E_DATABASE_URL`, with the API's own `pg`): `refuseReleaseOutputs` makes a release whose
    planning was refused for too many files (#477), as lowering the run's limit would refuse
    every other flow's releases; `holdReleaseOutputs` puts a release's files back to waiting behind
    newer releases (#497), out of the reuse groups other flows' releases of the same product share,
    so none of their renders makes them meanwhile (#536); `holdPlanning` and `releasePlanning`
    hold a release's planning job and let it run, `unplanRelease` takes back a release's files and `cutOffPlanning` makes its planning one cut
    off part way,
    so a later release waits for it to be planned (#527: in the order cut; only on a product no
    other flow releases, `ownProduct`). Only for a release (or row) of the test's own;
  - tips and the first-run tour (#222) are off in every flow: `tipsOff` answers
    `GET /api/me/preferences` with "Show tips" off and the tour done, in the page's context (the
    screenshots' fixture does the same), since a tip or the tour would take a flow's focus. A
    flow about them sets `test.use({ tips: true })` and signs in as a person of its own
    (`specs/tips.spec.ts`);
  - `chooseSegment`, `openAccountMenu`, `openSidebar` (the drawer below 768 px),
    `expectNoSideways`;
  - `expectPageFits(page, { fits })`: the document never scrolls and the shell's `main` is no
    taller than its content (nothing escapes an inner scroller to stretch it, #563); `fits`: the
    screen fits the window, so `main` has nothing to scroll. `expectWheelStaysInside(page,
scroller)` waits until the scroller has loaded what it shows (nothing busy or a skeleton in
    it, its frames loaded, its height steady), then wheels it past its end and checks the page
    did not scroll with it (#599).
- **Shared data:** every test runs against the same stack, in parallel. Make your own data
  (`unique()`, `moduleId()`, a revision of your own); a module of main that a test locks or
  changes is that test's alone (named in a comment); never assert on counts others change.
  Never read "the first" or "the latest" release of a shared product: other flows, a retry and
  `--repeat-each` cut more of them. Open your own release by its ID; a flow that needs a
  product's first release (its changes list every manual) makes a product of its own
  (`ownProduct` in `releases.spec.ts`, #564). That merges a configuration change, so a flow
  that edits the configuration in a revision of its own retries taking its lock (`toPass`).
- **Installation-wide state** (a setting such as self-approval, #588; an outbox consumer held
  after a restore, `outbox-restore.spec.ts`, #619; people invited with passwords,
  `password-sign-in.spec.ts`, #610; who must have a second factor, `second-factor.spec.ts`, #611): a flow that changes it would change
  what every other flow running beside it sees, so it never runs beside them. Its spec file is
  matched by `ISOLATED` in `playwright.config.ts` (`ISOLATED_SPECS`, `isolated.ts`): the `isolated` project runs it after `desktop`
  and `narrow` are done (`dependencies`), one test at a time (`workers: 1`: `mode: 'serial'` orders
  a file's tests, but not the files or the copies `--repeat-each` makes, #724), and it puts the
  setting back after each test (`afterEach`). Its tests add their own run time to the suite's
  wall time, so keep them few; anything else goes in the shared projects. Playwright runs a
  dependency's tests whatever files were named, so `run.ts` runs a selection holding an isolated
  flow in two passes (the others, then `--project=isolated --no-deps`); to run one by hand:
  `node run.ts specs/self-approval.spec.ts --project=isolated --no-deps`.
- **The first check after a page load:** opening a module reads the change set, the
  configuration, the module and its working copy one after another, then takes the lock; on a
  busy machine that chain alone can use most of an expect's 10 s. A flow whose first check
  depends on a request at the end of it (the lock's answer, a symbol's artwork) waits for that
  response first (`page.waitForResponse`, registered before `goto`), then for what it shows
  (#523), not for a longer timeout.
- **Eager writes:** the editor shows many writes at once and sends them after (a comment, a
  reply, a resolve). A flow waits for the API's answer to such a write (`page.waitForResponse`,
  as `review.spec.ts` does), not only for its text on screen: else the next step, or the end of
  the test and its change set abandoned, can overtake it (#493).
- **The console:** a console error or an uncaught exception fails the test. A flow that provokes
  one on purpose (a refused request) allows it with `test.use({ consoleAllow: [/…/] })` in a
  describe of its own, matched against the whole line (text and URL); a known bug allowed this
  way names its issue. The sandboxed preview frames' blocked-script messages are allowed always;
  the 404 a normal instance answers to the editor's `GET /api/sandbox` at start-up (#826) is
  allowed in every editor but the public sandbox's (`E2E_SANDBOX_URL`), where that request must
  succeed.
- **A known bug** whose fix is not merged: `test.fail(true, '#<issue>: …')`, so the flow runs and
  says so once the fix lands (an expected failure that passes fails the run).
- **Viewports:** `desktop` (1440×900) runs everything but the isolated flows; `narrow` (390×844) the `@narrow` describes; `isolated` (1440×900) the isolated flows, last.

## When a test fails

The report names, per failure, its **trace** (`pnpm exec playwright show-trace <trace.zip>`), a
**screenshot**, the **console** (`console.txt`, with a `[response]` line per refused API
request: status, method, URL and the API's error body, so its `code` shows; these lines never
fail a test) and an `error-context.md` with the page's
accessibility snapshot, all under `.local/editor-e2e/results/` of the checkout; the HTML report
is in `.local/editor-e2e/report/`. One retry runs, never silently: a test that passes only on it
is listed as **flaky** in the summary, which also gives the run time and the load average.

## In `pnpm check:changed`

Nx runs `editor-e2e:e2e` when the editor, the API or a package they build on is affected
(`implicitDependencies`). `scripts/check.mjs` passes `CCMS_E2E_SELECT=affected` and the base and
head, and `run.ts` picks the spec files (`tools/select.ts`, tested in `tools/select.test.ts`): a
change in an editor area or API component runs the specs tagged with it, a changed spec runs
itself, and a change the map cannot place (the UI library, the editor's API client, the API's
`base`, `access`, `config`, `database`, `jobs`, …, a package, this suite's own support code) runs
every flow. Unit tests, docs and scripts run none.

## Screenshots for the user guide (`screenshots/`)

The user guide's images (`frontend/docs/public/images/guide/<lang>/<name>.webp`, #447) are made by
a script, never by hand, so they follow the screens:

```sh
pnpm nx run editor-e2e:guide-screenshots                 # every image, English and German
pnpm nx run editor-e2e:guide-screenshots -- --project=de -g "module editor"   # some of them
pnpm nx run editor-e2e:guide-screenshots -- screenshots/releases.shots.ts       # one area
```

- **Its own stack:** `screenshots/global-setup.ts` starts the suite's stack (`startStack`) in a
  folder of its own (`.local/guide-screenshots/`), with the page designs and the safety leaflet
  `api:setup-local` adds on top of the sample content: a fresh database, fresh content, ports the
  system picks. It never touches the suite's runs, its log or a running `serve-local`.
- **What a shot shows:** one file per area of the guide (`screenshots/<area>.shots.ts`:
  `guide`, `writing-blocks`, `writing-lifecycle`, `review-checks`, `releases`,
  `translations-media`, `admin`) on the shared fixtures of `screenshots/fixtures.ts`; one test
  per screen and the images it writes, in light mode, at 1280×800, once per UI language (the Playwright projects `en` and
  `de`). Each makes its state through the API (a revision with the guide's module, in the shot's
  language) and abandons its revisions after it. Buttons are found by the editor's own texts
  (`screenshots/labels.ts` reads `frontend/editor/src/i18n/`), the texts the guide quotes.
- **The files:** WebP, encoded by the same browser (`screenshots/shot.ts`), about 50 KB each.
  Commit the changed images with the change that moved the screen; a page of the guide names its
  image as `/images/guide/<lang>/<name>.webp`, and the docs' tests fail on an image that is
  missing in a language.
- **Not a test:** the shots run only on demand, never in `pnpm check`; `testMatch` is
  `*.shots.ts`, which the suite's `specs/` never holds.
