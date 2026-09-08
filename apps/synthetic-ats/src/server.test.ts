import { afterEach, describe, expect, it } from "vitest";
import { startSyntheticAts, type SyntheticAtsServer } from "./server.js";

const servers: SyntheticAtsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("synthetic ATS application scenarios", () => {
  it("serves the paginated job matching fixture without submitting", async () => {
    const server = await startSyntheticAts();
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/job-list.html?page=1&taskId=job-match-task`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-fixture="job-list"');
    expect(server.state("job-match-task").submissionCount).toBe(0);
  });

  it("renders the required phone control only for the explicit stuck scenario", async () => {
    const server = await startSyntheticAts();
    servers.push(server);

    const onboarding = await fetch(`${server.baseUrl}/application?taskId=onboarding&scenario=onboarding`)
      .then((response) => response.text());
    const stuck = await fetch(`${server.baseUrl}/application?taskId=stuck&scenario=stuck-control`)
      .then((response) => response.text());

    expect(onboarding).not.toContain('name="phone"');
    expect(stuck).toContain('<div id="phone-field">');
    expect(stuck).toContain('<input id="phone" name="phone" inputmode="numeric" required>');
  });

  it("serves the domestic ATS stability form and records interaction state without submitting", async () => {
    const server = await startSyntheticAts();
    servers.push(server);

    const html = await fetch(`${server.baseUrl}/stability?taskId=stability-task`)
      .then((response) => response.text());

    expect(html).toContain("正式工作经历");
    expect(html).toContain("实习经历");
    expect(html).toContain("项目经历");
    expect(html).toContain("赛事名称");
    expect(html).toContain("语言能力");
    expect(html).toContain("提交申请");

    const recorded = await fetch(`${server.baseUrl}/api/stability-state?taskId=stability-task`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        draft: { major: "软件工程", preservedValue: "用户预填内容" },
        searches: { major: ["软件工程专业", "软件工程"] },
        workAddCount: 0,
        internshipAddCount: 0,
        projectAddCount: 1
      })
    }).then((response) => response.json());

    expect(recorded).toMatchObject({
      draft: { major: "软件工程", preservedValue: "用户预填内容" },
      searches: { major: ["软件工程专业", "软件工程"] },
      workAddCount: 0,
      internshipAddCount: 0,
      projectAddCount: 1,
      submissionCount: 0
    });
  });

  it("serves every Runtime P0 mode and exposes its counters through synthetic state", async () => {
    const server = await startSyntheticAts();
    servers.push(server);

    const scenarios = [
      "insert-before",
      "replace-same-index",
      "reorder",
      "rollback-500ms",
      "continuous-mutation"
    ];
    for (const scenario of scenarios) {
      const response = await fetch(
        `${server.baseUrl}/runtime-p0?taskId=runtime-${scenario}&scenario=${scenario}`
      );
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('data-fixture="runtime-p0"');
      expect(html).toContain(`const scenario = ${JSON.stringify(scenario)}`);
    }

    const recorded = await fetch(`${server.baseUrl}/api/runtime-p0-state?taskId=runtime-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        scenario: "replace-same-index",
        values: { replacement: "" },
        writeCounts: { target: 1 },
        mutationCount: 1,
        auditCount: 1
      })
    }).then((response) => response.json());

    expect(recorded).toMatchObject({
      runtime: {
        scenario: "replace-same-index",
        values: { replacement: "" },
        writeCounts: { target: 1 },
        mutationCount: 1,
        auditCount: 1
      },
      submissionCount: 0
    });
    expect(server.state("runtime-state")).toMatchObject(recorded);
  });

  it("serves declared adapter replay fixtures with an immutable unrelated sentinel", async () => {
    const server = await startSyntheticAts();
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/adapter-replay/adapter-replay-basic?taskId=adapter-replay-task`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-fixture="adapter-replay-basic"');
    expect(server.state("adapter-replay-task")).toMatchObject({
      runtime: {
        values: { unrelatedSentinel: "UNCHANGED" },
        writeCounts: {}
      },
      submissionCount: 0
    });

    const unknown = await fetch(`${server.baseUrl}/adapter-replay/not-declared?taskId=adapter-replay-task`);
    expect(unknown.status).toBe(404);
  });

  it("serves the boundary replay fixture without recording a submission", async () => {
    const server = await startSyntheticAts();
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/adapter-replay/adapter-replay-boundary?taskId=adapter-replay-boundary-task`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-fixture="adapter-replay-boundary"');
    expect(server.state("adapter-replay-boundary-task")).toMatchObject({
      runtime: { values: { unrelatedSentinel: "UNCHANGED" }, writeCounts: {} },
      submissionCount: 0
    });
  });

  it.each([
    ["adapter-replay-access-denied", 403, "access_denied"],
    ["adapter-replay-rate-limited", 429, "rate_limited"]
  ] as const)("returns the declared HTTP challenge for %s", async (fixtureId, status, kind) => {
    const server = await startSyntheticAts();
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/adapter-replay/${fixtureId}?taskId=${fixtureId}-task`);

    expect(response.status).toBe(status);
    expect(server.state(`${fixtureId}-task`)).toMatchObject({
      challenge: { scenario: fixtureId, kind, fillCount: 0 },
      submissionCount: 0
    });
  });

  it("serves the repeated-section replay fixture with no initial writes", async () => {
    const server = await startSyntheticAts();
    servers.push(server);

    const response = await fetch(`${server.baseUrl}/adapter-replay/adapter-replay-repeated?taskId=adapter-replay-repeated-task`);

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('data-fixture="adapter-replay-repeated"');
    expect(server.state("adapter-replay-repeated-task")).toMatchObject({
      runtime: {
        values: { unrelatedSentinel: "UNCHANGED" },
        repeatedOrder: [],
        writeCounts: {}
      },
      submissionCount: 0
    });
  });

  it("serves every Challenge P0 mode with finite state and never submits", async () => {
    const server = await startSyntheticAts();
    servers.push(server);

    const scenarios = [
      ["captcha", 200],
      ["access-denied", 403],
      ["rate-limited", 429],
      ["device-verification", 200],
      ["risk-control", 200],
      ["interactive-iframe", 200],
      ["open-shadow-input", 200],
      ["closed-shadow-host", 200]
    ] as const;
    for (const [scenario, status] of scenarios) {
      const response = await fetch(
        `${server.baseUrl}/challenge-p0?taskId=challenge-${scenario}&scenario=${scenario}`
      );
      expect(response.status).toBe(status);
      expect(await response.text()).toContain('data-fixture="challenge-p0"');
      expect(server.state(`challenge-${scenario}`)).toMatchObject({
        challenge: { scenario, fillCount: 0 },
        submissionCount: 0
      });
    }
  });

  it("serves deterministic Skill runtime pages for every supported site and adverse variant", async () => {
    const server = await startSyntheticAts();
    servers.push(server);

    const sites = ["moka", "dji", "baidu"] as const;
    const scenarios = [
      "stable",
      "renamed-label",
      "duplicate-label",
      "reordered-controls",
      "delayed-options",
      "hidden-honeypot",
      "delayed-render",
      "stale-node",
      "ambiguous-fingerprint",
      "unexpected-navigation",
      "post-fill-mutation",
      "evolution-label-change"
    ] as const;

    for (const site of sites) {
      for (const scenario of scenarios) {
        const taskId = `skill-${site}-${scenario}`;
        const response = await fetch(
          `${server.baseUrl}/skill-runtime?taskId=${taskId}&site=${site}&scenario=${scenario}`
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain('data-fixture="application-skill-runtime"');
        expect(html).toContain(`data-site="${site}"`);
        expect(html).toContain(`data-scenario="${scenario}"`);
        expect(server.state(taskId)).toMatchObject({
          skillRuntime: { site, scenario, values: {}, writeCounts: {} },
          submissionCount: 0
        });
      }
    }

    const reordered = await fetch(
      `${server.baseUrl}/skill-runtime?taskId=reordered&site=moka&scenario=reordered-controls`
    ).then((response) => response.text());
    expect(reordered.indexOf('data-semantic="basics.phone"')).toBeLessThan(
      reordered.indexOf('data-semantic="basics.name"')
    );
    const delayedOptions = await fetch(
      `${server.baseUrl}/skill-runtime?taskId=options&site=moka&scenario=delayed-options`
    ).then((response) => response.text());
    expect(delayedOptions).toContain("skill-runtime-options-ready");
    const honeypot = await fetch(
      `${server.baseUrl}/skill-runtime?taskId=honeypot&site=moka&scenario=hidden-honeypot`
    ).then((response) => response.text());
    expect(honeypot).toContain('data-honeypot="true"');
    const mutation = await fetch(
      `${server.baseUrl}/skill-runtime?taskId=mutation&site=moka&scenario=post-fill-mutation`
    ).then((response) => response.text());
    expect(mutation).toContain("skill-runtime-post-fill-mutated");
    const evolvedLabel = await fetch(
      `${server.baseUrl}/skill-runtime?taskId=evolution-label&site=baidu&scenario=evolution-label-change`
    ).then((response) => response.text());
    expect(evolvedLabel).toContain('placeholder="Preferred identity"');
    expect(evolvedLabel).not.toContain('data-semantic="basics.name"');
  });

  it("records Skill runtime field readback without accepting a final submission", async () => {
    const server = await startSyntheticAts();
    servers.push(server);

    const recorded = await fetch(`${server.baseUrl}/api/skill-runtime-state?taskId=skill-state`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        site: "moka",
        scenario: "stable",
        values: { "basics.name": "Skill Runtime Candidate" },
        writeCounts: { "basics.name": 1 },
        navigationCount: 0
      })
    }).then((response) => response.json());

    expect(recorded).toMatchObject({
      skillRuntime: {
        site: "moka",
        scenario: "stable",
        values: { "basics.name": "Skill Runtime Candidate" },
        writeCounts: { "basics.name": 1 },
        navigationCount: 0
      },
      submissionCount: 0
    });
  });
});
