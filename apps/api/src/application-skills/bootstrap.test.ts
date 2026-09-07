import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { ApplicationSkillVersion } from "@resume/contracts";
import { SkillRegistry } from "./skill-registry.js";
import { migrateApplicationSkillSchema } from "./skill-schema-migration.js";
import { bootstrapApplicationSkills } from "./bootstrap.js";

describe("bootstrapApplicationSkills", () => {
  it("idempotently creates one safe Champion for moka, dji, and baidu", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    migrateApplicationSkillSchema(database);
    const registry = new SkillRegistry(database);

    try {
      bootstrapApplicationSkills(registry);
      bootstrapApplicationSkills(registry);

      const rows = database.prepare(`
        SELECT skill_id, version, site, status, allowed_domains_json, content_json
        FROM skill_versions ORDER BY site
      `).all() as Array<{
        skill_id: string;
        version: string;
        site: ApplicationSkillVersion["site"];
        status: ApplicationSkillVersion["status"];
        allowed_domains_json: string;
        content_json: string;
      }>;

      expect(rows).toHaveLength(3);
      expect(rows.map(({ site, status }) => ({ site, status }))).toEqual([
        { site: "baidu", status: "champion" },
        { site: "dji", status: "champion" },
        { site: "moka", status: "champion" }
      ]);
      expect(Object.fromEntries(rows.map((row) => [row.site, JSON.parse(row.allowed_domains_json)]))).toEqual({
        baidu: ["talent.baidu.com"],
        dji: ["apply.careers.dji.com", "app.mokahr.com"],
        moka: ["app.mokahr.com"]
      });

      for (const row of rows) {
        const content = JSON.parse(row.content_json) as ApplicationSkillVersion["content"];
        expect(content.capabilities).toContain("full_page_audit");
        expect(JSON.stringify(content).toLowerCase()).not.toContain("submit");
        for (const step of content.workflow) {
          const capabilities = step.actions.map((action) => action.capability);
          expect(capabilities.at(-1)).toBe("full_page_audit");
          expect(capabilities).toContain("readback");
          expect(capabilities.indexOf("readback")).toBeLessThan(capabilities.indexOf("full_page_audit"));
        }
      }
    } finally {
      database.close();
    }
  });

  it("uses current observed application routes, labels, and deterministic hashes", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    migrateApplicationSkillSchema(database);
    const registry = new SkillRegistry(database);

    try {
      bootstrapApplicationSkills(registry);

      const moka = registry.getVersion("moka-application", "1.0.0")!;
      const dji = registry.getVersion("dji-application", "1.0.0")!;
      const baidu = registry.getVersion("baidu-application", "1.0.0")!;
      expect(moka.content.pageVariants[0]!.match.routePatterns).toEqual([
        "/social-recruitment",
        "/campus_apply"
      ]);
      expect(dji.content.pageVariants[0]!.match.routePatterns).toEqual([
        "/campus-recruitment/dji"
      ]);
      expect(baidu.content.pageVariants[0]!.match.routePatterns).toEqual([
        "/jobs/detail/GRADUATE"
      ]);
      expect(dji.content.fields.map((field) => field.locatorHints[0])).toEqual(expect.arrayContaining([
        { key: "candidate-name", by: "label", text: "姓名" },
        { key: "candidate-phone", by: "label", text: "手机号码" },
        { key: "education-institution", by: "label", text: "毕业院校" }
      ]));
      expect(new Set([moka.contentHash, dji.contentHash, baidu.contentHash]).size).toBe(3);
    } finally {
      database.close();
    }
  });
});
