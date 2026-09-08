import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentGraphState, ProfileFact } from "@resume/contracts";
import type { ExtractedDocument } from "@resume/profile-domain/src/pdf/types.js";
import { migrateDatabase } from "../../db/migrate.js";
import { createProfileRepository } from "../../profile/profile-repository.js";
import { createSqliteTraceSink } from "../trace-sink.js";
import { createResumeIngestionSubgraph } from "./resume-ingestion.js";

const databases: Database.Database[] = [];
const sourceBytes = Uint8Array.from(Buffer.from("resume-source"));
const documentFingerprint = createHash("sha256").update(sourceBytes).digest("hex");

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("resume ingestion subgraph", () => {
  it("preserves text-first and OCR page sources from the existing extractor", async () => {
    const document = documentFixture([
      { page: 1, text: "Ada Lovelace", source: "pdf_text" },
      { page: 2, text: "TypeScript", source: "ocr" }
    ]);
    const { graph, extractFacts, extractPdf } = createTestGraph({ document });

    const result = await graph({ state: graphState() });

    expect(result).toEqual(expect.objectContaining({
      status: "completed",
      currentNode: "check_completeness",
      resumeIngestion: expect.objectContaining({
        documentId: "document-1",
        documentFingerprint,
        pageSources: ["pdf", "ocr"],
        candidateFactIds: []
      })
    }));
    expect(extractPdf).toHaveBeenCalledOnce();
    expect(extractFacts).toHaveBeenCalledWith(document);
  });

  it("interrupts before persistence when a candidate lacks valid page evidence", async () => {
    const unsupported = extractedFact({
      id: "11111111-1111-4111-8111-111111111111",
      fieldPath: "basics.name",
      value: "Ada Lovelace",
      evidence: [{ documentId: documentFingerprint, page: 2, text: "Ada Lovelace", extraction: "pdf_text" }]
    });
    const { graph, profileRepository } = createTestGraph({
      document: documentFixture([{ page: 1, text: "Ada Lovelace", source: "pdf_text" }]),
      facts: [unsupported],
      requiredFactPaths: ["basics.name"]
    });

    const result = await graph({ state: graphState() });

    expect(result).toEqual(expect.objectContaining({
      status: "interrupted",
      currentNode: "validate_evidence",
      pendingInterrupt: expect.objectContaining({
        kind: "missing_fact",
        reasonCode: "resume_evidence_invalid",
        questionIds: ["field:basics.name"]
      })
    }));
    expect(profileRepository.listActive()).toEqual([]);
  });

  it("confirms an evidence-backed required candidate before publishing its profile revision", async () => {
    const candidate = extractedFact({
      id: "22222222-2222-4222-8222-222222222222",
      fieldPath: "basics.name",
      value: "Ada Lovelace"
    });
    const { graph, profileRepository } = createTestGraph({
      document: documentFixture([{ page: 1, text: "Ada Lovelace", source: "pdf_text" }]),
      facts: [candidate],
      requiredFactPaths: ["basics.name"]
    });

    const first = await graph({ state: graphState() });
    expect(first).toEqual(expect.objectContaining({
      status: "interrupted",
      pendingInterrupt: expect.objectContaining({ questionIds: [`fact:${candidate.id}`] })
    }));

    const second = await graph({
      state: graphState({
        status: "interrupted",
        pendingInterrupt: first.pendingInterrupt,
        resumeIngestion: first.resumeIngestion
      }),
      resume: {
        interruptId: first.pendingInterrupt!.id,
        action: "confirm",
        values: { factIds: [candidate.id] }
      }
    });

    expect(second).toEqual(expect.objectContaining({
      status: "completed",
      resumeIngestion: expect.objectContaining({
        candidateFactIds: [candidate.id],
        acceptedFactIds: [candidate.id],
        publishedProfileRevision: 1
      })
    }));
    expect(profileRepository.resolveForTask("task-1", "basics.name")).toMatchObject({
      id: candidate.id,
      status: "user_confirmed",
      value: "Ada Lovelace"
    });
  });

  it("interrupts when a new candidate conflicts with a reviewed profile fact", async () => {
    const candidate = extractedFact({
      id: "33333333-3333-4333-8333-333333333333",
      fieldPath: "basics.name",
      value: "Ada Lovelace"
    });
    const { graph, profileRepository } = createTestGraph({
      document: documentFixture([{ page: 1, text: "Ada Lovelace", source: "pdf_text" }]),
      facts: [candidate]
    });
    profileRepository.upsertUserFact({ fieldPath: "basics.name", value: "Grace Hopper" });

    const result = await graph({ state: graphState({ profileRevision: 1 }) });

    expect(result).toEqual(expect.objectContaining({
      status: "interrupted",
      currentNode: "validate_evidence",
      pendingInterrupt: expect.objectContaining({
        kind: "fact_conflict",
        reasonCode: "resume_fact_conflict",
        questionIds: [`fact:${candidate.id}`]
      })
    }));
    expect(profileRepository.resolveForTask("task-1", "basics.name")).toMatchObject({
      value: "Grace Hopper",
      status: "user_corrected"
    });
  });

  it("writes a user correction for a missing required field through the profile repository", async () => {
    const { graph, profileRepository } = createTestGraph({
      document: documentFixture([{ page: 1, text: "Ada Lovelace", source: "pdf_text" }]),
      requiredFactPaths: ["basics.email"]
    });

    const first = await graph({ state: graphState() });
    expect(first).toEqual(expect.objectContaining({
      status: "interrupted",
      pendingInterrupt: expect.objectContaining({ questionIds: ["field:basics.email"] })
    }));

    const second = await graph({
      state: graphState({
        status: "interrupted",
        pendingInterrupt: first.pendingInterrupt,
        resumeIngestion: first.resumeIngestion
      }),
      resume: {
        interruptId: first.pendingInterrupt!.id,
        action: "correct",
        values: { "basics.email": "ada@example.com" }
      }
    });

    expect(second).toEqual(expect.objectContaining({
      status: "completed",
      resumeIngestion: expect.objectContaining({ publishedProfileRevision: 1 })
    }));
    expect(profileRepository.resolveForTask("task-1", "basics.email")).toMatchObject({
      status: "user_corrected",
      value: "ada@example.com",
      evidence: [{ documentId: "user", page: 1, text: "Corrected value: \"ada@example.com\"", extraction: "user" }]
    });
  });
});

