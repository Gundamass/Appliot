import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createTaskEventBus } from "./task-events.js";

describe("task event bus", () => {
  it("persists monotonic events and replays after a bus restart", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const first = createTaskEventBus(database);
    const one = first.emit("91dc4bd6-425a-4cab-a38d-d13e33cda771", "observing_page");
    const two = first.emit("91dc4bd6-425a-4cab-a38d-d13e33cda771", "waiting_for_login");

    const reopened = createTaskEventBus(database);
    expect(Number(two.id)).toBeGreaterThan(Number(one.id));
    expect(reopened.history(one.taskId, one.id)).toEqual([two]);
    database.close();
  });

  it("publishes future events and removes subscribers", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const bus = createTaskEventBus(database);
    const listener = vi.fn();
    const unsubscribe = bus.subscribe("91dc4bd6-425a-4cab-a38d-d13e33cda771", listener);

    const event = bus.emit("91dc4bd6-425a-4cab-a38d-d13e33cda771", "waiting_for_login");
    expect(listener).toHaveBeenCalledWith(event);
    expect(bus.subscriberCount(event.taskId)).toBe(1);

    unsubscribe();
    expect(bus.subscriberCount(event.taskId)).toBe(0);
    database.close();
  });

  it("keeps only the configured number of events per task", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const bus = createTaskEventBus(database, { historyLimit: 2 });
    const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";

    bus.emit(taskId, "created");
    const second = bus.emit(taskId, "observing_page");
    const third = bus.emit(taskId, "waiting_for_login");

    expect(bus.history(taskId)).toEqual([second, third]);
    database.close();
  });

  it("returns a reset signal when Last-Event-ID points into truncated history", () => {
    const database = new Database(":memory:");
    migrateDatabase(database);
    const bus = createTaskEventBus(database, { historyLimit: 2 });
    const taskId = "91dc4bd6-425a-4cab-a38d-d13e33cda771";

    const discarded = bus.emit(taskId, "created");
    const second = bus.emit(taskId, "observing_page");
    const third = bus.emit(taskId, "waiting_for_login");

    expect(bus.replay(taskId, discarded.id)).toEqual({
      events: [second, third],
      reset: {
        type: "history_reset",
        taskId,
        reason: "history_gap",
        requestedLastEventId: discarded.id,
        oldestAvailableId: second.id
      }
    });
    database.close();
  });
});
