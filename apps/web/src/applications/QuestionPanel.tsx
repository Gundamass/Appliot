import type { ApplicationQuestion, JsonValue } from "@resume/contracts";
import { CircleHelp, Database, MoveRight } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

export interface QuestionAnswerInput {
  id: string;
  value: JsonValue;
  scope: "application";
}

export interface QuestionSubmission {
  answers: QuestionAnswerInput[];
  promoteFieldPaths: string[];
}

interface QuestionPanelProps {
  questions: ApplicationQuestion[];
  busy: boolean;
  onSubmit(submission: QuestionSubmission): void | Promise<void>;
}

export function QuestionPanel({ questions, busy, onSubmit }: QuestionPanelProps) {
  const [values, setValues] = useState<Record<string, JsonValue>>({});
  const [promotions, setPromotions] = useState<Record<string, boolean>>({});
  const questionSignature = useMemo(() => JSON.stringify(questions.map((question) => ({
    id: question.id,
    fieldPath: question.fieldPath,
    label: question.label,
    text: question.text,
    pageText: question.pageText,
    interpretation: question.interpretation,
    missingInformation: question.missingInformation,
    scope: question.scope,
    inputType: question.inputType,
    options: question.options,
    required: question.required
  }))), [questions]);

  useEffect(() => {
    setValues(Object.fromEntries(questions.map((question) => [
      question.id,
      question.inputType === "checkbox" ? false : ""
    ])));
    setPromotions({});
  }, [questionSignature]);

  const complete = useMemo(() => questions.every((question) => {
    if (!question.required || question.inputType === "checkbox") return true;
    const value = values[question.id];
    return typeof value === "string" && value.trim() !== "";
  }), [questions, values]);

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!complete || busy) return;
    void onSubmit({
      answers: questions.map((question) => ({
        id: question.id,
        value: values[question.id] ?? (question.inputType === "checkbox" ? false : ""),
        scope: "application" as const
      })),
      promoteFieldPaths: questions
        .filter((question) => question.fieldPath && promotions[question.id])
        .map((question) => question.fieldPath!)
    });
  };

  return (
    <section className="question-panel" aria-labelledby="question-panel-title">
      <header>
        <div className="review-section-icon"><CircleHelp aria-hidden="true" size={19} /></div>
        <div><h2 id="question-panel-title">补充当前页面信息</h2><p>这些回答默认只用于本次投递。</p></div>
        <span>{questions.length} 项</span>
      </header>
      <form onSubmit={submit}>
        <div className="question-list">
          {questions.map((question, index) => (
            <article className="question-item" key={question.id}>
              <div className="question-index">{String(index + 1).padStart(2, "0")}</div>
              <div className="question-body">
                <label className={question.inputType === "checkbox" ? "question-checkbox" : "question-field"}>
                  <span>{question.label ?? question.text}</span>
                  {question.inputType !== "checkbox" && <small>{question.text}</small>}
                  <dl className="question-context">
                    <div><dt>页面原文</dt><dd>{question.pageText}</dd></div>
                    <div><dt>系统理解</dt><dd>{question.interpretation}</dd></div>
                    <div><dt>需要补充</dt><dd>{question.missingInformation}</dd></div>
                  </dl>
                  <QuestionControl
                    question={question}
                    value={values[question.id] ?? ""}
                    disabled={busy}
                    label={question.label ?? question.text}
                    onChange={(value) => setValues((current) => ({ ...current, [question.id]: value }))}
                  />
                </label>
                {question.fieldPath && <label className="promotion-control">
                  <input
                    type="checkbox"
                    checked={promotions[question.id] ?? false}
                    disabled={busy}
                    aria-label={`将“${question.label ?? question.text}”保存为长期资料`}
                    onChange={(event) => setPromotions((current) => ({ ...current, [question.id]: event.target.checked }))}
                  />
                  <Database aria-hidden="true" size={14} />保存为长期资料
                </label>}
              </div>
            </article>
          ))}
        </div>
        <div className="question-submit-row">
          <span>未勾选的答案不会影响其他投递。</span>
          <button className="button primary" type="submit" disabled={!complete || busy}>
            {busy ? "处理中" : "继续填写"}<MoveRight aria-hidden="true" size={16} />
          </button>
        </div>
      </form>
    </section>
  );
}

function QuestionControl({ question, value, disabled, label, onChange }: {
  question: ApplicationQuestion;
  value: JsonValue;
  disabled: boolean;
  label: string;
  onChange(value: JsonValue): void;
}) {
  if (question.inputType === "checkbox") {
    return <input aria-label={label} type="checkbox" checked={value === true} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />;
  }
  if (question.inputType === "textarea") {
    return <textarea aria-label={label} required={question.required} value={typeof value === "string" ? value : ""} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
  }
  if (question.inputType === "select") {
    return <select aria-label={label} required={question.required} value={typeof value === "string" ? value : ""} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">请选择</option>
      {question.options.map((option) => <option key={option} value={option}>{option}</option>)}
    </select>;
  }
  return <input aria-label={label} type={question.inputType === "date" ? "date" : "text"} required={question.required} value={typeof value === "string" ? value : ""} disabled={disabled} onChange={(event) => onChange(event.target.value)} />;
}
