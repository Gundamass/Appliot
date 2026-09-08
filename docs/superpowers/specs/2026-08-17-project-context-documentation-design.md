# Independent Repository Project Context Documentation Design

## Purpose

Create a compact, source-grounded representation of each independent repository so an interviewer can understand the project and inspect its implementation without first reading the full codebase.

The documentation is project context only. It must not contain interview question banks, suggested follow-up questions, resume wording, or comparisons that imply the repositories form one system.

## Repository Scope

The documentation covers four independent repositories:

- `E:\projects\简历投递助手`
- `E:\projects\full-redbook-backend`
- `E:\projects\datacenter\bigdata-backend-sx`
- `E:\projects\hm-dianping`

Each repository is analyzed, documented, and verified independently. The context documents must not create a cross-repository call graph, shared runtime architecture, or integration relationship.

Generated context artifacts are stored outside the repositories under `E:\projects\docs`, with one directory per repository. The repositories themselves are not modified by this documentation task.

## Goals

For each repository, the resulting documents must let a reader determine:

- what the project does and where its boundaries are;
- how the repository is organized internally;
- how its main use cases execute from entry point to persistence or output;
- which modules, interfaces, data structures, and runtime components are important;
- how the implementation handles state, failures, concurrency, security, performance, testing, and deployment;
- which claims are implemented, partially implemented, planned, or absent;
- where the supporting source code can be found.

The documents must compress the codebase, not reproduce it. Important claims must remain traceable to files and symbols.

## Non-Goals

The documentation will not:

- generate interview questions or interviewer scripts;
- recommend how to describe a project on a resume;
- rank or compare the repositories;
- invent reasons for design choices that are not supported by source, tests, configuration, documentation, or commit history;
- describe planned features as implemented behavior;
- create empty detail documents merely to keep repository layouts identical.

## Documentation Architecture

Every repository receives `E:\projects\docs\<repository-name>\PROJECT_CONTEXT.md`. This is the required entry point and is designed for progressive reading.

Small repositories may keep all content in that file. Larger repositories may add detail files beside it under `E:\projects\docs\<repository-name>\project-context\`, containing only the detail documents justified by their implementation.

The maximum detail-document set is:

```text
<repository-name>/PROJECT_CONTEXT.md
<repository-name>/project-context/
|-- 01-architecture.md
|-- 02-business-flows.md
|-- 03-data-and-state.md
|-- 04-interfaces-and-integrations.md
|-- 05-core-implementation.md
|-- 06-engineering-quality.md
|-- 07-runtime-and-deployment.md
|-- 08-status-and-limitations.md
`-- 09-source-map.md
```

The numbering provides a stable reading order. A repository may omit any file that lacks meaningful content.

## Root Context File

`PROJECT_CONTEXT.md` must be understandable without opening a detail file. It contains:

1. Document metadata: repository, analyzed commit, date, included and excluded paths.
2. Project summary: problem, users, scenarios, capabilities, boundaries, current status.
3. Technology inventory: languages, frameworks, databases, middleware, external services, and build tools.
4. Internal architecture summary: layers, modules, runtime components, and dependency direction within this repository.
5. Core workflow summary: the small set of flows that best explain the project.
6. Data and interface summary: principal entities, persistence mechanisms, public interfaces, background work, and external dependencies.
7. Engineering summary: reliability, consistency, concurrency, security, performance, observability, testing, and deployment mechanisms that actually exist.
8. Implementation status: implemented, partial, placeholder, and absent capabilities where that distinction is material.
9. Reading guide: links to generated detail documents and the questions each document answers.
10. High-value source index: the minimum set of entry points and symbols needed to begin code inspection.

The opening summary should remain readable in one to two pages. Detailed sections follow it or move to detail documents when they would obscure the overview.

## Detail Document Definitions

### Architecture

`01-architecture.md` describes internal layers, component boundaries, dependency direction, startup composition, runtime topology, and source-supported architectural decisions.

### Business Flows

`02-business-flows.md` documents each core use case as a complete path: trigger, preconditions, ordered calls, validation, data and state changes, successful outcome, failure branches, retry or compensation behavior, and source references.

One workflow must not be fragmented across several detail documents.

### Data and State

`03-data-and-state.md` covers domain entities, schemas, relationships, indexes, caches, transactions, state machines, lifecycle rules, and consistency boundaries.

