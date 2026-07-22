# Task 2 Report: SQLite Persistence and Fact Revision Rules

## Status

Implemented Task 2 in `E:\projects\简历投递助手\.worktrees\resume-assistant-foundation` using test-first development. The API package pins the planned SQLite dependencies: `better-sqlite3@11.10.0`, `drizzle-orm@0.44.2`, and `@types/better-sqlite3@7.6.13`.

Commit: `d0388027b80cd27609b4202ef3ab0e2d95c6d376` (`feat: persist source-backed profile facts`).

## RED

Command:

```powershell
corepack pnpm --filter @resume/api test -- profile-repository.test.ts
```

Output summary: `1 failed`, `no tests`; Vitest failed during suite loading with `Cannot find module '../db/migrate.js'`. This was the expected missing-implementation failure.

## GREEN

Command:

```powershell
corepack pnpm --filter @resume/api test -- profile-repository.test.ts
```

Output summary: `1 passed`, `3 passed`, exit code `0`.

Additional verification:

```powershell
corepack pnpm --filter @resume/api typecheck
corepack pnpm --filter @resume/contracts test
corepack pnpm --filter @resume/contracts typecheck
corepack pnpm --filter @resume/api build
git diff --check
```

Output summary: all commands exited `0`; contracts tests were `1` file / `2` tests passed; `git diff --check` was clean.

## Migration and Repository Behavior

- `migrateDatabase` creates `documents`, `document_chunks`, `profile_facts`, `fact_revisions`, `application_answers`, and `embeddings`, with foreign keys and lookup indexes.
- `profile_facts` and `fact_revisions` enforce `task_id IS NOT NULL` when `scope = 'application'` through SQLite `CHECK` constraints.
- `correct` uses one SQLite transaction: it snapshots the current fact into `fact_revisions`, then updates the current profile fact as `user_corrected`, revision plus one, with user evidence and confidence `1`.
- `history` returns each preserved prior revision and the current revision in revision order.
- `resolveForTask` returns only, in order: the exact current task answer, an active `user_corrected` profile fact, or an active `user_confirmed` profile fact. It never returns `extracted` or `superseded` rows.

## Files

- `apps/api/package.json`
- `apps/api/src/db/client.ts`
- `apps/api/src/db/schema.ts`
- `apps/api/src/db/migrate.ts`
- `apps/api/src/profile/profile-repository.ts`
- `apps/api/src/profile/profile-repository.test.ts`
- `package.json` and `pnpm-lock.yaml` for the dependency allow-list and lock resolution

## Concerns

- `pnpm` was unavailable on `PATH`, so all commands use `corepack pnpm`.
- Initial Node 24 install used bundled `node-gyp@11.1.0`, which could not recognize VS 2026; the review-fix patch below resolves that with pinned `node-gyp@13.0.1`.
- Initial root `test` and `build` wiring was invalid in this environment; the review-fix section below records the corrected `corepack pnpm` package-recursion scripts.

## Review Fixes (2026-07-22)

### RED Evidence

Commands:

```powershell
corepack pnpm --filter @resume/contracts test
corepack pnpm --filter @resume/api test -- profile-repository.test.ts
```

Output summary: contracts `1` file / `4` tests with `1` failure because non-JSON values passed `z.unknown()`. API `1` file / `12` tests with `7` failures: reviewed defaults were not superseded, `confirm` downgraded corrected facts, superseded facts could be confirmed, and SQLite accepted empty/malformed evidence JSON. This was the expected regression suite failure before the fixes.

### GREEN Evidence

Commands, run in clean isolated copy `C:\ra2-clean-20260722` after `corepack pnpm install --frozen-lockfile`:

```powershell
corepack pnpm --filter @resume/api test -- profile-repository.test.ts
corepack pnpm --filter @resume/contracts test
corepack pnpm --filter @resume/contracts typecheck
corepack pnpm --filter @resume/api typecheck
corepack pnpm --filter @resume/api build
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
```

Output summary: every command exited `0`; focused API tests were `1` file / `12` tests passed, contracts were `1` file / `4` tests passed, root test ran both workspace packages and passed all `16` tests, and root typecheck/build passed.

Fresh-install command:

```powershell
corepack pnpm install --frozen-lockfile
```

Output summary: exit `0`; the patched `better-sqlite3@11.10.0` lifecycle selected pinned `node-gyp@13.0.1`, recognized VS 2026, and produced `better_sqlite3.node` without a manual rebuild.

