// `pnpm perf:seed --profile <small|large|xl>`: builds a profile's data in `.local/perf/<profile>/`
// (git-ignored) and its database `ccms_perf_<profile>` on the local compose Postgres, from
// nothing, every time. See scripts/perf/README.md.
//
//   1. media: images, PDFs and attachments into the blob store folder (`blobs/`);
//   2. content: a bare repository (`content.git`) with the configuration, terms, snippets,
//      modules, manuals and translations, then the history, written with `git fast-import`;
//   3. database: created, migrated, users and roles seeded (the API's own commands);
//   4. through the API (the built server on a free port): a release after each part of the
//      history, the open change sets with their working copies, save points, reviews and
//      comments, webhooks and translation export jobs;
//   5. directly: the audit log's history and the webhook deliveries;
//   6. the module index, rebuilt for every branch and tag (the API's own command), and a pack.
//
// The content and history are deterministic (the profile's seed; commit IDs repeat); what the API
// writes carries the time it ran (release tags, change sets, comments).

import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { cpus, loadavg, totalmem } from 'node:os';
import { parseArgs } from 'node:util';
import { ScaleContent, SOURCE_LANG, PRODUCTS } from './content.mjs';
import {
  assertReachable,
  insertAuditEvents,
  insertDeliveries,
  migrate,
  recreateDatabase,
  seedUsers,
  serviceToken,
  tableCounts,
} from './database.mjs';
import { author, git, importCommits, initBare } from './git-import.mjs';
import { makeMedia } from './media.mjs';
import {
  API_DIR,
  LOCAL_POSTGRES,
  databaseName,
  profilePaths,
} from './paths.mjs';
import { profileOf } from './profiles.mjs';
import { Random, NOUNS, paragraphText } from './random.mjs';
import { startServer } from './server.mjs';

/** The history ends here (fixed, so commit IDs repeat); commits are 30 minutes apart. */
const HISTORY_END = Date.UTC(2026, 5, 1) / 1000;
const COMMIT_SPACING = 1800;

