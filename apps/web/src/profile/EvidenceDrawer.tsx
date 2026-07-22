import type { ProfileFact } from "@resume/contracts";
import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";

interface EvidenceDrawerProps {
  fact: ProfileFact;
  returnFocusTo: HTMLElement | null;
  onClose(): void;
}

export function EvidenceDrawer({ fact, returnFocusTo, onClose }: EvidenceDrawerProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      returnFocusTo?.focus();
    };
  }, [returnFocusTo]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (!focusable?.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <div className="drawer-layer" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside
        ref={dialogRef}
        className="evidence-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <header className="drawer-header">
          <div>
            <p className="drawer-kicker">字段来源</p>
            <h2 id={titleId}>提取来源</h2>
          </div>
          <button ref={closeRef} className="icon-button" type="button" aria-label="关闭来源" title="关闭来源" onClick={onClose}>
            <X aria-hidden="true" size={20} />
          </button>
        </header>
        <div className="drawer-content">
          {fact.evidence.map((evidence, index) => {
            const userEvidence = evidence.extraction === "user";
            return (
              <section className="evidence-item" key={`${evidence.documentId}-${evidence.page}-${index}`}>
                <dl className="evidence-meta">
                  {userEvidence ? (
                    <div>
                      <dt>来源</dt>
                      <dd>用户更正</dd>
                    </div>
                  ) : (
                    <>
                      <div>
                        <dt>文档标识</dt>
                        <dd className="document-id">{evidence.documentId}</dd>
                      </div>
                      <div>
                        <dt>页码</dt>
                        <dd>第 {evidence.page} 页</dd>
                      </div>
                      <div>
                        <dt>提取方式</dt>
                        <dd>{sourceLabel(evidence.extraction)}</dd>
                      </div>
                    </>
                  )}
                </dl>
                <div className="quote-block">
                  <h3>{userEvidence ? "更正记录" : "原文"}</h3>
                  <blockquote>{evidence.text}</blockquote>
                </div>
              </section>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

function sourceLabel(source: ProfileFact["evidence"][number]["extraction"]): string {
  if (source === "pdf_text") return "PDF 文本提取";
  if (source === "ocr") return "OCR 识别";
  return "用户更正";
}
