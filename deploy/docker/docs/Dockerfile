# syntax=docker/dockerfile:1.17
#
# The public docs site (frontend/docs, deploy/README.md "The docs site"): its static export served
# by Caddy on port 8080, as an unprivileged user. The site is built before the image, never in it,
# so a small server only pulls and runs it:
#
#   pnpm docs:publish                      # builds the site and this image (scripts/docs-publish.mjs)
#   docker buildx build -f deploy/docker/docs/Dockerfile --build-context site=frontend/docs/out .
#
# The build context is the repository (only the licence files and the Caddyfile are read from it);
# the site comes from the build context `site`, by default the repository's frontend/docs/out.
#
# The base image is pinned by version and digest (an index with linux/amd64 and linux/arm64);
# update both together.

ARG CADDY_IMAGE=caddy:2.11.9-alpine@sha256:003a97808e781aa9f7e75cc2f43d34d461099031faf5e20faefb9f61126836f0

# The built site. `--build-context site=<folder>` replaces this stage with that folder.
FROM scratch AS site
COPY frontend/docs/out/ /

FROM ${CADDY_IMAGE}
# The base image lets its caddy bind ports below 1024 by a file capability. Port 8080 needs none,
# and a file capability can stop the binary from starting where a platform drops capabilities. The
# unprivileged user `docs` runs it, named by its uid so a platform can check it is not root.
# Caddy keeps no state here: its config and data folders are in /tmp, so the container also runs on a read-only file system with a tmpfs at /tmp.
RUN setcap -r /usr/bin/caddy \
 && apk del --no-cache libcap \
 && addgroup -S -g 10001 docs \
 && adduser -S -D -H -u 10001 -G docs -s /sbin/nologin docs
COPY LICENSE THIRD-PARTY-NOTICES.md /usr/share/openfolia/
COPY deploy/docker/docs/Caddyfile /etc/caddy/Caddyfile
COPY --from=site / /srv/docs
USER 10001:10001
ENV XDG_CONFIG_HOME=/tmp/caddy/config \
    XDG_DATA_HOME=/tmp/caddy/data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/healthz"]
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
