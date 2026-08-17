# Certified ATS Adapter Packs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a governed pipeline that observes an unknown ATS, asks AI for a sanitized adapter proposal, passes deterministic replay gates, requires human certification, and only then permits the existing controlled executor to fill real pages.

**Architecture:** Add strict adapter-pack contracts and a composite registry in front of field resolution. Unknown pages enter an `awaiting_adapter_review` state with their execution epoch invalidated; proposal, replay, AI review, and human decisions are persisted in an immutable SQLite ledger. The existing `ActionPolicy`, `NodeRef`, stable double-readback, challenge pause, audit, and terminal-submit prohibition remain the only production write path.

**Tech Stack:** TypeScript, Zod, XState 5, Fastify 5, SQLite (`better-sqlite3`), React, Vitest, Playwright, Node.js `crypto`, existing browser worker and synthetic ATS.

## Global Constraints

- Lifecycle is exactly `candidate -> replay_verified -> ai_reviewed -> human_reviewed -> certified`, with `rejected` and `retired`; `replay_verified -> human_reviewed` is allowed only after an explicit AI-unavailable acknowledgement.
- Deterministic schema, policy, control/section compatibility, and replay assertions are authoritative; AI cannot override a failed assertion.
- Only a human decision may create a `certified` pack. An AI proposal is always `review_only` and must never become a production fill source.
- Production keeps only sanitized structured AI records. Debug raw responses require explicit enablement, AES-256-GCM encryption, a default TTL of 24 hours, a maximum TTL of 7 days (168 hours), and an audit row for every read.
- Never send real profile values, cookies, credentials, complete HTML, screenshots containing PII, `NodeRef`, approval tokens, or executable browser commands to AI.
- Unknown or unmatched ATS pages must stop before the first real-page write and enter `awaiting_adapter_review`; they resume only after the registry can resolve a certified immutable pack version.
- Keep `ControlledExecutor`, `ActionPolicy`, snapshot ID, `NodeRef`, mutation epoch, stable double-readback, challenge handling, full-page audit, and terminal-submit prohibition unchanged as the production execution authority.
- CAPTCHA, 403, 429, device verification, risk control, unsupported iframe, and unsupported Shadow DOM always pause for human handling; never bypass them.
- Every synthetic replay must assert correct target values, no unrelated writes, compatible repeated-section behavior, stable readback, explicit boundary handling, and `submissionCount === 0`.
- Moka/Mokahr and DJI are the first source-controlled certified packs; their current fill behavior and zero-submit safety line must remain intact.
- Do not use real ATS accounts, real resumes, browser profiles, credentials, or real submissions in tests.
- A hint pack is versioned domain data, not a Codex Skill and not executable browser script.
- Do not introduce Browser-Use, LangGraph, a remote hint-pack marketplace, CAPTCHA bypass, or a claim of universal ATS/iframe/Shadow DOM coverage in this phase.

---

## File map

- `packages/contracts/src/ats-adapter.ts`: all adapter-pack, proposal, replay, AI-review, human-decision, and task-review wire contracts.
- `packages/form-semantics/src/hint-packs/registry.ts`: deterministic composite resolution of built-in and locally certified immutable packs.
- `packages/form-semantics/src/hint-packs/runtime.ts`: apply declarative field, section, and repeated-action hints to a fresh snapshot without storing `NodeRef` in a pack.
- `packages/form-semantics/src/hint-packs/mokahr-pack.ts` and `dji-pack.ts`: source-controlled first-party certified definitions.
- `apps/api/src/ats-adapters/adapter-ledger.ts`: SQLite lifecycle ledger and transition authority.
- `apps/api/src/ats-adapters/debug-raw-store.ts`: encrypted, expiring debug raw-response storage and read audit.
- `apps/api/src/ats-adapters/observation-sanitizer.ts`: AI-safe observation construction and fingerprints.
- `apps/api/src/ats-adapters/ai-proposal-service.ts` and `ai-replay-review-service.ts`: two separate strict-schema AI roles.
- `apps/api/src/ats-adapters/hard-validator.ts`: non-AI schema/policy/control/section validation.
- `apps/api/src/ats-adapters/synthetic-replay-runner.ts`: isolated replay through the controlled browser path.
- `apps/api/src/ats-adapters/adapter-review-service.ts`: orchestration across proposal, replay, AI review, human decision, registry refresh, and retirement.
- `apps/api/src/ats-adapters/routes.ts`: sanitized review APIs only.
- `apps/web/src/applications/AdapterReviewPanel.tsx`: proposal/replay/AI/human review workbench.

### Task 1: Define strict adapter contracts and provenance

**Files:**
- Create: `packages/contracts/src/ats-adapter.ts`
- Create: `packages/contracts/src/ats-adapter.test.ts`
- Modify: `packages/contracts/src/index.ts`
- Modify: `packages/contracts/src/browser.ts`
- Modify: `packages/contracts/src/browser.test.ts`
- Modify: `packages/contracts/src/application.ts`
- Modify: `packages/contracts/src/application.test.ts`

**Interfaces:**
- Consumes: existing `PageSectionHintSchema`, `FormFieldSchema`, `ApplicationTaskSchema`, and Zod 3.
- Produces: `HintPackDefinition`, `CertifiedHintPack`, `AiHintPackProposal`, `ReplayReport`, `AiReplayReview`, `HumanCertificationDecision`, `AdapterReviewSummary`, and field provenance `{ packId, packVersion, confidence, certification: "certified" }`.

- [ ] **Step 1: Write failing contract tests that reject executable and uncertified provenance**

```typescript
import { describe, expect, it } from "vitest";
import {
  AiHintPackProposalSchema,
  CertifiedHintPackSchema,
  HumanCertificationDecisionSchema
} from "./ats-adapter.js";

const definition = {
  schemaVersion: 1 as const,
  packId: "mokahr-cn",
  version: "1.0.0",
  match: { sites: [{ hostSuffix: "mokahr.com", pathPrefixes: ["/"] }], stages: ["application_form"] },
  sectionRules: [{ section: "education", headingAliases: ["教育经历"], fieldOrderAliases: [["学校", "院校"]] }],
  fieldRules: [{ ruleId: "school", profilePath: "education[0].institution", labelAliases: ["毕业院校"], sections: ["education"], controlTypes: ["text"], confidence: 1 }],
  actionRules: [{ kind: "add_repeated_entry", verbs: ["添加", "新增"], sections: ["education"] }],
  fixtures: [{ fixtureId: "mokahr-basic", expectedProfilePaths: ["education[0].institution"] }]
};

describe("ATS adapter contracts", () => {
  it("keeps AI output candidate-only and selector-free", () => {
    const parsed = AiHintPackProposalSchema.parse({
      proposalId: "proposal-1", taskId: "task-1", lifecycleStatus: "candidate",
      provider: "deepseek", model: "deepseek-v4-flash", promptVersion: "hint-proposal-v1",
      inputHash: "a".repeat(64), outputHash: "b".repeat(64), definition,
      unsupportedBoundaries: [], rejectedActions: ["terminal_submit"], createdAt: "2026-08-17T00:00:00.000Z"
    });
    expect(parsed.lifecycleStatus).toBe("candidate");
    expect(() => AiHintPackProposalSchema.parse({ ...parsed, lifecycleStatus: "certified" })).toThrow();
    expect(() => AiHintPackProposalSchema.parse({ ...parsed, executableCommand: { type: "fill" } })).toThrow();
  });

  it("requires replay and human provenance for a certified pack", () => {
    expect(() => CertifiedHintPackSchema.parse({ ...definition, lifecycleStatus: "certified" })).toThrow();
  });

  it("requires acknowledgement on the AI-unavailable path", () => {
    expect(() => HumanCertificationDecisionSchema.parse({
      reviewId: "human-1", proposalId: "proposal-1", decision: "certify",
      reviewer: "local-user", aiReviewUnavailable: true, acknowledgedAiUnavailable: false,
      createdAt: "2026-08-17T00:00:00.000Z"
    })).toThrow(/acknowledge/iu);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify the new module is missing**

Run: `rtk pnpm --filter @resume/contracts test -- src/ats-adapter.test.ts`

Expected: FAIL with `Cannot find module './ats-adapter.js'`.

- [ ] **Step 3: Add the complete lifecycle and wire schemas**

```typescript
// packages/contracts/src/ats-adapter.ts
import { z } from "zod";
import { PageSectionHintSchema } from "./browser.js";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const SemverSchema = z.string().regex(/^\d+\.\d+\.\d+$/u);
const ControlTypeSchema = z.enum(["text", "textarea", "select", "radio", "checkbox", "date", "file"]);
export const HintPackRepeatSectionSchema = z.enum(["education", "work", "internship", "work_combined", "projects", "awards", "laboratory", "languages"]);
const HintPackSectionSchema = z.union([PageSectionHintSchema, z.literal("laboratory")]);

export const HintPackLifecycleStatusSchema = z.enum([
  "candidate", "replay_verified", "ai_reviewed", "human_reviewed", "certified", "rejected", "retired"
]);
export const HintPackDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  packId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/u),
  version: SemverSchema,
  match: z.object({
    sites: z.array(z.object({
      hostSuffix: z.string().min(1).max(253),
      pathPrefixes: z.array(z.string().startsWith("/").max(500)).min(1).max(50)
    }).strict()).min(1).max(20),
    stages: z.array(z.enum(["application_form", "review"])).min(1).max(2),
    requiredTextSignals: z.array(z.string().min(1).max(80)).max(30).default([]),
    pageFingerprintHashes: z.array(Sha256Schema).max(100).default([])
  }).strict(),
  sectionRules: z.array(z.object({
    section: HintPackSectionSchema,
    headingAliases: z.array(z.string().min(1).max(80)).min(1).max(30),
    fieldOrderAliases: z.array(z.array(z.string().min(1).max(80)).min(1).max(20)).max(50)
  }).strict()).max(30),
  fieldRules: z.array(z.object({
    ruleId: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/u),
    profilePath: z.string().regex(/^[a-z][a-zA-Z0-9]*(?:\[\d+\])?(?:\.[a-z][a-zA-Z0-9]*)*$/u),
    labelAliases: z.array(z.string().min(1).max(120)).min(1).max(30),
    sections: z.array(PageSectionHintSchema).max(10),
    controlTypes: z.array(ControlTypeSchema).min(1).max(7),
    confidence: z.number().min(0).max(1)
  }).strict()).max(500),
  actionRules: z.array(z.object({
    kind: z.enum(["add_repeated_entry", "intermediate_save", "intermediate_navigation"]),
    verbs: z.array(z.string().min(1).max(80)).min(1).max(20),
    sections: z.array(HintPackRepeatSectionSchema).min(1).max(20)
  }).strict()).max(50),
  fixtures: z.array(z.object({
    fixtureId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,63}$/u),
    expectedProfilePaths: z.array(z.string().min(1).max(512)).min(1).max(500)
  }).strict()).min(1).max(50)
}).strict();

