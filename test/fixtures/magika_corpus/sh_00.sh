#!/usr/bin/env bash
# Install (or refresh) the harness pre-commit hook.
#
# Idempotent: running twice produces an identical hook file.
# Safe: refuses to overwrite a pre-existing hook unless --force.
#
# Per H-18: pre-commit hook runs `make validate-fast`. The hook is
# bypassable via `git commit --no-verify` for the rare case where the
# operator must commit despite a known violation (e.g., during the
# very first scaffolding when a check expects state that doesn't exist
# yet).

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
HOOK="$REPO_ROOT/.git/hooks/pre-commit"

MARKER="# debugduck-harness pre-commit hook v1"
HOOK_BODY="#!/usr/bin/env bash
$MARKER
#
# Runs make validate-fast before every commit. Bypass with
#   git commit --no-verify
# in the rare cases where you need to commit despite a violation.
#
# B23 (v1.2.1): falls back to \`python3 tools/run_validate.py --fast\`
# when make isn't on PATH (Windows, minimal Docker images).

set -e
if command -v make >/dev/null 2>&1; then
    exec make validate-fast
else
    exec python3 tools/run_validate.py --fast
fi
"

FORCE=0
if [[ "${1-}" == "--force" ]]; then
  FORCE=1
fi

if [[ -f "$HOOK" ]]; then
  if grep -q "$MARKER" "$HOOK"; then
    # It's our own hook — overwrite (idempotent).
    :
  elif [[ "$FORCE" -ne 1 ]]; then
    echo "ERROR: $HOOK exists and was not installed by this script." >&2
    echo "       Re-run with --force to overwrite." >&2
    exit 1
  fi
fi

mkdir -p "$REPO_ROOT/.git/hooks"
printf '%s' "$HOOK_BODY" > "$HOOK"
chmod +x "$HOOK"
echo "Installed harness pre-commit hook at $HOOK"
