#!/bin/sh
set -eu

DATA_DIR="${DATA_DIR:-/app/data}"
mkdir -p "$DATA_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DATA_DIR" 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi

exec "$@"
