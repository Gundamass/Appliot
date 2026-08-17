import {
  AdapterReviewSummarySchema,
  AiHintPackProposalSchema,
  AiReplayReviewSchema,
  CertifiedHintPackSchema,
  HumanCertificationDecisionSchema,
  ReplayReportSchema,
  type AdapterReviewSummary,
  type AiHintPackProposal,
  type AiReplayReview,
  type CertifiedHintPack,
  type HintPackLifecycleStatus,
  type HumanCertificationDecision,
  type ReplayReport
} from "@resume/contracts";
import { certifiedTextReference } from "@resume/form-semantics";
import type { SqliteDatabase } from "../db/client.js";

interface ProposalRow {
  proposal_id: string;
  lifecycle_status: HintPackLifecycleStatus;
  payload_json: string;
}

interface PayloadRow { payload_json: string; }

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

function transitionDenied(): never {
  throw new Error("adapter_transition_denied");
}

const schemaConstrainedStringKeys = new Set([
  "lifecycleStatus", "promptVersion", "inputHash", "outputHash", "version",
  "stages", "pageFingerprintHashes", "section", "sections", "profilePath", "controlTypes",
  "kind", "fixtureId", "rejectedActions", "createdAt", "status", "recommendation",
  "severity", "decision"
]);
const identifierStringKeys = new Set([
  "proposalId", "taskId", "parentProposalId", "packId", "provider", "model",
  "ruleId", "reportId", "reviewId", "code", "reviewer"
]);
const matchingTextStringKeys = new Set([
  "requiredTextSignals", "headingAliases", "fieldOrderAliases", "labelAliases", "verbs"
]);
const unrestrictedStringKeys = new Set([
  "unsupportedBoundaries", "detail", "explanation", "notes"
]);
const allowedRetirementReasons = new Set(["unsafe mapping", "superseded mapping"]);
const prohibitedArtifactTokens = new Set([
  "bearer", "password", "currentvalue", "noderef", "approvaltoken", "approvalkey"
]);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const modelIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/u;
const packIdPattern = /^[a-z0-9][a-z0-9-]{2,63}$/u;
const semverPattern = /^\d+\.\d+\.\d+$/u;
const hostSuffixPattern = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const pathPrefixPattern = /^\/[A-Za-z0-9._~/-]*$/u;
const semanticPathPattern = /^[a-z][a-zA-Z0-9]*(?:\[\d+\])?(?:\.[a-z][a-zA-Z0-9]*)*$/u;
const matchingReferencePattern = /^ats:sha256:[1-9]\d{0,2}:[a-f0-9]{64}$/u;
const redactedReviewPatterns = [
  /^redacted:unsupported-boundary$/u,
  /^redacted:assertion:[A-Za-z0-9][A-Za-z0-9._-]{0,79}:(?:passed|failed):report-(?:passed|failed)$/u,
  /^redacted:finding:[A-Za-z0-9][A-Za-z0-9._-]{0,79}:(?:info|warning|error):recommendation-(?:accept_for_human_review|revise|reject)$/u,
  /^redacted:human-decision:(?:certify|reject|revise):ai-review-(?:available|unavailable):fallback-(?:acknowledged|not-acknowledged)$/u
];

function assertSanitizedPayload(value: unknown): void {
  if (!isSanitizedPersistenceValue(value)) throw new Error("adapter_sensitive_payload_rejected");
}

function isSanitizedPersistenceValue(value: unknown, key?: string): boolean {
  if (typeof value === "string") return key !== undefined && isAllowedString(key, value);
  if (Array.isArray(value)) return value.every((item) => isSanitizedPersistenceValue(item, key));
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).every(([childKey, child]) => isSanitizedPersistenceValue(child, childKey));
  }
  return value === undefined || value === null || typeof value === "boolean" || typeof value === "number";
}

function isAllowedString(key: string, value: string): boolean {
  if (schemaConstrainedStringKeys.has(key)) return true;
  if (key === "model") return modelIdentifierPattern.test(value) && !hasExplicitArtifact(value);
  if (identifierStringKeys.has(key)) return identifierPattern.test(value) && !hasExplicitArtifact(value);
  if (key === "hostSuffix") return hostSuffixPattern.test(value);
  if (key === "pathPrefixes") return pathPrefixPattern.test(value);
  if (key === "expectedProfilePaths") return semanticPathPattern.test(value);
  if (unrestrictedStringKeys.has(key)) return redactedReviewPatterns.some((pattern) => pattern.test(value));
  return matchingTextStringKeys.has(key) && matchingReferencePattern.test(value);
}

