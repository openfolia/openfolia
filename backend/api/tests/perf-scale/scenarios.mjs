// What `api:perf-scale` measures on a profile: one scenario per route and case. Each scenario
// names its cold requests (the first request for each of several keys, in a server process
// started for that scenario alone) and its warm request (repeated once those ran).
//
// The data a scenario needs (release IDs, variant slugs, commits) is read from the seeded
// profile by `discover()` before any measurement, on a server of its own.

const enc = encodeURIComponent;

/**
 * Reads what the scenarios refer to: releases (newest first), the big manual's variant slugs,
 * commits of `main` and release tags, a translation job, a submitted change set.
 */
export async function discover(api, state) {
  const as = 'perf-admin';
  const releases = (await api.must('GET', '/releases?page[size]=100', { as }))
    .body.data;
  const manual = (await api.must('GET', `/manuals/${state.bigManual}`, { as }))
    .body.data;
  const slugs = (manual.meta?.variants ?? [])
    .map((v) => v.slug)
    .filter(Boolean);
  const manuals = (await api.must('GET', '/manuals?page[size]=10', { as })).body
    .data;
  const otherManual =
    manuals.find((m) => m.id !== state.bigManual)?.id ?? state.bigManual;
  const otherSlugs = (
    (await api.must('GET', `/manuals/${otherManual}`, { as })).body.data.meta
      ?.variants ?? []
  ).map((v) => v.slug);
  const jobs = (
    await api.must('GET', '/translations/exports?page[size]=100', { as })
  ).body.data;
  const bigJob = jobs.at(-1);
  const big = state.changeSets.find((c) => c.big);
  const small = state.changeSets.find((c) => c.submitted && !c.big) ?? big;
  const head = (
    await api.must('GET', '/refs?page[size]=1', { as })
  ).headers.get('x-ccms-commit');
  return { releases, slugs, otherManual, otherSlugs, bigJob, big, small, head };
}

/**
 * The scenarios. `as`: the seeded user a request acts as. `cold`: paths (or request specs)
 * whose first request each is timed; `warm`: the one repeated afterwards; `expect`: the
 * statuses that count as an answer (anything else fails the scenario and is reported).
 */
/** Fills in each list's deep page: 80 % of the way to its last page, as page 1 says. */
export async function resolveDeepPages(api, list) {
  for (const scenario of list) {
    if (!scenario.deepOf) continue;
    const res = await api.get(scenario.deepOf, { as: scenario.as });
    const last = res.body?.meta?.page?.lastPage;
    // A list of one page has no deep page: the row would only repeat page 1.
    if (res.status !== 200 || !(last > 1)) {
      scenario.skip = `${scenario.name}: skipped, page 1 answered ${res.status} with ${last ?? 'no'} pages`;
      continue;
    }
    const deep = Math.max(1, Math.round(last * 0.8));
    scenario.name = `${scenario.name} (${deep} of ${last})`;
    scenario.cold = scenario.cold.map((p) =>
      p.replace('page[number]=DEEP', `page[number]=${deep}`),
    );
    scenario.warm = scenario.warm.replace(
      'page[number]=DEEP',
      `page[number]=${deep}`,
    );
  }
  return list;
}

