import { SelfEvaluationReviewSchema, type AdapterId, type AdapterStatus, type FactStatus, type JsonValue, type ProfileCompleteness, type ProfileDocumentSummary, type ProfileFact, type SelfEvaluationReview as SelfEvaluationReviewModel } from "@resume/contracts";
import { FileText, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ProfileApi, RagApi, SelfEvaluationReviewApi } from "../api/client.js";
import type { HealthApi } from "../api/health-client.js";
import { EvidenceDrawer } from "./EvidenceDrawer.js";
import { FactEditor } from "./FactEditor.js";
import { SelfEvaluationReview } from "../reviews/SelfEvaluationReview.js";
import { RagWorkspace } from "../rag/RagWorkspace.js";
import { ServiceStatus } from "../health/ServiceStatus.js";
import { CandidateProfileCenter } from "./CandidateProfileCenter.js";
import { ProfileSummaryBar } from "./ProfileSummaryBar.js";
import { ResumeParsePanel } from "./ResumeParsePanel.js";

type ReviewStatus = Exclude<FactStatus, "superseded">;
type Filter = "all" | ReviewStatus;
type Category = typeof CATEGORY_ORDER[number];
type UploadState = "idle" | "uploading" | "accepted_refreshing" | "success" | "accepted_refresh_error" | "error";
type ReadResult = "success" | "error" | "stale";
type FocusControl = "modify" | "evidence";
type AcceptedUploadPhase = "none" | "refreshing" | "error" | "success";

interface FactEntry {
  key: string;
  index: number;
  title: string;
  meta: string;
  facts: ProfileFact[];
}

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
  healthApi?: HealthApi;
  reviewApi?: SelfEvaluationReviewApi;
  ragApi?: RagApi;
  onStartApplication?: () => void;
  embedded?: boolean;
}

