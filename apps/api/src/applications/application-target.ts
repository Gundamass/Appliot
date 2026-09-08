import { createHash } from "node:crypto";
import { countConversationWebUrls, extractConversationUrlInput } from "../conversations/conversation-url-input.js";
import { validatePublicHttpsUrl, type HostnameResolver } from "../recruitment-search/public-https-url.js";

export interface PreparedApplicationTarget {
  id: string;
  applicationUrl: string;
  boundary: "explicit" | "recovered_encoded_suffix";
}

export class ApplicationTargetError extends Error {
  constructor(readonly code: "invalid_application_url" | "unsafe_application_url") {
    super(code);
    this.name = "ApplicationTargetError";
  }
}

const APPLICATION_TARGET_NAMESPACE = Buffer.from("6ba7b8119dad11d180b400c04fd430c8", "hex");

export function deterministicApplicationTaskId(identity: string, applicationUrl: string): string {
  const name = Buffer.from(`${identity}\u0000${applicationUrl}`, "utf8");
  const bytes = createHash("sha1")
    .update(APPLICATION_TARGET_NAMESPACE)
    .update(name)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function prepareApplicationTarget(
  rawUrl: string,
  identity: string,
  resolveHostname?: HostnameResolver
): Promise<PreparedApplicationTarget> {
  if (countConversationWebUrls(rawUrl) !== 1 || hasMalformedPercentEncoding(rawUrl)) {
    throw new ApplicationTargetError("invalid_application_url");
  }
  const extracted = extractConversationUrlInput(rawUrl);
  if (extracted === undefined) throw new ApplicationTargetError("invalid_application_url");

  try {
    const validated = await validatePublicHttpsUrl(extracted.url, resolveHostname);
    return {
      id: deterministicApplicationTaskId(identity, validated.url),
      applicationUrl: validated.url,
      boundary: extracted.boundary
    };
  } catch {
    throw new ApplicationTargetError("unsafe_application_url");
  }
}

function hasMalformedPercentEncoding(value: string): boolean {
  return /%(?![0-9A-Fa-f]{2})/u.test(value);
}
