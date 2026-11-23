# Deploying OpenFolia with containers

OpenFolia runs as four containers and Postgres, from one Compose file: `deploy/compose.yaml`.
This guide covers the one command that starts it all ("Quick start"), what to set, the content
repository, signing in (with a provider you host yourself as the example), backups, upgrades, a
reverse proxy with TLS, Coolify as a worked example, how the images are built and tested, and
the image of the public docs site ("The docs site").

The other `compose.yaml`, at the repository root, is for development only (Postgres and S3 for
`pnpm nx run api:serve-local`). Don't use it for a deployment.

## What runs

| Service    | Image                       | What it is                                                                                          |
| ---------- | --------------------------- | --------------------------------------------------------------------------------------------------- |
| `postgres` | `postgres:18.7-alpine`      | Operational state: users, roles, locks, comments, workflow, the audit log, and a rebuildable index. |
| `api`      | `<OPENFOLIA_IMAGES>/api`    | The JSON:API (`backend/api`), with git, the Typst compiler, the theme's fonts and the migrations.   |
| `worker`   | `<OPENFOLIA_IMAGES>/api`    | The background work (`CCMS_ROLE=worker`): release files, imports, webhooks, sweeps. Scales out.     |
| `editor`   | `<OPENFOLIA_IMAGES>/editor` | The editor's static build behind nginx, which also proxies `/api` to the API.                       |
| `mcp`      | `<OPENFOLIA_IMAGES>/mcp`    | Optional (`--profile mcp`): the MCP server for AI assistants over released content (`backend/mcp`). |
| `backup`   | `<OPENFOLIA_IMAGES>/backup` | Scheduled, encrypted, verified backups (see "Backups"): the API image with the Postgres client.     |

Each OpenFolia image runs as an unprivileged user (`node`, uid 1000, or `nginx`, uid 101) on a read-only
file system. It has no Linux capabilities and can't gain privileges (`no-new-privileges`). Only
`/tmp` (a tmpfs) and the data volume can be written. Each image has a health check: the API's
is `GET /health/ready` (the database and the blob store answer), the editor's is `GET /healthz`.
Base images are pinned by version and digest.

Three volumes hold everything that persists:

- `postgres`: the database.
- `data`, mounted at `/data` in the API and the workers:
  - `/data/content.git`: the content repository (bare), the source of truth for content;
  - `/data/blobs`: images, attachments and archived release PDFs (the `fs` blob store);
  - `/data/ccms-secret.key`: the instance secret key, which the API makes on its first start.
- `backups`, mounted at `/backups` in the backup service: the backups (see "Backups").

A fourth, `backup-staging`, holds a backup run's unencrypted parts while it lasts and is emptied
whenever the backup service starts: never copy it off the host.

## Quick start

You need Docker with Compose 2.24 or newer, on a Linux server or any machine with Docker, and this
checkout. The Typst sandbox needs Linux, which the image provides.

### One command

```sh
deploy/self-host.sh --admin you@example.com
```

