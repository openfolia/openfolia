#!/bin/sh
# Starts the compose stack from scratch on the sample content, checks it, and removes it again
# (containers and volumes): the API's health, the editor, the editor's /api proxy and its host and
# origin checks, a PDF rendered through each, the editor after the API is recreated, the MCP
# server, a release's files rendered by two separate workers, none twice and within the
# per-release cap, with the workers' health, and the backups: a verified backup to an S3 server
# in a container, restored onto a fresh stack that renders a PDF and still opens its sealed
# secrets (deploy/README.md, "Smoke test").
#
#   deploy/smoke-test.sh            images built from this checkout first (compose.build.yaml)
#   SMOKE_BUILD=0 deploy/smoke-test.sh   the images as they are (OPENFOLIA_IMAGES, OPENFOLIA_VERSION)
#
# Settings: SMOKE_PROJECT (the Compose project, default openfolia-smoke), SMOKE_API_PORT,
# SMOKE_EDITOR_PORT and SMOKE_MCP_PORT (published on 127.0.0.1, default 3103, 4303 and 3203), SMOKE_KEEP=1 to leave the
# stack running. Everything it makes is random and thrown away. It reads no settings file: not
# the deploy/.env or deploy/api.env of a deployment on the same machine (--env-file /dev/null,
# OPENFOLIA_API_ENV_FILE=/dev/null), and it names its images itself: openfolia-smoke/<image>:smoke
# when it builds them, else OPENFOLIA_IMAGES and OPENFOLIA_VERSION from the shell.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
project=${SMOKE_PROJECT:-openfolia-smoke}
api_port=${SMOKE_API_PORT:-3103}
editor_port=${SMOKE_EDITOR_PORT:-4303}
api="http://127.0.0.1:${api_port}"
editor="http://127.0.0.1:${editor_port}"
mcp_port=${SMOKE_MCP_PORT:-3203}
mcp="http://127.0.0.1:${mcp_port}"
pdf_path=/manuals/operating/variants/model=large/en/pdf
work=$(mktemp -d)

# A random token, and a Postgres password of letters and digits: never a real one.
token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
export POSTGRES_PASSWORD
POSTGRES_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
export CCMS_AUTH_MODE=token CCMS_API_TOKEN="$token" CCMS_EDITOR_API_TOKEN="$token" CCMS_EDITOR_HOSTS=127.0.0.1
export OPENFOLIA_API_ENV_FILE=/dev/null OPENFOLIA_WORKER_ENV_FILE=/dev/null OPENFOLIA_BACKUP_ENV_FILE=/dev/null
export OPENFOLIA_API_ROLE=api
# A CPU limit on each worker, as a shared host would set (deploy/README.md, "The API first").
export OPENFOLIA_WORKER_CPUS=1
# The S3 server's credentials (smoke-s3.yaml), random too.
export SMOKE_S3_ACCESS_KEY_ID=smoke-backups
SMOKE_S3_SECRET_ACCESS_KEY=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
export SMOKE_S3_SECRET_ACCESS_KEY
unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES
if [ "${SMOKE_BUILD:-1}" = 1 ]; then
  export OPENFOLIA_IMAGES=openfolia-smoke OPENFOLIA_VERSION=smoke
fi
export OPENFOLIA_BIND=127.0.0.1 OPENFOLIA_API_BIND=127.0.0.1 OPENFOLIA_API_PORT="$api_port" OPENFOLIA_EDITOR_PORT="$editor_port"
unset CCMS_TRUST_PROXY

files="-f ${here}/compose.yaml -f ${here}/smoke-s3.yaml"
if [ "${SMOKE_BUILD:-1}" = 1 ]; then files="$files -f ${here}/compose.build.yaml"; fi
compose() {
  # shellcheck disable=SC2086 # $files is a list of options
  docker compose --project-name "$project" --project-directory "$here" --env-file /dev/null $files "$@"
}

