import type { ProfileFact } from "@resume/contracts";
import {
  JOB_EXPECTATION_FIELDS,
  projectJobExpectations,
  type ProjectedJobExpectation
} from "@resume/job-matching";
import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProfileApi } from "../api/client.js";
import { JobMatchApiError, type JobMatchApi } from "./api.js";

type ProfileExpectationApi = Pick<ProfileApi, "listFacts" | "confirm" | "upsert">;
type JobMatchCreateApi = Pick<JobMatchApi, "create">;
type CanonicalPath = ProjectedJobExpectation["canonicalPath"];

interface JobMatchStartPanelProps {
  profileApi: ProfileExpectationApi;
  jobMatchApi: JobMatchCreateApi;
  onSessionCreated(sessionId: string): void;
  onApplicationForm(applicationUrl: string): void;
  onOpenProfile(): void;
  onBusyChange?(busy: boolean): void;
}

interface ExpectationDraft {
  canonicalPath: CanonicalPath;
  label: string;
  fieldPath?: string;
  factId?: string;
  status?: ProfileFact["status"];
  originalValue: string;
  currentValue: string;
  settled: boolean;
}

type LoadState = "loading" | "ready" | "error";

const ERROR_MESSAGES: Record<string, string> = {
  job_expectation_required: "请先确认至少一项岗位期望",
  browser_task_in_use: "受控浏览器正在处理另一个投递或匹配任务，请先完成当前任务。",
  unsupported_job_entry: "当前仅支持 Moka/Mokahr 中文岗位页和 DJI 招聘路径。"
};

export function JobMatchStartPanel({
  profileApi,
  jobMatchApi,
  onSessionCreated,
  onApplicationForm,
  onOpenProfile,
  onBusyChange
}: JobMatchStartPanelProps) {
  const [drafts, setDrafts] = useState<ExpectationDraft[]>(() => emptyDrafts());
  const [url, setUrl] = useState("");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const targetRoleRef = useRef<HTMLInputElement>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(false);
  const loadGenerationRef = useRef(0);
  const operationGenerationRef = useRef(0);
  const busyRef = useRef(false);

  const loadFacts = useCallback(async (preserveValues = false): Promise<boolean> => {
    const generation = ++loadGenerationRef.current;
    if (!preserveValues) setLoadState("loading");
    try {
      const facts = await profileApi.listFacts();
      if (!mountedRef.current || generation !== loadGenerationRef.current) return false;
      setDrafts((current) => draftsFromFacts(facts, preserveValues ? current : undefined));
      setLoadState("ready");
      if (!preserveValues) setError(undefined);
      return true;
    } catch {
      if (!mountedRef.current || generation !== loadGenerationRef.current) return false;
      if (!preserveValues) {
        setLoadState("error");
        setError("岗位期望加载失败，请重试");
      }
      return false;
    }
  }, [profileApi]);

  useEffect(() => {
    mountedRef.current = true;
    void loadFacts();
    return () => {
      mountedRef.current = false;
      loadGenerationRef.current += 1;
      operationGenerationRef.current += 1;
      busyRef.current = false;
    };
  }, [loadFacts]);

  const updateDraft = (canonicalPath: CanonicalPath, currentValue: string) => {
    setDrafts((current) => current.map((draft) => draft.canonicalPath === canonicalPath
      ? {
          ...draft,
          currentValue,
          settled: isReviewed(draft.status)
            && draft.fieldPath === draft.canonicalPath
            && currentValue.trim() === draft.originalValue
        }
      : draft));
  };

  const submit = async () => {
    if (busyRef.current || loadState !== "ready") return;
    const nonEmpty = drafts.filter((draft) => draft.currentValue.trim() !== "");
    if (nonEmpty.length === 0) {
      setError("请先确认至少一项岗位期望");
      targetRoleRef.current?.focus();
      return;
    }
    const normalizedUrl = url.trim();
    if (!isHttpUrl(normalizedUrl)) {
      setError("请输入有效的 HTTP/HTTPS 招聘链接");
      urlRef.current?.focus();
      return;
    }

    const generation = ++operationGenerationRef.current;
    busyRef.current = true;
    setBusy(true);
    setError(undefined);
    onBusyChange?.(true);
    let phase: "saving" | "creating" = "saving";
    let working = drafts;
    try {
      for (const draft of working) {
        const value = draft.currentValue.trim();
        if (value === "" || draft.settled) continue;
        const saved = shouldConfirm(draft)
          ? await profileApi.confirm(draft.factId!)
          : await profileApi.upsert(draft.canonicalPath, value);
        const settled = settledDraft(draft, saved, value);
        working = working.map((candidate) => candidate.canonicalPath === draft.canonicalPath ? settled : candidate);
        if (mountedRef.current && generation === operationGenerationRef.current) setDrafts(working);
      }
      if (!working.some((draft) => draft.currentValue.trim() !== "" && isReviewed(draft.status))) {
        throw new Error("job_expectation_required");
      }

      phase = "creating";
      const result = await jobMatchApi.create(normalizedUrl);
      if (!mountedRef.current || generation !== operationGenerationRef.current) return;
      if ("redirect" in result) onApplicationForm(result.applicationUrl);
      else onSessionCreated(result.id);
    } catch (caught) {
      if (!mountedRef.current || generation !== operationGenerationRef.current) return;
      const code = caught instanceof JobMatchApiError ? caught.code : caught instanceof Error ? caught.message : undefined;
      if (code === "job_expectation_required") {
        await loadFacts(true);
        if (mountedRef.current && generation === operationGenerationRef.current) {
          setError(ERROR_MESSAGES.job_expectation_required);
        }
      } else {
        setError(code === undefined
          ? phase === "saving" ? "岗位期望保存失败，请重试" : "岗位匹配创建失败，请重试"
          : ERROR_MESSAGES[code] ?? (phase === "saving" ? "岗位期望保存失败，请重试" : "岗位匹配创建失败，请重试"));
      }
    } finally {
      if (generation === operationGenerationRef.current) {
        busyRef.current = false;
        if (mountedRef.current) {
          setBusy(false);
          onBusyChange?.(false);
        }
      }
    }
  };

  return <section className="job-match-start job-match-start-panel" aria-labelledby="job-match-start-title">
    <div className="job-match-start__heading">
      <div>
        <h2 id="job-match-start-title">岗位匹配</h2>
        <p>岗位期望</p>
      </div>
      <button type="button" onClick={onOpenProfile} disabled={busy}>打开候选人档案</button>
    </div>

    {loadState === "error" && <div className="job-match-start__load-error">
      <p role="alert">岗位期望加载失败，请重试</p>
      <button type="button" onClick={() => void loadFacts()} disabled={busy}>
        <RefreshCw size={16} aria-hidden="true" />
        重试
      </button>
    </div>}

    <div className="job-match-start__fields job-match-expectation-grid" aria-busy={loadState === "loading"}>
      {drafts.map((draft, index) => <label key={draft.canonicalPath}>
        <span>{draft.label}</span>
        <input
          ref={index === 0 ? targetRoleRef : undefined}
          aria-label={draft.label}
          value={draft.currentValue}
          onChange={(event) => updateDraft(draft.canonicalPath, event.target.value)}
          disabled={busy || loadState !== "ready"}
        />
        {draft.status === "extracted" && <small>来自简历，待确认</small>}
        {isReviewed(draft.status) && <small>已确认</small>}
      </label>)}
    </div>

    <label className="job-match-start__url">
      <span>招聘链接</span>
      <input
        ref={urlRef}
        type="url"
        value={url}
        onChange={(event) => setUrl(event.target.value)}
        disabled={busy || loadState !== "ready"}
      />
    </label>
    {error !== undefined && loadState !== "error" && <p role="alert">{error}</p>}
    <button type="button" onClick={() => void submit()} disabled={busy || loadState !== "ready"}>
      <Search size={17} aria-hidden="true" />
      {busy ? "正在创建匹配" : "确认岗位期望并开始匹配"}
    </button>
  </section>;
}

