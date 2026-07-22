import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

export type SqliteDatabase = InstanceType<typeof Database>;

export function createSqliteDatabase(filename: string): SqliteDatabase {
  return new Database(filename);
}

export function createDrizzleClient(database: SqliteDatabase) {
  return drizzle(database, { schema });
}
