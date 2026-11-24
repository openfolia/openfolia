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
# - a second run of self-host.sh keeps everything, and the recreated API makes no second admin
#   and prints no new link.
#
#   deploy/self-host-test.sh            images built from this checkout
#   SELF_HOST_KEEP=1 deploy/self-host-test.sh   leaves the stack running
#
# Settings: SELF_HOST_PROJECT (the Compose project, default openfolia-self-host),
# SELF_HOST_API_PORT, SELF_HOST_EDITOR_PORT and SELF_HOST_OIDC_PORT (on 127.0.0.1, default 3104,
# 4304 and 9404). Everything it makes is random and thrown away; it reads no settings file of a
# deployment on the same machine (its own, in a temporary folder).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
# COMPOSE_FILE's names are read from the current folder, as self-host.sh reads them.
cd "$here"
project=${SELF_HOST_PROJECT:-openfolia-self-host}
api_port=${SELF_HOST_API_PORT:-3104}
editor_port=${SELF_HOST_EDITOR_PORT:-4304}
oidc_port=${SELF_HOST_OIDC_PORT:-9404}
api="http://127.0.0.1:${api_port}"
editor="http://127.0.0.1:${editor_port}"
oidc="http://127.0.0.1:${oidc_port}"
admin=admin@example.com
work=$(mktemp -d)

unset COMPOSE_PROFILES COMPOSE_ENV_FILES CCMS_API_TOKEN CCMS_EDITOR_API_TOKEN CCMS_AUTH_MODE \
  CCMS_FIRST_ADMIN_EMAIL CCMS_FIRST_ADMIN_NAME CCMS_FIRST_ADMIN_LINK_LOG CCMS_PUBLIC_URL CCMS_TRUST_PROXY POSTGRES_PASSWORD
export COMPOSE_PROJECT_NAME="$project"
export COMPOSE_FILE=compose.yaml:compose.build.yaml:smoke-oidc.yaml
export OPENFOLIA_ENV_FILE="$work/env"
# Images of its own names, never the smoke test's or a deployment's.
export OPENFOLIA_IMAGES=openfolia-self-host OPENFOLIA_VERSION=test
export OPENFOLIA_BIND=127.0.0.1 OPENFOLIA_API_BIND=127.0.0.1
export OPENFOLIA_API_PORT="$api_port" OPENFOLIA_EDITOR_PORT="$editor_port"
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
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
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
"$here/self-host.sh" --admin "$admin" --name "First Admin" --sample --yes --build </dev/null >"$work/first-run" 2>&1 ||
  { cat "$work/first-run"; fail "self-host.sh failed: $(grep -v '^ ' "$work/first-run" | tail -n 1)"; }
cat "$work/first-run"
grep -q '^POSTGRES_PASSWORD=[0-9a-f]\{48\}$' "$work/env" || fail "no random Postgres password in the settings file"
[ "$(stat -c %a "$work/env" 2>/dev/null || stat -f %Lp "$work/env")" = 600 ] || fail "the settings file can be read by others"
link=$(grep -oE "$editor/set-password#ccms_pwl_[0-9a-f]{64}" "$work/first-run" | tail -n 1)
[ -n "$link" ] || fail "self-host.sh printed no link for the first admin"
token=${link#*#}
echo "self-host.sh printed the first admin's link ($editor/set-password#…)"

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

step "once only: run self-host.sh again on a recreated API"
compose rm -sf api oidc >/dev/null
"$here/self-host.sh" --yes --as-is </dev/null >"$work/second-run" 2>&1 ||
  { cat "$work/second-run"; fail "the second run of self-host.sh failed: $(grep -v '^ ' "$work/second-run" | tail -n 1)"; }
cat "$work/second-run"
grep -q 'Kept .* as it is' "$work/second-run" || fail "the second run did not keep the settings file"
grep -q 'has a content repository: kept' "$work/second-run" || fail "the second run did not keep the content"
grep -q 'no first admin was made' "$work/second-run" || fail "the second run does not say the first admin is closed"
compose logs --no-color api >"$work/api-log" 2>&1
grep -q 'CCMS_FIRST_ADMIN_EMAIL is ignored' "$work/api-log" || fail "the recreated API did not say it ignored CCMS_FIRST_ADMIN_EMAIL"
if grep -q 'set-password#' "$work/api-log"; then fail "the recreated API printed a new link"; fi
echo "the recreated API made no second admin and printed no link"
users=$(compose exec -T postgres psql -U openfolia -d openfolia -tAc 'select count(*) from users')
[ "$users" = 1 ] || fail "$users users, not 1"
echo "one user in the database"

printf '\nself-host test passed\n'
