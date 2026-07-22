import { JsonValueSchema, type JsonValue, type ProfileFact } from "@resume/contracts";
import { useEffect, useId, useRef, useState } from "react";

interface FactEditorProps {
  fact: ProfileFact;
  fieldLabel: string;
  saving: boolean;
  apiError: string | undefined;
  onCancel(): void;
  onSave(value: JsonValue): Promise<boolean>;
}

export function FactEditor({ fact, fieldLabel, saving, apiError, onCancel, onSave }: FactEditorProps) {
  const inputId = useId();
  const controlRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState(() => serializeValue(fact.value));
  const [booleanDraft, setBooleanDraft] = useState(() => fact.value === true);
  const [validationError, setValidationError] = useState<string>();

  useEffect(() => {
    controlRef.current?.focus();
  }, []);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = parseDraft(fact.value, draft, booleanDraft);
    if (!parsed.success) {
      setValidationError(parsed.message);
      return;
    }
    setValidationError(undefined);
    await onSave(parsed.value);
  };

  const label = `修改 ${fieldLabel}`;
  const structured = fact.value === null || typeof fact.value === "object";
  const multiline = typeof fact.value === "string" && (fact.value.length > 120 || fact.value.includes("\n"));

  return (
    <form className="fact-editor" onSubmit={submit}>
      {typeof fact.value === "boolean" ? (
        <label className="checkbox-field" htmlFor={inputId}>
          <input
            ref={controlRef as React.Ref<HTMLInputElement>}
            id={inputId}
            type="checkbox"
            checked={booleanDraft}
            disabled={saving}
            onChange={(event) => setBooleanDraft(event.target.checked)}
          />
          {label}
        </label>
      ) : structured || multiline ? (
        <label className="editor-field" htmlFor={inputId}>
          <span>{label}</span>
          <textarea
            ref={controlRef as React.Ref<HTMLTextAreaElement>}
            id={inputId}
            aria-label={label}
            rows={structured ? 6 : 4}
            value={draft}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
      ) : (
        <label className="editor-field" htmlFor={inputId}>
          <span>{label}</span>
          <input
            ref={controlRef as React.Ref<HTMLInputElement>}
            id={inputId}
            aria-label={label}
            type={typeof fact.value === "number" ? "number" : "text"}
            value={draft}
            disabled={saving}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
      )}
      {(validationError || apiError) && <p className="inline-error" role="alert">{validationError ?? apiError}</p>}
      <div className="editor-actions">
        <button className="button primary" type="submit" disabled={saving}>{saving ? "保存中" : "保存"}</button>
        <button className="button secondary" type="button" disabled={saving} onClick={onCancel}>取消</button>
      </div>
    </form>
  );
}

function serializeValue(value: JsonValue): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  return JSON.stringify(value, null, 2);
}

type ParsedDraft = { success: true; value: JsonValue } | { success: false; message: string };

function parseDraft(original: JsonValue, draft: string, booleanDraft: boolean): ParsedDraft {
  if (typeof original === "boolean") return { success: true, value: booleanDraft };
  if (typeof original === "string") return { success: true, value: draft };
  if (typeof original === "number") {
    const value = Number(draft);
    return draft.trim() !== "" && Number.isFinite(value)
      ? { success: true, value }
      : { success: false, message: "请输入有效数字" };
  }

  try {
    const value = JSON.parse(draft) as unknown;
    const parsed = JsonValueSchema.safeParse(value);
    return parsed.success
      ? { success: true, value: parsed.data }
      : { success: false, message: "请输入有效的 JSON" };
  } catch {
    return { success: false, message: "请输入有效的 JSON" };
  }
}