const { values } = parseArgs({
  options: {
    profile: { type: 'string', default: 'large' },
    // Another Postgres than the compose one (the database is dropped and made again).
    postgres: { type: 'string', default: LOCAL_POSTGRES },
  },
  allowPositionals: false,
});
const profile = profileOf(values.profile);
const paths = profilePaths(profile.name);
if (!/^postgres(ql)?:\/\/[^/?#]+$/.test(values.postgres)) {
  throw new Error(
    'perf: --postgres is a server URL without a path or query (postgres://user:pass@host:port)',
  );
}
const databaseUrl = `${values.postgres}/${databaseName(profile.name)}`;
const timings = {};
const startedAll = performance.now();
const log = (line) => console.log(`[perf:seed ${profile.name}] ${line}`);

async function step(name, run) {
  const started = performance.now();
  log(`${name} …`);
  const result = await run();
  timings[name] = Math.round(performance.now() - started);
  log(`${name}: ${(timings[name] / 1000).toFixed(1)} s`);
  return result;
}

// Nothing is deleted before the database answers and the API is built.
await assertReachable(databaseUrl);
if (!existsSync(join(API_DIR, 'dist', 'main.js'))) {
  throw new Error('perf: the API is not built; run pnpm nx run api:build');
}
rmSync(paths.dir, { recursive: true, force: true });
mkdirSync(paths.dir, { recursive: true });

const media = await step('media', () => makeMedia(profile, paths.blobs, log));
const content = await step('generate', () => new ScaleContent(profile, media));

let time = HISTORY_END - profile.commits * COMMIT_SPACING;
let commitIndex = 0;
const commit = (message, changes) => {
  commitIndex += 1;
  time += COMMIT_SPACING;
  return { message, changes, author: author(commitIndex), time };
};

let head = await step('content: first commits', async () => {
  initBare(paths.content);
  let tip = await importCommits(paths.content, 'main', undefined, [
    commit(
      'Add the configuration, terms, modules and manuals',
      content.initialFiles(),
    ),
  ]);
  const translations = [...content.initialTranslations(() => tip)].map((c) =>
    commit(c.message, c.changes),
  );
  tip = await importCommits(paths.content, 'main', tip, translations);
  return tip;
});

await step('database', async () => {
  await recreateDatabase(databaseUrl);
  migrate(databaseUrl);
});
const languages = content.projectConfig.languages.targets;
const users = await step('users', () =>
  seedUsers(profile, languages, databaseUrl, paths.seedUsers),
);
const state = {
  profile: profile.name,
  databaseUrl,
  token: randomBytes(32).toString('hex'),
  webhooksKey: randomBytes(32).toString('base64'),
  agentToken: serviceToken(databaseUrl),
  users: users.byRole,
  bigManual: content.bigManualId,
};
writeFileSync(paths.state, JSON.stringify(state, null, 2), { mode: 0o600 });

const server = await step('server start', () =>
  startServer(state, { label: 'seed', env: { CCMS_JOBS_POLL_MS: '0' } }),
);
const api = server.client;
const releaseTimes = [];
const changeSets = [];
const webhookIds = [];
try {
  // The history, a release after each part of it.
  await step('content: history and releases', async () => {
    const remaining = profile.commits - commitIndex;
    const parts = Math.max(1, profile.releases);
    for (let part = 0; part < parts; part++) {
      const count =
        Math.floor(((part + 1) * remaining) / parts) -
        Math.floor((part * remaining) / parts);
      const sourceCommit = head;
      const commits = [];
      for (let i = 0; i < count; i++) {
        const c = content.historyCommit(commitIndex, sourceCommit);
        commits.push(commit(c.message, c.changes));
      }
      head = await importCommits(paths.content, 'main', head, commits);
      if (part < profile.releases) {
        const product = PRODUCTS[part % PRODUCTS.length];
        const revision = `${Math.floor(part / PRODUCTS.length) + 1}.0`;
        const res = await api.must('POST', '/releases', {
          as: users.byRole.publisher[0],
          body: {
            data: {
              type: 'Release',
              attributes: {
                product,
                revision,
                notes: `Release ${revision} of ${product}.`,
                major: revision.endsWith('.0') && part % 7 === 0,
              },
            },
          },
        });
        releaseTimes.push(Math.round(res.ms));
      }
      if ((part + 1) % 5 === 0)
        log(`history: ${part + 1} of ${parts} parts, ${commitIndex} commits`);
    }
  });

  await step('change sets', async () => {
    const random = new Random(`${profile.seed}/change-sets`);
    // Planned first, in order, so the drafts are the same whatever order the requests finish
    // in. Each module is edited by one change set at most: a module has one lock.
    const free = random.sample(content.contentIds, content.contentIds.length);
    const plans = Array.from({ length: profile.changeSets }, (_, i) => {
      const big = i === 0;
      const ids = free.splice(
        0,
        big ? profile.bigChangeSetModules : random.int(1, 8),
      );
      const committed = big || random.chance(0.7);
      return {
        index: i,
        author: users.byRole.author[i % users.byRole.author.length],
        big,
        title: big ? 'Rework of many modules' : `Update ${ids[0]}`,
        description: paragraphText(random, 2),
        edits: ids.map((id) => content.edited(content.modules.get(id), random)),
        committed,
        submitted: committed && (big || random.chance(0.4)),
      };
    });
    let finished = 0;
    await pool(plans, 4, async (plan) => {
      const as = plan.author;
      const created = await api.must('POST', '/change-sets', {
        as,
        body: {
          data: {
            type: 'ChangeSet',
            attributes: { title: plan.title, description: plan.description },
          },
        },
      });
      const { id } = created.body.data;
      const { baseCommit } = created.body.data.attributes;
      for (const module of plan.edits) {
        await api.must('POST', `/change-sets/${id}/locks`, {
          as,
          body: {
            data: {
              type: 'Lock',
              attributes: {
                subject: {
                  type: 'module',
                  lang: SOURCE_LANG,
                  moduleId: module.id,
                },
              },
            },
          },
        });
        await api.must(
          'PUT',
          `/change-sets/${id}/modules/${SOURCE_LANG}/${module.id}/working-copy`,
          {
            as,
            body: {
              data: { type: 'WorkingCopy', attributes: { content: module } },
              meta: { version: 0, baseCommit },
            },
          },
        );
      }
      if (plan.committed) {
        await api.must('POST', `/change-sets/${id}/commits`, {
          as,
          body: {
            data: {
              type: 'Commit',
              attributes: { message: `Edit ${plan.edits.length} modules` },
            },
          },
        });
      }
      if (plan.submitted)
        await api.must('POST', `/change-sets/${id}/submit`, { as, body: {} });
      changeSets[plan.index] = {
        id,
        author: as,
        modules: plan.edits.map((m) => m.id),
        edits: plan.edits,
        committed: plan.committed,
        submitted: plan.submitted,
        big: plan.big,
      };
      finished += 1;
      if (finished % 25 === 0)
        log(`change sets: ${finished} of ${profile.changeSets}`);
    });
  });

  await step('comments', async () => {
    const random = new Random(`${profile.seed}/comments`);
    const reviewed = changeSets.filter((c) => c.submitted);
    if (reviewed.length === 0) return;
    const comments = Array.from({ length: profile.comments }, (_, i) => {
      // A third of the comments go to the big change set, the rest spread over the others.
      const cs = i % 3 === 0 ? reviewed[0] : random.pick(reviewed);
      const module = random.pick(cs.edits);
      return {
        cs,
        as: random.pick(users.byRole.reviewer),
        attributes: {
          body: `Please ${random.pick(['check', 'reword', 'shorten', 'confirm'])} the ${random.pick(NOUNS)} here.`,
          subject: { type: 'module', lang: SOURCE_LANG, moduleId: module.id },
          blockId: random.pick(module.blocks).id,
        },
      };
    });
    await pool(comments, 4, ({ cs, as, attributes }) =>
      api.must('POST', `/change-sets/${cs.id}/comments`, {
        as,
        body: { data: { type: 'Comment', attributes } },
      }),
    );
  });

  await step('webhooks', async () => {
    for (let i = 0; i < profile.webhooks; i++) {
      const res = await api.must('POST', '/webhooks', {
        as: 'perf-admin',
        body: {
          data: {
            type: 'Webhook',
            attributes: {
              url: `http://127.0.0.1:9/hooks/${i + 1}`,
              events: ['manual.released', 'module.released'],
              description: `Receiver ${i + 1}`,
            },
          },
        },
      });
      webhookIds.push(res.body.data.id);
    }
  });

  await step('translation jobs', async () => {
    const random = new Random(`${profile.seed}/translation-jobs`);
    const manuals = [...content.manuals.keys()];
    for (let i = 0; i < profile.translationJobs; i++) {
      const lang = languages[i % languages.length];
      const res = await api.request('POST', '/translations/exports', {
        as: users.byRole.translator[lang],
        body: {
          data: {
            type: 'TranslationJob',
            attributes: {
              languages: [lang],
              subject: {
                type: 'manual',
                manualId: i === 0 ? content.bigManualId : random.pick(manuals),
              },
            },
          },
        },
      });
      // A manual whose modules another job holds already (an open unit each) exports nothing new.
      if (res.status >= 300 && res.status !== 409 && res.status !== 422) {
        throw new Error(
          `perf: POST /translations/exports answered ${res.status}: ${JSON.stringify(res.body)?.slice(0, 600)}`,
        );
      }
    }
  });
} finally {
  await server.stop();
}

/** Runs `work` over `items`, at most `size` at a time. */
async function pool(items, size, work) {
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) await work(items[i]);
  };
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, worker),
  );
}

