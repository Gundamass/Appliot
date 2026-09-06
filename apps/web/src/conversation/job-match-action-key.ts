export function createJobMatchActionKey(
  sessionId: string,
  action: string,
  version: number,
  resultId?: string
): string {
  const raw = `inline-job-match:${sessionId}:${action}:${version}${resultId === undefined ? "" : `:${resultId}`}`;
  if (raw.length <= 128) return raw;
  return `inline-job-match:${action}:${version}:${stableDigest128(raw)}`;
}

function stableDigest128(value: string): string {
  return [0x243f6a88, 0x85a308d3, 0x13198a2e, 0x03707344]
    .map((seed) => hash32(value, seed).toString(16).padStart(8, "0"))
    .join("");
}

function hash32(value: string, seed: number): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}