export const AiHintPackProposalSchema = z.object({
  proposalId: z.string().min(1).max(128), taskId: z.string().min(1).max(128),
  parentProposalId: z.string().min(1).max(128).optional(),
  lifecycleStatus: z.literal("candidate"), provider: z.string().min(1).max(80), model: z.string().min(1).max(120),
  promptVersion: z.literal("hint-proposal-v1"), inputHash: Sha256Schema, outputHash: Sha256Schema,
  definition: HintPackDefinitionSchema, unsupportedBoundaries: z.array(z.string().min(1).max(120)).max(50),
  rejectedActions: z.array(z.enum(["unknown_side_effect", "terminal_submit"])).max(2),
  createdAt: z.string().datetime()
}).strict();

export const ReplayAssertionSchema = z.object({
  code: z.enum(["schema_valid", "policy_safe", "mapping_one_to_one", "control_type_compatible", "section_compatible", "target_value", "unrelated_unchanged", "repeat_order", "stable_readback", "boundary_paused", "challenge_paused", "zero_submit", "pii_free_trace"]),
  passed: z.boolean(), detail: z.string().min(1).max(1000)
}).strict();
export const ReplayReportSchema = z.object({
  reportId: z.string().min(1).max(128), proposalId: z.string().min(1).max(128), fixtureId: z.string().min(1).max(128),
  status: z.enum(["passed", "failed"]), assertions: z.array(ReplayAssertionSchema).min(1).max(1000),
  submissionCount: z.number().int().nonnegative(), inputHash: Sha256Schema, createdAt: z.string().datetime()
}).strict().superRefine((report, context) => {
  if ((report.status === "passed") !== report.assertions.every((item) => item.passed)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["status"], message: "status must equal deterministic assertion result" });
  }
});
export const AiReplayReviewSchema = z.object({
  reviewId: z.string().min(1).max(128), proposalId: z.string().min(1).max(128), reportId: z.string().min(1).max(128),
  recommendation: z.enum(["accept_for_human_review", "revise", "reject"]),
  findings: z.array(z.object({ code: z.string().min(1).max(80), severity: z.enum(["info", "warning", "error"]), explanation: z.string().min(1).max(1000) }).strict()).max(100),
  provider: z.string().min(1).max(80), model: z.string().min(1).max(120), promptVersion: z.literal("replay-review-v1"),
  inputHash: Sha256Schema, outputHash: Sha256Schema, createdAt: z.string().datetime()
}).strict();
export const HumanCertificationDecisionSchema = z.object({
  reviewId: z.string().min(1).max(128), proposalId: z.string().min(1).max(128),
  decision: z.enum(["certify", "reject", "revise"]), reviewer: z.string().min(1).max(128),
  aiReviewUnavailable: z.boolean(), acknowledgedAiUnavailable: z.boolean(), notes: z.string().max(4000).optional(),
  createdAt: z.string().datetime()
}).strict().superRefine((decision, context) => {
  if (decision.aiReviewUnavailable && decision.decision === "certify" && !decision.acknowledgedAiUnavailable) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["acknowledgedAiUnavailable"], message: "acknowledge AI-unavailable certification path" });
  }
});
export const CertifiedHintPackSchema = HintPackDefinitionSchema.extend({
  lifecycleStatus: z.literal("certified"), certifiedAt: z.string().datetime(),
  provenance: z.object({ proposalId: z.string(), replayReportIds: z.array(z.string()).min(1), humanReviewId: z.string(), aiReviewId: z.string().optional() }).strict()
}).strict();
export const AdapterReviewSummarySchema = z.object({
  proposal: AiHintPackProposalSchema.optional(), replayReports: z.array(ReplayReportSchema), aiReview: AiReplayReviewSchema.optional(),
  humanDecision: HumanCertificationDecisionSchema.optional(), lifecycleStatus: HintPackLifecycleStatusSchema,
  aiReviewUnavailable: z.boolean(), writeBlocked: z.literal(true)
}).strict();

export type HintPackDefinition = z.infer<typeof HintPackDefinitionSchema>;
export type CertifiedHintPack = z.infer<typeof CertifiedHintPackSchema>;
export type AiHintPackProposal = z.infer<typeof AiHintPackProposalSchema>;
export type ReplayReport = z.infer<typeof ReplayReportSchema>;
export type AiReplayReview = z.infer<typeof AiReplayReviewSchema>;
export type HumanCertificationDecision = z.infer<typeof HumanCertificationDecisionSchema>;
export type AdapterReviewSummary = z.infer<typeof AdapterReviewSummarySchema>;
export type HintPackRepeatSection = z.infer<typeof HintPackRepeatSectionSchema>;
```

Add `export * from "./ats-adapter.js";` to `packages/contracts/src/index.ts`. In `FormFieldSchema`, retain `dji_catalog` only for old serialized checkpoints and add certified provenance. A `superRefine` issue must require `semanticProvenance` whenever `semanticSource === "certified_hint"` and reject provenance for every other source:

```typescript
semanticSource: z.enum(["dji_catalog", "certified_hint"]).optional(),
semanticProvenance: z.object({
  packId: z.string().min(1).max(64), packVersion: z.string().min(1).max(32),
  confidence: z.number().min(0).max(1), certification: z.literal("certified")
}).strict().optional(),
```

Extend `ApplicationFieldAssessmentSchema.source` with `"certified_hint"` while retaining `"dji_catalog"` for old checkpoints, add the same provenance refinement, add `awaiting_adapter_review` to `ApplicationTaskStateSchema`, add command `resume_after_adapter_certification`, and add `adapterReview: AdapterReviewSummarySchema.optional()` to `ApplicationTaskSchema`. New runtime output must use only `certified_hint`; compatibility parsing must not grant certification to a candidate.

- [ ] **Step 4: Run all contract tests**

Run: `rtk pnpm --filter @resume/contracts test`

Expected: PASS, including rejection of extra keys, executable commands, uncertified provenance, inconsistent replay status, and unacknowledged AI-unavailable certification.

- [ ] **Step 5: Commit the contract boundary**

```bash
rtk git add packages/contracts/src
rtk git commit -m "feat: define certified ATS adapter contracts"
```

### Task 2: Replace hard-coded ATS branching with a certified-pack registry

**Files:**
- Create: `packages/form-semantics/src/hint-packs/registry.ts`
- Create: `packages/form-semantics/src/hint-packs/registry.test.ts`
- Create: `packages/form-semantics/src/hint-packs/runtime.ts`
- Create: `packages/form-semantics/src/hint-packs/runtime.test.ts`
- Create: `packages/form-semantics/src/hint-packs/mokahr-pack.ts`
- Create: `packages/form-semantics/src/hint-packs/dji-pack.ts`
- Modify: `packages/form-semantics/src/index.ts`
- Modify: `packages/form-semantics/src/mokahr-adapter.ts`
- Modify: `packages/form-semantics/src/mokahr-adapter.test.ts`
- Modify: `apps/api/src/applications/dji-field-catalog.ts`
- Modify: `apps/api/src/applications/dji-field-catalog.test.ts`

**Interfaces:**
- Consumes: `CertifiedHintPack`, `FormSnapshot`, `FormField`, and the current Mokahr section/action ordering behavior.
- Produces: `BUILT_IN_HINT_PACKS`, `createHintPackRegistry({ builtIns, local })`, `HintPackRegistry.resolve(snapshot)`, `applyCertifiedHintPack(snapshot, pack)`, and `classifyRepeatedActions(snapshot, pack)`.

- [ ] **Step 1: Write registry tests for specificity, immutability, and review-only fallback**

```typescript
it("selects DJI over the broader Mokahr pack and never resolves candidates", () => {
  const registry = createHintPackRegistry({ builtIns: [mokahrHintPack, djiHintPack], local: () => [], isRetired: () => false });
  const dji = registry.resolve(snapshot("https://apply.careers.dji.com/campus", ["毕业院校"]));
  expect(dji).toMatchObject({ kind: "certified", pack: { packId: "dji-campus", lifecycleStatus: "certified" } });

  const unknown = registry.resolve(snapshot("https://jobs.example.test/apply", ["姓名"]));
  expect(unknown).toEqual({ kind: "review_only", reason: "no_certified_pack", mismatchedPacks: [] });
  expect(Object.isFrozen((dji as { pack: object }).pack)).toBe(true);
});

it("annotates DJI fields with generic certified provenance", () => {
  const result = applyCertifiedHintPack(snapshot("https://apply.careers.dji.com/campus", ["毕业院校"]), djiHintPack);
  expect(result.fields[0]).toMatchObject({
    semanticHint: "education[0].institution", semanticSource: "certified_hint",
    semanticProvenance: { packId: "dji-campus", packVersion: "1.0.0", certification: "certified", confidence: 1 }
  });
});
```

- [ ] **Step 2: Verify the tests fail before registry exports exist**

Run: `rtk pnpm --filter @resume/form-semantics test -- src/hint-packs/registry.test.ts src/hint-packs/runtime.test.ts`

Expected: FAIL with missing `hint-packs/registry.js` and `hint-packs/runtime.js`.

- [ ] **Step 3: Implement deterministic registry resolution and runtime application**

```typescript
// packages/form-semantics/src/hint-packs/registry.ts
import { createHash } from "node:crypto";
import type { CertifiedHintPack, FormSnapshot } from "@resume/contracts";

export type HintPackResolution =
  | { kind: "certified"; pack: CertifiedHintPack }
  | { kind: "review_only"; reason: "no_certified_pack"; mismatchedPacks: [] }
  | { kind: "review_only"; reason: "fingerprint_mismatch"; mismatchedPacks: Array<{ packId: string; version: string }> };
export interface HintPackRegistry {
  resolve(snapshot: FormSnapshot): HintPackResolution;
  listCertified(): readonly CertifiedHintPack[];
}