function hasExplicitArtifact(value: string): boolean {
  const normalized = value.normalize("NFKC").toLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokenSet = new Set(tokens);
  const hasPair = (left: string, right: string) => tokenSet.has(left) && tokenSet.has(right);
  const commandShaped = tokenSet.has("type")
    && ["fill", "click", "select", "upload"].some((token) => tokenSet.has(token))
    && (tokenSet.has("value") || hasPair("field", "id"));
  const encodedArtifact = /\bdata:[^,\s]{1,128};base64,[A-Za-z0-9+/]+={0,2}/iu.test(value)
    || /\bbase64\s*[:,=]\s*[A-Za-z0-9+/]{24,}={0,2}/iu.test(value)
    || /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?\b/u.test(value)
    || /-----BEGIN [A-Z0-9 ]+-----/u.test(value)
    || /\b[a-f0-9]{64,}\b/iu.test(value);
  const credentialHeader = /(?:^|[\r\n;,])\s*(?:proxy[\s_/-]*)?authorization(?:\s*[:=]\s*|\s+)(?:basic|bearer|digest|negotiate|ntlm|aws4-hmac-sha256)\s+\S+/iu.test(value);
  const artifactAssignment = /(?:^|[\s;,])(?:cookie|session|password|screenshot|approval(?:[\s_/-]*(?:token|key))?|api[\s_/-]*key|client[\s_/-]*secret|access[\s_/-]*token|refresh[\s_/-]*token)\s*[:=]/iu.test(value);
  const knownCredential = /(?:AKIA|ASIA)[A-Z0-9]{16}|(?:sk_(?:live|test)|ghp_|github_pat_|xox[baprs]-)[A-Za-z0-9_-]+/u.test(value);
  return /\p{N}{7,}/u.test(value)
    || /[@<>{}\\`|]/u.test(value)
    || encodedArtifact
    || credentialHeader
    || artifactAssignment
    || knownCredential
    || tokens.some((token) => prohibitedArtifactTokens.has(token))
    || hasPair("api", "key")
    || hasPair("client", "secret")
    || hasPair("access", "token")
    || hasPair("refresh", "token")
    || hasPair("node", "ref")
    || hasPair("current", "value")
    || hasPair("approval", "token")
    || commandShaped;
}

function assertSafeSourceText(value: string): void {
  if (hasExplicitArtifact(value)) throw new Error("adapter_sensitive_payload_rejected");
}

function sanitizeMatchingText(value: string): string {
  if (matchingReferencePattern.test(value)) throw new Error("adapter_sensitive_payload_rejected");
  assertSafeSourceText(value);
  try {
    return certifiedTextReference(value);
  } catch {
    throw new Error("adapter_sensitive_payload_rejected");
  }
}

function sanitizeProposalForPersistence(proposal: AiHintPackProposal): AiHintPackProposal {
  proposal.unsupportedBoundaries.forEach(assertSafeSourceText);
  return AiHintPackProposalSchema.parse({
    ...proposal,
    definition: {
      ...proposal.definition,
      match: {
        ...proposal.definition.match,
        requiredTextSignals: proposal.definition.match.requiredTextSignals.map(sanitizeMatchingText)
      },
      sectionRules: proposal.definition.sectionRules.map((rule) => ({
        ...rule,
        headingAliases: rule.headingAliases.map(sanitizeMatchingText),
        fieldOrderAliases: rule.fieldOrderAliases.map((aliases) => aliases.map(sanitizeMatchingText))
      })),
      fieldRules: proposal.definition.fieldRules.map((rule) => ({
        ...rule,
        labelAliases: rule.labelAliases.map(sanitizeMatchingText)
      })),
      actionRules: proposal.definition.actionRules.map((rule) => ({
        ...rule,
        verbs: rule.verbs.map(sanitizeMatchingText)
      }))
    },
    unsupportedBoundaries: proposal.unsupportedBoundaries.map(() => "redacted:unsupported-boundary")
  });
}

function sanitizeReplayForPersistence(report: ReplayReport): ReplayReport {
  report.assertions.forEach(({ detail }) => assertSafeSourceText(detail));
  return ReplayReportSchema.parse({
    ...report,
    assertions: report.assertions.map((assertion) => ({
      ...assertion,
      detail: `redacted:assertion:${assertion.code}:${assertion.passed ? "passed" : "failed"}:report-${report.status}`
    }))
  });
}

function sanitizeAiReviewForPersistence(review: AiReplayReview): AiReplayReview {
  review.findings.forEach(({ explanation }) => assertSafeSourceText(explanation));
  return AiReplayReviewSchema.parse({
    ...review,
    findings: review.findings.map((finding) => ({
      ...finding,
      explanation: `redacted:finding:${finding.code}:${finding.severity}:recommendation-${review.recommendation}`
    }))
  });
}

function sanitizeHumanDecisionForPersistence(decision: HumanCertificationDecision): HumanCertificationDecision {
  if (decision.notes !== undefined) assertSafeSourceText(decision.notes);
  return HumanCertificationDecisionSchema.parse({
    ...decision,
    ...(decision.notes === undefined ? {} : {
      notes: `redacted:human-decision:${decision.decision}:ai-review-${decision.aiReviewUnavailable ? "unavailable" : "available"}:fallback-${decision.acknowledgedAiUnavailable ? "acknowledged" : "not-acknowledged"}`
    })
  });
}

function sanitizeRetirementReason(reason: string): string {
  assertSafeSourceText(reason);
  return allowedRetirementReasons.has(reason) ? reason : "redacted:retirement-reason";
}

export function createAdapterLedger(database: SqliteDatabase): AdapterLedger {
  const findProposalRow = database.prepare(`
    SELECT proposal_id, lifecycle_status, payload_json
    FROM ats_adapter_proposals WHERE proposal_id = ?
  `);
  const findReplayRows = database.prepare(`
    SELECT payload_json FROM ats_adapter_replay_reports
    WHERE proposal_id = ? ORDER BY created_at, report_id
  `);
  const findAiReviewRow = database.prepare("SELECT payload_json FROM ats_adapter_ai_reviews WHERE proposal_id = ?");
  const findHumanReviewRow = database.prepare("SELECT payload_json FROM ats_adapter_human_reviews WHERE proposal_id = ?");

  const findProposal = (proposalId: string): AiHintPackProposal | undefined => {
    const row = findProposalRow.get(proposalId) as ProposalRow | undefined;
    return row ? AiHintPackProposalSchema.parse(JSON.parse(row.payload_json)) : undefined;
  };

  const findReviewSummary = (proposalId: string): AdapterReviewSummary | undefined => {
    const row = findProposalRow.get(proposalId) as ProposalRow | undefined;
    if (!row) return undefined;
    const proposal = AiHintPackProposalSchema.parse(JSON.parse(row.payload_json));
    const replayReports = (findReplayRows.all(proposalId) as PayloadRow[])
      .map(({ payload_json }) => ReplayReportSchema.parse(JSON.parse(payload_json)));
    const aiRow = findAiReviewRow.get(proposalId) as PayloadRow | undefined;
    const humanRow = findHumanReviewRow.get(proposalId) as PayloadRow | undefined;
    const aiReview = aiRow ? AiReplayReviewSchema.parse(JSON.parse(aiRow.payload_json)) : undefined;
    const humanDecision = humanRow
      ? HumanCertificationDecisionSchema.parse(JSON.parse(humanRow.payload_json))
      : undefined;
    return AdapterReviewSummarySchema.parse({
      proposal,
      replayReports,
      ...(aiReview ? { aiReview } : {}),
      ...(humanDecision ? { humanDecision } : {}),
      lifecycleStatus: row.lifecycle_status,
      aiReviewUnavailable: humanDecision?.aiReviewUnavailable ?? false,
      writeBlocked: true
    });
  };

  const updateLifecycle = database.prepare(`
    UPDATE ats_adapter_proposals
    SET lifecycle_status = ?, updated_at = ?
    WHERE proposal_id = ? AND lifecycle_status = ?
  `);

  return {
    createProposal(input) {
      const proposal = sanitizeProposalForPersistence(AiHintPackProposalSchema.parse(input));
      assertSanitizedPayload(proposal);
      database.prepare(`
        INSERT INTO ats_adapter_proposals (
          proposal_id, task_id, parent_proposal_id, pack_id, version, lifecycle_status,
          provider, model, prompt_version, input_hash, output_hash, payload_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        proposal.proposalId,
        proposal.taskId,
        proposal.parentProposalId ?? null,
        proposal.definition.packId,
        proposal.definition.version,
        proposal.lifecycleStatus,
        proposal.provider,
        proposal.model,
        proposal.promptVersion,
        proposal.inputHash,
        proposal.outputHash,
        JSON.stringify(proposal),
        proposal.createdAt,
        proposal.createdAt
      );
    },
    findProposal,
    findReviewSummary,
    findActiveByFingerprint(taskId, inputHash) {
      const row = database.prepare(`
        SELECT proposal_id FROM ats_adapter_proposals
        WHERE task_id = ? AND input_hash = ?
          AND lifecycle_status NOT IN ('rejected', 'retired')
        ORDER BY updated_at DESC, proposal_id DESC LIMIT 1
      `).get(taskId, inputHash) as { proposal_id: string } | undefined;
      return row ? findReviewSummary(row.proposal_id) : undefined;
    },
    recordReplay(inputs) {
      if (inputs.length === 0) return;
      const reports = inputs.map((report) => sanitizeReplayForPersistence(ReplayReportSchema.parse(report)));
      reports.forEach(assertSanitizedPayload);
      database.transaction(() => {
        const row = findProposalRow.get(reports[0]!.proposalId) as ProposalRow | undefined;
        if (!row || row.lifecycle_status !== "candidate") transitionDenied();
        const proposal = AiHintPackProposalSchema.parse(JSON.parse(row.payload_json));
        const requiredFixtureIds = new Set(proposal.definition.fixtures.map(({ fixtureId }) => fixtureId));
        const insert = database.prepare(`
          INSERT INTO ats_adapter_replay_reports (
            report_id, proposal_id, status, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `);
        for (const report of reports) {
          if (report.proposalId !== proposal.proposalId || !requiredFixtureIds.has(report.fixtureId)) {
            throw new Error("adapter_replay_fixture_invalid");
          }
          insert.run(report.reportId, report.proposalId, report.status, JSON.stringify(report), report.createdAt);
        }
        const storedReports = (findReplayRows.all(proposal.proposalId) as PayloadRow[])
          .map(({ payload_json }) => ReplayReportSchema.parse(JSON.parse(payload_json)));
        const passedFixtureIds = new Set(storedReports.filter(({ status }) => status === "passed").map(({ fixtureId }) => fixtureId));
        const allPassed = storedReports.every(({ status }) => status === "passed")
          && [...requiredFixtureIds].every((fixtureId) => passedFixtureIds.has(fixtureId));
        if (!allPassed) return;
        const updatedAt = storedReports.at(-1)?.createdAt ?? proposal.createdAt;
        if (updateLifecycle.run("replay_verified", updatedAt, proposal.proposalId, "candidate").changes !== 1) {
          transitionDenied();
        }
      })();
    },
    recordAiReview(input) {
      const review = sanitizeAiReviewForPersistence(AiReplayReviewSchema.parse(input));
      assertSanitizedPayload(review);
      database.transaction(() => {
        const row = findProposalRow.get(review.proposalId) as ProposalRow | undefined;
        if (!row || row.lifecycle_status !== "replay_verified") transitionDenied();
        const report = database.prepare(`
          SELECT report_id FROM ats_adapter_replay_reports
          WHERE report_id = ? AND proposal_id = ?
        `).get(review.reportId, review.proposalId);
        if (!report) throw new Error("adapter_ai_review_report_missing");
        database.prepare(`
          INSERT INTO ats_adapter_ai_reviews (review_id, proposal_id, payload_json, created_at)
          VALUES (?, ?, ?, ?)
        `).run(review.reviewId, review.proposalId, JSON.stringify(review), review.createdAt);
        if (updateLifecycle.run("ai_reviewed", review.createdAt, review.proposalId, "replay_verified").changes !== 1) {
          transitionDenied();
        }
      })();
    },
    recordHumanDecision(input) {
      const decision = sanitizeHumanDecisionForPersistence(HumanCertificationDecisionSchema.parse(input));
      assertSanitizedPayload(decision);
      database.transaction(() => {
        const row = findProposalRow.get(decision.proposalId) as ProposalRow | undefined;
        if (!row) transitionDenied();
        const normalPath = row.lifecycle_status === "ai_reviewed" && !decision.aiReviewUnavailable;
        const acknowledgedFallback = row.lifecycle_status === "replay_verified"
          && decision.aiReviewUnavailable
          && decision.acknowledgedAiUnavailable;
        if (!normalPath && !acknowledgedFallback) transitionDenied();
        database.prepare(`
          INSERT INTO ats_adapter_human_reviews (
            review_id, proposal_id, decision, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?)
        `).run(
          decision.reviewId,
          decision.proposalId,
          decision.decision,
          JSON.stringify(decision),
          decision.createdAt
        );
        const nextStatus = decision.decision === "certify" ? "human_reviewed" : "rejected";
        if (updateLifecycle.run(nextStatus, decision.createdAt, decision.proposalId, row.lifecycle_status).changes !== 1) {
          transitionDenied();
        }
      })();
    },
    certify(proposalId) {
      return database.transaction(() => {
        const row = findProposalRow.get(proposalId) as ProposalRow | undefined;
        if (!row || row.lifecycle_status !== "human_reviewed") transitionDenied();
        const proposal = AiHintPackProposalSchema.parse(JSON.parse(row.payload_json));
        const summary = findReviewSummary(proposalId);
        if (!summary?.humanDecision || summary.humanDecision.decision !== "certify") transitionDenied();
        const retired = database.prepare(`
          SELECT 1 FROM ats_adapter_pack_retirements WHERE pack_id = ? AND version = ?
        `).get(proposal.definition.packId, proposal.definition.version);
        if (retired) transitionDenied();
        const certifiedAt = new Date().toISOString();
        const certified = CertifiedHintPackSchema.parse({
          ...proposal.definition,
          lifecycleStatus: "certified",
          certifiedAt,
          provenance: {
            proposalId,
            replayReportIds: summary.replayReports.map(({ reportId }) => reportId),
            humanReviewId: summary.humanDecision.reviewId,
            ...(summary.aiReview ? { aiReviewId: summary.aiReview.reviewId } : {})
          }
        });
        database.prepare(`
          INSERT INTO ats_adapter_certified_packs (
            pack_id, version, lifecycle_status, payload_json, certified_at
          ) VALUES (?, ?, 'certified', ?, ?)
        `).run(certified.packId, certified.version, JSON.stringify(certified), certified.certifiedAt);
        if (updateLifecycle.run("certified", certifiedAt, proposalId, "human_reviewed").changes !== 1) {
          transitionDenied();
        }
        return certified;
      })();
    },
    retire(packId, version, reason) {
      if (!packIdPattern.test(packId) || !semverPattern.test(version)) {
        throw new Error("adapter_sensitive_payload_rejected");
      }
      const persistedReason = sanitizeRetirementReason(reason);
      const retiredAt = new Date().toISOString();
      database.transaction(() => {
        database.prepare(`
          INSERT OR IGNORE INTO ats_adapter_pack_retirements (pack_id, version, reason, retired_at)
          VALUES (?, ?, ?, ?)
        `).run(packId, version, persistedReason, retiredAt);
        database.prepare(`
          UPDATE ats_adapter_certified_packs
          SET lifecycle_status = 'retired', retired_at = ?, retirement_reason = ?
          WHERE pack_id = ? AND version = ? AND lifecycle_status = 'certified'
        `).run(retiredAt, persistedReason, packId, version);
        database.prepare(`
          UPDATE ats_adapter_proposals
          SET lifecycle_status = 'retired', updated_at = ?
          WHERE pack_id = ? AND version = ? AND lifecycle_status = 'certified'
        `).run(retiredAt, packId, version);
      })();
    },
    isRetired(packId, version) {
      return database.prepare(`
        SELECT 1 FROM ats_adapter_pack_retirements WHERE pack_id = ? AND version = ?
      `).get(packId, version) !== undefined;
    },
    listCertified() {
      const rows = database.prepare(`
        SELECT certified.payload_json
        FROM ats_adapter_certified_packs AS certified
        WHERE certified.lifecycle_status = 'certified'
          AND NOT EXISTS (
            SELECT 1 FROM ats_adapter_pack_retirements AS retirement
            WHERE retirement.pack_id = certified.pack_id AND retirement.version = certified.version
          )
        ORDER BY certified.pack_id, certified.version
      `).all() as PayloadRow[];
      return Object.freeze(rows.map(({ payload_json }) => CertifiedHintPackSchema.parse(JSON.parse(payload_json))));
    }
  };
}
