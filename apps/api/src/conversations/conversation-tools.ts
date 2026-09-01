import { createHash } from "node:crypto";
import {
  ConversationCardSchema,
  RecruitmentSearchRequestSchema,
  RecruitmentSiteSearchResultSchema,
  VerifiedRecruitmentSiteSchema,
  type ConversationCard,
  type RecruitmentSearchRequest,
  type RecruitmentSiteSearchResult,
  type VerifiedRecruitmentSite,
  type JobMatchResult
} from "@resume/contracts";
import type { ApplicationService } from "../applications/application-service.js";
import type {
  ApplicationTaskRepository,
  StoredApplicationTask
} from "../applications/application-task-repository.js";
import type {
  JobMatchAggregate,
  JobMatchRepository
} from "../job-matching/job-match-repository.js";
import { z } from "zod";

const IdentifierSchema = z.string().min(1).max(256);

export const conversationToolNames = [
  "discover_recruitment_site",
  "create_job_match_session",
  "list_recommendations",
  "show_recommendation",
  "list_application_tasks",
  "show_application_task",
  "create_application_task"
] as const;

export type ConversationToolName = typeof conversationToolNames[number];

export interface ConversationToolContext {
  conversationId: string;
  recentPostingIds: string[];
  activeJobMatchSessionId?: string;
  selectedPostingId?: string;
  activeApplicationTaskId?: string;
  verifiedRecruitmentSite?: VerifiedRecruitmentSite;
}

export interface ConversationToolResult {
  cards: ConversationCard[];
  task?: StoredApplicationTask;
  recommendation?: {
    sessionId: string;
    resultId: string;
    postingId: string;
    postingContentHash: string;
  };
  recruitmentSite?: VerifiedRecruitmentSite;
  recruitmentSearch?: RecruitmentSiteSearchResult;
  jobMatchSession?: {
    sessionId: string;
    state: string;
    postingIds: string[];
  };
}

export interface ConversationToolDependencies {
  jobMatchRepository: Pick<JobMatchRepository, "get">;
  applicationTasks: Pick<ApplicationTaskRepository, "list" | "get" | "createFromJob">;
  applicationService?: Pick<ApplicationService, "start"> & Partial<Pick<ApplicationService, "state">>;
  searchRecruitmentSites?: (
    input: RecruitmentSearchRequest
  ) => Promise<RecruitmentSiteSearchResult>;
  jobMatchService?: {
    create?(input: { url: string }): Promise<JobMatchAggregate | { redirect: "application"; applicationUrl: string }>;
    select(sessionId: string, input: {
      sessionVersion: number;
      idempotencyKey: string;
      resultId: string;
      resultVersion: number;
      postingContentHash: string;
    }): unknown;
    convert(sessionId: string, input: {
      sessionVersion: number;
      idempotencyKey: string;
      resultId: string;
      resultVersion: number;
      postingContentHash: string;
    }): Promise<StoredApplicationTask>;
  };
  createTaskId?: (conversationId: string, resultId: string) => string;
}

const ListRecommendationsInputSchema = z.object({
  sessionId: IdentifierSchema.optional()
}).strict();

const ShowRecommendationInputSchema = z.object({
  sessionId: IdentifierSchema,
  resultId: IdentifierSchema
}).strict();

const ListApplicationTasksInputSchema = z.object({}).strict();

const ShowApplicationTaskInputSchema = z.object({
  taskId: IdentifierSchema
}).strict();

const CreateApplicationTaskInputSchema = z.object({
  sessionId: IdentifierSchema,
  resultId: IdentifierSchema,
  postingContentHash: z.string().min(1).max(256)
}).strict();

export const DiscoverRecruitmentSiteInputSchema = z.object({
  company: z.string().trim().min(1).max(80),
  recruitmentType: z.enum(["campus", "social", "internship", "unknown"])
}).strict();

const CreateJobMatchSessionInputSchema = z.object({}).strict();

