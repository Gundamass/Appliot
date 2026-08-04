import { FIELD_DEFINITIONS, type FieldDefinition, type FieldSection } from "@resume/form-semantics/field-registry";
import { Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";

export interface RepeatedEntry {
  index: number;
  values: Record<string, string>;
}

interface RepeatedEntryEditorProps {
  section: FieldSection;
  entries: RepeatedEntry[];
  disabled?: boolean;
  onChange(values: Record<string, string>): void;
  onAdd(): void;
  onRemove(index: number): void;
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
  work: ["company", "position", "startDate", "endDate", "description", "employmentType"],
  awards: ["name", "date", "level", "description"]
};

const AWARD_LEVELS = ["国家级", "省级", "市级", "校级", "院级", "其他"];

export function RepeatedEntryEditor({ section, entries, disabled = false, onChange, onAdd, onRemove }: RepeatedEntryEditorProps) {
  const fields = useMemo(() => orderedFields(section), [section]);
  const name = SECTION_NAMES[section] ?? "经历";
  const visibleEntries = entries.slice().sort((left, right) => left.index - right.index);

  return (
    <div className="repeated-entry-editor">
      <button className="button secondary add-entry-button" type="button" disabled={disabled} onClick={onAdd}>
        <Plus aria-hidden="true" size={16} />新增{name}
      </button>
      {visibleEntries.length === 0 ? (
        <p className="profile-section-empty">暂无{name}</p>
      ) : visibleEntries.map((entry) => {
        const title = entryTitle(section, entry.index, entry.values);
        return (
          <article className="profile-entry" aria-label={title} key={`${section}-${entry.index}`}>
            <header>
              <strong>{title}</strong>
              <button
                className="icon-button"
                type="button"
                aria-label={`删除${name}`}
                title={`删除${name}`}
                disabled={disabled}
                onClick={() => onRemove(entry.index)}
              >
                <Trash2 aria-hidden="true" size={16} />
              </button>
            </header>
            <div className="profile-form-grid">
              {fields.map((field) => {
                const path = materialize(field.semantic, entry.index);
                return (
                  <ProfileControl
                    key={path}
                    field={field}
                    value={entry.values[path] ?? ""}
                    disabled={disabled}
                    onChange={(value) => onChange({ ...entry.values, [path]: value })}
                  />
                );
              })}
            </div>
          </article>
        );
      })}
    </div>
  );
}

function ProfileControl({ field, value, disabled, onChange }: { field: FieldDefinition; value: string; disabled: boolean; onChange(value: string): void }) {
  const multiline = field.types[0] === "textarea";
  const date = field.types[0] === "date";
  const booleanChoice = field.types.includes("checkbox") || field.types.includes("radio");
  const awardLevel = field.semantic === "awards[].level";
  return (
    <label className={multiline ? "profile-field profile-field-wide" : "profile-field"}>
      <span>{field.label}</span>
      {awardLevel ? (
        <select aria-label={field.label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          <option value="">请选择</option>
          {AWARD_LEVELS.map((option) => <option key={option} value={option}>{option}</option>)}
        </select>
      ) : booleanChoice ? (
        <select aria-label={field.label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
          <option value="">请选择</option><option value="是">是</option><option value="否">否</option>
        </select>
      ) : multiline ? (
        <textarea aria-label={field.label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <input aria-label={field.label} type={date ? "date" : "text"} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
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
  return candidates[section]?.map((path) => values[path]?.trim()).find(Boolean) ?? `${SECTION_NAMES[section] ?? "经历"} ${index + 1}`;
}
