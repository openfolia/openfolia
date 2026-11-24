#!/bin/sh
# Entrypoint of the portal image (Dockerfile, target `portal`): the folders a build writes besides
# its output, then the shared entrypoint (secrets from files: CCMS_PORTAL_TOKEN_FILE) and the
# command.
#
# The image's file system is read-only in compose.yaml: Astro's own folders (.astro and its caches
# in node_modules) are links into /tmp, a tmpfs, made here on every start. Its build itself stays
# in the output's volume (/app/portal/out, inside the project, so the pages' modules find its
# packages and its files move within one file system).
set -eu
mkdir -p /tmp/portal/astro /tmp/portal/astro-cache /tmp/portal/vite-cache
exec /usr/local/bin/openfolia-entrypoint "$@"
