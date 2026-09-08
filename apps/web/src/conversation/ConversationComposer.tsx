import { ArrowUp } from "lucide-react";
import { useState } from "react";

interface ConversationComposerProps {
  sending: boolean;
  onSend(text: string): void;
}

export function ConversationComposer({ sending, onSend }: ConversationComposerProps) {
  const [text, setText] = useState("");
  const remaining = 500 - text.length;
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = text.trim();
    if (!value || sending) return;
    onSend(value);
    setText("");
  };
  return <form className="conversation-composer" onSubmit={submit}><div className="conversation-composer-box"><textarea aria-label="输入消息" maxLength={500} rows={1} value={text} onChange={(event) => setText(event.target.value)} placeholder="输入你想了解的内容……" /><button type="submit" className="conversation-send" aria-label="发送" disabled={sending || !text.trim()}><ArrowUp aria-hidden="true" size={17} /></button></div><div className="conversation-composer-meta"><span>{sending ? "正在处理…" : "助手会在创建投递任务前征求你的确认"}</span><span>{remaining} 字剩余</span></div></form>;
}