cleanup() {
  status=$?
  if [ "$status" != 0 ]; then
    echo "--- the stack's log" >&2
    compose logs --no-color --tail 40 >&2 || true
  fi
  if [ "${SMOKE_KEEP:-0}" != 1 ]; then
    compose --profile mcp down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT INT TERM

step() { printf '\n== %s\n' "$*"; }
fail() {
  echo "FAILED: $*" >&2
  exit 1
}
# The status of a request; the body goes to $work/body.
status() { curl -sg -o "$work/body" -w '%{http_code}' "$@"; }

if [ "${SMOKE_BUILD:-1}" = 1 ]; then
  step "build"
  compose --profile mcp build --quiet
fi

step "sample content onto the empty data volume"
compose run --rm --no-deps api node docker/sample-content.mjs

step "start (docker compose up --wait), with two workers"
compose up -d --wait --wait-timeout 180 --scale worker=2
compose ps --format 'table {{.Service}}\t{{.Status}}'

step "the API's health"
code=$(status "$api/health")
[ "$code" = 200 ] || fail "GET /health answered $code"
echo "GET /health -> $code $(cat "$work/body")"
code=$(status "$api/health/ready")
[ "$code" = 200 ] || fail "GET /health/ready answered $code"
echo "GET /health/ready -> $code"

step "the editor"
code=$(status "$editor/")
[ "$code" = 200 ] || fail "GET / answered $code"
grep -qi '<of-root' "$work/body" || fail "GET / is not the editor's index.html"
echo "GET / -> $code (the editor's index.html)"
code=$(status "$editor/manuals/some/deep/route")
[ "$code" = 200 ] || fail "an app route answered $code"
echo "GET /manuals/some/deep/route -> $code (the app's own route)"
same='Sec-Fetch-Site: same-origin'
code=$(status -H "$same" "$editor/api/me")
[ "$code" = 200 ] || fail "a same-origin GET /api/me through the editor answered $code"
echo "GET /api/me through the editor, Sec-Fetch-Site: same-origin -> $code (the proxy adds the token)"
code=$(status -H "Origin: $editor" "$editor/api/me")
[ "$code" = 200 ] || fail "a request from the editor's origin answered $code"
echo "GET /api/me from the editor's origin -> $code"
code=$(status "$editor/api/me")
[ "$code" = 403 ] || fail "a request with neither Origin nor Sec-Fetch-Site answered $code"
echo "GET /api/me with neither Origin nor Sec-Fetch-Site -> $code (refused, no token added)"
code=$(status -H 'Origin: https://elsewhere.example' -H "$same" "$editor/api/me")
[ "$code" = 403 ] || fail "a cross-site request through the editor answered $code"
echo "GET /api/me from another origin -> $code (refused)"
code=$(status -H 'Host: rebound.example' -H 'Origin: http://rebound.example' -H "$same" "$editor/api/me")
[ "$code" = 421 ] || fail "a request for another host name answered $code"
grep -q 'does not answer for that host' "$work/body" || fail "the 421 did not come from the editor's default server"
echo "GET /api/me with Host and Origin rebound.example (DNS rebinding) -> $code, answered by the editor, never proxied"
code=$(status -H 'Host: rebound.example' "$editor/healthz")
[ "$code" = 200 ] || fail "the health check on the default server answered $code"

step "a PDF"
code=$(status -H "Authorization: Bearer $token" "$api$pdf_path")
[ "$code" = 200 ] || fail "GET $pdf_path answered $code: $(head -c 400 "$work/body")"
head -c 5 "$work/body" | grep -q '%PDF-' || fail "GET $pdf_path is no PDF"
echo "GET $pdf_path -> $code, $(wc -c <"$work/body" | tr -d ' ') bytes, $(head -c 8 "$work/body")"
code=$(status -H "$same" "$editor/api$pdf_path")
[ "$code" = 200 ] || fail "the PDF through the editor answered $code"
head -c 5 "$work/body" | grep -q '%PDF-' || fail "the PDF through the editor is no PDF"
if [ -n "${SMOKE_PDF_OUT:-}" ]; then cp "$work/body" "$SMOKE_PDF_OUT"; fi
echo "GET /api$pdf_path through the editor -> $code, $(wc -c <"$work/body" | tr -d ' ') bytes"

step "the editor finds a recreated API (a new address)"
compose up -d --wait --no-deps --force-recreate api
code=$(status -H "$same" "$editor/api/me")
[ "$code" = 200 ] || fail "after the API was recreated, /api/me through the editor answered $code"
echo "GET /api/me through the editor after recreating the API -> $code"

step "the MCP server"
compose exec -T api node dist/database/seed.main.js --example >/dev/null
CCMS_MCP_API_TOKEN=$(compose exec -T api node dist/database/service-token.main.js smoke-mcp --role reader | tail -n 1)
CCMS_MCP_HTTP_TOKEN=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
export CCMS_MCP_API_TOKEN CCMS_MCP_HTTP_TOKEN OPENFOLIA_MCP_PORT="$mcp_port"
compose --profile mcp up -d --wait --no-deps mcp
code=$(status -X POST "$mcp/mcp")
[ "$code" = 401 ] || fail "POST /mcp without the token answered $code"
echo "POST /mcp without the token -> $code"
code=$(status -X POST -H "Authorization: Bearer $CCMS_MCP_HTTP_TOKEN" -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' "$mcp/mcp")
[ "$code" = 200 ] && grep -q '"tools"' "$work/body" || fail "tools/list answered $code: $(head -c 300 "$work/body")"
echo "POST /mcp tools/list -> $code, $(grep -o '"name":"[a-z_-]*"' "$work/body" | wc -l | tr -d ' ') tools"

step "the workers' health (inside their containers: no port is published)"
for index in 1 2; do
  health=$(compose exec -T --index "$index" worker node -e \
    'fetch(`http://127.0.0.1:${process.env.PORT}/health`).then(async (r) => { console.log(r.status, await r.text()); process.exit(r.ok ? 0 : 1); }, () => process.exit(1))') ||
    fail "worker $index: GET /health failed: $health"
  echo "worker $index: GET /health -> $health"
  echo "$health" | grep -q '"role":"worker"' || fail "worker $index did not answer as a worker"
  code=$(compose exec -T --index "$index" worker node -e \
    'fetch(`http://127.0.0.1:${process.env.PORT}/modules`).then((r) => console.log(r.status), () => console.log(0))')
  [ "$code" = 404 ] || fail "worker $index answered GET /modules with $code: a worker serves no API"
  echo "worker $index: GET /modules -> $code (no API on a worker)"
done
for index in 1 2; do
  compose logs --index "$index" worker 2>&1 | grep -q 'CPU priority (nice) 10' ||
    fail "worker $index does not run at nice 10: $(compose logs --index "$index" worker 2>&1 | grep -i 'priority' | head -n 2)"
done
echo "both workers: CPU priority (nice) 10"
code=$(status "$api/health/ready")
[ "$code" = 200 ] || fail "the API's /health/ready answered $code"

step "a release's files, rendered by the two workers"
sql() { compose exec -T postgres psql -U openfolia -d openfolia -tAc "$1"; }
publisher=$(compose exec -T api node dist/database/service-token.main.js smoke-publisher --role publisher | tail -n 1)
revision="smoke-$(date +%s)"
code=$(status -X POST -H "Authorization: Bearer $publisher" -H 'Content-Type: application/vnd.api+json' \
  --data "{\"data\":{\"type\":\"Release\",\"attributes\":{\"product\":\"north\",\"revision\":\"$revision\"}}}" "$api/releases")
[ "$code" = 201 ] || fail "POST /releases answered $code: $(head -c 400 "$work/body")"
release=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).data.id)' "$work/body")
echo "POST /releases -> $code, release $release"
case "$release" in *[!0-9a-f-]*) fail "not a release ID: $release" ;; esac
state=planning
max_scheduled=0
for _ in $(seq 1 150); do
  code=$(status -H "Authorization: Bearer $publisher" "$api/releases/$release")
  [ "$code" = 200 ] || fail "GET /releases/$release answered $code"
  state=$(node -e 'console.log(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).data.meta.outputs?.state ?? "none")' "$work/body")
  scheduled=$(sql "select count(*) from release_outputs where release_id = '$release' and scheduled_at is not null and state in ('queued', 'rendering')")
  [ "$scheduled" -gt "$max_scheduled" ] && max_scheduled=$scheduled
  [ "$state" = done ] || [ "$state" = failed ] && break
  sleep 2
