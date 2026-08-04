import type { ProfileDocumentSummary } from "@resume/contracts";
import { FileText, RefreshCw, Upload, X } from "lucide-react";
import { useEffect, useRef } from "react";

export type ProfileUploadState = "idle" | "uploading" | "accepted_refreshing" | "success" | "accepted_refresh_error" | "error";

interface ResumeParsePanelProps {
  open: boolean;
  selectedFile?: File | undefined;
  uploadState: ProfileUploadState;
  uploadMessage?: string | undefined;
  latestDocument?: ProfileDocumentSummary | undefined;
  onSelectFile(file: File | undefined): void;
  onUpload(): void;
  onRetry(): void;
  onClose(): void;
}

export function ResumeParsePanel({
  open,
  selectedFile,
  uploadState,
  uploadMessage,
  latestDocument,
  onSelectFile,
  onUpload,
  onRetry,
  onClose
}: ResumeParsePanelProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!selectedFile && inputRef.current) inputRef.current.value = "";
  }, [selectedFile]);
  if (!open) return null;
  const busy = uploadState === "uploading" || uploadState === "accepted_refreshing";
  const messageRole = uploadState === "error" || uploadState === "accepted_refresh_error" ? "alert" : "status";

  return (
    <section className="resume-parse-panel" aria-labelledby="resume-parse-title">
      <h2 className="visually-hidden">简历资料</h2>
      <div className="resume-parse-heading">
        <span className="resume-parse-icon"><FileText aria-hidden="true" size={20} /></span>
        <div>
          <h2 id="resume-parse-title">简历解析</h2>
          <p>{latestDocument ? <><strong>{latestDocument.filename}</strong><span>已提取 {latestDocument.extractedFactCount} 项资料</span></> : "上传 PDF 简历，将解析结果写入对应档案栏目"}</p>
        </div>
        <button className="icon-button" type="button" aria-label="收起简历解析" title="收起简历解析" onClick={onClose}>
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
        <button className="button primary" type="button" aria-label="上传并提取" disabled={!selectedFile || busy} onClick={onUpload}>
          {uploadState === "uploading" ? "正在上传" : "开始解析"}
        </button>
        {uploadState === "accepted_refresh_error" && (
          <button className="button secondary" type="button" onClick={onRetry}>
            <RefreshCw aria-hidden="true" size={16} />重新刷新资料
          </button>
        )}
      </div>
      {uploadState === "uploading" && selectedFile && (
        <div className="upload-progress" role="progressbar" aria-label={`正在上传 ${selectedFile.name}`}><span /></div>
      )}
      {uploadMessage && <p className={`resume-parse-message ${messageRole === "alert" ? "error" : ""}`} role={messageRole}>{uploadMessage}</p>}
    </section>
  );
}
