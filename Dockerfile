# syntax=docker/dockerfile:1.17
#
# The container images, one target each (deploy/README.md):
#
#   docker build --target api    -t openfolia/api:local .
#   docker build --target editor -t openfolia/editor:local .
#   docker build --target mcp    -t openfolia/mcp:local .
#   docker build --target backup -t openfolia/backup:local .
#   docker build --target embedder -t openfolia/embedder:local .
#   docker build --target portal -t openfolia/portal:local .
#   docker build --target sandbox -t openfolia/sandbox:local .
#   docker build --target sandbox-launcher -t openfolia/sandbox-launcher:local .
#   docker build --target demo-portal -t openfolia/demo-portal:local .
#
# Every image builds for linux/amd64 and linux/arm64 (the images workflow builds each natively).
#
# Base images are pinned by version and digest; update both together.

ARG NODE_IMAGE=node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29.8-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6
# The portal's web server (as deploy/docker/docs/Dockerfile's): only its binary is copied.
ARG CADDY_IMAGE=caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0

# ---------------------------------------------------------------------------------------------
# Dependencies and the build: the whole workspace, its dev dependencies included. Nothing of it
# reaches a runtime image but what `pnpm deploy` and the editor's build write.
FROM ${NODE_IMAGE} AS workspace
ENV CI=true \
    NX_DAEMON=false \
    NX_NO_CLOUD=true \
    NX_SKIP_NX_CACHE=true \
    PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0
WORKDIR /src
RUN corepack enable
# The store from the lockfile alone, so a source change does not download the packages again.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm fetch --frozen-lockfile
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --offline

# `pnpm deploy` copies a package with its production dependencies only. It also adds the root
# package's own dependencies (the editor's Angular), so those are taken out of the root
# package.json first. Then each copy keeps only what runs: the build, the API's migrations, the
# dependencies. Two optional peers the lockfile resolves for the tests are dropped too: the
# in-memory Postgres (drizzle-orm's PGlite driver, never loaded by the server) and TypeScript
# (@nestjs/swagger's build plugin).
FROM workspace AS build-api
# The sandbox's embedded database (backend/sandbox) too: build-sandbox, below, takes it from here.
RUN pnpm nx run-many -t build -p api mcp sandbox --output-style=static
RUN node -e "const fs = require('node:fs'); const p = JSON.parse(fs.readFileSync('package.json', 'utf8')); delete p.dependencies; fs.writeFileSync('package.json', JSON.stringify(p, null, 2))" \
 && pnpm --filter=@openfolia/api deploy --prod --legacy /out/api \
 && pnpm --filter=@openfolia/mcp deploy --prod --legacy /out/mcp \
 && cd /out/api \
 && find . -mindepth 1 -maxdepth 1 ! -name package.json ! -name dist ! -name migrations ! -name node_modules -exec rm -rf {} + \
 && rm -rf node_modules/.pnpm/@electric-sql+pglite@* node_modules/.pnpm/typescript@* \
 && cd /out/mcp \
 && find . -mindepth 1 -maxdepth 1 ! -name package.json ! -name dist ! -name node_modules -exec rm -rf {} +

