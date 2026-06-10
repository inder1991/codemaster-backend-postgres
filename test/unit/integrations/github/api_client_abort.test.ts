/**
 * Unit tests for AbortSignal threading into GitHubApiClient (de-Temporal Phase 2, Task W4.1).
 *
 * Gate ① contract (the enforceable guarantee): NO new external call STARTS after `signal.aborted`;
 * an in-flight call RECEIVES the signal. Here that decomposes into:
 *   - an already-aborted `signal` rejects in `_request` BEFORE any `http.request` (recording stub sees
 *     zero calls) — no new call starts;
 *   - a 5xx-retry does NOT start a fresh `http.request` once the signal aborts between attempts;
 *   - a LIVE external signal is COMBINED with the transport timeout (`AbortSignal.any([external,
 *     transportAbortSignal(timeoutMs)])`) so an in-flight fetch receives BOTH — aborting the external
 *     signal aborts the combined one, and the transport timeout still fires independently.
 *
 * `signal` is OPTIONAL on every entry point; omitting it must be byte-identical to the pre-W4.1 client
 * (the existing api_client.test.ts suite, run unchanged, is the regression pin for that).
 *
 * These tests inject a recording HTTP transport (NOT the cassette) so the per-call count + the
 * forwarded `signal` arg are observable; the abort gate sits in `_request`, ABOVE the transport.
 */

import { describe, it, expect } from "vitest";

import { FakeClock } from "#platform/clock.js";
import {
  FetchGitHubHttpClient,
  GitHubApiClient,
  type GitHubHttpClient,
  type GitHubHttpRequestArgs,
  type GitHubHttpResponse,
  type TokenProvider,
} from "#backend/integrations/github/api_client.js";

const INSTALLATION_ID = 999;

const tokenProvider: TokenProvider = async () => {
  await Promise.resolve();
  return "tok";
};

/**
 * A recording HTTP transport: captures every `request` arg (including the forwarded `signal`) and
 * returns a canned response sequence. NOT the cassette — we need the raw call count + signal arg.
 */
class RecordingHttp implements GitHubHttpClient {
  public readonly calls: Array<GitHubHttpRequestArgs> = [];
  private readonly responses: Array<GitHubHttpResponse>;
  private i = 0;

  public constructor(responses: Array<GitHubHttpResponse>) {
    this.responses = responses;
  }

  public async request(args: GitHubHttpRequestArgs): Promise<GitHubHttpResponse> {
    this.calls.push(args);
    await Promise.resolve();
    const resp = this.responses[Math.min(this.i, this.responses.length - 1)]!;
    this.i += 1;
    return resp;
  }
}

function okResponse(body: unknown): GitHubHttpResponse {
  return { status: 200, headers: {}, body_text: JSON.stringify(body) };
}

const PR_BODY = { number: 42, state: "open", title: "t", head_sha: "abc", base_ref: "main" };

