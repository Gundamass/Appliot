import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { JobMatchWorkbench } from "./JobMatchWorkbench.js";
import type { JobMatchSession } from "./api.js";

const session = {
  id: "session-1",
  version: 4,
  state: "paused",
  initialUrl: "https://jobs.example.test/list",
  scoringVersion: "job-match-v1",
  profileRevision: 2,
  expectationRevision: 1,
  executionEpoch: 1,
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
  expectation: { revision: 1, confirmedAt: "2026-08-16T00:00:00.000Z", criteria: [
    { kind: "target_role", values: ["Java 技术负责人"], strength: "required" },
    { kind: "location", values: ["深圳"], strength: "preferred" }
  ] },
  filterPlan: {
    source: "moka",
    adapterVersion: "moka-job-v1",
    mapped: [{ criterionIndex: 0, key: "job", values: ["Java 技术负责人"] }],
    localOnly: [{ criterionIndex: 1, reasonCode: "unsupported_filter" }]
  },
  postings: [{ id: "posting-1", source: "moka", canonicalUrl: "https://jobs.example.test/1", title: "平台后端技术负责人超长岗位名称", organization: "示例公司", description: "负责平台服务", requirements: [{ id: "req-1", category: "skill", normalizedValue: "Java", required: true, sourceEvidence: "岗位要求 Java" }], adapterVersion: "moka-v1", contentHash: "sha256:posting", extractedAt: "2026-08-16T00:00:00.000Z" }],
  results: [{ id: "result-1", version: 2, sessionId: "session-1", postingId: "posting-1", fitScore: 86, confidence: 72, rankingScore: 80, outcomes: [{ requirementId: "req-1", outcome: "unknown", reasonCode: "missing_evidence" }], evidence: [], gaps: [{ requirementId: "req-1", outcome: "unknown", summary: "缺少直接证据" }], scoringVersion: "job-match-v1", profileRevision: 2, expectationRevision: 1, postingContentHash: "sha256:posting", stale: false }],
  cursor: { value: "page-2", pagesRead: 2, elapsedMs: 1200, newJobs: 1, consecutiveNoNewPages: 0, updatedAt: "2026-08-16T00:00:00.000Z" }
} as JobMatchSession;

describe("JobMatchWorkbench", () => {
  it("presents website filters as a read-only mapping", () => {
    const onConfirmFilters = vi.fn();
    render(<JobMatchWorkbench
      session={{ ...session, state: "awaiting_filter_confirmation" }}
      onContinue={() => undefined}
      onSelect={() => undefined}
      onSelectConflict={() => undefined}
      onRematch={() => undefined}
      onConfirmFilters={onConfirmFilters}
    />);

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByText("网站筛选：Java 技术负责人")).toBeVisible();
    expect(screen.getByText("仅本地判断：深圳")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "确认筛选并读取岗位" }));

    expect(onConfirmFilters).toHaveBeenCalledWith();
  });

  it("offers an explicit pause action while jobs are being read", () => {
    const onPause = vi.fn();
    render(<JobMatchWorkbench
      session={{ ...session, state: "extracting_jobs" }}
      onContinue={() => undefined}
      onSelect={() => undefined}
      onSelectConflict={() => undefined}
      onRematch={() => undefined}
      {...({ onPause } as Record<string, unknown>)}
    />);

    fireEvent.click(screen.getByRole("button", { name: "暂停读取" }));

    expect(onPause).toHaveBeenCalledOnce();
  });

  it("renders the three-stage matching workspace without unsafe submission language", () => {
    render(<JobMatchWorkbench session={session} onContinue={() => undefined} onSelect={() => undefined} onSelectConflict={() => undefined} onRematch={() => undefined} />);
    expect(screen.getByText("已确认筛选条件")).toBeVisible();
    expect(screen.getByText("推荐岗位")).toBeVisible();
    expect(screen.getByText("平台后端技术负责人超长岗位名称")).toBeVisible();
    expect(screen.getByText("最接近但有冲突")).toBeVisible();
    expect(screen.getByText("未知")).toBeVisible();
    expect(screen.queryByText(/自动申请|最终提交/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "继续读取" })).toBeEnabled();
  });

  it("requires an inline second confirmation for a conflict result", () => {
    const conflict = { ...session.results[0]!, outcomes: [{ requirementId: "req-1", outcome: "conflict" as const, reasonCode: "education_conflict" }] };
    const onSelectConflict = vi.fn();
    render(<JobMatchWorkbench session={{ ...session, results: [conflict] }} onContinue={() => undefined} onSelect={() => undefined} onSelectConflict={onSelectConflict} onRematch={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /平台后端技术负责人超长岗位名称/ }));
    expect(onSelectConflict).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认选择冲突岗位" }));
    expect(onSelectConflict).toHaveBeenCalledWith(conflict);
  });

  it("shows only rematching as an action when results are stale", () => {
    render(<JobMatchWorkbench session={{ ...session, results: session.results.map((result) => ({ ...result, stale: true })) }} onContinue={() => undefined} onSelect={() => undefined} onSelectConflict={() => undefined} onRematch={() => undefined} />);
    expect(screen.getByRole("button", { name: "重新匹配" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "继续读取" })).not.toBeInTheDocument();
  });

  it("closes an open conflict confirmation when refreshed results become stale", () => {
    const conflict = { ...session.results[0]!, outcomes: [{ requirementId: "req-1", outcome: "conflict" as const, reasonCode: "education_conflict" }] };
    const props = { onContinue: () => undefined, onSelect: () => undefined, onSelectConflict: () => undefined, onRematch: () => undefined };
    const view = render(<JobMatchWorkbench session={{ ...session, results: [conflict] }} {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /平台后端技术负责人超长岗位名称/ }));
    expect(screen.getByRole("button", { name: "确认选择冲突岗位" })).toBeVisible();

    view.rerender(<JobMatchWorkbench session={{ ...session, results: [{ ...conflict, stale: true }] }} {...props} />);

    expect(screen.queryByRole("button", { name: "确认选择冲突岗位" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新匹配" })).toBeEnabled();
  });
});
