export type BrowserOwnerKind = "job_match" | "application";

export interface BrowserOwnerIdentity {
  ownerKind: BrowserOwnerKind;
  ownerId: string;
}

export interface BrowserOwnership extends BrowserOwnerIdentity {
  executionEpoch: number;
}

export class BrowserOwnershipLease {
  private owner: BrowserOwnership | undefined;
  private nextExecutionEpoch = 1;

  acquire(identity: BrowserOwnerIdentity): BrowserOwnership {
    if (this.owner !== undefined) {
      if (!sameOwner(this.owner, identity)) throw new Error("browser_lease_in_use");
      return { ...this.owner };
    }
    this.owner = { ...identity, executionEpoch: this.nextExecutionEpoch };
    this.nextExecutionEpoch += 1;
    return { ...this.owner };
  }

  assertOwner(identity: BrowserOwnerIdentity): BrowserOwnership {
    if (this.owner === undefined || !sameOwner(this.owner, identity)) {
      throw new Error("browser_lease_not_owned");
    }
    return { ...this.owner };
  }

  release(identity: BrowserOwnerIdentity): void {
    this.assertOwner(identity);
    this.owner = undefined;
  }

  current(): BrowserOwnership | undefined {
    return this.owner === undefined ? undefined : { ...this.owner };
  }
}

function sameOwner(owner: BrowserOwnerIdentity, identity: BrowserOwnerIdentity): boolean {
  return owner.ownerKind === identity.ownerKind && owner.ownerId === identity.ownerId;
}