# The embedding worker (backend/embedder): its build and production dependencies, then only what
# runs. ONNX Runtime's install script never ran (pnpm-workspace.yaml, allowBuilds): it downloads
# GPU libraries. Its CPU library is in the package; the other platforms' libraries, the script and
# the packages only the script uses are dropped (an allowlist of what the worker loads). Then the
# runtime is checked for a usage-data client (`--check-runtime`), so a version that has one fails
# the build, and loaded once. `licenses/` holds ONNX Runtime's licence and the notices of what its
# library contains (its npm package carries neither).
FROM workspace AS build-embedder
RUN pnpm nx run embedder:build --output-style=static
RUN node -e "const fs = require('node:fs'); const p = JSON.parse(fs.readFileSync('package.json', 'utf8')); delete p.dependencies; fs.writeFileSync('package.json', JSON.stringify(p, null, 2))" \
 && pnpm --filter=@openfolia/embedder deploy --prod --legacy /out/embedder \
 && cd /out/embedder \
 && find . -mindepth 1 -maxdepth 1 ! -name package.json ! -name dist ! -name node_modules ! -name licenses -exec rm -rf {} + \
 && find node_modules/.pnpm -mindepth 1 -maxdepth 1 ! -name node_modules ! -name 'onnxruntime-node@*' \
      ! -name 'onnxruntime-common@*' ! -name '@huggingface+tokenizers@*' ! -name 'tslib@*' ! -name 'zod@*' \
      -exec rm -rf {} + \
 && ort="$(dirname "$(node -p "require.resolve('onnxruntime-node/package.json')")")" \
 && rm -rf "$ort/script" \
 && find "$ort/bin/napi-v6" -mindepth 1 -maxdepth 1 ! -name linux -exec rm -rf {} + \
 && find "$ort/bin/napi-v6/linux" -mindepth 1 -maxdepth 1 ! -name "$(node -p process.arch)" -exec rm -rf {} + \
 && node dist/main.js --check-runtime \
 && node -e "import('onnxruntime-node').then(() => console.error('ONNX Runtime loads.'))"

FROM workspace AS build-editor
RUN pnpm nx run editor:build:production --output-style=static

# The portal (frontend/portal, #819): it is built from the API at run time, so the image holds its
# build (Astro, Pagefind, sharp) with the packages it renders with. `pnpm deploy` copies it with its
# production dependencies; then it keeps only what a build runs (no tests, fixtures or browser
# tests). Astro writes .astro and its caches into the project: links into /tmp
# (deploy/docker/portal/entrypoint.sh makes the folders), so the image runs on a read-only file
# system. The output goes to out/ (a volume), inside the project: Astro builds there, and the
# pages' modules it runs there find the project's packages.
FROM workspace AS build-portal
RUN pnpm nx run-many -t build -p content-model render-html --output-style=static
RUN node -e "const fs = require('node:fs'); const p = JSON.parse(fs.readFileSync('package.json', 'utf8')); delete p.dependencies; fs.writeFileSync('package.json', JSON.stringify(p, null, 2))" \
 && pnpm --filter=@openfolia/portal deploy --prod --legacy /out/portal \
 && cd /out/portal \
 && find . -mindepth 1 -maxdepth 1 ! -name package.json ! -name node_modules ! -name astro.config.mjs \
      ! -name build ! -name scripts ! -name src ! -name public -exec rm -rf {} + \
 && rm -f scripts/build-fixture.ts \
 && mkdir out \
 && ln -s /tmp/portal/astro .astro \
 && ln -s /tmp/portal/astro-cache node_modules/.astro \
 && ln -s /tmp/portal/vite-cache node_modules/.vite

