#!/bin/sh
# Entrypoint of the API, backup, MCP and portal images (Dockerfile): secrets from files, then the command.
#
# For each setting below, <NAME>_FILE may name a file holding its value instead (a Docker or
# Compose secret, mounted under /run/secrets/): the file is read, its trailing newlines dropped,
# and <NAME> is set from it for the command only. Setting both (a value that is not blank) is refused. The instance secret
# key needs nothing here: the API reads CCMS_SECRET_KEY_FILE itself (.env.example).
set -eu

for name in \
  CCMS_DATABASE_URL \
  CCMS_API_TOKEN \
  CCMS_S3_ACCESS_KEY_ID \
  CCMS_S3_SECRET_ACCESS_KEY \
  CCMS_STYLE_REVIEW_API_KEY \
  CCMS_EMBEDDER_API_KEY \
  CCMS_MCP_API_TOKEN \
  CCMS_PORTAL_TOKEN \
  CCMS_AUDIT_SINK_SECRET \
  CCMS_OIDC_CLIENT_SECRET \
  CCMS_BACKUP_VERIFY_DATABASE_URL \
  CCMS_BACKUP_S3_ACCESS_KEY_ID \
  CCMS_BACKUP_S3_SECRET_ACCESS_KEY; do
  eval "file=\${${name}_FILE:-}"
  [ -n "$file" ] || continue
  eval "given=\${${name}:-}"
  if [ -n "$given" ]; then
    echo "openfolia: set ${name} or ${name}_FILE, not both." >&2
    exit 64
  fi
  if [ ! -r "$file" ]; then
    echo "openfolia: ${name}_FILE names ${file}, which cannot be read." >&2
    exit 64
  fi
  value=$(cat "$file")
  export "${name}=${value}"
  unset "${name}_FILE"
done

# The API starts without a content repository (health answers), but every content route fails
# until one is there: said once at start, where the operator looks.
if [ "$*" = 'node dist/main.js' ] && [ -n "${CCMS_CONTENT_DIR:-}" ] && [ ! -e "$CCMS_CONTENT_DIR" ]; then
  echo "openfolia: no content repository at ${CCMS_CONTENT_DIR} yet; content requests fail until one is there (deploy/README.md, \"Content repository\")." >&2
fi

exec "$@"