function createTestGraph(input: {
  document: ExtractedDocument;
  facts?: ProfileFact[];
  requiredFactPaths?: string[];
}) {
  const database = new Database(":memory:");
  databases.push(database);
  migrateDatabase(database);
  const profileRepository = createProfileRepository(database);
  const extractPdf = vi.fn(async () => input.document);
  const extractFacts = vi.fn(async () => input.facts ?? []);
  const graph = createResumeIngestionSubgraph({
    loadDocument: async () => ({ documentId: "document-1", bytes: sourceBytes }),
    extractPdf,
    extractFacts,
    profileRepository,
    requiredFactPaths: input.requiredFactPaths ?? [],
    traceSink: createSqliteTraceSink(database),
    now: () => new Date("2026-08-22T00:00:00.000Z")
  });

  return { graph, extractPdf, extractFacts, profileRepository };
}

function graphState(overrides: Partial<AgentGraphState> = {}): AgentGraphState {
  return {
    threadId: "thread-1",
    runId: "run-1",
    taskId: "task-1",
    graphVersion: "agent-v1",
    status: "running",
    profileRevision: 0,
    currentSubgraph: "resume_ingestion",
    auditEventIds: [],
    ...overrides
  };
}

function documentFixture(pages: ExtractedDocument["pages"]): ExtractedDocument {
  return { fingerprint: documentFingerprint, pages };
}

function extractedFact(input: {
  id: string;
  fieldPath: string;
  value: string;
  evidence?: ProfileFact["evidence"];
}): ProfileFact {
  return {
    id: input.id,
    fieldPath: input.fieldPath,
    value: input.value,
    status: "extracted",
    confidence: 0.98,
    scope: "profile",
    revision: 1,
    evidence: input.evidence ?? [{
      documentId: documentFingerprint,
      page: 1,
      text: input.value,
      extraction: "pdf_text"
    }]
  };
}
