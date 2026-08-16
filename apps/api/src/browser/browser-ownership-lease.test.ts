import { describe, expect, it } from "vitest";
import { BrowserOwnershipLease } from "./browser-ownership-lease.js";

describe("BrowserOwnershipLease", () => {
  it("rejects a competing owner", () => {
    const lease = new BrowserOwnershipLease();
    lease.acquire({ ownerKind: "job_match", ownerId: "jm-1" });

    expect(() => lease.acquire({ ownerKind: "application", ownerId: "app-1" }))
      .toThrow("browser_lease_in_use");
  });

  it("returns the current epoch when the same owner reacquires", () => {
    const lease = new BrowserOwnershipLease();
    const first = lease.acquire({ ownerKind: "application", ownerId: "app-1" });

    expect(lease.acquire({ ownerKind: "application", ownerId: "app-1" })).toEqual(first);
    expect(lease.current()).toEqual(first);
  });

  it("rejects assertions and releases from a different owner", () => {
    const lease = new BrowserOwnershipLease();
    lease.acquire({ ownerKind: "job_match", ownerId: "jm-1" });

    expect(() => lease.assertOwner({ ownerKind: "application", ownerId: "jm-1" }))
      .toThrow("browser_lease_not_owned");
    expect(() => lease.release({ ownerKind: "job_match", ownerId: "jm-2" }))
      .toThrow("browser_lease_not_owned");
    expect(lease.current()).toMatchObject({ ownerKind: "job_match", ownerId: "jm-1" });
  });

  it("increments the global epoch after ownership is released and transferred", () => {
    const lease = new BrowserOwnershipLease();
    expect(lease.acquire({ ownerKind: "job_match", ownerId: "jm-1" }).executionEpoch).toBe(1);

    lease.release({ ownerKind: "job_match", ownerId: "jm-1" });

    expect(lease.current()).toBeUndefined();
    expect(lease.acquire({ ownerKind: "application", ownerId: "app-1" }).executionEpoch).toBe(2);
  });
});