export function createHintPackRegistry(input: { builtIns: readonly CertifiedHintPack[]; local: () => readonly CertifiedHintPack[]; isRetired: (packId: string, version: string) => boolean }): HintPackRegistry {
  const builtIns = input.builtIns.map((pack) => deepFreeze(structuredClone(pack)));
  const all = () => [...builtIns, ...input.local().map((pack) => deepFreeze(structuredClone(pack)))]
    .filter((pack) => pack.lifecycleStatus === "certified" && !input.isRetired(pack.packId, pack.version))
    .sort((left, right) => specificity(right) - specificity(left));
  return {
    resolve(snapshot) {
      const url = new URL(snapshot.url);
      const text = normalize([snapshot.title, ...snapshot.fields.map((field) => `${field.sectionHint ?? ""} ${field.label}`), ...snapshot.actions.map((action) => `${action.context ?? ""} ${action.text}`)].join(" "));
      const fingerprint = fingerprintSnapshot(snapshot);
      const siteCandidates = all().filter((candidate) => candidate.match.stages.includes(snapshot.stage as "application_form" | "review")
        && candidate.match.sites.some((site) => hostMatches(url.hostname, site.hostSuffix)
          && site.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix)))
        && candidate.match.requiredTextSignals.every((signal) => text.includes(normalize(signal))));
      const pack = siteCandidates.find((candidate) => candidate.match.pageFingerprintHashes.length === 0
        || candidate.match.pageFingerprintHashes.includes(fingerprint));
      if (pack !== undefined) return { kind: "certified", pack };
      return siteCandidates.length > 0
        ? { kind: "review_only", reason: "fingerprint_mismatch", mismatchedPacks: siteCandidates.map(({ packId, version }) => ({ packId, version })) }
        : { kind: "review_only", reason: "no_certified_pack", mismatchedPacks: [] };
    },
    listCertified: () => all()
  };
}

export function fingerprintSnapshot(snapshot: FormSnapshot): string {
  const canonical = JSON.stringify({ stage: snapshot.stage, fields: snapshot.fields.map((field) => [normalize(field.label), field.type, field.sectionHint ?? null]), actions: snapshot.actions.map((action) => [normalize(action.text), action.class]) });
  return createHash("sha256").update(canonical).digest("hex");
}

function hostMatches(host: string, suffix: string): boolean {
  const normalizedHost = host.toLowerCase();
  const normalizedSuffix = suffix.toLowerCase();
  return normalizedHost === normalizedSuffix || normalizedHost.endsWith(`.${normalizedSuffix}`);
}
function specificity(pack: CertifiedHintPack): number {
  return Math.max(...pack.match.sites.flatMap((site) => site.pathPrefixes.map((path) => site.hostSuffix.length + path.length)));
}
function normalize(value: string): string { return value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase(); }
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}
```

```typescript
// packages/form-semantics/src/hint-packs/runtime.ts
import type { CertifiedHintPack, FormField, FormSnapshot, HintPackRepeatSection } from "@resume/contracts";

export function applyCertifiedHintPack(snapshot: FormSnapshot, pack: CertifiedHintPack): FormSnapshot {
  return { ...snapshot, fields: snapshot.fields.map((field) => annotate(field, pack)) };
}
export function classifyRepeatedActions(snapshot: FormSnapshot, pack: CertifiedHintPack): Array<{ actionId: string; section: HintPackRepeatSection }> {
  return snapshot.actions.flatMap((action) => pack.actionRules.flatMap((rule) => {
    if (rule.kind !== "add_repeated_entry" || !rule.verbs.some((verb) => normalize(action.text).includes(normalize(verb)))) return [];
    const context = normalize(`${action.context ?? ""} ${action.text}`);
    const section = rule.sections.find((candidateSection) => pack.sectionRules.some((candidate) =>
      candidate.section === candidateSection && candidate.headingAliases.some((alias) => context.includes(normalize(alias)))));
    return section === undefined ? [] : [{ actionId: action.id, section }];
  }));
}
function annotate(field: FormField, pack: CertifiedHintPack): FormField {
  const label = normalize(field.label);
  const rule = pack.fieldRules.find((candidate) => candidate.controlTypes.includes(field.type)
    && candidate.labelAliases.some((alias) => normalize(alias) === label)
    && (candidate.sections.length === 0 || field.sectionHint !== undefined && candidate.sections.includes(field.sectionHint)));
  return rule === undefined ? field : { ...field, semanticHint: rule.profilePath, semanticSource: "certified_hint", semanticProvenance: {
    packId: pack.packId, packVersion: pack.version, confidence: rule.confidence, certification: "certified"
  } };
}
function normalize(value: string): string { return value.normalize("NFKC").replace(/\s+/gu, "").trim(); }
```

Define `mokahrHintPack` and `djiHintPack` with the exact aliases currently present in `SECTION_SIGNALS`, `FIELD_ORDER`, and `CATALOG`. Give DJI more-specific hosts/path prefixes and the five current semantic mappings. Keep localhost out of production packs; browser tests inject test-only clones with synthetic origins through `ProductionAdapterDependencies.hintPacks`. Export `BUILT_IN_HINT_PACKS = [djiHintPack, mokahrHintPack] as const`; leave deprecated wrapper exports in `mokahr-adapter.ts` and `dji-field-catalog.ts` for one release, implemented by the new pack runtime, so every Task 2 commit still builds.

The declarative source-controlled constants must contain these exact current aliases (the implementation may factor the arrays into shared constants):

```typescript
const MOKAHR_SECTIONS = [
  { section: "education", headingAliases: ["教育经历", "教育背景", "教育信息"], fieldOrderAliases: [["学校", "院校", "毕业院校"], ["学历"], ["专业"], ["开始时间", "入学时间"], ["结束时间", "毕业时间"], ["成绩", "GPA"], ["描述", "说明"]] },
  { section: "work_combined", headingAliases: ["工作/实习经历", "实习/工作经历"], fieldOrderAliases: [["公司", "单位"], ["职位", "岗位", "职务"], ["工作类型", "用工类型", "实习类型"], ["开始时间"], ["结束时间"], ["地点", "所在地"], ["职责"], ["成果", "业绩", "成就"]] },
  { section: "internship", headingAliases: ["实习经历"], fieldOrderAliases: [["公司", "单位"], ["职位", "岗位", "职务"], ["实习类型", "用工类型"], ["开始时间"], ["结束时间"], ["地点", "所在地"], ["职责"], ["成果", "业绩", "成就"]] },
  { section: "work", headingAliases: ["正式工作经历", "工作经历"], fieldOrderAliases: [["公司", "单位"], ["职位", "岗位", "职务"], ["工作类型", "用工类型", "实习类型"], ["开始时间"], ["结束时间"], ["地点", "所在地"], ["职责"], ["成果", "业绩", "成就"]] },
  { section: "projects", headingAliases: ["项目经历", "项目经验", "项目背景"], fieldOrderAliases: [["项目名称", "项目名"], ["开始时间"], ["结束时间"], ["项目描述", "项目简介", "描述"], ["技术栈", "技术", "开发工具"], ["项目要点", "项目成果", "项目职责", "职责", "亮点"]] },
  { section: "awards", headingAliases: ["获奖经历", "获奖信息", "赛事经历", "竞赛经历", "奖项经历"], fieldOrderAliases: [["获奖名称", "奖项名称", "赛事名称", "比赛名称"], ["获奖时间", "奖项时间", "赛事时间"], ["奖项级别", "获奖级别"], ["获奖描述", "奖项描述", "赛事描述"]] },
  { section: "laboratory", headingAliases: ["实验室经历", "科研经历", "研究经历"], fieldOrderAliases: [["实验室名称", "科研名称", "研究方向"], ["开始时间"], ["结束时间"], ["描述", "成果", "职责"]] },
  { section: "languages", headingAliases: ["语言能力", "外语能力"], fieldOrderAliases: [["语种", "语言"], ["等级", "水平"], ["证书", "考试"], ["分数", "成绩"]] }
] as const;
const MOKAHR_ACTION_RULES = [{ kind: "add_repeated_entry", verbs: ["添加", "新增"], sections: ["education", "work", "internship", "work_combined", "projects", "awards", "laboratory", "languages"] }] as const;
const DJI_FIELD_RULES = [
  { ruleId: "name", profilePath: "basics.name", labelAliases: ["姓名"], sections: ["basics"], controlTypes: ["text"], confidence: 1 },
  { ruleId: "phone", profilePath: "basics.phone", labelAliases: ["手机号码"], sections: ["basics"], controlTypes: ["text"], confidence: 1 },
  { ruleId: "school", profilePath: "education[0].institution", labelAliases: ["毕业院校"], sections: ["education"], controlTypes: ["text"], confidence: 1 },
  { ruleId: "project", profilePath: "projects[0].name", labelAliases: ["项目名称"], sections: ["projects"], controlTypes: ["text"], confidence: 1 },
  { ruleId: "award-level", profilePath: "awards[0].level", labelAliases: ["获奖级别"], sections: ["awards"], controlTypes: ["select", "radio"], confidence: 1 }
] as const;
```

`mokahrHintPack` uses `sites: [{ hostSuffix: "mokahr.com", pathPrefixes: ["/"] }]`, `requiredTextSignals: []`, the section/action constants, an empty `fieldRules` array, and fixture `mokahr-basic`. `djiHintPack` uses three coupled site rules: `apply.careers.dji.com` with `/`, `careers.dji.com` with `/`, and `app.mokahr.com` with `/campus-recruitment/dji/`; it uses `requiredTextSignals: []`, the shared section/action constants plus `DJI_FIELD_RULES`, and fixture `dji-basic`. Both include `lifecycleStatus: "certified"`, a source-controlled human review ID, and at least one source-controlled replay report ID.

- [ ] **Step 4: Run semantics and DJI regression tests**

Run: `rtk pnpm --filter @resume/form-semantics test`

Run: `rtk pnpm --filter @resume/api test -- src/applications/entry-field-semantics.test.ts`

Expected: PASS; current Mokahr section ordering, repeated-add classification, and DJI five-field mappings are unchanged except provenance is now `certified_hint`.

- [ ] **Step 5: Commit the registry extraction**

```bash
rtk git add packages/form-semantics packages/contracts apps/api/src/applications/dji-field-catalog.ts apps/api/src/applications/dji-field-catalog.test.ts
rtk git commit -m "refactor: register Moka and DJI hint packs"
```

### Task 3: Persist the certification ledger and encrypted debug responses

**Files:**
- Create: `apps/api/src/ats-adapters/adapter-ledger.ts`
- Create: `apps/api/src/ats-adapters/adapter-ledger.test.ts`
- Create: `apps/api/src/ats-adapters/debug-raw-store.ts`
- Create: `apps/api/src/ats-adapters/debug-raw-store.test.ts`
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/db/migrate.test.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `apps/api/src/config.test.ts`

**Interfaces:**
- Consumes: strict Task 1 schemas and `SqliteDatabase`.
- Produces: `createAdapterLedger(database): AdapterLedger`, `createDebugRawStore(database, config): DebugRawStore`, immutable certified pack listing, lifecycle transition checks, encrypted retention, expiry purge, and read audits.

```typescript
export interface AdapterLedger {
  createProposal(proposal: AiHintPackProposal): void;
  findProposal(proposalId: string): AiHintPackProposal | undefined;
  findReviewSummary(proposalId: string): AdapterReviewSummary | undefined;
  findActiveByFingerprint(taskId: string, inputHash: string): AdapterReviewSummary | undefined;
  recordReplay(reports: readonly ReplayReport[]): void;
  recordAiReview(review: AiReplayReview): void;
  recordHumanDecision(decision: HumanCertificationDecision): void;
  certify(proposalId: string): CertifiedHintPack;
  retire(packId: string, version: string, reason: string): void;
  isRetired(packId: string, version: string): boolean;
  listCertified(): readonly CertifiedHintPack[];
}
```

- [ ] **Step 1: Write failing repository and encryption tests**

```typescript
it("refuses certification before replay and human review", () => {
  const ledger = createAdapterLedger(database);
  ledger.createProposal(proposal());
  expect(() => ledger.certify("proposal-1")).toThrowError("adapter_transition_denied");
});