export function createConversationToolRegistry(dependencies: ConversationToolDependencies) {
  const names = [...conversationToolNames] as ConversationToolName[];
  const createTaskId = dependencies.createTaskId ?? defaultTaskId;

  return {
    names(): ConversationToolName[] {
      return [...names];
    },

    async invoke(
      name: ConversationToolName,
      rawInput: unknown,
      rawContext: ConversationToolContext
    ): Promise<ConversationToolResult> {
      if (!isConversationToolName(name)) throw new Error("tool_not_allowed");
      const context = parseContext(rawContext);
      try {
        let result: ConversationToolResult;
        switch (name) {
          case "discover_recruitment_site": {
            const input = DiscoverRecruitmentSiteInputSchema.parse(rawInput);
            result = await discoverRecruitmentSite(dependencies, input, context);
            break;
          }
          case "create_job_match_session": {
            CreateJobMatchSessionInputSchema.parse(rawInput);
            result = await createJobMatchSession(dependencies, context);
            break;
          }
          case "list_recommendations": {
            const input = ListRecommendationsInputSchema.parse(rawInput);
            const sessionId = input.sessionId ?? context.activeJobMatchSessionId;
            result = sessionId === undefined
              ? { cards: [] }
              : listRecommendations(dependencies, sessionId, context);
            break;
          }
          case "show_recommendation": {
            const input = ShowRecommendationInputSchema.parse(rawInput);
            result = showRecommendation(dependencies, input.sessionId, input.resultId, context);
            break;
          }
          case "list_application_tasks": {
            ListApplicationTasksInputSchema.parse(rawInput);
            result = {
              cards: dependencies.applicationTasks.list().map((task) => taskCard(dependencies, task))
            };
            break;
          }
          case "show_application_task": {
            const input = ShowApplicationTaskInputSchema.parse(rawInput);
            const task = dependencies.applicationTasks.get(input.taskId);
            if (task === undefined) throw new Error("application_task_not_found");
            result = { cards: [taskCard(dependencies, task)], task };
            break;
          }
          case "create_application_task": {
            const input = CreateApplicationTaskInputSchema.parse(rawInput);
            result = await createApplicationTask(dependencies, input, context, createTaskId);
            break;
          }
        }
        return validateResult(result);
      } catch (error) {
        throw normalizeToolError(error);
      }
    }
  };
}

function listRecommendations(
  dependencies: ConversationToolDependencies,
  sessionId: string,
  context: ConversationToolContext
): ConversationToolResult {
  const aggregate = requireAggregate(dependencies, sessionId);
  const allowedPostingIds = new Set(context.recentPostingIds);
  const results = aggregate.results
    .filter((result) => !result.stale)
    .filter((result) => allowedPostingIds.size === 0 || allowedPostingIds.has(result.postingId))
    .sort((left, right) => right.rankingScore - left.rankingScore || left.id.localeCompare(right.id));
  return {
    cards: results.map((result) => recommendationCard(aggregate, result))
  };
}

function showRecommendation(
  dependencies: ConversationToolDependencies,
  sessionId: string,
  resultId: string,
  context: ConversationToolContext
): ConversationToolResult {
  const aggregate = requireAggregate(dependencies, sessionId);
  const result = aggregate.results.find((candidate) => candidate.id === resultId);
  if (result === undefined) throw new Error("recommendation_not_found");
  if (result.stale) throw new Error("recommendation_stale");
  if (context.recentPostingIds.length > 0 && !context.recentPostingIds.includes(result.postingId)) {
    throw new Error("recommendation_not_in_context");
  }
  return {
    cards: [recommendationCard(aggregate, result)],
    recommendation: {
      sessionId,
      resultId,
      postingId: result.postingId,
      postingContentHash: result.postingContentHash
    }
  };
}

