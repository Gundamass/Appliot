import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("reduced motion styles", () => {
  it("disables the adapter checking animation", () => {
    const packagePath = resolve(process.cwd(), "src/styles.css");
    const workspacePath = resolve(process.cwd(), "apps/web/src/styles.css");
    const css = readFileSync(existsSync(packagePath) ? packagePath : workspacePath, "utf8");
    const reducedMotion = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([^}]*)\}/)?.[1];

    expect(reducedMotion).toContain(".service-state.checking svg");
    expect(reducedMotion).toContain("animation: none !important");
  });
});
