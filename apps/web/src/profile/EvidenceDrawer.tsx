import type { Evidence, JsonValue } from "@resume/contracts";
import { ExternalLink, FileSearch, Link2, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

interface EvidenceDrawerProps {
  fieldLabel: string;
  value: JsonValue;
  evidence: Evidence[];
  returnFocusTo: HTMLElement | null;
  onClose(): void;
}

interface EvidenceBox {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface GroundingState {
  status: "idle" | "loading" | "exact" | "page";
  boxes: EvidenceBox[];
}

export function EvidenceDrawer({ fieldLabel, value, evidence, returnFocusTo, onClose }: EvidenceDrawerProps) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [grounding, setGrounding] = useState<GroundingState>({ status: "idle", boxes: [] });
  const selectedEvidence = evidence[selectedIndex] ?? evidence[0];

  useEffect(() => {
    setSelectedIndex(0);
  }, [fieldLabel]);

  useEffect(() => {
    closeRef.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
      returnFocusTo?.focus();
    };
  }, [returnFocusTo]);

  useEffect(() => {
    if (!selectedEvidence || selectedEvidence.extraction !== "ocr") {
      setGrounding({ status: "idle", boxes: [] });
      return;
    }
    const controller = new AbortController();
    setGrounding({ status: "loading", boxes: [] });
    const url = `/api/profile/documents/${encodeURIComponent(selectedEvidence.documentId)}`
      + `/pages/${selectedEvidence.page}/grounding?text=${encodeURIComponent(selectedEvidence.text)}`;
    void fetch(url, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("grounding request failed");
        return response.json() as Promise<unknown>;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        const result = parseGrounding(payload);
        setGrounding(result ?? { status: "page", boxes: [] });
      })
      .catch(() => {
        if (!controller.signal.aborted) setGrounding({ status: "page", boxes: [] });
      });
    return () => controller.abort();
  }, [selectedEvidence]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])'
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

  const userEvidence = selectedEvidence?.extraction === "user";

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
            <p className="drawer-kicker">字段与原文核对</p>
            <h2 id={titleId}>证据映射</h2>
          </div>
          <button ref={closeRef} className="icon-button" type="button" aria-label="关闭来源" title="关闭来源" onClick={onClose}>
            <X aria-hidden="true" size={20} />
          </button>
        </header>

        <div className={`drawer-content ${userEvidence ? "user-evidence-view" : "document-evidence-view"}`}>
          <section className="evidence-sidebar" aria-label="当前字段和证据列表">
            <div className="knowledge-field">
              <p>当前字段</p>
              <h3>{fieldLabel}</h3>
              <div className="knowledge-value">{displayValue(value)}</div>
            </div>

            <div className="evidence-list-block">
              <div className="evidence-section-title">
                <FileSearch aria-hidden="true" size={16} />
                <h3>证据记录</h3>
                <span>{evidence.length}</span>
              </div>
              <div className="evidence-list">
                {evidence.map((item, index) => {
                  const isUserEvidence = item.extraction === "user";
                  const label = isUserEvidence
                    ? "用户提供"
                    : `${sourceLabel(item.extraction)}，第 ${item.page} 页`;
                  return (
                    <button
                      className="evidence-option"
                      type="button"
                      aria-label={label}
                      aria-pressed={selectedIndex === index}
                      key={`${item.documentId}-${item.page}-${index}`}
                      onClick={() => setSelectedIndex(index)}
                    >
                      <span className="evidence-option-source">
                        {isUserEvidence ? `用户提供记录 ${index + 1}` : `证据 ${index + 1}`}
                      </span>
                      {!isUserEvidence && <span>第 {item.page} 页</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          {selectedEvidence && !userEvidence ? (
            <>
              <div className="evidence-relationship" aria-hidden="true">
                <span />
                <Link2 size={17} />
                <span />
              </div>
              <section className="document-evidence" aria-label="原始文档证据">
                <header className="document-evidence-header">
                  <div>
                    <p>原始 PDF</p>
                    <h3>页码 {selectedEvidence.page}</h3>
                  </div>
                  <div className="document-evidence-actions">
                    <span className={`location-badge ${grounding.status === "exact" ? "exact" : grounding.status === "page" ? "page-level" : "text-level"}`}>
                      {locationLabel(selectedEvidence.extraction, grounding.status)}
                    </span>
                    <a
                      className="button secondary document-open-link"
                      href={`/api/profile/documents/${encodeURIComponent(selectedEvidence.documentId)}/pdf#page=${selectedEvidence.page}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink aria-hidden="true" size={15} />
                      原始 PDF
                    </a>
                  </div>
                </header>
                <div className="pdf-preview-shell">
                  <div className="pdf-page-stage">
                    <img
                      src={`/api/profile/documents/${encodeURIComponent(selectedEvidence.documentId)}/pages/${selectedEvidence.page}/image`}
                      title={`原始 PDF 第 ${selectedEvidence.page} 页`}
                      alt={`原始 PDF 第 ${selectedEvidence.page} 页`}
                    />
                    {grounding.status === "exact" && grounding.boxes.map((box, index) => (
                      <span
                        className="evidence-highlight"
                        data-testid={`evidence-highlight-${index}`}
                        key={`${box.x1}-${box.y1}-${box.x2}-${box.y2}-${index}`}
                        style={{
                          left: `${box.x1 / 10}%`,
                          top: `${box.y1 / 10}%`,
                          width: `${(box.x2 - box.x1) / 10}%`,
                          height: `${(box.y2 - box.y1) / 10}%`
                        }}
                      />
                    ))}
                  </div>
                </div>
                <div className="selected-evidence-details">
                  <div className="quote-block">
                    <h3>原文</h3>
                    <blockquote>{selectedEvidence.text}</blockquote>
                  </div>
                  <dl className="evidence-meta">
                    <div>
                      <dt>提取方式</dt>
                      <dd>{sourceLabel(selectedEvidence.extraction)}</dd>
                    </div>
                    <div>
                      <dt>文档标识</dt>
                      <dd className="document-id">{selectedEvidence.documentId}</dd>
                    </div>
                  </dl>
                </div>
              </section>
            </>
          ) : selectedEvidence ? (
            <section className="correction-evidence" aria-label="用户提供记录">
              <p className="correction-source">用户提供</p>
              <div className="quote-block">
                <h3>用户提供记录</h3>
                <blockquote>{selectedEvidence.text}</blockquote>
              </div>
            </section>
          ) : (
            <section className="empty-evidence">暂无可核对的证据记录</section>
          )}
        </div>
      </aside>
    </div>
  );
}

function sourceLabel(source: Evidence["extraction"]): string {
  if (source === "pdf_text") return "PDF 文本提取";
  if (source === "ocr") return "OCR 识别";
  return "用户提供";
}

function displayValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === null) return "空";
  if (typeof value === "boolean") return value ? "是" : "否";
  return typeof value === "number" ? String(value) : JSON.stringify(value, null, 2);
}

function locationLabel(
  extraction: Evidence["extraction"],
  status: GroundingState["status"]
): string {
  if (extraction !== "ocr") return "PDF 文本证据";
  if (status === "loading") return "正在定位";
  if (status === "exact") return "文本位置高亮";
  return "页级定位";
}

function parseGrounding(payload: unknown): GroundingState | undefined {
  if (typeof payload !== "object" || payload === null || !("match" in payload) || !("boxes" in payload)) return undefined;
  const match = payload.match;
  const boxes = payload.boxes;
  if ((match !== "exact" && match !== "page") || !Array.isArray(boxes)) return undefined;
  const parsedBoxes: EvidenceBox[] = [];
  for (const box of boxes) {
    if (typeof box !== "object" || box === null) return undefined;
    const candidate = box as Partial<EvidenceBox>;
    if (![candidate.x1, candidate.y1, candidate.x2, candidate.y2].every((value) => typeof value === "number")) return undefined;
    const { x1, y1, x2, y2 } = candidate as EvidenceBox;
    if (x1 < 0 || y1 < 0 || x2 > 1000 || y2 > 1000 || x1 >= x2 || y1 >= y2) return undefined;
    parsedBoxes.push({ x1, y1, x2, y2 });
  }
  if (match === "exact" && parsedBoxes.length === 0) return undefined;
  return { status: match, boxes: parsedBoxes };
}
