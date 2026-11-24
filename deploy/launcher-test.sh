#!/bin/sh
# The public demo's launcher (#828; deploy/README.md, "The public demo") on a real container
# runtime: the agent (the only process with the runtime's socket) and the launcher on a control
# network of their own, the sandbox image behind them. It checks:
#
# - two visitors each start a sandbox through the launcher (deploy/launcher-client.mjs: the
#   challenge, the start, the cookie; ready in under 10 s) and reach their own; one without a
#   cookie gets the start page;
# - each sandbox runs as the agent starts it: its own internal network with only the launcher
#   besides, a read-only root file system, the memory, CPU, process and tmpfs limits, no
#   capabilities, a capped log;
# - neither sandbox reaches the other, nor the launcher's listener, nor the agent, nor the outside;
# - a third start is refused when the cap is reached (CCMS_LAUNCHER_MAX_SANDBOXES=2);
# - a visitor ends their sandbox through the end route the sandbox's GET /api/sandbox names
#   (#846): its container and network go, the other visitor's stay;
# - on the launcher's stop every sandbox and its network are gone, and a sandbox left behind is
#   removed at the launcher's next start.
#
#   deploy/launcher-test.sh                       builds both images from this checkout first
#   SANDBOX_IMAGE=<image> LAUNCHER_IMAGE=<image> deploy/launcher-test.sh
#
# LAUNCHER_KEEP=1 leaves everything running. It publishes no port and reads no settings file.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
instance=test-$suffix
control=openfolia-launcher-test-$suffix
launcher=openfolia-launcher-test-$suffix-launcher
agent=openfolia-launcher-test-$suffix-agent
token=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
work=$(mktemp -d)

# Every container and network of this run's instance, by its label.
leftovers() {
  docker ps -aq --filter "label=org.openfolia.sandbox.instance=$instance"
  docker network ls -q --filter "label=org.openfolia.sandbox.instance=$instance"
}

