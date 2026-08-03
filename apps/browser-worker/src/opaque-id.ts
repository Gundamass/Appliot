import { createHash } from "node:crypto";

export function opaqueId(prefix: "field" | "action", value: string): string {
  return `${prefix}_${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16)}`;
}

export function opaqueFieldIdForIndex(index: number): string {
  return opaqueId("field", `field:${index}`);
}

export function opaqueActionIdForIndex(index: number): string {
  return opaqueId("action", `action:${index}`);
}
