#!/bin/sh
# Self-hosting with one command (#373; deploy/README.md, "Quick start"):
#
#   deploy/self-host.sh --admin you@example.com
#
# 1. Makes the settings file (deploy/.env) when there is none: a random Postgres password, the
#    editor's address and the first admin. An existing one is kept as it is.
# 2. Builds the images from this checkout, or pulls them when OPENFOLIA_IMAGES is set.
# 3. When the data volume holds no content repository, offers the sample one (never forced).
# 4. Starts the stack and waits until every service is healthy (the API applies the migrations
#    first, and makes the first admin on an instance without users).
# 5. The reader portal (#819, asked for; --portal, --no-portal): a read-only role and service
#    account for one audience, its token written into the settings file, the `portal` profile
#    started (its own port, OPENFOLIA_PORTAL_PORT, default 8090).
# 6. Prints the editor's and the portal's address and the first admin's one-time link to choose
#    a password.
#
# Options:
#   --admin <email>   the first admin (CCMS_FIRST_ADMIN_EMAIL); asked for when unset and there is
#                     a terminal. Written into a new settings file, or added to one without it.
#   --name <name>     their name (CCMS_FIRST_ADMIN_NAME; default: the address's part before "@")
#   --sample          put the sample content in when there is no content repository, unasked
#   --no-sample       never put the sample content in (bring your own: "Content repository")
#   --portal          run the reader portal, unasked (the default answer when asked)
#   --no-portal       no reader portal (one set up before keeps running: COMPOSE_PROFILES)
#   --portal-audience <id>
#                     the audience the portal shows, at most (an audience ID of openfolia.yaml;
#                     default: CCMS_PORTAL_AUDIENCE, else the least restricted one configured)
#   --yes             ask nothing: no sample content unless --sample, no admin unless --admin,
#                     no portal unless --portal
#   --build | --pull | --as-is
#                     the images: built from this checkout (the default without OPENFOLIA_IMAGES),
#                     pulled from OPENFOLIA_IMAGES (the default with it), or used as they are
#
# Run it again at any time: it keeps the settings, the volumes and the content, and the API never
# makes a second admin (CCMS_FIRST_ADMIN_EMAIL works once, on an instance without users).
# OPENFOLIA_ENV_FILE names another settings file than deploy/.env; COMPOSE_FILE and
# COMPOSE_PROJECT_NAME are Compose's own (then the images' option decides only build or pull).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
self="$here/$(basename "$0")"
cd "$here"
env_file=${OPENFOLIA_ENV_FILE:-$here/.env}

admin=
name=
sample=ask
ask=1
images=
portal=ask
portal_audience=
usage() {
  sed -n '2,39p' "$self" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}
while [ $# -gt 0 ]; do
  case "$1" in
    --admin)
      [ $# -ge 2 ] || usage 64
      admin=$2
      shift 2
      ;;
    --name)
      [ $# -ge 2 ] || usage 64
      name=$2
      shift 2
      ;;
    --sample) sample=yes && shift ;;
    --no-sample) sample=no && shift ;;
    --portal) portal=yes && shift ;;
    --no-portal) portal=no && shift ;;
    --portal-audience)
      [ $# -ge 2 ] || usage 64
      portal_audience=$2
      shift 2
      ;;
    --yes) ask=0 && shift ;;
    --build) images=build && shift ;;
    --pull) images=pull && shift ;;
    --as-is) images=as-is && shift ;;
    -h | --help) usage 0 ;;
    *)
      echo "self-host: unknown option $1" >&2
      usage 64
      ;;
  esac
done
[ -t 0 ] || ask=0

say() { printf '\n== %s\n' "$*"; }
fail() {
  echo "self-host: $*" >&2
  exit 1
}

# A setting: from the shell, else the last line naming it in the settings file.
setting() {
  eval "given=\${$1:-}"
  if [ -n "$given" ]; then
    printf '%s' "$given"
  elif [ -f "$env_file" ]; then
    sed -n "s/^$1=//p" "$env_file" | tail -n 1 | sed "s/^['\"]\(.*\)['\"]\$/\1/"
  fi
}

# An email address as the API takes it, loosely: one @, a dot after it, and nothing Compose would
# read in a settings file (spaces, quotes, $, `, #, braces, control characters).
valid_email() {
  case "$1" in
    *[[:space:][:cntrl:]\'\"\\\$\`#{}]* | *@*@* | @* | *@ | *@.* | *.) return 1 ;;
    ?*@?*.?*) return 0 ;;
    *) return 1 ;;
  esac
}

