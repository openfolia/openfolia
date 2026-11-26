#!/bin/sh
# The one-command self-host (#373) from scratch, as a person would run it, then removed again
# (containers and volumes): deploy/self-host.sh on a new settings file with a first admin and the
# sample content, a test OpenID Connect provider beside it (smoke-oidc.yaml), and then:
#
# - GET /health, and the editor;
# - the sign-in options: the password form and the provider;
# - the first admin signs in through the provider, found by their email address, as the admin;
# - that sign-in closes the one-time link the API logged; first-admin prints a new one;
# - they choose a password through it, and sign in with it; the link works once;
# - the reader portal (--portal): healthy on its own port with the page that says nothing is
#   released, its token in the settings file only (in no file of the portal), then a release
#   published and its manual shown without a restart;
# - a second run of self-host.sh keeps everything, and the recreated API makes no second admin
#   and prints no new link.
#
#   deploy/self-host-test.sh            images built from this checkout
#   SELF_HOST_KEEP=1 deploy/self-host-test.sh   leaves the stack running
#
# Settings: SELF_HOST_PROJECT (the Compose project, default openfolia-self-host),
# SELF_HOST_API_PORT, SELF_HOST_EDITOR_PORT, SELF_HOST_OIDC_PORT and SELF_HOST_PORTAL_PORT (on
# 127.0.0.1, default 3104, 4304, 9404 and 8194). Everything it makes is random and thrown away; it reads no settings file of a
# deployment on the same machine (its own, in a temporary folder).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
# COMPOSE_FILE's names are read from the current folder, as self-host.sh reads them.
cd "$here"
project=${SELF_HOST_PROJECT:-openfolia-self-host}
api_port=${SELF_HOST_API_PORT:-3104}
editor_port=${SELF_HOST_EDITOR_PORT:-4304}
oidc_port=${SELF_HOST_OIDC_PORT:-9404}
portal_port=${SELF_HOST_PORTAL_PORT:-8194}
portal="http://127.0.0.1:${portal_port}"
api="http://127.0.0.1:${api_port}"
editor="http://127.0.0.1:${editor_port}"
oidc="http://127.0.0.1:${oidc_port}"
admin=admin@example.com
work=$(mktemp -d)

unset COMPOSE_PROFILES COMPOSE_ENV_FILES CCMS_API_TOKEN CCMS_EDITOR_API_TOKEN CCMS_AUTH_MODE \
  CCMS_FIRST_ADMIN_EMAIL CCMS_FIRST_ADMIN_NAME CCMS_FIRST_ADMIN_LINK_LOG CCMS_PUBLIC_URL CCMS_TRUST_PROXY POSTGRES_PASSWORD \
  CCMS_PORTAL_TOKEN CCMS_PORTAL_TOKEN_FILE CCMS_PORTAL_AUDIENCE CCMS_PORTAL_LANGUAGES CCMS_PORTAL_RELEASES \
  CCMS_PORTAL_RELEASES_PER_PRODUCT CCMS_PORTAL_OLDER_NOINDEX CCMS_PORTAL_BASE_PATH CCMS_PORTAL_BRANDING \
  CCMS_PORTAL_START CCMS_PORTAL_URL
export COMPOSE_PROJECT_NAME="$project"
export COMPOSE_FILE=compose.yaml:compose.build.yaml:smoke-oidc.yaml
export OPENFOLIA_ENV_FILE="$work/env"
# Images of its own names, never the smoke test's or a deployment's.
export OPENFOLIA_IMAGES=openfolia-self-host OPENFOLIA_VERSION=test
export OPENFOLIA_BIND=127.0.0.1 OPENFOLIA_API_BIND=127.0.0.1
export OPENFOLIA_API_PORT="$api_port" OPENFOLIA_EDITOR_PORT="$editor_port" OPENFOLIA_PORTAL_PORT="$portal_port"
# The portal reads the releases every 5 s here (default 300).
export CCMS_PORTAL_REFRESH_SECONDS=5
export OPENFOLIA_API_ENV_FILE="$work/api.env" OPENFOLIA_WORKER_ENV_FILE=/dev/null OPENFOLIA_BACKUP_ENV_FILE=/dev/null
export SMOKE_OIDC_PORT="$oidc_port" SMOKE_ADMIN_EMAIL="$admin"
# The provider, for the API (and the workers, which read the same file).
printf '%s\n' "CCMS_OIDC_ISSUER=$oidc" "CCMS_OIDC_CLIENT_ID=openfolia-smoke" \
  "CCMS_OIDC_REDIRECT_URL=$editor/api/auth/oidc/callback" >"$work/api.env"

