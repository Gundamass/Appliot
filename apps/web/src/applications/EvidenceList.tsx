import type { Evidence } from "@resume/contracts";
import { FileSearch } from "lucide-react";

interface EvidenceListProps {
  evidence: Evidence[];
  onInspect?(trigger: HTMLButtonElement): void;
}

export function EvidenceList({ evidence, onInspect }: EvidenceListProps) {
  return (
    <section className="application-evidence" aria-labelledby="application-evidence-title">
      <div className="application-evidence-heading">
        <h3 id="application-evidence-title"><FileSearch aria-hidden="true" size={16} />支持证据</h3>
        {evidence.length > 0 && onInspect && <button className="button quiet" type="button" onClick={(event) => onInspect(event.currentTarget)}>查看原文</button>}
      </div>
      {evidence.length === 0 ? <p className="empty-review-detail">暂无可核对的支持证据</p> : <ol>
        {evidence.map((item, index) => <li key={`${item.documentId}-${item.page}-${index}`}>
          <div><strong>{sourceLabel(item.extraction)}</strong><span>{item.text}</span></div>
          <span className="evidence-page-label">{item.extraction === "user" ? "用户确认" : `第 ${item.page} 页`}</span>
        </li>)}
      </ol>}
    </section>
  );
}

function sourceLabel(extraction: Evidence["extraction"]): string {
  if (extraction === "ocr") return "OCR 识别";
  if (extraction === "pdf_text") return "PDF 原文";
  return "用户确认";
}
