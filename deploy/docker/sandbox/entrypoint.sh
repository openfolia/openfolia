#!/bin/bash
# The sandbox image's entrypoint (Dockerfile, target `sandbox`; deploy/README.md, "The sandbox
# image"): one visitor's whole OpenFolia in one container, started from the demo's baked state.
#
#   1. The baked state of CCMS_SANDBOX_LANG (en or de; scripts/demo/bake.mjs, read only in the
#      image) is copied to /tmp/sandbox, the container's only writable place (a tmpfs the
#      launcher caps): the database, the content repository, and the blob folder as links to the
#      image's files (a new file is written beside them, the baked ones are never changed).
#   2. The embedded database (backend/sandbox) on 127.0.0.1:5432, the API in a public sandbox
#      (CCMS_PUBLIC_SANDBOX=on, demo mode) on 127.0.0.1:3000, both inside the container only.
#   3. The editor (nginx, the editor image's configuration) on CCMS_EDITOR_PORT (8080), the one
#      port the container serves, proxying /api to the API with a token made for this start.
#
# Any of the three ending ends the container (tini then stops the rest). Nothing outlives it: no
# volume, and /tmp is gone with the container. Starting again starts from the baked state.
set -euo pipefail

started=$(date +%s%3N)
say() { echo "openfolia-sandbox: $*" >&2; }
fail() {
  say "$*"
  exit 64
}

lang=${CCMS_SANDBOX_LANG:-en}
case "$lang" in
  en | de) ;;
  *) fail "CCMS_SANDBOX_LANG must be en or de, not '$lang'." ;;
esac
state=/opt/openfolia/sandbox/$lang
data=/tmp/sandbox
[ -d "$state/pgdata" ] || fail "no baked state at $state."
[ -w /tmp ] || fail "/tmp is not writable: run with a tmpfs there (--read-only --tmpfs /tmp:size=…; deploy/README.md, \"The sandbox image\")."
if [ "$(stat -f -c %T /tmp)" != tmpfs ]; then
  say "warning: /tmp is no tmpfs: what the visitor writes is on the container's disk, without a size cap, until the container is removed."
fi

# The settings that make it a sandbox are the image's, whatever the container was given; the
# API refuses the rest of what could reach outside (backend/api/README.md, "Public sandbox").
for name in CCMS_SECRET_KEY CCMS_SECRET_KEY_FILE CCMS_WEBHOOKS_SECRET_KEY CCMS_WEBHOOKS_SECRET_KEY_FILE CCMS_API_TOKEN CCMS_API_TOKEN_FILE \
  CCMS_DATABASE_URL CCMS_DATABASE_URL_FILE CCMS_EDITOR_API_TOKEN CCMS_EDITOR_API_TOKEN_FILE CCMS_EDITOR_API_URL; do
  [ -z "${!name:-}" ] || fail "$name is the sandbox's own: leave it unset."
done

# 1. The baked state, copied. Zero blocks stay holes (--sparse=always): the database's
# preallocated write-ahead log costs the tmpfs nothing until it is written.
rm -rf "$data"
mkdir -m 0700 "$data"
cp -r --sparse=always "$state/pgdata" "$data/pgdata"
cp -r "$state/content.git" "$data/content.git"
cp -rs "$state/blobs" "$data/blobs"
# The image's files are read only for everyone; the copies are the sandbox's own to write.
chmod -R u=rwX,go= "$data"

# A token for this start only, shared by the API and the editor's proxy; never logged.
token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')

pids=()
# Stopped (docker stop: tini -g hands SIGTERM to every process here): wait for the three to end.
# No second SIGTERM from here: the API takes a second one as "end at once" and would cut its own
# shutdown short. Only a process still running after 8 s (a start without tini) is sent one.
stop() {
  trap - TERM INT
  local pid alive
  for _ in $(seq 80); do
    alive=0
    for pid in "${pids[@]}"; do kill -0 "$pid" 2>/dev/null && alive=1; done
    [ "$alive" = 1 ] || break
    sleep 0.1
  done
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then kill -TERM "$pid" 2>/dev/null || true; fi
  done
  wait "${pids[@]}" 2>/dev/null || true
  exit 143
}
trap stop TERM INT

# 2. The database, then the API once it listens. PGlite is Postgres compiled to WebAssembly: V8's
# optimising compiler (TurboFan) would compile its hot functions again at start, which briefly
# takes over a gigabyte; its baseline compiler alone (Liftoff) keeps the process near 280 MB
# from the start, and is fast enough for one visitor's database.
node --liftoff-only /app/sandbox/dist/db-server.js --data "$data/pgdata" --port 5432 >/dev/null &
pids+=($!)
listening=0
for _ in $(seq 400); do
  if (exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null; then
    listening=1
    break
  fi
  kill -0 "${pids[0]}" 2>/dev/null || fail "the database did not start."
  sleep 0.025
done
[ "$listening" = 1 ] || fail "the database did not listen within 10 s."

(
  cd /app/api
  exec env \
    HOST=127.0.0.1 \
    PORT=3000 \
    CCMS_PUBLIC_SANDBOX=on \
    CCMS_AUTH_MODE=demo \
    CCMS_ROLE=all \
    CCMS_API_TOKEN="$token" \
    CCMS_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres \
    CCMS_DATABASE_MIGRATE=false \
    CCMS_CONTENT_DIR="$data/content.git" \
    CCMS_BLOB_DRIVER=fs \
    CCMS_BLOB_FS_ROOT="$data/blobs" \
    CCMS_DEFAULT_REF=main \
    node dist/main.js
) &
pids+=($!)

# 3. The editor, at once: its health check waits for the API.
CCMS_EDITOR_API_URL=http://127.0.0.1:3000 \
  CCMS_EDITOR_API_TOKEN="$token" \
  CCMS_EDITOR_HOSTS="${CCMS_EDITOR_HOSTS:-localhost,127.0.0.1}" \
  /usr/local/bin/openfolia-editor-entrypoint nginx -e /dev/stderr -g 'daemon off;' &
pids+=($!)
unset token

# Said once, when the API answers through the editor's port: the time a start takes.
(
  for _ in $(seq 1200); do
    if /usr/local/bin/openfolia-sandbox-health 2>/dev/null; then
      say "ready in $(($(date +%s%3N) - started)) ms ($lang)."
      exit 0
    fi
    sleep 0.05
  done
  say "not ready after a minute."
) &

status=0
wait -n "${pids[@]}" || status=$?
say "a process ended (status $status): stopping the sandbox."
trap - TERM INT
kill -TERM "${pids[@]}" 2>/dev/null || true
wait "${pids[@]}" 2>/dev/null || true
exit "$status"
