import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "better-sqlite3": fileURLToPath(new URL("../../apps/api/node_modules/better-sqlite3", import.meta.url))
    }
  },
  test: {
    include: ["./*.test.ts"],
    environment: "node"
  }
});
