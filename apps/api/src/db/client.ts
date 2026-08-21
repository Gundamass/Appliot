import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type SqliteDatabase = InstanceType<typeof Database>;

export function createSqliteDatabase(filename: string): SqliteDatabase {
  if (filename !== ":memory:" && !filename.startsWith("file:")) {
    mkdirSync(dirname(filename), { recursive: true });
  }
  return new Database(filename);
}

export function createDrizzleClient(database: SqliteDatabase) {
  return drizzle(database, { schema });
}