function emptyDrafts(): ExpectationDraft[] {
  return JOB_EXPECTATION_FIELDS.map((field) => ({
    canonicalPath: field.canonicalPath,
    label: field.label,
    originalValue: "",
    currentValue: "",
    settled: false
  }));
}

function draftsFromFacts(facts: readonly ProfileFact[], current?: readonly ExpectationDraft[]): ExpectationDraft[] {
  const projected = new Map(projectJobExpectations(facts).map((item) => [item.canonicalPath, item]));
  return JOB_EXPECTATION_FIELDS.map((field) => {
    const source = projected.get(field.canonicalPath);
    const sourceValue = source?.values.join("、") ?? "";
    const existing = current?.find((draft) => draft.canonicalPath === field.canonicalPath);
    const currentValue = existing?.currentValue ?? sourceValue;
    return {
      canonicalPath: field.canonicalPath,
      label: field.label,
      ...(source === undefined ? {} : {
        fieldPath: source.fieldPath,
        factId: source.factId,
        status: source.status
      }),
      originalValue: sourceValue,
      currentValue,
      settled: source !== undefined
        && isReviewed(source.status)
        && source.fieldPath === field.canonicalPath
        && currentValue.trim() === sourceValue
    };
  });
}

function shouldConfirm(draft: ExpectationDraft): boolean {
  return draft.status === "extracted"
    && draft.fieldPath === draft.canonicalPath
    && draft.factId !== undefined
    && draft.currentValue.trim() === draft.originalValue;
}

function settledDraft(draft: ExpectationDraft, fact: ProfileFact, value: string): ExpectationDraft {
  return {
    ...draft,
    fieldPath: fact.fieldPath,
    factId: fact.id,
    status: fact.status,
    originalValue: value,
    currentValue: value,
    settled: isReviewed(fact.status) && fact.fieldPath === draft.canonicalPath
  };
}

function isReviewed(status: ProfileFact["status"] | undefined): boolean {
  return status === "user_confirmed" || status === "user_corrected";
}

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
