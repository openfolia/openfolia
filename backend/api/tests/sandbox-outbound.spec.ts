import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The outbound inventory of the public sandbox (#826): every file of the API (and of the
 * packages it runs) that can reach the network, each with the decision of what it does in a
 * sandbox (`CCMS_PUBLIC_SANDBOX=on`). A new one fails this test until it has a decision here;
 * so does a package the code starts to import that is not classified below. What each "off"
 * decision claims is checked against the running app in `sandbox.e2e.spec.ts` (the adapter
 * every such port takes, and no connection beyond this machine).
 */

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SCANNED = ['backend/api/src', 'packages'];

type Decision =
  /** The module binds its port to an adapter that never connects in a sandbox. */
  | { readonly off: string }
  /** The settings that would turn it on refuse to start in a sandbox (`SANDBOX_REFUSED_SETTINGS`). */
  | { readonly refusedAtStart: string }
  /** It runs in another process that refuses to start in a sandbox, or never in one. */
  | { readonly notInSandbox: string }
  /** It connects only to the instance's own infrastructure, or runs only local programs. */
  | { readonly local: string }
  /** It imports from a network module only what makes no connection (a parser, a server). */
  | { readonly noConnection: string };

const INVENTORY: Record<string, Decision> = {
  // Leaves the instance: off at the port.
  'backend/api/src/mail/repos/smtp-mailer.ts': {
    off: 'MailModule binds Mailer to NoMailer, and MailOutbox drops every email (CCMS_MAIL_* refused at start).',
  },
  'backend/api/src/webhooks/repos/node-webhook-sender.ts': {
    off: 'WebhooksModule binds WebhookSender to SandboxWebhookSender; creating, changing, testing and retrying webhooks is sandbox-not-allowed.',
  },
  'backend/api/src/search/repos/http-embedder.ts': {
    off: 'SearchModule binds Embedder to NoEmbedder (CCMS_EMBEDDER_* refused at start).',
  },
  'backend/api/src/style-review/repos/http-style-reviewer.ts': {
    off: 'StyleReviewModule binds StyleReviewer to NoStyleReviewer (CCMS_STYLE_REVIEW_* refused at start).',
  },
  'backend/api/src/access/repos/oidc-identity-provider.ts': {
    off: 'AccessModule offers no identity provider (CCMS_OIDC_* refused at start; demo mode only).',
  },
  'backend/api/src/access/repos/saml-identity-provider.ts': {
    off: 'AccessModule offers no identity provider (CCMS_SAML_IDP_METADATA_* refused at start; demo mode only).',
  },
  'backend/api/src/audit/repos/https-audit-sink.ts': {
    off: 'AuditModule binds AuditSink to NoAuditSink (CCMS_AUDIT_SINK_* refused at start).',
  },
  'backend/api/src/audit/repos/syslog-audit-sink.ts': {
    off: 'AuditModule binds AuditSink to NoAuditSink (CCMS_AUDIT_SINK_* refused at start).',
  },
  // S3 is reached through @aws-sdk/client-s3, classified below.
  'backend/api/src/blobs/repos/s3-blob-store.ts': {
    refusedAtStart:
      'CCMS_BLOB_DRIVER=s3 and CCMS_S3_* are refused at start, and BlobsModule refuses any driver but fs in a sandbox.',
  },
  // The backup service: its own process (CCMS_ROLE=backup), which refuses CCMS_PUBLIC_SANDBOX=on.
  'backend/api/src/backups/repos/backup-targets.ts': {
    notInSandbox:
      'The backup service refuses to start in a sandbox (BackupEnv); the API refuses backup settings, keys and requests.',
  },
  'backend/api/src/backups/repos/guarded-lookup.ts': {
    notInSandbox: 'The backup service’s S3 lookups: as backup-targets.ts.',
  },
  'backend/api/src/backups/repos/pg-backup-lock.ts': {
    notInSandbox:
      'The backup service’s lock in the database: as backup-targets.ts.',
  },
  'backend/api/src/backups/repos/processes.ts': {
    notInSandbox:
      'The backup service’s pg_dump and pg_restore: as backup-targets.ts.',
  },
  'backend/api/src/backups/repos/restore-backup.ts': {
    notInSandbox: 'A restore from the command line: as backup-targets.ts.',
  },
  'backend/api/src/backups/repos/shell-backup-source.ts': {
    notInSandbox: 'The backup service’s dump: as backup-targets.ts.',
  },
  'backend/api/src/backups/repos/shell-backup-verifier.ts': {
    notInSandbox: 'The backup service’s check: as backup-targets.ts.',
  },
  // The instance's own infrastructure and local programs.
  'backend/api/src/database/postgres.database.ts': {
    local:
      'The instance’s own database (CCMS_DATABASE_URL, the operator’s; the sandbox image embeds it): nothing a visitor names.',
  },
  'backend/api/src/jobs/repos/pg-boss-jobs.ts': {
    local: 'The job queue in the instance’s own database.',
  },
  'packages/content-repo/src/lib/git.ts': {
    local:
      'Runs git on the instance’s own bare repository; never a remote command (checked below).',
  },
  'packages/content-repo/src/lib/writer.ts': {
    local: 'As git.ts: git on the local repository only.',
  },
  'packages/render-typst/src/lib/compile.ts': {
    local:
      'PDF compiler processes: Typst package downloads go to a blocked proxy on the loopback, always (`sandbox.spec.ts` of render-typst).',
  },
  'packages/dita/src/lib/isolated.ts': {
    local:
      'A DITA conversion’s own process, which reads no DTD and fetches nothing; imports are sandbox-not-allowed anyway.',
  },
  // A network module imported for what makes no connection.
  'backend/api/src/base/api/api-exception.filter.ts': {
    noConnection: 'STATUS_CODES from node:http.',
  },
  'backend/api/src/scim/api/scim-http.ts': {
    noConnection: 'STATUS_CODES from node:http.',
  },
  'backend/api/src/base/api/client-address.ts': {
    noConnection: 'isIPv4 and isIPv6 from node:net.',
  },
  'backend/api/src/config/audit-env.ts': {
    noConnection: 'isIP from node:net.',
  },
  'backend/api/src/config/trust-proxy.ts': {
    noConnection: 'BlockList and isIP from node:net.',
  },
  'backend/api/src/webhooks/core/webhook-url.ts': {
    noConnection: 'BlockList and isIP from node:net.',
  },
  'backend/api/src/backups/core/backup-endpoint.ts': {
    noConnection: 'BlockList and isIP from node:net.',
  },
  'backend/api/src/health/api/worker-health.server.ts': {
    noConnection:
      'A worker’s health endpoint: it listens on its own port, it connects nowhere.',
  },
};

