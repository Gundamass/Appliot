import type { CurrentProfileDocumentSummary, DocumentImportStatus } from "@resume/contracts";
import { CircleAlert, FileText, RefreshCw, Upload, X } from "lucide-react";
import { useEffect, useRef } from "react";

export type ResumeOperationState =
  | { kind: "idle" }
  | { kind: "uploading"; mode: "update_only" | "update_and_parse" }
  | { kind: "parsing"; documentId: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string; retry: "upload" | "parse" };

interface ResumeParsePanelProps {
  open: boolean;
  selectedFile?: File | undefined;
  operationState: ResumeOperationState;
  currentDocument?: CurrentProfileDocumentSummary | undefined;
  onSelectFile(file: File | undefined): void;
  onUpdateOnly(): void;
  onUpdateAndParse(): void;
  onRetryParse(): void;
  onClose(): void;
}

const STATUS_LABELS: Record<DocumentImportStatus, string> = {
  retained: "未解析",
  importing: "解析中",
  completed: "已解析",
  failed: "解析失败，可重试"
};

export function ResumeParsePanel({
  open,
  selectedFile,
  operationState,
  currentDocument,
  onSelectFile,
  onUpdateOnly,
  onUpdateAndParse,
  onRetryParse,
  onClose
}: ResumeParsePanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!selectedFile && inputRef.current) inputRef.current.value = "";
  }, [selectedFile]);
  if (!open) return null;

  const busy = operationState.kind === "uploading" || operationState.kind === "parsing";
  const canRetryCurrent = !selectedFile
    && !busy
    && (currentDocument?.importStatus === "retained" || currentDocument?.importStatus === "failed");

  return (
    <section className="resume-parse-panel" aria-labelledby="resume-parse-title">
      <h2 className="visually-hidden">简历资料</h2>
      <div className="resume-parse-heading">
        <span className="resume-parse-icon"><FileText aria-hidden="true" size={20} /></span>
        <div>
          <h2 id="resume-parse-title">简历更新</h2>
          {currentDocument ? (
            <p className="resume-current-document">
              <strong>{currentDocument.filename}</strong>
              <span>{STATUS_LABELS[currentDocument.importStatus]}</span>
              {currentDocument.importStatus === "completed" && <span>已提取 {currentDocument.extractedFactCount} 项资料</span>}
            </p>
          ) : <p>上传 PDF 简历。你可以只更新投递文件，也可以同时解析并更新档案资料。</p>}
        </div>
        <button className="icon-button" type="button" aria-label="收起简历更新" title="收起简历更新" onClick={onClose}>
          <X aria-hidden="true" size={18} />
        </button>
      </div>
      <div className="resume-parse-controls">
        <label className="button secondary resume-file-picker">
          <Upload aria-hidden="true" size={16} />
          {selectedFile ? selectedFile.name : "选择 PDF 简历"}
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept=".pdf"
            aria-label="选择 PDF 简历"
            disabled={busy}
            onChange={(event) => onSelectFile(event.target.files?.[0])}
          />
        </label>
        <button className="button secondary" type="button" disabled={!selectedFile || busy} onClick={onUpdateOnly}>
          仅更新简历
        </button>
        <button className="button primary" type="button" disabled={!selectedFile || busy} onClick={onUpdateAndParse}>
          更新并解析
        </button>
        {canRetryCurrent && (
          <button className="button secondary" type="button" onClick={onRetryParse}>
            <RefreshCw aria-hidden="true" size={16} />重新解析
          </button>
        )}
      </div>
      {operationState.kind === "uploading" && selectedFile && (
        <div className="upload-progress" role="progressbar" aria-label={`正在上传 ${selectedFile.name}`}><span /></div>
      )}
      {operationState.kind === "parsing" && <p className="resume-parse-message" role="status">正在解析当前简历并更新档案资料</p>}
      {operationState.kind === "success" && <p className="resume-parse-message" role="status">{operationState.message}</p>}
      {operationState.kind === "error" && (
        <div className="resume-parse-message error" role="alert">
          <CircleAlert aria-hidden="true" size={18} />
          <div><strong>操作未完成</strong><span>{operationState.message}</span></div>
        </div>
      )}
    </section>
  );
}
