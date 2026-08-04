import { SelfEvaluationReviewSchema, type AdapterId, type AdapterStatus, type ProfileCompleteness, type ProfileDocumentSummary, type ProfileFact, type SelfEvaluationReview as SelfEvaluationReviewModel } from "@resume/contracts";
import { FileText, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProfileApi, RagApi, SelfEvaluationReviewApi } from "../api/client.js";
import type { HealthApi } from "../api/health-client.js";
import { SelfEvaluationReview } from "../reviews/SelfEvaluationReview.js";
import { RagWorkspace } from "../rag/RagWorkspace.js";
import { ServiceStatus } from "../health/ServiceStatus.js";
import { CandidateProfileCenter, type CandidateProfileCenterHandle } from "./CandidateProfileCenter.js";
import { ProfileSummaryBar, type ProfileSaveState } from "./ProfileSummaryBar.js";
import { ResumeParsePanel } from "./ResumeParsePanel.js";

type UploadState = "idle" | "uploading" | "accepted_refreshing" | "success" | "accepted_refresh_error" | "error";
type ReadResult = "success" | "error" | "stale";
type AcceptedUploadPhase = "none" | "refreshing" | "error" | "success";

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
  const [selectedFile, setSelectedFile] = useState<File>();
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [uploadMessage, setUploadMessage] = useState<string>();
  const contextGeneration = useRef(0);
  const readGeneration = useRef(0);
  const completenessReadGeneration = useRef(0);
  const latestDocumentReadGeneration = useRef(0);
  const operationSequence = useRef(0);
  const uploadOwner = useRef<number | null>(null);
  const acceptedUploadOwner = useRef<number | null>(null);
  const acceptedUploadPhase = useRef<AcceptedUploadPhase>("none");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const profileCenterRef = useRef<CandidateProfileCenterHandle>(null);
  const [profileSaveState, setProfileSaveState] = useState<ProfileSaveState>("saved");
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

  const loadFacts = useCallback(async (): Promise<ReadResult> => {
    if (acceptedUploadPhase.current === "refreshing") return "stale";
    return requestFacts(api, contextGeneration.current, true);
  }, [api, requestFacts]);

  const loadCompleteness = useCallback(async (
    requestApi: ProfileApi = api,
    context: number = contextGeneration.current
  ): Promise<ReadResult> => {
    const request = ++completenessReadGeneration.current;
    try {
      const nextCompleteness = await requestApi.getCompleteness();
      if (!isCurrentContext(context) || completenessReadGeneration.current !== request) return "stale";
      setCompleteness(nextCompleteness);
      return "success";
    } catch {
      if (!isCurrentContext(context) || completenessReadGeneration.current !== request) return "stale";
      setCompleteness(undefined);
      return "error";
    }
  }, [api, isCurrentContext]);

  const loadLatestDocument = useCallback(async (
    requestApi: ProfileApi = api,
    context: number = contextGeneration.current
  ) => {
    const request = ++latestDocumentReadGeneration.current;
    try {
      const document = await requestApi.getLatestDocument();
      if (!isCurrentContext(context) || latestDocumentReadGeneration.current !== request) return;
      setLatestDocument(document);
    } catch {
      if (!isCurrentContext(context) || latestDocumentReadGeneration.current !== request) return;
      setLatestDocument(undefined);
    }
  }, [api, isCurrentContext]);

  useEffect(() => {
    const context = ++contextGeneration.current;
    readGeneration.current += 1;
    completenessReadGeneration.current += 1;
    latestDocumentReadGeneration.current += 1;
    uploadOwner.current = null;
    acceptedUploadOwner.current = null;
    acceptedUploadPhase.current = "none";
    setFacts([]);
    setCompleteness(undefined);
    setLatestDocument(undefined);
    setLoading(true);
    setLoadError(false);
    setSelectedFile(undefined);
    setUploadState("idle");
    setUploadMessage(undefined);
    if (fileInputRef.current) fileInputRef.current.value = "";
    void requestFacts(api, context, true);
    void loadCompleteness(api, context);
    void loadLatestDocument(api, context);
    return () => {
      if (contextGeneration.current === context) contextGeneration.current += 1;
      readGeneration.current += 1;
      completenessReadGeneration.current += 1;
      latestDocumentReadGeneration.current += 1;
      uploadOwner.current = null;
      acceptedUploadOwner.current = null;
      acceptedUploadPhase.current = "none";
    };
  }, [api, loadCompleteness, loadLatestDocument, requestFacts]);

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
    if (!selectedFile || uploadOwner.current !== null || acceptedUploadPhase.current === "refreshing") return;
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
      void loadLatestDocument(api, context);
      void refreshAcceptedUpload(owner, context, api);
    } catch {
      if (!isCurrentContext(context) || uploadOwner.current !== owner) return;
      setUploadState("error");
      setUploadMessage("上传失败，请检查文件后重试");
      acceptedUploadPhase.current = "none";
      uploadOwner.current = null;
    }
  };

  const uploading = uploadState === "uploading";
  const acceptedRefreshing = uploadState === "accepted_refreshing";
  const controlsLocked = uploading || acceptedRefreshing;
  const deepseek = adapterStatus("deepseek");
  const deepseekAvailable = healthApi === undefined || deepseek?.state === "configured" || deepseek?.state === "ready";
  const ocr = adapterStatus("ocr");
  const embedding = adapterStatus("embedding");
  const candidateName = factText(facts, ["name"]) ?? "候选人";
  const targetRole = factText(facts, ["targetrole"]);
  const missingCount = completeness?.sections.reduce((total, section) => total + section.missing.length, 0) ?? 0;

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
        {!embedded && <nav className="view-switch" aria-label="工作区视图">
          <button type="button" aria-pressed={view === "profile"} onClick={() => setView("profile")}>候选人档案</button>
          <button type="button" aria-pressed={view === "self-evaluation"} onClick={() => setView("self-evaluation")}>自我评价审核</button>
          <button type="button" aria-pressed={view === "rag"} onClick={() => setView("rag")}>字段检索</button>
        </nav>}
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
          saveState={profileSaveState}
          onSave={() => { void profileCenterRef.current?.save(); }}
          onOpenParser={() => setParseOpen(true)}
          onFillMissing={() => profileCenterRef.current?.focusFirstMissing()}
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
              onClick={() => { void loadFacts(); void loadCompleteness(api, contextGeneration.current); void refreshAdapterStatuses(); void loadLatestDocument(api, contextGeneration.current); }}
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
        {loading ? (
          <div className="state-panel" role="status" aria-label="资料加载状态"><span className="spinner" />正在加载资料</div>
        ) : loadError ? (
          <div className="state-panel error-state" role="alert">
            <strong>资料加载失败</strong>
            <button className="button secondary" type="button" onClick={() => void loadFacts()}>重新加载</button>
          </div>
        ) : (
          <CandidateProfileCenter
            ref={profileCenterRef}
            api={api}
            facts={facts}
            completeness={completeness}
            onSaveStateChange={setProfileSaveState}
            onFactsChanged={async () => {
              const context = contextGeneration.current;
              const [factsResult, completenessResult] = await Promise.all([
                requestFacts(api, context, false),
                loadCompleteness(api, context)
              ]);
              if (factsResult === "error" || completenessResult === "error") throw new Error("profile refresh failed");
            }}
          />
        )}
        </>}
      </main>
    </div>
  );
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
