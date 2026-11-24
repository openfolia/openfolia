#!/bin/bash
# The sandbox image's health check (Dockerfile, target `sandbox`): healthy once the API is ready
# (its database and blob folder answer) and the editor's server answers on its port. Plain bash
# over /dev/tcp, so a check every few seconds starts no Node process.
set -u

# 0 when `GET <path>` on 127.0.0.1:<port> answers 200 within 2 seconds.
answers() {
  local status
  { exec 3<>"/dev/tcp/127.0.0.1/$1"; } 2>/dev/null || return 1
  printf 'GET %s HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n' "$2" >&3
  IFS= read -r -t 2 status <&3 || status=''
  exec 3<&- 3>&-
  [[ $status =~ ^HTTP/1\.[01]\ 200 ]]
}

answers 3000 /health/ready && answers "${CCMS_EDITOR_PORT:-8080}" /healthz