say "Docker"
command -v docker >/dev/null 2>&1 || fail "Docker is not installed (https://docs.docker.com/engine/install/)."
docker info >/dev/null 2>&1 || fail "Docker is not running, or this user may not use it."
version=$(docker compose version --short 2>/dev/null) || fail "Docker Compose (the compose plugin) is missing."
major=$(echo "$version" | sed 's/^v//' | cut -d. -f1)
minor=$(echo "$version" | sed 's/^v//' | cut -d. -f2)
case "$major$minor" in '' | *[!0-9]*) fail "Docker Compose answered no version we can read: $version" ;; esac
if [ "$major" -lt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -lt 24 ]; }; then
  fail "Docker Compose $version is too old: 2.24 or newer is needed."
fi
echo "Docker Compose $version"

say "Settings ($env_file)"
if [ -z "$admin" ] && [ -z "$(setting CCMS_FIRST_ADMIN_EMAIL)" ] && [ "$ask" = 1 ]; then
  printf "The first admin's email address (they choose a password through a link; empty: none now): "
  read -r admin || admin=
fi
if [ -n "$admin" ] && ! valid_email "$admin"; then fail "not an email address: $admin"; fi
case "$name" in *[\"\\\$\`[:cntrl:]]*) fail "the name cannot hold quotes, backslashes, \$ or \`." ;; esac

if [ ! -f "$env_file" ]; then
  editor_port=${OPENFOLIA_EDITOR_PORT:-8080}
  (
    umask 077
    {
      echo "# Made by deploy/self-host.sh; every setting: .env.example, \"Container deployment\"."
      echo "# Keep this file: Postgres reads its password on the first start only."
      echo "POSTGRES_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
      echo "# Where people open the editor (and readers the stable addresses); the first admin's link"
      echo "# starts with it. Change it to your own https:// address behind a reverse proxy."
      echo "CCMS_PUBLIC_URL=http://127.0.0.1:${editor_port}/"
    } >"$env_file"
  )
  echo "Made $env_file (a random Postgres password, CCMS_PUBLIC_URL=http://127.0.0.1:${editor_port}/)."
else
  echo "Kept $env_file as it is."
  # It holds the Postgres password: readable by its owner only.
  if [ -n "$(find "$env_file" -perm -004 -o -perm -040 2>/dev/null)" ]; then
    chmod 600 "$env_file"
    echo "Made it readable by you only (chmod 600): it holds the Postgres password."
  fi
  [ -n "$(setting POSTGRES_PASSWORD)" ] || fail "$env_file has no POSTGRES_PASSWORD (deploy/README.md, \"Quick start\")."
fi
if [ -n "$admin" ]; then
  existing=$(setting CCMS_FIRST_ADMIN_EMAIL)
  if [ -z "$existing" ]; then
    {
      echo "# The first admin, made on the first start of an instance without users, then ignored."
      echo "CCMS_FIRST_ADMIN_EMAIL=$admin"
      [ -z "$name" ] || echo "CCMS_FIRST_ADMIN_NAME=\"$name\""
    } >>"$env_file"
    echo "Added CCMS_FIRST_ADMIN_EMAIL=$admin."
  elif [ "$existing" != "$admin" ]; then
    echo "CCMS_FIRST_ADMIN_EMAIL is already $existing in $env_file; that one is kept."
  fi
fi

# The reader portal: set up before (its token in the settings file), asked, or as the options say.
case "$portal_audience" in '' | [a-z0-9] | [a-z0-9]*[a-z0-9]) ;; *) fail "--portal-audience: an audience ID, e.g. public" ;; esac
case "$portal_audience" in *[!a-z0-9-]*) fail "--portal-audience: an audience ID, e.g. public" ;; esac
if [ "$portal" = ask ]; then
  if [ -n "$(setting CCMS_PORTAL_TOKEN)" ]; then
    portal=yes
  elif [ "$ask" = 1 ]; then
    printf 'Run the reader portal too (the released manuals for readers, on its own port)? [Y/n] '
    read -r answer || answer=
    case "$answer" in [nN]*) portal=no ;; *) portal=yes ;; esac
  else
    portal=no
  fi
fi
# The profile for building and pulling its image, and for starting it.
portal_profile=
[ "$portal" = yes ] && portal_profile="--profile portal"

# The Compose files: COMPOSE_FILE when set, else compose.yaml (and the build file when building).
compose_file=$(setting COMPOSE_FILE)
[ -z "$images" ] && { [ -n "$(setting OPENFOLIA_IMAGES)" ] && images=pull || images=build; }
if [ -n "$compose_file" ]; then
  export COMPOSE_FILE="$compose_file"
  files=
elif [ "$images" = build ]; then
  files="-f compose.yaml -f compose.build.yaml"
else
  files="-f compose.yaml"
fi
compose() {
  # shellcheck disable=SC2086 # $files is a list of options
  docker compose --project-directory "$here" --env-file "$env_file" $files "$@"
}

case "$images" in
  build)
    say "Images: building them from this checkout (a few minutes the first time)"
    # shellcheck disable=SC2086 # $portal_profile is empty or two options
    compose $portal_profile build --quiet
    ;;
  pull)
    [ -n "$(setting OPENFOLIA_IMAGES)" ] || fail "--pull needs OPENFOLIA_IMAGES (the registry path, deploy/README.md, \"Quick start\" step 2)."
    say "Images: pulling $(setting OPENFOLIA_IMAGES):$(setting OPENFOLIA_VERSION)"
    # shellcheck disable=SC2086
    compose $portal_profile pull --quiet
    ;;
  as-is) say "Images: as they are" ;;
esac

say "Content repository"
# test answers 1 for "not there"; anything else is a failure of the run itself, said as it is.
found=0
compose run --rm --no-deps -T api test -e /data/content.git || found=$?
if [ "$found" = 0 ]; then
  echo "The data volume has a content repository: kept."
elif [ "$found" != 1 ]; then
  fail "could not look into the data volume (exit $found): see the message above."
else
  if [ "$sample" = ask ]; then
    sample=no
    if [ "$ask" = 1 ]; then
      printf 'There is no content repository yet. Put the sample content in, to try it out? [y/N] '
      read -r answer || answer=
      case "$answer" in [yY]*) sample=yes ;; esac
    fi
  fi
  if [ "$sample" = yes ]; then
    compose run --rm --no-deps -T api node docker/sample-content.mjs
  else
    echo "None yet: content requests fail until you put one in (deploy/README.md, \"Content repository\")."
  fi
fi

say "Starting (docker compose up -d --wait)"
# This run's log only: an earlier start's link is used, expired or closed by now.
started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
if ! compose up -d --wait --wait-timeout "${OPENFOLIA_WAIT_TIMEOUT:-300}"; then
  # How each container stands, and what the last health check of each unhealthy one said.
  compose ps -a --format 'table {{.Service}}\t{{.State}}\t{{.Status}}' >&2 || true
  for id in $(compose ps -aq); do
    check=$(docker inspect --format '{{.Name}}: {{.State.Status}}, health {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$id") || continue
    case "$check" in *'health healthy'*) continue ;; esac
    last=$(docker inspect --format '{{if .State.Health}}{{range .State.Health.Log}}{{printf "%q" .Output}}{{"\n"}}{{end}}{{end}}' "$id" | tail -n 1) || true
    printf '%s\n' "${check#/}${last:+; its last health check said $last}" >&2
  done
  fail "the stack did not start healthy (Docker Compose $version; the lines above say why). Its log: cd $here && docker compose logs <service>"
fi
compose ps --format 'table {{.Service}}\t{{.Status}}'

# The reader portal: a role that may only read, up to one audience, a service account holding it,
# and that account's token in the settings file (never shown); then the profile, started.
portal_url=
if [ "$portal" = yes ]; then
  say "The reader portal"
  if [ -n "$(setting CCMS_PORTAL_TOKEN)" ]; then
    echo "Its token is in $env_file: kept."
  else
    # The audience levels the content configures (openfolia.yaml), least restricted first.
    levels=$(compose exec -T api node --input-type=module -e '
      import { execFileSync } from "node:child_process";
      import { parseConfig } from "@openfolia/content-model";
      const text = execFileSync("git", ["--git-dir", process.env.CCMS_CONTENT_DIR, "show", "HEAD:openfolia.yaml"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      for (const level of parseConfig(text).audiences ?? []) if (/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(level?.id ?? "")) console.log(level.id);
    ' </dev/null 2>/dev/null) || levels=
    if [ -z "$levels" ]; then
      echo "No content configuration with audience levels yet: the portal is not set up. Run this again"
      echo "once the content repository is there (deploy/README.md, \"Content repository\")."
      portal=no
    else
      audience=${portal_audience:-$(setting CCMS_PORTAL_AUDIENCE)}
      if [ -z "$audience" ]; then
        audience=$(printf '%s\n' "$levels" | head -n 1)
        if [ "$ask" = 1 ]; then
          printf 'The audience the portal shows, at most (%s) [%s]: ' "$(printf '%s' "$levels" | tr '\n' ' ' | sed 's/ $//; s/ /, /g')" "$audience"
          read -r answer || answer=
          [ -z "$answer" ] || audience=$answer
        fi
      fi
      printf '%s\n' "$levels" | grep -qxF -- "$audience" ||
        fail "the content configures no audience \"$audience\" (it has: $(printf '%s' "$levels" | tr '\n' ' '))"
      echo "{\"roles\":[{\"id\":\"portal-reader\",\"name\":\"Portal reader\",\"permissions\":[\"content.read\"],\"scope\":{\"maxAudience\":\"$audience\"}}],\"users\":[]}" |
        compose exec -T api node dist/database/seed.main.js /dev/stdin >/dev/null ||
        fail "could not make the role portal-reader (the message above says why)."
      # A new service account gets the role; an existing one keeps its roles (Admin changes them):
      # only then, a token without --role. Any other failure makes no token (stderr never holds one).
      why=$(mktemp)
      if ! token=$(compose exec -T api node dist/database/service-token.main.js portal --role portal-reader --name portal --days 366 </dev/null 2>"$why"); then
        if grep -qF '"portal" exists: its roles are changed in Admin' "$why"; then
          token=$(compose exec -T api node dist/database/service-token.main.js portal --name portal --days 366 </dev/null 2>/dev/null) || token=
        else
          sed 's/^/  /' "$why" >&2
          token=
        fi
      fi
      rm -f "$why"
      token=$(printf '%s\n' "$token" | tail -n 1)
      if ! printf '%s' "$token" | grep -qxE 'ccms_sat_[0-9a-f]{16}_[0-9a-f]{64}'; then
        token=
        fail "no token for the service account portal: see Admin, Service accounts (one may have been made: revoke it there)."
      fi
      profiles=$(setting COMPOSE_PROFILES)
      case ",$profiles," in *,portal,*) ;; *) profiles=${profiles:+$profiles,}portal ;; esac
      {
        echo "# The reader portal (#819): the audience it shows and its service account's token (portal, role"
        echo "# portal-reader, valid 366 days; a new one: delete this line and run deploy/self-host.sh again)."
        echo "COMPOSE_PROFILES=$profiles"
        echo "CCMS_PORTAL_AUDIENCE=$audience"
        echo "CCMS_PORTAL_TOKEN=$token"
      } >>"$env_file"
      token=
      echo "Made the role portal-reader (content.read up to \"$audience\") and a token for the service account"
      echo "portal, written to $env_file (never shown)."
    fi
  fi
  if [ "$portal" = yes ]; then
    if ! compose --profile portal up -d --wait --wait-timeout "${OPENFOLIA_WAIT_TIMEOUT:-900}" portal; then
      compose --profile portal logs --no-color --tail 20 portal >&2 || true
      fail "the portal did not start healthy (its log above). Its log: cd $here && docker compose logs portal"
    fi
    portal_url="http://127.0.0.1:$(setting OPENFOLIA_PORTAL_PORT | grep . || echo 8090)/"
  fi
fi

editor=$(setting CCMS_PUBLIC_URL)
[ -n "$editor" ] || editor="http://127.0.0.1:${OPENFOLIA_EDITOR_PORT:-8080}/"
say "Ready"
echo "The editor: $editor"
if [ -n "$portal_url" ]; then
  echo "The portal: $portal_url (public, no sign-in; it shows the manuals once a release is published)"
fi
# The API's last word on the first admin: the link it printed, or that it made none (users exist).
last=$(compose logs --no-color --since "$started" api 2>/dev/null | grep -oE 'CCMS_FIRST_ADMIN_EMAIL is ignored|[^ ]*set-password#ccms_pwl_[0-9a-f]{64}' | tail -n 1 || true)
case "$last" in
  *set-password#*)
    echo "The first admin chooses their password here (once, within the hour; the API's log holds"
    echo "it until then, so keep that log to yourself; a new one: first-admin, deploy/README.md):"
    echo
    echo "  $last"
    ;;
  *ignored*)
    echo "The instance has users already, so no first admin was made. A new link for an admin:"
    echo "  cd $here && docker compose exec api node dist/database/first-admin.main.js <email>"
    ;;
  *)
    if [ -z "$(setting CCMS_FIRST_ADMIN_EMAIL)" ]; then
      echo "No first admin yet: run this again with --admin <email>, or"
    else
      echo "The API did not start anew, so it printed no link now. A new link for an admin:"
    fi
    echo "  cd $here && docker compose exec api node dist/database/first-admin.main.js <email>"
    ;;
esac
