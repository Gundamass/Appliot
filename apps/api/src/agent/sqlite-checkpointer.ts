import type { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  copyCheckpoint,
  getCheckpointId,
  WRITES_IDX_MAP,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  type PendingWrite,
  type SerializerProtocol
} from "@langchain/langgraph-checkpoint";
import type { SqliteDatabase } from "../db/client.js";

interface CheckpointRow {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string;
  metadata_type: string;
  checkpoint_blob: Buffer;
  metadata_blob: Buffer;
  created_at: string;
}

interface WriteRow {
  task_id: string;
  write_index: number;
  channel: string;
  type: string;
  value_blob: Buffer;
}

/**
 * SQLite-backed LangGraph persistence. Only compact, serialized graph state is
 * stored here; documents, browser state, and secrets remain in their own stores.
 */
export class SqliteAgentCheckpointer extends BaseCheckpointSaver {
  constructor(
    private readonly database: SqliteDatabase,
    serde?: SerializerProtocol
  ) {
    super(serde);
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const threadId = requireThreadId(config);
    const checkpointNs = checkpointNamespace(config);
    const checkpointId = getCheckpointId(config);
    if (checkpointId !== "") assertKey("checkpoint_id", checkpointId);

    const row = (checkpointId === ""
      ? this.database.prepare(`
        SELECT * FROM agent_checkpoints
        WHERE thread_id = ? AND checkpoint_ns = ?
        ORDER BY checkpoint_id DESC
        LIMIT 1
      `).get(threadId, checkpointNs)
      : this.database.prepare(`
        SELECT * FROM agent_checkpoints
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
      `).get(threadId, checkpointNs, checkpointId)) as CheckpointRow | undefined;

    if (row === undefined) return undefined;
    return this.toTuple(row, config);
  }

