import type { ProfileCompleteness, ProfileFact } from "@resume/contracts";
import {
  FIELD_DEFINITIONS,
  PROFILE_SECTION_DEFINITIONS,
  type FieldDefinition,
  type FieldSection
} from "@resume/form-semantics/field-registry";
import { CheckCircle2, CircleAlert } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ProfileApi } from "../api/client.js";
import type { ProfileSaveState } from "./ProfileSummaryBar.js";
import { RepeatedEntryEditor, type RepeatedEntry } from "./RepeatedEntryEditor.js";

export interface CandidateProfileCenterHandle {
  save(): Promise<void>;
  focusFirstMissing(): void;
}

interface CandidateProfileCenterProps {
  api: ProfileApi;
  facts: ProfileFact[];
  completeness: ProfileCompleteness | undefined;
  onFactsChanged(): void | Promise<void>;
  onSaveStateChange?: ((state: ProfileSaveState) => void) | undefined;
}

type AddedEntryIndexes = Partial<Record<FieldSection, number[]>>;

export const CandidateProfileCenter = forwardRef<CandidateProfileCenterHandle, CandidateProfileCenterProps>(function CandidateProfileCenter(
  { api, facts, completeness, onFactsChanged, onSaveStateChange },
  ref
) {
  const baselineValues = useMemo(() => activeFactValues(facts), [facts]);
  const [draftValues, setDraftValues] = useState<Record<string, string>>(baselineValues);
  const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(() => new Set());
  const [removedPaths, setRemovedPaths] = useState<Set<string>>(() => new Set());
  const draftValuesRef = useRef(draftValues);
  const dirtyPathsRef = useRef(dirtyPaths);
  const removedPathsRef = useRef(removedPaths);
  const savingRef = useRef(false);
  const [activeSection, setActiveSection] = useState<FieldSection>("basics");
  const [addedEntryIndexes, setAddedEntryIndexes] = useState<AddedEntryIndexes>({});
  const [saveError, setSaveError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const sectionProgress = completeness?.sections ?? [];
  const percentage = completeness && Math.round((completeness.completed / Math.max(1, completeness.total)) * 100);
  const saveState: ProfileSaveState = saving ? "saving" : dirtyPaths.size > 0 || removedPaths.size > 0 ? "dirty" : "saved";

  useEffect(() => {
    setDraftValues((current) => {
      const next = { ...baselineValues };
      dirtyPathsRef.current.forEach((path) => {
        if (path in draftValuesRef.current) next[path] = draftValuesRef.current[path] ?? "";
      });
      removedPathsRef.current.forEach((path) => delete next[path]);
      draftValuesRef.current = next;
      return next;
    });
  }, [baselineValues]);

  useEffect(() => {
    onSaveStateChange?.(saveState);
  }, [onSaveStateChange, saveState]);

  const changeValue = useCallback((path: string, value: string) => {
    setDraftValues((current) => {
      const next = { ...current, [path]: value };
      draftValuesRef.current = next;
      return next;
    });
    setDirtyPaths((current) => {
      const next = new Set(current);
      if (value === (baselineValues[path] ?? "")) next.delete(path);
      else next.add(path);
      dirtyPathsRef.current = next;
      return next;
    });
    setSaveError(undefined);
  }, [baselineValues]);

  const saveDrafts = useCallback(async () => {
    if (savingRef.current) return;
    const paths = [...dirtyPathsRef.current];
    const pathsToRemove = [...removedPathsRef.current];
    if (paths.length === 0 && pathsToRemove.length === 0) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(undefined);

    const operations = [
      ...paths.map((path) => ({ kind: "upsert" as const, path, promise: api.upsert(path, draftValuesRef.current[path] ?? "") })),
      ...(pathsToRemove.length > 0 ? [{ kind: "remove" as const, path: undefined, promise: api.remove(pathsToRemove) }] : [])
    ];
    const results = await Promise.allSettled(operations.map((operation) => operation.promise));
    const successfulPaths = operations.flatMap((operation, index) =>
      operation.kind === "upsert" && results[index]?.status === "fulfilled" ? [operation.path] : []
    );
    const removalSucceeded = pathsToRemove.length > 0
      && operations.some((operation, index) => operation.kind === "remove" && results[index]?.status === "fulfilled");
    const succeeded = successfulPaths.length + (removalSucceeded ? 1 : 0);
    const failed = results.length - succeeded;

    setDirtyPaths((current) => {
      const next = new Set(current);
      successfulPaths.forEach((path) => next.delete(path));
      dirtyPathsRef.current = next;
      return next;
    });
    if (removalSucceeded) {
      setRemovedPaths((current) => {
        const next = new Set(current);
        pathsToRemove.forEach((path) => next.delete(path));
        removedPathsRef.current = next;
        return next;
      });
    }
    let refreshFailed = false;
    if (succeeded > 0) {
      setAddedEntryIndexes({});
      try {
        await onFactsChanged();
      } catch {
        refreshFailed = true;
      }
    }
    if (failed > 0) {
      setSaveError(refreshFailed
        ? "部分内容保存失败，且资料刷新失败，请重试"
        : succeeded > 0 ? "部分内容保存失败，请重试" : "档案保存失败，请重试");
    } else if (refreshFailed) {
      setSaveError("档案已保存，但资料刷新失败");
    }
    savingRef.current = false;
    setSaving(false);
  }, [api, onFactsChanged]);

  const focusFirstMissing = useCallback(() => {
    const firstMissing = completeness?.sections.find((section) => section.missing.length > 0)?.id as FieldSection | undefined;
    setActiveSection(firstMissing ?? "basics");
  }, [completeness]);

  useImperativeHandle(ref, () => ({ save: saveDrafts, focusFirstMissing }), [focusFirstMissing, saveDrafts]);

  const activeDefinition = PROFILE_SECTION_DEFINITIONS.find((section) => section.id === activeSection) ?? PROFILE_SECTION_DEFINITIONS[0]!;
  const activeMissing = sectionProgress.find((item) => item.id === activeSection)?.missing ?? [];
  const activeEntries = activeDefinition.repeatable
    ? repeatedEntries(activeSection, draftValues, addedEntryIndexes[activeSection] ?? [])
    : [];

  const addEntry = () => {
    const used = new Set([
      ...activeEntries.map((entry) => entry.index),
      ...repeatedEntries(activeSection, baselineValues, []).map((entry) => entry.index)
    ]);
    let index = 0;
    while (used.has(index)) index += 1;
    setAddedEntryIndexes((current) => ({
      ...current,
      [activeSection]: [...(current[activeSection] ?? []), index]
    }));
  };

  const removeEntry = (index: number) => {
    const fields = repeatedFields(activeSection);
    const paths = fields.map((field) => materialize(field.semantic, index));
    const persisted = paths.some((path) => path in baselineValues);
    if (persisted) {
      setDraftValues((current) => {
        const next = { ...current };
        paths.forEach((path) => delete next[path]);
        draftValuesRef.current = next;
        return next;
      });
      setDirtyPaths((current) => {
        const next = new Set(current);
        paths.forEach((path) => next.delete(path));
        dirtyPathsRef.current = next;
        return next;
      });
      setRemovedPaths((current) => {
        const next = new Set(current);
        paths.forEach((path) => next.add(path));
        removedPathsRef.current = next;
        return next;
      });
    } else {
      setDraftValues((current) => {
        const next = { ...current };
        paths.forEach((path) => delete next[path]);
        draftValuesRef.current = next;
        return next;
      });
      setDirtyPaths((current) => {
        const next = new Set(current);
        paths.forEach((path) => next.delete(path));
        dirtyPathsRef.current = next;
        return next;
      });
    }
    setSaveError(undefined);
    setAddedEntryIndexes((current) => ({
      ...current,
      [activeSection]: (current[activeSection] ?? []).filter((entryIndex) => entryIndex !== index)
    }));
  };

  return (
    <section className="candidate-profile-center" aria-labelledby="candidate-profile-title">
      <header className="profile-center-summary">
        <div>
          <span>长期候选人资料</span>
          <h2 id="candidate-profile-title">完整候选人档案</h2>
          <p>一次补全，后续投递优先精确映射，剩余空字段再进行语义匹配。</p>
        </div>
        <div className="profile-completeness" aria-label={completeness ? `档案完整度 ${percentage}%` : "档案完整度暂不可用"}>
          <strong>{completeness ? `${percentage}%` : "--"}</strong>
          <span>{completeness ? `${completeness.completed}/${completeness.total} 个字段已填写` : "档案完整度暂不可用"}</span>
        </div>
      </header>

      {saveError && <p className="inline-error" role="alert">{saveError}</p>}

      <div className="profile-center-layout">
        <div className="profile-section-navigation" role="group" aria-label="档案栏目">
          {PROFILE_SECTION_DEFINITIONS.map((section) => {
            const progress = sectionProgress.find((item) => item.id === section.id);
            const entries = section.repeatable ? repeatedEntries(section.id, draftValues, addedEntryIndexes[section.id] ?? []) : [];
            const status = completeness === undefined
              ? "未统计"
              : (progress?.missing.length ?? 0) > 0
                ? `缺 ${progress?.missing.length ?? 0}`
                : section.repeatable
                  ? `${entries.length} 条`
                  : `${progress?.completed ?? 0}/${progress?.total ?? 0}`;
            return (
              <button
                key={section.id}
                type="button"
                className={activeSection === section.id ? "active" : ""}
                aria-pressed={activeSection === section.id}
                onClick={() => setActiveSection(section.id)}
              >
                <span>{section.label}</span><small className={(progress?.missing.length ?? 0) > 0 ? "missing" : "complete"}>{status}</small>
              </button>
            );
          })}
        </div>

        <div className="profile-sections">
          <ProfileSection
            section={activeSection}
            label={activeDefinition.label}
            repeatable={activeDefinition.repeatable}
            entries={activeEntries}
            draftValues={draftValues}
            missing={activeMissing}
            completenessAvailable={completeness !== undefined}
            saving={saving}
            onScalarChange={changeValue}
            onEntryChange={(values) => Object.entries(values).forEach(([path, value]) => changeValue(path, value))}
            onAdd={addEntry}
            onRemove={removeEntry}
          />
        </div>
      </div>
    </section>
  );
});

function ProfileSection({
  section,
  label,
  repeatable,
  entries,
  draftValues,
  missing,
  completenessAvailable,
  saving,
  onScalarChange,
  onEntryChange,
  onAdd,
  onRemove
}: {
  section: FieldSection;
  label: string;
  repeatable: boolean;
  entries: RepeatedEntry[];
  draftValues: Record<string, string>;
  missing: string[];
  completenessAvailable: boolean;
  saving: boolean;
  onScalarChange(path: string, value: string): void;
  onEntryChange(values: Record<string, string>): void;
  onAdd(): void;
  onRemove(index: number): void;
}) {
  const fields = FIELD_DEFINITIONS.filter((field) => field.sections.includes(section) && !field.semantic.includes("[]"));
  const filledCount = repeatable ? entries.length : fields.filter((field) => (draftValues[field.semantic] ?? "").trim().length > 0).length;
  return (
    <section className="profile-section" id={`profile-section-${section}`} aria-labelledby={`profile-section-title-${section}`}>
      <header>
        <div>
          <h3 id={`profile-section-title-${section}`}>{label}</h3>
          <p>{!completenessAvailable ? "完整度暂不可用" : missing.length > 0 ? `${missing.length} 个字段建议补全` : `${filledCount} 项资料`}</p>
        </div>
        {!completenessAvailable || missing.length > 0 ? <CircleAlert aria-hidden="true" size={18} /> : <CheckCircle2 aria-hidden="true" size={18} />}
      </header>
      {repeatable ? (
        <RepeatedEntryEditor section={section} entries={entries} disabled={saving} onChange={onEntryChange} onAdd={onAdd} onRemove={onRemove} />
      ) : (
        <div className="profile-form-grid">
          {fields.map((field) => (
            <ScalarField
              key={field.semantic}
              field={field}
              value={draftValues[field.semantic] ?? ""}
              missing={missing.includes(field.semantic)}
              disabled={saving}
              onChange={(value) => onScalarChange(field.semantic, value)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ScalarField({ field, value, missing, disabled, onChange }: { field: FieldDefinition; value: string; missing: boolean; disabled: boolean; onChange(value: string): void }) {
  const multiline = field.types[0] === "textarea";
  const date = field.types[0] === "date";
  const booleanChoice = field.types.includes("checkbox") || field.types.includes("radio");
  return (
    <label className={multiline ? "profile-field profile-field-wide" : "profile-field"}>
      <span>{field.label}{missing && <small>缺失，可减少追问</small>}</span>
      {booleanChoice ? (
        <select aria-label={field.label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}><option value="">请选择</option><option value="是">是</option><option value="否">否</option></select>
      ) : multiline ? (
        <textarea aria-label={field.label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input aria-label={field.label} type={date ? "date" : "text"} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      )}
    </label>
  );
}

function activeFactValues(facts: ProfileFact[]): Record<string, string> {
  const values: Record<string, string> = {};
  facts.filter((fact) => fact.scope === "profile" && fact.status !== "superseded")
    .sort((left, right) => right.revision - left.revision)
    .forEach((fact) => {
      if (!(fact.fieldPath in values)) values[fact.fieldPath] = displayValue(fact.value);
    });
  return values;
}

function repeatedEntries(section: FieldSection, values: Record<string, string>, addedIndexes: number[]): RepeatedEntry[] {
  const entries = new Map<number, Record<string, string>>();
  const pattern = new RegExp(`^${section}\\[(\\d+)\\]\\.`, "u");
  Object.entries(values).forEach(([path, value]) => {
    const match = path.match(pattern);
    if (!match) return;
    const index = Number(match[1]);
    const entry = entries.get(index) ?? {};
    entry[path] = value;
    entries.set(index, entry);
  });
  addedIndexes.forEach((index) => {
    if (!entries.has(index)) entries.set(index, {});
  });
  const added = new Set(addedIndexes);
  return [...entries.entries()]
    .filter(([index, entryValues]) => added.has(index) || Object.values(entryValues).some((value) => value.trim().length > 0))
    .map(([index, entryValues]) => ({ index, values: entryValues }));
}

function repeatedFields(section: FieldSection): FieldDefinition[] {
  return FIELD_DEFINITIONS.filter((field) => field.sections.includes(section) && field.semantic.includes("[]"));
}

function materialize(semantic: string, index: number): string {
  return semantic.replace("[]", `[${index}]`);
}

function displayValue(value: ProfileFact["value"]): string {
  return typeof value === "string" ? value : value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
}
