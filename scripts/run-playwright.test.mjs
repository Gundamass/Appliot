import assert from "node:assert/strict";
import test from "node:test";

import { normalizePlaywrightArgs, sanitizePlaywrightEnvironment } from "./run-playwright.mjs";

test("removes exactly one leading pnpm argument delimiter", () => {
  assert.deepEqual(
    normalizePlaywrightArgs(["--", "--", "--trace=on", "tests/browser/submit-safety.spec.ts"]),
    ["--", "--trace=on", "tests/browser/submit-safety.spec.ts"]
  );
  assert.deepEqual(normalizePlaywrightArgs(["test", "--trace=on"]), ["test", "--trace=on"]);
});

test("removes all VS Code, Electron, and Node REPL trusted host variables", () => {
  const environment = sanitizePlaywrightEnvironment({
    ELECTRON_RUN_AS_NODE: "1",
    ELECTRON_ENABLE_LOGGING: "1",
    VSCODE_ESM_ENTRYPOINT: "vs/workbench/api/node/extensionHostProcess",
    VSCODE_HANDLES_UNCAUGHT_ERRORS: "true",
    VSCODE_CODE_CACHE_PATH: "C:/cache",
    VSCODE_CRASH_REPORTER_PROCESS_TYPE: "extensionHost",
    VSCODE_CWD: "C:/workspace",
    VSCODE_IPC_HOOK: "\\\\.\\pipe\\vscode",
    VSCODE_NLS_CONFIG: "{\"locale\":\"zh-cn\"}",
    VSCODE_PID: "1234",
    vScOdE_EXTENSION_TEST: "1",
    NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: "hash",
    NODE_REPL_TRUSTED_CODE_PATHS: "C:/trusted",
    DEBUG: "release",
    CI: "true",
    CUSTOM_VALUE: "preserved"
  });

  assert.deepEqual(environment, { CI: "true", CUSTOM_VALUE: "preserved" });
});

test("preserves ordinary DEBUG values", () => {
  const environment = sanitizePlaywrightEnvironment({ DEBUG: "pw:api", PATH: "/bin" });

  assert.deepEqual(environment, { DEBUG: "pw:api", PATH: "/bin" });
});
