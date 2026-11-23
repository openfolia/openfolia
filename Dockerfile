# syntax=docker/dockerfile:1.17
#
# The container images, one target each (deploy/README.md):
#
#   docker build --target api    -t openfolia/api:local .
#   docker build --target editor -t openfolia/editor:local .
#   docker build --target mcp    -t openfolia/mcp:local .
#   docker build --target backup -t openfolia/backup:local .
#   docker build --target embedder -t openfolia/embedder:local .
#
# Base images are pinned by version and digest; update both together.

ARG NODE_IMAGE=node:24.22.3-trixie-slim@sha256:af02d57b57719b9657a45199a79264a9437940cd55b3c7b3fc99615654f124a0
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.29.8-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6

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
RUN pnpm nx run-many -t build -p api mcp --output-style=static
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
    PATH=/usr/lib/postgresql/18/bin:$PATH
HEALTHCHECK NONE
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