async function createApplicationTask(
  dependencies: ConversationToolDependencies,
  input: z.infer<typeof CreateApplicationTaskInputSchema>,
  context: ConversationToolContext,
  createTaskId: (conversationId: string, resultId: string) => string
): Promise<ConversationToolResult> {
  const aggregate = requireAggregate(dependencies, input.sessionId);
  const result = aggregate.results.find((candidate) => candidate.id === input.resultId);
  if (result === undefined) throw new Error("recommendation_not_found");
  if (result.stale) throw new Error("recommendation_stale");
  const posting = aggregate.postings.find((candidate) => candidate.id === result.postingId);
  if (posting === undefined) throw new Error("recommendation_posting_not_found");
  if (posting.contentHash !== input.postingContentHash || result.postingContentHash !== input.postingContentHash) {
    throw new Error("job_match_posting_changed");
  }

  const idempotencyKey = `conversation-${context.conversationId}-${input.resultId}`.slice(0, 128);
  const selection = {
    sessionVersion: aggregate.version,
    idempotencyKey,
    resultId: result.id,
    resultVersion: result.version,
    postingContentHash: input.postingContentHash
  };
  let task: StoredApplicationTask;
  if (dependencies.jobMatchService !== undefined) {
    if (aggregate.selectedResultId !== result.id) {
      dependencies.jobMatchService.select(input.sessionId, selection);
    }
    const selected = dependencies.jobMatchRepository.get(input.sessionId);
    if (selected === undefined) throw new Error("job_match_session_not_found");
    task = await dependencies.jobMatchService.convert(input.sessionId, {
      ...selection,
      sessionVersion: selected.version
    });
  } else {
    task = dependencies.applicationTasks.createFromJob({
      id: createTaskId(context.conversationId, result.id),
      name: posting.title,
      applicationUrl: posting.canonicalUrl
    });
  }

  if (dependencies.applicationService?.start !== undefined) {
    try {
      dependencies.applicationService.start({ taskId: task.id, applicationUrl: task.applicationUrl });
    } catch (error) {
      if (!isAlreadyStarted(error)) throw error;
    }
  }

  return {
    cards: [taskCard(dependencies, task)],
    task,
    recommendation: {
      sessionId: input.sessionId,
      resultId: result.id,
      postingId: result.postingId,
      postingContentHash: result.postingContentHash
    }
  };
}

async function discoverRecruitmentSite(
  dependencies: ConversationToolDependencies,
  input: z.infer<typeof DiscoverRecruitmentSiteInputSchema>,
  context: ConversationToolContext
): Promise<ConversationToolResult> {
  if (dependencies.searchRecruitmentSites === undefined) throw new Error("TAVILY_NOT_CONFIGURED");
  const request = RecruitmentSearchRequestSchema.parse({
    companyName: input.company,
    recruitmentType: input.recruitmentType
  });
  const search = RecruitmentSiteSearchResultSchema.parse(await dependencies.searchRecruitmentSites(request));
  return { cards: [], recruitmentSearch: search };
}

async function createJobMatchSession(
  dependencies: ConversationToolDependencies,
  context: ConversationToolContext
): Promise<ConversationToolResult> {
  const site = context.verifiedRecruitmentSite;
  if (site === undefined) throw new Error("recruitment_site_confirmation_required");
  if (dependencies.jobMatchService?.create === undefined) {
    throw new Error("job_match_create_unavailable");
  }
  const created = await dependencies.jobMatchService.create({ url: site.url });
  if (!isJobMatchAggregate(created)) {
    throw new Error("job_match_application_redirect");
  }
  const aggregate = created;
  const resultCards = aggregate.results
    .filter((result) => !result.stale)
    .sort((left, right) => right.rankingScore - left.rankingScore || left.id.localeCompare(right.id))
    .slice(0, 18)
    .map((result) => recommendationCard(aggregate, result));
  return {
    cards: [
      recruitmentSiteCard(site),
      jobMatchSessionCard(aggregate),
      ...resultCards
    ],
    recruitmentSite: site,
    jobMatchSession: {
      sessionId: aggregate.id,
      state: aggregate.state,
      postingIds: aggregate.results.map((result) => result.postingId).slice(0, 50)
    }
  };
}

function recommendationCard(aggregate: JobMatchAggregate, result: JobMatchResult): ConversationCard {
  const posting = aggregate.postings.find((candidate) => candidate.id === result.postingId);
  if (posting === undefined) throw new Error("recommendation_posting_not_found");
  return ConversationCardSchema.parse({
    type: "recommendation",
    sessionId: aggregate.id,
    resultId: result.id,
    title: posting.title,
    company: posting.organization,
    score: result.rankingScore,
    evidenceCount: result.evidence.length,
    postingContentHash: result.postingContentHash
  });
}

