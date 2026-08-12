import type { FieldDefinition } from "@resume/form-semantics/field-registry";
import type { ChangeEvent } from "react";

type ProfileControlElement = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

interface ProfileFieldControlProps {
  field: FieldDefinition;
  value: string;
  disabled: boolean;
  onChange(value: string): void;
  onFile?: ((file: File) => Promise<string>) | undefined;
  onControl(control: ProfileControlElement | null): void;
}

export function ProfileFieldControl({ field, value, disabled, onChange, onFile, onControl }: ProfileFieldControlProps) {
  const label = field.label;
  const controlProps = {
    "aria-label": label,
    value,
    disabled,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => onChange(event.target.value)
  };

  if (field.profileControl === "boolean" || field.profileControl === "enum") {
    const options = field.profileOptions ?? [];
    const visibleOptions = value && !options.includes(value) ? [...options, value] : options;
    return (
      <select ref={onControl} {...controlProps}>
        <option value="">请选择</option>
        {visibleOptions.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
    );
  }

  if (field.profileControl === "textarea") {
    return <textarea ref={onControl} {...controlProps} />;
  }

  if (field.profileControl === "file") {
    return <input
      ref={onControl}
      aria-label={label}
      disabled={disabled}
      type="file"
      accept="image/jpeg,image/png,image/webp"
      onChange={(event) => {
        const file = event.target.files?.[0];
        if (file && onFile) void onFile(file).then((fileId) => { if (fileId) onChange(fileId); });
        event.currentTarget.value = "";
      }}
    />;
  }

  if (field.profileControl === "suggestion") {
    const listId = `profile-suggestions-${field.semantic.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    return (
      <>
        <input ref={onControl} {...controlProps} type="text" list={listId} />
        <datalist id={listId}>
          {[...(field.profileOptions ?? []), ...suggestionsFor(field.semantic)].filter((option, index, options) => options.indexOf(option) === index).map((option) => <option key={option} value={option} />)}
        </datalist>
      </>
    );
  }

  return <input ref={onControl} {...controlProps} type={field.profileControl === "date" ? "date" : "text"} />;
}

function suggestionsFor(semantic: string): readonly string[] {
  if (semantic.endsWith("currentLocation") || semantic.endsWith("hukouLocation") || semantic.endsWith("targetCity")) {
    return ["北京", "上海", "广州", "深圳", "杭州", "成都", "南京", "武汉", "西安"];
  }
  return [];
}
