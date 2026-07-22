import type { FactStatus, JsonValue, ProfileFact } from "@resume/contracts";
import { FileText, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ProfileApi } from "../api/client.js";
import { EvidenceDrawer } from "./EvidenceDrawer.js";
import { FactEditor } from "./FactEditor.js";

type Filter = "all" | FactStatus;
type Category = typeof CATEGORY_ORDER[number];

const CATEGORY_ORDER = [
  "basic", "education", "work", "projects", "skills", "certificates", "links", "self", "preferences", "other"
] as const;

const CATEGORY_LABELS: Record<Category, string> = {
  basic: "基本信息",
  education: "教育经历",
  work: "工作经历",
  projects: "项目经历",
  skills: "技能",
  certificates: "证书",
  links: "链接",
  self: "自我评价",
  preferences: "求职偏好",
  other: "其他"
};

const STATUS_META: Record<FactStatus, { label: string; className: string }> = {
  extracted: { label: "待确认", className: "pending" },
  user_confirmed: { label: "已确认", className: "confirmed" },
  user_corrected: { label: "已修改", className: "corrected" },
  superseded: { label: "已被替代", className: "superseded" }
};

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "extracted", label: "待确认" },
  { value: "user_confirmed", label: "已确认" },
  { value: "user_corrected", label: "已修改" },
  { value: "superseded", label: "已替代" }
];

interface ProfilePageProps {
  api: ProfileApi;
}