compose() {
  docker compose --project-directory "$here" --env-file "$work/env" "$@"
}

cleanup() {
  status=$?
  if [ "$status" != 0 ]; then
    echo "--- the stack's log" >&2
    compose logs --no-color --tail 60 >&2 || true
  fi
  if [ "${SELF_HOST_KEEP:-0}" != 1 ]; then
    compose --profile portal down --volumes --remove-orphans >/dev/null 2>&1 || true
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
# A request with the cookie jar: prints "<status> <redirect URL>"; the body goes to $work/body.
jar="$work/cookies"
request() { curl -sg -b "$jar" -c "$jar" -o "$work/body" -w '%{http_code} %{redirect_url}' "$@"; }
# A value of the body: node reads $work/body as JSON, the argument is the expression (d = the body).
field() { node -e "const d = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')); const v = ($1); console.log(typeof v === 'string' ? v : JSON.stringify(v))" "$work/body"; }
same='Sec-Fetch-Site: same-origin'
jsonapi='Content-Type: application/vnd.api+json'

step "the one command: deploy/self-host.sh, on a new settings file"
"$here/self-host.sh" --admin "$admin" --name "First Admin" --sample --portal --yes --build </dev/null >"$work/first-run" 2>&1 ||
  { cat "$work/first-run"; fail "self-host.sh failed: $(grep -v '^ ' "$work/first-run" | tail -n 1)"; }
cat "$work/first-run"
grep -q '^POSTGRES_PASSWORD=[0-9a-f]\{48\}$' "$work/env" || fail "no random Postgres password in the settings file"
[ "$(stat -c %a "$work/env" 2>/dev/null || stat -f %Lp "$work/env")" = 600 ] || fail "the settings file can be read by others"
link=$(grep -oE "$editor/set-password#ccms_pwl_[0-9a-f]{64}" "$work/first-run" | tail -n 1)
[ -n "$link" ] || fail "self-host.sh printed no link for the first admin"
token=${link#*#}
echo "self-host.sh printed the first admin's link ($editor/set-password#…)"

grep -qxF "The portal: $portal/ (public, no sign-in; it shows the manuals once a release is published)" "$work/first-run" ||
  fail "self-host.sh printed no address for the portal"
echo "self-host.sh printed the portal's address ($portal/)"

step "the API's health, and the editor"
out=$(request "$api/health")
[ "${out%% *}" = 200 ] || fail "GET /health answered $out"
echo "GET /health -> 200 $(cat "$work/body")"
out=$(request "$editor/")
[ "${out%% *}" = 200 ] && grep -qi '<of-root' "$work/body" || fail "GET / on the editor answered $out"
echo "GET / on the editor -> 200 (the editor's index.html)"

step "the sign-in options"
out=$(request -H "$same" "$editor/api/auth/options")
[ "${out%% *}" = 200 ] || fail "GET /api/auth/options answered $out"
[ "$(field 'd.data.attributes.password')" = true ] && [ "$(field 'd.data.attributes.providers')" = 1 ] ||
  fail "the sign-in options are $(cat "$work/body")"
out=$(request -H "$same" "$editor/api/auth/providers")
provider=$(field 'd.data[0].id')
echo "password sign-in and one provider ($provider)"

step "the first admin signs in through the provider"
url="$editor/api/auth/$provider/sign-in?returnTo=%2F"
hops=0
while :; do
  hops=$((hops + 1))
  [ "$hops" -le 15 ] || fail "too many redirects, at $url"
  out=$(request "$url")
  code=${out%% *}
  case "$code" in
    30?) url=${out#* } ;;
    200)
      case "$url" in
        "$oidc"/interaction/*)
          out=$(request -X POST --data-urlencode 'login=admin' "$url")
          case "${out%% *}" in 30?) url=${out#* } ;; *) fail "the provider's sign-in answered $out: $(head -c 300 "$work/body")" ;; esac
          ;;
        *) break ;;
      esac
      ;;
    *) fail "$url answered $out: $(head -c 300 "$work/body")" ;;
  esac
done
case "$url" in "$editor"/ | "$editor"/\?*) ;; *) fail "the sign-in ended at $url, not the editor" ;; esac
echo "through the provider and back to the editor in $hops steps"
out=$(request -H "$same" "$editor/api/me")
[ "${out%% *}" = 200 ] || fail "GET /api/me after the provider's sign-in answered $out"
[ "$(field 'd.data.id')" = admin ] && [ "$(field 'd.data.attributes.roles.map((r) => r.id).join()')" = admin ] ||
  fail "signed in as $(cat "$work/body")"
[ "$(field 'd.data.meta.session.provider')" = "$provider" ] || fail "not a session of the provider: $(cat "$work/body")"
echo "GET /api/me -> the user admin, role admin, a session of the provider"
# A browser of its own for the password: no session of the provider's.
rm -f "$jar"

step "the logged link closed by that sign-in; a new one from first-admin"
password="self-host $(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')"
body=$(printf '{"data":{"type":"PasswordSet","attributes":{"token":"%s","password":"%s"}}}' "$token" "$password")
out=$(request -X POST -H "$same" -H "Origin: $editor" -H "$jsonapi" --data "$body" "$editor/api/auth/password/set")
case "${out%% *}" in 404 | 410) ;; *) fail "the logged link still works after the provider's sign-in: $out" ;; esac
echo "the logged link -> ${out%% *} $(field 'd.errors[0].code') (closed by the sign-in)"
fresh=$(compose exec -T api node dist/database/first-admin.main.js "$admin" 2>/dev/null | tail -n 1)
case "$fresh" in "$editor"/set-password\#ccms_pwl_*) ;; *) fail "first-admin printed no link: $fresh" ;; esac
token=${fresh#*#}
echo "first-admin printed a new link on the terminal"

step "the first admin chooses a password through the new link, and signs in with it"
body=$(printf '{"data":{"type":"PasswordSet","attributes":{"token":"%s","password":"%s"}}}' "$token" "$password")
out=$(request -X POST -H "$same" -H "Origin: $editor" -H "$jsonapi" --data "$body" "$editor/api/auth/password/set")
[ "${out%% *}" = 200 ] || fail "POST /api/auth/password/set answered $out: $(head -c 300 "$work/body")"
echo "POST /api/auth/password/set -> 200"
out=$(request -X POST -H "$same" -H "Origin: $editor" -H "$jsonapi" --data "$body" "$editor/api/auth/password/set")
case "${out%% *}" in 404 | 410) ;; *) fail "the link worked twice: $out" ;; esac
echo "the link again -> ${out%% *} $(field 'd.errors[0].code') (it works once)"
rm -f "$jar"
body=$(printf '{"data":{"type":"PasswordSignIn","attributes":{"email":"%s","password":"%s"}}}' "$admin" "$password")
out=$(request -X POST -H "$same" -H "Origin: $editor" -H "$jsonapi" --data "$body" "$editor/api/auth/password/sign-in")
[ "${out%% *}" = 200 ] || fail "POST /api/auth/password/sign-in answered $out: $(head -c 300 "$work/body")"
out=$(request -H "$same" "$editor/api/me")
[ "${out%% *}" = 200 ] && [ "$(field 'd.data.id')" = admin ] || fail "GET /api/me after the password sign-in answered $out"
echo "POST /api/auth/password/sign-in -> 200; GET /api/me -> the user admin"
out=$(request -H "$same" "$editor/api/manuals?page%5Bsize%5D=1")
[ "${out%% *}" = 200 ] || fail "GET /api/manuals answered $out: the sample content is not there"
echo "GET /api/manuals -> 200 (the sample content)"

step "the reader portal: set up by self-host.sh, then a release shown without a restart"
grep -q '^COMPOSE_PROFILES=portal$' "$work/env" && grep -q '^CCMS_PORTAL_AUDIENCE=public$' "$work/env" ||
  fail "the settings file does not name the portal's profile and audience"
portal_token=$(sed -n 's/^CCMS_PORTAL_TOKEN=//p' "$work/env" | tail -n 1)
printf '%s' "$portal_token" | grep -qxE 'ccms_sat_[0-9a-f]{16}_[0-9a-f]{64}' || fail "no portal token in the settings file"
grep -qF "${portal_token##*_}" "$work/first-run" && fail "self-host.sh printed the portal's token"
echo "the settings file holds the portal's profile, audience and token (not printed)"
code=$(curl -sg -D "$work/headers" -o "$work/body" -w '%{http_code}' "$portal/")
[ "$code" = 200 ] && grep -q 'No manuals have been released yet' "$work/body" || fail "the portal's start page answered $code: $(head -c 300 "$work/body")"
grep -qi "^content-security-policy: .*frame-ancestors 'none'" "$work/headers" || fail "the portal sends no CSP with frame-ancestors"
echo "GET / on the portal -> $code, the page that says nothing is released yet, with its CSP"
started_at=$(docker inspect --format '{{.State.StartedAt}}' "$(compose --profile portal ps -q portal)")
echo '{"roles":[{"id":"self-host-publisher","name":"Publisher","permissions":["content.read","release.publish"],"scope":{}}],"users":[]}' |
  compose exec -T api node dist/database/seed.main.js /dev/stdin >/dev/null
publisher=$(compose exec -T api node dist/database/service-token.main.js self-host-publisher --role self-host-publisher 2>/dev/null | tail -n 1)
out=$(curl -sg -o "$work/body" -w '%{http_code}' -X POST -H "Authorization: Bearer $publisher" -H "$jsonapi" \
  --data '{"data":{"type":"Release","attributes":{"product":"north","revision":"self-host-1"}}}' "$api/releases")
[ "$out" = 201 ] || fail "POST /releases answered $out: $(head -c 300 "$work/body")"
manual=/en/north/operating/model=large/
shown=
for _ in $(seq 1 90); do
  if [ "$(curl -sg -o "$work/body" -w '%{http_code}' "$portal$manual")" = 200 ] && grep -q 'Release self-host-1<' "$work/body"; then
    shown=1
    break
  fi
  sleep 2
done
[ -n "$shown" ] || fail "the portal did not show the release within 180 s: $(compose --profile portal logs --no-color --tail 20 portal)"
[ "$(docker inspect --format '{{.State.StartedAt}}' "$(compose --profile portal ps -q portal)")" = "$started_at" ] ||
  fail "the portal container was restarted"
echo "GET $manual -> 200, the release self-host-1, the same container"
# grep answers 1 for no match; a match (0) or an error (2) fails.
found=0
printf '%s\n%s\n' "$portal_token" "${portal_token##*_}" | compose --profile portal exec -T portal grep -rlF -f - /app/portal/out /tmp >"$work/found" 2>&1 || found=$?
[ "$found" = 1 ] || fail "files of the portal hold its token (grep $found): $(cat "$work/found")"
echo "no file of the portal holds its token"

step "once only: run self-host.sh again on a recreated API"
compose rm -sf api oidc >/dev/null
"$here/self-host.sh" --yes --as-is </dev/null >"$work/second-run" 2>&1 ||
  { cat "$work/second-run"; fail "the second run of self-host.sh failed: $(grep -v '^ ' "$work/second-run" | tail -n 1)"; }
cat "$work/second-run"
grep -q 'Kept .* as it is' "$work/second-run" || fail "the second run did not keep the settings file"
grep -q 'has a content repository: kept' "$work/second-run" || fail "the second run did not keep the content"
grep -q 'Its token is in .*: kept' "$work/second-run" || fail "the second run did not keep the portal's token"
[ "$(grep -c '^CCMS_PORTAL_TOKEN=' "$work/env")" = 1 ] || fail "the second run made another portal token"
grep -q 'no first admin was made' "$work/second-run" || fail "the second run does not say the first admin is closed"
compose logs --no-color api >"$work/api-log" 2>&1
grep -q 'CCMS_FIRST_ADMIN_EMAIL is ignored' "$work/api-log" || fail "the recreated API did not say it ignored CCMS_FIRST_ADMIN_EMAIL"
if grep -q 'set-password#' "$work/api-log"; then fail "the recreated API printed a new link"; fi
echo "the recreated API made no second admin and printed no link"
users=$(compose exec -T postgres psql -U openfolia -d openfolia -tAc 'select count(*) from users')
[ "$users" = 1 ] || fail "$users users, not 1"
echo "one user in the database"

printf '\nself-host test passed\n'
