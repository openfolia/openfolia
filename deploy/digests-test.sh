#!/bin/sh
# A release's images pinned by their digests (#739), end to end on a registry of its own, then
# removed again (the registry, its volume, the images and the containers it made):
#
# - images pushed to the registry under a release tag, each an index of linux/amd64 and
#   linux/arm64 (#827), and scripts/release-digests.mjs recording
#   their digests (images.lock, compose.digests.yaml), as the release workflow does;
# - the install guide for coding agents rendered for that release (DOCS_RELEASE_DIGESTS = the
#   lock): it names the SHA-256 of the very override the release wrote;
# - compose.yaml with the override names every OpenFolia image by tag and digest (the guide's
#   step 4 check), and an installation set up as the guide's step 4 does (COMPOSE_FILE) runs them:
#   the guide's own step 7 image check prints `every image pinned`;
# - an installation by tag alone, before the tag moves: it runs the same images, but its settings
#   would follow the tag, and the check fails (`NOT pinned by the settings`);
# - the tag moved in the registry to other images: the pinned installation, its images removed,
#   pulls again and still runs the release's images, and passes the check again; the installation
#   by tag alone runs the moved images, and the check fails (`NOT the pinned image`).
#
#   deploy/digests-test.sh
#
# Settings: DIGESTS_TEST_REGISTRY_PORT (on 127.0.0.1, default 5739). It pulls nothing but the
# registry image and the Postgres image compose.yaml pins, both by digest; its own images are
# built from the latter, each only a label apart, and run `sleep`. It reads no settings file of a
# deployment on the same machine: every installation is a temporary folder of its own.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
port=${DIGESTS_TEST_REGISTRY_PORT:-5739}
name=openfolia-digests-test
registry_image=registry:2.8.3@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373
# The base of the test's images: the Postgres image compose.yaml pins, so nothing else is pulled.
base_image=$(sed -n 's/^ *image: \(postgres:[^ ]*@sha256:[0-9a-f]\{64\}\)$/\1/p' "$here/compose.yaml")
repo="localhost:$port/digests-test/openfolia"
tag=v9.9.9
images="api backup editor embedder mcp portal sandbox sandbox-launcher demo-portal"
work=$(mktemp -d)
own_registry=

unset COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES OPENFOLIA_IMAGES OPENFOLIA_VERSION