It makes the settings file `deploy/.env` (a random Postgres password, readable by you only; the
editor's address, `CCMS_PUBLIC_URL`; the first admin, `CCMS_FIRST_ADMIN_EMAIL`), builds the
images from this checkout (or pulls them when `OPENFOLIA_IMAGES` is set, step 2 below), offers
the sample content when there is no content repository yet, starts the stack, waits until every
service is healthy, and prints the editor's address and the first admin's one-time link:

```text
== Ready
The editor: http://127.0.0.1:8080/
The first admin chooses their password here (once, within the hour; the API's log holds
it until then, so keep that log to yourself; a new one: first-admin, deploy/README.md):

  http://127.0.0.1:8080/set-password#ccms_pwl_…
```

Open the link, choose a password, and you are signed in as the admin. `--sample` puts the
sample content in without asking, `--no-sample` never does, and `--yes` asks nothing (for
scripts); `--help` lists the options. Run it again at any time, for example after an upgrade: it
keeps the settings file, the volumes and the content, and makes no second admin.

**The first admin** comes from `CCMS_FIRST_ADMIN_EMAIL` (and `CCMS_FIRST_ADMIN_NAME`): on its
first start on an instance **without users**, the API makes that user with the role `admin`
(every permission; the role is made too when missing) and, with password sign-in on, logs their
one-time link. On every later start, or when the instance already has a user, the setting does
nothing but say so in the log: it works once and is closed after (unset it then if you like).
With OpenID Connect the admin signs in with the provider instead, which finds the user by this
email address ("Signing in").

**The link in the log** is a trade-off: it is what makes one command enough, but logs are kept,
and log shippers copy them. So that link works **one hour**, once, and closes as soon as the
admin signs in any other way (their first sign-in with the provider, or a code by email). Anyone who can read the
API's log in that hour can use it, as anyone who can run `docker compose exec` could make an
admin anyway. To keep it out of the log altogether, set `CCMS_FIRST_ADMIN_LINK_LOG=false`: the
start then makes the admin without a link. For a new link, or to revoke the one in the log, run
`first-admin` (step 5 below): it prints a new link on your terminal only and the earlier one
stops working.

### Step by step

The same, by hand:

1. **Settings.** Create `deploy/.env` (Compose reads it next to `compose.yaml`) with at least a
   Postgres password:

   ```sh
   cd deploy
   printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)" >> .env
   chmod 600 .env
   ```

   Keep this file: Postgres reads the password only on its first start.

2. **Images.** Either pull the published images:

   ```sh
   printf 'OPENFOLIA_IMAGES=ghcr.io/<owner>/openfolia\nOPENFOLIA_VERSION=v1.2.3\n' >> .env
   docker compose pull
   ```

   For a release, pin them by their digests as well: put the release's `compose.digests.yaml`
   (attached to its GitHub Release, listed in its `SHA256SUMS`) next to `compose.yaml` and set
   `COMPOSE_FILE=compose.yaml:compose.digests.yaml` in `.env`. Docker then pulls and runs exactly
   the images the release pushed, by digest, even if someone moves the tag in the registry later
   (see "Images pinned by digest").

   Or build them from this checkout. Then add `-f compose.yaml -f compose.build.yaml` to every
   `docker compose` command below, or set `COMPOSE_FILE=compose.yaml:compose.build.yaml` in `.env`:

   ```sh
   docker compose -f compose.yaml -f compose.build.yaml build
   ```

3. **Content.** Put a content repository on the data volume (see "Content repository"). To try it
   out, use the sample instead:

   ```sh
   docker compose run --rm --no-deps api node docker/sample-content.mjs
   ```

4. **Start:**

   ```sh
   docker compose up -d --wait
   curl -s http://127.0.0.1:3000/health    # {"status":"ok","database":"ok",...}
   ```

   The editor is at `http://127.0.0.1:8080`, the API at `http://127.0.0.1:3000` (its reference
   at `/docs`). Both listen on 127.0.0.1 only, for a reverse proxy on the same machine (see
   "Reverse proxy with TLS").

5. **The first admin** (#610), who signs in with their email address and a password: either
   `CCMS_FIRST_ADMIN_EMAIL` in `.env` before the first start (above), or this command at any
   time. It makes the user (and the role `admin`, with every permission, when missing) and prints
   a one-time link to choose their password, valid 7 days (`CCMS_INVITE_DAYS`) and once:

   ```sh
   docker compose exec api node dist/database/first-admin.main.js you@example.com \
     --name "Your Name" --editor https://docs.example.com/
   ```

   `--editor` is the editor's address as people open it (default: `CCMS_PUBLIC_URL`). Run it
   again for a new link; the earlier one stops working (also the one the first start logged).
   Its link goes to your terminal, never to the log. Further people: Admin › Users › New
   user, which makes their invite.

6. **A first token** for API clients (a service account's token, printed once):

   ```sh
   docker compose exec api node dist/database/service-token.main.js <account> --role <role>
   ```

**Before real use:** put a reverse proxy with TLS in front and set `CCMS_PUBLIC_URL` to its
`https://` address ("Reverse proxy with TLS"), set up the backups ("Backups") and, where your
organisation has one, sign-in with its OpenID Connect provider ("Signing in").

## Settings

**The `CCMS_` prefix stays.** The API's, the MCP server's and the workers' settings keep the
prefix they had before the product was named OpenFolia (`CCMS_DATABASE_URL`, `CCMS_PUBLIC_URL`,
…), so an existing deployment's settings files go on working unchanged after an upgrade; so do
the secret key file's name (`/data/ccms-secret.key`) and the database names. Only the Compose
file's own settings are `OPENFOLIA_*`.

There are three places for settings:

- **`deploy/.env`**: what `compose.yaml` itself uses. These are `POSTGRES_PASSWORD`,
  `OPENFOLIA_IMAGES`, `OPENFOLIA_VERSION`, `OPENFOLIA_BIND`, `OPENFOLIA_API_BIND`, the published ports
  (`OPENFOLIA_EDITOR_PORT`, `OPENFOLIA_API_PORT`, `OPENFOLIA_MCP_PORT`) and the API settings
  that `compose.yaml` passes on: `CCMS_AUTH_MODE` (default `token`), `CCMS_API_TOKEN`,
  `CCMS_EDITOR_ORIGINS`, `CCMS_SOURCE_URL`, `CCMS_PUBLIC_URL`, `CCMS_FIRST_ADMIN_EMAIL` and
  `CCMS_FIRST_ADMIN_NAME` ("Quick start"), `CCMS_TRUST_PROXY` (default `1`),
  the `CCMS_MAIL_*` settings (see "Email"),
  `CCMS_EDITOR_API_TOKEN` and the MCP server's
  `CCMS_MCP_*`.
- **`deploy/api.env`** (optional): any other API setting from `.env.example`, one `NAME=value`
  per line. Examples are an S3 blob store, the PDF workers and the webhooks. A setting named
  under `environment:` in `compose.yaml` wins over this file, so set those in `deploy/.env`.
- **The images' own defaults:** `HOST=0.0.0.0`, `PORT=3000`,
  `CCMS_CONTENT_DIR=/data/content.git`, `CCMS_BLOB_DRIVER=fs` and
  `CCMS_BLOB_FS_ROOT=/data/blobs`.

`.env.example` at the repository root describes every setting, with its format and default. Its
section "Container deployment" lists the ones above.

**Secrets from files.** Each of `CCMS_DATABASE_URL`, `CCMS_API_TOKEN`, `CCMS_S3_ACCESS_KEY_ID`,
`CCMS_S3_SECRET_ACCESS_KEY`, `CCMS_STYLE_REVIEW_API_KEY`, `CCMS_EMBEDDER_API_KEY`, `CCMS_AUDIT_SINK_SECRET`, `CCMS_OIDC_CLIENT_SECRET`, `CCMS_MCP_API_TOKEN` and
`CCMS_MCP_HTTP_TOKEN` can come from a file: set `<NAME>_FILE` to its path, for example a Compose
secret under `/run/secrets/`. The editor takes `CCMS_EDITOR_API_TOKEN_FILE` in the same way. The
instance secret key has `CCMS_SECRET_KEY_FILE`, which the API reads itself. No secret is ever
part of an image: the images hold code only, and every setting comes in when the container
starts. `compose.yaml` builds `CCMS_DATABASE_URL` from `POSTGRES_PASSWORD` itself, so to take
the database URL and the passwords from files, add a `compose.override.yaml` like this one (a
blank value counts as unset):

```yaml
services:
  postgres:
    environment:
      POSTGRES_PASSWORD: ''
      POSTGRES_PASSWORD_FILE: /run/secrets/postgres-password
    secrets: [postgres-password]
  api:
    environment:
      CCMS_DATABASE_URL: ''
      CCMS_DATABASE_URL_FILE: /run/secrets/database-url
    secrets: [database-url]
secrets:
  postgres-password:
    file: /srv/secrets/postgres-password
  database-url:
    file: /srv/secrets/database-url
```

Then set `POSTGRES_PASSWORD` in your settings file to any placeholder, since `compose.yaml`
requires it.

**Memory.** Each PDF worker can take up to about 450 MB (`packages/render-typst`, "Memory").
There is one worker per spare CPU by default. On a small server, set `CCMS_PDF_WORKERS` in
`api.env`. A release's files render in the background on half of them by default
(`CCMS_RENDER_CONCURRENCY`, at most `CCMS_PDF_WORKERS`); readers' PDFs and previews go first.

## Workers

The API and the background work run in processes of their own (`CCMS_ROLE`, #527), from the
same image:

- **`api`** (`CCMS_ROLE=api`) serves the API and only enqueues jobs. It runs no background
  loop and keeps a small PDF pool of 2 workers (`CCMS_PDF_WORKERS`) for what readers ask for:
  a manual's PDF, page images, checks. Past its queue (`CCMS_PDF_QUEUE`, 4 per PDF worker) it
  answers 503 with `Retry-After`, so a burst of PDFs never costs other readers their answers.
  Its `/health/ready` never depends on a worker.
- **`worker`** (`CCMS_ROLE=worker`) consumes every job: release planning and files, imports,
  webhook deliveries, notifications, and it runs the sweeps and recounts. It serves no API:
  only `GET /health` and `GET /health/ready`, on the container's loopback interface for its
  health check, with the job queue's lag. It never migrates; it starts once the API has.
- **`all`** (the default outside this file) does both in one process, as before.

More workers: `docker compose up -d --scale worker=3`. Each job is taken by one worker only, and
the per-release caps (40 files of one release queued at once, 8 moved ahead for readers) hold
across them. A product's releases are planned one at a time across the workers (a Postgres
advisory lock), strictly in the order they were cut (the turn plans the product's earlier
releases still to be planned first), so a release finds the one before it planned and shares its
unchanged files; different products plan side by side. Each process keeps its own PDF pool, render
concurrency and rate limits (`backend/api/README.md`, "Roles", lists every one). Settings for
the workers only, such as their PDF pool, go into `deploy/worker.env` (over `api.env`).

**Previews stay on the API.** What a reader waits for (a manual's PDF, page images, checks) the
API renders in its own pool, never through the job queue: a worker's PDF processes are busy with
release files and a render cannot be interrupted, so a preview sent there would wait for one to
finish, and previews keep working with no worker up. A release file not rendered yet is moved to
the front of the queue and answered `409 output-not-ready` until a worker made it. For a larger
API pool, set `CCMS_PDF_WORKERS` in `api.env` and the workers' own in `worker.env`.

**The API first.** On a host they share, a worker yields the CPU to the API: the worker (on Linux each
of its threads) and the PDF processes it forks run at nice 10 (`CCMS_WORKER_NICE`, 0 to 19). For a hard bound,
limit each worker container's CPUs with `OPENFOLIA_WORKER_CPUS` in `deploy/.env` (for example
`2` on an 8-CPU host, leaving the rest to the API and Postgres; default `0`, no limit, since
Docker refuses a limit above the host's CPUs).

**Sizing.** Memory for PDFs is about `workers × CCMS_PDF_WORKERS × 450 MB`, plus the API's
2 × 450 MB. With a CPU limit, give each worker as many PDF workers as CPUs (`CCMS_PDF_WORKERS` in
`worker.env`, the same as `OPENFOLIA_WORKER_CPUS`): the pool's default is the host's CPUs less
one, not the limit's, and more only wait for a CPU and take memory. A worker renders release files on all its PDF workers (`CCMS_RENDER_CONCURRENCY`). On one server with 8 CPUs and 8 GB,
for example, set `CCMS_PDF_WORKERS=3` in `worker.env` and `OPENFOLIA_WORKER_CPUS=3`, and run 2
workers: 2 × 3 × 450 MB plus the API's 900 MB is about 3.6 GB at the peak, and 2 CPUs stay
the API's. Add workers (on more hosts, against the same
Postgres and blob store: S3, as `/data/blobs` on a volume is one host's) when release files
take too long; the admin's System page shows the jobs waiting and warns when jobs wait and no
worker took one for 5 minutes.

A worker binds its health server to `127.0.0.1` here (`HOST`), as only the container's own
health check needs it. Run outside this file (the image sets `HOST=0.0.0.0`), set
`HOST=127.0.0.1` for a worker too, unless an orchestrator probes it from outside: its
`/health` shows the job queue's counts to whoever reaches it. Rotating the instance secret key
stops the workers as well as the API (`docker compose stop api worker`): they deliver the
webhooks with it.

**Upgrading to separate workers.** `compose.yaml` now starts the API with `CCMS_ROLE=api` and
the background work in `worker`. Both read `api.env`: a `CCMS_PDF_WORKERS` there now sizes the
API's own pool too (no longer its default of 2), so move it, with `CCMS_RENDER_CONCURRENCY`,
into `worker.env`. The API ignores `CCMS_RENDER_CONCURRENCY`.

To run everything in one container instead, set `OPENFOLIA_API_ROLE=all` in the compose
settings file and start with `--scale worker=0`.

**Blobs in S3.** For S3-compatible storage instead of the data volume, put the S3 settings into
`api.env`: `CCMS_BLOB_DRIVER=s3`, `CCMS_S3_ENDPOINT`, `CCMS_S3_BUCKET`, the credentials, and
`CCMS_S3_FORCE_PATH_STYLE`. To move existing blobs, see `backend/api/README.md`, "Blob store".

**Search.** By default the API indexes the content in Postgres as readers search: words in any
of their forms in the content's language, and typos in titles and keywords (`pg_trgm`, which
the stock image has and the migrations create). Nothing to set up. `CCMS_SEARCH_ADAPTER=memory`
searches in the API's memory instead (word matching alone). See `backend/api/README.md`,
"Postgres search".

### Semantic search

Off by default: then no text leaves the server. To find by meaning too (a reader's
"replace the cell" finds "change the battery"), the API needs an embeddings endpoint and
Postgres needs pgvector.

**When it is on, module text leaves the API.** A background job posts every indexed text to
the endpoint (titles, keywords, block and FAQ text of what readers searched, the drafts of
change sets included for their authors), and every search posts its query. Run the model
yourself, beside the API on the same network, unless you accept that the content goes to a
hosted provider.

1. **Postgres with pgvector.** `compose.vector.yaml` builds `docker/postgres/Dockerfile`: the
   same `postgres:18.7-alpine` as `compose.yaml` (pinned by version and digest) with pgvector
   0.8.7 compiled in (its source pinned by SHA-256). It is a drop-in on the existing `postgres`
   volume: same Postgres version, same data directory, nothing to dump or restore.

   ```sh
   docker compose -f compose.yaml -f compose.vector.yaml up -d --build --wait
   ```

   Keep naming both files in every later `docker compose` command (or set
   `COMPOSE_FILE=compose.yaml:compose.vector.yaml` in your settings file). A managed Postgres
   needs the `vector` extension available (most have it); the API creates it itself.

2. **An embeddings endpoint.** Either the local embedding worker (below: nothing leaves the
   installation), or another endpoint, in `api.env`: `CCMS_EMBEDDER_URL` (the full URL requests
   are posted to), `CCMS_EMBEDDER_MODEL`, `CCMS_EMBEDDER_DIMENSIONS`, and if it needs one
   `CCMS_EMBEDDER_API_KEY` (or `CCMS_EMBEDDER_API_KEY_FILE`; `https://` then, except to
   localhost). Any endpoint that takes `{ "model", "input": [texts] }` and answers
   `{ "data": [{ "embedding": [...], "index": 0 }] }` works. The settings reference at the
   repository root describes these and `CCMS_EMBEDDER_TIMEOUT_MS` and
   `CCMS_EMBEDDER_MIN_SIMILARITY`.
3. Restart the API. It embeds the indexed text in the background (`search.embed`), creates the
   vector index on the first search, and finds by meaning once the text is embedded. Changing
   the model or its dimensions embeds everything again. If the endpoint is down, search goes on
   by words, and the job retries. Without pgvector the API logs it and searches by words.

#### The local embedding worker

`compose.embedder.yaml` runs a sentence-embedding model on the CPU beside the API
(`backend/embedder`, ONNX Runtime): the content never leaves the host, and nothing in the worker
makes a network call. It is off unless you name the file; without it nothing changes.

1. **A model, once.** Any sentence-embedding model exported to ONNX with a `tokenizer.json`
   that is **multilingual** (the content's languages), made for **sentence embeddings**, with
   vectors of **at most 2,000 numbers**, under a licence that lets you run it. A small one
   (about 100 million parameters, 384 dimensions, 120 to 470 MB) is enough; its card names its
   pooling (`mean` or `cls`) and any prefix it expects (`backend/embedder/README.md`, "The
   model"). Fetching it is the only download, and you run it yourself:

   ```sh
   mkdir -p embedder-model
   curl -fL -o embedder-model/model.onnx     <the model's ONNX file>
   curl -fL -o embedder-model/tokenizer.json <its tokenizer.json>
   sha256sum embedder-model/model.onnx embedder-model/tokenizer.json
   ```

   Check the checksums against the ones its publisher gives, where it does. The folder is
   git-ignored and mounted read-only (`OPENFOLIA_EMBEDDER_MODEL_DIR`, default
   `./embedder-model`). To bake it into an image instead: `FROM openfolia/embedder:<version>`,
   `COPY embedder-model/ /models/`.

2. **Its settings**, in the settings file beside `compose.yaml` (`deploy/.env`):

   ```sh
   CCMS_EMBEDDER_MODEL=<a name for it>          # also what the API sends; changing it embeds everything again
   CCMS_EMBEDDER_DIMENSIONS=384                 # the length of its vectors
   CCMS_EMBEDDER_MODEL_SHA256=<sha256 of model.onnx>
   CCMS_EMBEDDER_TOKENIZER_SHA256=<sha256 of tokenizer.json>
   # as the model's card says, e.g. CCMS_EMBEDDER_POOLING=cls, CCMS_EMBEDDER_PREFIX="query: "
   ```

   A file whose checksum differs is refused, and the worker does not start. The compose file
   sets the API's and the workers' `CCMS_EMBEDDER_URL`, `_MODEL` and `_DIMENSIONS` itself (over
   `api.env`); set no `CCMS_EMBEDDER_API_KEY` (the worker takes none, and the API refuses a key
   over plain HTTP).

3. **Start** with all three files:

   ```sh
   docker compose -f compose.yaml -f compose.vector.yaml -f compose.embedder.yaml up -d --build --wait
   ```

   (or `COMPOSE_FILE=compose.yaml:compose.vector.yaml:compose.embedder.yaml` in the settings
   file).

**How it is kept apart.** The worker is on a network of its own that Docker marks internal (no
route out of the host); only the API and the workers join it, and it publishes no port. Its
container is read-only, without capabilities, limited to `OPENFOLIA_EMBEDDER_MEMORY` (default
2g) and `OPENFOLIA_EMBEDDER_CPUS` (default none). It loads the model once and runs one request
at a time on `CCMS_EMBEDDER_THREADS` threads (default 2); at most 32 texts of 4,000 characters
per request, as the API sends them, and `CCMS_EMBEDDER_QUEUE` requests waiting (default 8), then
503 (the API's job retries, a search goes on by words). Its log names the model's load time,
never a text. `deploy/semantic-search-test.sh` checks the whole of it with the network cut off
(`offline.yaml`): neither the API nor the worker reaches the outside, and a German query finds
an English module by meaning.

**What it costs** (a 384-dimension multilingual model of 118 MB, int8, 2 threads): about 500 MB
of memory, and a query embedded in a few milliseconds. The measurements on the `large` profile
are in the pull request of #532.

## Content repository

The API reads and writes a **bare** Git repository at `/data/content.git`. Until one is there,
the API starts and answers its health check, but every content request fails. Its log says so
when it starts.

- From a Git server:

  ```sh
  docker compose run --rm --no-deps api git clone --bare https://git.example.com/docs/content.git /data/content.git
  ```

- From a bare repository on the host:

  ```sh
  docker compose run --rm --no-deps -v /srv/content.git:/import:ro api \
    git -c safe.directory=/import clone --bare /import /data/content.git
  ```

  `safe.directory` is needed because Git refuses to read a repository that another user owns.

- The sample, to try it out: `docker compose run --rm --no-deps api node docker/sample-content.mjs`.
  It refuses to run if something is already at `/data/content.git`.

The API writes change sets as branches and releases as tags into this repository. It is the
copy that counts, so back it up (see "Backups"). To publish it elsewhere, push from it.

## Signing in

- **Email address and password** (#610, on by default; `CCMS_PASSWORD_SIGN_IN=off` turns it
  off): the first admin comes from the command line ("Quick start", step 5); every other person
  is added in Admin › Users, which makes a one-time invite link to copy, emailed too when email
  is set up ("Email"). An admin can make a new invite or a reset link at any time (the earlier
  link stops working) and withdraw an open invite. "Forgot password" shows on the sign-in page
  only with email and `CCMS_PUBLIC_URL` set; a reset link works one hour, once. Passwords are
  hashed with argon2id; failed sign-ins count toward `CCMS_AUTH_FAILURES_MAX` per client address
  and per account. Setting a password through a link, or changing it (the account menu), ends
  the person's other sessions. Password sign-in works beside OpenID Connect: the sign-in page
  shows the form and the provider's button. Unlike OpenID Connect, it does not refuse the shared
  `CCMS_API_TOKEN`, which token-mode setups use; **leave `CCMS_API_TOKEN` and
  `CCMS_EDITOR_API_TOKEN` unset** where people sign in, or anyone reaching the editor reads every
  draft without signing in (the API warns at start-up).
- **A one-time code by email** (#634, on by default wherever email is set up and password
  sign-in is on, "Email"; `CCMS_EMAIL_CODE_SIGN_IN=off` turns it off; with
  `CCMS_PASSWORD_SIGN_IN=off` only `CCMS_EMAIL_CODE_SIGN_IN=on` offers it, since it signs in
  without the provider; never in demo mode): the sign-in page offers "Email me a code". The
  person enters their address and gets a six-digit code and a link that signs in (the link only
  with `CCMS_PUBLIC_URL`), each working once, for `CCMS_EMAIL_CODE_MINUTES` (10) minutes; a new
  code revokes the earlier one. The answer is the same whether or not the address is known.
  Anyone with an active account and an email address may use it, with a password or without
  one, so people who prefer it never set one. Requests and wrong codes each count per account
  (`CCMS_PASSWORD_FAILURES_MAX`, apart from passwords) and per client address; once the wrong
  codes use up the tries, the code is revoked. **Codes alone** (#639), without passwords or a
  provider: set `CCMS_PASSWORD_SIGN_IN=off`, `CCMS_EMAIL_CODE_SIGN_IN=on` and email
  (`CCMS_MAIL_URL`; `on` is refused at start-up without it). The sign-in page then shows only
  "Email me a code", and the first admin (`CCMS_FIRST_ADMIN_EMAIL`, or `first-admin`) signs in
  with a code at their address; the start-up log says so instead of printing a link. As with
  passwords, leave `CCMS_API_TOKEN` and `CCMS_EDITOR_API_TOKEN` unset.
- **Sign-in with OpenID Connect** (#37), where real people sign in: register a client at your
  provider (authorization code with PKCE) with the redirect URL
  `https://<editor>/api/auth/oidc/callback` and the post-logout redirect URL
  `https://<editor>/sign-in`, then set `CCMS_OIDC_ISSUER`, `CCMS_OIDC_CLIENT_ID`,
  `CCMS_OIDC_REDIRECT_URL` (and `CCMS_OIDC_CLIENT_SECRET` for a confidential client) on the API
  (`.env.example`, the sign-in block; `backend/api/README.md`, "Sign-in"). Seed or create the
  first admin with their email address before their first sign-in, or map the admins' group to
  the admin role (`groupMappings` in a seed file). **Leave `CCMS_API_TOKEN` and
  `CCMS_EDITOR_API_TOKEN` unset**: the API refuses the shared token with sign-in, as it would let
  anyone reaching the editor read every draft without signing in. Not with demo mode.
  The provider must not let people set an email address it then reports as verified
  (`CCMS_OIDC_LINK_BY_EMAIL`). Moving to another provider (a new issuer): under the default
  `pending`, people who signed in before would get a second account at their first sign-in at the
  new one; set `any` for the move, if the new provider guarantees verified addresses, and back
  once everyone has signed in.

### Example: a provider you host yourself

Any standard OpenID Connect provider works, hosted or your own: OpenFolia reads the provider's
discovery document (`<issuer>/.well-known/openid-configuration`) and needs nothing specific to
it. To keep sign-in on your own servers, run an open-source identity server beside OpenFolia, in
a container of its own, behind the same reverse proxy, for example at `https://id.example.com`
with the editor at `https://docs.example.com`. In the provider's admin console:

1. **A client** (some providers call it an application) for the authorization code flow with
   PKCE (S256). A confidential client has a secret; a public one doesn't need any.
2. **Its addresses:** the redirect URL `https://docs.example.com/api/auth/oidc/callback`, and,
   to sign out there too, the post-logout redirect URL `https://docs.example.com/sign-in`.
3. **Its claims:** the scopes `openid profile email` (`CCMS_OIDC_SCOPES`), with `email` and
   `email_verified` in the ID token or the userinfo answer. For roles from groups, a claim with
   the person's groups (`groups`, or `CCMS_OIDC_GROUPS_CLAIM`; mapped in Admin › Group mappings).
   Don't let people set an email address the provider then reports as verified.

Then, in `deploy/api.env`:

```sh
CCMS_OIDC_ISSUER=https://id.example.com/realms/docs   # exactly as its discovery document names it
CCMS_OIDC_CLIENT_ID=openfolia
CCMS_OIDC_REDIRECT_URL=https://docs.example.com/api/auth/oidc/callback
CCMS_OIDC_NAME=Company account                       # the sign-in button's label (optional)
```

The client secret, for a confidential client, comes from a file: add it to a
`compose.override.yaml` as in "Settings" (a Compose secret, `CCMS_OIDC_CLIENT_SECRET_FILE:
/run/secrets/oidc-client-secret` under the `api` and `worker` services' `environment`). The API
container must reach the issuer at the same address as people's browsers do, over `https://`
with a certificate it trusts: with a provider beside the stack, that is its public name through
the reverse proxy. For a certificate from your own CA, mount the CA file and set
`NODE_EXTRA_CA_CERTS` to its path in `api.env`.

**The first admin** then needs no password: set `CCMS_FIRST_ADMIN_EMAIL` to your address at the
provider before the first start ("Quick start"), and sign in with the provider's button. The
provider's sign-in finds that user by the verified email address and links it, since they have
never signed in before (`CCMS_OIDC_LINK_BY_EMAIL=pending`, the default). To offer only the
provider, set `CCMS_PASSWORD_SIGN_IN=off`; the start-up then prints no password link.

`deploy/self-host-test.sh` does all of this in CI against a test provider ("Smoke test").

Without sign-in:

- **Token mode** (`CCMS_AUTH_MODE=token`, the default): API clients authenticate with a
  service account's token (see "Quick start", step 6). With `CCMS_PASSWORD_SIGN_IN=off` and no
  OpenID Connect, the editor loads and its sign-in page says that sign-in is not set up. If `CCMS_API_TOKEN` is set, it acts as a read-only service
  that reads everything, drafts included.
- **Demo mode**, for evaluating on a private network only: set `CCMS_AUTH_MODE=demo`, set
  `CCMS_API_TOKEN` to a random token (`openssl rand -hex 32`), set `CCMS_EDITOR_API_TOKEN` to the
  same token, set `CCMS_EDITOR_HOSTS` to the host names people open the editor under (for
  example `docs.internal.example,127.0.0.1`), and seed the example users with
  `docker compose exec api node dist/database/seed.main.js --example`. The editor's proxy then
  adds the token to `/api` requests from the editor's own page, and the sign-in page lists the
  seeded users. **Anyone who reaches the editor can act as any user, the admin included.** Keep
  a demo instance on a private network, or behind a proxy that authenticates people first.

The token is never injected by default: `CCMS_EDITOR_API_TOKEN` is opt-in, and the editor
refuses to start with it unless `CCMS_EDITOR_HOSTS` is set too. With a token, the proxy guards
it against other websites in three ways:

- **Host allowlist:** only the hosts in `CCMS_EDITOR_HOSTS` are served. Any other `Host` gets
  421 from a default server and is never proxied. This stops DNS rebinding, where a page on
  another host name that resolves to this server would carry its own name as both `Host` and
  `Origin`.
- **Origin:** a request whose `Origin` is not the editor's own is refused (403).
- **Same origin shown:** an `/api` request must carry either the editor's `Origin` or
  `Sec-Fetch-Site: same-origin`, which browsers send on the editor's own requests. A
  cross-site `<img>` or link, or a script without either header, is refused (403) before the
  token is added. Browsers send `Sec-Fetch-Site` only to a secure origin, so open a demo
  editor over HTTPS (through the reverse proxy) or on `localhost`/`127.0.0.1`. Over plain HTTP
  on another address, its reads are refused.

A program that can reach the editor directly can still send those headers itself. That is why
a demo instance belongs on a private network.

## Email

The API sends email through your own mail server (SMTP). Each email carries the product name,
logo and colour from Admin › Branding, is written in the person's language (English or German),
and has an HTML part and a plain-text part. Sign-in links (invites, password resets) are the first
emails it sends. Without a mail server nothing is emailed, and the editor offers those links to
copy instead.

Set these in your Compose settings file (`compose.yaml` passes them on to the API and to the
workers, which send the email):

```sh
CCMS_MAIL_URL=smtp://mail.example.com:587   # or smtps://mail.example.com:465
CCMS_MAIL_FROM=docs@example.com             # the sender's name is the product name
CCMS_MAIL_USER=docs@example.com             # when the server wants a sign-in
CCMS_MAIL_PASSWORD_FILE=/run/secrets/mail-password
CCMS_PUBLIC_URL=https://docs.example.com/   # the base of every link in an email
```

- **TLS.** `smtps://` uses TLS from the first byte. On `smtp://`, STARTTLS is required
  (`CCMS_MAIL_REQUIRE_TLS`, default `true`). A server that offers no STARTTLS gets nothing, not
  even the sign-in. The server's certificate is always verified. If a private authority signed
  it, set `CCMS_MAIL_CA_FILE` to that authority's PEM file.
- **The password** comes from `CCMS_MAIL_PASSWORD`, or from a file named by
  `CCMS_MAIL_PASSWORD_FILE`. When both are set, the file wins. For Compose secrets, add a
  `compose.override.yaml` like this one:

  ```yaml
  services:
    api:
      secrets: [mail-password]
    worker:
      secrets: [mail-password]
  secrets:
    mail-password:
      file: /srv/secrets/mail-password
  ```

  The container's user must be able to read the file.

- **The instance secret key.** A queued email is sealed under it, because the email may hold a
  sign-in link. Without a key (`CCMS_SECRET_KEY_GENERATE=false` and none set), email stays off:
  the API logs this at start-up, and Admin › System › Email shows why.
- **Language.** An email goes out in the person's language when the API knows it, and otherwise
  in `CCMS_MAIL_LANGUAGE` (`en` or `de`, default `en`).
- **Checking it.** Admin › System › Email shows the server, the TLS mode and the sender, never
  the password. "Send a test email" sends one to your own address. Emails are sent in the
  background and retried for about half an hour. An email that fails for good is recorded in the
  audit log as `mail.failed` (Admin › Audit), without its address or content.
- **What is kept.** A queued email waits in the database, sealed, until it is sent or fails for
  good. Then it is deleted, so no email body is ever stored.

## Backups

| What                                                                       | Where                                                  | Back up?                                                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Content (modules, manuals, change sets, releases)                          | `data`: `/data/content.git`                            | **Yes.** The source of truth.                                                                                                                                    |
| Users, roles, comments, workflow, audit log, notifications, webhooks, jobs | `postgres`                                             | **Yes.**                                                                                                                                                         |
| Images, attachments, archived release PDFs                                 | `data`: `/data/blobs` (or the S3 bucket)               | **Yes.** Postgres refers to them by hash. The backup service copies `/data/blobs`; an S3 bucket is not in the backup, so keep it versioned.                      |
| The instance secret key                                                    | `data`: `/data/ccms-secret.key` (or `CCMS_SECRET_KEY`) | **Yes, with the database.** Without it, the stored secrets (webhook signing secrets) can't be read, and the API refuses to start with a database that holds any. |
| The module index, release diffs, image renditions                          | Postgres and the blob store                            | Rebuildable: `docker compose exec api node dist/modules/index-rebuild.main.js` builds the index again; renditions are made again on request.                     |
| The images, `deploy/.env`                                                  | the registry, the server                               | Keep `deploy/.env` (it holds the Postgres password) somewhere safe. The images can be pulled again.                                                              |

The `backup` service backs all of that up for you (#529). Each run, in this order:

1. **The database**: `pg_dump --format=custom` of one snapshot, in a read-only transaction that also
   counts every table's rows and lists the blobs the database refers to.
2. **The content repository**: `git bundle create --all`, one consistent file of every branch and tag.
3. **The archive**: the dump, the bundle, the blob folder (every blob the dump refers to, and any
   uploaded since) and the instance secret key, in one tar streamed straight into
   [age](https://age-encryption.org) encryption to the backup key. Nothing unencrypted is written
   outside the run's staging folder (the `backup-staging` volume, never the `backups` volume you
   copy off the host; emptied whenever the service starts), and a run without a backup key is
   refused.
4. **The check** (default on, see below), then the file goes to its location (a subfolder of the
   `backups` volume, or an S3-compatible bucket) and old backups are pruned by the retention.

A backup is named `openfolia-backup-<UTC time>-<run>.tar.age`. Only one run happens at a time, also
across several backup services (a Postgres advisory lock).

### Setting it up

In the editor, **Admin, Backups** (permission `admin.backups`, which an upgrade grants to every role
holding `admin.roles`):

1. **Create the backup key.** The page shows it once: download it or copy it, and keep it apart from
   the server (a password manager, a printed copy in a safe). Every backup is encrypted to it; **without
   it no backup can be restored**, and the server never keeps a copy inside the backups. The server
   keeps only its public half, and (with "Verify by decrypting") the private half sealed under the
   instance secret key, so scheduled runs can check what they wrote.
2. **Choose the schedule** (daily, weekly on a weekday, every few hours, or a cron expression; the page
   shows the next three runs), the time of day and the time zone.
3. **Choose the location** and press **Test location**: it writes, reads back and deletes a small file,
   and shows the exact error when that fails. For S3, the secret access key is sealed under the
   instance secret key and never shown again ("Set", with Replace and Remove).
4. **Turn backups on**, and press **Back up now** once. The history shows each run: time, size,
   duration, location, the key's fingerprint, and verified or failed with the reason.

Rotating the key (**Rotate key**) makes a new one for the backups from then on. Older backups stay
encrypted to the key they were made with: the history shows which, by fingerprint. Keep the old key
until those backups are pruned.

The admin overview shows "Last backup: 6 hours ago, verified", and a warning when the last good backup
is older than `CCMS_BACKUP_WARN_AFTER_HOURS` (26), after a failed run, while the service is not
running, or "Not set up". The `admin.backups` holders get one notification per incident (a failure,
or a backup overdue), not one per run.

### Settings from the environment

Each setting of the page can also come from a `CCMS_BACKUP_*` variable in `deploy/backup.env`
(`.env.example`, "Backups"). **Precedence: a variable that is set wins**, and the page shows that
field read-only, naming the variable; an unset variable leaves the page's value, read from the
database at every pass (no restart); unset on both, the default. `CCMS_BACKUP_KEY_FILE` takes the
backup key from an age identity file (`age-keygen -o key.txt`) instead of the page.

### The check, and verifying by decrypting

With **Verify after each run** on (the default), a backup counts only once it was restored somewhere
safe: the dump into a throwaway database `<db>_verify_<run>` (`pg_restore --exit-on-error`, then the
migrations table and every table's row count compared with the snapshot), the bundle cloned and
`git fsck --full`, and the SHA-256 of each blob the dump refers to. The throwaway database is always
dropped; leftovers of a stopped run (older than an hour) are dropped when the service starts.

- The database user needs `CREATEDB` (the compose `openfolia` user has it), or set
  `CCMS_BACKUP_VERIFY_DATABASE_URL` to another server.
- The check needs about as much free disk on that server as the database takes, and the backups
  volume about twice a backup's size while a run lasts.

**Verify by decrypting** (default on) decrypts the finished file with the backup key, so the check
covers exactly what was stored. For that the server keeps the private key, sealed under the instance
secret key: whoever holds the database, the instance secret key and a backup can read the backup.
Turned off, the server keeps no private key: it checks the parts before they are encrypted, and the
encrypted file only by its age header, size and SHA-256. A backup is then readable only with the key
you keep, at the price of a check that does not open the file itself. Do a restore drill (below) now
and then either way.

### Restoring a backup

Restore onto a fresh stack with the same settings file of Compose (so the same `POSTGRES_PASSWORD`).
The restore asks for the backup key; it refuses an instance that holds anything (tables, a content
repository, blobs, another instance secret key) unless given `--force`, and it refuses while a
backup runs: on a running stack, `docker compose stop api worker backup` first.
On a new host, restore before the first start: `self-host.sh` (or a first start with
`CCMS_FIRST_ADMIN_EMAIL`) makes a user, and the restore then refuses the instance as not empty.

```sh
docker compose up -d --wait postgres
# The key from a file on your machine, on stdin (--key-file -), or from a file in the container
docker compose run --rm -T restore openfolia-backup-20261120T020000Z-72ad5ad9.tar.age --key-file - < key.txt
# From the S3 location instead of the backups volume (CCMS_BACKUP_LOCATION=s3 and its settings in backup.env):
#   docker compose run --rm -T restore <name> --s3 --key-file - < key.txt
# Finish the restore before the first start (below): the SQL of "After a restore", saved as a file
docker compose exec -T postgres psql -U openfolia -d openfolia -v ON_ERROR_STOP=1 < after-a-restore.sql
docker compose up -d --wait
```

**After a restore**, before the first start: the database now runs on another Postgres server,
which counts transactions anew, so the events waiting for notifications, webhooks and the change
feed would sort wrongly and new ones be skipped. The server holds them instead (Admin, System says
"Delivery is held after a restore"; the log says so at error level; the change feed answers 503
`outbox-blocked`) until you run, once, the SQL in `backend/api/README.md`, "Outbox", "After a
restore" (also in the user guide, `guide/self-hosting/after-a-restore`), as above or later with
`docker compose stop api worker` first. It needs no input; change-feed readers resync afterwards. For a backup from before this version, start once first (the migrations add the latch), then `docker compose stop api worker` and run it. With
an audit sink set, its own step follows (below, "Audit log sink and retention").

Restore only backups from your own location: anyone who knows the backup key's public recipient
can make a file that decrypts, so keep the location writable only by the backup service (object
lock or versioning on S3).

The restore decrypts the file, checks that the archive holds only plain files and folders with safe
names and that its manifest names only parts it holds, refuses before writing anything when the
instance is not empty or holds another instance secret key, restores the database, clones the content repository from the bundle (an existing one is set
aside as `content.git.before-restore-<time>`), and copies the blobs and the instance secret key. The
webhook secrets and the S3 secret open again with that key. `docker compose run --rm backup list`
lists the backups at the location in force.

**Restore drill.** Restore the newest backup onto a second machine (or with another
`COMPOSE_PROJECT_NAME`) once a quarter: sign in, open a manual, render a PDF. Then remove that stack.
Leave `CCMS_AUDIT_SINK_URL` unset on it, so the drill never sends to your audit collector, and
skip the outbox's "After a restore" step there and turn its webhook subscribers off
(`UPDATE webhooks SET active = false`), so the drill never sends to your receivers either.

### An S3 server on your own network

The backup service connects only to public addresses unless told otherwise: every connection
resolves the endpoint's host again and is refused when any address it resolves to is private or
loopback, and always when it is link-local or a cloud metadata service (whatever IPv6 spelling it
has). For an S3 server beside the stack (MinIO, SeaweedFS), set `CCMS_BACKUP_S3_ALLOW_PRIVATE=true`
in `backup.env` (the `restore` service reads it too). The address each connection reaches is
checked again when the socket connects, so an endpoint given as an IP address is held to the same
rule. The page refuses a link-local or metadata endpoint when it is saved, and an IP address that
is private or loopback unless the backup service reports the setting.

### Sizing

A backup is about the size of the dump (compressed by `pg_dump`) plus the content repository plus the
blobs; age adds almost nothing. With the default retention (7 daily, 4 weekly, 12 monthly, so at most
23 backups), plan for 25 times a backup at the location. Keep a copy off the host: an S3 location
(with object lock or versioning, if the provider has it), or a copy of the `backups` volume.

### By hand

Without the backup service, the same parts by hand, with the stack running (dump first, so the tar
has every blob the dump refers to):

```sh
umask 077
docker compose exec -T postgres pg_dump -U openfolia -Fc openfolia > /srv/backups/openfolia/openfolia.dump
docker compose exec -T api tar -C /data -cf - . > /srv/backups/openfolia/data.tar
```

`data.tar` holds the instance secret key: keep it encrypted, or apart from the dump.

## Audit log sink and retention

The audit log (Admin, Audit log) can be copied, as it grows, to a place of your own, and old events
removed after a period. Both are operator settings in `deploy/api.env`, read when the API starts;
they run in the worker (or the single `all` process). Details: `backend/api/README.md`, "Audit log".

| Setting                      | What                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `CCMS_AUDIT_SINK_URL`        | `https://host/path` or `syslog+tls://host[:port]` (port 6514 by default). Unset: no sink.                                     |
| `CCMS_AUDIT_SINK_SECRET`     | The HTTPS sink's signing secret, `whsec_` and 64 hex digits; required with `https://`. Or `CCMS_AUDIT_SINK_SECRET_FILE`.      |
| `CCMS_AUDIT_SINK_CA_FILE`    | A PEM file of certificates to trust instead of the system's (a private CA), mounted into the worker (the process that sends). |
| `CCMS_AUDIT_SINK_POLL_MS`    | How often new events go out (default 3000 ms).                                                                                |
| `CCMS_AUDIT_SINK_TIMEOUT_MS` | One delivery's whole time (default 10000 ms).                                                                                 |
| `CCMS_AUDIT_KEEP_DAYS`       | Remove events older than this many days (1 to 36500). Unset: kept for ever.                                                   |

**What the sink guarantees.** Every event at least once, in order: by ID within one transaction, the
transactions in the order they got their ID (their first write). The position is kept in the database, so a restart goes on
where it stopped; a failed delivery is tried again (30 s, doubling to 10 minutes) until it succeeds,
and nothing after it goes first. An event can arrive twice: dedupe by its `id` together with its `at` (after a restore an `id` can come again with another `at`). Setting a sink on an
installation with history sends the whole log first.

- **HTTPS:** batches of up to 100 events, `POST`ed as `{"events": [...]}`, each event as the JSON Lines
  export writes it, signed in the header `X-Ccms-Signature` as webhooks are (check it with the
  secret as in the webhooks' recipe, `backend/api/README.md`, "Webhooks"). Answer with any 2xx;
  anything else, a redirect too, counts as failed. The URL may be on your own network.
- **Syslog over TLS:** RFC 5424 messages framed as RFC 5425 says, one per event, APP-NAME `openfolia`,
  MSGID the event's action, the message the event as JSON. Syslog has no acknowledgement: an event
  counts as delivered once it is written to the connection. Raise the collector's message size limit
  (some cut at 8 KiB) if events carry large details.

**Retention** removes events older than `CCMS_AUDIT_KEEP_DAYS` at start-up and daily (sooner while it catches up), 5,000 at a time
(up to 100,000 a day), and records each removal in the log itself (`audit-log.prune`: the cut-off,
how many, the first and last ID). With a sink set it never removes an event the sink has not sent.
It goes through a database function (`audit_events_prune`); any other delete is refused by the
database. To have the grants hold too, run the API as a database role of its own without `DELETE`
on `audit_events` (`backend/api/README.md`, "Audit log", "Database roles").

**After restoring a backup** onto a new stack with a sink set, the sink sends nothing until its
position is set right once (its log says so), as the outbox's consumers ("Restoring a backup",
"After a restore"): run the SQL in `backend/api/README.md`, "Audit log",
"After a restore", as the database owner, best right after the restore and before the first start,
else with the API stopped. The same goes for a sink set later
on a restored stack. A separate API database role needs its grants again after a restore.

**Upgrading** to the version that brings these: the migration adds a column to `audit_events`
without rewriting it, then builds two indexes on it. Until the migration commits (seconds per
million events) the audit log cannot be read, and writes that record an audit event fail with 503
after a few seconds. On a very large log, upgrade in a quiet moment.

## Upgrades

1. Read the upgrade notes of every release since yours (the changelog: the docs site's
   `/changelog`, `CHANGELOG.md` or the releases on GitHub), and take a backup: `docker compose run --rm backup now`
   (see "Backups").
2. Set `OPENFOLIA_VERSION` in `deploy/.env` to the new version, and replace
   `compose.digests.yaml` with the new release's if you pin by digest. Then run
   `docker compose pull && docker compose up -d --wait`. When building from source, run
   `git pull` and then `docker compose -f compose.yaml -f compose.build.yaml up -d --build --wait`,
   or `deploy/self-host.sh` again (it keeps the settings, the volumes and the content).
3. The API applies pending database migrations when it starts, before it answers requests. For
   that, `CCMS_DATABASE_MIGRATE` must not be `false`. Its log says
   `Migrations applied`. Migrations only go forward: to go back to an older version, restore
   the backup taken in step 1.

**Postgres with pgvector** (see "Semantic search"): switching an existing installation from
`compose.yaml`'s Postgres to `compose.vector.yaml`'s needs no migration, as both are the same
Postgres 18.7 on the same volume. This was tested on a populated volume (arm64): its rows and
indexes were intact and checked (`amcheck`) after the switch, and `CREATE EXTENSION vector`
worked. Take the backup first anyway. When `compose.yaml` moves to a newer Postgres, the
`FROM` line in `docker/postgres/Dockerfile` moves with it.

When several API servers share one database, upgrade them together. Alternatively, set
`CCMS_DATABASE_MIGRATE=false` on them and run the migrations once with
`docker compose run --rm api node dist/database/migrate.main.js`.

## Reverse proxy with TLS

Put a reverse proxy in front of the editor. It terminates TLS and forwards everything to the
editor's port. The editor serves the app and proxies `/api` to the API on the stack's own
network. Leave `OPENFOLIA_BIND` at `127.0.0.1` when the proxy runs on the same machine.

- **Set `CCMS_EDITOR_HOSTS`** to the editor's public host name (`docs.example.com`). Then any
  other `Host` gets 421. It is required when the editor adds a token (see "Signing in").
- **Keep the `Host` header.** The editor's `/api` proxy compares each request's `Origin` with
  its `Host` and refuses a request from another origin. Caddy and Traefik keep `Host` by
  default; nginx needs `proxy_set_header Host $host;`.
- **Uploads** stream to the API, which enforces its own limits (`CCMS_MAX_UPLOAD_BYTES` and
  the others). The proxy in front must allow bodies that large: 1 GB covers every default.
- **Timeouts:** a PDF can take up to `CCMS_PDF_TIMEOUT_MS` (default 60 s), so allow at least
  that.
- **API clients** (service accounts, scripts) can use `https://<editor host>/api/...`. When
  `CCMS_EDITOR_API_TOKEN` is unset, the editor passes their `Authorization` header on. To expose
  the API on a host of its own instead, proxy that host to the API's published port, and mind
  `CCMS_TRUST_PROXY` (below): that path has one hop fewer than the one through the editor.
- Set `CCMS_SOURCE_URL` if you run a modified version (AGPL section 13).
- **Stable addresses.** The editor also serves `/d/` (a manual's stable address, its PDF and QR
  codes; `backend/api/README.md`, "Stable addresses") from the API, never with the editor's
  token: readers who scan a printed QR code get only what `delivery.access` in `openfolia.yaml`
  allows without signing in. Set `CCMS_PUBLIC_URL` to the editor's public URL
  (`https://docs.example.com/`), the base of every address and QR code; without it the editor
  shows paths only and makes no QR codes.
  - **Who may open them, at most:** `CCMS_DELIVERY_MAX_ACCESS` (in `deploy/api.env`) caps what
    `delivery.access` may ask for on this deployment: `public` (the default, no cap),
    `signed-in` or `off`. Set it to `signed-in` where no project may be readable without signing
    in, so a single reviewed change on `main` cannot publish one. A project asking for more is
    served at the cap, and its manuals' checks say so (`delivery-access-capped`). PDFs
    print a QR code by the cap at the time their release was planned.
  - **Tracking parameters:** a shared link often picks up query parameters. `/d/` ignores those
    `CCMS_DELIVERY_IGNORED_QUERY` names (default `utm_*`; add the click-ID parameters your
    channels append, comma-separated, a trailing `*` for a prefix). Any other parameter is
    still refused (400).
  - **Caches in front (a proxy, a CDN):** the pages, PDFs, QR codes and symbols of `/d/` are
    `no-cache` with an ETag: every cache asks again on each request and gets a cheap 304, so a
    new release, a withdrawal or a change of `delivery.access` reaches readers at once. A page's
    images are content-addressed and cached longer: a reader's own browser keeps one a day, and
    a shared cache keeps a public one for `CCMS_DELIVERY_SHARED_MAX_AGE` seconds (default 300,
    `s-maxage` with `proxy-revalidate`), then must revalidate (304 by the image's hash while the
    reader may still see it, 410 once its release is withdrawn). The trade-off: a withdrawn
    release's images can stay in a shared cache for up to that long, and a browser that already
    showed one keeps it for the day; lower values move a withdrawal out sooner at the price of
    more revalidations (`0`: every request asks again). A signed-in reader's answers are
    `private`, never kept by a shared cache. Set `CCMS_BUILD_ID` (in `deploy/api.env`) to the same value on
    every server of one build, so their page ETags agree and a cache's revalidation stays a 304
    whichever server answers it.
  - **Rate limit and the reader's address:** one client may ask for `CCMS_DELIVERY_PER_MINUTE`
    pages, PDFs and QR codes under `/d/` a minute (in `deploy/api.env`; default 60, `0` for no
    limit), then gets 429 with `Retry-After`. Readers with a token count apart, by who they
    are; readers without one by their address, which failed sign-ins count against too. The
    API believes no proxy about that address unless `CCMS_TRUST_PROXY` says so; `compose.yaml`
    sets it to `1` (override it in `deploy/.env`): the editor's nginx, one hop, which passes on
    the address it saw (`X-Forwarded-For`).
    - `1` (the compose default) is right when readers reach the editor's port directly.
    - `2` with a reverse proxy in front of the editor, as below: the API then believes your
      proxy too. Your proxy must append the address it saw to `X-Forwarded-For` (Caddy does;
      nginx needs `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`), and the
      editor's port must be reachable only through it (`OPENFOLIA_BIND=127.0.0.1`), or a reader
      could name any address. Left at `1` behind your proxy, every reader counts as your proxy:
      one budget for all.
    - A hop count must match every path to the API. A host of the API's own, proxied by your
      proxy to the API's port, is one hop fewer than the editor's path: with `2`, a client on it
      could name any address. So with `2`, don't give the API a host of its own: its clients use
      `https://<editor host>/api/...`. Or keep `1`, and readers through the editor count as your
      proxy.
    - A hop count believes whoever connects to the API. So the API's own port listens on
      `OPENFOLIA_API_BIND` (default `127.0.0.1`, whatever `OPENFOLIA_BIND` says): keep it there,
      and let clients reach the API through the editor's `/api/`. If you publish it wider, set
      `CCMS_TRUST_PROXY=none`, and raise or turn off the limit, since every reader through the
      editor then shares one budget.
    - Wherever the API sees one address for many clients (`1` behind your proxy, `none`, a
      CDN's edge), they also share one window of failed sign-ins (`CCMS_AUTH_FAILURES_MAX`):
      one client sending bad tokens holds back the others' shared-token sign-ins for that window.
    - Your proxy must send plain addresses in `X-Forwarded-For`, never with a port.

    Raise the limit where many readers share one address (a site behind one NAT).

Caddy (certificates from Let's Encrypt automatically):

```caddyfile
docs.example.com {
	reverse_proxy 127.0.0.1:8080 {
		transport http {
			read_timeout 5m
		}
	}
	request_body {
		max_size 1GB
	}
	header Strict-Transport-Security "max-age=31536000"
}
```

nginx:

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name docs.example.com;
    ssl_certificate     /etc/letsencrypt/live/docs.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/docs.example.com/privkey.pem;
    add_header Strict-Transport-Security "max-age=31536000" always;
    client_max_body_size 1g;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_http_version 1.1;
        proxy_request_buffering off;
        proxy_read_timeout 300s;
    }
}
```

## The static portal

The portal (`frontend/portal/README.md`) is plain files, built for one audience: serve its
output folder with any static file server or host, on a host name of its own or under a path
(`CCMS_PORTAL_BASE_PATH`). It needs no API at run time. A non-public portal needs a sign-in
in front of it (your proxy's or your host's), which the portal does not provide.

Each page carries its Content Security Policy as a meta tag. A host must send these headers
too, since a meta tag cannot carry them:

- `Content-Security-Policy`: the pages' policy plus `frame-ancestors 'none'` (browsers ignore
  `frame-ancestors` in a meta tag), exactly:

  ```text
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
  ```

- `X-Content-Type-Options: nosniff`: a file is only what its type says, so an attachment the
  build wrote as `.bin` (served as `application/octet-stream`) is never taken for a page.
- `Referrer-Policy: strict-origin-when-cross-origin`, and over HTTPS
  `Strict-Transport-Security: max-age=31536000`.
- On the attachments written as `.bin` (`<lang>/assets/*.bin`): `Content-Type:
application/octet-stream` and `Content-Disposition: attachment`. Not every server knows the
  extension (Caddy, for one, sends no type for it), so set both yourself.

Each language has its own 404 page, `<lang>/404.html`; the examples answer a missing path with
the one of its language (`en` and `de` here: list yours), any other with the first language's.
The `.bin` matchers look at the end of the path, so they hold under a base path too.

nginx (an `add_header` in a `location` replaces the server's, so the `.bin` location repeats
them; `always` gives error pages the headers too):

```nginx
server {
    listen 443 ssl;
    http2 on;
    server_name manuals.example.com;
    ssl_certificate     /etc/letsencrypt/live/manuals.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/manuals.example.com/privkey.pem;
    root /srv/portal;

    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Strict-Transport-Security "max-age=31536000" always;

    location / {
        try_files $uri $uri/ =404;
    }
    location ~ /assets/[^/]+\.bin$ {
        types { }
        default_type application/octet-stream;
        add_header Content-Disposition "attachment" always;
        add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" always;
        add_header X-Content-Type-Options "nosniff" always;
        add_header Referrer-Policy "strict-origin-when-cross-origin" always;
        add_header Strict-Transport-Security "max-age=31536000" always;
    }
    error_page 404 /en/404.html;
    location /en/ { error_page 404 /en/404.html; try_files $uri $uri/ =404; }
    location /de/ { error_page 404 /de/404.html; try_files $uri $uri/ =404; }
}
```

Caddy (the headers as a snippet, imported for the files and for the error pages alike; the
`.bin` headers for the files only):

```caddyfile
(portal-headers) {
	header {
		Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		Strict-Transport-Security "max-age=31536000"
	}
}

manuals.example.com {
	root * /srv/portal
	import portal-headers
	@bin path_regexp /assets/[^/]+\.bin$
	header @bin {
		Content-Type "application/octet-stream"
		Content-Disposition "attachment"
	}
	file_server
	handle_errors {
		import portal-headers
		@en404 expression `{err.status_code} == 404 && {path}.startsWith("/en/")`
		@de404 expression `{err.status_code} == 404 && {path}.startsWith("/de/")`
		rewrite @en404 /en/404.html
		rewrite @de404 /de/404.html
		file_server
	}
}
```

On a host that takes a headers file or settings instead of a server configuration, set the same
headers there: the four for every path, and the two for `.bin` files.

## The docs site

The public documentation (`frontend/docs`) is a static export, served by an image of its own:
`ghcr.io/<owner>/openfolia-docs`, Caddy with the built site (`deploy/docker/docs/`). The site is
built on a maintainer's machine before the image, so the server that runs it only pulls an image
and never builds the repository. The image is built for `linux/arm64` and `linux/amd64`.

### Publishing it

```sh
# The development docs (before a release, or between releases):
DOCS_SITE_URL=https://docs.example.com \
DOCS_API_BASE_URL=https://api.example.com \
pnpm docs:publish --push

# A release's docs, from the release's tag (CONTRIBUTING.md, "Releases"):
DOCS_SITE_URL=https://docs.example.com \
DOCS_API_BASE_URL=https://api.example.com \
DOCS_RELEASE_DIGESTS="$(cat images.lock)" \
pnpm docs:publish --release vX.Y.Z --push
```

`pnpm docs:publish [--release vX.Y.Z] [--push] [--tag <tag>] [--platform <os/arch,...>]`
(`scripts/docs-publish.mjs`):

- **Checks first, builds nothing until they pass.** `DOCS_SITE_URL` and `DOCS_API_BASE_URL` must
  be set (`.env.example`, "Docs site"); with `--release`, `DOCS_RELEASE_DIGESTS` too, and
  `DOCS_RELEASE_SIGNATURES` when the release is signed. The command sets `DOCS_RELEASE` from
  `--release` itself; a release's settings without `--release` are refused, so development docs
  never carry half a release. `--push` refuses a working tree with changes, so the published
  image is a commit, and with `--release` a commit the release's tag is on. Settings in
  git-ignored dotenv files are not read: only the environment the checks see.
- **Builds the site** (`pnpm nx run docs:build`) with those settings, then **the image** with
  `docker buildx build`.
- **Tags:** `latest` (or `--tag <tag>` instead, for a preview), the release's `vX.Y.Z` with
  `--release`, and always `sha-<commit>`. Labels: the source repository, the licence
  (AGPL-3.0-only), the commit and the version.
- **Without `--push`** the image is loaded into the local Docker for this machine's platform
  (`--platform` for another), to try it first. **With `--push`** it is built for `linux/arm64` and
  `linux/amd64` (`--platform linux/arm64` for one only), pushed with an SBOM and provenance, and
  the command prints the image's digest.
- **The image's name:** `ghcr.io/<owner>/openfolia-docs`, the owner of a GitHub
  `DOCS_REPOSITORY_URL` (by default `openfolia`), or `DOCS_PUBLISH_IMAGE`.

Signing in to the registry is yours, once per machine: for GitHub's registry, a personal access
token (classic) with the `write:packages` scope (`read:packages` comes with it),
`echo "$TOKEN" | docker login ghcr.io -u <your GitHub user> --password-stdin`. A multi-platform
push needs Docker's containerd image store (Docker Desktop's default) or a `docker-container`
builder (`docker buildx create --use`). GitHub makes a new package private: make
`openfolia-docs` public once after its first push (the package's settings), or give the platform
credentials to pull it.

The command needs no CI: a workflow can run the same line after `docker login`.

### Running it

```sh
docker run -d --name docs -p 127.0.0.1:8080:8080 --read-only --tmpfs /tmp \
  --cap-drop ALL --security-opt no-new-privileges ghcr.io/<owner>/openfolia-docs:latest
```

- **Port** 8080, plain HTTP: put it behind a proxy that terminates TLS.
- **Health check:** `GET /healthz` answers `200 ok` (the image's `HEALTHCHECK`, with `wget`).
- **User:** `docs`, set by its uid (`10001:10001`), no capabilities needed, a read-only file system with a tmpfs at
  `/tmp`. Caddy's admin endpoint is off and it keeps no state.
- **Addresses:** a page's address without its slash redirects to it (`/guide/x` to `/guide/x/`,
  the form the site links to); `/x` also serves `x.html`. An unknown path gets the site's 404 page
  with status 404.
- **Caching:** the hashed build files (`/_next/static/`) for a year (`immutable`); everything else
  (the pages, `llms.txt`, the search index, the Markdown pages, the OpenAPI documents) with
  `no-cache`, revalidated by its ETag, so a new image shows at once.
- **Compression:** zstd and gzip, as the browser asks.
- **Headers:** a Content-Security-Policy (`default-src 'self'`, scripts and styles of the site,
  inline ones included because the export puts each page's data in inline scripts; `connect-src`
  the site and the origin of the `DOCS_API_BASE_URL` it was built with, for the API reference's
  playground; `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`. HSTS is your
  proxy's to send, as it serves HTTPS.

### On a PaaS (Coolify, for example)

1. Create a resource from a **Docker image**: `ghcr.io/<owner>/openfolia-docs:latest`.
2. **Port** 8080 (the exposed port); no published host port is needed behind the platform's
   proxy.
3. **Health check:** path `/healthz`, port 8080 (or the image's own `HEALTHCHECK`).
4. **Domain:** the docs' address, for example `https://docs.example.com`. The platform's proxy
   gets the certificate and terminates HTTPS. Add `www.docs.example.com` (or the bare domain) as
   a redirect to it, if you serve one, and turn on the redirect from HTTP to HTTPS.
5. **Redeploy on a new image:** after `pnpm docs:publish --push`, redeploy the resource, which
   pulls `latest` again: from the platform's UI, its deploy webhook, or its API. In Coolify, an
   API token (Keys & Tokens, with the deploy permission) and the application's UUID redeploy it
   from the command line:

   ```sh
   curl -fsS -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" \
     -H "Content-Type: application/json" \
     https://<your Coolify>/api/v1/deploy -d '{"uuid":"<application UUID>"}'
   ```

   It is a POST with a JSON body: a GET of the same address is refused. The resource's deploy
   webhook (its "Webhooks" settings) is another way to start it, with the same bearer token. Keep the token out of shell history and files you commit. Pin `vX.Y.Z` or
   `sha-<commit>` instead of `latest` to choose a version by hand.

On a small server the image needs little: about 20 MB of memory beside the files it serves.
Build the site with the address it is served at (`DOCS_SITE_URL`): the links in `llms.txt` and
the install guide for coding agents name it.

## Coolify (a worked example)

[Coolify](https://coolify.io) runs this `compose.yaml` as one Docker Compose resource.

1. Create a resource of the type **Docker Compose**, from this repository (or a fork of it),
   with `deploy/compose.yaml` as the Compose file.
2. Under **Environment variables**, set `POSTGRES_PASSWORD`,
   `OPENFOLIA_IMAGES=ghcr.io/<owner>/openfolia` and `OPENFOLIA_VERSION=latest`
   (the newest release, which a release's deploy webhook then picks up; or a pinned `vX.Y.Z`,
   changed by hand for each upgrade), plus any other variable from "Settings". Coolify lists the `${...}` variables of the
   Compose file for you.
3. Give the `editor` service its domain (`https://docs.example.com:8080`: Coolify's proxy
   terminates TLS and forwards to port 8080). Coolify's proxy keeps the `Host` header. The
   published ports are not needed behind Coolify, but they do no harm on 127.0.0.1.
4. Coolify keeps the named volumes (`postgres`, `data`) across deployments. Add a scheduled
   backup for the Postgres database, and back up the `data` volume as in "Backups".
5. Deploy. For a release, CI calls the resource's deploy webhook after it pushes the images
   (the secrets `DEPLOY_WEBHOOK_URL` and `DEPLOY_WEBHOOK_TOKEN` in `.github/workflows/images.yml`).

Before the first start, put the content repository on the `data` volume. Use Coolify's
terminal for the `api` service, or the commands in "Content repository" on the server.

## The MCP server

```sh
# in deploy/.env: a service account token whose roles hold content.read only, and a random HTTP token
CCMS_MCP_API_TOKEN=ccms_sat_...
CCMS_MCP_HTTP_TOKEN=<openssl rand -hex 32>
docker compose --profile mcp up -d --wait
```

The endpoint is `http://127.0.0.1:3200/mcp`. Put TLS in front of it as you do for the editor.
`backend/mcp/README.md` describes its settings.

## Building the images

There is one `Dockerfile` at the repository root, with one target per image. The build context
is the repository's sources (`.dockerignore` keeps out dependencies, builds, local data and
secrets).

```sh
docker build --target api    -t openfolia/api:local .
docker build --target editor -t openfolia/editor:local .
docker build --target mcp    -t openfolia/mcp:local .
docker build --target backup -t openfolia/backup:local .   # the API image plus the Postgres client
docker build --target embedder -t openfolia/embedder:local .   # the local embedding worker (no model inside)
```

- **Stages:** the dependencies are fetched from the lockfile alone, so a source change doesn't
  download them again. The projects are built with Nx. `pnpm deploy` then copies each Node
  image's production dependencies, without the dev dependencies, the sources or the tests. The
  Node images are Debian (`node:24-trixie-slim`), because the Typst compiler and `sharp` ship
  glibc binaries. npm, npx, corepack and yarn are removed from them.
- **One set of images:** every image is built from the one codebase, all of it under
  AGPL-3.0-only.
- **CI** (`.github/workflows/images.yml`):
  - On a pull request, CI builds the affected images and runs the smoke test and the self-host
    test below. Nothing is pushed.
  - On a merge to `main`, CI also pushes the affected images to
    `ghcr.io/<owner>/openfolia/<image>`. They are tagged with the commit SHA and `main`, each
    with an SBOM and provenance attestations. "Affected" is measured from the last successful
    run on `main`, and the images a merge did not change get its SHA tag too, so any commit
    SHA of `main` names a whole set for `OPENFOLIA_VERSION`.
  - On a release tag `vX.Y.Z`, CI builds every image and tags it with the SHA, `vX.Y.Z` and
    `latest`. Then it records the images' digests and attaches the release's files (below), and
    calls the deploy webhook, but only for a tag on a commit of `main`.

  GitHub creates a new container package as private: make each of `openfolia/api`,
  `openfolia/editor`, `openfolia/mcp`, `openfolia/backup` and `openfolia/embedder` public once (the package's
  settings, after its first push), so anyone can pull them without signing in.

  "Affected" (`scripts/images-plan.mjs`) follows Nx: a change in `packages/content-model`
  rebuilds the API, the MCP server and the editor. The backup image is the API image plus the
  Postgres client, so whatever rebuilds the API rebuilds it too. A change to the `Dockerfile`,
  `deploy/`, the lockfile or the workflow rebuilds every image.

### Images pinned by digest

A tag in a registry can be moved: whoever can push there can make `vX.Y.Z` name other images, and
an installation that pulls later would run them. So a release also pins its images by their
digests (#739). Once every image of the tag is pushed, `scripts/release-digests.mjs` reads each
image's digest from the registry (`docker buildx imagetools inspect`, nothing else), checks it
against the digest the build job itself pushed (a tag moved since the push fails the release),
and writes:

- `images.lock`: every image of the release, `ghcr.io/<owner>/openfolia/<image>:vX.Y.Z@sha256:…`;
- `compose.digests.yaml`: a Compose override giving every service of `compose.yaml` that runs an
  OpenFolia image that image by tag and digest.

CI attaches both to the GitHub Release with `compose.yaml` and a `SHA256SUMS` over the three, and
shows `images.lock` in the run's summary. The job that runs this repository's code has no token
that can change the release; a second job, which runs only `gh`, attaches the files. With
`COMPOSE_FILE=compose.yaml:compose.digests.yaml`, `docker compose config --images` names each
image with its digest, `docker compose pull` fetches exactly those, and a moved tag changes
nothing. The install guide for coding agents (the docs' `/agents`) downloads the override,
verifies its SHA-256, which the release's docs name, and checks after starting that each running
container's image has the digest the release pins for its service (`docker image inspect`, its
`RepoDigests`), and that the settings name it by that digest (`docker compose config --images`),
so the next pull can't follow a moved tag either.

The override covers `compose.yaml`'s services only. An image added by another file
(`compose.embedder.yaml`, `compose.vector.yaml`) is pulled by its tag; `images.lock` still names
the embedder's digest, to compare by hand. An installation that uses the override upgrades by
replacing it with the new release's along with `OPENFOLIA_VERSION`: with the old one it keeps
running the old images.

An override instead of a digest setting per image in `compose.yaml`: Compose can't leave out an
empty `@${DIGEST}`, so that would take a setting per image holding its own `@`, four more lines
in `.env` for a person to keep right on every upgrade. The override is one file per release,
verified like `compose.yaml`, and an installation that doesn't use it runs as before.

`deploy/digests-test.sh` shows it end to end on a registry of its own (`registry:2` on
`127.0.0.1:${DIGESTS_TEST_REGISTRY_PORT:-5739}`, removed again with its volume and images): images
pushed under a release tag and their digests recorded; the release's guide naming the override's
SHA-256; `compose.yaml` with the override naming every OpenFolia image by its digest; an
installation set up as the guide sets it up passing the guide's own image check, and one by tag
alone failing it (its settings would follow the tag); then the tag moved to other images: the
pinned installation, its images removed and pulled again, still runs the release's and passes,
and the installation by tag alone runs the moved images and fails the same check. CI runs it on every pull request that changes an image.

### Images signed

A digest says which images a release pins; a signature says that the release's own workflow
pushed them (#745). Signing is **off by default**: it runs only with the repository variable
`SIGN_IMAGES` set to `true` (Settings, Secrets and variables, Actions, Variables). Unset, the
images workflow and a release's files are exactly as above.

With it on, the job `release-sign` (once `release-files` has written `images.lock`) signs each
image of the release by its digest with cosign, keyless: GitHub gives the job an OIDC token
(`id-token: write`, that job only), Sigstore's certificate authority issues a short-lived
certificate for the workflow's identity, and the signature is recorded in Sigstore's public
transparency log. The job runs no code of this repository: cosign, downloaded and checked
against its pinned SHA-256, `gh`, `jq`, the runner's `docker` and actions pinned by their SHA (download, login, upload). It doesn't
take what to sign from `images.lock` alone, since a job that ran the repository's code wrote it:
each line must name this release's repository (`ghcr.io/<owner, lowercased>/openfolia`), one of
the release's images, its tag, and the digest that image's build leg recorded it pushed and the
registry names for the tag now (`docker buildx imagetools inspect`). A line that doesn't, an image
missing or named twice, signs nothing. `cosign sign --upload=false --bundle` writes each
signature as a Sigstore bundle, `<image>.sigstore.json`: a DSSE envelope over an in-toto
statement whose subject is the image's digest (predicate type
`https://sigstore.dev/cosign/sign/v1`), with the certificate and the log's inclusion proof. The
job also writes `trusted_root.json`, the trust root of Sigstore's public instance (fetched and
verified through its TUF repository by `gh attestation trusted-root`), verifies each bundle
against it offline as the install guide will, and writes `signatures.sha256` over them.
`release-upload` attaches them with the files above; if signing fails, it attaches nothing.
Nothing is written to the registry.

**What the signatures carry, and what a fork sets.** The identity is the workflow file at the
release's tag, `https://github.com/<owner>/<repository>/.github/workflows/images.yml@refs/tags/vX.Y.Z`,
and the issuer GitHub Actions', `https://token.actions.githubusercontent.com`. The docs of a
release derive the identity from `DOCS_REPOSITORY_URL` and `DOCS_RELEASE`, so a fork that runs
this workflow on its own GitHub repository only sets `DOCS_REPOSITORY_URL` (it does for the docs
anyway). A fork that signs elsewhere, or from another workflow, sets
`DOCS_RELEASE_SIGNER_IDENTITY` and `DOCS_RELEASE_SIGNER_ISSUER` (`.env.example`, "Docs site").
The job checks the identity it signs as against that form, and prints it in the run's summary
with `signatures.sha256`.

**Verifying, offline.** The docs of a signed release are built with `DOCS_RELEASE_SIGNATURES`
set to the `signatures.sha256` of the signing job's run summary, compared with the release's file
(CONTRIBUTING.md, "Releases"): the trust root is what the bundles are checked against, so its
SHA-256 comes from the run that signed, not from release assets anyone with write access could
replace. The install
guide (`/agents`, step 5, before anything is pulled; again before an upgrade's pull) checks the
signatures only when `cosign` (3.0 or newer) is installed, and never installs it. It downloads
the trust root and each image's bundle from the release, verifies each file's SHA-256, which the
release's docs name as they name `compose.yaml`'s, then runs for each image

```sh
cosign verify-blob-attestation --bundle api.sigstore.json --trusted-root trusted_root.json \
  --certificate-identity 'https://github.com/<owner>/<repository>/.github/workflows/images.yml@refs/tags/vX.Y.Z' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --type https://sigstore.dev/cosign/sign/v1 --digest <the digest images.lock pins, hex> --digestAlg sha256
```

With `--trusted-root` and a bundle, cosign verifies the certificate chain, the signature, the
log's inclusion proof and the subject's digest locally: it asks neither the transparency log,
the certificate authority nor Sigstore's TUF repository, and not the registry either (the
digest comes from the release's files, and step 7 checks the running containers against it).
Online keyless verification (`cosign verify <image>`) would ask those servers, which are beyond
the registry an installation uses, so the guide never runs it, and its own build check refuses
any other `cosign` command. A signature for another digest or by another identity, a missing
bundle, or a file whose checksum doesn't match stops the guide before the first pull. Without
`cosign`, the guide says that the signatures are not checked, and the digests still pin the
images.

`deploy/signatures-test.sh` runs the guide's check as a release's guide words it, with a
stand-in for cosign and for curl and nothing else on its PATH (no network tool, no Docker): an
unsigned release downloads and checks nothing; without cosign nothing is downloaded; good
signatures verify, from the release's files only, with cosign run only as
`verify-blob-attestation --trusted-root`; a signature for another digest, by another identity, a
missing bundle and a file with another checksum each fail the check. CI runs it beside
`digests-test.sh`. What it can't show is cosign's own offline verification of a real bundle,
which needs a release signed by the workflow.

## Smoke test

`deploy/smoke-test.sh` builds the images and starts the stack from scratch on the sample
content, with random secrets. It checks:

- `GET /health` and `GET /health/ready` (200);
- two workers (`--scale worker=2`): each one's health from inside its container, and no API on
  them;
- a release cut through the API, its files rendered by the two workers: none rendered twice, at
  most 40 scheduled at once, both workers alive and the jobs taken by them, the API none, and one file a PDF;
- a page image from the API's own PDF pool;
- the editor's index and an app route;
- `/api` through the editor, and that a request from another origin is refused there;
- a PDF, rendered both directly and through the editor;
- the editor still reaching the API after the API container is recreated;
- the MCP server: refused without its token, and `tools/list` with it;
- the secret key file on the data volume.

Then it removes the containers and volumes again. It reads no settings file. The ports are
`SMOKE_API_PORT` and `SMOKE_EDITOR_PORT` (default 3103 and 4303). With `SMOKE_BUILD=0` it
skips the build and uses the images as they are; with `SMOKE_KEEP=1` it leaves the stack
running.

### The self-host test

`deploy/self-host-test.sh` runs the one command of "Quick start" as a person would, on a new
settings file of its own (never `deploy/.env`), with a first admin, the sample content and a test
OpenID Connect provider beside the stack (`smoke-oidc.yaml`: a test target of the `Dockerfile`,
never pushed, that signs in a known login without a password). It checks:

- the settings file it made: a random Postgres password, readable by its owner only;
- `GET /health`, and the editor's index;
- the sign-in options: the password form and the provider;
- the first admin signing in through the provider, linked to the user made from
  `CCMS_FIRST_ADMIN_EMAIL` by their email address, with the role `admin`;
- the one-time link printed by `self-host.sh` closed by that sign-in, a new one from
  `first-admin`, their password chosen through it, a sign-in with it, and the link refused the
  second time;
- the sample content through the editor;
- a second run of `self-host.sh` on a recreated API: the settings and the content kept, no
  second admin, no new link, one user in the database.

Then it removes the containers and volumes again. The ports are `SELF_HOST_API_PORT`,
`SELF_HOST_EDITOR_PORT` and `SELF_HOST_OIDC_PORT` (default 3104, 4304 and 9404);
`SELF_HOST_KEEP=1` leaves the stack running. CI runs it on every pull request that changes an
image, and a release is deployed only after it passed.
