import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createDebugRawStore } from "./debug-raw-store.js";

describe("createDebugRawStore", () => {
  let database: InstanceType<typeof Database>;

  beforeEach(() => {
    database = new Database(":memory:");
    migrateDatabase(database);
  });

  afterEach(() => database.close());

  it("retains ciphertext for at most 168 hours and audits every read", () => {
    const store = createDebugRawStore(database, {
      enabled: true,
      encryptionKey: Buffer.alloc(32, 7),
      ttlHours: 24,
      now: () => new Date("2026-08-17T00:00:00.000Z")
    });
    const id = store.retain({ proposalId: "proposal-1", purpose: "proposal", plaintext: "raw model body" });

    const stored = database.prepare("SELECT ciphertext, expires_at FROM ats_adapter_debug_responses WHERE id = ?")
      .get(id) as { ciphertext: Buffer; expires_at: string };
    expect(stored.ciphertext.equals(Buffer.from("raw model body", "utf8"))).toBe(false);
    expect(stored.expires_at).toBe("2026-08-18T00:00:00.000Z");
    expect(store.read(id!, "local-reviewer")).toBe("raw model body");
    expect(database.prepare("SELECT COUNT(*) AS count FROM ats_adapter_debug_accesses WHERE response_id = ?").get(id))
      .toEqual({ count: 1 });
    expect(() => createDebugRawStore(database, {
      enabled: true,
      encryptionKey: Buffer.alloc(32),
      ttlHours: 169
    })).toThrow(/168/u);
  });

  it("uses the 24 hour default, requires AES-256 keys, and remains opt-in", () => {
    const now = () => new Date("2026-08-17T00:00:00.000Z");
    const disabled = createDebugRawStore(database, { enabled: false, now });
    expect(disabled.retain({ proposalId: "proposal-1", purpose: "proposal", plaintext: "raw model body" }))
      .toBeUndefined();
    expect(database.prepare("SELECT COUNT(*) AS count FROM ats_adapter_debug_responses").get()).toEqual({ count: 0 });
    expect(() => createDebugRawStore(database, { enabled: true, encryptionKey: Buffer.alloc(31), now }))
      .toThrowError("debug_raw_key_must_be_32_bytes");

    const enabled = createDebugRawStore(database, { enabled: true, encryptionKey: Buffer.alloc(32, 9), now });
    const id = enabled.retain({ proposalId: "proposal-1", purpose: "replay_review", plaintext: "structured debug input" });
    expect(database.prepare("SELECT expires_at FROM ats_adapter_debug_responses WHERE id = ?").get(id))
      .toEqual({ expires_at: "2026-08-18T00:00:00.000Z" });
  });

  it("audits expired reads and purges expired ciphertext", () => {
    let current = new Date("2026-08-17T00:00:00.000Z");
    const store = createDebugRawStore(database, {
      enabled: true,
      encryptionKey: Buffer.alloc(32, 3),
      ttlHours: 1,
      now: () => current
    });
    const id = store.retain({ proposalId: "proposal-1", purpose: "proposal", plaintext: "short-lived body" });
    current = new Date("2026-08-17T01:00:00.000Z");

    expect(store.read(id!, "expiry-reviewer")).toBeUndefined();
    expect(database.prepare("SELECT actor FROM ats_adapter_debug_accesses WHERE response_id = ?").all(id))
      .toEqual([{ actor: "expiry-reviewer" }]);
    expect(store.purgeExpired()).toBe(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM ats_adapter_debug_responses").get()).toEqual({ count: 0 });
  });

  it("audits reads for absent and already-purged response ids", () => {
    let current = new Date("2026-08-17T00:00:00.000Z");
    const store = createDebugRawStore(database, {
      enabled: true,
      encryptionKey: Buffer.alloc(32, 4),
      ttlHours: 1,
      now: () => current
    });

    expect(store.read("missing-response", "missing-reviewer")).toBeUndefined();
    const purgedId = store.retain({
      proposalId: "proposal-1",
      purpose: "proposal",
      plaintext: "short-lived synthetic body"
    });
    current = new Date("2026-08-17T01:00:00.000Z");
    expect(store.purgeExpired()).toBe(1);
    expect(store.read(purgedId!, "purged-reviewer")).toBeUndefined();

    expect(database.prepare(`
      SELECT response_id, actor FROM ats_adapter_debug_accesses ORDER BY id
    `).all()).toEqual([
      { response_id: "missing-response", actor: "missing-reviewer" },
      { response_id: purgedId, actor: "purged-reviewer" }
    ]);
  });
});
