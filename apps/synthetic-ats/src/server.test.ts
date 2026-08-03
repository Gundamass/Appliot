import { afterEach, describe, expect, it } from "vitest";
import { startSyntheticAts, type SyntheticAtsServer } from "./server.js";

const servers: SyntheticAtsServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("synthetic ATS application scenarios", () => {
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
});
