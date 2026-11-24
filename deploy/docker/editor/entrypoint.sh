#!/bin/sh
# Entrypoint of the editor image (Dockerfile, target `editor`): writes the parts of nginx.conf
# that come from the settings, then runs the command (nginx). Settings (.env.example,
# "Container deployment"):
#   CCMS_EDITOR_PORT            port to listen on (default 8080)
#   CCMS_EDITOR_API_URL         the API's address, http(s)://host[:port] (default http://api:3000)
#   CCMS_EDITOR_MCP_URL         optional: the MCP server's address, http(s)://host[:port], proxied
#                               at /mcp (unset: /mcp answers 404)
#   CCMS_EDITOR_HOSTS           the hosts the editor answers for, host[:port],... (any when unset;
#                               required with a token); any other Host gets 421
#   CCMS_EDITOR_API_TOKEN       optional: a token the proxy adds to every same-origin /api request
#   CCMS_EDITOR_API_TOKEN_FILE  optional: a file holding it instead (a Docker secret)
set -eu

fail() {
  echo "openfolia-editor: $*" >&2
  exit 64
}

port=${CCMS_EDITOR_PORT:-8080}
api=${CCMS_EDITOR_API_URL:-http://api:3000}
mcp=${CCMS_EDITOR_MCP_URL:-}
hosts=${CCMS_EDITOR_HOSTS:-}
token=${CCMS_EDITOR_API_TOKEN:-}
if [ -n "${CCMS_EDITOR_API_TOKEN_FILE:-}" ]; then
  [ -z "$token" ] || fail "set CCMS_EDITOR_API_TOKEN or CCMS_EDITOR_API_TOKEN_FILE, not both."
  [ -r "$CCMS_EDITOR_API_TOKEN_FILE" ] || fail "CCMS_EDITOR_API_TOKEN_FILE names $CCMS_EDITOR_API_TOKEN_FILE, which cannot be read."
  token=$(cat "$CCMS_EDITOR_API_TOKEN_FILE")
fi

# Each value goes into nginx's configuration, so each is checked against a strict shape first:
# nothing else (a quote, a semicolon, a space) can reach the file.
case "$port" in
  '' | *[!0-9]*) fail "CCMS_EDITOR_PORT must be a port number, not '$port'." ;;
esac
[ "$port" -ge 1 ] && [ "$port" -le 65535 ] || fail "CCMS_EDITOR_PORT must be 1-65535, not $port."
api=${api%/}
case "$api" in
  *[!A-Za-z0-9.:/-]*) fail "CCMS_EDITOR_API_URL may hold only A-Z a-z 0-9 . : / -." ;;
esac
printf '%s' "$api" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' ||
  fail "CCMS_EDITOR_API_URL must be http(s)://host[:port] without a path, not '$api'."
mcp=${mcp%/}
if [ -n "$mcp" ]; then
  case "$mcp" in
    *[!A-Za-z0-9.:/-]*) fail "CCMS_EDITOR_MCP_URL may hold only A-Z a-z 0-9 . : / -." ;;
  esac
  printf '%s' "$mcp" | grep -Eq '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?$' ||
    fail "CCMS_EDITOR_MCP_URL must be http(s)://host[:port] without a path, not '$mcp'."
fi
if [ -n "$token" ]; then
  case "$token" in
    *[!A-Za-z0-9._~+/=-]*) fail "CCMS_EDITOR_API_TOKEN may hold only A-Z a-z 0-9 . _ ~ + / = -." ;;
  esac
  [ "${#token}" -ge 32 ] && [ "${#token}" -le 512 ] ||
    fail "CCMS_EDITOR_API_TOKEN must be 32-512 characters long."
  # A page on another host name that resolves to this server (DNS rebinding) sends its own name
  # as both Host and Origin, which the origin check cannot tell from the editor's own: the
  # token is added only for the hosts named here.
  [ -n "$hosts" ] || fail "CCMS_EDITOR_API_TOKEN needs CCMS_EDITOR_HOSTS (the editor's own host names)."
fi

# CCMS_EDITOR_HOSTS: host names (and an optional port, which is not compared: nginx matches the
# name), each checked before it reaches the configuration.
names=''
old_ifs=$IFS
IFS=','
for entry in $hosts; do
  entry=$(printf '%s' "$entry" | tr -d ' ')
  [ -n "$entry" ] || continue
  case "$entry" in
    *[!A-Za-z0-9.:-]*) fail "CCMS_EDITOR_HOSTS: '$entry' is no host[:port]." ;;
  esac
  printf '%s' "$entry" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$' ||
    fail "CCMS_EDITOR_HOSTS: '$entry' is no host[:port]."
  names="$names ${entry%%:*}"