await step('audit events', () =>
  insertAuditEvents(databaseUrl, {
    count: profile.auditEvents,
    seed: profile.seed,
    userIds: [...users.byRole.author, ...users.byRole.reviewer, 'perf-admin'],
    moduleIds: content.contentIds,
    endSeconds: HISTORY_END,
  }),
);
await step('webhook deliveries', () =>
  insertDeliveries(databaseUrl, {
    count: profile.deliveries,
    seed: profile.seed,
    webhookIds,
    ownerId: 'perf-admin',
    endSeconds: HISTORY_END,
  }),
);
await step('module index', () => {
  execFileSync(process.execPath, ['dist/modules/index-rebuild.main.js'], {
    cwd: API_DIR,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      CCMS_DATABASE_URL: databaseUrl,
      CCMS_CONTENT_DIR: paths.content,
    },
    stdio: 'inherit',
  });
});
await step('git gc', () => git(paths.content, 'gc', '--quiet'));

const counts = await tableCounts(databaseUrl);
const summary = {
  ...state,
  generatedAt: new Date().toISOString(),
  machine: {
    cpus: cpus().length,
    cpu: cpus()[0]?.model,
    memoryBytes: totalmem(),
    loadAtEnd: loadavg()[0],
  },
  timings: { ...timings, total: Math.round(performance.now() - startedAll) },
  releaseCutMs: releaseTimes,
  counts: {
    modules: content.modules.size,
    snippets: content.snippetIds.length,
    manuals: content.manuals.size,
    bigManualModules: profile.bigManualModules,
    translations: content.translationSummary(),
    images: media.images.length,
    pdfs: media.pdfs.length,
    attachments: media.attachments.length,
    mediaBytes: [...media.images, ...media.pdfs, ...media.attachments].reduce(
      (s, f) => s + f.size,
      0,
    ),
    commits: Number(git(paths.content, 'rev-list', '--count', 'main')),
    tags: git(paths.content, 'tag').split('\n').filter(Boolean).length,
    branches: git(paths.content, 'branch', '--list').split('\n').filter(Boolean)
      .length,
    gitBytes: folderBytes(paths.content),
    changeSets: changeSets.length,
    bigChangeSet: changeSets.find((c) => c.big)?.id,
    database: counts,
  },
  changeSets: changeSets.map(
    ({ id, author: by, modules, committed, submitted, big }) => ({
      id,
      author: by,
      modules: modules.length,
      moduleIds: modules.slice(0, 20),
      committed,
      submitted,
      big,
    }),
  ),
  sampleModules: content.contentIds.slice(0, 50),
  webhookIds,
};
writeFileSync(paths.state, JSON.stringify(summary, null, 2), { mode: 0o600 });
log(
  `done in ${(summary.timings.total / 1000).toFixed(0)} s; summary in ${paths.state}`,
);
log(
  `database ${databaseName(profile.name)} stays for the benchmarks; a benchmark run drops it when it ends (--keep keeps it)`,
);

function folderBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, {
    withFileTypes: true,
    recursive: true,
  })) {
    if (entry.isFile())
      total += statSync(join(entry.parentPath, entry.name)).size;
  }
  return total;
}