### Behavior and Rationale

- `confirm` transitions only extracted facts. It returns reviewed facts unchanged and rejects superseded facts.
- Confirmation and correction run transactionally and supersede every other reviewed profile default at the same field path. Each superseded row is snapshotted first, so its history remains intact.
- `resolveForTask` retains scope/status precedence and now ends its profile ordering with `updated_at DESC, id ASC` for deterministic behavior if data predates the invariant.
- `JsonValueSchema` rejects undefined, non-finite numbers, bigint, non-plain objects, and cycles before persistence. Valid scalar, array, and object values round-trip through SQLite exactly.
- Migration JSON checks reject malformed/empty evidence payloads and malformed fact/task value JSON. Drizzle declares the same status, scope, confidence, revision, page, application task, JSON, and unique constraints as the migration.
- Root scripts recurse with `corepack pnpm`, so they do not depend on a global `pnpm` shim. Root test now dispatches to package tests instead of the empty workspace glob configuration.
- `better-sqlite3@11.10.0` remains mandated and pinned. Root `node-gyp@13.0.1`, an override, and a narrowly scoped package patch make its Windows lifecycle select the VS-2026-capable tool.

### Files Added or Updated

- `.npmrc`
- `patches/better-sqlite3@11.10.0.patch`
- `package.json`, `pnpm-lock.yaml`
- `packages/contracts/src/profile.ts`, `packages/contracts/src/profile.test.ts`
- `apps/api/src/db/schema.ts`, `apps/api/src/db/migrate.ts`
- `apps/api/src/profile/profile-repository.ts`, `apps/api/src/profile/profile-repository.test.ts`

### Review-Fix Commit

`642422182c7c5a8272834a5e3b1642149a208acd` (`fix: harden profile fact persistence`)

Post-commit evidence: archived commit `6424221` into `C:\ra2-commit-6424221`; `corepack pnpm install --frozen-lockfile` and every GREEN command above exited `0` against that exact tree.

### Warnings and Concerns

- Fresh install succeeds but warns that `prebuild-install@7.1.3` is deprecated and that pnpm ignored `esbuild`'s build script; neither warning caused a failed verification.
- The original worktree's deep Unicode path can make VS/MSBuild fail while writing native build tracking files after `node-gyp@13.0.1` has already selected VS 2026. The clean short ASCII copy eliminates that host path limitation and passed the complete verification set.
- The existing `vitest.workspace.ts` is now unused by the root script but preserved to keep the planned layout intact.

## Re-Review Fixes (2026-07-22)

### Root Cause

- `node-gyp@13.0.1` declares `^22.22.2 || ^24.15.0 || >=26.0.0`, so Node `24.14.1` is outside its supported range. `node-gyp@12.1.0` declares `^20.17.0 || >=22.9.0`, which includes the required Node version.
- The VS 2026 compiler is functional; `better-sqlite3` failed only after compilation began because MSBuild could not create tracking paths below the real deep Unicode worktree. The short ASCII copy passed because it avoided that path condition.

### RED Evidence

Commands:

```powershell
node --test scripts/native-build-wrapper.test.cjs
corepack pnpm --filter @resume/contracts test
corepack pnpm --filter @resume/api test -- profile-repository.test.ts
```

Output summary: before the wrapper existed, wrapper import/planning failed; the contracts suite had `1` sparse-array/custom-`toJSON` failure because both values parsed as JSON. API loading was blocked by the absent native binding left by the prior deep-path installation failure. The earlier rollback test only failed before a snapshot was written and did not demonstrate transaction rollback.

### GREEN Evidence

Actual-worktree frozen install, after preserving `node_modules.pre-task2-native-backup` as recovery and restoring it automatically on failure:

```powershell
corepack pnpm install --frozen-lockfile
```

Output summary: exit `0` at `E:\projects\简历投递助手\.worktrees\resume-assistant-foundation`; lifecycle used `node-gyp@12.1.0`, mapped the package build to `Z:`, recognized VS 2026, and produced the native `better_sqlite3.node` in the actual worktree. The temporary `subst` mapping was removed in `finally`.

Post-install verification commands:

