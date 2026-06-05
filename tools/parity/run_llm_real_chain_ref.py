"""Tier-B parity ref process for the LLM credentials→SDK→cache chain (adversarial dual-run).

Long-lived JSONL request/response loop, one frozen-Python interpreter, exercising THREE seams of the
frozen spine against the SAME inputs the TS port is driven with so the verifier can byte-compare:

  1. {"op":"read_settings","dsn":..., "role":...}
       Drive the FROZEN PostgresLlmProviderSettingsRepo against the SAME disposable PG row the TS test
       seeded. Returns the decrypted settings (provider/model_id/region/api_key/enabled) +
       last_rotated_at fingerprint so the TS side can prove its Kysely SELECTs + decrypt match.
       Vault boundary is a deterministic base64 double ("b64:<base64(plaintext)>") injected into the
       repo's `vault=` seam — identical codec on both sides, so the SAME ciphertext stored in PG
       decrypts to the SAME plaintext regardless of language. The PG round-trip is REAL.

  2. {"op":"sdk_create_kwargs", "model":..., "messages":..., "max_tokens":..., "tools":..., "role":...}
       Drive the FROZEN AnthropicBedrockSdkAdapter.create_message with a recorded-response SDK double
       (the unreachable-Bedrock cassette stand-in). The double captures the EXACT kwargs the adapter
       passes to `messages.create(**kwargs)` — system hoisted, tools, model, max_tokens — so the TS
       adapter's request shape can be byte-compared.

  3. {"op":"map_exception","kind":...}
       Drive the FROZEN _map_anthropic_exception with a constructed anthropic SDK error of `kind` and
       return the mapped Llm* subclass name, so the TS mapAnthropicException can be proven symmetric.

Runs under the frozen submodule venv (anthropic 0.97 + sqlalchemy + asyncpg present) with cwd at
vendor/codemaster-py so `import codemaster` resolves the source-of-truth. NEVER touches the in-cluster
DB — the DSN is passed in by the TS test and points only at the disposable PG.
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
from typing import Any

from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from codemaster.api.admin.postgres_llm_provider_settings_repo import (
    PostgresLlmProviderSettingsRepo,
)
from codemaster.integrations.llm.credentials_provider import (
    LlmCredentials,
    LlmCredentialsProvider,
)
from codemaster.integrations.llm.sdk_adapter import (
    AnthropicBedrockSdkAdapter,
    _map_anthropic_exception,
)

_B64_PREFIX = "b64:"


class _B64Vault:
    """Deterministic, stateless Vault-Transit double: ciphertext = "b64:<base64(plaintext)>".

    The SAME codec is used on the TS side, so a ciphertext seeded into PG by the TS test decrypts to
    the identical plaintext here. No in-memory fixture map — purely a function of the ciphertext, which
    is what makes the cross-language dual-run reproducible.
    """

    def encrypt(self, *, plaintext: bytes, key_name: str) -> str:  # noqa: ARG002
        return _B64_PREFIX + base64.b64encode(plaintext).decode("ascii")

    def decrypt(self, *, ciphertext: str, key_name: str) -> bytes:  # noqa: ARG002
        if not ciphertext.startswith(_B64_PREFIX):
            raise ValueError(f"not a b64-double ciphertext: {ciphertext!r}")
        return base64.b64decode(ciphertext[len(_B64_PREFIX) :])


class _RecordedSdk:
    """Recorded-response SDK double capturing the kwargs create_message builds (the cassette stand-in)."""

    def __init__(self) -> None:
        self.captured: dict[str, Any] | None = None

        class _Messages:
            def __init__(self, outer: "_RecordedSdk") -> None:
                self._outer = outer

            async def create(self, **kwargs: Any) -> Any:
                self._outer.captured = kwargs

                class _Resp:
                    def model_dump(self) -> dict[str, Any]:
                        return {"content": [{"type": "text", "text": "recorded"}]}

                return _Resp()

        self.messages = _Messages(self)


class _StaticProvider:
    """Returns a fixed LlmCredentials triple (the cred-resolution is exercised separately by op 1)."""

    def __init__(self, creds: LlmCredentials) -> None:
        self._creds = creds

    async def current(self, role: str) -> LlmCredentials:  # noqa: ARG002
        return self._creds


async def _read_settings(dsn: str, role: str) -> dict[str, Any]:
    # asyncpg DSNs use the postgresql+asyncpg driver under SQLAlchemy async.
    async_dsn = dsn.replace("postgresql://", "postgresql+asyncpg://", 1)
    engine = create_async_engine(async_dsn)
    try:
        factory = async_sessionmaker(engine, expire_on_commit=False)
        repo = PostgresLlmProviderSettingsRepo(session_factory=factory, vault=_B64Vault())
        settings = await repo.read_decrypted_settings(role)  # type: ignore[arg-type]
        last_rotated = await repo.read_last_rotated_at(scope="platform", role=role)  # type: ignore[arg-type]
        fp_rows = await repo.read_rotation_fingerprint()
    finally:
        await engine.dispose()

    if settings is None:
        return {
            "settings": None,
            "last_rotated_at": last_rotated.isoformat() if last_rotated else None,
            "fingerprint": [[r, ts.isoformat()] for (r, ts) in fp_rows],
        }
    return {
        "settings": {
            "provider": settings.provider,
            "model_id": settings.model_id,
            "region": settings.region,
            "api_key": settings.api_key,
            "enabled": settings.enabled,
        },
        "last_rotated_at": last_rotated.isoformat() if last_rotated else None,
        "fingerprint": [[r, ts.isoformat()] for (r, ts) in fp_rows],
    }


async def _sdk_create_kwargs(req: dict[str, Any]) -> dict[str, Any]:
    creds = LlmCredentials(api_key="sk-ref", region="us-east-1", model_id=req["model"])
    adapter = AnthropicBedrockSdkAdapter(provider=_StaticProvider(creds))
    recorded = _RecordedSdk()
    # Replace _sdk_for so the real AsyncAnthropicBedrock is never constructed (cassette stand-in).
    adapter._sdk_for = lambda _creds: recorded  # type: ignore[assignment,method-assign]
    await adapter.create_message(
        model=req["model"],
        messages=req["messages"],
        max_tokens=req["max_tokens"],
        tools=req.get("tools"),
        role=req["role"],
    )
    return {"create_kwargs": recorded.captured}


def _map_exception(kind: str) -> dict[str, Any]:
    import anthropic

    headers = {}
    body = {"type": "error"}
    if kind == "timeout":
        exc: BaseException = anthropic.APITimeoutError(request=_dummy_request())
    elif kind == "rate_limit":
        exc = anthropic.RateLimitError(message="429", response=_dummy_response(429), body=body)
    elif kind == "auth":
        exc = anthropic.AuthenticationError(message="401", response=_dummy_response(401), body=body)
    elif kind == "permission":
        exc = anthropic.PermissionDeniedError(message="403", response=_dummy_response(403), body=body)
    elif kind == "connection":
        exc = anthropic.APIConnectionError(message="conn reset", request=_dummy_request())
    elif kind == "server_5xx":
        exc = anthropic.APIStatusError(message="503", response=_dummy_response(503), body=body)
    elif kind == "client_4xx":
        exc = anthropic.APIStatusError(message="400", response=_dummy_response(400), body=body)
    else:
        raise ValueError(f"unknown kind {kind!r}")
    mapped = _map_anthropic_exception(exc)
    return {"mapped": type(mapped).__name__}


def _dummy_request() -> Any:
    import httpx

    return httpx.Request("POST", "https://bedrock.example/invoke")


def _dummy_response(status: int) -> Any:
    import httpx

    return httpx.Response(status_code=status, request=_dummy_request())


def _handle(req: dict[str, Any]) -> dict[str, Any]:
    op = req["op"]
    if op == "read_settings":
        return asyncio.run(_read_settings(req["dsn"], req["role"]))
    if op == "sdk_create_kwargs":
        return asyncio.run(_sdk_create_kwargs(req))
    if op == "map_exception":
        return _map_exception(req["kind"])
    raise ValueError(f"unknown op {op!r}")


def main() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        rid = req.get("id")
        try:
            out = _handle(req)
            sys.stdout.write(json.dumps({"id": rid, "ok": True, "out": out}) + "\n")
        except Exception as exc:  # noqa: BLE001 — surface any ref failure to the TS side
            sys.stdout.write(
                json.dumps({"id": rid, "ok": False, "err": f"{type(exc).__name__}: {exc}"}) + "\n"
            )
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