done
[ "$state" = done ] || fail "the release's files ended $state: $(head -c 600 "$work/body")"
outputs=$(sql "select count(*) from release_outputs where release_id = '$release'")
twice=$(sql "select count(*) from release_outputs where release_id = '$release' and attempts > 1")
alive=$(sql "select count(*) from job_consumers where role = 'worker' and seen_at > now() - interval '1 minute'")
# Nine files fit in one worker's claims, so which of the two took them is chance: at least one.
# A worker records that it consumed with its next beat (every 15 s): waited for, at most 30 s.
for _ in $(seq 1 15); do
  consumers=$(sql "select count(*) from job_consumers where role = 'worker' and seen_at > now() - interval '1 minute' and consumed_at is not null")
  [ "$consumers" -ge 1 ] && break
  sleep 2
done
others=$(sql "select count(*) from job_consumers where role <> 'worker'")
echo "$outputs files done; $twice attempted more than once (a retry or a second render); at most $max_scheduled scheduled at once (cap 40); $alive workers alive, $consumers of them took jobs, $others other consumers"
[ "$outputs" -gt 0 ] || fail "the release has no files"
[ "$twice" = 0 ] || fail "$twice files were attempted more than once"
[ "$max_scheduled" -le 40 ] || fail "$max_scheduled files were scheduled at once, past the cap of 40"
[ "$alive" = 2 ] || fail "$alive workers alive, not 2"
[ "$consumers" -ge 1 ] || fail "no worker took a job"
[ "$others" = 0 ] || fail "the API consumed jobs (CCMS_ROLE=api consumes none)"
file=$(sql "select id from release_outputs where release_id = '$release' and state = 'done' limit 1")
code=$(status -H "Authorization: Bearer $publisher" "$api/releases/$release/outputs/$file/file")
[ "$code" = 200 ] || fail "a release file answered $code"
head -c 5 "$work/body" | grep -q '%PDF-' || fail "the release file is no PDF"
echo "GET /releases/$release/outputs/$file/file -> $code, $(wc -c <"$work/body" | tr -d ' ') bytes"

