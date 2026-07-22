import type { FactStatus, JsonValue, ProfileFact } from "@resume/contracts";
import { FileText, RefreshCw, ShieldCheck, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProfileApi, SelfEvaluationReviewApi } from "../api/client.js";
import { EvidenceDrawer } from "./EvidenceDrawer.js";
import { FactEditor } from "./FactEditor.js";
import { SelfEvaluationReview } from "../reviews/SelfEvaluationReview.js";

type ReviewStatus = Exclude<FactStatus, "superseded">;
type Filter = "all" | ReviewStatus;
type Category = typeof CATEGORY_ORDER[number];
type UploadState = "idle" | "uploading" | "accepted_refreshing" | "success" | "accepted_refresh_error" | "error";
type ReadResult = "success" | "error" | "stale";
type FocusControl = "modify" | "evidence";
type AcceptedUploadPhase = "none" | "refreshing" | "error" | "success";

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
  { value: "user_corrected", label: "已修改" }
];

interface ProfilePageProps {
  api: ProfileApi;
  reviewApi?: SelfEvaluationReviewApi;
}

export function ProfilePage({ api, reviewApi }: ProfilePageProps) {
  const [facts, setFacts] = useState<ProfileFact[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedFile, setSelectedFile] = useState<File>();
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadMessage, setUploadMessage] = useState<string>();
  const [busy, setBusy] = useState<{ factId: string; action: "confirm" | "correct" }>();
  const [editingId, setEditingId] = useState<string>();
  const [factErrors, setFactErrors] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<{ fact: ProfileFact; trigger: HTMLElement | null }>();
  const [focusRequest, setFocusRequest] = useState<{ factId: string; control: FocusControl }>();
  const contextGeneration = useRef(0);
  const readGeneration = useRef(0);
  const operationSequence = useRef(0);
  const uploadOwner = useRef<number | null>(null);
  const acceptedUploadOwner = useRef<number | null>(null);
  const acceptedUploadPhase = useRef<AcceptedUploadPhase>("none");
  const mutationOwner = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const reviewTitleRef = useRef<HTMLHeadingElement>(null);
  const [view, setView] = useState<"profile" | "self-evaluation">("profile");
  const [taskId, setTaskId] = useState("task-1");
  const [selfEvaluationReview, setSelfEvaluationReview] = useState<Awaited<ReturnType<SelfEvaluationReviewApi["get"]>>>();
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string>();
  const modifyButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const evidenceButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const isCurrentContext = useCallback((context: number) => contextGeneration.current === context, []);

  const loadSelfEvaluationReview = async () => {
    if (!reviewApi || reviewLoading || taskId.trim() === "") return;
    setReviewLoading(true); setReviewError(undefined);
    try { setSelfEvaluationReview(await reviewApi.get(taskId.trim())); }
    catch { setSelfEvaluationReview(undefined); setReviewError("审核加载失败，请重试"); }
    finally { setReviewLoading(false); }
  };

  const settleAcceptedUploadSuccess = useCallback((context: number) => {
    if (!isCurrentContext(context) || acceptedUploadOwner.current === null) return;
    if (acceptedUploadPhase.current !== "refreshing" && acceptedUploadPhase.current !== "error") return;
    acceptedUploadPhase.current = "success";
    setUploadState("success");
    setUploadMessage("简历已导入，资料已刷新");
  }, [isCurrentContext]);

  const requestFacts = useCallback(async (
    requestApi: ProfileApi,
    context: number,
    foreground: boolean
  ): Promise<ReadResult> => {
    const request = ++readGeneration.current;
    if (!isCurrentContext(context)) return "stale";
    if (foreground) {
      setLoading(true);
      setLoadError(false);
    }
    try {
      const nextFacts = await requestApi.listFacts();
      if (!isCurrentContext(context) || readGeneration.current !== request) return "stale";
      setFacts(nextFacts);
      setLoadError(false);
      settleAcceptedUploadSuccess(context);
      return "success";
    } catch {
      if (!isCurrentContext(context) || readGeneration.current !== request) return "stale";
      if (foreground) setLoadError(true);
      return "error";
    } finally {
      if (foreground && isCurrentContext(context) && readGeneration.current === request) setLoading(false);
    }
  }, [isCurrentContext, settleAcceptedUploadSuccess]);

  const loadFacts = useCallback(async () => {
    if (acceptedUploadPhase.current === "refreshing") return;
    await requestFacts(api, contextGeneration.current, true);
  }, [api, requestFacts]);

  useEffect(() => {
    const context = ++contextGeneration.current;
    readGeneration.current += 1;
    uploadOwner.current = null;
    acceptedUploadOwner.current = null;
    acceptedUploadPhase.current = "none";
    mutationOwner.current = null;
    setFacts([]);
    setLoading(true);
    setLoadError(false);
    setSelectedFile(undefined);
    setUploadState("idle");
    setUploadMessage(undefined);
    setBusy(undefined);
    setEditingId(undefined);
    setFactErrors({});
    setEvidence(undefined);
    setFocusRequest(undefined);
    if (fileInputRef.current) fileInputRef.current.value = "";
    void requestFacts(api, context, true);
    return () => {
      if (contextGeneration.current === context) contextGeneration.current += 1;
      readGeneration.current += 1;
      uploadOwner.current = null;
      acceptedUploadOwner.current = null;
      acceptedUploadPhase.current = "none";
      mutationOwner.current = null;
    };
  }, [api, requestFacts]);

  useEffect(() => {
    if (!focusRequest) return;
    const buttonRefs = focusRequest.control === "modify" ? modifyButtonRefs : evidenceButtonRefs;
    (buttonRefs.current.get(focusRequest.factId) ?? reviewTitleRef.current)?.focus();
    setFocusRequest(undefined);
  }, [focusRequest]);

  const replaceFact = (updated: ProfileFact) => {
    setFacts((current) => current.map((fact) => fact.id === updated.id ? updated : fact));
  };

  const reconcileMutation = async (updated: ProfileFact, context: number, requestApi: ProfileApi) => {
    const result = await requestFacts(requestApi, context, false);
    if (result === "error" && isCurrentContext(context)) {
      setFactErrors((errors) => ({ ...errors, [updated.id]: "操作已保存，但资料刷新失败" }));
    }
  };

  const confirmFact = async (fact: ProfileFact) => {
    if (mutationOwner.current !== null || uploadOwner.current !== null || acceptedUploadPhase.current === "refreshing") return;
    readGeneration.current += 1;
    const context = contextGeneration.current;
    const owner = ++operationSequence.current;
    mutationOwner.current = owner;
    setBusy({ factId: fact.id, action: "confirm" });
    setFactErrors((errors) => ({ ...errors, [fact.id]: "" }));
    try {
      const updated = await api.confirm(fact.id);
      if (!isCurrentContext(context) || mutationOwner.current !== owner) return;
      replaceFact(updated);
      mutationOwner.current = null;
      setBusy(undefined);
      setFocusRequest({ factId: fact.id, control: "evidence" });
      void reconcileMutation(updated, context, api);
    } catch {
      if (!isCurrentContext(context) || mutationOwner.current !== owner) return;
      setFactErrors((errors) => ({ ...errors, [fact.id]: "确认失败，请重试" }));
      mutationOwner.current = null;
      setBusy(undefined);
    }
  };

  const correctFact = async (fact: ProfileFact, value: JsonValue): Promise<boolean> => {
    if (mutationOwner.current !== null || uploadOwner.current !== null || acceptedUploadPhase.current === "refreshing") return false;
    readGeneration.current += 1;
    const context = contextGeneration.current;
    const owner = ++operationSequence.current;
    mutationOwner.current = owner;
    setBusy({ factId: fact.id, action: "correct" });
    setFactErrors((errors) => ({ ...errors, [fact.id]: "" }));
    try {
      const updated = await api.correct(fact.id, value);
      if (!isCurrentContext(context) || mutationOwner.current !== owner) return false;
      replaceFact(updated);
      setEditingId(undefined);
      mutationOwner.current = null;
      setBusy(undefined);
      setFocusRequest({ factId: fact.id, control: "evidence" });
      void reconcileMutation(updated, context, api);
      return true;
    } catch {
      if (!isCurrentContext(context) || mutationOwner.current !== owner) return false;
      setFactErrors((errors) => ({ ...errors, [fact.id]: "保存失败，请重试" }));
      mutationOwner.current = null;
      setBusy(undefined);
      return false;
    }
  };

  const selectFile = (file: File | undefined) => {
    if (acceptedUploadPhase.current === "refreshing") return;
    acceptedUploadOwner.current = null;
    acceptedUploadPhase.current = "none";
    setUploadState("idle");
    setUploadMessage(undefined);
    if (!file) {
      setSelectedFile(undefined);
      return;
    }
    const pdfName = file.name.toLowerCase().endsWith(".pdf");
    if (!pdfName || (file.type !== "application/pdf" && file.type !== "")) {
      setSelectedFile(undefined);
      setUploadState("error");
      setUploadMessage("请选择 PDF 文件");
      return;
    }
    if (file.type === "") {
      setSelectedFile(undefined);
      setUploadState("error");
      setUploadMessage("浏览器未提供 PDF 文件类型，无法上传");
      return;
    }
    setSelectedFile(file);
  };

  const refreshAcceptedUpload = async (owner: number, context: number, requestApi: ProfileApi) => {
    if (!isCurrentContext(context) || acceptedUploadOwner.current !== owner) return;
    if (acceptedUploadPhase.current === "refreshing") return;
    acceptedUploadPhase.current = "refreshing";
    setUploadState("accepted_refreshing");
    setUploadMessage("简历已导入，正在刷新资料");
    const result = await requestFacts(requestApi, context, false);
    if (!isCurrentContext(context) || acceptedUploadOwner.current !== owner) return;
    if (result !== "success" && acceptedUploadPhase.current === "refreshing") {
      acceptedUploadPhase.current = "error";
      setUploadState("accepted_refresh_error");
      setUploadMessage("简历已导入，但资料刷新失败");
    }
  };

  const uploadFile = async () => {
    if (!selectedFile || uploadOwner.current !== null || mutationOwner.current !== null || acceptedUploadPhase.current === "refreshing") return;
    readGeneration.current += 1;
    setLoading(false);
    setLoadError(false);
    const context = contextGeneration.current;
    const owner = ++operationSequence.current;
    const file = selectedFile;
    uploadOwner.current = owner;
    setUploadState("uploading");
    setUploadMessage(undefined);
    try {
      await api.upload(file);
      if (!isCurrentContext(context) || uploadOwner.current !== owner) return;
      setSelectedFile(undefined);
      if (fileInputRef.current) fileInputRef.current.value = "";
      acceptedUploadOwner.current = owner;
      uploadOwner.current = null;
      void refreshAcceptedUpload(owner, context, api);
    } catch {
      if (!isCurrentContext(context) || uploadOwner.current !== owner) return;
      setUploadState("error");
      setUploadMessage("上传失败，请检查文件后重试");
      acceptedUploadPhase.current = "none";
      uploadOwner.current = null;
    }
  };

  const counts = useMemo(() => {
    const statusCounts: Record<ReviewStatus, number> = { extracted: 0, user_confirmed: 0, user_corrected: 0 };
    facts.forEach((fact) => {
      if (fact.status !== "superseded") statusCounts[fact.status] += 1;
    });
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
  const acceptedRefreshing = uploadState === "accepted_refreshing";
  const mutationBusy = busy !== undefined;
  const controlsLocked = uploading || acceptedRefreshing || mutationBusy;

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
        <nav className="view-switch" aria-label="工作区视图">
          <button type="button" aria-pressed={view === "profile"} onClick={() => setView("profile")}>资料审核</button>
          <button type="button" aria-pressed={view === "self-evaluation"} onClick={() => setView("self-evaluation")}>自我评价审核</button>
        </nav>
        {view === "self-evaluation" && reviewApi ? (
          <section className="review-band" aria-labelledby="self-evaluation-title">
            <div className="review-heading"><div><h2 id="self-evaluation-title" tabIndex={-1}>自我评价审核</h2><p>任务范围内的版本确认</p></div></div>
            <div className="review-load-controls"><label>任务 ID<input aria-label="任务 ID" value={taskId} disabled={reviewLoading} onChange={(event) => setTaskId(event.target.value)} /></label><button className="button secondary" type="button" disabled={reviewLoading || taskId.trim() === ""} onClick={() => void loadSelfEvaluationReview()}>{reviewLoading ? "加载中" : "加载审核"}</button><button className="icon-button" type="button" aria-label="刷新审核" title="刷新审核" disabled={reviewLoading || taskId.trim() === ""} onClick={() => void loadSelfEvaluationReview()}><RefreshCw aria-hidden="true" size={18} /></button></div>
            {reviewError && <p className="inline-error" role="alert">{reviewError}</p>}
            {selfEvaluationReview && <SelfEvaluationReview draft={selfEvaluationReview} onApprove={async (value) => { const next = await reviewApi.approve(taskId, value); setSelfEvaluationReview(next); return next; }} onKeepOriginal={async () => { const next = await reviewApi.approve(taskId, undefined, true); setSelfEvaluationReview(next); return next; }} />}
          </section>
        ) : view === "self-evaluation" ? (
          <section className="review-band"><p className="inline-error" role="alert">审核服务不可用</p></section>
        ) : <>
        <section className="upload-band" aria-labelledby="upload-title">
          <div className="section-heading">
            <div>
              <h2 id="upload-title">简历资料</h2>
              <p>{facts.length} 条资料</p>
            </div>
            <button className="icon-button" type="button" aria-label="刷新资料" title="刷新资料" disabled={loading || controlsLocked} onClick={() => void loadFacts()}>
              <RefreshCw aria-hidden="true" size={18} />
            </button>
          </div>
          <div className="upload-controls">
            <label className={`file-picker${controlsLocked ? " disabled" : ""}`}>
              <Upload aria-hidden="true" size={18} />
              <span>选择 PDF</span>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf"
                aria-label="选择 PDF 简历"
                disabled={controlsLocked}
                onChange={(event) => selectFile(event.target.files?.[0])}
              />
            </label>
            <span className="filename" title={selectedFile?.name}>{selectedFile?.name ?? "未选择文件"}</span>
            <button className="button primary upload-button" type="button" disabled={!selectedFile || controlsLocked} onClick={() => void uploadFile()}>
              {uploading ? "上传中" : "上传并提取"}
            </button>
          </div>
          {uploading && selectedFile && (
            <div className="upload-progress" role="progressbar" aria-label={`正在上传 ${selectedFile.name}`}>
              <span />
            </div>
          )}
          {uploadMessage && (
            <div
              className={`upload-message ${uploadState}`}
              role={uploadState === "error" || uploadState === "accepted_refresh_error" ? "alert" : "status"}
            >
              <span>{uploadMessage}</span>
              {uploadState === "accepted_refresh_error" && acceptedUploadOwner.current !== null && (
                <button
                  className="button secondary"
                  type="button"
                  onClick={() => void refreshAcceptedUpload(acceptedUploadOwner.current!, contextGeneration.current, api)}
                >重新加载资料</button>
              )}
            </div>
          )}
        </section>

        <section className="review-band" aria-labelledby="review-title">
          <div className="review-heading">
            <div>
              <h2 ref={reviewTitleRef} id="review-title" tabIndex={-1}>资料审核</h2>
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
                                  setFocusRequest({ factId: fact.id, control: "modify" });
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
                                ref={(element) => {
                                  if (element) evidenceButtonRefs.current.set(fact.id, element);
                                  else evidenceButtonRefs.current.delete(fact.id);
                                }}
                                className="button quiet"
                                type="button"
                                onClick={(event) => setEvidence({ fact, trigger: event.currentTarget })}
                              >查看来源</button>
                              {fact.status === "extracted" && (
                                <button className="button primary" type="button" disabled={controlsLocked} onClick={() => void confirmFact(fact)}>
                                  {isBusy && busy.action === "confirm" ? "确认中" : "确认"}
                                </button>
                              )}
                              {fact.status !== "superseded" && (
                                <button
                                  ref={(element) => {
                                    if (element) modifyButtonRefs.current.set(fact.id, element);
                                    else modifyButtonRefs.current.delete(fact.id);
                                  }}
                                  className="button secondary"
                                  type="button"
                                  disabled={controlsLocked}
                                  onClick={() => {
                                    if (acceptedUploadPhase.current === "refreshing") return;
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
        </>}
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
  languages: "语言", items: "技能项", skills: "技能", portfolio: "作品集", website: "网站", url: "链接",
  summary: "内容", remote: "接受远程"
};

const CATEGORY_FIELD_LABELS: Partial<Record<Category, Record<string, string>>> = {
  education: { degree: "学历/学位", title: "学历/学位" },
  work: { title: "职位" },
  projects: { name: "项目名称", title: "项目标题" },
  certificates: { name: "证书名称", title: "证书名称" }
};

function labelFor(fieldPath: string): string {
  const segments = fieldPath.split(/[.[\]]/).filter((segment) => segment && !/^\d+$/.test(segment));
  const leaf = segments.at(-1) ?? fieldPath;
  const normalizedLeaf = leaf.toLowerCase();
  const category = categoryFor(fieldPath);
  if (category === "skills" && segments.length === 1) return "技能";
  return CATEGORY_FIELD_LABELS[category]?.[normalizedLeaf] ?? FIELD_LABELS[normalizedLeaf] ?? leaf;
}

function displayValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "是" : "否";
  return typeof value === "number" ? String(value) : JSON.stringify(value, null, 2);
}
