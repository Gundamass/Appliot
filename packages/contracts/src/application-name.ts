import { z } from "zod";

export const ApplicationTaskNameSchema = z.string().trim().min(1).max(80);

export function suggestApplicationTaskName(applicationUrl: string): string {
  const url = new URL(applicationUrl);
  const fingerprint = `${url.hostname}${url.pathname}`.toLowerCase();

  if (fingerprint.includes("dji")) return "大疆校招投递";

  return `${url.hostname.replace(/^www\./, "")} 投递`.slice(0, 80);
}
