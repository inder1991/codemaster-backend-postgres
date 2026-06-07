// Unit tests for the shared two-person-approval predicates — 1:1 parity with
// vendor/codemaster-py/codemaster/api/admin/_two_person_approval.py. Pure functions; no I/O.

import { describe, expect, it } from "vitest";

import {
  ExpiredApprovalError,
  SelfApprovalError,
  StalePendingStateError,
  TwoPersonApprovalError,
  checkNotExpired,
  checkPendingState,
  checkSelfApproval,
} from "#backend/api/admin/two_person_approval.js";

const NOW = new Date("2026-06-07T12:00:00.000Z");
const U1 = "11111111-1111-1111-1111-111111111111";
const U2 = "22222222-2222-2222-2222-222222222222";

describe("two_person_approval predicates (parity with _two_person_approval.py)", () => {
  it("checkSelfApproval: throws SelfApprovalError iff requester === approver", () => {
    expect(() => checkSelfApproval({ requesterUserId: U1, approverUserId: U1 })).toThrow(
      SelfApprovalError,
    );
    // the error carries the offending user id + is a TwoPersonApprovalError subclass
    try {
      checkSelfApproval({ requesterUserId: U1, approverUserId: U1 });
    } catch (e) {
      expect(e).toBeInstanceOf(TwoPersonApprovalError);
      expect((e as SelfApprovalError).userId).toBe(U1);
    }
    expect(() => checkSelfApproval({ requesterUserId: U1, approverUserId: U2 })).not.toThrow();
  });

  it("checkNotExpired: null never expires; expires_at <= now is expired (boundary inclusive)", () => {
    expect(() => checkNotExpired({ expiresAt: null, now: NOW })).not.toThrow();
    const future = new Date(NOW.getTime() + 1000);
    expect(() => checkNotExpired({ expiresAt: future, now: NOW })).not.toThrow();
    // exact-equality boundary is treated as expired
    expect(() => checkNotExpired({ expiresAt: new Date(NOW.getTime()), now: NOW })).toThrow(
      ExpiredApprovalError,
    );
    const past = new Date(NOW.getTime() - 1);
    try {
      checkNotExpired({ expiresAt: past, now: NOW });
    } catch (e) {
      expect(e).toBeInstanceOf(ExpiredApprovalError);
      expect((e as ExpiredApprovalError).expiresAt).toBe(past);
    }
  });

  it("checkPendingState: throws unless state === expected (default 'pending')", () => {
    expect(() => checkPendingState({ state: "pending" })).not.toThrow();
    expect(() => checkPendingState({ state: "applied" })).toThrow(StalePendingStateError);
    expect(() => checkPendingState({ state: "approved", expected: "approved" })).not.toThrow();
    try {
      checkPendingState({ state: "applied", expected: "pending" });
    } catch (e) {
      expect((e as StalePendingStateError).actualState).toBe("applied");
      expect((e as StalePendingStateError).expectedState).toBe("pending");
    }
  });
});