### Interfaces and Integrations

`04-interfaces-and-integrations.md` covers HTTP or RPC endpoints, messages, scheduled work, background jobs, authentication, validation, request and response types, error contracts, and third-party services.

### Core Implementation

`05-core-implementation.md` explains the most consequential classes, functions, algorithms, patterns, extension points, and implementation constraints. It summarizes behavior and links to source rather than pasting large code blocks.

### Engineering Quality

`06-engineering-quality.md` records implemented mechanisms for concurrency, idempotency, transactions, retries, timeouts, degradation, resource cleanup, security, performance, logging, metrics, and tests. Missing mechanisms are mentioned only when their absence materially affects current behavior.

### Runtime and Deployment

`07-runtime-and-deployment.md` describes configuration, startup order, processes, environment dependencies, build artifacts, deployment, health checks, migrations, and recovery procedures.

### Status and Limitations

`08-status-and-limitations.md` distinguishes implemented, partial, placeholder, disabled, and planned behavior. It also records verified limitations and technical debt without turning them into recommendations unrelated to understanding the current project.

### Source Map

`09-source-map.md` maps business capabilities to modules, files, and symbols. It is a navigation aid, not a complete file inventory.

## Detail Split Rules

A section moves out of `PROJECT_CONTEXT.md` when at least one of these conditions applies:

- it requires roughly 2,000 to 3,000 Chinese characters to explain accurately;
- it contains several independent workflows, components, state machines, or interface groups;
- a reader may reasonably need the subject without loading other implementation detail;
- keeping it in the root file would make the overview difficult to scan.

A detail file is not created when it would contain only headings, repeat the root summary, or describe functionality absent from the repository.

Expected total size is approximately 8,000 to 15,000 Chinese characters per repository, adjusted for actual complexity. Accuracy and density take priority over equal length.

## Evidence Standard

Every material technical claim must be supported by one or more of:

- current source code and named symbols;
- executable configuration or schemas;
- tests that demonstrate behavior;
- build and deployment definitions;
- existing repository documentation;
- commit history when it is needed to establish intent.

CodeGraph is used before text search in repositories containing `.codegraph/`. In repositories without an index, normal source discovery is used.

Source references use repository-relative paths and, where stable and useful, symbol names. Line numbers may be included as supplemental navigation but must not be the only identifier because they drift after edits.

Assertions about motivation use explicit wording:

- `The implementation does ...` for directly observed behavior.
- `Tests verify ...` for behavior demonstrated by tests.
- `Existing documentation states ...` for documented intent.
- `The reason is not recorded in the repository` when motivation cannot be proved.

## Implementation Status Vocabulary

All repositories use the same status vocabulary:

- **Implemented**: reachable production code exists and is supported by configuration or tests.
- **Partial**: meaningful code exists, but an essential path, integration, or operating condition is incomplete.
- **Placeholder**: interfaces, stubs, mock behavior, or scaffolding exist without the real implementation.
- **Disabled**: implementation exists but is not active under the current composition or configuration.
- **Planned**: only specifications, TODOs, issues, or design documents describe the capability.
- **Absent**: no supporting implementation was found within the documented analysis scope.

## Per-Document Metadata

Every generated document includes:

```markdown
- Repository: <name>
- Analyzed commit: <commit>
- Generated: <date>
- Analysis scope: <paths>
- Prerequisites: <documents to read first, if any>
```

This makes staleness and scope visible when the repository changes.

## Verification

Each repository is verified independently before its documentation is considered complete:

1. Confirm the recorded commit and analysis scope.
2. Check every linked path and named symbol exists.
3. Trace each documented core flow against source and tests.
4. Check architecture and dependency statements against build manifests and composition roots.
5. Check data and interface descriptions against schemas, migrations, DTOs, and route definitions.
6. Search for unsupported wording such as unqualified claims of completeness, guarantees, or design intent.
7. Check status labels against reachable implementation and configuration.
8. Ensure no interview questions, resume language, or cross-repository architecture claims were introduced.
9. Confirm the root context file links only to detail files that exist.

## Delivery Order

Repositories are processed one at a time. Each repository passes its own source verification before work begins on the next repository. This prevents facts, terminology, or architecture from one independent project leaking into another.

The final deliverable is the set of repository-local context documents. No central document is required to combine the projects because they do not form a single system.
