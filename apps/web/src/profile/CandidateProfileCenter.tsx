import type { ProfileCompleteness, ProfileFact } from "@resume/contracts";
import {
  FIELD_DEFINITIONS,
  PROFILE_SECTION_DEFINITIONS,
  type FieldDefinition,
  type FieldSection
} from "@resume/form-semantics/field-registry";
import { CheckCircle2, CircleAlert, Save } from "lucide-react";
import { useMemo, useState } from "react";
import type { ProfileApi } from "../api/client.js";
import { RepeatedEntryEditor, type RepeatedEntry } from "./RepeatedEntryEditor.js";

interface CandidateProfileCenterProps {
  api: ProfileApi;
  facts: ProfileFact[];
  completeness: ProfileCompleteness;
  onFactsChanged(): void | Promise<void>;
}

export function CandidateProfileCenter({ api, facts, completeness, onFactsChanged }: CandidateProfileCenterProps) {
  const factValues = useMemo(() => activeFactValues(facts), [facts]);
  const percentage = Math.round((completeness.completed / Math.max(1, completeness.total)) * 100);

  const saveValues = async (values: Record<string, string>) => {
    await Promise.all(Object.entries(values).map(([path, value]) => api.upsert(path, value)));
    await onFactsChanged();
  };

  return (
    <section className="candidate-profile-center" aria-labelledby="candidate-profile-title">
      <header className="profile-center-summary">
        <div>
          <span>长期候选人资料</span>
          <h2 id="candidate-profile-title">完整候选人档案</h2>
          <p>一次补全，后续投递优先精确映射，剩余空字段再进行语义匹配。</p>
        </div>
        <div className="profile-completeness" aria-label={`档案完整度 ${percentage}%`}>
          <strong>{percentage}%</strong>
          <span>{completeness.completed}/{completeness.total} 个字段已确认</span>
        </div>
      </header>

      <div className="profile-center-layout">
        <div className="profile-section-navigation" role="group" aria-label="档案栏目">
          {PROFILE_SECTION_DEFINITIONS.map((section) => {
            const progress = completeness.sections.find((item) => item.id === section.id);
            const missing = progress?.missing.length ?? 0;
            return <a key={section.id} href={`#profile-section-${section.id}`}><span>{section.label}</span><small className={missing > 0 ? "missing" : "complete"}>{missing > 0 ? `缺 ${missing}` : "完整"}</small></a>;
          })}
        </div>

        <div className="profile-sections">
          {PROFILE_SECTION_DEFINITIONS.map((section) => (
            <ProfileSection
              key={section.id}
              section={section.id}
              label={section.label}
              repeatable={section.repeatable}
              facts={facts}
              factValues={factValues}
              missing={completeness.sections.find((item) => item.id === section.id)?.missing ?? []}
              onSave={saveValues}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function ProfileSection({
  section,
  label,
  repeatable,
  facts,
  factValues,
  missing,
  onSave
}: {
  section: FieldSection;
  label: string;
  repeatable: boolean;
  facts: ProfileFact[];
  factValues: Map<string, string>;
  missing: string[];
  onSave(values: Record<string, string>): Promise<void>;
}) {
  const fields = FIELD_DEFINITIONS.filter((field) => field.sections.includes(section));
  const entries = repeatable ? repeatedEntries(section, facts) : [];
  return (
    <section className="profile-section" id={`profile-section-${section}`} aria-labelledby={`profile-section-title-${section}`}>
      <header>
        <div><h3 id={`profile-section-title-${section}`}>{label}</h3><p>{missing.length > 0 ? `${missing.length} 个字段建议补全` : "已具备可用资料"}</p></div>
        {missing.length > 0 ? <CircleAlert aria-hidden="true" size={18} /> : <CheckCircle2 aria-hidden="true" size={18} />}
      </header>
      {repeatable ? (
        <RepeatedEntryEditor section={section} entries={entries} onSave={async (_entryPath, values) => onSave(values)} />
      ) : (
        <div className="profile-form-grid">
          {fields.map((field) => (
            <ScalarField
              key={field.semantic}
              field={field}
              value={factValues.get(field.semantic) ?? ""}
              missing={missing.includes(field.semantic)}
              onSave={(value) => onSave({ [field.semantic]: value })}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ScalarField({ field, value, missing, onSave }: { field: FieldDefinition; value: string; missing: boolean; onSave(value: string): Promise<void> }) {
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const multiline = field.types[0] === "textarea";
  const date = field.types[0] === "date";
  const booleanChoice = field.types.includes("checkbox") || field.types.includes("radio");
  const save = async () => {
    if (saving || draft === value) return;
    setSaving(true);
    setError(undefined);
    try {
      await onSave(draft);
    } catch {
      setError("保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };
  return (
    <label className={multiline ? "profile-field profile-field-wide" : "profile-field"}>
      <span>{field.label}{missing && <small>缺失，可减少追问</small>}</span>
      <div className="profile-field-control">
        {booleanChoice ? (
          <select aria-label={field.label} value={draft} onChange={(event) => setDraft(event.target.value)}><option value="">请选择</option><option value="是">是</option><option value="否">否</option></select>
        ) : multiline ? (
          <textarea aria-label={field.label} value={draft} onChange={(event) => setDraft(event.target.value)} />
        ) : (
          <input aria-label={field.label} type={date ? "date" : "text"} value={draft} onChange={(event) => setDraft(event.target.value)} />
        )}
        <button className="icon-button" type="button" aria-label={`保存${field.label}`} title={`保存${field.label}`} disabled={saving || draft === value} onClick={() => void save()}><Save aria-hidden="true" size={16} /></button>
      </div>
      {error && <small className="inline-error" role="alert">{error}</small>}
    </label>
  );
}

function activeFactValues(facts: ProfileFact[]): Map<string, string> {
  const values = new Map<string, string>();
  facts.filter((fact) => fact.scope === "profile" && fact.status !== "superseded")
    .sort((left, right) => right.revision - left.revision)
    .forEach((fact) => {
      if (!values.has(fact.fieldPath)) values.set(fact.fieldPath, displayValue(fact.value));
    });
  return values;
}

function repeatedEntries(section: FieldSection, facts: ProfileFact[]): RepeatedEntry[] {
  const entries = new Map<number, Record<string, string>>();
  const pattern = new RegExp(`^${section}\\[(\\d+)\\]\\.`, "u");
  facts.filter((fact) => fact.scope === "profile" && fact.status !== "superseded").forEach((fact) => {
    const match = fact.fieldPath.match(pattern);
    if (!match) return;
    const index = Number(match[1]);
    const values = entries.get(index) ?? {};
    if (!(fact.fieldPath in values)) values[fact.fieldPath] = displayValue(fact.value);
    entries.set(index, values);
  });
  return [...entries.entries()].map(([index, values]) => ({ index, values }));
}

function displayValue(value: ProfileFact["value"]): string {
  return typeof value === "string" ? value : value === null ? "" : typeof value === "object" ? JSON.stringify(value) : String(value);
}
