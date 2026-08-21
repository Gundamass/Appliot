import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteDatabase } from "./client.js";

describe("createSqliteDatabase", () => {
  it("creates a missing parent directory for a file-backed database", async () => {
    const root = await mkdtemp(join(tmpdir(), "resume-database-"));
    const filename = join(root, "data", "resume-assistant.sqlite");

    try {
      const database = createSqliteDatabase(filename);
      database.close();

      expect((await stat(filename)).isFile()).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