step "a preview (the API's own small PDF pool)"
code=$(status -H "Authorization: Bearer $token" "$api$pdf_path/pages/1.png?width=200")
[ "$code" = 200 ] || fail "the page image answered $code: $(head -c 300 "$work/body")"
head -c 8 "$work/body" | od -An -tx1 | tr -d ' \n' | grep -q '^89504e47' || fail "the page image is no PNG"
echo "GET $pdf_path/pages/1.png?width=200 -> $code, $(wc -c <"$work/body" | tr -d ' ') bytes"

step "backups: the backup key, an S3 location, a test, a verified backup"
# Someone holding admin.backups (and webhook.manage, for a webhook with a secret header to restore).
compose exec -T postgres psql -q -U openfolia -d openfolia -c \
  "insert into roles (id, name, permissions) values ('smoke-backups', 'Smoke backups', array['content.read', 'admin.backups', 'webhook.manage'])"
admin_token=$(compose exec -T api node dist/database/service-token.main.js smoke-backups --role smoke-backups | tail -n 1)
auth="Authorization: Bearer $admin_token"
jsonapi='Content-Type: application/vnd.api+json'
# A value of the body: node reads $work/body as JSON, the argument is the expression (d = the body).
field() { node -e "const d = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')); const v = ($1); console.log(typeof v === 'string' ? v : JSON.stringify(v))" "$work/body"; }

