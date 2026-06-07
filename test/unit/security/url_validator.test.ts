// Unit corpus for the SSRF URL validator (1:1 port of url_validator.py). No DB; injects a stub DNS resolver.
// Covers: scheme/malformed, https-required, userinfo, hostname-allowlist, EVERY private/reserved IPv4 + IPv6
// range, the IPv4-mapped-IPv6 unwrap, the multi-address DNS-rebind defense, and resolution failures.

import { describe, expect, it } from "vitest";

import {
  DnsResolutionError,
  HostnameNotInAllowlistError,
  HttpsRequiredError,
  MalformedUrlError,
  PrivateCidrError,
  UserInfoNotAllowedError,
  validateExternalUrl,
} from "#backend/security/url_validator.js";

const PUBLIC_V4 = "93.184.216.34"; // example.com
const resolveTo =
  (...addrs: Array<string>) =>
  async () =>
    addrs;

describe("validateExternalUrl — happy paths", () => {
  it("accepts an https URL resolving to a public IPv4", async () => {
    const v = await validateExternalUrl("https://confluence.example.com/wiki", { resolver: resolveTo(PUBLIC_V4) });
    expect(v).toEqual({
      scheme: "https",
      hostname: "confluence.example.com",
      port: 443,
      path: "/wiki",
      resolvedIp: PUBLIC_V4,
    });
  });

  it("accepts a public IPv6 address", async () => {
    const v = await validateExternalUrl("https://host.example.com", { resolver: resolveTo("2001:4860:4860::8888") });
    expect(v.resolvedIp).toBe("2001:4860:4860::8888");
  });

  it("accepts http only when allowHttp=true", async () => {
    const v = await validateExternalUrl("http://dev.local", { allowHttp: true, resolver: resolveTo(PUBLIC_V4) });
    expect(v.scheme).toBe("http");
    expect(v.port).toBe(80);
  });

  it("honors a hostname allowlist (member passes)", async () => {
    const v = await validateExternalUrl("https://atlassian.example.com", {
      hostnameAllowlist: ["atlassian.example.com"],
      resolver: resolveTo(PUBLIC_V4),
    });
    expect(v.hostname).toBe("atlassian.example.com");
  });
});

describe("validateExternalUrl — scheme / syntax rejections", () => {
  it("rejects empty / malformed / unsupported-scheme URLs", async () => {
    await expect(validateExternalUrl("", { resolver: resolveTo(PUBLIC_V4) })).rejects.toBeInstanceOf(MalformedUrlError);
    await expect(validateExternalUrl("not-a-url", { resolver: resolveTo(PUBLIC_V4) })).rejects.toBeInstanceOf(
      MalformedUrlError,
    );
    await expect(validateExternalUrl("ftp://host", { resolver: resolveTo(PUBLIC_V4) })).rejects.toBeInstanceOf(
      MalformedUrlError,
    );
  });

  it("rejects http when allowHttp=false (default)", async () => {
    await expect(validateExternalUrl("http://host.example.com", { resolver: resolveTo(PUBLIC_V4) })).rejects.toBeInstanceOf(
      HttpsRequiredError,
    );
  });

  it("rejects userinfo (user:pass@ and user@)", async () => {
    await expect(validateExternalUrl("https://u:p@host.example.com", { resolver: resolveTo(PUBLIC_V4) })).rejects.toBeInstanceOf(
      UserInfoNotAllowedError,
    );
    await expect(validateExternalUrl("https://u@host.example.com", { resolver: resolveTo(PUBLIC_V4) })).rejects.toBeInstanceOf(
      UserInfoNotAllowedError,
    );
  });

  it("rejects a hostname not in the allowlist", async () => {
    await expect(
      validateExternalUrl("https://evil.example.com", {
        hostnameAllowlist: ["good.example.com"],
        resolver: resolveTo(PUBLIC_V4),
      }),
    ).rejects.toBeInstanceOf(HostnameNotInAllowlistError);
  });
});

describe("validateExternalUrl — SSRF private/reserved address rejection", () => {
  // One representative address per ported IPv4 deny-range (incl. the cloud-metadata 169.254.169.254).
  it.each([
    "0.0.0.0",
    "10.0.0.5",
    "127.0.0.1",
    "169.254.169.254", // cloud metadata
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
  ])("rejects IPv4 private/reserved %s", async (ip) => {
    await expect(validateExternalUrl("https://internal.example.com", { resolver: resolveTo(ip) })).rejects.toBeInstanceOf(
      PrivateCidrError,
    );
  });

  it.each(["::1", "::", "fc00::1", "fd00::1", "fe80::1", "ff00::1", "64:ff9b::1"])(
    "rejects IPv6 private/reserved %s",
    async (ip) => {
      await expect(validateExternalUrl("https://internal.example.com", { resolver: resolveTo(ip) })).rejects.toBeInstanceOf(
        PrivateCidrError,
      );
    },
  );

  it("rejects an IPv4-mapped-IPv6 address pointing at a private IPv4 (::ffff:10.x unwrap)", async () => {
    await expect(
      validateExternalUrl("https://internal.example.com", { resolver: resolveTo("::ffff:169.254.169.254") }),
    ).rejects.toBeInstanceOf(PrivateCidrError);
  });

  it("rejects DNS-rebind: one public + one private address in the same answer", async () => {
    await expect(
      validateExternalUrl("https://rebind.example.com", { resolver: resolveTo(PUBLIC_V4, "10.0.0.5") }),
    ).rejects.toBeInstanceOf(PrivateCidrError);
  });
});

describe("validateExternalUrl — DNS resolution failures", () => {
  it("maps a resolver throw → DnsResolutionError", async () => {
    const boom: () => Promise<Array<string>> = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(validateExternalUrl("https://nope.example.com", { resolver: boom })).rejects.toBeInstanceOf(
      DnsResolutionError,
    );
  });

  it("maps an empty answer → DnsResolutionError", async () => {
    await expect(validateExternalUrl("https://empty.example.com", { resolver: resolveTo() })).rejects.toBeInstanceOf(
      DnsResolutionError,
    );
  });
});
