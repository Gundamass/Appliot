import { assign, setup, type ActorRefFrom } from "xstate";
import type { ApplicationQuestion } from "@resume/contracts";

export type ApplicationStateValue =
  | "created"
  | "observing"
  | "awaiting_login"
  | "needs_questions"
  | "awaiting_content_review"
  | "filling"
  | "validating"
  | "navigating"
  | "review_locked"
  | "cancelled"
  | "failed";

export interface ApplicationContext {
  taskId: string;
  applicationUrl: string;
  questions: ApplicationQuestion[];
  errors: string[];
}

export type ApplicationEvent =
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
  | { type: "CANCEL" }
  | { type: "RECOVER" }
  | { type: "RETRY" }
  | { type: "FAIL"; errors: string[] };

export const applicationMachine = setup({
  types: {
    context: {} as ApplicationContext,
    events: {} as ApplicationEvent,
    input: {} as { taskId: string; applicationUrl: string }
  },
  actions: {
    storeQuestions: assign({ questions: ({ event }) =>
      event.type === "QUESTIONS_REQUIRED" ? event.questions : [] }),
    clearQuestions: assign({ questions: [] }),
    storeErrors: assign({ errors: ({ event }) =>
      "errors" in event ? event.errors : [] }),
    clearErrors: assign({ errors: [] })
  }
}).createMachine({
  id: "resume-application",
  initial: "created",
  context: ({ input }) => ({
    taskId: input.taskId,
    applicationUrl: input.applicationUrl,
    questions: [],
    errors: []
  }),
  states: {
    created: { on: { START: "observing" } },
    observing: {
      on: {
        LOGIN_REQUIRED: "awaiting_login",
        QUESTIONS_REQUIRED: { target: "needs_questions", actions: "storeQuestions" },
        CONTENT_REVIEW_REQUIRED: "awaiting_content_review",
        READY_TO_FILL: { target: "filling", actions: ["clearQuestions", "clearErrors"] },
        REVIEW_REACHED: "review_locked",
        FAIL: { target: "failed", actions: "storeErrors" },
        RECOVER: { target: "observing", actions: "clearErrors" }
      }
    },
    awaiting_login: { on: { RESUME: "observing" } },
    needs_questions: {
      on: {
        ANSWERS_PROVIDED: { target: "observing", actions: "clearQuestions" },
        PROFILE_UPDATED: { target: "observing", actions: "clearQuestions" }
      }
    },
    awaiting_content_review: {
      on: {
        CONTENT_APPROVED: "filling",
        CONTENT_REJECTED: { target: "failed", actions: "storeErrors" }
      }
    },
    filling: {
      on: {
        PAGE_FILLED: "validating",
        QUESTIONS_REQUIRED: { target: "needs_questions", actions: "storeQuestions" },
        CONTENT_REVIEW_REQUIRED: "awaiting_content_review",
        REVIEW_REACHED: "review_locked",
        FAIL: { target: "failed", actions: "storeErrors" },
        RECOVER: { target: "observing", actions: "clearErrors" }
      }
    },
    validating: {
      on: {
        PAGE_VALID: "navigating",
        PAGE_INVALID: { target: "needs_questions", actions: "storeErrors" },
        REVIEW_REACHED: "review_locked",
        FAIL: { target: "failed", actions: "storeErrors" },
        RECOVER: { target: "observing", actions: "clearErrors" }
      }
    },
    navigating: {
      on: {
        PAGE_NAVIGATED: "observing",
        REVIEW_REACHED: "review_locked",
        FAIL: { target: "failed", actions: "storeErrors" },
        RECOVER: { target: "observing", actions: "clearErrors" }
      }
    },
    review_locked: { on: { CANCEL: undefined } },
    cancelled: {},
    failed: { on: {
      RETRY: { target: "observing", actions: "clearErrors" },
      RECOVER: { target: "observing", actions: "clearErrors" }
    } }
  },
  on: { CANCEL: ".cancelled" }
});

export type ApplicationActor = ActorRefFrom<typeof applicationMachine>;

export function sendApplicationEvent(actor: ApplicationActor, event: ApplicationEvent): void {
  const state = actor.getSnapshot();
  if (!state.can(event)) {
    throw new Error(`${String(state.value)} 状态不允许事件 ${event.type}`);
  }
  actor.send(event);
}