/** Node's modules that open connections, and the packages that do. */
const NETWORK_MODULE =
  /^(?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process)(?:\/.*)?$|^(?:nodemailer|pg|pg-boss|openid-client|undici|ws|@aws-sdk\/.*|drizzle-orm\/node-postgres)$/;

/**
 * Every package the code imports, with whether it can reach the network. A package that can
 * is in `NETWORK_MODULE`, so each file importing it needs its decision above.
 */
const PACKAGES: Record<string, 'network' | 'none'> = {
  '@aws-sdk/client-s3': 'network',
  '@myriaddreamin/typst-ts-node-compiler': 'none',
  '@nestjs/common': 'none',
  '@nestjs/config': 'none',
  '@nestjs/core': 'none',
  '@nestjs/platform-express': 'none',
  '@nestjs/swagger': 'none',
  '@node-saml/node-saml': 'none',
  '@openfolia/content-model': 'none',
  '@openfolia/content-repo': 'none',
  '@openfolia/dita': 'none',
  '@openfolia/render-html': 'none',
  '@openfolia/render-typst': 'none',
  '@openfolia/xliff': 'none',
  '@openfolia/xml': 'none',
  '@resvg/resvg-js': 'none',
  '@tiptap/core': 'none',
  '@tiptap/pm': 'none',
  'age-encryption': 'none',
  busboy: 'none',
  croner: 'none',
  'drizzle-orm': 'none',
  express: 'none',
  fflate: 'none',
  nodemailer: 'network',
  'openid-client': 'network',
  pg: 'network',
  'pg-boss': 'network',
  'qrcode-generator': 'none',
  'reflect-metadata': 'none',
  rxjs: 'none',
  sharp: 'none',
  yaml: 'none',
  zod: 'none',
};

/** Node's own modules that never connect. */
const QUIET_BUILTINS = new Set([
  'node:assert',
  'node:buffer',
  'node:crypto',
  'node:events',
  'node:fs',
  'node:module',
  'node:os',
  'node:path',
  'node:perf_hooks',
  'node:process',
  'node:stream',
  'node:string_decoder',
  'node:timers',
  'node:url',
  'node:util',
  'node:v8',
  'node:worker_threads',
  'node:zlib',
]);