```powershell
node --test scripts/native-build-wrapper.test.cjs
corepack pnpm --filter @resume/contracts test
corepack pnpm --filter @resume/contracts typecheck
corepack pnpm --filter @resume/api test -- profile-repository.test.ts
corepack pnpm --filter @resume/api typecheck
corepack pnpm --filter @resume/api build
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
git diff --check
```

Output summary: all commands exited `0`; wrapper tests `4/4`, contracts tests `5/5`, API tests `12/12`, root tests `17/17`, typechecks and builds passed, and `git diff --check` was clean.

### Files and Rationale

- `scripts/native-build-wrapper.cjs` maps only a Windows repository root to an unused drive with `subst`, computes the package path relative to that root, invokes pinned root `node-gyp`, returns its exit status, and removes the mapping in `finally`; non-Windows uses real paths directly.
- `scripts/native-build-wrapper.test.cjs` tests Windows/Unix planning, outside-root rejection, and mapping cleanup without spawning native tooling.
- `patches/better-sqlite3@11.10.0.patch` invokes the repository wrapper with `%INIT_CWD%` and `%CD%`; no user-specific path is hard-coded.
- `package.json` and `pnpm-lock.yaml` pin and override `node-gyp@12.1.0`; `better-sqlite3` remains `11.10.0` and Node remains `>=24.14.1`.
- `JsonValueSchema` now rejects sparse arrays and objects/arrays defining `toJSON` so serialization stays structural and total.
- `ProfileRepositoryOptions.afterSnapshot` is a minimal test seam. The rollback test raises after the snapshot insert and confirms the SQLite transaction leaves no orphan revision or updated fact.

### Re-Review Commit

`d1ec2cbb38a96620ebf9ddba727b12f506851438` (`fix: build sqlite natively in unicode paths`)

### Report Correction and Warnings

- `.npmrc` was briefly created during the prior review attempt, then deleted before commit; it is not part of the repository. The prior report's `.npmrc` file listing was inaccurate and is superseded by this section.
- The successful-install recovery directory is ignored as `node_modules.pre-task2-native-backup/`; cleanup was blocked by the shell safety policy, so it remains locally available and untracked.
- Fresh install emitted non-fatal warnings: `prebuild-install@7.1.3` deprecated, `prebuild-install` network `ECONNRESET` before its local build fallback, Node deprecation warnings for `fs.R_OK` and `url.parse`, one C++ signed/unsigned warning, and pnpm ignored the `esbuild` build script. None caused a verification failure.

## Wrapper Follow-up Fixes (2026-07-22)

### Root Cause and Design

- The patched lifecycle embedded Windows command-shell expansions of `%INIT_CWD%` and `%CD%`, so it could not be portable and trusted a caller-controlled working directory instead of deriving its package/root relationship.
- The wrapper chose one apparent free `subst` letter and ignored cleanup status, leaving a race window and allowing a successful native build to report a successful installation even when the temporary mapping remained.
- The patch now uses exactly `prebuild-install || node scripts/resume-native-build.cjs`. The dependency-local bootstrap walks upward from its own package cwd, requires both `pnpm-workspace.yaml` and a `package.json` named `resume-application-assistant`, and then loads the root wrapper. It does not read `INIT_CWD`.

### RED Evidence

Command:

```powershell
node --test scripts/native-build-wrapper.test.cjs scripts/better-sqlite3-native-bootstrap.test.cjs
```

Output summary: exit `1`; bootstrap loading failed with `Cannot find module ...better-sqlite3\\scripts\\resume-native-build.cjs`, retry used only `Z:` rather than the requested `R:`/`S:` candidates, and cleanup failures were silently ignored. The focused suite had `6` passing and `4` failing tests. A later isolated RED test for a thrown `subst /d` cleanup failed with `Error: access denied`, proving that cleanup errors still lacked required context.

### GREEN Evidence

Focused commands:

```powershell
node --test scripts/native-build-wrapper.test.cjs scripts/better-sqlite3-native-bootstrap.test.cjs
corepack pnpm install --lockfile-only
git diff --check
```

Output summary: all commands exited `0`; wrapper/bootstrap tests were `12/12` passing. Tests cover POSIX planning, dependency-cwd root discovery while `INIT_CWD` names `apps/api`, mapping race retry, cleanup after build failure, cleanup-status failure, thrown cleanup failure, and combined build/cleanup failure reporting.

