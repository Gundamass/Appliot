import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createApplicationTaskRepository } from "./application-task-repository.js";
import { createGraphApplicationReviewRepository } from "./graph-application-review-repository.js";

const databases: Database.Database[] = [];

function createDatabase(): Database.Database {
  const database = new Database(":memory:");
  migrateDatabase(database);
  databases.push(database);
  return database;
}

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("graph application review repository", () => {
  it("exposes a draft only after the matching review has been approved", () => {
    const database = createDatabase();
    createApplicationTaskRepository(database).create({
      id: "task-1",
      applicationUrl: "https://jobs.example.test/apply"
    });
    const reviews = createGraphApplicationReviewRepository(database);

    reviews.save({
      id: "review-1",
      interruptId: "interrupt-1",
      taskId: "task-1",
      fieldId: "self-evaluation",
      fieldLabel: "Self evaluation",
      original: "Grounded original",
      draft: "Grounded original",
      reasons: ["Human approval is required before filling generated content."],
      evidence: [{ documentId: "resume-1", page: 1, text: "Grounded original", extraction: "pdf_text" }],
      unsupportedClaims: [],
      status: "needs_review"
    });

    expect(reviews.current("task-1")).toMatchObject({ id: "review-1", draft: "Grounded original" });
    expect(reviews.approvedValue("task-1", "self-evaluation")).toBeUndefined();

    expect(reviews.approve("task-1", "review-1")).toMatchObject({ status: "approved" });
    expect(reviews.approvedValue("task-1", "self-evaluation")).toBe("Grounded original");
  });
});
