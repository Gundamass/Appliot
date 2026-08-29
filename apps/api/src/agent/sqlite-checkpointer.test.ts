import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Checkpoint, CheckpointMetadata } from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { SqliteAgentCheckpointer } from "./sqlite-checkpointer.js";

const databases: Database.Database[] = [];
const temporaryDirectories: string[] = [];

function createDatabase(): Database.Database {
  const database = new Database(":memory:");
  migrateDatabase(database);
  databases.push(database);
  return database;
}

function createCheckpoint(id: string, status: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: `2026-08-21T00:00:0${id.slice(-1)}.000Z`,
    channel_values: { status },
    channel_versions: { status: id },
    versions_seen: { node: { status: id } }
  };
}

function config(threadId: string, checkpointNs = "application", checkpointId?: string): RunnableConfig {
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: checkpointNs,
      ...(checkpointId === undefined ? {} : { checkpoint_id: checkpointId })
    }
  };
}

const metadata = (step: number, source: CheckpointMetadata["source"] = "update"): CheckpointMetadata => ({
  source,
  step,
  parents: {}
});

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("SqliteAgentCheckpointer", () => {
  it("round-trips checkpoints and pending writes by thread and namespace", async () => {
    const saver = new SqliteAgentCheckpointer(createDatabase());
    const saved = await saver.put(
      config("thread-a"),
      createCheckpoint("cp-1", "running"),
      metadata(1),
      {}
    );

    await saver.putWrites(saved, [["auditEventIds", ["trace-1"]]], "node-1");

    const tuple = await saver.getTuple(saved);
    expect(tuple?.checkpoint.id).toBe("cp-1");
    expect(tuple?.checkpoint.channel_values).toEqual({ status: "running" });
    expect(tuple?.pendingWrites).toEqual([["node-1", "auditEventIds", ["trace-1"]]]);
    expect(await saver.getTuple(config("thread-b"))).toBeUndefined();
  });

  it("returns the newest checkpoint and preserves parent configuration", async () => {
    const saver = new SqliteAgentCheckpointer(createDatabase());
    const first = await saver.put(config("thread-a"), createCheckpoint("cp-1", "first"), metadata(1), {});
    await saver.put(
      { configurable: { ...config("thread-a").configurable, checkpoint_id: "cp-1" } },
      createCheckpoint("cp-2", "second"),
      metadata(2),
      {}
    );

    const tuple = await saver.getTuple(config("thread-a"));
    expect(tuple?.config).toEqual({ configurable: {
      thread_id: "thread-a", checkpoint_ns: "application", checkpoint_id: "cp-2"
    } });
    expect(tuple?.parentConfig).toEqual(first);
  });

  it("lists newest first with before, limit, namespace, and metadata filters", async () => {
    const saver = new SqliteAgentCheckpointer(createDatabase());
    for (const [id, step, source] of [
      ["cp-1", 1, "input"],
      ["cp-2", 2, "loop"],
      ["cp-3", 3, "loop"]
    ] as const) {
      await saver.put(config("thread-a"), createCheckpoint(id, id), metadata(step, source), {});
    }
    await saver.put(config("thread-a", "resume"), createCheckpoint("cp-x", "other"), metadata(9), {});

    const listed = [];
    for await (const tuple of saver.list(config("thread-a"), { limit: 2, filter: { source: "loop" } })) {
      listed.push(tuple);
    }
    expect(listed.map((tuple) => tuple.checkpoint.id)).toEqual(["cp-3", "cp-2"]);

    const before = [];
    for await (const tuple of saver.list(config("thread-a"), {
      before: config("thread-a", "application", "cp-3"),
      filter: { source: "loop" }
    })) {
      before.push(tuple.checkpoint.id);
    }
    expect(before).toEqual(["cp-2"]);
  });

  it("deduplicates ordinary writes for a task and keeps special writes distinct", async () => {
    const saver = new SqliteAgentCheckpointer(createDatabase());
    const saved = await saver.put(config("thread-a"), createCheckpoint("cp-1", "running"), metadata(1), {});

    await saver.putWrites(saved, [["channel-a", "first"], ["channel-b", "second"]], "node-1");
    await saver.putWrites(saved, [["channel-a", "replacement"], ["channel-c", "third"]], "node-1");

    const tuple = await saver.getTuple(saved);
    expect(tuple?.pendingWrites).toEqual([
      ["node-1", "channel-a", "first"],
      ["node-1", "channel-b", "second"]
    ]);
  });

  it("rejects a missing thread and deletes every namespace for a thread", async () => {
    const saver = new SqliteAgentCheckpointer(createDatabase());
    await expect(saver.put(
      { configurable: { checkpoint_ns: "application" } },
      createCheckpoint("cp-1", "running"),
      metadata(1),
      {}
    )).rejects.toThrow("agent_thread_id_required");

    const saved = await saver.put(config("thread-a"), createCheckpoint("cp-1", "running"), metadata(1), {});
    await saver.put(config("thread-a", "resume"), createCheckpoint("cp-2", "paused"), metadata(2), {});
    await saver.putWrites(saved, [["auditEventIds", ["trace-1"]]], "node-1");
    await saver.deleteThread("thread-a");

    expect(await saver.getTuple(config("thread-a"))).toBeUndefined();
    const remaining = [];
    for await (const tuple of saver.list({})) remaining.push(tuple);
    expect(remaining).toHaveLength(0);
  });

  it("restores checkpoints and writes from a second saver instance", async () => {
    const directory = mkdtempSync(join(tmpdir(), "resume-agent-checkpoint-"));
    temporaryDirectories.push(directory);
    const filename = join(directory, "agent.sqlite");
    const firstDatabase = new Database(filename);
    migrateDatabase(firstDatabase);
    const firstSaver = new SqliteAgentCheckpointer(firstDatabase);
    const saved = await firstSaver.put(config("thread-a"), createCheckpoint("cp-1", "running"), metadata(1), {});
    await firstSaver.putWrites(saved, [["auditEventIds", ["trace-1"]]], "node-1");
    firstDatabase.close();

    const secondDatabase = new Database(filename);
    migrateDatabase(secondDatabase);
    databases.push(secondDatabase);
    const secondSaver = new SqliteAgentCheckpointer(secondDatabase);
    const tuple = await secondSaver.getTuple(config("thread-a"));

    expect(tuple?.checkpoint.id).toBe("cp-1");
    expect(tuple?.pendingWrites).toEqual([["node-1", "auditEventIds", ["trace-1"]]]);
  });
});