export function ProfilePage({ api, healthApi, reviewApi, ragApi, onStartApplication, embedded = false }: ProfilePageProps) {
  const [facts, setFacts] = useState<ProfileFact[]>([]);
  const [completeness, setCompleteness] = useState<ProfileCompleteness>();
  const [latestDocument, setLatestDocument] = useState<ProfileDocumentSummary>();
  const [parseOpen, setParseOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedFile, setSelectedFile] = useState<File>();
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadMessage, setUploadMessage] = useState<string>();
  const [busy, setBusy] = useState<{ factId: string; action: "confirm" | "correct" }>();
  const [editingId, setEditingId] = useState<string>();
  const [factErrors, setFactErrors] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<{ fact: ProfileFact; fieldLabel: string; trigger: HTMLElement | null }>();
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
  const [view, setView] = useState<"profile" | "self-evaluation" | "rag">("profile");
  const [taskId, setTaskId] = useState("task-1");
  const [jobDescription, setJobDescription] = useState("");
  const [selfEvaluationReview, setSelfEvaluationReview] = useState<SelfEvaluationReviewModel>();
  const [loadedReviewTaskId, setLoadedReviewTaskId] = useState<string>();
  const reviewLoadGeneration = useRef(0);
  const reviewActionOwner = useRef<number | null>(null);
  const [loadingReviewTaskId, setLoadingReviewTaskId] = useState<string>();
  const [reviewActionBusy, setReviewActionBusy] = useState(false);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string>();
  const [adapterStatuses, setAdapterStatuses] = useState<AdapterStatus[]>([]);
  const healthRequestGeneration = useRef(0);
  const healthAbortController = useRef<AbortController | undefined>(undefined);
  const healthMounted = useRef(true);
  const modifyButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const evidenceButtonRefs = useRef(new Map<string, HTMLButtonElement>());

  const isCurrentContext = useCallback((context: number) => contextGeneration.current === context, []);
  const adapterStatus = (id: AdapterId) => adapterStatuses.find((status) => status.id === id);
  const refreshAdapterStatuses = useCallback(async () => {
    if (!healthApi) return;
    healthAbortController.current?.abort();
    const controller = new AbortController();
    const request = ++healthRequestGeneration.current;
    healthAbortController.current = controller;
    try {
      const statuses = await healthApi.getStatuses(controller.signal);
      if (healthMounted.current && !controller.signal.aborted && healthRequestGeneration.current === request) {
        setAdapterStatuses(statuses);
      }
    } catch {
      if (healthMounted.current && !controller.signal.aborted && healthRequestGeneration.current === request) {
        setAdapterStatuses([]);
      }
    } finally {
      if (healthRequestGeneration.current === request) healthAbortController.current = undefined;
    }
  }, [healthApi]);

  useEffect(() => { void refreshAdapterStatuses(); }, [refreshAdapterStatuses]);
  useEffect(() => {
    healthMounted.current = true;
    return () => {
      healthMounted.current = false;
      healthRequestGeneration.current += 1;
      healthAbortController.current?.abort();
      healthAbortController.current = undefined;
    };
  }, []);

  const acceptReview = (candidate: unknown, expectedTaskId: string): SelfEvaluationReviewModel => {
    const parsed = SelfEvaluationReviewSchema.parse(candidate);
    if (parsed.taskId !== expectedTaskId) throw new Error("review task mismatch");
    return parsed;
  };

  const loadSelfEvaluationReview = async (requestedTaskId: string) => {
    if (!reviewApi || reviewActionOwner.current !== null || requestedTaskId === "" || loadingReviewTaskId === requestedTaskId) return;
    const request = ++reviewLoadGeneration.current;
    setReviewLoading(true); setLoadingReviewTaskId(requestedTaskId); setReviewError(undefined);
    try {
      const next = acceptReview(await reviewApi.get(requestedTaskId), requestedTaskId);
      if (reviewLoadGeneration.current !== request) return;
      setSelfEvaluationReview(next); setLoadedReviewTaskId(requestedTaskId);
    } catch {
      if (reviewLoadGeneration.current !== request) return;
      setSelfEvaluationReview(undefined); setLoadedReviewTaskId(undefined); setReviewError("审核加载失败，请重试");
    } finally {
      if (reviewLoadGeneration.current === request) { setReviewLoading(false); setLoadingReviewTaskId(undefined); }
    }
  };

  const changeReviewTaskId = (nextTaskId: string) => {
    setTaskId(nextTaskId);
    if (nextTaskId.trim() !== loadedReviewTaskId) {
      reviewLoadGeneration.current += 1;
      setSelfEvaluationReview(undefined); setLoadedReviewTaskId(undefined); setReviewError(undefined);
    }
  };

  const actOnLoadedReview = async (action: "approve" | "keep", value?: string): Promise<SelfEvaluationReviewModel> => {
    const review = selfEvaluationReview;
    if (!reviewApi || !review || review.taskId !== loadedReviewTaskId || reviewActionOwner.current !== null) throw new Error("review is unavailable");
    const owner = ++reviewLoadGeneration.current;
    reviewActionOwner.current = owner; setReviewActionBusy(true); setReviewError(undefined);
    try {
      const next = acceptReview(await reviewApi.approve(review.taskId, value, action === "keep"), review.taskId);
      if (reviewActionOwner.current !== owner || loadedReviewTaskId !== review.taskId) throw new Error("review changed");
      setSelfEvaluationReview(next);
      return next;
    } catch (error) {
      if (reviewActionOwner.current === owner && loadedReviewTaskId === review.taskId) setReviewError("审核操作失败，请重试");
      throw error;
    } finally {
      if (reviewActionOwner.current === owner) { reviewActionOwner.current = null; setReviewActionBusy(false); }
    }
  };

  const createSelfEvaluationReview = async () => {
    const requestedTaskId = taskId.trim();
    const provenance = jobDescription.trim();
    if (!reviewApi || reviewActionOwner.current !== null || !requestedTaskId || !provenance) return;
    const owner = ++reviewLoadGeneration.current;
    reviewActionOwner.current = owner; setReviewActionBusy(true); setReviewError(undefined);
    try {
      const next = acceptReview(await reviewApi.create(requestedTaskId, provenance), requestedTaskId);
      if (reviewActionOwner.current !== owner) return;
      setSelfEvaluationReview(next); setLoadedReviewTaskId(requestedTaskId);
    } catch {
      if (reviewActionOwner.current === owner) setReviewError("审核创建失败，请重试");
      void refreshAdapterStatuses();
    } finally {
      if (reviewActionOwner.current === owner) { reviewActionOwner.current = null; setReviewActionBusy(false); }
    }
  };

  const promoteLoadedReview = async (): Promise<SelfEvaluationReviewModel> => {
    const review = selfEvaluationReview;
    if (!reviewApi || !review || review.status !== "approved" || review.taskId !== loadedReviewTaskId || reviewActionOwner.current !== null) throw new Error("review is unavailable");
    const owner = ++reviewLoadGeneration.current;
    reviewActionOwner.current = owner; setReviewActionBusy(true); setReviewError(undefined);
    try {
      const next = acceptReview(await reviewApi.promote(review.taskId), review.taskId);
      if (reviewActionOwner.current !== owner) throw new Error("review changed");
      setSelfEvaluationReview(next);
      return next;
    } catch (error) {
      if (reviewActionOwner.current === owner) setReviewError("推广到长期资料失败，请重试");
      throw error;
    } finally {
      if (reviewActionOwner.current === owner) { reviewActionOwner.current = null; setReviewActionBusy(false); }
    }
  };

  useEffect(() => () => {
    reviewLoadGeneration.current += 1;
    reviewActionOwner.current = null;
  }, [reviewApi]);

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

  const loadCompleteness = useCallback(async () => {
    try {
      setCompleteness(await api.getCompleteness());
    } catch {
      setCompleteness(undefined);
    }
  }, [api]);

  const loadLatestDocument = useCallback(async () => {
    try {
      setLatestDocument(await api.getLatestDocument());
    } catch {
      setLatestDocument(undefined);
    }
  }, [api]);

  useEffect(() => {
    const context = ++contextGeneration.current;
    readGeneration.current += 1;
    uploadOwner.current = null;
    acceptedUploadOwner.current = null;
    acceptedUploadPhase.current = "none";
    mutationOwner.current = null;
    setFacts([]);
    setLatestDocument(undefined);
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
    void loadCompleteness();
    void loadLatestDocument();
    return () => {
      if (contextGeneration.current === context) contextGeneration.current += 1;
      readGeneration.current += 1;
      uploadOwner.current = null;
      acceptedUploadOwner.current = null;
      acceptedUploadPhase.current = "none";
      mutationOwner.current = null;
    };
  }, [api, loadCompleteness, loadLatestDocument, requestFacts]);

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
    return CATEGORY_ORDER.map((category) => {
      const categoryFacts = visibleFacts.filter((fact) => categoryFor(fact.fieldPath) === category);
      const allCategoryFacts = facts.filter((fact) => categoryFor(fact.fieldPath) === category);
      const entries = buildFactEntries(category, categoryFacts, allCategoryFacts);
      return {
        category,
        facts: categoryFacts,
        entries,
        looseFacts: entries.length > 0
          ? categoryFacts.filter((fact) => repeatedEntryIndex(fact.fieldPath) === undefined && !duplicatesEntryValue(fact, entries))
          : categoryFacts
      };
    }).filter((group) => group.facts.length > 0);
  }, [facts, filter]);

  const uploading = uploadState === "uploading";
  const acceptedRefreshing = uploadState === "accepted_refreshing";
  const mutationBusy = busy !== undefined;
  const controlsLocked = uploading || acceptedRefreshing || mutationBusy;
  const deepseek = adapterStatus("deepseek");
  const deepseekAvailable = healthApi === undefined || deepseek?.state === "configured" || deepseek?.state === "ready";
  const ocr = adapterStatus("ocr");
  const embedding = adapterStatus("embedding");
  const candidateName = factText(facts, ["name"]) ?? "候选人";
  const targetRole = factText(facts, ["targetrole"]);
  const missingCount = completeness?.sections.reduce((total, section) => total + section.missing.length, 0) ?? 0;

  const renderFact = (fact: ProfileFact, entryFacts: ProfileFact[] = []) => {
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
            <pre className="fact-value">{displayFactValue(fact, entryFacts)}</pre>
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
              onClick={(event) => setEvidence({ fact, fieldLabel, trigger: event.currentTarget })}
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
  };

  return (
    <div className={`app-shell${embedded ? " profile-page-embedded" : ""}`}>
      {!embedded && <header className="app-header">
        <div className="brand-block">
          <FileText aria-hidden="true" size={21} />
          <h1>简历投递助手</h1>
        </div>
        <div className="header-actions">
          {onStartApplication && <button className="button primary header-command" type="button" onClick={onStartApplication}><Plus aria-hidden="true" size={16} />新建投递</button>}
          <div className="local-state"><ShieldCheck aria-hidden="true" size={16} />仅本机</div>
        </div>
      </header>}

      <main>
        <nav className="view-switch" aria-label="工作区视图">
          <button type="button" aria-pressed={view === "profile"} onClick={() => setView("profile")}>候选人档案</button>
          <button type="button" aria-pressed={view === "self-evaluation"} onClick={() => setView("self-evaluation")}>自我评价审核</button>
          <button type="button" aria-pressed={view === "rag"} onClick={() => setView("rag")}>字段证据</button>
        </nav>
        {view === "rag" && ragApi ? <RagWorkspace api={ragApi} {...(embedding ? { embeddingStatus: embedding } : {})} /> : view === "rag" ? (
          <section className="review-band"><p className="inline-error" role="alert">RAG 服务不可用</p></section>
        ) : view === "self-evaluation" && reviewApi ? (
          <section className="review-band" aria-labelledby="self-evaluation-title">
            <div className="review-heading"><div><h2 id="self-evaluation-title" tabIndex={-1}>自我评价审核</h2><p>任务范围内的版本确认</p></div>{deepseek && <ServiceStatus statuses={[deepseek]} />}</div>
            <div className="review-load-controls"><label>任务 ID<input aria-label="任务 ID" value={taskId} disabled={reviewActionBusy} onChange={(event) => changeReviewTaskId(event.target.value)} /></label><button className="button secondary" type="button" disabled={reviewActionBusy || taskId.trim() === "" || loadingReviewTaskId === taskId.trim()} onClick={() => void loadSelfEvaluationReview(taskId.trim())}>{loadingReviewTaskId === taskId.trim() ? "加载中" : "加载审核"}</button><button className="icon-button" type="button" aria-label="刷新审核" title="刷新审核" disabled={reviewActionBusy || !loadedReviewTaskId || loadingReviewTaskId === loadedReviewTaskId} onClick={() => { if (loadedReviewTaskId) void loadSelfEvaluationReview(loadedReviewTaskId); }}><RefreshCw aria-hidden="true" size={18} /></button></div>
            <div className="review-create-controls"><label>岗位描述<textarea aria-label="岗位描述" value={jobDescription} disabled={reviewActionBusy} onChange={(event) => setJobDescription(event.target.value)} /></label><button className="button primary" type="button" disabled={!deepseekAvailable || reviewActionBusy || taskId.trim() === "" || jobDescription.trim() === ""} onClick={() => void createSelfEvaluationReview()}>创建审核</button></div>
            {reviewError && <p className="inline-error" role="alert">{reviewError}</p>}
            {selfEvaluationReview && <SelfEvaluationReview draft={selfEvaluationReview} onApprove={(value) => actOnLoadedReview("approve", value)} onKeepOriginal={() => actOnLoadedReview("keep")} {...(selfEvaluationReview.status === "approved" ? { onPromote: promoteLoadedReview } : {})} />}
          </section>
        ) : view === "self-evaluation" ? (
          <section className="review-band"><p className="inline-error" role="alert">审核服务不可用</p></section>
        ) : <>
        <ProfileSummaryBar
          candidateName={candidateName}
          {...(targetRole ? { targetRole } : {})}
          completeness={completeness}
          missingCount={missingCount}
          latestDocument={latestDocument}
          saveState="saved"
          onSave={() => undefined}
          onOpenParser={() => setParseOpen(true)}
          onFillMissing={() => {
            const firstMissing = completeness?.sections.find((section) => section.missing.length > 0);
            document.getElementById(`profile-section-${firstMissing?.id ?? "basics"}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
          }}
        />
        <div className="resume-parse-region">
          <div className="resume-parse-service-bar">
            {ocr && <ServiceStatus statuses={[ocr]} />}
            <button
              className="icon-button"
              type="button"
              aria-label="刷新资料"
              title="刷新资料"
              disabled={loading || controlsLocked}
              onClick={() => { void loadFacts(); void refreshAdapterStatuses(); void loadLatestDocument(); }}
            >
              <RefreshCw aria-hidden="true" size={18} />
            </button>
          </div>
          <ResumeParsePanel
            open={parseOpen}
            selectedFile={selectedFile}
            uploadState={uploadState}
            uploadMessage={uploadMessage}
            latestDocument={latestDocument}
            onSelectFile={selectFile}
            onUpload={() => void uploadFile()}
            onRetry={() => {
              if (acceptedUploadOwner.current !== null) {
                void refreshAcceptedUpload(acceptedUploadOwner.current, contextGeneration.current, api);
              }
            }}
            onClose={() => setParseOpen(false)}
          />
        </div>
        <CandidateProfileCenter
          api={api}
          facts={facts}
          completeness={completeness}
          onFactsChanged={async () => {
            await loadFacts();
            await loadCompleteness();
          }}
        />

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
                    <span>{group.entries.length > 0 ? `${group.entries.length} 个条目 · ` : ""}{group.facts.length} 条资料</span>
                  </header>
                  {group.entries.length > 0 && (
                    <div className="fact-entry-list">
                      {group.entries.map((entry) => (
                        <section className={`fact-entry ${group.category}`} data-testid={`fact-entry-${group.category}-${entry.index}`} key={entry.key}>
                          <header className="fact-entry-header">
                            <div className="fact-entry-index" aria-hidden="true">{String(entry.index + 1).padStart(2, "0")}</div>
                            <div className="fact-entry-heading">
                              <span>{entryCategoryLabel(group.category)}</span>
                              <h3>{entry.title}</h3>
                              {entry.meta && <p>{entry.meta}</p>}
                            </div>
                            <span className="fact-entry-count">{entry.facts.length} 条资料</span>
                          </header>
                          <div className="fact-list">{entry.facts.map((fact) => renderFact(fact, entry.facts))}</div>
                        </section>
                      ))}
                    </div>
                  )}
                  {group.looseFacts.length > 0 && <div className="fact-list loose-facts">{group.looseFacts.map((fact) => renderFact(fact))}</div>}
                </section>
              ))}
            </div>
          )}
        </section>
        </>}
      </main>

      {evidence && (
        <EvidenceDrawer
          fact={evidence.fact}
          fieldLabel={evidence.fieldLabel}
          returnFocusTo={evidence.trigger}
          onClose={() => setEvidence(undefined)}
        />
      )}
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

function buildFactEntries(category: Category, visibleFacts: ProfileFact[], allFacts: ProfileFact[]): FactEntry[] {
  if (category !== "education" && category !== "projects" && category !== "work") return [];

  const visibleByIndex = new Map<number, ProfileFact[]>();
  visibleFacts.forEach((fact) => {
    const index = repeatedEntryIndex(fact.fieldPath);
    if (index === undefined) return;
    const entryFacts = visibleByIndex.get(index) ?? [];
    entryFacts.push(fact);
    visibleByIndex.set(index, entryFacts);
  });

  return [...visibleByIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, entryFacts]) => {
      const allEntryFacts = allFacts.filter((fact) => repeatedEntryIndex(fact.fieldPath) === index);
      const title = category === "projects"
        ? factText(allEntryFacts, ["name", "title"]) ?? `项目 ${index + 1}`
        : category === "education"
          ? factText(allEntryFacts, ["school", "institution", "name"]) ?? `教育经历 ${index + 1}`
          : workEntryTitle(allEntryFacts, index);
      return {
        key: `${category}-${index}`,
        index,
        title,
        meta: entryMeta(category, allEntryFacts),
        facts: sortEntryFacts(category, entryFacts)
      };
    });
}

function duplicatesEntryValue(fact: ProfileFact, entries: FactEntry[]): boolean {
  const value = JSON.stringify(fact.value);
  return entries.some((entry) => entry.facts.some((entryFact) => JSON.stringify(entryFact.value) === value));
}

function repeatedEntryIndex(fieldPath: string): number | undefined {
  const segments = fieldPath.split(/[.[\]]/).filter(Boolean);
  if (segments.length < 2 || !/^\d+$/.test(segments[1]!)) return undefined;
  return Number(segments[1]);
}

function workEntryTitle(facts: ProfileFact[], index: number): string {
  const company = factText(facts, ["company"]);
  const title = workRoleText(facts);
  if (company && title) return `${company} · ${title}`;
  return company ?? title ?? `工作 / 实习 ${index + 1}`;
}

function workRoleText(facts: ProfileFact[]): string | undefined {
  const position = factText(facts, ["title", "position", "role"]);
  const employmentType = normalizeEmploymentType(factText(facts, ["employmenttype"]));
  if (!position) return employmentType;
  if (employmentType !== "实习" || position.includes("实习")) return position;
  return position.endsWith("开发") ? `${position.slice(0, -2)}实习` : `${position}实习`;
}

function normalizeEmploymentType(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[-_\s]/g, "").toLowerCase();
  if (["internship", "intern", "实习"].includes(normalized)) return "实习";
  if (["fulltime", "全职"].includes(normalized)) return "全职";
  if (["parttime", "兼职"].includes(normalized)) return "兼职";
  return value;
}

function entryMeta(category: Category, facts: ProfileFact[]): string {
  const start = factText(facts, ["startdate"]);
  const end = factText(facts, ["enddate"]);
  const period = start || end ? `${start ?? "时间未填写"} - ${end ?? "至今"}` : undefined;
  const detail = category === "projects"
    ? factText(facts, ["role", "technologies"])
    : category === "education"
      ? factText(facts, ["degree", "major"])
      : factText(facts, ["location"]);
  return [period, detail].filter(Boolean).join(" · ");
}

function entryCategoryLabel(category: Category): string {
  if (category === "projects") return "项目";
  if (category === "education") return "教育经历";
  return "工作 / 实习";
}

const ENTRY_FIELD_ORDER: Partial<Record<Category, string[]>> = {
  education: ["school", "institution", "degree", "major", "startdate", "enddate", "gpa", "description", "details"],
  work: ["company", "title", "position", "employmenttype", "startdate", "enddate", "location", "description", "summary", "achievements", "highlights"],
  projects: ["name", "title", "startdate", "enddate", "description", "technologies", "keywords", "highlights", "role", "url"]
};

function sortEntryFacts(category: Category, facts: ProfileFact[]): ProfileFact[] {
  const order = ENTRY_FIELD_ORDER[category] ?? [];
  return [...facts].sort((left, right) => {
    const leftRank = fieldOrder(order, fieldLeaf(left.fieldPath));
    const rightRank = fieldOrder(order, fieldLeaf(right.fieldPath));
    return leftRank - rightRank || left.fieldPath.localeCompare(right.fieldPath) || left.id.localeCompare(right.id);
  });
}

function fieldOrder(order: string[], leaf: string): number {
  const index = order.indexOf(leaf);
  return index < 0 ? order.length : index;
}

function factText(facts: ProfileFact[], leaves: string[]): string | undefined {
  for (const leaf of leaves) {
    const fact = facts.find((candidate) => fieldLeaf(candidate.fieldPath) === leaf);
    if (typeof fact?.value === "string" && fact.value.trim()) return fact.value.trim();
    if (Array.isArray(fact?.value)) {
      const values = fact.value.filter((value): value is string => typeof value === "string" && value.trim().length > 0);
      if (values.length > 0) return values.join("、");
    }
  }
  return undefined;
}

function fieldLeaf(fieldPath: string): string {
  const segments = fieldPath.split(/[.[\]]/).filter((segment) => segment && !/^\d+$/.test(segment));
  return (segments.at(-1) ?? fieldPath).replace(/[-_]/g, "").toLowerCase();
}

const FIELD_LABELS: Record<string, string> = {
  name: "姓名", email: "邮箱", phone: "手机号", mobile: "手机号", wechat: "微信",
  city: "城市", address: "地址", location: "所在地", birthdate: "出生日期",
  school: "学校", degree: "学历", major: "专业", gpa: "平均绩点",
  institution: "学校", details: "经历要点", company: "公司", title: "职位", position: "岗位",
  role: "角色", years: "工作年限", employmenttype: "岗位类型", highlights: "要点", keywords: "技术栈",
  startdate: "开始时间", enddate: "结束时间", date: "日期", description: "描述", achievements: "成果",
  languages: "语言", items: "技能项", skills: "技能", technologies: "技术栈",
  portfolio: "作品集", website: "网站", url: "链接", github: "GitHub", linkedin: "LinkedIn",
  summary: "内容", remote: "接受远程", issuer: "颁发机构", credentialid: "证书编号",
  targetrole: "目标职位", targetcity: "目标城市", availability: "到岗时间", salary: "期望薪资"
};

const CATEGORY_FIELD_LABELS: Partial<Record<Category, Record<string, string>>> = {
  education: { institution: "学校", degree: "学历/学位", title: "学历/学位", description: "教育经历描述", details: "在校经历", location: "学校所在地" },
  work: { title: "职位", position: "岗位", description: "工作内容", summary: "工作描述", achievements: "职责和成果", highlights: "职责和成果", location: "工作地点", employmenttype: "岗位类型" },
  projects: { name: "项目名称", title: "项目标题", role: "项目角色", description: "项目描述", technologies: "技术栈", keywords: "技术栈", highlights: "项目要点", url: "项目链接" },
  certificates: { name: "证书名称", title: "证书名称", date: "获证日期", url: "证书链接" },
  preferences: { employmenttype: "求职类型" }
};

function labelFor(fieldPath: string): string {
  const segments = fieldPath.split(/[.[\]]/).filter((segment) => segment && !/^\d+$/.test(segment));
  const leaf = segments.at(-1) ?? fieldPath;
  const normalizedLeaf = leaf.toLowerCase();
  const category = categoryFor(fieldPath);
  if (category === "skills" && segments.length === 1) return "技能";
  return CATEGORY_FIELD_LABELS[category]?.[normalizedLeaf] ?? FIELD_LABELS[normalizedLeaf] ?? "其他字段";
}

function displayValue(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "是" : "否";
  return typeof value === "number" ? String(value) : JSON.stringify(value, null, 2);
}

function displayFactValue(fact: ProfileFact, entryFacts: ProfileFact[]): string {
  if (fieldLeaf(fact.fieldPath) === "employmenttype") {
    return workRoleText(entryFacts) ?? normalizeEmploymentType(typeof fact.value === "string" ? fact.value : undefined) ?? displayValue(fact.value);
  }
  return displayValue(fact.value);
}
