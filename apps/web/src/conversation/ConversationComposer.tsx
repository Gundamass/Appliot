import { ArrowUp } from "lucide-react";
import { useRef, useState, type ClipboardEvent, type FormEvent } from "react";

const MAX_MESSAGE_LENGTH = 500;

interface ConversationComposerProps {
  sending: boolean;
  onSend(text: string): void;
}

export function ConversationComposer({ sending, onSend }: ConversationComposerProps) {
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const remaining = MAX_MESSAGE_LENGTH - text.length;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    onSend(value);
    setText("");
  };

  const paste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const input = event.currentTarget;
    const next = insertPastedWebUrl(
      text,
      event.clipboardData.getData("text/plain"),
      input.selectionStart,
      input.selectionEnd
    );
    if (next === undefined) return;
    event.preventDefault();
    setText(next.value);
    requestAnimationFrame(() => {
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  return <form className="conversation-composer" onSubmit={submit}><div className="conversation-composer-box"><textarea ref={inputRef} aria-label="输入消息" maxLength={MAX_MESSAGE_LENGTH} rows={1} value={text} onChange={(event) => setText(event.target.value)} onPaste={paste} placeholder="输入你想了解的内容……" /><button type="submit" className="conversation-send" aria-label="发送" disabled={sending || !text.trim()}><ArrowUp aria-hidden="true" size={17} /></button></div><div className="conversation-composer-meta"><span>{sending ? "正在处理…" : "助手会在创建投递任务前征求你的确认"}</span><span>{remaining} 字剩余</span></div></form>;
}

export function insertPastedWebUrl(
  current: string,
  clipboardText: string,
  selectionStart: number,
  selectionEnd: number
): { value: string; caret: number } | undefined {
  const pasted = clipboardText.trim();
  if (pasted.length === 0 || /\s/u.test(pasted)) return undefined;
  try {
    const url = new URL(pasted);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  const inserted = `${pasted} `;
  const value = `${current.slice(0, selectionStart)}${inserted}${current.slice(selectionEnd)}`;
  if (value.length > MAX_MESSAGE_LENGTH) return undefined;
  return { value, caret: selectionStart + inserted.length };
}
