#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
playground_dir=$(dirname "$script_dir")
repository_dir=$(dirname "$playground_dir")
fixture_key="$playground_dir/.cordierite/key.pem"

if [ "${1-}" = "--" ]; then
  shift
fi

# Git does not preserve 0600, while the daemon refuses group- or world-readable host keys.
chmod 600 "$fixture_key"

if [ ! -f "$repository_dir/packages/cordierite/dist/bin.js" ]; then
  pnpm --dir "$repository_dir" --filter cordierite build
fi

exec node "$repository_dir/packages/cordierite/bin.js" \
  --state-dir "$playground_dir/.cordierite" "$@"
