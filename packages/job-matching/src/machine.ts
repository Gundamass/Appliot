import type { JobEntryKind } from "@resume/contracts";
import { assign, createActor, setup, type ActorRefFrom } from "xstate";

export interface JobMatchMachineInput {
  sessionId: string;
  entryUrl: string;
  leaseOwnerId?: string | undefined;
  executionEpoch?: number | undefined;
}

export interface JobMatchContext extends JobMatchMachineInput {
  entryKind?: "job_list" | "job_detail" | undefined;
  pauseReason?: string | undefined;
  challengeReason?: string | undefined;
}

export type JobMatchEvent =
  | { type: "ENTRY_IDENTIFIED"; entryKind: JobEntryKind }
  | { type: "FILTERS_CONFIRMED" }
  | { type: "LOGIN_REQUIRED" }
  | { type: "PAGE_READY"; entryKind: "job_list" | "job_detail" }
  | { type: "FILTERS_APPLIED" }
  | { type: "EXTRACTION_COMPLETE" }
  | { type: "BUDGET_EXHAUSTED"; reason: string }
  | { type: "MATCHING_COMPLETE" }
  | { type: "SELECT"; resultId: string }
  | { type: "APPLICATION_CONVERTED"; taskId: string }
  | { type: "CHALLENGE_DETECTED"; reason: string }
  | { type: "USER_RESUME" }
  | { type: "PAUSE"; reason: string }
  | { type: "CONTINUE_EXTRACTION" }
  | { type: "CANCEL" }
  | { type: "FAIL"; errorCode: string }
  | { type: "EXPIRE"; reason: string };

const jobMatchMachine = setup({
  types: {
    context: {} as JobMatchContext,
    events: {} as JobMatchEvent,
    input: {} as JobMatchMachineInput
  },
  guards: {
    isListEntry: ({ event }) =>
      event.type === "ENTRY_IDENTIFIED" && event.entryKind === "job_list",
    isDetailEntry: ({ event }) =>
      event.type === "ENTRY_IDENTIFIED" && event.entryKind === "job_detail",
    isListPage: ({ context, event }) =>
      context.entryKind === "job_list"
      && event.type === "PAGE_READY"
      && event.entryKind === "job_list",
    isDetailPage: ({ context, event }) =>
      context.entryKind === "job_detail"
      && event.type === "PAGE_READY"
      && event.entryKind === "job_detail"
  },
  actions: {
    storeEntryKind: assign({
      entryKind: ({ event }) =>
        event.type === "ENTRY_IDENTIFIED" && event.entryKind !== "application_form"
          ? event.entryKind
          : undefined
    }),
    clearBrowserAuthorization: assign({
      leaseOwnerId: undefined,
      executionEpoch: undefined
    }),
    clearInterruption: assign({
      pauseReason: undefined,
      challengeReason: undefined
    }),
    storePauseReason: assign({
      pauseReason: ({ event }) =>
        event.type === "BUDGET_EXHAUSTED" || event.type === "PAUSE"
          ? event.reason
          : undefined
    }),
    storeChallengeReason: assign({
      challengeReason: ({ event }) =>
        event.type === "CHALLENGE_DETECTED" ? event.reason : undefined
    })
  }
}).createMachine({
  id: "job-match",
  initial: "created",
  context: ({ input }) => ({ ...input }),
  states: {
    created: {
      on: {
        ENTRY_IDENTIFIED: [
          {
            guard: "isListEntry",
            target: "awaiting_filter_confirmation",
            actions: "storeEntryKind"
          },
          {
            guard: "isDetailEntry",
            target: "opening_job_page",
            actions: "storeEntryKind"
          }
        ]
      }
    },
    awaiting_filter_confirmation: {
      on: { FILTERS_CONFIRMED: "opening_job_page" }
    },
    opening_job_page: {
      on: {
        LOGIN_REQUIRED: {
          target: "awaiting_login",
          actions: "clearBrowserAuthorization"
        },
        PAGE_READY: [
          { guard: "isListPage", target: "applying_filters" },
          { guard: "isDetailPage", target: "extracting_jobs" }
        ],
        CHALLENGE_DETECTED: {
          target: "awaiting_challenge",
          actions: ["storeChallengeReason", "clearBrowserAuthorization"]
        }
      }
    },
    awaiting_login: {
      on: {
        USER_RESUME: {
          target: "opening_job_page",
          actions: "clearInterruption"
        }
      }
    },
    applying_filters: {
      on: {
        FILTERS_APPLIED: "extracting_jobs",
        CHALLENGE_DETECTED: {
          target: "awaiting_challenge",
          actions: ["storeChallengeReason", "clearBrowserAuthorization"]
        }
      }
    },
    extracting_jobs: {
      on: {
        EXTRACTION_COMPLETE: "matching_jobs",
        BUDGET_EXHAUSTED: {
          target: "paused",
          actions: ["storePauseReason", "clearBrowserAuthorization"]
        },
        PAUSE: {
          target: "paused",
          actions: ["storePauseReason", "clearBrowserAuthorization"]
        },
        CHALLENGE_DETECTED: {
          target: "awaiting_challenge",
          actions: ["storeChallengeReason", "clearBrowserAuthorization"]
        }
      }
    },
    matching_jobs: {
      on: { MATCHING_COMPLETE: "awaiting_job_selection" }
    },
    awaiting_job_selection: {
      on: {
        SELECT: "selected"
      }
    },
    selected: {
      on: {
        APPLICATION_CONVERTED: {
          target: "converted_to_application",
          actions: "clearBrowserAuthorization"
        }
      }
    },
    awaiting_challenge: {
      on: {
        USER_RESUME: {
          target: "opening_job_page",
          actions: "clearInterruption"
        }
      }
    },
    paused: {
      on: {
        CONTINUE_EXTRACTION: {
          target: "opening_job_page",
          actions: "clearInterruption"
        }
      }
    },
    converted_to_application: { type: "final" },
    failed: { type: "final" },
    cancelled: { type: "final" },
    expired: { type: "final" }
  },
  on: {
    CANCEL: {
      target: ".cancelled",
      actions: "clearBrowserAuthorization"
    },
    FAIL: {
      target: ".failed",
      actions: "clearBrowserAuthorization"
    },
    EXPIRE: {
      target: ".expired",
      actions: "clearBrowserAuthorization"
    }
  }
});

export type JobMatchActor = ActorRefFrom<typeof jobMatchMachine>;

export function createJobMatchMachine(input: JobMatchMachineInput): JobMatchActor {
  return createActor(jobMatchMachine, { input }).start();
}

export function sendJobMatchEvent(actor: JobMatchActor, event: JobMatchEvent): void {
  const state = actor.getSnapshot();
  if (!state.can(event)) {
    throw new Error(`${String(state.value)} 状态不允许事件 ${event.type}`);
  }
  actor.send(event);
}

export type JobMatchEntryResolution =
  | { outcome: "create_session" }
  | { outcome: "redirect"; redirect: "application" };

export function resolveJobMatchEntry(entryKind: JobEntryKind): JobMatchEntryResolution {
  return entryKind === "application_form"
    ? { outcome: "redirect", redirect: "application" }
    : { outcome: "create_session" };
}