export function ProfilePage({ api }: ProfilePageProps) {
  const [facts, setFacts] = useState<ProfileFact[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedFile, setSelectedFile] = useState<File>();
  const [uploadState, setUploadState] = useState<"idle" | "uploading" | "success" | "error">("idle");
  const [uploadMessage, setUploadMessage] = useState<string>();
  const [busy, setBusy] = useState<{ factId: string; action: "confirm" | "correct" }>();
  const [editingId, setEditingId] = useState<string>();
  const [factErrors, setFactErrors] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<{ fact: ProfileFact; trigger: HTMLElement | null }>();

  const loadFacts = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      setFacts(await api.listFacts());
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError(false);
    void api.listFacts().then((nextFacts) => {
      if (active) setFacts(nextFacts);
    }).catch(() => {
      if (active) setLoadError(true);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [api]);

  const replaceFact = (updated: ProfileFact) => {
    setFacts((current) => current.map((fact) => fact.id === updated.id ? updated : fact));
  };

  const reconcileMutation = async (updated: ProfileFact) => {
    replaceFact(updated);
    try {
      setFacts(await api.listFacts());
    } catch {
      setFactErrors((errors) => ({ ...errors, [updated.id]: "操作已保存，但资料刷新失败" }));
    }
  };

  const confirmFact = async (fact: ProfileFact) => {
    setBusy({ factId: fact.id, action: "confirm" });
    setFactErrors((errors) => ({ ...errors, [fact.id]: "" }));
    try {
      await reconcileMutation(await api.confirm(fact.id));
    } catch {
      setFactErrors((errors) => ({ ...errors, [fact.id]: "确认失败，请重试" }));
    } finally {
      setBusy(undefined);
    }
  };

  const correctFact = async (fact: ProfileFact, value: JsonValue): Promise<boolean> => {
    setBusy({ factId: fact.id, action: "correct" });
    setFactErrors((errors) => ({ ...errors, [fact.id]: "" }));
    try {
      await reconcileMutation(await api.correct(fact.id, value));
      setEditingId(undefined);
      return true;
    } catch {
      setFactErrors((errors) => ({ ...errors, [fact.id]: "保存失败，请重试" }));
      return false;
    } finally {
      setBusy(undefined);
    }
  };

  const selectFile = (file: File | undefined) => {
    setUploadState("idle");
    setUploadMessage(undefined);
    if (!file) {
      setSelectedFile(undefined);
      return;
    }
    const pdfName = file.name.toLowerCase().endsWith(".pdf");
    const pdfType = file.type === "application/pdf" || file.type === "";
    if (!pdfName || !pdfType) {
      setSelectedFile(undefined);
      setUploadState("error");
      setUploadMessage("请选择 PDF 文件");
      return;
    }
    setSelectedFile(file);
  };

  const uploadFile = async () => {
    if (!selectedFile) return;
    setUploadState("uploading");
    setUploadMessage(undefined);
    try {
      await api.upload(selectedFile);
      const refreshed = await api.listFacts();
      setFacts(refreshed);
      setLoadError(false);
      setUploadState("success");
      setUploadMessage("简历已导入，资料已刷新");
    } catch {
      setUploadState("error");
      setUploadMessage("上传失败，请检查文件后重试");
    }
  };

  const counts = useMemo(() => {
    const statusCounts: Record<FactStatus, number> = { extracted: 0, user_confirmed: 0, user_corrected: 0, superseded: 0 };
    facts.forEach((fact) => { statusCounts[fact.status] += 1; });
    return statusCounts;
  }, [facts]);

  const grouped = useMemo(() => {
    const visibleFacts = facts
      .filter((fact) => filter === "all" || fact.status === filter)
      .sort((left, right) => left.fieldPath.localeCompare(right.fieldPath) || left.id.localeCompare(right.id));
    return CATEGORY_ORDER.map((category) => ({
      category,
      facts: visibleFacts.filter((fact) => categoryFor(fact.fieldPath) === category)
    })).filter((group) => group.facts.length > 0);
  }, [facts, filter]);

  const uploading = uploadState === "uploading";

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <FileText aria-hidden="true" size={21} />
          <h1>简历投递助手</h1>
        </div>
        <div className="local-state"><ShieldCheck aria-hidden="true" size={16} />仅本机</div>
      </header>

      <main>
        <section className="upload-band" aria-labelledby="upload-title">
          <div className="section-heading">
            <div>
              <h2 id="upload-title">简历资料</h2>
              <p>{facts.length} 条资料</p>
            </div>
            <button className="icon-button" type="button" aria-label="刷新资料" title="刷新资料" disabled={loading || uploading} onClick={() => void loadFacts()}>
              <RefreshCw aria-hidden="true" size={18} />
            </button>
          </div>
          <div className="upload-controls">
            <label className={`file-picker${uploading ? " disabled" : ""}`}>
              <Upload aria-hidden="true" size={18} />
              <span>选择 PDF</span>
              <input
                type="file"
                accept="application/pdf,.pdf"
                aria-label="选择 PDF 简历"
                disabled={uploading}
                onChange={(event) => selectFile(event.target.files?.[0])}
              />
            </label>
            <span className="filename" title={selectedFile?.name}>{selectedFile?.name ?? "未选择文件"}</span>
            <button className="button primary upload-button" type="button" disabled={!selectedFile || uploading} onClick={() => void uploadFile()}>
              {uploading ? "上传中" : "上传并提取"}
            </button>
          </div>
          {uploading && selectedFile && (
            <div className="upload-progress" role="progressbar" aria-label={`正在上传 ${selectedFile.name}`}>
              <span />
            </div>
          )}
          {uploadMessage && <p className={`upload-message ${uploadState}`} role={uploadState === "error" ? "alert" : "status"}>{uploadMessage}</p>}
        </section>

        <section className="review-band" aria-labelledby="review-title">
          <div className="review-heading">
            <div>
              <h2 id="review-title">资料审核</h2>
              <p>逐项确认提取结果</p>
            </div>
            <div className="status-filter" role="group" aria-label="按状态筛选">
              {FILTERS.map((item) => {
                const count = item.value === "all" ? facts.length : counts[item.value];
                return (
                  <button
                    type="button"
                    key={item.value}
                    aria-pressed={filter === item.value}
                    aria-label={`${item.label} ${count}`}
                    onClick={() => setFilter(item.value)}
                  >
                    <span>{item.label}</span><strong>{count}</strong>
                  </button>
                );
              })}
            </div>
          </div>

          {loading ? (
            <div className="state-panel" role="status" aria-label="资料加载状态"><span className="spinner" />正在加载资料</div>
          ) : loadError ? (
            <div className="state-panel error-state" role="alert">
              <strong>资料加载失败</strong>
              <button className="button secondary" type="button" onClick={() => void loadFacts()}>重新加载</button>
            </div>
          ) : facts.length === 0 ? (
            <div className="state-panel empty-state">
              <strong>还没有可审核的资料</strong>
              <span>请先选择并上传 PDF 简历</span>
            </div>
          ) : grouped.length === 0 ? (
            <div className="state-panel empty-state"><strong>当前筛选下没有资料</strong></div>
          ) : (
            <div className="fact-groups">
              {grouped.map((group) => (
                <section className="fact-section" key={group.category} aria-labelledby={`category-${group.category}`}>
                  <header>
                    <h2 id={`category-${group.category}`}>{CATEGORY_LABELS[group.category]}</h2>
                    <span>{group.facts.length}</span>
                  </header>
                  <div className="fact-list">
                    {group.facts.map((fact) => {
                      const fieldLabel = labelFor(fact.fieldPath);
                      const isBusy = busy?.factId === fact.id;
                      const editing = editingId === fact.id;
                      return (
                        <article className="fact-row" data-testid={`fact-${fact.id}`} key={fact.id}>
                          <div className="fact-main">
                            <div className="fact-label-line">
                              <span className="field-label">{fieldLabel}</span>
                              <span className={`status-badge ${STATUS_META[fact.status].className}`}>{STATUS_META[fact.status].label}</span>
                            </div>
                            {editing ? (
                              <FactEditor
                                fact={fact}
                                fieldLabel={fieldLabel}
                                saving={isBusy && busy.action === "correct"}
                                apiError={factErrors[fact.id] || undefined}
                                onCancel={() => {
                                  setEditingId(undefined);
                                  setFactErrors((errors) => ({ ...errors, [fact.id]: "" }));
                                }}
                                onSave={(value) => correctFact(fact, value)}
                              />
                            ) : (
                              <pre className="fact-value">{displayValue(fact.value)}</pre>
                            )}
                            {!editing && factErrors[fact.id] && <p className="inline-error" role="alert">{factErrors[fact.id]}</p>}
                          </div>
                          {!editing && (
                            <div className="fact-actions">
                              <button
                                className="button quiet"
                                type="button"
                                onClick={(event) => setEvidence({ fact, trigger: event.currentTarget })}
                              >查看来源</button>
                              {fact.status === "extracted" && (
                                <button className="button primary" type="button" disabled={isBusy} onClick={() => void confirmFact(fact)}>
                                  {isBusy && busy.action === "confirm" ? "确认中" : "确认"}
                                </button>
                              )}
                              {fact.status !== "superseded" && (
                                <button
                                  className="button secondary"
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => {
                                    setEditingId(fact.id);
                                    setFactErrors((errors) => ({ ...errors, [fact.id]: "" }));
                                  }}
                                >修改</button>
                              )}
                            </div>
                          )}
                        </article>
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </section>
      </main>

      {evidence && <EvidenceDrawer fact={evidence.fact} returnFocusTo={evidence.trigger} onClose={() => setEvidence(undefined)} />}
    </div>
  );
}

function categoryFor(fieldPath: string): Category {
  const root = fieldPath.split(/[.[\]]/).find(Boolean)?.replace(/[-_]/g, "").toLowerCase() ?? "";
  if (["basic", "basics", "basicinfo", "basicinformation", "personal", "contact"].includes(root)) return "basic";
  if (["education", "educations", "academic", "educationbackground", "educationexperience"].includes(root)) return "education";
  if (["work", "works", "experience", "experiences", "employment", "workexperience", "professionalexperience"].includes(root)) return "work";
  if (["project", "projects", "projectexperience"].includes(root)) return "projects";
  if (["skill", "skills", "skillset", "technicalskills"].includes(root)) return "skills";
  if (["certificate", "certificates", "certification", "certifications"].includes(root)) return "certificates";
  if (["link", "links", "social", "sociallinks"].includes(root)) return "links";
  if (["self", "selfevaluation", "summary", "objective"].includes(root)) return "self";
  if (["preference", "preferences", "jobpreference", "jobpreferences"].includes(root)) return "preferences";
  return "other";
}

const FIELD_LABELS: Record<string, string> = {
  name: "姓名", email: "邮箱", phone: "手机号", mobile: "手机号", city: "城市", location: "所在地",
  school: "学校", degree: "学历", major: "专业", company: "公司", title: "职位", years: "工作年限",
  languages: "语言", items: "技能项", portfolio: "作品集", website: "网站", url: "链接", summary: "内容"
};

function labelFor(fieldPath: string): string {
  const segments = fieldPath.split(/[.[\]]/).filter((segment) => segment && !/^\d+$/.test(segment));
  const leaf = segments.at(-1) ?? fieldPath;
  return FIELD_LABELS[leaf.toLowerCase()] ?? leaf;
}

function displayValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "是" : "否";
  return typeof value === "number" ? String(value) : JSON.stringify(value, null, 2);
}