  async *list(config: RunnableConfig, options: CheckpointListOptions = {}): AsyncGenerator<CheckpointTuple> {
    const threadId = optionalKey("thread_id", config.configurable?.thread_id);
    const checkpointNs = config.configurable?.checkpoint_ns === undefined
      ? undefined
      : checkpointNamespace(config);
    const checkpointId = getCheckpointId(config);
    if (checkpointId !== "") assertKey("checkpoint_id", checkpointId);

    const beforeId = options.before === undefined ? undefined : getCheckpointId(options.before);
    if (beforeId !== undefined && beforeId !== "") assertKey("checkpoint_id", beforeId);

    const predicates: string[] = [];
    const parameters: unknown[] = [];
    if (threadId !== undefined) {
      predicates.push("thread_id = ?");
      parameters.push(threadId);
    }
    if (checkpointNs !== undefined) {
      predicates.push("checkpoint_ns = ?");
      parameters.push(checkpointNs);
    }
    if (checkpointId !== "") {
      predicates.push("checkpoint_id = ?");
      parameters.push(checkpointId);
    }
    if (beforeId !== undefined && beforeId !== "") {
      predicates.push("checkpoint_id < ?");
      parameters.push(beforeId);
    }

    const where = predicates.length === 0 ? "" : `WHERE ${predicates.join(" AND ")}`;
    const rows = this.database.prepare(`
      SELECT * FROM agent_checkpoints
      ${where}
      ORDER BY checkpoint_id DESC
    `).all(...parameters) as CheckpointRow[];
    const limit = options.limit;
    if (limit !== undefined && limit <= 0) return;

    let yielded = 0;
    for (const row of rows) {
      const metadata = await this.deserialize<CheckpointMetadata>(row.metadata_type, row.metadata_blob);
      if (options.filter !== undefined && !matchesMetadata(metadata, options.filter)) continue;
      if (limit !== undefined && yielded >= limit) return;
      yielded += 1;
      yield this.toTuple(row, {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.checkpoint_id
        }
      }, metadata);
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    _newVersions: Record<string, number | string>
  ): Promise<RunnableConfig> {
    const threadId = requireThreadId(config);
    const checkpointNs = checkpointNamespace(config);
    assertKey("checkpoint_id", checkpoint.id);
    const parentCheckpointId = getCheckpointId(config);
    if (parentCheckpointId !== "") assertKey("checkpoint_id", parentCheckpointId);

    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const [[checkpointType, checkpointBlob], [metadataType, metadataBlob]] = await Promise.all([
      this.serde.dumpsTyped(preparedCheckpoint),
      this.serde.dumpsTyped(metadata)
    ]);
    const createdAt = new Date().toISOString();
    const write = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO agent_checkpoints (
          thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id,
          type, metadata_type, checkpoint_blob, metadata_blob, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id) DO UPDATE SET
          parent_checkpoint_id = excluded.parent_checkpoint_id,
          type = excluded.type,
          metadata_type = excluded.metadata_type,
          checkpoint_blob = excluded.checkpoint_blob,
          metadata_blob = excluded.metadata_blob,
          created_at = excluded.created_at
      `).run(
        threadId,
        checkpointNs,
        checkpoint.id,
        parentCheckpointId === "" ? null : parentCheckpointId,
        checkpointType,
        metadataType,
        Buffer.from(checkpointBlob),
        Buffer.from(metadataBlob),
        createdAt
      );
    });
    write();

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id
      }
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const threadId = requireThreadId(config);
    const checkpointNs = checkpointNamespace(config);
    const checkpointId = getCheckpointId(config);
    if (checkpointId === "") throw new Error("agent_checkpoint_id_required");
    assertKey("checkpoint_id", checkpointId);
    assertKey("task_id", taskId);

    const serialized = await Promise.all(writes.map(async ([channel, value], index) => {
      const [type, blob] = await this.serde.dumpsTyped(value);
      return { channel, type, blob: Buffer.from(blob), writeIndex: WRITES_IDX_MAP[channel] ?? index };
    }));
    const write = this.database.transaction(() => {
      const insert = this.database.prepare(`
        INSERT INTO agent_checkpoint_writes (
          thread_id, checkpoint_ns, checkpoint_id, task_id, write_index,
          channel, type, value_blob
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id, checkpoint_ns, checkpoint_id, task_id, write_index)
        DO UPDATE SET channel = excluded.channel, type = excluded.type, value_blob = excluded.value_blob
      `);
      const regularExists = this.database.prepare(`
        SELECT 1 FROM agent_checkpoint_writes
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
          AND task_id = ? AND write_index = ?
      `);
      for (const item of serialized) {
        if (item.writeIndex >= 0 && regularExists.get(
          threadId, checkpointNs, checkpointId, taskId, item.writeIndex
        ) !== undefined) continue;
        insert.run(
          threadId,
          checkpointNs,
          checkpointId,
          taskId,
          item.writeIndex,
          item.channel,
          item.type,
          item.blob
        );
      }
    });
    write();
  }

  async deleteThread(threadId: string): Promise<void> {
    assertKey("thread_id", threadId);
    const remove = this.database.transaction(() => {
      this.database.prepare("DELETE FROM agent_checkpoint_writes WHERE thread_id = ?").run(threadId);
      this.database.prepare("DELETE FROM agent_checkpoints WHERE thread_id = ?").run(threadId);
    });
    remove();
  }

  private async toTuple(
    row: CheckpointRow,
    requestedConfig: RunnableConfig,
    knownMetadata?: CheckpointMetadata
  ): Promise<CheckpointTuple> {
    const checkpoint = await this.deserialize<Checkpoint>(row.type, row.checkpoint_blob);
    const metadata = knownMetadata ?? await this.deserialize<CheckpointMetadata>(row.metadata_type, row.metadata_blob);
    const pendingWrites = await this.pendingWrites(row);
    const tuple: CheckpointTuple = {
      config: requestedConfig.configurable?.checkpoint_id === undefined &&
        requestedConfig.configurable?.thread_ts === undefined &&
        getCheckpointId(requestedConfig) === ""
        ? {
          configurable: {
            thread_id: row.thread_id,
            checkpoint_ns: row.checkpoint_ns,
            checkpoint_id: row.checkpoint_id
          }
        }
        : requestedConfig,
      checkpoint,
      metadata,
      pendingWrites
    };
    if (row.parent_checkpoint_id !== null) {
      tuple.parentConfig = {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: row.checkpoint_ns,
          checkpoint_id: row.parent_checkpoint_id
        }
      };
    }
    return tuple;
  }

  private async pendingWrites(row: CheckpointRow): Promise<CheckpointPendingWrite[]> {
    const writes = this.database.prepare(`
      SELECT task_id, write_index, channel, type, value_blob
      FROM agent_checkpoint_writes
      WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
      ORDER BY task_id ASC, write_index ASC
    `).all(row.thread_id, row.checkpoint_ns, row.checkpoint_id) as WriteRow[];
    return Promise.all(writes.map(async (write): Promise<CheckpointPendingWrite> => [
      write.task_id,
      write.channel,
      await this.deserialize(write.type, write.value_blob)
    ]));
  }

  private async deserialize<T>(type: string, blob: Uint8Array): Promise<T> {
    return this.serde.loadsTyped(type, new Uint8Array(blob)) as Promise<T>;
  }
}

function requireThreadId(config: RunnableConfig): string {
  const threadId = config.configurable?.thread_id;
  if (typeof threadId !== "string" || threadId.length === 0) throw new Error("agent_thread_id_required");
  assertKey("thread_id", threadId);
  return threadId;
}

function optionalKey(field: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`agent_${field}_invalid`);
  assertKey(field, value);
  return value;
}

function checkpointNamespace(config: RunnableConfig): string {
  const value = config.configurable?.checkpoint_ns;
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error("agent_checkpoint_namespace_invalid");
  assertKey("checkpoint_ns", value, true);
  return value;
}

function assertKey(field: string, value: string, allowEmpty = false): void {
  if ((!allowEmpty && value.length === 0) || value === "__proto__" || value === "constructor" || value === "prototype") {
    throw new Error(`agent_${field}_invalid`);
  }
}

function matchesMetadata(metadata: CheckpointMetadata, filter: Record<string, unknown>): boolean {
  const values = metadata as Record<string, unknown>;
  return Object.entries(filter).every(([key, value]) => values[key] === value);
}
