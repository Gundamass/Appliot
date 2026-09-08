import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type HostnameResolver = (hostname: string) => Promise<readonly string[]>;

const defaultResolveHostname: HostnameResolver = async (hostname) => (
  await lookup(hostname, { all: true, verbatim: true })
).map((entry) => entry.address);

export async function validatePublicHttpsUrl(
  rawUrl: string,
  resolveHostname: HostnameResolver = defaultResolveHostname
): Promise<{ url: string; domain: string }> {
  if (rawUrl.length > 2_048) throw new Error("unsafe_recruitment_url");

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("unsafe_recruitment_url");
  }

  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" || !parsed.hostname) {
    throw new Error("unsafe_recruitment_url");
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (isBlockedHostname(hostname) || isIP(hostname) !== 0) {
    throw new Error("unsafe_recruitment_url");
  }

  let addresses: readonly string[];
  try {
    addresses = await resolveHostname(hostname);
  } catch {
    throw new Error("unsafe_recruitment_url");
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error("unsafe_recruitment_url");
  }

  parsed.hostname = hostname;
  parsed.hash = "";
  return { url: parsed.toString(), domain: hostname };
}

function isBlockedHostname(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname === "0.0.0.0"
    || hostname === "::";
}

function isPrivateAddress(value: string): boolean {
  const normalized = value.toLowerCase().replace(/^\[|\]$/gu, "");
  const kind = isIP(normalized);
  if (kind === 4) {
    const parts = normalized.split(".").map(Number);
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return true;
    }
    const [first, second, third] = parts as [number, number, number, number];
    return first === 0
      || first === 10
      || (first === 100 && second >= 64 && second <= 127)
      || first === 127
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 0 && third === 0)
      || (first === 192 && second === 0 && third === 2)
      || (first === 192 && second === 88 && third === 99)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19 || (second === 51 && third === 100)))
      || (first === 203 && second === 0 && third === 113)
      || first >= 224;
  }
  if (kind === 6) {
    if (normalized === "::" || normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")
      || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea")
      || normalized.startsWith("feb") || normalized.startsWith("ff") || normalized.startsWith("2001:db8")) {
      return true;
    }
    const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
    return mapped !== undefined && isPrivateAddress(mapped);
  }
  return true;
}
