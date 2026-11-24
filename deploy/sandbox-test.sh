#!/bin/sh
# The sandbox image (#827; deploy/README.md, "The sandbox image"), started as the launcher starts
# one per visitor, checked, measured, and removed again:
#
# - started on a network of its own with no route out (`docker network create --internal`), a
#   read-only root file system, a size-capped tmpfs at /tmp, every capability dropped, no new
#   privileges, and memory and CPU limits; ready (its health check) within SANDBOX_READY_SECONDS;
# - not root, nothing written outside /tmp, nothing to reach but the editor's port: no outbound
#   connection or name lookup from inside, and neither the API's nor the database's port from
#   the network;
# - through the editor's port, from a client container on the same network
#   (deploy/sandbox-client.mjs): each demo person signed in, the baked state there, the proxy's
#   refusals, an upload refused; a change made, reviewed and merged, and a visitor typing; a
#   release cut, its PDFs rendered and one downloaded;
# - the German state started too; on removal nothing is left (no volume).
#
# Its memory (the container's cgroup, as `docker stats` counts it: page cache it can drop left
# out) and CPU time are sampled throughout and printed per phase: started, idle, editing,
# rendering (deploy/README.md, "Sizing the sandboxes").
#
#   deploy/sandbox-test.sh                         builds the image from this checkout first
#   SANDBOX_IMAGE=<image> deploy/sandbox-test.sh   that image, as it is
#
# Settings: SANDBOX_MEMORY (default 1g), SANDBOX_CPUS (1), SANDBOX_TMPFS (256m),
# SANDBOX_READY_SECONDS (5), SANDBOX_IDLE_SECONDS (20), SANDBOX_EDIT_SAVES (30), SANDBOX_KEEP=1 to
# leave the container running. It publishes no port and reads no settings file.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
suffix=$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')
name=openfolia-sandbox-test-$suffix
net=openfolia-sandbox-test-$suffix
memory=${SANDBOX_MEMORY:-1g}
cpus=${SANDBOX_CPUS:-1}
tmpfs=${SANDBOX_TMPFS:-256m}
ready_seconds=${SANDBOX_READY_SECONDS:-5}
idle_seconds=${SANDBOX_IDLE_SECONDS:-20}
saves=${SANDBOX_EDIT_SAVES:-30}
work=$(mktemp -d)
sampler=

cleanup() {
  status=$?
  [ -z "$sampler" ] || kill "$sampler" 2>/dev/null || true
  if [ "$status" != 0 ]; then
    for c in "$name" "$name-de"; do
      docker inspect "$c" >/dev/null 2>&1 || continue
      echo "--- the log of $c" >&2
      docker logs --tail 60 "$c" >&2 2>&1 || true
    done
  fi
  if [ "${SANDBOX_KEEP:-0}" != 1 ]; then
    docker rm -f "$name" "$name-de" >/dev/null 2>&1 || true
    docker network rm "$net" >/dev/null 2>&1 || true
  fi
  rm -rf "$work"
  if [ "$status" = 0 ]; then echo "sandbox-test: passed"; else echo "sandbox-test: FAILED" >&2; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

step() { printf '\n== %s\n' "$*"; }
fail() {
  echo "sandbox-test: $*" >&2
  exit 1
}
# Milliseconds since the epoch: GNU date, else Node (macOS's date has no %N).
now_ms() {
  t=$(date +%s%3N 2>/dev/null || true)
  case "$t" in
    '' | *[!0-9]*) node -e 'console.log(Date.now())' ;;
    *) echo "$t" ;;
  esac
}

if [ -n "${SANDBOX_IMAGE:-}" ]; then
  image=$SANDBOX_IMAGE
else
  image=openfolia-sandbox-test/sandbox:local
  step "building the image ($image)"
  docker build --target sandbox -t "$image" "$root"
fi

docker network create --internal "$net" >/dev/null

# The container as the launcher runs it; the name `sandbox` on the network, as the editor's host.
start() {
  docker run -d --name "$1" --network "$net" --network-alias "$2" \
    --read-only --tmpfs "/tmp:rw,size=$tmpfs,mode=1777" \
    --cap-drop ALL --security-opt no-new-privileges:true \
    --memory "$memory" --memory-swap "$memory" --cpus "$cpus" --pids-limit 256 \
    --log-driver local --log-opt max-size=5m --log-opt max-file=2 \
    -e CCMS_SANDBOX_LANG="$3" -e CCMS_EDITOR_HOSTS="$2" \
    "$image" >/dev/null
}

# Ready: the image's own health check, run until it passes; the time from `docker run` on.
wait_ready() {
  started=$1
  i=0
  until docker exec "$2" /usr/local/bin/openfolia-sandbox-health >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -lt 600 ] || fail "$2 is not healthy after a minute"
    [ "$(docker inspect --format '{{.State.Running}}' "$2")" = true ] || fail "$2 ended"
    sleep 0.05
  done
  echo $(($(now_ms) - started))
}

# The client (deploy/sandbox-client.mjs) in a container of its own on the network.
client() {
  docker run --rm -i --network "$net" --read-only --cap-drop ALL \
    -e SANDBOX_URL="http://$1:8080" -e MODE="$2" -e SANDBOX_LANG="$3" -e EDIT_SAVES="$saves" \
    --entrypoint node "$image" --input-type=module - <"$here/sandbox-client.mjs"
}

