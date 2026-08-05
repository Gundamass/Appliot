import { z } from "zod";

export const ApplicationTaskNameSchema = z.string().trim().min(1).max(80);

export function suggestApplicationTaskName(applicationUrl: string): string {
  const url = new URL(applicationUrl);
  const hostname = url.hostname.toLowerCase();
  const isDjiHost = hostname === "dji.com" || hostname.endsWith(".dji.com");
  const isDjiPath = url.pathname.split("/").some((segment) => segment.toLowerCase() === "dji");

  if (isDjiHost || isDjiPath) return "大疆校招投递";

  const suffix = " 投递";
  const normalizedHostname = hostname.replace(/^www\./, "");
  return `${normalizedHostname.slice(0, 80 - suffix.length)}${suffix}`;
}
