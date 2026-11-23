#!/usr/bin/env bash
# Usage: GH_PROJECT_OWNER=<org or user> GH_PROJECT_NUMBER=<n> \
#          scripts/set-project-status.sh "<Status>" <issue> [<issue> ...]
# Sets each issue's Status on a GitHub project board (adding it to the project first if it
# isn't on it yet). The repository comes from `gh repo view`; the field (GH_PROJECT_FIELD,
# default "Status") and its option are looked up by name, so nothing is hard-coded, and their
# ids are cached between calls (scripts/set-project-status.mjs), so a status change is one
# GitHub call; a call that hits GitHub's secondary rate limit waits and tries again.
# Needs `gh` with the `project` scope (`gh auth refresh -s project`) and node.
set -euo pipefail
exec node "$(dirname "$0")/set-project-status.mjs" "$@"