export function scenarios(state, d) {
  const modules = state.sampleModules;
  const m = (i) => modules[i % modules.length];
  const [newest, previous, older] = d.releases;
  const oldest = d.releases.at(-1);
  const tag = (r) => enc(r.attributes.tag);
  const reader = state.users.reader?.[0] ?? 'perf-admin';
  const author = state.users.author[0];
  const translator = Object.values(state.users.translator)[0];
  const lang = Object.keys(state.users.translator)[0];
  // The deep page is 80 % of the way to the last one, read from page 1 by `resolveDeepPages`.
  const list = (
    name,
    path,
    { as = 'perf-admin', size = 50, variants = [] } = {},
  ) => [
    {
      name: `${name}, page 1`,
      group: 'lists',
      as,
      cold: [
        `${path}${path.includes('?') ? '&' : '?'}page[size]=${size}`,
        ...variants.map(
          (v) =>
            `${path}${path.includes('?') ? '&' : '?'}${v}&page[size]=${size}`,
        ),
      ],
      warm: `${path}${path.includes('?') ? '&' : '?'}page[size]=${size}`,
    },
    {
      name: `${name}, deep page`,
      group: 'lists',
      as,
      deepOf: `${path}${path.includes('?') ? '&' : '?'}page[size]=${size}`,
      cold: [
        `${path}${path.includes('?') ? '&' : '?'}page[size]=${size}&page[number]=DEEP`,
      ],
      warm: `${path}${path.includes('?') ? '&' : '?'}page[size]=${size}&page[number]=DEEP`,
    },
  ];
  return [
    ...list('GET /modules', '/modules', {
      variants: [
        'filter[lang]=en&sort=title',
        'filter[type]=procedure&sort=-title',
        'filter[product]=alpha',
        'filter[status]=changed',
      ],
    }),
    ...list('GET /modules (reader, public)', '/modules?filter[lang]=en', {
      as: reader,
    }),
    ...list('GET /module-summaries', '/module-summaries', {}),
    ...list('GET /manuals', '/manuals', {}),
    ...list('GET /assets', '/assets', {
      variants: [
        'filter[type]=image/png',
        'filter[q]=filter',
        'filter[lang]=de',
      ],
    }),
    {
      name: 'GET /assets?filter[unused]=true',
      group: 'lists',
      as: 'perf-admin',
      cold: ['/assets?filter[unused]=true&page[size]=50'],
      warm: '/assets?filter[unused]=true&page[size]=50',
    },
    ...list('GET /change-sets', '/change-sets', {
      size: 20,
      variants: ['filter[state]=in-review', `filter[author]=${author}`],
    }),
    ...list('GET /audit-events', '/audit-events', {
      size: 50,
      variants: [
        'filter[action]=module.edit',
        `filter[actor]=user/${author}`,
        `filter[subject]=module/en/${m(0)}`,
      ],
    }),
    ...list('GET /translations/status', '/translations/status', {
      variants: [`filter[lang]=${lang}`, `filter[manual]=${state.bigManual}`],
    }),
    ...list('GET /chunks', '/chunks', { size: 50 }),
    {
      name: 'GET /chunks?filter[changedSince] (previous release)',
      group: 'lists',
      as: 'perf-admin',
      cold: [
        `/chunks?filter[changedSince]=${previous.attributes.commit}&page[size]=50`,
        `/chunks?filter[changedSince]=${oldest.attributes.commit}&page[size]=50`,
      ],
      warm: `/chunks?filter[changedSince]=${previous.attributes.commit}&page[size]=50`,
    },
    ...list('GET /terms', '/terms', {}),
    ...list('GET /releases', '/releases', { size: 20 }),
    ...list('GET /locks', '/locks', { size: 50 }),
    ...list(
      'GET /webhooks/:id/deliveries',
      `/webhooks/${state.webhookIds[0]}/deliveries`,
      { size: 50 },
    ),
    ...list(
      'GET /change-sets/:id/comments (big)',
      `/change-sets/${d.big.id}/comments`,
      { size: 50 },
    ),
    {
      name: 'GET /changelog',
      group: 'lists',
      as: 'perf-admin',
      cold: [
        '/changelog?page[size]=20',
        `/changelog?filter[manual]=${state.bigManual}&page[size]=20`,
      ],
      warm: '/changelog?page[size]=20',
    },
    {
      name: 'GET /search',
      group: 'search',
      as: 'perf-admin',
      cold: [
        '/search?filter[q]=filter',
        '/search?filter[q]=replace%20the%20valve',
        '/search?filter[q]=bearing&filter[lang]=de',
        `/search?filter[q]=panel&ref=${tag(newest)}`,
        // Another commit: what its scope costs next to the newest's (#643).
        `/search?filter[q]=panel&ref=${tag(previous)}`,
      ],
      warm: '/search?filter[q]=filter',
    },
    {
      // Slow shapes (#539): many short words, each a prefix before #539, and every word of
      // a query in several languages' configurations.
      name: 'GET /search (short words)',
      group: 'search',
      as: 'perf-admin',
      cold: [
        '/search?filter[q]=a%20e%20i%20o%20u%20s%20t%20r',
        '/search?filter[q]=of%20in%20to%20on',
        '/search?filter[q]=ab%20cd%20ef%20gh%20ij%20kl%20mn%20op',
      ],
      warm: '/search?filter[q]=a%20e%20i%20o%20u%20s%20t%20r',
    },
    {
      name: 'GET /search (reader, public)',
      group: 'search',
      as: reader,
      cold: ['/search?filter[q]=filter', '/search?filter[q]=motor'],
      warm: '/search?filter[q]=filter',
    },
    {
      name: 'GET /modules/:lang/:id',
      group: 'read',
      as: 'perf-admin',
      cold: [0, 1, 2, 3, 4].map((i) => `/modules/en/${m(i)}`),
      warm: `/modules/en/${m(0)}`,
    },
    {
      name: 'GET /modules/:lang/:id/preview',
      group: 'preview',
      as: 'perf-admin',
      cold: [0, 1, 2, 3, 4].map((i) => `/modules/en/${m(i)}/preview`),
      warm: `/modules/en/${m(0)}/preview`,
      accept: 'text/html',
    },
    {
      name: 'GET /modules/:lang/:id/history',
      group: 'history',
      as: 'perf-admin',
      cold: [0, 1, 2].map((i) => `/modules/en/${m(i)}/history`),
      warm: `/modules/en/${m(0)}/history`,
    },
    {
      name: 'GET /modules/:lang/:id/compare (oldest to newest release)',
      group: 'compare',
      as: 'perf-admin',
      cold: [0, 1, 2].map(
        (i) =>
          `/modules/en/${m(i)}/compare?base=${tag(oldest)}&head=${tag(newest)}`,
      ),
      warm: `/modules/en/${m(0)}/compare?base=${tag(oldest)}&head=${tag(newest)}`,
      expect: [200, 404],
    },
    {
      name: 'GET /manuals/:id/compare (big manual, oldest to newest release)',
      group: 'compare',
      as: 'perf-admin',
      cold: [
        `/manuals/${state.bigManual}/compare?base=${tag(oldest)}&head=${tag(newest)}`,
        `/manuals/${state.bigManual}/compare?base=${tag(older ?? oldest)}&head=${tag(newest)}`,
      ],
      warm: `/manuals/${state.bigManual}/compare?base=${tag(oldest)}&head=${tag(newest)}`,
    },
    {
      name: 'GET /manuals/:id/history (big manual)',
      group: 'history',
      as: 'perf-admin',
      cold: [`/manuals/${state.bigManual}/history`],
      warm: `/manuals/${state.bigManual}/history`,
    },
    {
      name: 'GET /releases/:id/changes',
      group: 'compare',
      as: 'perf-admin',
      cold: [newest, previous, older]
        .filter(Boolean)
        .map((r) => `/releases/${r.id}/changes?page[size]=50`),
      warm: `/releases/${newest.id}/changes?page[size]=50`,
      expect: [200, 422],
    },
    {
      name: 'GET /manuals/:id/variants/:variant/:lang (big manual, resolved)',
      group: 'manual',
      as: 'perf-admin',
      cold: d.slugs
        .slice(0, 3)
        .map((s) => `/manuals/${state.bigManual}/variants/${enc(s)}/en`),
      warm: `/manuals/${state.bigManual}/variants/${enc(d.slugs[0])}/en`,
    },
    {
      name: 'GET /manuals/:id/checks (big manual)',
      group: 'manual',
      as: 'perf-admin',
      cold: [`/manuals/${state.bigManual}/checks`],
      warm: `/manuals/${state.bigManual}/checks`,
    },
    {
      name: 'GET /manuals/:id/variants/:variant/:lang/html (big manual)',
      group: 'manual',
      as: 'perf-admin',
      cold: [`/manuals/${state.bigManual}/variants/${enc(d.slugs[0])}/en/html`],
      warm: `/manuals/${state.bigManual}/variants/${enc(d.slugs[0])}/en/html`,
      accept: 'text/html',
    },
    {
      name: 'GET …/pdf (big manual: cold, then another variant)',
      group: 'pdf',
      as: 'perf-admin',
      cold: [
        ...d.slugs
          .slice(0, 2)
          .map((s) => `/manuals/${state.bigManual}/variants/${enc(s)}/en/pdf`),
        `/manuals/${state.bigManual}/variants/${enc(d.slugs[0])}/de/pdf`,
      ],
      warm: `/manuals/${state.bigManual}/variants/${enc(d.slugs[0])}/en/pdf`,
      accept: 'application/pdf',
      warmRuns: 3,
      timeoutMs: 600_000,
    },
    {
      name: 'GET …/pdf (a typical manual: cold, then another variant)',
      group: 'pdf',
      as: 'perf-admin',
      cold: [...d.otherSlugs.slice(0, 2), d.otherSlugs[0]].map(
        (s, i) =>
          `/manuals/${d.otherManual}/variants/${enc(s)}/${i === 2 ? 'de' : 'en'}/pdf`,
      ),
      warm: `/manuals/${d.otherManual}/variants/${enc(d.otherSlugs[0])}/en/pdf`,
      accept: 'application/pdf',
      warmRuns: 5,
      timeoutMs: 300_000,
    },
    {
      name: 'GET /change-sets/:id/changes (big change set)',
      group: 'review',
      as: 'perf-admin',
      cold: [`/change-sets/${d.big.id}/changes?page[size]=50`],
      warm: `/change-sets/${d.big.id}/changes?page[size]=50`,
    },
    {
      name: 'GET /change-sets/:id/review (big change set)',
      group: 'review',
      as: 'perf-admin',
      cold: [`/change-sets/${d.big.id}/review`],
      warm: `/change-sets/${d.big.id}/review`,
    },
    {
      name: 'GET /change-sets/:id/checks (big change set)',
      group: 'review',
      as: 'perf-admin',
      cold: [`/change-sets/${d.big.id}/checks`],
      warm: `/change-sets/${d.big.id}/checks`,
    },
    {
      name: 'POST /translations/exports, dry run (big manual, one language)',
      group: 'xliff',
      as: translator,
      method: 'POST',
      cold: [
        {
          data: {
            type: 'TranslationJob',
            attributes: {
              languages: [lang],
              subject: { type: 'manual', manualId: state.bigManual },
            },
          },
          meta: { dryRun: true },
        },
      ].map((body) => ({ path: '/translations/exports', body })),
      warm: {
        path: '/translations/exports',
        body: {
          data: {
            type: 'TranslationJob',
            attributes: {
              languages: [lang],
              subject: { type: 'manual', manualId: state.bigManual },
            },
          },
          meta: { dryRun: true },
        },
      },
      expect: [200, 422],
    },
    ...(d.bigJob
      ? [
          {
            name: 'GET /translations/exports/:id/file (the big job)',
            group: 'xliff',
            as: translator,
            cold: [
              `/translations/exports/${d.bigJob.id}/file?lang=${d.bigJob.attributes.languages[0]}`,
            ],
            warm: `/translations/exports/${d.bigJob.id}/file?lang=${d.bigJob.attributes.languages[0]}`,
            accept: '*/*',
          },
        ]
      : []),
    {
      name: 'GET /translations/status/:lang/:moduleId',
      group: 'read',
      as: 'perf-admin',
      cold: [0, 1, 2].map((i) => `/translations/status/${lang}/${m(i)}`),
      warm: `/translations/status/${lang}/${m(0)}`,
    },
    {
      name: 'GET /reports/translations',
      group: 'reports',
      as: 'perf-admin',
      cold: ['/reports/translations?page[size]=50'],
      warm: '/reports/translations?page[size]=50',
    },
    {
      name: 'GET /reports/module-usage',
      group: 'reports',
      as: 'perf-admin',
      cold: ['/reports/module-usage?page[size]=50'],
      warm: '/reports/module-usage?page[size]=50',
    },
    {
      name: 'GET /storage-usage',
      group: 'reports',
      as: 'perf-admin',
      cold: ['/storage-usage'],
      warm: '/storage-usage',
    },
    {
      name: 'GET /refs',
      group: 'read',
      as: 'perf-admin',
      cold: ['/refs?page[size]=50'],
      warm: '/refs?page[size]=50',
    },
  ];
}
