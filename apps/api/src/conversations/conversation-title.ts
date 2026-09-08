export const DEFAULT_CONVERSATION_TITLE = "新会话";
export const LEGACY_CONVERSATION_TITLE = "New conversation";

export function conversationTitleFromFirstMessage(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, " ");
  return Array.from(normalized).slice(0, 20).join("");
}
