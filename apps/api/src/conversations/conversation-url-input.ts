const WEB_URL_PATTERN = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+/giu;
const TRAILING_ENCODED_BYTES_PATTERN = /((?:%[0-9A-Fa-f]{2})+)$/u;
const IDENTIFIER_PARAMETER_PATTERN = /(?:id|uuid|token|code|key)$/iu;
const LAST_QUERY_PARAMETER_PATTERN = /[?&]([A-Za-z][A-Za-z0-9_.-]*)=([^&#]*)$/u;

export interface ConversationUrlInput {
  rawText: string;
  url: string;
  modelText: string;
  boundary: "explicit" | "recovered_encoded_suffix";
}

export function extractConversationUrlInput(rawText: string): ConversationUrlInput | undefined {
  const matches = conversationWebUrls(rawText);
  if (matches.length !== 1) return undefined;

  const candidate = matches[0]!;
  if (!candidate.toLowerCase().startsWith("https://")) return undefined;
  const recovered = recoverEncodedNaturalLanguageSuffix(candidate);
  if (recovered !== undefined) {
    return {
      rawText,
      url: recovered.url,
      modelText: rawText.replace(candidate, `[URL]${recovered.suffix}`),
      boundary: "recovered_encoded_suffix"
    };
  }
  return {
    rawText,
    url: candidate,
    modelText: rawText.replace(candidate, "[URL]"),
    boundary: "explicit"
  };
}

export function countConversationWebUrls(rawText: string): number {
  return conversationWebUrls(rawText).length;
}

function recoverEncodedNaturalLanguageSuffix(candidate: string): { url: string; suffix: string } | undefined {
  const encodedBytes = TRAILING_ENCODED_BYTES_PATTERN.exec(candidate)?.[1];
  if (encodedBytes === undefined) return undefined;

  if (candidate.includes("?")) {
    const parameter = LAST_QUERY_PARAMETER_PATTERN.exec(candidate);
    if (parameter?.[1] === undefined || parameter[2] === undefined) return undefined;
    if (!IDENTIFIER_PARAMETER_PATTERN.test(parameter[1])) return undefined;
    const identifierPrefix = parameter[2].slice(0, -encodedBytes.length);
    if (!/^[A-Za-z0-9._~-]+$/u.test(identifierPrefix)) return undefined;
  } else {
    const pathPrefix = candidate.slice(0, -encodedBytes.length);
    if (pathPrefix.includes("#")) return undefined;
    try {
      const lastSegment = new URL(pathPrefix).pathname.split("/").at(-1);
      if (lastSegment === undefined || !/^[A-Za-z0-9._~-]+$/u.test(lastSegment)) return undefined;
    } catch {
      return undefined;
    }
  }

  let suffix: string;
  try {
    suffix = decodeURIComponent(encodedBytes);
  } catch {
    return undefined;
  }
  if (!looksLikeNaturalLanguageSuffix(suffix)) return undefined;

  const url = candidate.slice(0, -encodedBytes.length);
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return { url, suffix };
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[).,;!?]+$/u, "");
}

function conversationWebUrls(rawText: string): string[] {
  return [...rawText.matchAll(WEB_URL_PATTERN)]
    .flatMap((match) => splitJoinedWebUrls(match[0]))
    .map(trimTrailingPunctuation)
    .filter((value) => value.length > 0);
}

function splitJoinedWebUrls(value: string): string[] {
  const starts = [...value.matchAll(/https?:\/\//giu)]
    .map((match) => match.index)
    .filter((index): index is number => index !== undefined);
  return starts.map((start, index) => value.slice(start, starts[index + 1]));
}

function looksLikeNaturalLanguageSuffix(value: string): boolean {
  const hanCount = [...value].filter((character) => /\p{Script=Han}/u.test(character)).length;
  if (hanCount < 4 || value.length > 100 || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  return /^(?:这个|该|请|帮|我想|能否|可以)/u.test(value) || /[吗呢吧呀啊哦！？。?！]$/u.test(value);
}