# The sandbox image's own parts (#827): its embedded database (backend/sandbox) with its
# production dependencies, and the demo's finished state in each language, baked here
# (scripts/demo/bake.mjs: the API of build-api in demo mode on loopback ports, the demo content,
# the demo people, two releases with their PDFs, a change set in review), so a sandbox starts
# from a copy of it in seconds instead of making it. git: the bake writes the content repository.
FROM build-api AS build-sandbox
RUN apt-get update \
 && apt-get install -y --no-install-recommends git \
 && rm -rf /var/lib/apt/lists/*
RUN pnpm --filter=@openfolia/sandbox deploy --prod --legacy /out/sandbox \
 && cd /out/sandbox \
 && find . -mindepth 1 -maxdepth 1 ! -name package.json ! -name dist ! -name node_modules -exec rm -rf {} +
# Read only for everyone: the sandbox runs as `node` and copies it (PGlite writes its files 0600).
RUN node scripts/demo/bake.mjs --lang en --out /out/sandbox-state/en \
 && node scripts/demo/bake.mjs --lang de --out /out/sandbox-state/de \
 && chmod -R a=rX /out/sandbox-state

# The public demo's launcher and its agent (#828, backend/sandbox-launcher): its build, its start
# page (page/) and its production dependencies (the theme's fonts and logos).
FROM workspace AS build-launcher
RUN pnpm nx build sandbox-launcher --output-style=static
RUN node -e "const fs = require('node:fs'); const p = JSON.parse(fs.readFileSync('package.json', 'utf8')); delete p.dependencies; fs.writeFileSync('package.json', JSON.stringify(p, null, 2))" \
 && pnpm --filter=@openfolia/sandbox-launcher deploy --prod --legacy /out/launcher \
 && cd /out/launcher \
 && find . -mindepth 1 -maxdepth 1 ! -name package.json ! -name dist ! -name page ! -name node_modules -exec rm -rf {} +

# The public demo's shared portal (#828): the released manuals of the demo's English state, built
# once by scripts/demo/portal.mjs from a normal instance of the API on loopback ports (never a
# sandbox's: a sandbox's demo sign-in is an admin), read with a token of a read-only role up to the
# owners' audience. A static site: nothing of the instance outlives the build.
FROM build-sandbox AS build-demo-portal
COPY --from=build-portal /out/portal /out/portal-app
# Its caches in the app's own folder (the portal image links them into /tmp, a tmpfs at run time):
# Astro's prerendered chunks then find the app's node_modules.
RUN cd /out/portal-app \
 && rm .astro node_modules/.astro node_modules/.vite \
 && mkdir .astro node_modules/.astro node_modules/.vite \
 && cd /src \
 && node scripts/demo/portal.mjs --state /out/sandbox-state/en --portal /out/portal-app --out /out/demo-portal \
 && test -f /out/demo-portal/index.html

# Caddy's binary, without the file capability its image gives it (as deploy/docker/docs/Dockerfile
# does): port 8080 needs none, and a file capability stops it where capabilities are dropped.
FROM ${CADDY_IMAGE} AS caddy
RUN setcap -r /usr/bin/caddy

# A test OpenID Connect provider (backend/api/scripts/mock-oidc.ts: no passwords, plain http) for
# the self-host test (deploy/self-host-test.sh, deploy/smoke-oidc.yaml). Never pushed, never part
# of a deployment; not the last target, so a plain `docker build .` never makes it.
FROM workspace AS mock-oidc
USER node
CMD ["node", "backend/api/scripts/mock-oidc.ts"]

# ---------------------------------------------------------------------------------------------
# Shared by the Node images: tini (PID 1: forwards signals, reaps the compiler's and git's
# processes), the licence texts, the entrypoint, the unprivileged user `node` (uid 1000) of the
# base image. npm, npx, corepack and yarn are removed: nothing installs packages at run time.
FROM ${NODE_IMAGE} AS node-runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-* \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
ENV NODE_ENV=production
WORKDIR /app
COPY LICENSE THIRD-PARTY-NOTICES.md /app/
COPY --chmod=0755 deploy/docker/node-entrypoint.sh /usr/local/bin/openfolia-entrypoint

# ---------------------------------------------------------------------------------------------
# The API (backend/api): the server, its migrations (applied on start unless
# CCMS_DATABASE_MIGRATE=false), the Typst compiler and the theme's fonts (@openfolia/theme).
FROM node-runtime AS api
# git: the API reads and writes the content repository through it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build-api /out/api /app/api
COPY deploy/docker/sample-content.mjs /app/api/docker/sample-content.mjs
# /data: the content repository, the blob folder and the instance secret key (deploy/README.md,
# "Volumes"); owned by the unprivileged user, so a fresh named volume mounted there is too.
RUN mkdir -p /data \
 && chown node:node /data \
 && chmod 0700 /data
USER node
WORKDIR /app/api
ENV HOST=0.0.0.0 \
    PORT=3000 \
    CCMS_CONTENT_DIR=/data/content.git \
    CCMS_BLOB_DRIVER=fs \
    CCMS_BLOB_FS_ROOT=/data/blobs
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health/ready`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/openfolia-entrypoint"]
CMD ["node", "dist/main.js"]

# The backup service (#529, deploy/README.md, "Backups"): the API image with the Postgres client
# tools (pg_dump, pg_restore, psql) of the server's major version, from the PostgreSQL project's
# Debian repository; Debian's own are older. The repository key is pinned by its checksum
# (fingerprint B97B 0AFC AA1A 47F0 44F2 44A0 7FCC 7D46 ACCC 4CF8) and the package by version, so
# an image builds the same until both are updated together. A target of its own, so the API's
# image stays as small as it was. Runs `CCMS_ROLE=backup`.
FROM api AS backup
ARG PG_CLIENT_VERSION=18.7-1.pgdg13+5
USER root
ADD --checksum=sha256:0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76 \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc /usr/share/keyrings/pgdg.asc
RUN chmod 0644 /usr/share/keyrings/pgdg.asc \
 && printf '%s\n' 'Types: deb' 'URIs: https://apt.postgresql.org/pub/repos/apt' 'Suites: trixie-pgdg' \
      'Components: main' 'Signed-By: /usr/share/keyrings/pgdg.asc' > /etc/apt/sources.list.d/pgdg.sources \
 && apt-get update \
 && apt-get install -y --no-install-recommends "postgresql-client-18=${PG_CLIENT_VERSION}" \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /backups /staging \
 && chown node:node /backups /staging \
 && chmod 0700 /backups /staging
USER node
ENV CCMS_ROLE=backup \
    CCMS_BACKUP_DIR=/backups \
    CCMS_BACKUP_STAGING_DIR=/staging \
    CCMS_BACKUP_HEALTH_FILE=/tmp/openfolia-backup-alive \
    PATH=/usr/lib/postgresql/18/bin:$PATH
# Healthy while the loop's last heartbeat reached the database at most 45 s ago (#813). A check of
# its own, never `HEALTHCHECK NONE`: Compose before 5.0.2 refuses to `up --wait` for a container
# whose image turns the inherited check off ("has no healthcheck configured").
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "dist/backups/backup-health.main.js"]
# The server's entry point, which CCMS_ROLE=backup (config/role.ts, #527) turns into the backup
# service; the arguments are its command: `docker compose run --rm backup now`.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/openfolia-entrypoint", "node", "dist/main.js"]
CMD ["run"]

# ---------------------------------------------------------------------------------------------
# The MCP server (backend/mcp) over its Streamable HTTP transport.
FROM node-runtime AS mcp
COPY --from=build-api /out/mcp /app/mcp
USER node
WORKDIR /app/mcp
ENV CCMS_MCP_HTTP_HOST=0.0.0.0 \
    CCMS_MCP_HTTP_PORT=3200
EXPOSE 3200
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "require('node:net').connect(Number(process.env.CCMS_MCP_HTTP_PORT), '127.0.0.1').on('connect', () => process.exit(0)).on('error', () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/openfolia-entrypoint"]
CMD ["node", "dist/main.js", "--http"]

# ---------------------------------------------------------------------------------------------
# The embedding worker (backend/embedder, #532; deploy/README.md, "Semantic search"): a
# sentence-embedding model on ONNX Runtime, on the CPU, serving POST /v1/embeddings to the API on
# the deployment's internal network. No model is in the image: it is mounted at /models (or
# copied there by an image built on this one), each file checked against its pinned SHA-256 as
# it loads. Nothing in it makes a network call.
FROM node-runtime AS embedder
COPY --from=build-embedder /out/embedder /app/embedder
USER node
WORKDIR /app/embedder
ENV CCMS_EMBEDDER_HOST=0.0.0.0 \
    CCMS_EMBEDDER_PORT=8090 \
    CCMS_EMBEDDER_MODEL_DIR=/models \
    ORT_DISABLE_TELEMETRY=1
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.CCMS_EMBEDDER_PORT}/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------------------------------
# The reader portal (frontend/portal, #819; deploy/README.md, "The static portal"): Caddy serves
# /app/portal/out/site on port 8080, and beside it scripts/serve.ts builds the portal from the API at
# start and again after each release (CCMS_PORTAL_REFRESH_SECONDS), replacing the folder only when
# a build completes. /app/portal/out: a volume, so a restart serves the last build at once. Healthy
# once a build (or the page saying nothing is released yet) is served; the first build may take
# minutes, hence the long start period. tini signals its whole process group (-g): the server and
# a build's processes stop with it.
FROM node-runtime AS portal
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
COPY --from=build-portal /out/portal /app/portal
COPY deploy/docker/portal/Caddyfile /etc/caddy/Caddyfile
COPY --chmod=0755 deploy/docker/portal/entrypoint.sh /usr/local/bin/openfolia-portal-entrypoint
RUN chown node:node /app/portal/out
USER node
WORKDIR /app/portal
ENV CCMS_PORTAL_OUT_DIR=/app/portal/out/site \
    XDG_CONFIG_HOME=/tmp/caddy/config \
    XDG_DATA_HOME=/tmp/caddy/data \
    ASTRO_TELEMETRY_DISABLED=1
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=900s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/openfolia-portal-entrypoint"]
CMD ["node", "scripts/serve.ts", "--", "caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

# ---------------------------------------------------------------------------------------------
# The public sandbox (#827; deploy/README.md, "The sandbox image"): one visitor's OpenFolia in one
# container, the API in a public sandbox (CCMS_PUBLIC_SANDBOX=on, demo mode), its embedded
# database and its content repository inside, and the editor (the editor image's nginx
# configuration, one worker) on port 8080, the only port it serves. A start copies the baked
# state of CCMS_SANDBOX_LANG (en, de) into /tmp, which the launcher makes a size-capped tmpfs on a
# read-only root file system; it needs no network beyond its own loopback. Nothing outlives the
# container: no volume.
FROM node-runtime AS sandbox
# git: the API reads and writes the content repository through it. nginx: Debian's, for the
# editor.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git nginx \
 && rm -rf /var/lib/apt/lists/* /etc/nginx/sites-enabled /etc/nginx/sites-available /etc/nginx/conf.d
COPY --from=build-api /out/api /app/api
COPY --from=build-sandbox /out/sandbox /app/sandbox
COPY --from=build-sandbox /out/sandbox-state /opt/openfolia/sandbox
COPY --from=build-editor /src/frontend/editor/dist/browser /usr/share/openfolia/editor
# The editor image's configuration with one worker process (one visitor needs no more) and no
# access log: a visitor's requests would otherwise fill the host's container log, outside every
# limit of the container. Errors are still logged.
COPY deploy/docker/editor/nginx.conf /etc/nginx/nginx.conf
RUN sed -i -e 's/^worker_processes auto;$/worker_processes 1;/' \
      -e 's|^\( *\)access_log /dev/stdout main;$|\1access_log off;|' /etc/nginx/nginx.conf \
 && grep -qx 'worker_processes 1;' /etc/nginx/nginx.conf \
 && grep -qx ' *access_log off;' /etc/nginx/nginx.conf
COPY --chmod=0755 deploy/docker/editor/entrypoint.sh /usr/local/bin/openfolia-editor-entrypoint
COPY --chmod=0755 deploy/docker/sandbox/entrypoint.sh /usr/local/bin/openfolia-sandbox
COPY --chmod=0755 deploy/docker/sandbox/health.sh /usr/local/bin/openfolia-sandbox-health
RUN install -d -o node -g node /opt/openfolia/node-cache
USER node
WORKDIR /app
ENV CCMS_SANDBOX_LANG=en \
    CCMS_EDITOR_PORT=8080 \
    NODE_COMPILE_CACHE=/opt/openfolia/node-cache
# One start at build time, stopped once it is healthy: it fills Node's compile cache, which every
# start then reads (read only) instead of compiling the API's modules again, and it fails the
# build when the image does not start. Nothing of it is kept but the cache.
RUN /usr/bin/tini -s -g -- /usr/local/bin/openfolia-sandbox & tini=$! \
 && for _ in $(seq 600); do /usr/local/bin/openfolia-sandbox-health && break; sleep 0.1; done \
 && /usr/local/bin/openfolia-sandbox-health \
 && kill -TERM "$tini" && wait "$tini"; \
 status=$?; rm -rf /tmp/sandbox /tmp/openfolia /tmp/*_temp /tmp/nginx.pid; \
 [ "$status" = 0 ] || [ "$status" = 143 ] || exit 1; \
 [ -n "$(ls -A /opt/openfolia/node-cache)" ] \
 && chmod -R a-w /opt/openfolia/node-cache
EXPOSE 8080
# Checked every second while it starts (a start takes a few), then every 10 s.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --start-interval=1s --retries=3 \
  CMD ["/usr/local/bin/openfolia-sandbox-health"]
# tini signals its whole process group (-g): the database, the API and nginx stop with it.
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/openfolia-sandbox"]

# ---------------------------------------------------------------------------------------------
# The public demo's launcher (#828; deploy/README.md, "The public demo"): the start page, the
# proof of work, the limits and the routing to each visitor's sandbox, on CCMS_LAUNCHER_PORT
# (8080). The same image runs the agent, the only process that talks to the container runtime:
# `node dist/agent-main.js` (deploy/compose.demo.yaml). Neither needs a writable file system.
FROM node-runtime AS sandbox-launcher
COPY --from=build-launcher /out/launcher /app/launcher
USER node
WORKDIR /app/launcher
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://' + (process.env.CCMS_LAUNCHER_HOST || '127.0.0.1') + ':' + (process.env.CCMS_LAUNCHER_PORT || '8080') + '/_demo/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# Its secrets: CCMS_LAUNCHER_AGENT_TOKEN_FILE and CCMS_LAUNCHER_ADDRESS_SECRET_FILE, read by itself.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]

# ---------------------------------------------------------------------------------------------
# The public demo's shared portal (#828): the static site build-demo-portal made, behind the
# portal image's Caddy configuration on port 8080, as an unprivileged user. Read only; no API.
FROM ${CADDY_IMAGE} AS demo-portal
RUN setcap -r /usr/bin/caddy \
 && apk del --no-cache libcap \
 && addgroup -S -g 10001 portal \
 && adduser -S -D -H -u 10001 -G portal -s /sbin/nologin portal
COPY LICENSE THIRD-PARTY-NOTICES.md /usr/share/openfolia/
COPY deploy/docker/portal/Caddyfile /etc/caddy/Caddyfile
COPY --from=build-demo-portal /out/demo-portal /app/portal/out/site
USER 10001:10001
ENV XDG_CONFIG_HOME=/tmp/caddy/config \
    XDG_DATA_HOME=/tmp/caddy/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]

# ---------------------------------------------------------------------------------------------
# The editor (frontend/editor): the static build behind nginx, which proxies /api to the API
# (CCMS_EDITOR_API_URL, read at start).
FROM ${NGINX_IMAGE} AS editor
COPY LICENSE THIRD-PARTY-NOTICES.md /usr/share/openfolia/
COPY --from=build-editor /src/frontend/editor/dist/browser /usr/share/openfolia/editor
COPY deploy/docker/editor/nginx.conf /etc/nginx/nginx.conf
COPY --chmod=0755 deploy/docker/editor/entrypoint.sh /usr/local/bin/openfolia-editor-entrypoint
USER nginx
ENV CCMS_EDITOR_PORT=8080 \
    CCMS_EDITOR_API_URL=http://api:3000
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["sh", "-c", "wget -q -O /dev/null \"http://127.0.0.1:${CCMS_EDITOR_PORT}/healthz\""]
ENTRYPOINT ["/usr/local/bin/openfolia-editor-entrypoint"]
CMD ["nginx", "-g", "daemon off;"]
