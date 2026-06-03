"""Stateless cross-impl crypto parity driver for the frozen Python source-of-truth.

Dedicated to the ADR-0033 local AES-256-GCM field-encryption seam (do NOT fold into
run_python_ref.py — that runner canonicalizes pure-function results; this one drives the
REAL ``codemaster.security`` crypto stateful APIs and must speak base64-binary on the
wire). One interpreter, many requests, read JSONL on stdin and emit one JSON line per
request on stdout. Runs under the frozen submodule's venv with cwd at vendor/codemaster-py
so ``import codemaster`` resolves the source-of-truth.

The security guarantee under proof: ciphertext written by EITHER impl (TS or Python)
decrypts in the OTHER under the same key + AAD. Because the AES-GCM nonce is random,
ciphertexts are NOT byte-comparable — parity is proven by CROSS-DECRYPTION (encrypt on
one side, decrypt on the other, assert the plaintext matches). This driver is the Python
half of that proof: it both produces envelopes for the TS side to decrypt and decrypts
envelopes the TS side produced.

All binary values cross the wire as base64 for safety; ``aad`` is base64 or null.

Two request kinds:

    {"id": "...", "op": "encrypt", "keys": {"1": "<b64key>"}, "version": "1",
     "plaintext": "<b64>", "aad": "<b64>"|null}
        Builds a fresh KeyRegistry holding ``keys`` with ``version`` current, then calls
        ``encrypt(plaintext, registry=..., aad=...)``.
        Response: {"id": "...", "ok": true, "ct": "<envelope string>"}

    {"id": "...", "op": "decrypt", "keys": {"1": "<b64key>", ...},
     "ciphertext": "<envelope>", "aad": "<b64>"|null}
        Builds a fresh KeyRegistry holding the full ``keys`` map (the envelope itself
        carries the version, so ``current_version`` is set to any present version — the
        decrypt path resolves the key by the envelope's version via ``registry.get``).
        This lets a test simulate "wrong version not loaded" by omitting a version from
        ``keys``. Calls ``decrypt(ciphertext, registry=..., aad=...)``.
        Response: {"id": "...", "ok": true, "pt": "<b64 plaintext>"}
              OR  {"id": "...", "ok": false, "err": "<LocalKeyEncryptionError msg>"}.

On any exception (LocalKeyEncryptionError, malformed request, etc.) the driver emits
{"id": "...", "ok": false, "err": "..."} and keeps running, so one bad request never
tears down the long-lived process. For encrypt the error also surfaces as ok:false.
"""

from __future__ import annotations

import base64
import json
import sys
from typing import Any

from codemaster.security.key_registry import KeyRegistry, KeySet
from codemaster.security.local_key_field_encryption import decrypt as dec
from codemaster.security.local_key_field_encryption import encrypt as enc


def _build_registry(keys_map: dict[str, str], current_version: str) -> KeyRegistry:
    """Construct a fresh KeyRegistry from the wire's base64 key map.

    ``current_version`` must be a key present in ``keys_map`` (KeySet validates this).
    For decrypt requests the per-version resolution happens via ``registry.get`` keyed
    on the envelope's embedded version, so ``current_version`` only needs to name SOME
    loaded version — it does not have to be the version the envelope was written under.
    """
    keys = {version: base64.b64decode(b64) for version, b64 in keys_map.items()}
    registry = KeyRegistry()
    registry.set(KeySet(current_version=current_version, keys=keys))
    return registry


def _b64decode_opt(value: str | None) -> bytes | None:
    """Decode an optional base64 wire field to bytes, preserving None (the AAD-absent case)."""
    if value is None:
        return None
    return base64.b64decode(value)


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    """Dispatch one request to the frozen crypto primitive and return its encoded result."""
    op = req["op"]
    keys_map: dict[str, str] = req["keys"]
    aad = _b64decode_opt(req.get("aad"))

    if op == "encrypt":
        version: str = req["version"]
        registry = _build_registry(keys_map, current_version=version)
        plaintext = base64.b64decode(req["plaintext"])
        ct = enc(plaintext, registry=registry, aad=aad)
        return {"id": req["id"], "ok": True, "ct": ct}

    if op == "decrypt":
        # The envelope carries the version; current_version only needs to name a loaded
        # version so KeySet validates. Pick any key present in the map.
        current_version = next(iter(keys_map)) if keys_map else "1"
        registry = _build_registry(keys_map, current_version=current_version)
        plaintext = dec(req["ciphertext"], registry=registry, aad=aad)
        return {"id": req["id"], "ok": True, "pt": base64.b64encode(plaintext).decode("ascii")}

    raise ValueError(f"unknown op: {op!r}")


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        try:
            resp = _handle(req)
        except Exception as exc:  # report, never crash the long-lived process
            resp = {"id": req.get("id"), "ok": False, "err": f"{type(exc).__name__}: {exc}"}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