Actual deep-Unicode clean installs used recoverable renamed `node_modules` directories, retaining the previous dependency trees as ignored `node_modules.pre-wrapper-root-backup/` and `node_modules.pre-wrapper-api-backup/` rather than deleting them:

```powershell
corepack pnpm install --frozen-lockfile
Push-Location apps\api; corepack pnpm install --frozen-lockfile; Pop-Location
```

Output summary: both commands exited `0` in `E:\projects\简历投递助手\.worktrees\resume-assistant-foundation`. The root install ran `prebuild-install || node scripts/resume-native-build.cjs`, selected root `node-gyp@12.1.0`, mapped the native build to `Z:`, recognized VS 2026, produced `better_sqlite3.node`, and removed the mapping. The child-directory install also completed from a freshly renamed dependency state; the installed package retains the relative bootstrap command and native binding.

Full Task 2 verification command:

```powershell
node --test scripts/native-build-wrapper.test.cjs scripts/better-sqlite3-native-bootstrap.test.cjs
corepack pnpm --filter @resume/contracts test
corepack pnpm --filter @resume/contracts typecheck
corepack pnpm --filter @resume/api test -- profile-repository.test.ts
corepack pnpm --filter @resume/api typecheck
corepack pnpm --filter @resume/api build
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
git diff --check
```

Output summary: all commands exited `0`; wrapper/bootstrap `12/12`, contracts `5/5`, focused API `12/12`, and root workspace `17/17` tests passed; all requested typechecks/builds and diff check passed.

### Files and Rationale

- `patches/better-sqlite3@11.10.0.patch` adds the dependency-local bootstrap and removes every lifecycle shell expansion.
- `scripts/native-build-wrapper.cjs` retains package containment validation, uses platform-appropriate path checks, retries unused Windows drive candidates when `subst` mapping returns nonzero, and makes cleanup failure fatal while preserving/reported build failures.
- `scripts/native-build-wrapper.test.cjs` and `scripts/better-sqlite3-native-bootstrap.test.cjs` cover the lifecycle planning and execution boundaries without compiling native code.
- `pnpm-lock.yaml` records the new patch hash.

### Warnings and Concerns

- Successful root installation emitted non-fatal `prebuild-install@7.1.3` deprecation, Node `fs.R_OK`/`url.parse` deprecations, one C++ signed/unsigned warning, and pnpm's ignored `esbuild` build-script warning.
- The two ignored recoverable dependency backups remain locally because the safe verification strategy intentionally does not delete recovery state; they are not tracked or part of the commit.

### Final Amendment and Commit

A final RED/GREEN cycle added a literal POSIX-path root-discovery test. The initial command below failed because `findWorkspaceRoot` hard-wired host Windows path/filesystem APIs:

```powershell
node --test scripts/better-sqlite3-native-bootstrap.test.cjs
```

RED output summary: `2/3` passing with `could not find the resume-application-assistant workspace root` for the injected POSIX fixture. The bootstrap's pure discovery function now accepts injected path/filesystem operations while production defaults remain Node's native APIs. A stale pnpm patch-store directory briefly caused the test to load an earlier patched copy; the test now resolves `apps/api/node_modules/better-sqlite3`, the package actually consumed by the workspace.

GREEN commands:

```powershell
corepack pnpm install --frozen-lockfile
Push-Location apps\api; corepack pnpm install --frozen-lockfile; Pop-Location
node --test scripts/native-build-wrapper.test.cjs scripts/better-sqlite3-native-bootstrap.test.cjs
corepack pnpm --filter @resume/contracts test
corepack pnpm --filter @resume/contracts typecheck
corepack pnpm --filter @resume/api test -- profile-repository.test.ts
corepack pnpm --filter @resume/api typecheck
corepack pnpm --filter @resume/api build
corepack pnpm test
corepack pnpm typecheck
corepack pnpm build
git diff --check
```

Final output summary: both actual-path frozen installs exited `0`; the root install rebuilt `better-sqlite3` via the final relative bootstrap and `node-gyp@12.1.0` on mapped `Z:`, while the `apps/api` frozen install exited `0` from a fresh dependency state. The focused wrapper/bootstrap suite was `13/13`, contracts `5/5`, API `12/12`, root workspace `17/17`; all typechecks/builds/diff check exited `0`.

Final implementation commit: `0def2d631d98a7f37b74c6438d55c7fefc1a5c5e` (`fix: harden native install bootstrap`).
