import { describe, expect, it } from "vitest";
import {
  createCallerAttestationAuthority,
  issueCallerAttestationTokens
} from "./caller-attestation.js";

describe("caller attestation composition", () => {
  it("issues immutable scoped tokens for each trusted execution boundary", () => {
    const authority = createCallerAttestationAuthority({
      signingKey: Buffer.alloc(32, 31),
      idFactory: (() => {
        let sequence = 0;
        return () => `attestation-${++sequence}`;
      })()
    });

    const tokens = issueCallerAttestationTokens(authority.issuer);

    expect(Object.isFrozen(tokens)).toBe(true);
    expect(authority.verifier.verify(tokens.graph)).toMatchObject({ valid: true, caller: "graph" });
    expect(authority.verifier.verify(tokens.runtime)).toMatchObject({ valid: true, caller: "runtime" });
    expect(authority.verifier.verify(tokens.supervisor)).toMatchObject({ valid: true, caller: "supervisor" });
    expect(authority.verifier.verify(tokens.specialistAgent)).toMatchObject({ valid: true, caller: "specialist_agent" });
    expect(tokens.graph).not.toBe(tokens.runtime);
  });
});