describe("GitHubApiClient — AbortSignal threading (W4.1, gate ①)", () => {
  it("rejects an already-aborted signal BEFORE any http.request (recording stub sees zero calls)", async () => {
    const http = new RecordingHttp([okResponse(PR_BODY)]);
    const client = new GitHubApiClient({ tokenProvider, http });
    const aborted = AbortSignal.abort(new Error("aborted-before-call"));

    await expect(
      client.getPullRequest({
        installationId: INSTALLATION_ID,
        owner: "acme",
        repo: "ex",
        prNumber: 42,
        signal: aborted,
      }),
    ).rejects.toThrow();

    // The gate fired in `_request` ABOVE the transport: NO new external call started.
    expect(http.calls.length).toBe(0);
  });

  it("forwards a LIVE signal into http.request (the in-flight call RECEIVES it)", async () => {
    const http = new RecordingHttp([okResponse(PR_BODY)]);
    const client = new GitHubApiClient({ tokenProvider, http });
    const controller = new AbortController();

    const pr = await client.getPullRequest({
      installationId: INSTALLATION_ID,
      owner: "acme",
      repo: "ex",
      prNumber: 42,
      signal: controller.signal,
    });

    expect(pr.number).toBe(42);
    expect(http.calls.length).toBe(1);
    // The same external signal reaches the transport so an in-flight fetch can observe an abort.
    expect(http.calls[0]!.signal).toBe(controller.signal);
  });

  it("when no signal is passed the transport receives undefined (byte-identical to pre-W4.1)", async () => {
    const http = new RecordingHttp([okResponse(PR_BODY)]);
    const client = new GitHubApiClient({ tokenProvider, http });

    await client.getPullRequest({
      installationId: INSTALLATION_ID,
      owner: "acme",
      repo: "ex",
      prNumber: 42,
    });

    expect(http.calls.length).toBe(1);
    expect(http.calls[0]!.signal).toBeUndefined();
  });

  it("does NOT start a fresh http.request retry once the signal aborts between 5xx attempts", async () => {
    // First attempt returns a 5xx; the second attempt would normally retry. We abort the signal as a
    // side-effect of the first call, so the loop's pre-call gate must stop a SECOND http.request.
    const controller = new AbortController();
    const http: GitHubHttpClient = {
      calls: 0,
      async request(_args: GitHubHttpRequestArgs): Promise<GitHubHttpResponse> {
        (this as { calls: number }).calls += 1;
        controller.abort(new Error("aborted-mid-retry"));
        await Promise.resolve();
        return { status: 503, headers: {}, body_text: "down" };
      },
    } as unknown as GitHubHttpClient & { calls: number };

    // FakeClock makes the backoff sleep instant + recorded; the abort gate at the top of the next loop
    // iteration must then suppress the SECOND http.request.
    const client = new GitHubApiClient({ tokenProvider, http, clock: new FakeClock() });

    await expect(
      client.getPullRequest({
        installationId: INSTALLATION_ID,
        owner: "acme",
        repo: "ex",
        prNumber: 42,
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    // Exactly ONE http.request happened: the retry was suppressed by the post-abort gate.
    expect((http as unknown as { calls: number }).calls).toBe(1);
  });
});

describe("FetchGitHubHttpClient — AbortSignal.any combine (W4.1)", () => {
  it("aborting the external signal aborts the combined signal handed to fetch", async () => {
    const client = new FetchGitHubHttpClient({ timeoutSeconds: 30 });
    const controller = new AbortController();
    let observed: AbortSignal | undefined;

    // Stub global fetch: capture the combined signal, never resolve until it aborts.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      observed = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        observed?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof globalThis.fetch;

    try {
      const p = client.request({
        method: "GET",
        url: "https://api.github.com/x",
        headers: {},
        signal: controller.signal,
      });
      // The combined signal is distinct from BOTH inputs (it's the AbortSignal.any product) but firing
      // the external one must propagate to it.
      expect(observed).toBeDefined();
      expect(observed).not.toBe(controller.signal);
      expect(observed!.aborted).toBe(false);
      controller.abort(new Error("external-abort"));
      expect(observed!.aborted).toBe(true);
      await expect(p).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("the transport timeout still fires independently when no external signal is passed", async () => {
    // A TINY real transport timeout — the timer is the production `transportAbortSignal` seam, so a
    // no-external request still aborts on timeout (byte-identical to pre-W4.1 transport behaviour).
    // Sub-second timeout keeps the test fast + deterministic; `setTimeout` is permitted in *.test.ts.
    const client = new FetchGitHubHttpClient({ timeoutSeconds: 0.05 });
    let observed: AbortSignal | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      observed = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        observed?.addEventListener(
          "abort",
          () => reject(new DOMException("timed out", "TimeoutError")),
          { once: true },
        );
      });
    }) as typeof globalThis.fetch;

    try {
      const p = client.request({ method: "GET", url: "https://api.github.com/x", headers: {} });
      // Even without an external signal, fetch receives a (timeout-only) signal — the transport timer
      // is preserved.
      await expect(p).rejects.toThrow();
      expect(observed).toBeDefined();
      expect(observed!.aborted).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
