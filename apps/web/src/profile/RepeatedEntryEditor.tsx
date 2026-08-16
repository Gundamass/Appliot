import { FIELD_DEFINITIONS, type FieldDefinition, type FieldSection } from "@resume/form-semantics/field-registry";
import { Plus, Trash2 } from "lucide-react";
import { useMemo } from "react";
import { ProfileFieldControl } from "./ProfileFieldControl.js";

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
  onControl?(path: string, control: ProfileControlElement | null): void;
}

type ProfileControlElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const SECTION_NAMES: Partial<Record<FieldSection, string>> = {
  education: "教育经历",
  work: "实习与工作经历",
  projects: "项目经历",
  campus: "在校实践",
  awards: "获奖经历",
  publications: "论文与专著",
  languages: "语言能力",
  certificates: "证书"
};

const FIELD_ORDERS: Partial<Record<FieldSection, readonly string[]>> = {
  projects: ["name", "role", "startDate", "endDate", "technologies", "url", "description", "highlights[0]"],
  work: ["company", "position", "startDate", "endDate", "description", "employmentType"],
  campus: ["name", "role", "startDate", "endDate", "description", "highlights[0]"],
  awards: ["name", "date", "level", "description"],
  languages: ["name", "proficiency", "speakingListening", "readingWriting"]
};

const PROJECT_WIDE_FIELDS = new Set(["technologies", "url", "description", "highlights[0]"]);

export function RepeatedEntryEditor({ section, entries, disabled = false, onChange, onAdd, onRemove, onControl = () => undefined }: RepeatedEntryEditorProps) {
  const fields = useMemo(() => orderedFields(section), [section]);
  const name = SECTION_NAMES[section] ?? "经历";
  const visibleEntries = sortEntries(section, entries);

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
                    section={section}
                    field={field}
                    value={entry.values[path] ?? ""}
                    disabled={disabled}
                    onChange={(value) => onChange({ ...entry.values, [path]: value })}
                    onControl={(control) => onControl(path, control)}
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

function ProfileControl({ section, field, value, disabled, onChange, onControl }: { section: FieldSection; field: FieldDefinition; value: string; disabled: boolean; onChange(value: string): void; onControl(control: ProfileControlElement | null): void }) {
  const wide = field.profileControl === "textarea"
    || section === "projects" && PROJECT_WIDE_FIELDS.has(fieldLeaf(field.semantic));
  return (
    <label className={wide ? "profile-field profile-field-wide" : "profile-field"}>
      <span>{field.label}{field.profileRequired === false && <small>选填</small>}</span>
      <ProfileFieldControl field={field} value={value} disabled={disabled} onChange={onChange} onControl={onControl} />
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
  const leaf = fieldLeaf(semantic);
  const index = order.indexOf(leaf);
  return index === -1 ? order.length : index;
}

function fieldLeaf(semantic: string): string {
  return semantic.slice(semantic.indexOf("].") + 2);
}

function sortEntries(section: FieldSection, entries: RepeatedEntry[]): RepeatedEntry[] {
  if (section !== "projects") return entries.slice().sort((left, right) => left.index - right.index);
  return entries.slice().sort((left, right) => {
    const leftStart = projectDateKey(left, "startDate");
    const rightStart = projectDateKey(right, "startDate");
    if (leftStart !== rightStart) return rightStart - leftStart;
    if (leftStart > 0) {
      const endDifference = projectDateKey(right, "endDate") - projectDateKey(left, "endDate");
      if (endDifference !== 0) return endDifference;
    }
    return left.index - right.index;
  });
}

function projectDateKey(entry: RepeatedEntry, leaf: "startDate" | "endDate"): number {
  const value = entry.values[`projects[${entry.index}].${leaf}`]?.trim();
  if (!value) return 0;
  const match = value.match(/^(\d{4})[-/](\d{1,2})(?:[-/](\d{1,2}))?$/u);
  if (!match) return 0;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3] ?? 1);
  if (month < 1 || month > 12 || day < 1 || day > 31) return 0;
  return year * 10_000 + month * 100 + day;
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
    languages: [`languages[${index}].name`],
    certificates: [`certificates[${index}].name`]
  };
  return candidates[section]?.map((path) => values[path]?.trim()).find(Boolean) ?? `${SECTION_NAMES[section] ?? "经历"} ${index + 1}`;
}
