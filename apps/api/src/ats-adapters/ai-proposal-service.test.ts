import type {
  FormSnapshot,
  HintPackDefinition
} from "@resume/contracts";
import type { StructuredGenerationInput, StructuredModelProvider } from "@resume/model-provider";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateDatabase } from "../db/migrate.js";
import { createAdapterLedger } from "./adapter-ledger.js";
import { createAiProposalService } from "./ai-proposal-service.js";

const hash = (character: string) => character.repeat(64);
const nodeRef = {
  documentId: "document-secret-00000001",
  nodeId: "node-secret-000000000001",
  observedAt: 7
};

function snapshot(): FormSnapshot {
  return {
    id: "snapshot-secret",
    taskId: "task-secret",
    url: "https://jobs.example.test/apply?token=secret",
    title: "Alice Example application",
    stage: "application_form",
    frameRef: { documentId: nodeRef.documentId, kind: "main" },
    mutationEpoch: nodeRef.observedAt,
    fields: [{
      id: "field-secret",
      label: "Email",
      type: "text",
      required: true,
      options: [],
      currentValue: "alice@example.com",
      sectionHint: "basics",
      nodeRef
    }],
    actions: [{
      id: "action-secret",
      text: "Continue",
      class: "intermediate_navigation",
      nodeRef
    }],
    errors: []
  };
}

function definition(): HintPackDefinition {
  return {
    schemaVersion: 1,
    packId: "example-ats",
    version: "1.0.0",
    match: {
      sites: [{ hostSuffix: "jobs.example.test", pathPrefixes: ["/apply"] }],
      stages: ["application_form"],
      requiredTextSignals: ["Application"],
      pageFingerprintHashes: [hash("a")]
    },
    sectionRules: [],
    fieldRules: [{
      ruleId: "email",
      profilePath: "basics.email",
      labelAliases: ["Email"],
      sections: ["basics"],
      controlTypes: ["text"],
      confidence: 1
    }],
    actionRules: [],
    fixtures: [{ fixtureId: "synthetic-basic", expectedProfilePaths: ["basics.email"] }]
  };
}

describe("createAiProposalService", () => {
  let database: InstanceType<typeof Database>;

  beforeEach(() => {
    database = new Database(":memory:");
    migrateDatabase(database);
  });

  afterEach(() => database.close());

  it("sends only a sanitized observation and persists server-authored provenance", async () => {
    const generateStructured = vi.fn(async (input: StructuredGenerationInput<unknown>) => input.schema.parse(definition()));
    const provider: StructuredModelProvider = {
      generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
        return generateStructured(input) as Promise<T>;
      }
    };
    const ledger = createAdapterLedger(database);
    const service = createAiProposalService({
      provider,
      ledger,
      providerName: "deepseek",
      model: "deepseek-test",
      createId: () => "proposal-1",
      now: () => new Date("2026-08-17T00:00:00.000Z")
    });

    const proposal = await service.propose({
      taskId: "task-1",
      snapshot: snapshot(),
      profilePaths: ["basics.email", "basics.name"]
    });

    expect(generateStructured).toHaveBeenCalledOnce();
    const input = generateStructured.mock.calls[0]![0]!;
    expect(input.metadata).toEqual({ requestId: "proposal-1", purpose: "adapter_proposal" });
    const prompt = JSON.stringify(input);
    for (const forbidden of ["Alice Example", "alice@example.com", "secret", "node-secret", "document-secret"]) {
      expect(prompt).not.toContain(forbidden);
    }
    expect(JSON.parse(input.user)).toMatchObject({
      schemaVersion: 1,
      origin: "https://jobs.example.test",
      profilePaths: ["basics.email", "basics.name"]
    });
    expect(proposal).toMatchObject({
      proposalId: "proposal-1",
      taskId: "task-1",
      lifecycleStatus: "candidate",
      provider: "deepseek",
      model: "deepseek-test",
      promptVersion: "hint-proposal-v1"
    });
    expect(proposal.inputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(proposal.outputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(proposal.definition.fieldRules[0]?.labelAliases).toEqual([
      expect.stringMatching(/^ats:sha256:\d{1,3}:[a-f0-9]{64}$/u)
    ]);
    expect(ledger.findProposal("proposal-1")).toEqual(proposal);
  });

  it("fails closed instead of returning an unpersisted AI definition", async () => {
    const generateStructured = vi.fn(async (input: StructuredGenerationInput<unknown>) => input.schema.parse(definition()));
    const service = createAiProposalService({
      provider: {
        generateStructured<T>(input: StructuredGenerationInput<T>): Promise<T> {
          return generateStructured(input) as Promise<T>;
        }
      },
      ledger: {
        createProposal: vi.fn(),
        findProposal: vi.fn(() => undefined)
      },
      providerName: "deepseek",
      model: "deepseek-test",
      createId: () => "proposal-1",
      now: () => new Date("2026-08-17T00:00:00.000Z")
    });

    await expect(service.propose({ taskId: "task-1", snapshot: snapshot(), profilePaths: ["basics.email"] }))
      .rejects.toThrow("adapter_proposal_persistence_failed");
  });
});