# One sample of the sandbox's cgroup: the phase, its memory as `docker stats` counts it (usage less
# the inactive page cache), its tmpfs (shmem) and its CPU time in microseconds.
sample() {
  docker exec "$name" sh -c '
    current=$(cat /sys/fs/cgroup/memory.current)
    inactive=$(awk "\$1 == \"inactive_file\" { print \$2 }" /sys/fs/cgroup/memory.stat)
    shmem=$(awk "\$1 == \"shmem\" { print \$2 }" /sys/fs/cgroup/memory.stat)
    cpu=$(awk "\$1 == \"usage_usec\" { print \$2 }" /sys/fs/cgroup/cpu.stat)
    echo "$((current - inactive)) $shmem $cpu"' 2>/dev/null | sed "s/^/$(cat "$work/phase") /"
}
phase() { echo "$1" >"$work/phase"; }

step "starting the sandbox (memory $memory, $cpus CPU, tmpfs $tmpfs, no route out)"
phase start
t0=$(now_ms)
start "$name" sandbox en
ready_ms=$(wait_ready "$t0" "$name")
echo "ready in $ready_ms ms from docker run ($(docker logs "$name" 2>&1 | sed -n 's/^openfolia-sandbox: \(ready in .*\)$/\1/p'))"
[ "$ready_ms" -le $((ready_seconds * 1000)) ] || fail "not ready within $ready_seconds s: $ready_ms ms"
sample >>"$work/samples"
(while :; do sample >>"$work/samples" || true; sleep 0.5; done) &
sampler=$!

step "contained: not root, a read-only root file system, the tmpfs, nothing out"
[ "$(docker exec "$name" id -u)" != 0 ] || fail "it runs as root"
! docker exec "$name" sh -c 'touch /app/x' 2>/dev/null || fail "the root file system is writable"
docker exec "$name" sh -c 'stat -f -c %T /tmp' | grep -qx tmpfs || fail "/tmp is no tmpfs"
[ "$(docker inspect --format '{{len .Mounts}}' "$name")" = 0 ] || fail "it has a volume"
for target in 1.1.1.1/443 8.8.8.8/53 93.184.215.14/80; do
  ! docker exec "$name" bash -c "exec 3<>/dev/tcp/${target}" 2>/dev/null || fail "an outbound connection to $target succeeded"
done
! docker exec "$name" getent hosts example.com >/dev/null 2>&1 || fail "a name was looked up from inside"
# From the network, only the editor's port: the API and the database listen on the loopback.
docker run --rm --network "$net" --entrypoint bash "$image" -c '
  exec 3<>/dev/tcp/sandbox/8080 || exit 1
  for port in 3000 5432; do (exec 4<>/dev/tcp/sandbox/$port) 2>/dev/null && { echo "port $port is reachable"; exit 1; }; done
  exit 0' || fail "a port other than the editor's is reachable from the network"
echo "uid $(docker exec "$name" id -u), root file system read only, /tmp a tmpfs of $tmpfs, no volume, no route out, only port 8080"

step "idle for $idle_seconds s"
phase idle
sleep "$idle_seconds"

step "the demo people, the baked state, the refusals"
phase people
client sandbox people en

step "a change made, reviewed and merged; a visitor typing ($saves autosaves)"
phase editing
client sandbox edit en

step "a release cut, its PDFs rendered"
phase rendering
client sandbox render en

phase after
sleep 2
kill "$sampler" 2>/dev/null || true
sampler=
peak=$(docker exec "$name" cat /sys/fs/cgroup/memory.peak 2>/dev/null || echo 0)
tmp_used=$(docker exec "$name" df -k /tmp | awk 'NR == 2 { print $3 }')

step "the German state"
t0=$(now_ms)
start "$name-de" sandbox-de de
ready_de=$(wait_ready "$t0" "$name-de")
echo "ready in $ready_de ms from docker run"
[ "$ready_de" -le $((ready_seconds * 1000)) ] || fail "the German state is not ready within $ready_seconds s: $ready_de ms"
client sandbox-de people de | grep 'in review' | grep -q 'Rad wechseln' || fail "the German state has no German change set in review"
echo "the German change set in review is there"

step "measured (memory as docker stats counts it; CPU time of the sandbox's cgroup)"
awk -v peak="$peak" -v tmp="$tmp_used" -v ready="$ready_ms" '
  !($1 in seen) { seen[$1] = 1; order[++n] = $1 }
  { if ($2 > mem[$1]) mem[$1] = $2; last[$1] = $2; shm[$1] = $3; cpu[$1] = $4 }
  END {
    printf "%-10s %10s %10s %10s %10s\n", "phase", "peak MiB", "end MiB", "tmpfs MiB", "CPU s"
    before = 0
    for (i = 1; i <= n; i++) {
      p = order[i]
      printf "%-10s %10.0f %10.0f %10.0f %10.1f\n", p, mem[p] / 1048576, last[p] / 1048576, shm[p] / 1048576, (cpu[p] - before) / 1e6
      before = cpu[p]
    }
    printf "ready in %d ms; memory.peak %.0f MiB (page cache included); /tmp used %.0f MiB\n", ready, peak / 1048576, tmp / 1024
  }' "$work/samples"

step "removed: nothing is left"
docker rm -f "$name" "$name-de" >/dev/null
# No container, and no volume left behind (it had none: a tmpfs goes with the container).
left=$(docker ps -aq --filter "name=^/$name(-de)?\$")
[ -z "$left" ] || fail "a container is still there: $left"