/** Source files only: no tests, test helpers or fixtures. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return [
        'node_modules',
        'dist',
        'testing',
        'fixtures',
        '__snapshots__',
      ].includes(name)
        ? []
        : sources(path);
    }
    return /\.ts$/.test(name) &&
      !/\.(spec|test|d)\.ts$/.test(name) &&
      name !== 'testing.ts'
      ? [path]
      : [];
  });
}

const files = SCANNED.flatMap((dir) =>
  dir === 'packages'
    ? readdirSync(join(ROOT, dir))
        .map((name) => join(ROOT, dir, name, 'src'))
        .filter((src) => {
          try {
            return statSync(src).isDirectory();
          } catch {
            return false;
          }
        })
        .flatMap(sources)
    : sources(join(ROOT, dir)),
).map((path) => ({
  path: relative(ROOT, path),
  text: readFileSync(path, 'utf8'),
}));

/** What a file imports (statically or dynamically), as written. */
const importsOf = (text: string): string[] =>
  [
    ...text.matchAll(
      /(?:^\s*(?:import|export)\s[^;'"`]*?\bfrom\s*|\b(?:import|require)\(\s*|^\s*import\s+)(['"])([^'"]+)\1/gm,
    ),
  ].map((m) => m[2] ?? '');

/**
 * The files that load a module by a name the code computes, or by `createRequire`: what they
 * load cannot be read from the source, so each says why it reaches no network.
 */
const DYNAMIC_LOADS: Record<string, string> = {
  'packages/render-typst/src/lib/tokens.ts':
    'createRequire(…).resolve: finds the theme’s token file on disk, loads nothing.',
};

/** A load the scan cannot follow: `import(x)`, `require(x)` or `createRequire`. */
const loadsDynamically = (text: string): boolean =>
  /\bcreateRequire\b|\b(?:import|require)\(\s*(?!['"])[^)\s]/.test(text);

/** The package an import names: `@scope/name` or `name`; a relative path is none. */
const packageOf = (specifier: string): string | undefined => {
  if (specifier.startsWith('.')) return undefined;
  if (specifier.startsWith('node:')) return specifier.split('/')[0];
  const [first, second] = specifier.split('/');
  return first?.startsWith('@') ? `${first}/${second}` : first;
};

const reachesNetwork = (text: string): boolean =>
  importsOf(text).some((s) => NETWORK_MODULE.test(s)) ||
  // The global fetch, however it is called, and the global sockets.
  /(?<![.\w])fetch\s*\(|globalThis\.fetch|\b(?:WebSocket|EventSource)\b/.test(
    text,
  );

describe('the public sandbox’s outbound inventory (#826)', () => {
  it('scans the API and the packages it runs', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('has a decision for every file that can reach the network, and only for those', () => {
    const found = files
      .filter((f) => reachesNetwork(f.text))
      .map((f) => f.path)
      .sort();
    const missing = found.filter((path) => !(path in INVENTORY));
    expect(
      missing,
      'These files can reach the network: add each to INVENTORY with what it does in a public sandbox (and make it so: an adapter that never connects, a setting refused at start, …).',
    ).toEqual([]);
    expect(
      Object.keys(INVENTORY)
        .filter((path) => !found.includes(path))
        .sort(),
      'These INVENTORY entries no longer reach the network (or moved): update INVENTORY.',
    ).toEqual([]);
  });

  it('knows every package the code imports, and whether it can reach the network', () => {
    const imported = new Set(
      files.flatMap((f) =>
        importsOf(f.text)
          .map(packageOf)
          .filter((p): p is string => p !== undefined),
      ),
    );
    const builtins = [...imported].filter((p) => p.startsWith('node:'));
    expect(
      builtins.filter((p) => !QUIET_BUILTINS.has(p) && !NETWORK_MODULE.test(p)),
      'A node: module neither quiet nor in NETWORK_MODULE: classify it.',
    ).toEqual([]);
    const packages = [...imported].filter((p) => !p.startsWith('node:')).sort();
    expect(
      packages.filter((p) => !(p in PACKAGES)),
      'A package the code imports that is not classified: add it to PACKAGES (network: also to NETWORK_MODULE, and decide each file in INVENTORY).',
    ).toEqual([]);
    expect(
      Object.keys(PACKAGES).filter((p) => !packages.includes(p)),
      'PACKAGES lists a package the code no longer imports: remove it.',
    ).toEqual([]);
    for (const [name, kind] of Object.entries(PACKAGES)) {
      expect([name, NETWORK_MODULE.test(name)]).toEqual([
        name,
        kind === 'network',
      ]);
    }
  });

  it('loads every module by a name the scan reads, or says why not', () => {
    expect(
      files
        .filter((f) => loadsDynamically(f.text))
        .map((f) => f.path)
        .sort(),
    ).toEqual(Object.keys(DYNAMIC_LOADS).sort());
  });

  it('runs no remote git command: the content repository is only ever local', () => {
    const git = files.filter((f) =>
      f.path.startsWith('packages/content-repo/src/'),
    );
    expect(git.length).toBeGreaterThan(0);
    for (const { path, text } of git) {
      expect([
        path,
        text.match(
          /'(?:fetch|push|pull|clone|ls-remote|remote|submodule|fetch-pack|send-pack|archive)'/g,
        ),
      ]).toEqual([path, null]);
    }
  });
});
