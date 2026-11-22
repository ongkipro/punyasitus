#!/usr/bin/env bash
# Wrapper for heavy repo jobs (build, workerd integration, browser e2e).
# Uses dotfiles `heavy-run` when installed on a shared dev host, with a
# per-worktree lock name so disjoint worktrees never block each other's build
# dirs while still respecting the host-wide AI_HEAVY_SLOTS pool.
# Degrades cleanly to direct execution in CI or containers without `heavy-run`.
set -euo pipefail

LABEL="punyasitus-job"
if [ "${1:-}" = "--label" ] && [ -n "${2:-}" ]; then
  LABEL="$2"
  shift 2
fi
if [ "${1:-}" = "--" ]; then
  shift
fi

if [ "$#" -eq 0 ]; then
  echo "Usage: scripts/dev/heavy.sh [--label NAME] -- <command...>" >&2
  exit 2
fi

if [ -z "${CI:-}" ] && command -v heavy-run >/dev/null 2>&1; then
  WORKTREE_SLUG="$(basename "$PWD" | tr -cd 'A-Za-z0-9._-')"
  exec heavy-run --lock "punyasitus-${WORKTREE_SLUG:-main}-env" --label "punyasitus-${LABEL}" -- "$@"
fi

exec "$@"
