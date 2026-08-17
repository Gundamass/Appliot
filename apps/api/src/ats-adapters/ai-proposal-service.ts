import { createHash, randomUUID } from "node:crypto";
import {
  AiHintPackProposalSchema,
  HintPackDefinitionSchema,
  type AiHintPackProposal,
  type FormSnapshot
} from "@resume/contracts";
import type { StructuredModelProvider } from "@resume/model-provider";
import type { AdapterLedger } from "./adapter-ledger.js";
import { sanitizeAdapterObservation } from "./observation-sanitizer.js";

const PROPOSAL_PROMPT_VERSION = "hint-proposal-v1" as const;

export interface AiProposalRequest {
  taskId: string;
  snapshot: FormSnapshot;
  profilePaths: readonly string[];
}

export interface AiProposalService {
  propose(input: AiProposalRequest): Promise<AiHintPackProposal>;
}

export interface AiProposalServiceDependencies {
  provider: StructuredModelProvider;
  ledger: Pick<AdapterLedger, "createProposal" | "findProposal">;
  providerName: string;
  model: string;
  now?: () => Date;
  createId?: () => string;
}

export function createAiProposalService(dependencies: AiProposalServiceDependencies): AiProposalService {
  const now = dependencies.now ?? (() => new Date());
  const createId = dependencies.createId ?? randomUUID;

  return {
    async propose(input) {
      const observation = sanitizeAdapterObservation(input.snapshot, input.profilePaths);
      const proposalId = createId();
      const definition = await dependencies.provider.generateStructured({
        system: [
          "Produce a declarative ATS hint-pack definition from the sanitized observation.",
          "Use only the supplied structural fields and profile paths.",
          "Never include profile values, selectors, DOM or NodeRef identifiers, browser commands, terminal submission actions, network requests, scripts, or executable code.",
          "Unsupported boundaries must remain review-only."
        ].join(" "),
        user: JSON.stringify(observation),
        schema: HintPackDefinitionSchema,
        jsonExample: hintPackExample(),
        metadata: { requestId: proposalId, purpose: "adapter_proposal" }
      });
      const proposal = AiHintPackProposalSchema.parse({
        proposalId,
        taskId: input.taskId,
        lifecycleStatus: "candidate",
        provider: dependencies.providerName,
        model: dependencies.model,
        promptVersion: PROPOSAL_PROMPT_VERSION,
        inputHash: hash(observation),
        outputHash: hash(definition),
        definition,
        unsupportedBoundaries: observation.boundaries.filter((boundary) => boundary.blocked).map((boundary) => boundary.kind),
        rejectedActions: [...new Set(observation.actions.flatMap((action) => (
          action.actionClass === "unknown_side_effect" || action.actionClass === "terminal_submit"
            ? [action.actionClass]
            : []
        )))],
        createdAt: now().toISOString()
      });
      dependencies.ledger.createProposal(proposal);
      const persisted = dependencies.ledger.findProposal(proposalId);
      if (persisted === undefined) throw new Error("adapter_proposal_persistence_failed");
      return persisted;
    }
  };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function hintPackExample() {
  return {
    schemaVersion: 1,
    packId: "example-ats",
    version: "1.0.0",
    match: {
      sites: [{ hostSuffix: "example.test", pathPrefixes: ["/apply"] }],
      stages: ["application_form"],
      requiredTextSignals: [],
      pageFingerprintHashes: []
    },
    sectionRules: [],
    fieldRules: [],
    actionRules: [],
    fixtures: [{ fixtureId: "synthetic-basic", expectedProfilePaths: ["basics.name"] }]
  };
}