it("retains ciphertext for at most 168 hours and audits every read", () => {
  const store = createDebugRawStore(database, {
    enabled: true, encryptionKey: Buffer.alloc(32, 7), ttlHours: 24, now: () => new Date("2026-08-17T00:00:00.000Z")
  });
  const id = store.retain({ proposalId: "proposal-1", purpose: "proposal", plaintext: "raw model body" });
  expect(database.prepare("SELECT ciphertext FROM ats_adapter_debug_responses WHERE id = ?").get(id)).not.toMatchObject({ ciphertext: "raw model body" });
  expect(store.read(id, "local-reviewer")).toBe("raw model body");
  expect(database.prepare("SELECT COUNT(*) AS count FROM ats_adapter_debug_accesses WHERE response_id = ?").get(id)).toEqual({ count: 1 });
  expect(() => createDebugRawStore(database, { enabled: true, encryptionKey: Buffer.alloc(32), ttlHours: 169 })).toThrow(/168/u);
});
```

- [ ] **Step 2: Verify migration/repository tests fail**

Run: `rtk pnpm --filter @resume/api test -- src/db/migrate.test.ts src/ats-adapters/adapter-ledger.test.ts src/ats-adapters/debug-raw-store.test.ts`

Expected: FAIL because the ledger tables and modules do not exist.

- [ ] **Step 3: Add ledger tables, constraints, cleanup, and transactional transitions**

Add these tables inside `migrateDatabase` (all JSON columns include `CHECK (json_valid(...))`):

```sql
CREATE TABLE IF NOT EXISTS ats_adapter_proposals (
  proposal_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, parent_proposal_id TEXT,
  pack_id TEXT NOT NULL, version TEXT NOT NULL, lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN (
    'candidate','replay_verified','ai_reviewed','human_reviewed','certified','rejected','retired'
  )), provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
  input_hash TEXT NOT NULL, output_hash TEXT NOT NULL, payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE (pack_id, version)
);
CREATE TABLE IF NOT EXISTS ats_adapter_replay_reports (
  report_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL REFERENCES ats_adapter_proposals(proposal_id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('passed','failed')), payload_json TEXT NOT NULL CHECK (json_valid(payload_json)), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ats_adapter_ai_reviews (
  review_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES ats_adapter_proposals(proposal_id) ON DELETE CASCADE,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ats_adapter_human_reviews (
  review_id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL UNIQUE REFERENCES ats_adapter_proposals(proposal_id) ON DELETE CASCADE,
  decision TEXT NOT NULL CHECK (decision IN ('certify','reject','revise')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ats_adapter_certified_packs (
  pack_id TEXT NOT NULL, version TEXT NOT NULL, lifecycle_status TEXT NOT NULL CHECK (lifecycle_status IN ('certified','retired')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)), certified_at TEXT NOT NULL, retired_at TEXT, retirement_reason TEXT,
  PRIMARY KEY (pack_id, version)
);
CREATE TABLE IF NOT EXISTS ats_adapter_pack_retirements (
  pack_id TEXT NOT NULL, version TEXT NOT NULL, reason TEXT NOT NULL,
  retired_at TEXT NOT NULL, PRIMARY KEY (pack_id, version)
);
CREATE TABLE IF NOT EXISTS ats_adapter_debug_responses (
  id TEXT PRIMARY KEY, proposal_id TEXT NOT NULL, purpose TEXT NOT NULL CHECK (purpose IN ('proposal','replay_review')),
  ciphertext BLOB NOT NULL, iv BLOB NOT NULL, auth_tag BLOB NOT NULL, expires_at TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ats_adapter_debug_accesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT, response_id TEXT NOT NULL,
  actor TEXT NOT NULL, accessed_at TEXT NOT NULL
);
```

Implement the transition authority so `recordReplay` moves to `replay_verified` only when every required fixture report passes, `recordAiReview` accepts only `replay_verified`, `recordHumanDecision` accepts `ai_reviewed` or explicitly acknowledged AI-unavailable `replay_verified`, and `certify` requires a `human_reviewed` decision of `certify`. `certify` inserts a new immutable row. `retire` inserts an immutable tombstone into `ats_adapter_pack_retirements` (so source-controlled built-ins can also be quarantined) and updates a matching local certified row to `retired`; `isRetired` checks the tombstone table.

- [ ] **Step 4: Implement AES-256-GCM retention and configuration validation**

```typescript
const DEFAULT_TTL_HOURS = 24;
const MAX_TTL_HOURS = 168;

export function createDebugRawStore(database: SqliteDatabase, config: DebugRawStoreConfig): DebugRawStore {
  const ttlHours = config.ttlHours ?? DEFAULT_TTL_HOURS;
  if (!Number.isInteger(ttlHours) || ttlHours < 1 || ttlHours > MAX_TTL_HOURS) throw new Error("debug_raw_ttl_must_be_1_to_168_hours");
  if (config.enabled && config.encryptionKey?.byteLength !== 32) throw new Error("debug_raw_key_must_be_32_bytes");
  return {
    retain(input) {
      if (!config.enabled || !config.encryptionKey) return undefined;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", config.encryptionKey, iv);
      const ciphertext = Buffer.concat([cipher.update(input.plaintext, "utf8"), cipher.final()]);
      const id = randomUUID();
      insert.run(id, input.proposalId, input.purpose, ciphertext, iv, cipher.getAuthTag(), expiresAt(config.now?.() ?? new Date(), ttlHours), nowIso(config));
      return id;
    },
    read(id, actor) {
      const row = find.get(id);
      if (!row) return undefined;
      audit.run(id, actor, nowIso(config));
      if (Date.parse(row.expires_at) <= (config.now?.() ?? new Date()).getTime()) return undefined;
      const decipher = createDecipheriv("aes-256-gcm", config.encryptionKey!, row.iv);
      decipher.setAuthTag(row.auth_tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString("utf8");
    },
    purgeExpired() { return removeExpired.run(nowIso(config)).changes; }
  };
}
```

Extend `ApiConfig` with optional `atsAdapterDebug` and parse `ATS_ADAPTER_DEBUG_RAW=1`, `ATS_ADAPTER_DEBUG_KEY_BASE64`, and `ATS_ADAPTER_DEBUG_TTL_HOURS`; reject a decoded key not exactly 32 bytes and reject TTL outside `1..168`. Do not log the decoded key or raw response.

- [ ] **Step 5: Run repository, migration, and configuration tests**

Run: `rtk pnpm --filter @resume/api test -- src/db/migrate.test.ts src/config.test.ts src/ats-adapters/adapter-ledger.test.ts src/ats-adapters/debug-raw-store.test.ts`

Expected: PASS, including migration from a pre-challenge database, legal/illegal transitions, immutable certified versions, retirement, encrypted storage, expiry, and audited reads.

- [ ] **Step 6: Commit the durable audit boundary**

```bash
rtk git add apps/api/src/db apps/api/src/config.ts apps/api/src/config.test.ts apps/api/src/ats-adapters
rtk git commit -m "feat: persist ATS adapter certification ledger"
```

### Task 4: Sanitize observations and add separate AI proposal/review roles

**Files:**
- Create: `apps/api/src/ats-adapters/observation-sanitizer.ts`
- Create: `apps/api/src/ats-adapters/observation-sanitizer.test.ts`
- Create: `apps/api/src/ats-adapters/ai-proposal-service.ts`
- Create: `apps/api/src/ats-adapters/ai-proposal-service.test.ts`
- Create: `apps/api/src/ats-adapters/ai-replay-review-service.ts`
- Create: `apps/api/src/ats-adapters/ai-replay-review-service.test.ts`
- Modify: `packages/model-provider/src/provider.ts`
- Modify: `packages/model-provider/src/deepseek-provider.ts`
- Modify: `packages/model-provider/src/deepseek-provider.test.ts`
- Modify: `apps/api/src/production-dependencies.ts`
- Modify: `apps/api/src/production-dependencies.test.ts`

**Interfaces:**
- Consumes: `StructuredModelProvider`, Task 1 schemas, `AdapterLedger`, `DebugRawStore`, and a fresh `FormSnapshot`.
- Produces: `sanitizeAdapterObservation(snapshot, profilePaths)`, `createAiProposalService(...)`, `createAiReplayReviewService(...)`, and optional provider raw-response observation keyed by `{ requestId, purpose }`.

- [ ] **Step 1: Write failing sanitizer and authority tests**

```typescript
it("removes values, node references, URLs with query data, and common PII", () => {
  const safe = sanitizeAdapterObservation(snapshotWith({
    url: "https://jobs.example.test/apply?token=secret", label: "联系 13800138000 user@example.com",
    currentValue: "真实姓名", nodeRef: { documentId: "document-secret", nodeId: "node-secret", observedAt: 1 }
  }), ["basics.name"]);
  const serialized = JSON.stringify(safe);
  expect(serialized).not.toMatch(/真实姓名|13800138000|user@example\.com|secret|node-secret|document-secret/u);
  expect(safe.origin).toBe("https://jobs.example.test");
});

it("does not call AI review or advance lifecycle when a hard assertion failed", async () => {
  await expect(reviewer.review(proposal(), failedReplayReport())).rejects.toThrow("hard_gate_failed");
  expect(provider.generateStructured).not.toHaveBeenCalled();
  expect(ledger.recordAiReview).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify the new service tests fail**

Run: `rtk pnpm --filter @resume/api test -- src/ats-adapters/observation-sanitizer.test.ts src/ats-adapters/ai-proposal-service.test.ts src/ats-adapters/ai-replay-review-service.test.ts`

Expected: FAIL with missing sanitizer and service modules.

- [ ] **Step 3: Implement the allowlisted sanitizer and stable fingerprint**

```typescript
export interface SanitizedAdapterObservation {
  schemaVersion: 1;
  origin: string;
  pathShape: string;
  stage: FormSnapshot["stage"];
  pageFingerprintHash: string;
  fields: Array<{ observedFieldId: string; label: string; type: FormField["type"]; required: boolean; optionCount: number; section?: string }>;
  actions: Array<{ observedActionId: string; text: string; actionClass: PageAction["class"] }>;
  boundaries: Array<{ kind: string; blocked: boolean }>;
  profilePaths: string[];
}

export function sanitizeAdapterObservation(snapshot: FormSnapshot, profilePaths: readonly string[]): SanitizedAdapterObservation {
  const url = new URL(snapshot.url);
  const fields = snapshot.fields.map((field, index) => ({
    observedFieldId: `field-${index + 1}`, label: sanitizeText(field.label), type: field.type,
    required: field.required, optionCount: field.options.length,
    ...(field.sectionHint === undefined ? {} : { section: field.sectionHint })
  }));
  const actions = snapshot.actions.map((action, index) => ({
    observedActionId: `action-${index + 1}`, text: sanitizeText(action.text), actionClass: action.class
  }));
  const canonical = JSON.stringify({ host: url.hostname.toLowerCase(), pathShape: pathShape(url.pathname), stage: snapshot.stage, fields, actions });
  return { schemaVersion: 1, origin: url.origin, pathShape: pathShape(url.pathname), stage: snapshot.stage,
    pageFingerprintHash: createHash("sha256").update(canonical).digest("hex"), fields, actions,
    boundaries: (snapshot.boundaries ?? []).map(({ kind, blocked }) => ({ kind, blocked })),
    profilePaths: [...new Set(profilePaths)].sort() };
}
function sanitizeText(value: string): string {
  return value.normalize("NFKC").replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu, "[redacted-email]")
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/gu, "[redacted-phone]").replace(/\s+/gu, " ").trim().slice(0, 120);
}
```

The serialized AI input is built only from `SanitizedAdapterObservation`; never spread a `FormSnapshot` into a prompt.

- [ ] **Step 4: Add provider correlation and encrypted raw-response observation**

```typescript
// packages/model-provider/src/provider.ts
export interface StructuredGenerationInput<T> {
  system: string; user: string; schema: z.ZodType<T>; jsonExample: unknown;
  metadata?: { requestId: string; purpose: "adapter_proposal" | "adapter_replay_review" | "self_evaluation" };
}
export interface RawStructuredResponse {
  requestId: string; purpose: NonNullable<StructuredGenerationInput<unknown>["metadata"]>["purpose"];
  model: string; content: string;
}
```

Add `observeRawResponse?: (response: RawStructuredResponse) => Promise<void> | void` to `DeepSeekProviderDependencies`. In `request`, immediately after checking non-empty `content`, invoke it only when metadata exists:

```typescript
if (input.metadata && this.observeRawResponse) {
  await this.observeRawResponse({ ...input.metadata, model, content });
}
```

Production wiring passes an observer only when debug retention is explicitly enabled; it maps `adapter_proposal` to `proposal` and `adapter_replay_review` to `replay_review`. Self-evaluation raw responses are not retained by this ATS-specific store.

- [ ] **Step 5: Implement two strict AI services**

`createAiProposalService` calls `generateStructured` with `HintPackDefinitionSchema`, combines the parsed definition with server-generated IDs/hashes/provenance, re-parses `AiHintPackProposalSchema`, and persists it. Its system prompt explicitly forbids values, selectors, `NodeRef`, commands, terminal submit, network requests, and scripts.

`createAiReplayReviewService` first executes this hard guard and never catches it as an AI availability issue:

```typescript
if (report.status !== "passed" || report.assertions.some((assertion) => !assertion.passed)) {
  throw new Error("hard_gate_failed");
}
```

It then sends only the sanitized proposal definition and sanitized assertion report to `AiReplayReviewSchema`. Provider errors return `{ kind: "unavailable", lifecycleStatus: "replay_verified" }` without calling `recordAiReview`; successful parsing calls `recordAiReview` and returns `{ kind: "reviewed", lifecycleStatus: "ai_reviewed", review }`.

- [ ] **Step 6: Run model-provider and AI service tests**

Run: `rtk pnpm --filter @resume/model-provider test`

Run: `rtk pnpm --filter @resume/api test -- src/ats-adapters`

Expected: PASS; prompts contain no fixture profile values, raw capture is opt-in and correlated, invalid AI JSON is rejected, hard failures cannot be overridden, and unavailable AI leaves `replay_verified`.

- [ ] **Step 7: Commit the AI boundary**

```bash
rtk git add packages/model-provider apps/api/src/ats-adapters apps/api/src/production-dependencies.ts apps/api/src/production-dependencies.test.ts
rtk git commit -m "feat: generate sanitized ATS adapter proposals"
```

### Task 5: Add deterministic hard validation and isolated synthetic replay

**Files:**
- Create: `apps/api/src/ats-adapters/hard-validator.ts`
- Create: `apps/api/src/ats-adapters/hard-validator.test.ts`
- Create: `apps/api/src/ats-adapters/synthetic-replay-runner.ts`
- Create: `apps/api/src/ats-adapters/synthetic-replay-runner.test.ts`
- Modify: `apps/synthetic-ats/src/server.ts`
- Modify: `apps/synthetic-ats/src/server.test.ts`
- Modify: `apps/synthetic-ats/package.json`
- Modify: `apps/api/package.json`
- Create: `scripts/copy-synthetic-ats-assets.mjs`
- Modify: `pnpm-lock.yaml`
- Create: `tests/browser/ats-adapter-replay.spec.ts`

**Interfaces:**
- Consumes: candidate definition, sanitized fixture ID, `ActionPolicy`, isolated `BrowserWorkerClient`, and `SyntheticAtsServer.state(taskId)`.
- Produces: `validateHintPackCandidate(input: unknown): ReplayAssertion[]` and `SyntheticReplayRunner.run(proposal): Promise<{ taskId: string; reports: ReplayReport[] }>`.

- [ ] **Step 1: Write failing hard-gate tests**

```typescript
it.each([
  ["terminal action", candidateWithAction("terminal_submit"), "schema_valid"],
  ["unknown action", candidateWithAction("unknown_side_effect"), "schema_valid"],
  ["type mismatch", candidateMapping("graduationDate", ["file"]), "control_type_compatible"],
  ["section mismatch", candidateMapping("education[0].institution", ["work"]), "section_compatible"],
  ["duplicate mapping", candidateWithDuplicateObservedField(), "mapping_one_to_one"]
])("rejects %s", (_name, candidate, code) => {
  expect(validateHintPackCandidate(candidate)).toContainEqual(expect.objectContaining({ code, passed: false }));
});
```

- [ ] **Step 2: Write a failing browser replay that proves zero unrelated writes and zero submission**

```typescript
test("candidate pack fills marker values through controlled execution without submitting", async ({ page }) => {
  const replay = await harness.run(proposalFor("adapter-replay-basic"));
  const state = synthetic.state(replay.taskId);
  expect(state.runtime.values).toMatchObject({ name: "MARKER_basics_name", school: "MARKER_education_0_institution" });
  expect(state.runtime.values.unrelatedSentinel).toBe("UNCHANGED");
  expect(state.runtime.writeCounts.unrelatedSentinel ?? 0).toBe(0);
  expect(state.submissionCount).toBe(0);
  expect(replay.reports.flatMap((report) => report.assertions).every((assertion) => assertion.passed)).toBe(true);
});
```

- [ ] **Step 3: Verify unit and browser tests fail before implementation**

Run: `rtk pnpm --filter @resume/api test -- src/ats-adapters/hard-validator.test.ts src/ats-adapters/synthetic-replay-runner.test.ts`

Run: `rtk pnpm test:e2e -- tests/browser/ats-adapter-replay.spec.ts`

Expected: FAIL because validator, fixture scenario, and runner do not exist.

- [ ] **Step 4: Implement hard validation without consulting AI**

```typescript
export function validateHintPackCandidate(input: unknown): ReplayAssertion[] {
  const parsed = HintPackDefinitionSchema.safeParse(input);
  if (!parsed.success) return [{ code: "schema_valid", passed: false, detail: parsed.error.issues.map((issue) => issue.path.join(".")).join(", ") }];
  const definition = parsed.data;
  const assertions: ReplayAssertion[] = [];
  assertions.push(assertion("schema_valid", true, "candidate matches HintPackDefinitionSchema"));
  assertions.push(assertion("policy_safe", definition.fieldRules.length + definition.actionRules.length > 0
    && definition.actionRules.every((rule) => ["add_repeated_entry", "intermediate_save", "intermediate_navigation"].includes(rule.kind)),
  "candidate must contain a field or action rule; terminal and unknown-side-effect actions are forbidden"));
  const identities = definition.fieldRules.map((rule) => `${rule.profilePath}|${rule.sections.join(",")}|${rule.labelAliases.join(",")}`);
  assertions.push(assertion("mapping_one_to_one", new Set(identities).size === identities.length, "field-rule identities must be unique"));
  for (const rule of definition.fieldRules) {
    assertions.push(assertion("control_type_compatible", ontologyAllows(rule.profilePath, rule.controlTypes), `${rule.ruleId} control types must match profile ontology`));
    assertions.push(assertion("section_compatible", sectionsAllow(rule.profilePath, rule.sections), `${rule.ruleId} sections must match profile root`));
  }
  return assertions;
}
```

Use explicit ontology maps for known profile roots; unknown roots fail closed. Schema parsing runs before these checks. No AI result can mutate these assertions.

- [ ] **Step 5: Extend the synthetic ATS with marker fixtures and observable safety counters**

Export `startSyntheticAts` from `apps/synthetic-ats/package.json` and change it to `startSyntheticAts(options?: { fixtureRoot?: URL }): Promise<SyntheticAtsServer>`. Add `/adapter-replay/:fixtureId`, an `unrelatedSentinel: "UNCHANGED"`, per-control `writeCounts`, readback snapshots, repeated-section order, boundary/challenge scenarios, and the existing `submissionCount`. The route accepts only fixture IDs declared in the candidate pack and never accepts profile values over HTTP.

Because the API is bundled, copy `apps/synthetic-ats/public` into `apps/api/dist/synthetic-ats-public` during `@resume/api` build with `scripts/copy-synthetic-ats-assets.mjs`. In development pass `new URL("../../synthetic-ats/public/", import.meta.url)`; in the bundled server pass `new URL("./synthetic-ats-public/", import.meta.url)`. Add a production-dependencies test that asserts both URL branches and a build-level test that all referenced fixture files exist after copying; do not rely on source-tree paths at runtime.

```javascript
// scripts/copy-synthetic-ats-assets.mjs
import { cp, mkdir, rm } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const source = resolve(repositoryRoot, "apps/synthetic-ats/public");
const target = resolve(repositoryRoot, "apps/api/dist/synthetic-ats-public");
if (relative(repositoryRoot, source).startsWith("..") || relative(repositoryRoot, target).startsWith("..")) {
  throw new Error("synthetic ATS asset path escaped repository root");
}
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
```

- [ ] **Step 6: Implement the isolated replay runner**

The runner starts its own synthetic server and browser worker with a new random approval key and a profile directory created by `mkdtemp(join(tmpdir(), "resume-ats-replay-"))`. A `finally` block stops the worker, closes the server, and removes exactly that resolved temporary directory with `rm(profileDirectory, { recursive: true, force: true })`. For each fixture it:

1. Opens the synthetic fixture.
2. Observes a fresh snapshot and applies the candidate definition only in the isolated replay context.
3. Generates marker values from profile paths (`MARKER_${profilePath.replace(/\W/g, "_")}`).
4. Uses `ActionPolicy.approve` and the browser worker `execute` method for writes.
5. Observes twice after stability, executes repeated actions only when allowed, and stops on challenges/boundaries.
6. Converts state counters to `ReplayAssertion` rows and forces `status: "failed"` if any assertion fails.
7. Asserts `submissionCount === 0` in `finally`, then stops the worker and synthetic server.

```typescript
const assertions: ReplayAssertion[] = [
  checkTargets(expected, state.runtime.values),
  checkUnrelated(initial, state.runtime.values, state.runtime.writeCounts),
  checkRepeatOrder(expectedOrder, state.runtime.repeatOrder),
  checkStableReadback(firstRead, secondRead),
  checkBoundaryPause(observed.boundaries, executionResults),
  checkChallengePause(observed.challenge, executionResults),
  { code: "zero_submit", passed: state.submissionCount === 0, detail: `submissionCount=${state.submissionCount}` },
  { code: "pii_free_trace", passed: traceIsSanitized(trace), detail: "trace contains marker IDs and hashes only" }
];
```

- [ ] **Step 7: Run replay, challenge, and stability suites**

Run: `rtk pnpm --filter @resume/synthetic-ats test`

Run: `rtk pnpm --filter @resume/api test -- src/ats-adapters`

Run: `rtk pnpm test:e2e -- tests/browser/ats-adapter-replay.spec.ts tests/browser/application-stability.spec.ts tests/browser/ats-challenge-p0.spec.ts`

Expected: PASS with all replay assertions green and `submissionCount === 0` for success, dynamic DOM, iframe, Shadow DOM, CAPTCHA, 403, 429, and device-verification scenarios.

- [ ] **Step 8: Commit deterministic certification gates**

```bash
rtk git add apps/api/src/ats-adapters apps/api/package.json apps/synthetic-ats pnpm-lock.yaml tests/browser/ats-adapter-replay.spec.ts
rtk git commit -m "feat: verify ATS packs with synthetic replay"
```

### Task 6: Gate application execution on a certified pack

**Files:**
- Create: `apps/api/src/ats-adapters/adapter-review-service.ts`
- Create: `apps/api/src/ats-adapters/adapter-review-service.test.ts`
- Modify: `apps/api/src/applications/application-machine.ts`
- Modify: `apps/api/src/applications/application-machine.test.ts`
- Modify: `apps/api/src/applications/application-service.ts`
- Modify: `apps/api/src/applications/routes.ts`
- Modify: `apps/api/src/applications/routes.test.ts`
- Modify: `apps/api/src/applications/repeated-section-planner.ts`
- Modify: `apps/api/src/applications/repeated-section-planner.test.ts`
- Modify: `apps/api/src/applications/checkpoint-repository.ts`
- Modify: `apps/api/src/applications/checkpoint-repository.test.ts`
- Modify: `apps/api/src/db/migrate.ts`
- Modify: `apps/api/src/db/migrate.test.ts`
- Modify: `apps/api/src/production-dependencies.ts`

**Interfaces:**
- Consumes: composite `HintPackRegistry`, `AdapterReviewService.prepare(taskId, snapshot)`, fresh snapshot observation, and existing execution invalidation.
- Produces: state/event `awaiting_adapter_review` / `ADAPTER_REVIEW_REQUIRED`, command `resume_after_adapter_certification`, persisted `adapterReview`, and a certified snapshot transformation before field resolution.

```typescript
export interface AdapterReviewService {
  prepare(taskId: string, snapshot: FormSnapshot): Promise<AdapterReviewSummary>;
  get(proposalId: string): AdapterReviewSummary | undefined;
  replay(proposalId: string): Promise<AdapterReviewSummary>;
  requestAiReview(proposalId: string): Promise<AdapterReviewSummary>;
  revise(proposalId: string, definition: HintPackDefinition): Promise<AdapterReviewSummary>;
  decide(proposalId: string, input: Omit<HumanCertificationDecision, "reviewId" | "proposalId" | "reviewer" | "createdAt">): AdapterReviewSummary;
  retire(packId: string, version: string, reason: string): void;
}
```

Extend `ApplicationService` with `adapterReview(taskId: string): AdapterReviewSummary | undefined` and `resumeAfterAdapterCertification(taskId: string): Promise<void>`. Extend `ApplicationServiceDependencies` with `hintPackRegistry: HintPackRegistry` and `adapterReviewService: Pick<AdapterReviewService, "prepare" | "retire">`.

Extend `ProductionAdapterDependencies` with `hintPacks?: readonly CertifiedHintPack[]`; production uses `BUILT_IN_HINT_PACKS` when absent, while browser tests pass test-only certified clones matching the synthetic server origin. Construct the registry as `createHintPackRegistry({ builtIns: adapters.hintPacks ?? BUILT_IN_HINT_PACKS, local: () => adapterLedger.listCertified(), isRetired: (packId, version) => adapterLedger.isRetired(packId, version) })`.

- [ ] **Step 1: Write failing state-machine and zero-write service tests**

```typescript
it("pauses an unknown application page for adapter review", () => {
  const actor = createActor(applicationMachine, { input: { taskId: "task-1", applicationUrl: "https://unknown.test/apply" } }).start();
  actor.send({ type: "START" });
  actor.send({ type: "ADAPTER_REVIEW_REQUIRED" });
  expect(actor.getSnapshot().value).toBe("awaiting_adapter_review");
  expect(actor.getSnapshot().can({ type: "READY_TO_FILL" })).toBe(false);
});

it("invalidates execution and performs zero writes for an unmatched ATS", async () => {
  await service.runUntilPause("task-1", unknownSnapshot());
  expect(service.state("task-1").value).toBe("awaiting_adapter_review");
  expect(browser.invalidateExecution).toHaveBeenCalledOnce();
  expect(browser.execute).not.toHaveBeenCalled();
  expect(resolveField).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify application tests fail before the new state exists**

Run: `rtk pnpm --filter @resume/api test -- src/applications/application-machine.test.ts src/applications/routes.test.ts src/ats-adapters/adapter-review-service.test.ts`

Expected: FAIL because `ADAPTER_REVIEW_REQUIRED` and `awaiting_adapter_review` are unknown.

- [ ] **Step 3: Add the XState transition and safe resume rule**

```typescript
export type ApplicationEvent =
  | { type: "ADAPTER_REVIEW_REQUIRED" }
  | { type: "ADAPTER_CERTIFIED" }
  | { type: "START" }
  | { type: "LOGIN_REQUIRED" }
  | { type: "QUESTIONS_REQUIRED"; questions: ApplicationQuestion[] }
  | { type: "CONTENT_REVIEW_REQUIRED" }
  | { type: "READY_TO_FILL" }
  | { type: "PAGE_FILLED" }
  | { type: "PAGE_VALID" }
  | { type: "PAGE_INVALID"; errors: string[] }
  | { type: "PAGE_NAVIGATED" }
  | { type: "REVIEW_REACHED" }
  | { type: "RESUME" }
  | { type: "PROFILE_UPDATED" }
  | { type: "ANSWERS_PROVIDED" }
  | { type: "CONTENT_APPROVED" }
  | { type: "CONTENT_REJECTED" }
  | { type: "CHALLENGE_DETECTED"; challenge: ChallengeDiagnostic }
  | { type: "USER_RESUME_CHALLENGE" }
  | { type: "CANCEL" }
  | { type: "RECOVER" }
  | { type: "RETRY" }
  | { type: "FAIL"; errors: string[] }
;

observing: {
  on: {
    ADAPTER_REVIEW_REQUIRED: "awaiting_adapter_review",
    LOGIN_REQUIRED: "awaiting_login",
    QUESTIONS_REQUIRED: { target: "needs_questions", actions: "storeQuestions" },
    CONTENT_REVIEW_REQUIRED: "awaiting_content_review",
    READY_TO_FILL: { target: "filling", actions: ["clearQuestions", "clearErrors"] },
    REVIEW_REACHED: "review_locked",
    FAIL: { target: "failed", actions: "storeErrors" },
    RECOVER: { target: "observing", actions: "clearErrors" },
    CHALLENGE_DETECTED: { target: "awaiting_challenge", actions: "storeChallenge" }
  }
},
awaiting_adapter_review: {
  on: { ADAPTER_CERTIFIED: "observing", CANCEL: "cancelled" }
},
```

Map internal `awaiting_adapter_review` to the same API state. `commandsForState` returns `cancel`, `open_browser`, and `resume_after_adapter_certification` only.

- [ ] **Step 4: Put the registry gate before all resolution and fill work**

Centralize every fresh observation in a `prepareObservedSnapshot(taskId, actor, observed)` helper so open, resume, recovery, navigation, and audit paths cannot bypass the gate. For an `application_form` snapshot, run challenge detection first and registry resolution second, before `deriveEntrySemanticHints`, repeated-section planning, field resolution, or approval:

```typescript
const adapterResolution = dependencies.hintPackRegistry.resolve(observed);
if (adapterResolution.kind === "review_only") {
  if (adapterResolution.reason === "fingerprint_mismatch") {
    for (const pack of adapterResolution.mismatchedPacks) dependencies.adapterReviewService.retire(pack.packId, pack.version, "fingerprint_mismatch");
  }
  await invalidateExecution(taskId);
  invalidateRunGeneration(taskId);
  adapterReviews.set(taskId, await dependencies.adapterReviewService.prepare(taskId, observed));
  sendApplicationEvent(actor, { type: "ADAPTER_REVIEW_REQUIRED" });
  persist(actor, observed);
  return;
}
const snapshot = withDerivedEntrySemantics(
  applyCertifiedHintPack(observed, adapterResolution.pack),
  dependencies.listProfileFacts?.() ?? []
);
activeHintPacks.set(taskId, adapterResolution.pack);
```

`resumeAfterAdapterCertification(taskId)` re-observes the page and re-resolves the registry. If still unmatched it throws `adapter_not_certified`, stays paused, and performs no writes. On success it sends `ADAPTER_CERTIFIED`, clears the review projection, and starts a new run generation and execution epoch.

Update `publishCoverageCounts` so new certified-pack fills count in the deterministic bucket (`field.source === "certified_hint"`), while `dji_catalog` remains accepted only when restoring an old checkpoint.

Change `planRepeatedSectionActions` to accept the already classified `{ actionId, section: HintPackRepeatSection }[]` from `classifyRepeatedActions(snapshot, adapterResolution.pack)`. Preserve the current `laboratory -> campus` profile-root mapping and all experience routing; remove its direct dependency on the deprecated Mokahr wrapper.

Track the active pack per task. If execution reports a wrong target/readback, or `runFullPageAudit` returns any mismatch, call this fail-closed helper before further work:

```typescript
const quarantineActivePack = async (taskId: string, actor: ApplicationActor, reason: string, snapshot: FormSnapshot): Promise<void> => {
  const pack = activeHintPacks.get(taskId);
  if (pack !== undefined) dependencies.adapterReviewService.retire(pack.packId, pack.version, reason);
  activeHintPacks.delete(taskId);
  await invalidateExecution(taskId);
  invalidateRunGeneration(taskId);
  adapterReviews.set(taskId, await dependencies.adapterReviewService.prepare(taskId, snapshot));
  sendApplicationEvent(actor, { type: "ADAPTER_REVIEW_REQUIRED" });
  persist(actor, snapshot);
};
```

Add `ADAPTER_REVIEW_REQUIRED: "awaiting_adapter_review"` transitions to `filling`, `validating`, and `navigating`, not only `observing`, so a pack that regresses during readback is immediately quarantined. Do not retire for user activity or a challenge; those retain their existing pause paths.

- [ ] **Step 5: Persist the review projection and safely upgrade SQLite state constraints**

Add `adapter_review_json` to `application_checkpoints`. Replace `upgradeChallengeStateConstraints` with `upgradeApplicationStateConstraints`, checking separately for both `'awaiting_challenge'` and `'awaiting_adapter_review'`, rebuilding `application_task_events` and `application_checkpoints` in one transaction while preserving every row and index. Add the new state to initial table definitions and cleanup trigger recreation.

- [ ] **Step 6: Run state, migration, checkpoint, and application regressions**

Run: `rtk pnpm --filter @resume/api test -- src/db/migrate.test.ts src/applications/application-machine.test.ts src/applications/checkpoint-repository.test.ts src/applications/routes.test.ts src/ats-adapters/adapter-review-service.test.ts`

Expected: PASS; old databases upgrade without data loss, unknown ATS executes zero commands, certified Moka/DJI proceeds, and challenges still take precedence and invalidate execution.

- [ ] **Step 7: Commit the production execution gate**

```bash
rtk git add apps/api/src/applications apps/api/src/ats-adapters/adapter-review-service.ts apps/api/src/ats-adapters/adapter-review-service.test.ts apps/api/src/db apps/api/src/production-dependencies.ts
rtk git commit -m "feat: gate application writes on certified ATS packs"
```

### Task 7: Expose sanitized review APIs and the human certification workbench

**Files:**
- Create: `apps/api/src/ats-adapters/routes.ts`
- Create: `apps/api/src/ats-adapters/routes.test.ts`
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/production-dependencies.ts`
- Create: `apps/web/src/applications/AdapterReviewPanel.tsx`
- Create: `apps/web/src/applications/AdapterReviewPanel.test.tsx`
- Modify: `apps/web/src/applications/ApplicationTaskPage.tsx`
- Modify: `apps/web/src/applications/ApplicationTaskPage.test.tsx`
- Modify: `apps/web/src/applications/FieldCoveragePanel.tsx`
- Modify: `apps/web/src/applications/FieldCoveragePanel.test.tsx`
- Modify: `apps/web/src/applications/api.ts`
- Modify: `apps/web/src/applications/api.test.ts`
- Modify: `apps/web/src/styles.css`

**Interfaces:**
- Consumes: `AdapterReviewService`, Task 1 request/response schemas, existing `ApplicationApi`, and `ApplicationTask.adapterReview`.
- Produces: proposal detail/replay/AI review/human decision/retirement routes and `AdapterReviewPanel` with revise, replay, AI-review, certify, reject, and explicit degraded-review acknowledgement controls.

- [ ] **Step 1: Write failing route authorization/lifecycle tests**

```typescript
it("returns sanitized review data and cannot certify before replay", async () => {
  const detail = await app.inject({ method: "GET", url: "/api/ats-adapters/proposals/proposal-1" });
  expect(detail.statusCode).toBe(200);
  expect(JSON.stringify(detail.json())).not.toMatch(/currentValue|nodeRef|cookie|approval|真实姓名/iu);

  const certify = await app.inject({ method: "POST", url: "/api/ats-adapters/proposals/proposal-1/decision", payload: {
    decision: "certify", reviewer: "local-user", aiReviewUnavailable: false, acknowledgedAiUnavailable: false
  }});
  expect(certify.statusCode).toBe(409);
  expect(certify.json()).toMatchObject({ error: { code: "adapter_transition_denied" } });
});
```

- [ ] **Step 2: Write the failing UI test for the three review layers**

```tsx
it("shows deterministic, AI, and human layers and requires degraded acknowledgement", async () => {
  render(<AdapterReviewPanel review={replayVerifiedWithoutAi()} busy={false} onReplay={vi.fn()} onAiReview={vi.fn()} onDecision={onDecision} onRevise={vi.fn()} />);
  expect(screen.getByRole("heading", { name: "确定性校验" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "AI 辅助审阅" })).toBeVisible();
  expect(screen.getByRole("heading", { name: "人工最终认证" })).toBeVisible();
  expect(screen.getByRole("button", { name: "认证此版本" })).toBeDisabled();
  await userEvent.click(screen.getByRole("checkbox", { name: "我已确认 AI 审阅不可用，仍由人工承担最终判断" }));
  expect(screen.getByRole("button", { name: "认证此版本" })).toBeEnabled();
});
```

- [ ] **Step 3: Verify API and web tests fail before routes/components exist**

Run: `rtk pnpm --filter @resume/api test -- src/ats-adapters/routes.test.ts`

Run: `rtk pnpm --filter @resume/web test -- src/applications/AdapterReviewPanel.test.tsx src/applications/ApplicationTaskPage.test.tsx`

Expected: FAIL with missing route registration and `AdapterReviewPanel`.

- [ ] **Step 4: Implement lifecycle routes with strict body parsing**

Register these loopback API routes:

```text
GET  /api/ats-adapters/proposals/:proposalId
POST /api/ats-adapters/proposals/:proposalId/replay
POST /api/ats-adapters/proposals/:proposalId/ai-review
POST /api/ats-adapters/proposals/:proposalId/revise
POST /api/ats-adapters/proposals/:proposalId/decision
POST /api/ats-adapters/packs/:packId/:version/retire
```

Use strict Zod bodies. `revise` accepts only `HintPackDefinitionSchema`, creates a new proposal ID and incremented immutable patch version, and immediately returns to `candidate`; it never mutates the parent. `decision` derives reviewer identity as the fixed local actor `local-user` rather than trusting an arbitrary remote header. Return 409 for lifecycle conflicts, 503 for AI unavailability, and sanitized error codes only.

```typescript
const ProposalParams = z.object({ proposalId: z.string().min(1).max(128) }).strict();
const PackParams = z.object({ packId: z.string().min(1).max(64), version: z.string().min(1).max(32) }).strict();
const DecisionBody = z.object({
  decision: z.enum(["certify", "reject", "revise"]), aiReviewUnavailable: z.boolean(),
  acknowledgedAiUnavailable: z.boolean(), notes: z.string().max(4000).optional()
}).strict();
const RetireBody = z.object({ reason: z.string().min(1).max(1000) }).strict();

export function registerAdapterRoutes(app: FastifyInstance, service: AdapterReviewService): void {
  app.get("/api/ats-adapters/proposals/:proposalId", async (request, reply) => {
    const { proposalId } = ProposalParams.parse(request.params);
    const review = service.get(proposalId);
    return review === undefined ? reply.code(404).send({ error: { code: "adapter_proposal_not_found" } }) : reply.send(review);
  });
  app.post("/api/ats-adapters/proposals/:proposalId/replay", async (request, reply) => {
    const { proposalId } = ProposalParams.parse(request.params);
    return reply.send(await service.replay(proposalId));
  });
  app.post("/api/ats-adapters/proposals/:proposalId/ai-review", async (request, reply) => {
    const { proposalId } = ProposalParams.parse(request.params);
    try { return reply.send(await service.requestAiReview(proposalId)); }
    catch (error) { return adapterErrorReply(reply, error); }
  });
  app.post("/api/ats-adapters/proposals/:proposalId/revise", async (request, reply) => {
    const { proposalId } = ProposalParams.parse(request.params);
    return reply.code(201).send(await service.revise(proposalId, HintPackDefinitionSchema.parse(request.body)));
  });
  app.post("/api/ats-adapters/proposals/:proposalId/decision", async (request, reply) => {
    const { proposalId } = ProposalParams.parse(request.params);
    try { return reply.send(service.decide(proposalId, DecisionBody.parse(request.body))); }
    catch (error) { return adapterErrorReply(reply, error); }
  });
  app.post("/api/ats-adapters/packs/:packId/:version/retire", async (request, reply) => {
    const { packId, version } = PackParams.parse(request.params);
    service.retire(packId, version, RetireBody.parse(request.body).reason);
    return reply.code(204).send();
  });
}

function adapterErrorReply(reply: FastifyReply, error: unknown) {
  const code = error instanceof Error ? error.message : "adapter_operation_failed";
  if (code === "adapter_transition_denied" || code === "hard_gate_failed") return reply.code(409).send({ error: { code } });
  if (code === "adapter_ai_unavailable") return reply.code(503).send({ error: { code } });
  throw error;
}
```

- [ ] **Step 5: Implement the review panel and task-page state**

```tsx
import { useEffect, useState } from "react";
import type { AdapterReviewSummary, HintPackDefinition, HumanCertificationDecision } from "@resume/contracts";

interface AdapterReviewPanelProps {
  review: AdapterReviewSummary;
  busy: boolean;
  onReplay(): void;
  onAiReview(): void;
  onRevise(definition: HintPackDefinition): void;
  onDecision(input: Pick<HumanCertificationDecision, "decision" | "aiReviewUnavailable" | "acknowledgedAiUnavailable">): void;
}

export function AdapterReviewPanel(props: AdapterReviewPanelProps) {
  const { review } = props;
  const [acknowledged, setAcknowledged] = useState(false);
  const [definition, setDefinition] = useState(review.proposal?.definition);
  useEffect(() => setDefinition(review.proposal?.definition), [review.proposal?.proposalId]);
  const hardPassed = review.replayReports.length > 0 && review.replayReports.every((report) => report.status === "passed");
  const canCertify = hardPassed && (review.aiReview !== undefined || review.aiReviewUnavailable && acknowledged);
  return <section className="adapter-review-panel" aria-label="ATS 适配认证">
    <header><span>只读观察</span><h3>当前网站尚无认证适配包</h3><p>认证前系统不会向真实页面写入任何字段。</p></header>
    {definition && <section><h4>候选映射</h4>{definition.fieldRules.map((rule, index) => <label key={rule.ruleId}>{rule.labelAliases[0]}
      <input aria-label={`${rule.ruleId} 档案路径`} value={rule.profilePath} onChange={(event) => setDefinition({ ...definition, fieldRules: definition.fieldRules.map((item, itemIndex) => itemIndex === index ? { ...item, profilePath: event.currentTarget.value } : item) })} />
    </label>)}<button disabled={props.busy} onClick={() => props.onRevise(definition)}>保存为新版本并重新回放</button></section>}
    <section><h4>确定性校验</h4><strong>{hardPassed ? "已通过" : "待运行"}</strong>
      <ul>{review.replayReports.flatMap((report) => report.assertions).map((item, index) => <li key={`${item.code}-${index}`}>{item.passed ? "通过" : "失败"}：{item.detail}</li>)}</ul>
      <button disabled={props.busy || !review.proposal} onClick={props.onReplay}>运行合成资料回放</button>
    </section>
    <section><h4>AI 辅助审阅</h4><strong>{review.aiReview ? "已完成" : review.aiReviewUnavailable ? "不可用" : "待运行"}</strong>
      <ul>{review.aiReview?.findings.map((finding, index) => <li key={`${finding.code}-${index}`}>{finding.severity}：{finding.explanation}</li>)}</ul>
      <button disabled={props.busy || !hardPassed} onClick={props.onAiReview}>请求 AI 审阅回放</button>
    </section>
    <section><h4>人工最终认证</h4><strong>等待决定</strong>
      {review.aiReviewUnavailable && <label><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.currentTarget.checked)} />我已确认 AI 审阅不可用，仍由人工承担最终判断</label>}
      <button disabled={!canCertify || props.busy} onClick={() => props.onDecision({ decision: "certify", aiReviewUnavailable: review.aiReviewUnavailable, acknowledgedAiUnavailable: acknowledged })}>认证此版本</button>
      <button disabled={props.busy} onClick={() => props.onDecision({ decision: "reject", aiReviewUnavailable: review.aiReviewUnavailable, acknowledgedAiUnavailable: false })}>拒绝</button>
    </section>
  </section>;
}
```

Render this panel when `currentTask.state === "awaiting_adapter_review"`. Mapping edits create a revised child candidate and require replay again. After successful certification, show `resume_after_adapter_certification` as a button labelled `适配包已认证，重新观察`; never automatically resume a real page merely because the certification API returned 200. The registry reads local certified packs from `AdapterLedger.listCertified()` on every resolution, so certification and retirement take effect without mutating an in-memory pack.

- [ ] **Step 6: Display certified source/version/confidence in field coverage**

Update `sourceLabel("certified_hint")` to `认证 ATS 提示包`; when provenance exists render `packId@packVersion · 已认证 · confidence%`. Do not expose proposal IDs, model raw text, hashes, or debug response IDs in the ordinary task page.

- [ ] **Step 7: Run route, component, accessibility, and API client tests**

Run: `rtk pnpm --filter @resume/api test -- src/ats-adapters/routes.test.ts src/applications/routes.test.ts`

Run: `rtk pnpm --filter @resume/web test -- src/applications/AdapterReviewPanel.test.tsx src/applications/ApplicationTaskPage.test.tsx src/applications/FieldCoveragePanel.test.tsx src/applications/api.test.ts`

Expected: PASS; the three layers are visible, failed hard gates disable certification, AI-unavailable requires acknowledgement, revisions create new versions, and certified provenance is visible.

- [ ] **Step 8: Commit the review workbench**

```bash
rtk git add apps/api/src/app.ts apps/api/src/production-dependencies.ts apps/api/src/ats-adapters/routes.ts apps/api/src/ats-adapters/routes.test.ts apps/web/src
rtk git commit -m "feat: add ATS adapter certification workbench"
```

### Task 8: Prove end-to-end safety and document operator behavior

**Files:**
- Create: `tests/browser/unknown-ats-review-only.spec.ts`
- Modify: `tests/browser/mokahr-campus-apply.spec.ts`
- Modify: `tests/browser/mokahr-high-coverage.spec.ts`
- Modify: `tests/browser/dji-coverage.spec.ts`
- Modify: `tests/browser/ats-challenge-p0.spec.ts`
- Modify: `README.md`
- Create: `docs/ats-adapter-certification.md`

**Interfaces:**
- Consumes: completed API, UI, registry, ledger, replay runner, synthetic ATS, and existing browser safety tests.
- Produces: release-level regression evidence and a local operator runbook.

- [ ] **Step 1: Add an unknown-ATS browser test that observes but never writes**

```typescript
test("unknown ATS remains review-only until a human-certified pack is resolvable", async ({ page }) => {
  const task = await harness.createApplication(`${synthetic.baseUrl}/adapter-replay/unknown?taskId=unknown-1`);
  await harness.openTask(page, task.id);
  await expect(page.getByRole("heading", { name: "当前网站尚无认证适配包" })).toBeVisible();
  const before = synthetic.state("unknown-1");
  expect(before.runtime.writeCounts).toEqual({});
  expect(before.submissionCount).toBe(0);

  await harness.runReplayAndAiReview(page);
  await page.getByRole("button", { name: "认证此版本" }).click();
  await page.getByRole("button", { name: "适配包已认证，重新观察" }).click();
  const after = synthetic.state("unknown-1");
  expect(after.submissionCount).toBe(0);
});
```

- [ ] **Step 2: Run the new test first and fix only concrete integration failures**

Run: `rtk pnpm test:e2e -- tests/browser/unknown-ats-review-only.spec.ts`

Expected: PASS with zero writes before certification and zero submissions for the entire flow.

- [ ] **Step 3: Extend existing Moka, DJI, challenge, and stable-readback assertions**

In each existing test assert the resolved pack ID/version, `semanticSource === "certified_hint"`, challenge pause where applicable, and final `submissionCount === 0`. Do not weaken any existing field-value, NodeRef invalidation, or double-readback assertion.

- [ ] **Step 4: Write the operator runbook**

Document:

- the three certification layers and exact lifecycle;
- how to inspect sanitized proposal mappings and replay assertions;
- that AI recommendations never override red hard-gate results;
- the explicit acknowledgement needed when AI review is unavailable;
- edit-and-rerun creating a new immutable version;
- retirement after fingerprint drift, wrong write, or readback regression;
- debug raw retention environment variables, 24-hour default, 168-hour maximum, encryption requirement, audit behavior, and purge command;
- prohibited data and the rule that no real ATS submission is part of certification.

- [ ] **Step 5: Run focused end-to-end regression suites**

Run: `rtk pnpm test:e2e -- tests/browser/unknown-ats-review-only.spec.ts tests/browser/ats-adapter-replay.spec.ts tests/browser/mokahr-campus-apply.spec.ts tests/browser/mokahr-high-coverage.spec.ts tests/browser/dji-coverage.spec.ts tests/browser/application-stability.spec.ts tests/browser/ats-challenge-p0.spec.ts`

Expected: PASS; all paths report `submissionCount === 0`, unknown pages write nothing before certification, and Moka/DJI behavior remains stable.

- [ ] **Step 6: Run repository-wide verification**

Run: `rtk pnpm test`

Expected: PASS with no failed Vitest suite.

Run: `rtk pnpm typecheck`

Expected: PASS with exit code 0 and no TypeScript diagnostics.

Run: `rtk pnpm build`

Expected: PASS with API, browser worker, web, and package builds completing successfully.

- [ ] **Step 7: Verify the final diff contains no secrets, raw fixtures, or unfinished implementation markers**

Run: `rtk rg -n "真实姓名|13800138000|Bearer |Cookie:|T[O]DO|T[B]D|implement[ ]later" packages apps tests docs/ats-adapter-certification.md`

Expected: no matches in files added or changed by this plan. Existing unrelated matches must be inspected and left unchanged.

Run: `rtk git diff --check`

Expected: no output.

- [ ] **Step 8: Commit final regressions and documentation**

```bash
rtk git add tests/browser README.md docs/ats-adapter-certification.md
rtk git commit -m "test: verify certified ATS adapter safety"
```

## Execution checkpoints

After Tasks 1–2, review the contract/registry boundary and confirm Moka/DJI parity. After Tasks 3–5, review lifecycle durability, privacy, and replay hard gates before allowing any application-state integration. After Tasks 6–7, manually inspect that the UI cannot certify a failed replay and that resuming requires a fresh certified registry match. Task 8 is the release gate; do not call the feature complete unless all three repository-wide commands pass.
