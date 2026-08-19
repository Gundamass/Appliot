import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ActionPolicy } from "@resume/action-policy";
import type {
  AiHintPackProposal,
  FormField,
  FormSnapshot,
  ReplayAssertion,
  ReplayReport
} from "@resume/contracts";
import { ReplayReportSchema } from "@resume/contracts";
import { certifiedTextEquals, certifiedTextIncludes } from "@resume/form-semantics";
import {
  startSyntheticAts,
  type StartSyntheticAtsOptions,
  type SyntheticAtsServer
} from "../../../synthetic-ats/src/server.js";
import { BrowserWorkerClient } from "../browser/worker-client.js";
import { validateHintPackCandidate } from "./hard-validator.js";

interface SyntheticReplayRunnerOptions {
  startSyntheticAts?: (options?: StartSyntheticAtsOptions) => Promise<SyntheticAtsServer>;
}

export interface SyntheticReplayResult {
  taskId: string;
  reports: ReplayReport[];
}

export class SyntheticReplayRunner {
  private readonly startServer: (options?: StartSyntheticAtsOptions) => Promise<SyntheticAtsServer>;

  constructor(options: SyntheticReplayRunnerOptions = {}) {
    this.startServer = options.startSyntheticAts ?? startSyntheticAts;
  }

  async run(proposal: AiHintPackProposal): Promise<SyntheticReplayResult> {
    const hardAssertions = validateHintPackCandidate(proposal.definition);
    if (hardAssertions.some((assertion) => !assertion.passed)) throw new Error("hard_gate_failed");

    const taskId = `replay-${randomUUID()}`;
    const approvalKey = randomBytes(32);
    const profileDirectory = await createReplayProfileDirectory();
    let browser: BrowserWorkerClient | undefined;
    let server: SyntheticAtsServer | undefined;
    try {
      server = await this.startServer({ fixtureRoot: defaultFixtureRoot() });
      browser = await BrowserWorkerClient.start({
        profileDir: profileDirectory,
        approvalKey,
        headless: true,
        requestTimeoutMs: 5_000,
        shutdownTimeoutMs: 2_000
      });
      const policy = new ActionPolicy(approvalKey);
      const reports: ReplayReport[] = [];
      for (const fixture of proposal.definition.fixtures) {
        reports.push(await runFixture({
          browser,
          hardAssertions,
          policy,
          proposal,
          server,
          taskId,
          fixtureId: fixture.fixtureId,
          expectedProfilePaths: fixture.expectedProfilePaths
        }));
      }
      return { taskId, reports };
    } finally {
      const submissionCount = server?.state(taskId).submissionCount ?? 0;
      await browser?.stop().catch(() => undefined);
      await server?.close().catch(() => undefined);
      await removeReplayProfileDirectory(profileDirectory);
      if (submissionCount !== 0) throw new Error("synthetic_replay_submission_detected");
    }
  }
}

interface FixtureRunInput {
  browser: BrowserWorkerClient;
  hardAssertions: ReplayAssertion[];
  policy: ActionPolicy;
  proposal: AiHintPackProposal;
  server: SyntheticAtsServer;
  taskId: string;
  fixtureId: string;
  expectedProfilePaths: string[];
}

