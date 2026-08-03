import type { Evidence } from "@resume/contracts";
import { ExternalLink, FileSearch } from "lucide-react";

interface EvidenceListProps { evidence: Evidence[]; }

export function EvidenceList({ evidence }: EvidenceListProps) {
  return (
    <section className="application-evidence" aria-labelledby="application-evidence-title">
      <h3 id="application-evidence-title"><FileSearch aria-hidden="true" size={16} />支持证据</h3>
      {evidence.length === 0 ? <p className="empty-review-detail">暂无可核对的支持证据</p> : <ol>
        {evidence.map((item, index) => <li key={`${item.documentId}-${item.page}-${index}`}>
          <div><strong>{sourceLabel(item.extraction)}</strong><span>{item.text}</span></div>
          {item.extraction === "user" ? <span className="evidence-page-label">用户确认</span> : <a
            href={`/api/profile/documents/${encodeURIComponent(item.documentId)}/pdf#page=${item.page}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`查看第 ${item.page} 页证据`}
          >第 {item.page} 页<ExternalLink aria-hidden="true" size={13} /></a>}
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
