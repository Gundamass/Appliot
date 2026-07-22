// @vitest-environment node

import { describe, expect, it } from "vitest";
import config from "../vite.config.js";

describe("development proxy", () => {
  it("targets the local API loopback port", () => {
    expect(config.server?.proxy?.["/api"]).toBe("http://127.0.0.1:43120");
  });
});