async function runFixture(input: FixtureRunInput): Promise<ReplayReport> {
  const { browser, hardAssertions, policy, proposal, server, taskId, fixtureId, expectedProfilePaths } = input;
  const url = new URL(`/adapter-replay/${encodeURIComponent(fixtureId)}`, server.baseUrl);
  url.searchParams.set("taskId", taskId);
  await browser.open(taskId, url.href);
  const initialState = server.state(taskId);
  let snapshot = (await browser.observe(taskId)).snapshot;
  const initialSnapshot = snapshot;
  const paused = (snapshot.boundaries?.length ?? 0) > 0 || snapshot.challenge !== undefined;
  const executionResults: Array<Awaited<ReturnType<BrowserWorkerClient["execute"]>>> = [];
  const repeatedResults: Array<Awaited<ReturnType<BrowserWorkerClient["execute"]>>> = [];
  const expectedValues = Object.fromEntries(expectedProfilePaths.map((path) => [path, markerFor(path)]));
  const repeatedActions = paused ? [] : findReplayRepeatedActions(snapshot, proposal, expectedProfilePaths);

  if (!paused) {
    let executionEpoch = 1;
    for (const repeated of repeatedActions) {
      const approval = policy.approve({
        taskId,
        snapshotId: snapshot.id,
        targetId: repeated.action.id,
        operation: "click_intermediate",
        nodeRef: repeated.action.nodeRef,
        executionEpoch
      }, snapshot, { valid: snapshot.errors.length === 0 });
      const result = await browser.execute({
        type: "click_intermediate",
        taskId,
        snapshotId: snapshot.id,
        actionId: repeated.action.id,
        nodeRef: repeated.action.nodeRef,
        approval: approval.token,
        executionEpoch
      }, executionEpoch);
      repeatedResults.push(result);
      snapshot = result.status === "applied"
        ? await waitForExpectedReplayFields(browser, taskId, result.snapshot, proposal, expectedProfilePaths)
        : result.snapshot;
      executionEpoch += 1;
    }
    for (const profilePath of expectedProfilePaths) {
      const target = findReplayField(snapshot, proposal, profilePath);
      if (target === undefined) continue;
      const approval = policy.approve({
        taskId,
        snapshotId: snapshot.id,
        targetId: target.id,
        operation: "fill",
        nodeRef: target.nodeRef,
        executionEpoch
      }, snapshot, { valid: snapshot.errors.length === 0 });
      const result = await browser.execute({
        type: "fill",
        taskId,
        snapshotId: snapshot.id,
        fieldId: target.id,
        value: markerFor(profilePath),
        nodeRef: target.nodeRef,
        approval: approval.token,
        executionEpoch
      }, executionEpoch);
      executionResults.push(result);
      snapshot = result.snapshot;
      executionEpoch += 1;
    }
  }

  const firstRead = (await browser.observe(taskId)).snapshot;
  const secondRead = (await browser.observe(taskId)).snapshot;
  const state = paused ? server.state(taskId) : await waitForSyntheticState(server, taskId, expectedValues);
  const assertions = [
    ...hardAssertions,
    assertion(
      "target_value",
      paused
        ? executionResults.length === 0
        : hasExpectedValues(expectedValues, state.runtime.values)
          && executionResults.length === expectedProfilePaths.length
          && executionResults.every((result) => result.status === "applied"),
      paused ? "target writes skipped because the fixture is paused" : `expectedTargets=${expectedProfilePaths.length}; executed=${executionResults.length}`
    ),
    assertion(
      "unrelated_unchanged",
      state.runtime.values.unrelatedSentinel === (initialState.runtime.values.unrelatedSentinel ?? "UNCHANGED")
        && (state.runtime.writeCounts.unrelatedSentinel ?? 0) === 0,
      "unrelated sentinel remains unchanged with zero writes"
    ),
    assertion(
      "repeat_order",
      sameOrder(state.runtime.repeatedOrder, repeatedActions.map((item) => item.section))
        && repeatedResults.every((result) => result.status === "applied"),
      `expectedRepeated=${repeatedActions.length}; observedRepeated=${state.runtime.repeatedOrder.length}; actionStatuses=${repeatedResults.map((result) => result.status).join(",")}`
    ),
    assertion(
      "stable_readback",
      paused || sameReplayValues(firstRead, secondRead, proposal, expectedProfilePaths),
      paused ? "readback skipped because the fixture is paused" : "two consecutive controlled readbacks match"
    ),
    assertion(
      "boundary_paused",
      (initialSnapshot.boundaries?.length ?? 0) === 0 || executionResults.length === 0,
      "boundary fixtures never execute a write"
    ),
    assertion(
      "challenge_paused",
      initialSnapshot.challenge === undefined || executionResults.length === 0,
      "challenge fixtures never execute a write"
    ),
    assertion("zero_submit", state.submissionCount === 0, `submissionCount=${state.submissionCount}`),
    assertion("pii_free_trace", traceIsSanitized({ taskId, fixtureId, executionCount: executionResults.length }), "trace stores IDs and counts only")
  ];
  const status = assertions.every((item) => item.passed) ? "passed" : "failed";
  return ReplayReportSchema.parse({
    reportId: randomUUID(),
    proposalId: proposal.proposalId,
    fixtureId,
    status,
    assertions,
    submissionCount: state.submissionCount,
    inputHash: hash({ proposalId: proposal.proposalId, fixtureId, expectedProfilePaths }),
    createdAt: new Date().toISOString()
  });
}

function findReplayField(snapshot: FormSnapshot, proposal: AiHintPackProposal, profilePath: string): FormField | undefined {
  const rule = proposal.definition.fieldRules.find((candidate) => candidate.profilePath === profilePath);
  if (rule === undefined) return undefined;
  return snapshot.fields.find((field) => rule.controlTypes.includes(field.type)
    && (rule.sections.length === 0 || (field.sectionHint !== undefined && rule.sections.includes(field.sectionHint)))
    && rule.labelAliases.some((alias) => certifiedTextEquals(field.label, alias)));
}