code=$(status -X POST -H "$auth" -H "$jsonapi" --data '{"data":{"type":"Webhook","attributes":{"url":"https://hooks.example.com/openfolia-smoke","events":["manual.released"],"headers":[{"name":"X-Api-Key","value":"smoke-header-secret","secret":true}]}}}' "$api/webhooks")
[ "$code" = 201 ] || fail "POST /webhooks answered $code: $(head -c 400 "$work/body")"
webhook_id=$(field 'd.data.id')
echo "POST /webhooks -> $code, $webhook_id, with a secret header (sealed under the instance secret key)"

code=$(status -X POST -H "$auth" -H "$jsonapi" --data '{}' "$api/backup-keys")
[ "$code" = 201 ] || fail "POST /backup-keys answered $code: $(head -c 400 "$work/body")"
field 'd.meta.identity' >"$work/backup-key.txt"
fingerprint=$(field 'd.data.attributes.fingerprint')
echo "POST /backup-keys -> $code, key $fingerprint (the identity answered once, kept in $work only)"

code=$(status -X PATCH -H "$auth" -H "$jsonapi" --data '{"data":{"type":"BackupSettings","id":"instance","attributes":{"location":{"kind":"local","subfolder":"../../etc"}}}}' "$api/backup-settings")
[ "$code" = 422 ] && [ "$(field 'd.errors[0].code')" = backup-path-outside-volume ] || fail "a path outside the volume answered $code"
echo "PATCH /backup-settings, subfolder ../../etc -> $code backup-path-outside-volume"

settings=$(printf '{"data":{"type":"BackupSettings","id":"instance","attributes":{"enabled":true,"frequency":{"kind":"daily"},"time":"02:00","timeZone":"Europe/Berlin","retention":{"daily":7,"weekly":4,"monthly":12},"location":{"kind":"s3","endpoint":"http://s3:8333","region":"us-east-1","bucket":"openfolia-backups","prefix":"smoke/","accessKeyId":"%s","secretAccessKey":"%s"}}}}' "$SMOKE_S3_ACCESS_KEY_ID" "$SMOKE_S3_SECRET_ACCESS_KEY")
code=$(status -X PATCH -H "$auth" -H "$jsonapi" --data "$settings" "$api/backup-settings")
[ "$code" = 200 ] || fail "PATCH /backup-settings answered $code: $(head -c 400 "$work/body")"
grep -q "$SMOKE_S3_SECRET_ACCESS_KEY" "$work/body" && fail "the S3 secret came back"
echo "PATCH /backup-settings (daily 02:00 Europe/Berlin, S3) -> $code, next runs $(field 'd.data.meta.nextRuns.join(", ")')"

# A request, polled until the backup service has finished it: its final state.
request() {
  waited=0
  while :; do
    code=$(status -X POST -H "$auth" -H "$jsonapi" --data "{\"data\":{\"type\":\"BackupRequest\",\"attributes\":{\"kind\":\"$1\"}}}" "$api/backup-requests")
    [ "$code" = 202 ] && break
    [ "$code" = 409 ] && [ "$(field 'd.errors[0].code')" = backup-service-not-running ] && [ "$waited" -lt 60 ] ||
      fail "POST /backup-requests ($1) answered $code: $(head -c 400 "$work/body")"
    sleep 2
    waited=$((waited + 2))
  done
  id=$(field 'd.data.id')
  waited=0
  while :; do
    status -H "$auth" "$api/backup-requests/$id" >/dev/null
    state=$(field 'd.data.attributes.status')
    case "$state" in done | failed) break ;; esac
    [ "$waited" -lt "$2" ] || fail "the $1 request is still $state after $2 s"
    sleep 2
    waited=$((waited + 2))
  done
  echo "$state"
}
state=$(request test-location 60)
[ "$state" = done ] || fail "Test location failed: $(field 'd.data.attributes.errorDetail')"
echo "Test location -> $state (wrote, read back and deleted a test object in the bucket)"
state=$(request run 300)
[ "$state" = done ] || fail "Back up now failed: $(field 'd.data.attributes.error'): $(field 'd.data.attributes.errorDetail')"
status -H "$auth" "$api/backup-runs?page[size]=1" >/dev/null
[ "$(field 'd.data[0].attributes.status')" = succeeded ] && [ "$(field 'd.data[0].attributes.verified')" = true ] ||
  fail "the run is not succeeded and verified: $(head -c 600 "$work/body")"
