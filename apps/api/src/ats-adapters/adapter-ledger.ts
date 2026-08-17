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
      const proposal = AiHintPackProposalSchema.parse(input);
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
      const reports = inputs.map((report) => ReplayReportSchema.parse(report));
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
      const review = AiReplayReviewSchema.parse(input);
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
      const decision = HumanCertificationDecisionSchema.parse(input);
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
      const retiredAt = new Date().toISOString();
      database.transaction(() => {
        database.prepare(`
          INSERT OR IGNORE INTO ats_adapter_pack_retirements (pack_id, version, reason, retired_at)
          VALUES (?, ?, ?, ?)
        `).run(packId, version, reason, retiredAt);
        database.prepare(`
          UPDATE ats_adapter_certified_packs
          SET lifecycle_status = 'retired', retired_at = ?, retirement_reason = ?
          WHERE pack_id = ? AND version = ? AND lifecycle_status = 'certified'
        `).run(retiredAt, reason, packId, version);
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