function sameReplayValues(
  first: FormSnapshot,
  second: FormSnapshot,
  proposal: AiHintPackProposal,
  expectedProfilePaths: string[]
): boolean {
  return expectedProfilePaths.every((profilePath) => {
    const firstField = findReplayField(first, proposal, profilePath);
    const secondField = findReplayField(second, proposal, profilePath);
    return firstField?.currentValue === secondField?.currentValue && firstField?.currentValue === markerFor(profilePath);
  });
}

function findReplayRepeatedActions(
  snapshot: FormSnapshot,
  proposal: AiHintPackProposal,
  expectedProfilePaths: string[]
): Array<{ action: FormSnapshot["actions"][number]; section: string }> {
  const expectedSections = new Set(expectedProfilePaths.map(sectionForProfilePath).filter((value): value is string => value !== undefined));
  const seenActions = new Set<string>();
  return snapshot.actions.flatMap((action) => proposal.definition.actionRules.flatMap((rule) => {
    if (rule.kind !== "add_repeated_entry"
      || !rule.verbs.some((verb) => certifiedTextIncludes(action.text, verb))
      || (action.class !== "intermediate_navigation" && action.class !== "intermediate_save")) {
      return [];
    }
    const context = `${action.context ?? ""} ${action.text}`;
    const section = proposal.definition.sectionRules.find((candidate) => expectedSections.has(candidate.section)
      && rule.sections.includes(candidate.section as typeof rule.sections[number])
      && candidate.headingAliases.some((heading) => certifiedTextIncludes(context, heading)))?.section;
    if (section === undefined || seenActions.has(action.id)) return [];
    seenActions.add(action.id);
    return [{ action, section }];
  }));
}

async function waitForExpectedReplayFields(
  browser: BrowserWorkerClient,
  taskId: string,
  initial: FormSnapshot,
  proposal: AiHintPackProposal,
  expectedProfilePaths: string[]
): Promise<FormSnapshot> {
  let snapshot = initial;
  const deadline = Date.now() + 2_000;
  while (!expectedProfilePaths.every((profilePath) => findReplayField(snapshot, proposal, profilePath) !== undefined)
    && Date.now() < deadline) {
    await delay(25);
    snapshot = (await browser.observe(taskId)).snapshot;
  }
  return snapshot;
}

async function waitForSyntheticState(
  server: SyntheticAtsServer,
  taskId: string,
  expectedValues: Record<string, string>
): Promise<ReturnType<SyntheticAtsServer["state"]>> {
  const deadline = Date.now() + 2_000;
  let state = server.state(taskId);
  while (!hasExpectedValues(expectedValues, state.runtime.values) && Date.now() < deadline) {
    await delay(25);
    state = server.state(taskId);
  }
  return state;
}

function hasExpectedValues(expected: Record<string, string>, actual: Record<string, string>): boolean {
  return Object.entries(expected).every(([profilePath, value]) => actual[replayKey(profilePath)] === value);
}

function replayKey(profilePath: string): string {
  if (profilePath === "basics.name") return "name";
  if (profilePath === "education[0].institution") return "school";
  return profilePath;
}

function markerFor(profilePath: string): string {
  return `MARKER_${profilePath.replace(/\W+/gu, "_")}`;
}

function assertion(code: ReplayAssertion["code"], passed: boolean, detail: string): ReplayAssertion {
  return { code, passed, detail };
}

function traceIsSanitized(trace: Record<string, unknown>): boolean {
  return Object.entries(trace).every(([key, value]) => /^[a-zA-Z][a-zA-Z0-9]*$/u.test(key)
    && (typeof value === "string" || typeof value === "number"));
}

function sectionForProfilePath(profilePath: string): string | undefined {
  return /^(education|work|internship|work_combined|projects|awards|laboratory|languages)\[/u.exec(profilePath)?.[1];
}

function sameOrder(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function defaultFixtureRoot(): URL {
  const modulePath = fileURLToPath(import.meta.url);
  return /[\\/]dist[\\/]server\.js$/u.test(modulePath)
    ? new URL("./synthetic-ats-public/", import.meta.url)
    : new URL("../../../synthetic-ats/public/", import.meta.url);
}

async function createReplayProfileDirectory(): Promise<string> {
  return resolve(await mkdtemp(join(tmpdir(), "resume-ats-replay-")));
}

async function removeReplayProfileDirectory(profileDirectory: string): Promise<void> {
  const temporaryRoot = resolve(tmpdir());
  const relativePath = relative(temporaryRoot, profileDirectory);
  if (relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)
    || !basename(profileDirectory).startsWith("resume-ats-replay-")) {
    throw new Error("replay_profile_directory_outside_temporary_root");
  }
  await rm(profileDirectory, {
    recursive: true,
    force: true,
    maxRetries: 40,
    retryDelay: 250
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