backup_name=$(field 'd.data[0].attributes.name')
echo "Back up now -> $state: $backup_name, $(field 'd.data[0].attributes.sizeBytes') bytes, verified ($(field 'd.data[0].attributes.verifyMode')), key $(field 'd.data[0].attributes.keyFingerprint'), at $(field 'd.data[0].attributes.location')"
status -H "$auth" "$api/backup-status" >/dev/null
[ "$(field 'd.data.meta.warning')" = null ] || fail "the status warns: $(head -c 400 "$work/body")"
echo "GET /backup-status -> no warning, last good backup $(field 'd.data.meta.lastGoodRun.attributes.finishedAt')"
compose exec -T postgres psql -At -U openfolia -d openfolia -c "select count(*) from pg_database where datname like 'openfolia_verify_%'" | grep -qx 0 ||
  fail "a throwaway verify database was left behind"
echo "no throwaway verify database left"
compose logs --no-color backup 2>&1 | grep -q "$SMOKE_S3_SECRET_ACCESS_KEY" && fail "the backup service logged the S3 secret"
echo "the S3 secret is in no log"

step "backups: restore onto a fresh stack, from the S3 location"
compose rm -sfv api worker editor backup mcp postgres >/dev/null
docker volume rm "${project}_postgres" "${project}_data" "${project}_backups" >/dev/null
compose up -d --wait postgres s3
printf '%s\n' "CCMS_BACKUP_LOCATION=s3" "CCMS_BACKUP_S3_ENDPOINT=http://s3:8333" "CCMS_BACKUP_S3_BUCKET=openfolia-backups" \
  "CCMS_BACKUP_S3_PREFIX=smoke/" "CCMS_BACKUP_S3_ACCESS_KEY_ID=$SMOKE_S3_ACCESS_KEY_ID" \
  "CCMS_BACKUP_S3_SECRET_ACCESS_KEY=$SMOKE_S3_SECRET_ACCESS_KEY" >"$work/backup.env"
OPENFOLIA_BACKUP_ENV_FILE="$work/backup.env" compose run --rm -T restore "$backup_name" --s3 --key-file - <"$work/backup-key.txt"
echo "a second restore, into the instance that now holds the backup, is refused:"
if OPENFOLIA_BACKUP_ENV_FILE="$work/backup.env" compose run --rm -T restore "$backup_name" --s3 --key-file - <"$work/backup-key.txt" 2>"$work/refused"; then
  fail "a restore into a non-empty instance went ahead"
fi
grep -i 'not empty' "$work/refused" || fail "the refusal does not say why: $(cat "$work/refused")"
rm -f "$work/backup.env"
compose up -d --wait --wait-timeout 180
code=$(status -H "Authorization: Bearer $token" "$api$pdf_path")
[ "$code" = 200 ] && head -c 5 "$work/body" | grep -q '%PDF-' || fail "the restored instance's PDF answered $code"
echo "GET $pdf_path on the restored instance -> $code, $(wc -c <"$work/body" | tr -d ' ') bytes"
code=$(status -H "$auth" "$api/webhooks/$webhook_id")
[ "$code" = 200 ] && [ "$(field 'd.data.attributes.headers[0].secret')" = true ] || fail "the restored webhook answered $code"
echo "GET /webhooks/$webhook_id -> $code, its secret header kept (the API opened every sealed secret at start)"
state=$(request test-location 60)
[ "$state" = done ] || fail "Test location after the restore failed: $(field 'd.data.attributes.errorDetail')"
echo "Test location on the restored instance -> $state (the sealed S3 secret opens with the restored instance key)"

step "the instance secret key on the data volume"
compose exec -T api sh -c 'ls -l /data/ccms-secret.key && id'

printf '\nsmoke test passed\n'