cleanup() {
  status=$?
  for install in pinned tagged; do
    if [ -d "$work/$install" ]; then
      (cd "$work/$install" && docker compose down --volumes --remove-orphans >/dev/null 2>&1) || true
    fi
  done
  # Only a registry this run started, never another run's (the guard below stops before one).
  if [ -n "$own_registry" ]; then
    docker rm -f -v "$name-registry" >/dev/null 2>&1 || true
    docker volume rm "$name-registry" >/dev/null 2>&1 || true
    # Every image of the test's repository: built, pushed, or pulled by tag or digest.
    ids=$( (docker image ls -q --filter "reference=$repo/*" 2>/dev/null; cat "$work/ids" 2>/dev/null) | sort -u)
  else
    ids=$(sort -u "$work/ids" 2>/dev/null || true)
  fi
  # shellcheck disable=SC2086
  [ -z "$ids" ] || docker rmi -f $ids >/dev/null 2>&1 || true
  rm -rf "$work"
  if [ "$status" = 0 ]; then echo "digests-test: passed"; else echo "digests-test: FAILED" >&2; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

fail() {
  echo "digests-test: $*" >&2
  exit 1
}

[ -n "$base_image" ] || fail "no Postgres image pinned by digest in compose.yaml"
if docker ps -a --format '{{.Names}}' | grep -qx "$name-registry"; then
  fail "a container $name-registry exists already: remove it first"
fi
if docker volume inspect "$name-registry" >/dev/null 2>&1; then
  fail "a volume $name-registry exists already: remove it first"
fi

echo "--- a registry of its own on 127.0.0.1:$port"
docker run -d --name "$name-registry" -p "127.0.0.1:$port:5000" \
  -v "$name-registry:/var/lib/registry" "$registry_image" >/dev/null
own_registry=1
i=0
until curl -fsS -o /dev/null "http://127.0.0.1:$port/v2/"; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || fail "the registry does not answer"
  sleep 1
done

# The release's images, one variant: each image only a label apart, so each has a digest of its own.
# Each is an index of a linux/amd64 and a linux/arm64 image, as the workflow's merge job makes it
# (#827; release-digests refuses anything else). Neither build runs a command, so building for the
# other architecture needs no emulation.
publish() {
  variant=$1
  for image in $images; do
    for arch in amd64 arm64; do
      printf 'FROM %s\nLABEL org.openfolia.digests-test.image=%s org.openfolia.digests-test.variant=%s\nENTRYPOINT []\nCMD ["sleep", "3600"]\n' \
        "$base_image" "$image" "$variant" |
        docker build -q --platform "linux/$arch" -t "$repo/$image:$tag-$arch" - >>"$work/ids"
      docker push -q "$repo/$image:$tag-$arch" >/dev/null
      # The installations pull from the registry, as on a server, never from this build.
      docker rmi "$repo/$image:$tag-$arch" >/dev/null
    done
    docker buildx imagetools create --tag "$repo/$image:$tag" "$repo/$image:$tag-amd64" "$repo/$image:$tag-arm64" >/dev/null 2>&1 ||
      fail "no index of both architectures for $image"
  done
}

# compose.yaml's services that run an OpenFolia image, with only their image and profiles: the
# same names and the same image settings, so the override fits it as it fits compose.yaml.
stripped_compose() {
  (cd "$root/scripts" && node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { parse, stringify } from "yaml";
    import { pinnedServices } from "./release-digests.mjs";
    const compose = parse(readFileSync(process.argv[1], "utf8"), { merge: true });
    const services = {};
    for (const { service } of pinnedServices(compose)) {
      const { image, profiles } = compose.services[service];
      services[service] = profiles ? { image, profiles } : { image };
    }
    process.stdout.write(stringify({ services }));
  ' "$here/compose.yaml")
}

# An installation folder as the guide's steps 3 and 4 make it; `pinned` names the override.
install() {
  dir="$work/$1"
  mkdir -p "$dir"
  stripped_compose >"$dir/compose.yaml"
  cp "$work/release/compose.digests.yaml" "$dir/compose.digests.yaml"
  {
    echo "COMPOSE_PROJECT_NAME=$name-$1"
    if [ "$1" = pinned ]; then echo "COMPOSE_FILE=compose.yaml:compose.digests.yaml"; fi
    echo "COMPOSE_PROFILES=mcp,portal"
    echo "OPENFOLIA_IMAGES=$repo"
    echo "OPENFOLIA_VERSION=$tag"
  } >"$dir/.env"
}

start() {
  (cd "$work/$1" && docker compose pull -q && docker compose up -d --quiet-pull >/dev/null 2>&1)
  (cd "$work/$1" && docker compose ps -q) | while read -r id; do
    docker inspect --format '{{.Image}}' "$id" >>"$work/ids"
  done
}

# An installation stopped, and the images it ran removed: its next start pulls them again.
reset() {
  used=$( (cd "$work/$1" && docker compose ps -q) | while read -r id; do docker inspect --format '{{.Image}}' "$id"; done | sort -u)
  (cd "$work/$1" && docker compose down >/dev/null 2>&1)
  # shellcheck disable=SC2086
  [ -z "$used" ] || docker rmi -f $used >/dev/null
}

# The guide's step 7 image check, as the guide of this release words it, run in an installation.
check() {
  (cd "$work/$1" && sh "$work/check.sh")
}

echo "--- the release: images pushed, their digests recorded"
publish release
node "$root/scripts/release-digests.mjs" --images "$repo" --tag "$tag" --out "$work/release" \
  --compose "$here/compose.yaml" >/dev/null
for image in $images; do
  grep -qx "$repo/$image:$tag@sha256:[0-9a-f]\{64\}" "$work/release/images.lock" ||
    fail "images.lock names no digest for $image"
done

echo "--- the release's guide: the override's SHA-256 and the step 7 check"
(cd "$root/frontend/docs" && DOCS_RELEASE="$tag" DOCS_SITE_URL=https://docs.example.com \
  DOCS_IMAGES="$repo" CHECK_OUT="$work/check.sh" DOCS_RELEASE_DIGESTS="$(cat "$work/release/images.lock")" \
  node --input-type=module -e '
    import { readFileSync, writeFileSync } from "node:fs";
    import { checkAgentGuide, codeBlocks, guideValues, renderAgentGuide } from "./scripts/lib/agent-guide.mjs";
    import { docsSettings } from "./scripts/lib/settings.mjs";
    const settings = docsSettings(process.env);
    const values = guideValues(settings, readFileSync("../../deploy/compose.yaml", "utf8"), "en");
    const page = renderAgentGuide(readFileSync("agents/agents.mdx", "utf8"), values);
    const problems = checkAgentGuide(page, { english: true, rendered: true });
    if (problems.length) throw new Error(problems.join("\n"));
    const block = codeBlocks(page).find((b) => b.includes("RepoDigests"));
    if (!block?.startsWith("cd ~/openfolia\n")) throw new Error("no image check in step 7");
    process.stdout.write(values.DIGESTS_SHA256 + "\n");
    writeFileSync(process.env.CHECK_OUT, block.slice("cd ~/openfolia\n".length));
  ' >"$work/guide-sha256")
(cd "$work/release" && echo "$(cat "$work/guide-sha256")  compose.digests.yaml" | shasum -a 256 -c - >/dev/null) ||
  fail "the guide names another SHA-256 than the release's compose.digests.yaml"

echo "--- compose.yaml with the override names every OpenFolia image by its digest (step 4)"
mkdir -p "$work/real"
cp "$here/compose.yaml" "$work/real/compose.yaml"
cp "$work/release/compose.digests.yaml" "$work/real/compose.digests.yaml"
(cd "$work/real" && COMPOSE_PROJECT_NAME="$name-real" COMPOSE_FILE=compose.yaml:compose.digests.yaml \
  COMPOSE_PROFILES=mcp,portal,restore OPENFOLIA_IMAGES="$repo" OPENFOLIA_VERSION="$tag" POSTGRES_PASSWORD=unused \
  docker compose --env-file /dev/null config --images) | sort -u >"$work/real/images"
grep -v '^postgres:' "$work/real/images" | while read -r ref; do
  grep -qxF "$ref" "$work/release/images.lock" || fail "compose.yaml runs $ref, which images.lock does not pin"
done
[ "$(grep -vc '^postgres:' "$work/real/images")" = 5 ] || fail "not the five images api, backup, editor, mcp and portal: $(cat "$work/real/images")"

echo "--- an installation as the guide makes it: the check passes"
install pinned
start pinned
check pinned >"$work/out"
cat "$work/out"
grep -qx "every image pinned" "$work/out" || fail "the pinned installation fails the check"
[ "$(grep -c ': pinned$' "$work/out")" = 6 ] || fail "not every service checked (api, worker, editor, backup, mcp, portal)"

echo "--- an installation by tag alone, the tag not moved yet: the check fails all the same"
install tagged
start tagged
check tagged >"$work/out"
cat "$work/out"
grep -qx "an image is not pinned: stop" "$work/out" || fail "the check passed settings that follow the tag"
[ "$(grep -c ': NOT pinned by the settings$' "$work/out")" = 6 ] || fail "not every unpinned service found"
(cd "$work/tagged" && docker compose down >/dev/null 2>&1)

echo "--- the tag moved in the registry to other images"
publish moved
node "$root/scripts/release-digests.mjs" --images "$repo" --tag "$tag" --out "$work/moved" \
  --compose "$here/compose.yaml" >/dev/null
! cmp -s "$work/release/images.lock" "$work/moved/images.lock" || fail "the tag did not move"

echo "--- the pinned installation, its images removed, pulled and started again: still the release's"
reset pinned
start pinned
check pinned >"$work/out"
cat "$work/out"
grep -qx "every image pinned" "$work/out" || fail "a moved tag changed the pinned installation"

echo "--- the installation by tag alone, pulled again, runs the moved images: the check fails"
start tagged
check tagged >"$work/out"
cat "$work/out"
grep -qx "an image is not pinned: stop" "$work/out" || fail "the check passed images the release does not pin"
[ "$(grep -c ': NOT the pinned image$' "$work/out")" = 6 ] || fail "not every moved image found"