function taskCard(
  dependencies: ConversationToolDependencies,
  task: StoredApplicationTask
): ConversationCard {
  let state = "created";
  if (dependencies.applicationService?.state !== undefined) {
    try {
      state = String(dependencies.applicationService.state(task.id).value);
    } catch {
      state = "created";
    }
  }
  return ConversationCardSchema.parse({
    type: "application_task",
    taskId: task.id,
    title: task.name,
    state,
    applicationUrl: task.applicationUrl
  });
}

function recruitmentSiteCard(site: VerifiedRecruitmentSite): ConversationCard {
  return ConversationCardSchema.parse({ type: "recruitment_site", ...site });
}

function jobMatchSessionCard(aggregate: JobMatchAggregate): ConversationCard {
  return ConversationCardSchema.parse({
    type: "job_match_session",
    sessionId: aggregate.id,
    initialUrl: aggregate.initialUrl,
    state: aggregate.state,
    postingCount: aggregate.postings.length
  });
}

function requireAggregate(
  dependencies: ConversationToolDependencies,
  sessionId: string
): JobMatchAggregate {
  const aggregate = dependencies.jobMatchRepository.get(sessionId);
  if (aggregate === undefined) throw new Error("job_match_session_not_found");
  return aggregate;
}

function parseContext(value: ConversationToolContext): ConversationToolContext {
  const parsed = z.object({
    conversationId: IdentifierSchema,
    recentPostingIds: z.array(IdentifierSchema).max(50),
    activeJobMatchSessionId: IdentifierSchema.optional(),
    selectedPostingId: IdentifierSchema.optional(),
    activeApplicationTaskId: IdentifierSchema.optional(),
    verifiedRecruitmentSite: VerifiedRecruitmentSiteSchema.optional()
  }).strict().parse(value);
  return {
    conversationId: parsed.conversationId,
    recentPostingIds: parsed.recentPostingIds,
    ...(parsed.activeJobMatchSessionId === undefined ? {} : { activeJobMatchSessionId: parsed.activeJobMatchSessionId }),
    ...(parsed.selectedPostingId === undefined ? {} : { selectedPostingId: parsed.selectedPostingId }),
    ...(parsed.activeApplicationTaskId === undefined ? {} : { activeApplicationTaskId: parsed.activeApplicationTaskId }),
    ...(parsed.verifiedRecruitmentSite === undefined ? {} : { verifiedRecruitmentSite: parsed.verifiedRecruitmentSite })
  };
}

function validateResult(value: ConversationToolResult): ConversationToolResult {
  return {
    cards: value.cards.map((card) => ConversationCardSchema.parse(card)),
    ...(value.task === undefined ? {} : { task: value.task }),
    ...(value.recommendation === undefined ? {} : { recommendation: value.recommendation }),
    ...(value.recruitmentSite === undefined ? {} : { recruitmentSite: VerifiedRecruitmentSiteSchema.parse(value.recruitmentSite) }),
    ...(value.recruitmentSearch === undefined ? {} : { recruitmentSearch: RecruitmentSiteSearchResultSchema.parse(value.recruitmentSearch) }),
    ...(value.jobMatchSession === undefined ? {} : { jobMatchSession: value.jobMatchSession })
  };
}

function isJobMatchAggregate(value: JobMatchAggregate | { redirect: "application"; applicationUrl: string }): value is JobMatchAggregate {
  return typeof value === "object"
    && value !== null
    && "id" in value
    && typeof value.id === "string"
    && "postings" in value
    && Array.isArray(value.postings)
    && "results" in value
    && Array.isArray(value.results);
}

function normalizeToolError(error: unknown): Error {
  if (error instanceof z.ZodError) return new Error("tool_input_invalid");
  if (error instanceof Error && /^[A-Za-z0-9_:-]+$/u.test(error.message)) return error;
  return new Error("tool_execution_failed");
}

function isConversationToolName(value: unknown): value is ConversationToolName {
  return typeof value === "string" && (conversationToolNames as readonly string[]).includes(value);
}

function isAlreadyStarted(error: unknown): boolean {
  return error instanceof Error && (
    error.message === "application_task_already_started"
    || error.message.includes("投递任务已存在")
  );
}

function defaultTaskId(conversationId: string, resultId: string): string {
  return `conversation-application-${createHash("sha256").update(`${conversationId}\u0000${resultId}`).digest("hex").slice(0, 32)}`;
}
