# Agent Runtime architecture

This document describes the Runtime cutover for application, resume, job
matching, and review work. The Runtime is the production task entry point;
the older fixed graph modules remain only as compatibility adapters for code
and tests that have not migrated yet.

## Lifecycle

```text
user input
  -> IntentResolver
  -> CanonicalIntent
  -> Planner / PlanValidator
  -> Supervisor decision
  -> SpecialistAgent or Capability Catalog
  -> observation / evidence / readback
  -> WAIT, replan, human gate, complete, or fail
```

The HTTP lifecycle is exposed by:

- `POST /api/agent/runs` to start a run;
- `GET /api/agent/runs/:runId` to inspect the public state;
- `POST /api/agent/runs/:runId/resume` to deliver a human response;
- `POST /api/agent/runs/:runId/cancel` to cancel a run;
- `GET /api/agent/runs/:runId/events` for JSON replay or SSE streaming.

Application-task routes use the same Runtime through
`createRuntimeApplicationService`. A task-scoped intent only contains
application sub-goals, so opening an application page cannot accidentally
start job matching or resume ingestion.

## Contracts and ownership

`packages/contracts` defines the boundaries shared by the Runtime:

- `CanonicalIntent` records normalized goals, entities, provenance,
  confidence, ambiguity, risk, and autonomy level;
- `PlanState` records dependency-aware steps, revisions, acceptance criteria,
  and approval bindings;
- `SupervisorDecision` permits exactly one dispatch, tool invocation, human
  request, finish, or failure decision per loop;
- `AgentRunResult`, `RuntimeCheckpoint`, and `AgentEvent` expose bounded,
  schema-validated state.

The supervisor never receives browser handles and never writes to the browser
or database. Specialists communicate with it through structured inputs,
output references, evidence references, and observation references.

## Specialist agents

The concrete agents live under `apps/api/src/agent/agents`:

- `ResumeAgent` wraps PDF/OCR extraction and returns document and fact
  references;
- `JobMatchingAgent` returns requirement-level outcomes and evidence;
- `ApplicationAgent` enforces observe -> propose/resolve -> authorize ->
  execute -> readback for browser actions;
- `ReviewAgent` checks evidence, target identity, payload hashes, and
  unsupported claims without submitting anything.

The application agent currently reuses the bounded application execution
adapter for its browser-domain logic. That adapter is behind the specialist
boundary and is not a second production task entry point.

## Browser safety and human approval

Every browser mutation is bound to a fresh observation, `snapshotId`,
`executionEpoch`, `NodeRef`, and target fingerprint. A stale snapshot, changed
frame, invalid node reference, or target mismatch blocks the action and
requires a new observation.

`final_submit` is registered as an irreversible, graph-only capability that
requires a current human approval. The production handler is acknowledgement
only: the application agent can reach a review lock, but no Runtime path sends
the terminal submission. CAPTCHA, authentication, prompt-injection signals,
conflicting facts, and unsupported content are human-gated or fail closed.

## Checkpoints, events, and replay

Runtime checkpoints are stored in `agent_checkpoints`; application progress is
stored separately in the Runtime application state store. The checkpoint
allow-list contains IDs, references, plan metadata, bounded counters,
interrupts, hashes, and terminal status. It excludes Playwright objects,
cookies, passwords, tokens, complete DOM payloads, raw prompts, and binary
documents. Browser snapshots supplied by a caller are transient observation
seeds and are never persisted as checkpoint payloads.

The original request is not restored from a checkpoint. Runtime stores only a
redacted, allow-listed request context in `agent_runtime_request_contexts`
and keeps its reference in the checkpoint, so a process restart can resume
application identity and profile revision without persisting the raw goal or
arbitrary metadata. Evidence provenance is stored separately in
`agent_evidence_records`; checkpoints retain only validated `EvidenceRef`
metadata.

Public events are persisted in SQLite `agent_events`. Event IDs are
deterministic for a run and sequence, and replay accepts either an `after`
cursor or `Last-SSE-Event-ID`. SSE frames contain the event ID, event type,
and redacted public data only. Runtime writes the authoritative lifecycle
events; route-level compatibility events are emitted only when the Runtime
did not produce the corresponding event, and one SSE connection de-duplicates
an event observed by both replay and live subscription.

`apps/api/src/agent/evals/replay-runner.ts` replays validated public traces
without browser or model calls. The offline datasets are in `evals/agent`.

## Default budgets

The Runtime defaults are deliberately finite:

| Budget | Default |
| --- | ---: |
| attempts per step | 2 |
| retries | 64 |
| replans | 8 |
| steps | 32 |
| tool calls | 80 |
| model tokens | 100,000 |
| wall time | 15 minutes |

Cancellation invalidates the active execution epoch, propagates an
`AbortSignal`, persists a cancelled checkpoint, and prevents new side-effect
actions from starting.

## Verification commands

From the repository root:

```powershell
corepack pnpm test
corepack pnpm typecheck
corepack pnpm eval:agent
corepack pnpm test:e2e
```

For a direct offline evaluation run when the package-manager wrapper is not
available:

```powershell
node node_modules/tsx/dist/cli.mjs evals/agent/run-evals.ts
```