done
IFS=$old_ifs
[ -z "$hosts" ] || [ -n "$names" ] || fail "CCMS_EDITOR_HOSTS names no host."

mkdir -p /tmp/openfolia
umask 077
listen() {
  printf 'listen %s%s;\n' "$port" "$1"
  # IPv6 too, where the container has it (nginx refuses to start on [::] otherwise).
  if [ -f /proc/net/if_inet6 ]; then
    printf 'listen [::]:%s%s;\n' "$port" "$1"
  fi
}
if [ -n "$names" ]; then
  {
    listen ''
    printf 'server_name%s;\n' "$names"
  } >/tmp/openfolia/listen.conf
  {
    printf 'server {\n'
    listen ' default_server'
    printf 'server_name _;\n'
    printf 'location = /healthz { access_log off; default_type text/plain; return 200 "ok\\n"; }\n'
    printf 'location / { default_type text/plain; return 421 "This server does not answer for that host.\\n"; }\n'
    printf '}\n'
  } >/tmp/openfolia/default-server.conf
else
  {
    listen ' default_server'
    printf 'server_name _;\n'
  } >/tmp/openfolia/listen.conf
  : >/tmp/openfolia/default-server.conf
fi
# The API's name is looked up again while nginx runs (every 10 s), through the container's own
# resolver, so a recreated API container with a new address is found without restarting this
# one. An API at an IPv4 address (the sandbox image's, in the same container) needs no lookup,
# and no resolver: the sandbox may run without any network.
by_name() {
  ! printf '%s' "$1" | grep -Eq '^https?://[0-9]{1,3}(\.[0-9]{1,3}){3}(:[0-9]{1,5})?$'
}
resolver_line=''
if by_name "$api" || { [ -n "$mcp" ] && by_name "$mcp"; }; then
  resolver=$(awk '$1 == "nameserver" { print $2; exit }' /etc/resolv.conf 2>/dev/null || true)
  case "$resolver" in
    '' | *[!0-9A-Fa-f.:]*) fail "no usable nameserver in /etc/resolv.conf to look the API's or the MCP server's address up with." ;;
    *:*) resolver="[$resolver]" ;;
  esac
  resolver_line="resolver $resolver valid=10s;"
fi
{
  [ -z "$resolver_line" ] || printf '%s\n' "$resolver_line"
  printf 'set $openfolia_api %s;\n' "$api"
  printf 'proxy_pass $openfolia_api$openfolia_api_uri;\n'
  if [ -n "$token" ]; then
    printf 'if ($openfolia_not_same_origin) { return 418; }\n'
    printf 'proxy_set_header Authorization "Bearer %s";\n' "$token"
  fi
} >/tmp/openfolia/api.conf
# The stable addresses (/d/, #450): proxied as they are, never with the token, so a reader who
# follows a printed QR code reads only what the API serves without one (openfolia.yaml
# delivery.access).
{
  [ -z "$resolver_line" ] || printf '%s\n' "$resolver_line"
  printf 'set $openfolia_api %s;\n' "$api"
  printf 'proxy_pass $openfolia_api$request_uri;\n'
} >/tmp/openfolia/addresses.conf
# /mcp (#860): the MCP server's own endpoint, proxied as it is, never with the token: the server
# checks the caller's bearer token, Origin and rate itself. Looked up like the API's, so the
# editor starts without the MCP service, and /mcp answers 404 while its name resolves to nothing
# (@mcp_unavailable in nginx.conf).
if [ -n "$mcp" ]; then
  {
    [ -z "$resolver_line" ] || printf '%s\n' "$resolver_line"
    printf 'set $openfolia_mcp %s;\n' "$mcp"
    printf 'proxy_pass $openfolia_mcp$request_uri;\n'
  } >/tmp/openfolia/mcp.conf
else
  printf 'return 404;\n' >/tmp/openfolia/mcp.conf
fi
if [ -n "$token" ]; then
  echo "openfolia-editor: /api -> $api, adding the token to same-origin requests for${names}: anyone who reaches this editor acts with it (deploy/README.md, \"Signing in\")." >&2
else
  echo "openfolia-editor: /api -> $api${names:+, for$names}" >&2
fi
[ -z "$mcp" ] || echo "openfolia-editor: /mcp -> $mcp (404 while it is not running)" >&2
unset CCMS_EDITOR_API_TOKEN CCMS_EDITOR_API_TOKEN_FILE token

exec "$@"