cleanup() {
  status=$?
  if [ "$status" != 0 ]; then
    for c in "$launcher" "$agent"; do
      docker inspect "$c" >/dev/null 2>&1 || continue
      echo "--- the log of $c" >&2
      docker logs --tail 40 "$c" >&2 2>&1 || true
    done
  fi
  if [ "${LAUNCHER_KEEP:-0}" != 1 ]; then
    docker rm -f "$launcher" "$agent" >/dev/null 2>&1 || true
    for c in $(docker ps -aq --filter "label=org.openfolia.sandbox.instance=$instance"); do
      docker rm -f "$c" >/dev/null 2>&1 || true
    done
    for n in $(docker network ls -q --filter "label=org.openfolia.sandbox.instance=$instance"); do
      docker network rm "$n" >/dev/null 2>&1 || true
    done
    docker network rm "$control" >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
  if [ "$status" = 0 ]; then echo "launcher-test: passed"; else echo "launcher-test: FAILED" >&2; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

step() { printf '\n== %s\n' "$*"; }
fail() {
  echo "launcher-test: $*" >&2
  exit 1
}

sandbox_image=${SANDBOX_IMAGE:-}
launcher_image=${LAUNCHER_IMAGE:-}
if [ -z "$sandbox_image" ]; then
  sandbox_image=openfolia-launcher-test/sandbox:local
  step "building the sandbox image ($sandbox_image)"
  docker build --target sandbox -t "$sandbox_image" "$root"
fi
if [ -z "$launcher_image" ]; then
  launcher_image=openfolia-launcher-test/sandbox-launcher:local
  step "building the launcher image ($launcher_image)"
  docker build --target sandbox-launcher -t "$launcher_image" "$root"
fi
socket_gid=$(docker run --rm -v /var/run/docker.sock:/var/run/docker.sock --entrypoint stat "$launcher_image" -c %g /var/run/docker.sock)

docker network create --internal "$control" >/dev/null

# The agent: the socket, the control network, nothing else; as compose.demo.yaml runs it.
run_agent() {
  docker run -d --name "$agent" --network "$control" --network-alias agent \
    --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    --group-add "$socket_gid" -v /var/run/docker.sock:/var/run/docker.sock \
    -e CCMS_LAUNCHER_PUBLIC_URL=http://localhost:8080 \
    -e CCMS_LAUNCHER_AGENT_HOST=0.0.0.0 -e CCMS_LAUNCHER_AGENT_TOKEN="$token" \
    -e CCMS_LAUNCHER_SANDBOX_IMAGE="$sandbox_image" -e CCMS_LAUNCHER_CONTAINER="$launcher" \
    -e CCMS_LAUNCHER_INSTANCE="$instance" \
    "$launcher_image" node dist/agent-main.js >/dev/null
}

# The launcher: on loopback in its own container, the visitors (below) in its network namespace.
run_launcher() {
  docker run -d --name "$launcher" --network "$control" \
    --read-only --cap-drop ALL --security-opt no-new-privileges:true \
    -e CCMS_LAUNCHER_PUBLIC_URL=http://localhost:8080 -e CCMS_LAUNCHER_HOST=127.0.0.1 \
    -e CCMS_LAUNCHER_AGENT_URL=http://agent:8081 -e CCMS_LAUNCHER_AGENT_TOKEN="$token" \
    -e CCMS_LAUNCHER_MAX_SANDBOXES=2 -e CCMS_LAUNCHER_PER_ADDRESS=3 \
    -e CCMS_LAUNCHER_PER_ADDRESS_DAILY=10 -e CCMS_LAUNCHER_POW_BITS=0 \
    "$launcher_image" >/dev/null
  i=0
  until docker exec "$launcher" node -e "fetch('http://127.0.0.1:8080/_demo/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -lt 120 ] || fail "the launcher is not ready after a minute"
    [ "$(docker inspect --format '{{.State.Running}}' "$launcher")" = true ] || fail "the launcher ended"
    sleep 0.5
  done
}

visitors() {
  docker run --rm -i --network "container:$launcher" --read-only --cap-drop ALL \
    -e LAUNCHER_URL=http://localhost:8080 \
    --entrypoint node "$launcher_image" --input-type=module - <"$here/launcher-client.mjs"
}

step "the agent and the launcher"
run_agent
run_launcher

step "two visitors, a sandbox each"
visitors >"$work/cookies"
set -- $(docker ps -q --filter "label=org.openfolia.sandbox.instance=$instance")
[ "$#" = 2 ] || fail "expected 2 sandboxes, found $#"
a=$(docker inspect --format '{{.Name}}' "$1" | tr -d /)
b=$(docker inspect --format '{{.Name}}' "$2" | tr -d /)
echo "sandboxes: $a $b"

step "each as the agent starts it"
for s in "$a" "$b"; do
  [ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}} {{.HostConfig.CapDrop}} {{.HostConfig.LogConfig.Type}}' "$s")" = \
    "true 1073741824 1073741824 1000000000 256 [ALL] local" ] || fail "$s: not started with the limits"
  [ "$(docker inspect --format '{{.HostConfig.PortBindings}}' "$s")" = 'map[]' ] || fail "$s publishes a port"
  nets=$(docker inspect --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$s")
  [ "$nets" = "$s " ] || fail "$s is on more than its own network: $nets"
  [ "$(docker network inspect --format '{{.Internal}}' "$s")" = true ] || fail "$s: its network is not internal"
  members=$(docker network inspect --format '{{range .Containers}}{{.Name}} {{end}}' "$s" | tr ' ' '\n' | grep -v '^$' | sort | tr '\n' ' ')
  expected=$(printf '%s\n%s\n' "$launcher" "$s" | sort | tr '\n' ' ')
  [ "$members" = "$expected" ] || fail "$s: its network holds $members"
done

step "neither reaches the other, the launcher's listener, the agent or the outside"
reach() {
  docker exec "$1" node -e "
    const net = require('node:net');
    const s = net.connect({ host: process.argv[1], port: Number(process.argv[2]), timeout: 2000 });
    s.on('connect', () => process.exit(0));
    s.on('error', () => process.exit(1));
    s.on('timeout', () => process.exit(1));" "$2" "$3" 2>/dev/null
}
launcher_ip_a=$(docker inspect --format "{{(index .NetworkSettings.Networks \"$a\").IPAddress}}" "$launcher")
for pair in "$a $b" "$b $a"; do
  set -- $pair
  ! reach "$1" "$2" 8080 || fail "$1 reaches $2"
  ! reach "$1" agent 8081 || fail "$1 reaches the agent"
  ! reach "$1" 1.1.1.1 443 || fail "$1 reaches the outside"
done
! reach "$a" "$launcher_ip_a" 8080 || fail "$a reaches the launcher's listener"
reach "$launcher" "$a" 8080 || fail "the launcher does not reach $a"

step "the cap: a third start is refused"
third=$(docker run --rm --network "container:$launcher" --entrypoint node "$launcher_image" --input-type=module -e "
  const base = 'http://localhost:8080';
  const h = { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' };
  const c = await (await fetch(base + '/_demo/api/challenge', { method: 'POST', headers: h, body: '{}' })).json();
  const r = await fetch(base + '/_demo/api/start', { method: 'POST', headers: h, body: JSON.stringify({ challenge: c.challenge, nonce: '0', lang: 'en' }) });
  console.log(r.status, (await r.json()).code);")
[ "$third" = "503 full" ] || fail "a third start answered: $third"

step "a visitor ends their sandbox from the banner's route: theirs goes, the other stays (#846)"
cookie_a=$(sed -E 's/.*"a":"([^"]+)".*/\1/' "$work/cookies")
ended=$(docker run --rm --network "container:$launcher" -e COOKIE="$cookie_a" --entrypoint node "$launcher_image" --input-type=module -e "
  const base = 'http://localhost:8080';
  const cookie = process.env.COOKIE;
  const sandbox = await (await fetch(base + '/api/sandbox', { headers: { cookie, origin: base, accept: 'application/vnd.api+json', 'x-ccms-user': 'demo-author' } })).json();
  const h = { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin', cookie };
  const r = await fetch(base + '/_demo/api/end', { method: 'POST', headers: h, body: JSON.stringify({ lang: 'en' }) });
  const after = await fetch(base + '/api/sandbox', { headers: { cookie, accept: 'application/vnd.api+json' } });
  console.log(sandbox.data.attributes.endUrl, r.status, (await r.json()).next, after.status);")
[ "$ended" = "/_demo/api/end 200 /?ended=closed&lang=en 404" ] || fail "ending a sandbox answered: $ended"
[ "$(docker ps -aq --filter "label=org.openfolia.sandbox.instance=$instance" | wc -l | tr -d ' ')" = 1 ] || fail "not exactly one sandbox left after the end"
[ "$(docker network ls -q --filter "label=org.openfolia.sandbox.instance=$instance" | wc -l | tr -d ' ')" = 1 ] || fail "not exactly one sandbox network left after the end"

step "the launcher stops: every sandbox goes"
docker stop -t 30 "$launcher" >/dev/null
[ -z "$(leftovers)" ] || fail "left after the launcher stopped: $(leftovers | tr '\n' ' ')"

step "a sandbox left behind goes at the launcher's next start"
docker rm "$launcher" >/dev/null
docker network create --internal --label org.openfolia.sandbox=00000000000000aa --label "org.openfolia.sandbox.instance=$instance" "openfolia-sandbox-$instance-00000000000000aa" >/dev/null
run_launcher
[ -z "$(leftovers)" ] || fail "left after the launcher's start: $(leftovers | tr '\n' ' ')"
