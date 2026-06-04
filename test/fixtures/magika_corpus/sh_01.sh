#!/usr/bin/env bash
# Point 5 — set up GPG signing so sync_harness.py's verify-tag gate works.
#
# Run once per repo (or per machine with --global). Does:
#   1. Installs gnupg via brew if missing.
#   2. Generates a passphrase-less Ed25519 signing key (default details:
#      "ai-harness signer" <ai-harness@local>) IF no signing key exists.
#      Override via SIGNING_NAME / SIGNING_EMAIL env vars.
#   3. Configures git in --local scope (per-repo) by default. With --global,
#      writes to ~/.gitconfig instead. With --force, overwrites existing values
#      (default: REFUSE if user.signingkey or tag.gpgsign already set in the
#      target scope, to protect the user's existing signing config).
#        user.signingkey  = the new fingerprint
#        commit.gpgsign   = false (we sign tags, not commits)
#        tag.gpgsign      = true
#   4. Prints the public key so you can paste it into the standalone repo's
#      docs (so consumers can `gpg --import` it).
#
# B4 hardening (v1.1.0): default switched from --global to --local. Previously
# this script silently overwrote any existing personal signing key configured
# in ~/.gitconfig. Now --local is the safe default; --global is opt-in.
#
# Idempotent: re-running with an existing key reuses it; re-running with
# git already configured aborts unless --force.
#
# H-25:
#   Missing input    — aborts if brew/gpg can't be installed.
#   Malformed input  — gpg's own validation handles bad batch params.
#   Upstream failed  — set -e aborts on any step.

set -euo pipefail

SIGNING_NAME="${SIGNING_NAME:-ai-harness signer}"
SIGNING_EMAIL="${SIGNING_EMAIL:-ai-harness@local}"

# B4 — default scope is --local. Override with --global, --force overwrites
# existing values without prompting.
# B22 (v1.2.1) — --protect prompts GPG for a passphrase during key
# generation instead of using %no-protection. Recommended for human
# signers; the default (no --protect) keeps CI runners working without
# interactive input.
SCOPE="--local"
FORCE=0
PROTECT=0
for arg in "$@"; do
    case "${arg}" in
        --global)  SCOPE="--global" ;;
        --local)   SCOPE="--local" ;;
        --force)   FORCE=1 ;;
        --protect) PROTECT=1 ;;
        --help|-h)
            sed -n '1,30p' "$0"
            exit 0
            ;;
        *)
            echo "[ERROR] unknown flag: ${arg}" >&2
            echo "Usage: $0 [--local|--global] [--force] [--protect]" >&2
            exit 2
            ;;
    esac
done

# --local requires running from inside a git repo.
if [[ "${SCOPE}" == "--local" ]]; then
    if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
        echo "[ERROR] --local scope requires running from inside a git repo." >&2
        echo "        Either cd into the repo or pass --global to use ~/.gitconfig." >&2
        exit 2
    fi
fi

# 1. gnupg
if ! command -v gpg >/dev/null 2>&1; then
    if ! command -v brew >/dev/null 2>&1; then
        echo "[ERROR] neither gpg nor brew on PATH; install GPG manually" >&2
        exit 2
    fi
    echo "[INFO] installing gnupg via brew"
    brew install gnupg
fi

# 2. signing key
EXISTING="$(gpg --list-secret-keys --keyid-format=long --with-colons 2>/dev/null \
    | awk -F: '$1=="sec" {print $5; exit}')"

if [[ -n "${EXISTING}" ]]; then
    echo "[INFO] using existing signing key: ${EXISTING}"
    KEYID="${EXISTING}"
else
    echo "[INFO] generating new Ed25519 signing key for ${SIGNING_NAME} <${SIGNING_EMAIL}>"
    BATCH_FILE="$(mktemp -t gpg-batch.XXXXXX)"
    trap 'rm -f "${BATCH_FILE}"' EXIT
    if [[ "${PROTECT}" -eq 1 ]]; then
        # Human signer mode: GPG will prompt for a passphrase
        # interactively. Drop %no-protection AND --batch so pinentry
        # works.
        cat > "${BATCH_FILE}" <<EOF
Key-Type: eddsa
Key-Curve: ed25519
Key-Usage: sign
Name-Real: ${SIGNING_NAME}
Name-Email: ${SIGNING_EMAIL}
Expire-Date: 2y
%commit
EOF
        gpg --gen-key "${BATCH_FILE}"
    else
        # Default (CI / unattended) mode: passphrase-less so automated
        # tag signing works without prompting. Documented trade-off.
        cat > "${BATCH_FILE}" <<EOF
%no-protection
Key-Type: eddsa
Key-Curve: ed25519
Key-Usage: sign
Name-Real: ${SIGNING_NAME}
Name-Email: ${SIGNING_EMAIL}
Expire-Date: 2y
%commit
EOF
        gpg --batch --gen-key "${BATCH_FILE}"
    fi
    KEYID="$(gpg --list-secret-keys --keyid-format=long --with-colons \
        | awk -F: '$1=="sec" {print $5; exit}')"
    echo "[INFO] generated key: ${KEYID}"
fi

# 3. git config — write to SCOPE (default --local; --global opt-in via flag).
# Refuse to overwrite existing values unless --force.
_check_existing() {
    local key="$1"
    local existing
    existing="$(git config "${SCOPE}" --get "${key}" 2>/dev/null || true)"
    if [[ -n "${existing}" && "${FORCE}" -ne 1 ]]; then
        echo "[ERROR] ${SCOPE#--} git config already has ${key}=${existing}" >&2
        echo "        Re-run with --force to overwrite, or remove the existing value first." >&2
        exit 3
    fi
}

_check_existing user.signingkey
_check_existing tag.gpgsign

git config "${SCOPE}" user.signingkey "${KEYID}"
# Only set commit.gpgsign if it's currently set (preserve user's preference);
# otherwise leave it alone — we don't want to disable commit signing for users
# who deliberately opted in.
if [[ -n "$(git config "${SCOPE}" --get commit.gpgsign 2>/dev/null || true)" && "${FORCE}" -eq 1 ]]; then
    git config "${SCOPE}" commit.gpgsign false
fi
git config "${SCOPE}" tag.gpgsign true
echo "[INFO] git ${SCOPE#--} config updated: tag.gpgsign=true, signingkey=${KEYID}"

# 4. public key block (for inclusion in standalone repo docs)
echo
echo "=== PUBLIC KEY (paste into the standalone repo's docs/keys.md) ==="
echo
gpg --armor --export "${KEYID}"
echo
echo "=== END PUBLIC KEY ==="
echo
echo "Next: bash tools/sign_release.sh v1.0.2"
