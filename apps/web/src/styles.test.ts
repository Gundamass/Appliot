import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("reduced motion styles", () => {
  it("disables the adapter checking animation", () => {
    const css = readFileSync(`${process.cwd()}/src/styles.css`, "utf8");
    const reducedMotion = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([^}]*)\}/)?.[1];

    expect(reducedMotion).toContain(".service-state.checking svg");
    expect(reducedMotion).toContain("animation: none !important");
  });
});
