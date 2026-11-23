#!/bin/sh
# Semantic search with the local embedding worker, with the network cut off (#532;
# deploy/README.md, "Semantic search"): builds the API, Postgres with pgvector and the embedding
# worker from this checkout, starts them with compose.yaml, compose.vector.yaml and
# compose.embedder.yaml on networks without a route out (offline.yaml), puts the sample content
# in, checks that neither the API nor the worker reaches the outside, and that a search finds a
# module by meaning alone. Then removes everything it made (containers, volumes, networks).
#
#   SEMANTIC_MODEL_DIR=/path/to/model SEMANTIC_DIMENSIONS=384 deploy/semantic-search-test.sh
#
# SEMANTIC_MODEL_DIR: a model folder (model.onnx, tokenizer.json; backend/embedder/README.md,
# "The model"), multilingual: the query below is German, the content English. SEMANTIC_DIMENSIONS:
# its vectors' length. Optional: SEMANTIC_PREFIX, SEMANTIC_POOLING (the worker's
# CCMS_EMBEDDER_PREFIX and _POOLING), SEMANTIC_QUERY (default "Akku aufladen"),
# SEMANTIC_PROJECT (default openfolia-semantic), SEMANTIC_BUILD=0 to use the images as they are,
# SEMANTIC_KEEP=1 to leave the stack running. It reads no settings file (--env-file /dev/null).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
project=${SEMANTIC_PROJECT:-openfolia-semantic}
model_dir=${SEMANTIC_MODEL_DIR:?set SEMANTIC_MODEL_DIR: a folder with model.onnx and tokenizer.json}
model_dir=$(cd "$model_dir" && pwd)
query=${SEMANTIC_QUERY:-Akku aufladen}

sha() { { sha256sum "$1" 2>/dev/null || shasum -a 256 "$1"; } | cut -d' ' -f1; }

token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
export POSTGRES_PASSWORD
POSTGRES_PASSWORD=$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')
export CCMS_AUTH_MODE=token CCMS_API_TOKEN="$token"
export OPENFOLIA_API_ENV_FILE=/dev/null OPENFOLIA_WORKER_ENV_FILE=/dev/null OPENFOLIA_BACKUP_ENV_FILE=/dev/null
export OPENFOLIA_API_ROLE=api OPENFOLIA_EMBEDDER_MODEL_DIR="$model_dir"
export CCMS_EMBEDDER_MODEL=semantic-test CCMS_EMBEDDER_DIMENSIONS="${SEMANTIC_DIMENSIONS:?set SEMANTIC_DIMENSIONS}"
export CCMS_EMBEDDER_PREFIX="${SEMANTIC_PREFIX:-}" CCMS_EMBEDDER_POOLING="${SEMANTIC_POOLING:-}"
CCMS_EMBEDDER_MODEL_SHA256=$(sha "$model_dir/model.onnx")
CCMS_EMBEDDER_TOKENIZER_SHA256=$(sha "$model_dir/tokenizer.json")
export CCMS_EMBEDDER_MODEL_SHA256 CCMS_EMBEDDER_TOKENIZER_SHA256
unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES CCMS_TRUST_PROXY
if [ "${SEMANTIC_BUILD:-1}" = 1 ]; then
  export OPENFOLIA_IMAGES="$project" OPENFOLIA_VERSION=test
fi

files="-f ${here}/compose.yaml -f ${here}/compose.vector.yaml -f ${here}/compose.embedder.yaml"
if [ "${SEMANTIC_BUILD:-1}" = 1 ]; then files="$files -f ${here}/compose.build.yaml"; fi
files="$files -f ${here}/offline.yaml"
services="postgres api worker embedder"
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
  if [ "${SEMANTIC_KEEP:-0}" != 1 ]; then
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

step() { printf '\n== %s\n' "$*"; }
fail() {
  echo "FAILED: $*" >&2
  exit 1
}

# Never on a stack of the same name that is already there: cleanup removes its volumes.
if [ -n "$(docker ps -aq --filter "label=com.docker.compose.project=$project")" ]; then
  echo "A Compose project named $project exists already; set SEMANTIC_PROJECT to another name." >&2
  trap - EXIT
  exit 1
fi

if [ "${SEMANTIC_BUILD:-1}" = 1 ]; then
  step "build"
  # shellcheck disable=SC2086 # a list of services
  compose build --quiet $services
fi

step "sample content onto the empty data volume"
compose run --rm --no-deps api node docker/sample-content.mjs

step "start, with no route out"
# shellcheck disable=SC2086 # a list of services
compose up -d --wait --wait-timeout 300 $services
compose ps --format 'table {{.Service}}\t{{.Status}}'

step "nothing reaches the outside"
for service in api embedder; do
  out=$(compose exec -T "$service" node -e "fetch('https://example.com', { signal: AbortSignal.timeout(5000) }).then(() => console.log('reached'), (e) => console.log('unreachable', e.cause?.code ?? e.name))")
  case "$out" in
    unreachable*) echo "$service: https://example.com $out" ;;
    *) fail "$service reached the outside: $out" ;;
  esac
done

step "a search finds a module by meaning (\"$query\")"
# The first search indexes the content and asks a worker to embed it; then the query's meaning
# finds the module whose words it does not share.
search="fetch('http://127.0.0.1:3000/search?filter[q]=' + encodeURIComponent(process.argv[1]), { headers: { Authorization: 'Bearer ' + process.env.CCMS_API_TOKEN, Accept: 'application/vnd.api+json' } }).then((r) => r.json()).then((b) => console.log((b.data ?? []).filter((h) => h.meta.matchedOn === 'meaning').map((h) => h.attributes.resourceId).join(' ')), () => console.log(''))"
found=""
started=$(date +%s)
for _ in $(seq 1 60); do
  found=$(compose exec -T api node -e "$search" "$query") || found=
  [ -n "$found" ] && break
  sleep 3
done
[ -n "$found" ] || fail "no hit by meaning within 3 minutes"
echo "found by meaning: $found (after $(($(date +%s) - started)) s)"
compose logs --no-color embedder | grep -i 'embedding worker' || true
echo
echo "semantic search works offline."
