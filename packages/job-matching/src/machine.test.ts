import { describe, expect, it } from "vitest";
import type { JobEntryKind, JobMatchSessionState } from "@resume/contracts";
import {
  createJobMatchMachine,
  resolveJobMatchEntry,
  sendJobMatchEvent,
  type JobMatchEvent
} from "./machine.js";

const input = {
  sessionId: "jm-1",
  entryUrl: "https://jobs.example/list",
  leaseOwnerId: "jm-1",
  executionEpoch: 7
};

function transition(
  setupEvents: JobMatchEvent[],
  event: JobMatchEvent
): JobMatchSessionState {
  const actor = createJobMatchMachine(input);
  setupEvents.forEach((setupEvent) => sendJobMatchEvent(actor, setupEvent));
  sendJobMatchEvent(actor, event);
  return actor.getSnapshot().value as JobMatchSessionState;
}

describe("JobMatchSession machine", () => {
  it.each<{
    name: string;
    setup: JobMatchEvent[];
    event: JobMatchEvent;
    expected: JobMatchSessionState;
  }>([
    {
      name: "routes a list entry through filter confirmation",
      setup: [],
      event: { type: "ENTRY_IDENTIFIED", entryKind: "job_list" },
      expected: "awaiting_filter_confirmation"
    },
    {
      name: "routes a detail entry directly to opening",
      setup: [],
      event: { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" },
      expected: "opening_job_page"
    },
    {
      name: "opens a confirmed list entry",
      setup: [{ type: "ENTRY_IDENTIFIED", entryKind: "job_list" }],
      event: { type: "FILTERS_CONFIRMED" },
      expected: "opening_job_page"
    },
    {
      name: "waits for login when the opened page requires it",
      setup: [{ type: "ENTRY_IDENTIFIED", entryKind: "job_detail" }],
      event: { type: "LOGIN_REQUIRED" },
      expected: "awaiting_login"
    },
    {
      name: "applies filters on a ready list page",
      setup: [
        { type: "ENTRY_IDENTIFIED", entryKind: "job_list" },
        { type: "FILTERS_CONFIRMED" }
      ],
      event: { type: "PAGE_READY", entryKind: "job_list" },
      expected: "applying_filters"
    },
    {
      name: "extracts a ready detail page",
      setup: [{ type: "ENTRY_IDENTIFIED", entryKind: "job_detail" }],
      event: { type: "PAGE_READY", entryKind: "job_detail" },
      expected: "extracting_jobs"
    },
    {
      name: "extracts after filters are applied",
      setup: [
        { type: "ENTRY_IDENTIFIED", entryKind: "job_list" },
        { type: "FILTERS_CONFIRMED" },
        { type: "PAGE_READY", entryKind: "job_list" }
      ],
      event: { type: "FILTERS_APPLIED" },
      expected: "extracting_jobs"
    },
    {
      name: "matches after extraction",
      setup: [
        { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" },
        { type: "PAGE_READY", entryKind: "job_detail" }
      ],
      event: { type: "EXTRACTION_COMPLETE" },
      expected: "matching_jobs"
    },
    {
      name: "pauses when an extraction budget is exhausted",
      setup: [
        { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" },
        { type: "PAGE_READY", entryKind: "job_detail" }
      ],
      event: { type: "BUDGET_EXHAUSTED", reason: "page_limit" },
      expected: "paused"
    },
    {
      name: "waits for selection after matching",
      setup: [
        { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" },
        { type: "PAGE_READY", entryKind: "job_detail" },
        { type: "EXTRACTION_COMPLETE" }
      ],
      event: { type: "MATCHING_COMPLETE" },
      expected: "awaiting_job_selection"
    },
    {
      name: "stores the selected result",
      setup: [
        { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" },
        { type: "PAGE_READY", entryKind: "job_detail" },
        { type: "EXTRACTION_COMPLETE" },
        { type: "MATCHING_COMPLETE" }
      ],
      event: { type: "SELECT", resultId: "result-1" },
      expected: "selected"
    },
    {
      name: "records conversion to an application task",
      setup: [
        { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" },
        { type: "PAGE_READY", entryKind: "job_detail" },
        { type: "EXTRACTION_COMPLETE" },
        { type: "MATCHING_COMPLETE" },
        { type: "SELECT", resultId: "result-1" }
      ],
      event: { type: "APPLICATION_CONVERTED", taskId: "application-1" },
      expected: "converted_to_application"
    }
  ])("$name", ({ setup, event, expected }) => {
    expect(transition(setup, event)).toBe(expected);
  });

  it.each([
    "opening_job_page",
    "applying_filters",
    "extracting_jobs"
  ] as const)("enters challenge handling from %s", (targetState) => {
    const setups: Record<typeof targetState, JobMatchEvent[]> = {
      opening_job_page: [{ type: "ENTRY_IDENTIFIED", entryKind: "job_detail" }],
      applying_filters: [
        { type: "ENTRY_IDENTIFIED", entryKind: "job_list" },
        { type: "FILTERS_CONFIRMED" },
        { type: "PAGE_READY", entryKind: "job_list" }
      ],
      extracting_jobs: [
        { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" },
        { type: "PAGE_READY", entryKind: "job_detail" }
      ]
    };

    expect(transition(setups[targetState], {
      type: "CHALLENGE_DETECTED",
      reason: "captcha"
    })).toBe("awaiting_challenge");
  });

  it.each<{
    name: string;
    setup: JobMatchEvent[];
    resume: JobMatchEvent;
  }>([
    {
      name: "login",
      setup: [
        { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" },
        { type: "LOGIN_REQUIRED" }
      ],
      resume: { type: "USER_RESUME" }
    },
    {
      name: "challenge",
      setup: [
        { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" },
        { type: "CHALLENGE_DETECTED", reason: "risk_control" }
      ],
      resume: { type: "USER_RESUME" }
    },
    {
      name: "paused extraction",
      setup: [
        { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" },
        { type: "PAGE_READY", entryKind: "job_detail" },
        { type: "BUDGET_EXHAUSTED", reason: "page_limit" }
      ],
      resume: { type: "CONTINUE_EXTRACTION" }
    }
  ])("resumes $name through a fresh page opening", ({ setup, resume }) => {
    expect(transition(setup, resume)).toBe("opening_job_page");
  });

  it.each<{
    name: string;
    setup: JobMatchEvent[];
    event: JobMatchEvent;
    expected: JobMatchSessionState;
  }>([
    {
      name: "explicit pause",
      setup: [
        { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" },
        { type: "PAGE_READY", entryKind: "job_detail" }
      ],
      event: { type: "PAUSE", reason: "user_requested" },
      expected: "paused"
    },
    { name: "cancellation", setup: [], event: { type: "CANCEL" }, expected: "cancelled" },
    {
      name: "failure",
      setup: [{ type: "ENTRY_IDENTIFIED", entryKind: "job_detail" }],
      event: { type: "FAIL", errorCode: "adapter_contract_mismatch" },
      expected: "failed"
    },
    {
      name: "expiry",
      setup: [{ type: "ENTRY_IDENTIFIED", entryKind: "job_detail" }],
      event: { type: "EXPIRE", reason: "source_removed" },
      expected: "expired"
    }
  ])("supports $name", ({ setup, event, expected }) => {
    expect(transition(setup, event)).toBe(expected);
  });

  it.each<{
    name: string;
    setup: JobMatchEvent[];
    event: JobMatchEvent;
  }>([
    { name: "pause", setup: [
      { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" },
      { type: "PAGE_READY", entryKind: "job_detail" }
    ], event: { type: "PAUSE", reason: "user_requested" } },
    { name: "challenge", setup: [
      { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" }
    ], event: { type: "CHALLENGE_DETECTED", reason: "captcha" } },
    { name: "cancel", setup: [], event: { type: "CANCEL" } },
    { name: "failure", setup: [], event: { type: "FAIL", errorCode: "fatal" } },
    { name: "expiry", setup: [], event: { type: "EXPIRE", reason: "source_removed" } }
  ])("clears browser authorization on $name", ({ setup, event }) => {
    const actor = createJobMatchMachine(input);
    setup.forEach((setupEvent) => sendJobMatchEvent(actor, setupEvent));
    sendJobMatchEvent(actor, event);

    expect(actor.getSnapshot().context).toMatchObject({
      leaseOwnerId: undefined,
      executionEpoch: undefined
    });
  });

  it("stores state-specific result, pause, challenge, failure, and conversion data", () => {
    const actor = createJobMatchMachine(input);
    sendJobMatchEvent(actor, { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" });
    sendJobMatchEvent(actor, { type: "PAGE_READY", entryKind: "job_detail" });
    sendJobMatchEvent(actor, { type: "BUDGET_EXHAUSTED", reason: "duration_limit" });
    expect(actor.getSnapshot().context.pauseReason).toBe("duration_limit");

    sendJobMatchEvent(actor, { type: "CONTINUE_EXTRACTION" });
    sendJobMatchEvent(actor, { type: "CHALLENGE_DETECTED", reason: "captcha" });
    expect(actor.getSnapshot().context.challengeReason).toBe("captcha");
  });

  it.each<{
    name: string;
    setup: JobMatchEvent[];
    event: JobMatchEvent;
  }>([
    { name: "out-of-order selection", setup: [], event: { type: "SELECT", resultId: "r1" } },
    {
      name: "wrong page branch",
      setup: [
        { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" }
      ],
      event: { type: "PAGE_READY", entryKind: "job_list" }
    },
    {
      name: "duplicate entry identification",
      setup: [{ type: "ENTRY_IDENTIFIED", entryKind: "job_detail" }],
      event: { type: "ENTRY_IDENTIFIED", entryKind: "job_detail" }
    },
    {
      name: "duplicate filter confirmation",
      setup: [
        { type: "ENTRY_IDENTIFIED", entryKind: "job_list" },
        { type: "FILTERS_CONFIRMED" }
      ],
      event: { type: "FILTERS_CONFIRMED" }
    }
  ])("rejects $name", ({ setup, event }) => {
    const actor = createJobMatchMachine(input);
    setup.forEach((setupEvent) => sendJobMatchEvent(actor, setupEvent));

    expect(() => sendJobMatchEvent(actor, event)).toThrow(/不允许/);
  });

  it("does not create a matching session for an application form entry", () => {
    expect(resolveJobMatchEntry("application_form")).toEqual({
      outcome: "redirect",
      redirect: "application"
    });
    expect(resolveJobMatchEntry("job_list")).toEqual({ outcome: "create_session" });
  });

  it("rejects an application form event on a created matching actor", () => {
    const actor = createJobMatchMachine(input);
    expect(() => sendJobMatchEvent(actor, {
      type: "ENTRY_IDENTIFIED",
      entryKind: "application_form" as JobEntryKind
    })).toThrow(/不允许/);
  });
});
