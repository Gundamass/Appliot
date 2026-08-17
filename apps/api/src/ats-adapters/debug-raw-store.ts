import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { SqliteDatabase } from "../db/client.js";

const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 168;
const PROPOSAL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface DebugRawStoreConfig {
  enabled: boolean;
  encryptionKey?: Buffer;
  ttlHours?: number;
  now?: () => Date;
}

export interface DebugRawRetentionInput {
  proposalId: string;
  purpose: "proposal" | "replay_review";
  plaintext: string;
}

export interface DebugRawStore {
  retain(input: DebugRawRetentionInput): string | undefined;
  read(id: string, actor: string): string | undefined;
  purgeExpired(): number;
}

interface DebugResponseRow {
  ciphertext: Buffer;
  iv: Buffer;
  auth_tag: Buffer;
  expires_at: string;
}

function auditHash(kind: "actor" | "response", value: string): string {
  return `sha256:${createHash("sha256").update(`${kind}\0${value}`).digest("hex")}`;
}

export function createDebugRawStore(database: SqliteDatabase, config: DebugRawStoreConfig): DebugRawStore {
  const ttlHours = config.ttlHours ?? DEFAULT_TTL_HOURS;
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > MAX_TTL_HOURS) {
    throw new Error("debug_raw_ttl_must_be_1_to_168_hours");
  }
  if (config.enabled && config.encryptionKey?.byteLength !== 32) {
    throw new Error("debug_raw_key_must_be_32_bytes");
  }
  const encryptionKey = config.encryptionKey ? Buffer.from(config.encryptionKey) : undefined;
  const now = config.now ?? (() => new Date());
  const insert = database.prepare(`
    INSERT INTO ats_adapter_debug_responses (
      id, proposal_id, purpose, ciphertext, iv, auth_tag, expires_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const find = database.prepare(`
    SELECT ciphertext, iv, auth_tag, expires_at FROM ats_adapter_debug_responses WHERE id = ?
  `);
  const audit = database.prepare(`
    INSERT INTO ats_adapter_debug_accesses (response_id, actor, accessed_at) VALUES (?, ?, ?)
  `);
  const removeExpired = database.prepare("DELETE FROM ats_adapter_debug_responses WHERE expires_at <= ?");

  return {
    retain(input) {
      if (!config.enabled || !encryptionKey) return undefined;
      if (!PROPOSAL_ID_PATTERN.test(input.proposalId)) throw new Error("debug_raw_proposal_id_invalid");
      const retainedAt = now();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      const ciphertext = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
      const id = randomUUID();
      const expiresAt = new Date(retainedAt.getTime() + ttlHours * 60 * 60 * 1_000).toISOString();
      insert.run(
        id,
        input.proposalId,
        input.purpose,
        ciphertext,
        iv,
        cipher.getAuthTag(),
        expiresAt,
        retainedAt.toISOString()
      );
      return id;
    },
    read(id, actor) {
      const readAt = now();
      audit.run(auditHash("response", id), auditHash("actor", actor), readAt.toISOString());
      const row = find.get(id) as DebugResponseRow | undefined;
      if (!row) return undefined;
      if (Date.parse(row.expires_at) <= readAt.getTime() || !config.enabled || !encryptionKey) return undefined;
      const decipher = createDecipheriv("aes-256-gcm", encryptionKey, row.iv);
      decipher.setAuthTag(row.auth_tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
    },
    purgeExpired() {
      return removeExpired.run(now().toISOString()).changes;
    }
  };
}
