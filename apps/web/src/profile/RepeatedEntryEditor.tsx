import { FIELD_DEFINITIONS, type FieldDefinition, type FieldSection } from "@resume/form-semantics/field-registry";
import { ChevronDown, Plus } from "lucide-react";
import { useMemo, useState } from "react";

export interface RepeatedEntry {
  index: number;
  values: Record<string, string>;
}

interface RepeatedEntryEditorProps {
  section: FieldSection;
  entries: RepeatedEntry[];
  onSave(entryPath: string, values: Record<string, string>): Promise<void>;
}

const SECTION_NAMES: Partial<Record<FieldSection, string>> = {
  education: "教育经历",
  work: "实习与工作经历",
  projects: "项目经历",
  campus: "在校实践",
  awards: "获奖经历",
  publications: "论文与专著",
  certificates: "证书"
};

const FIELD_ORDERS: Partial<Record<FieldSection, readonly string[]>> = {
  projects: ["name", "startDate", "endDate", "description", "technologies", "highlights[0]", "role"],
  work: ["company", "position", "employmentType", "startDate", "endDate", "description"],
  awards: ["name", "date", "level", "description"]
};

const AWARD_LEVELS = ["国家级", "省级", "市级", "校级", "院级", "其他"];

export function RepeatedEntryEditor({ section, entries, onSave }: RepeatedEntryEditorProps) {
  const [draftIndexes, setDraftIndexes] = useState<number[]>([]);
  const fields = useMemo(() => orderedFields(section), [section]);
  const name = SECTION_NAMES[section] ?? "经历";
  const visibleEntries = [
    ...entries.slice().sort((left, right) => left.index - right.index),
    ...draftIndexes.map((index) => ({ index, values: {} }))
  ];

  const addEntry = () => {
    const used = new Set([...entries.map((entry) => entry.index), ...draftIndexes]);
    let index = 0;
    while (used.has(index)) index += 1;
    setDraftIndexes((current) => [...current, index]);
  };

  return (
    <div className="repeated-entry-editor">
      <button className="button secondary add-entry-button" type="button" onClick={addEntry}>
        <Plus aria-hidden="true" size={16} />新增{name}
      </button>
      {visibleEntries.length === 0 ? (
        <p className="profile-section-empty">暂无{name}</p>
      ) : visibleEntries.map((entry) => (
        <EntryForm
          key={`${section}-${entry.index}`}
          section={section}
          index={entry.index}
          fields={fields}
          initialValues={entry.values}
          onSave={async (values) => {
            await onSave(`${section}[${entry.index}]`, values);
            setDraftIndexes((current) => current.filter((index) => index !== entry.index));
          }}
        />
      ))}
    </div>
  );
}

function EntryForm({
  section,
  index,
  fields,
  initialValues,
  onSave
}: {
  section: FieldSection;
  index: number;
  fields: FieldDefinition[];
  initialValues: Record<string, string>;
  onSave(values: Record<string, string>): Promise<void>;
}) {
  const [values, setValues] = useState(initialValues);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const sectionName = SECTION_NAMES[section] ?? "经历";
  const changed = fields.reduce<Record<string, string>>((result, field) => {
    const path = materialize(field.semantic, index);
    const value = values[path] ?? "";
    if (value !== (initialValues[path] ?? "")) result[path] = value;
    return result;
  }, {});

  const save = async () => {
    if (saving || Object.keys(changed).length === 0) return;
    setSaving(true);
    setError(undefined);
    try {
      await onSave(changed);
    } catch {
      setError("保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  return (
    <article className="profile-entry" aria-label={`${sectionName} ${index + 1}`}>
      <header><strong>{entryTitle(section, index, values)}</strong><ChevronDown aria-hidden="true" size={16} /></header>
      <div className="profile-form-grid">
        {fields.map((field) => {
          const path = materialize(field.semantic, index);
          return <ProfileControl key={path} field={field} value={values[path] ?? ""} onChange={(value) => setValues((current) => ({ ...current, [path]: value }))} />;
        })}
      </div>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="profile-entry-actions">
        <button className="button primary" type="button" disabled={saving || Object.keys(changed).length === 0} onClick={() => void save()}>
          {saving ? "保存中" : `保存${sectionName}`}
        </button>
      </div>
    </article>
  );
}

function ProfileControl({ field, value, onChange }: { field: FieldDefinition; value: string; onChange(value: string): void }) {
  const multiline = field.types[0] === "textarea";
  const date = field.types[0] === "date";
  const awardLevel = field.semantic === "awards[].level";
  return (
    <label className={multiline ? "profile-field profile-field-wide" : "profile-field"}>
      <span>{field.label}</span>
      {awardLevel ? (
        <select aria-label={field.label} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">请选择</option>
          {AWARD_LEVELS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : multiline ? (
        <textarea aria-label={field.label} value={value} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input aria-label={field.label} type={date ? "date" : "text"} value={value} onChange={(event) => onChange(event.target.value)} />
      )}
    </label>
  );
}

function orderedFields(section: FieldSection): FieldDefinition[] {
  const fields = FIELD_DEFINITIONS.filter((field) => field.sections.includes(section) && field.semantic.includes("[]"));
  const order = FIELD_ORDERS[section];
  if (!order) return fields;
  return fields.slice().sort((left, right) => fieldOrder(left.semantic, order) - fieldOrder(right.semantic, order));
}

function fieldOrder(semantic: string, order: readonly string[]): number {
  const leaf = semantic.slice(semantic.indexOf("].") + 2);
  const index = order.indexOf(leaf);
  return index === -1 ? order.length : index;
}

function materialize(semantic: string, index: number): string {
  return semantic.replace("[]", `[${index}]`);
}

function entryTitle(section: FieldSection, index: number, values: Record<string, string>): string {
  const candidates: Partial<Record<FieldSection, string[]>> = {
    education: [`education[${index}].institution`, `education[${index}].major`],
    work: [`work[${index}].company`, `work[${index}].position`],
    projects: [`projects[${index}].name`],
    campus: [`campus[${index}].name`],
    awards: [`awards[${index}].name`],
    publications: [`publications[${index}].title`],
    certificates: [`certificates[${index}].name`]
  };
  return candidates[section]?.map((path) => values[path]).find(Boolean) ?? `${SECTION_NAMES[section] ?? "经历"} ${index + 1}`;
}
