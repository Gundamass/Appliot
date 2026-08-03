import type { ActionClass, FormSnapshot } from "@resume/contracts";

export interface ActionContext {
  text: string;
  stage: FormSnapshot["stage"];
  ariaLabel?: string;
  nearbyText?: string;
}

const TERMINAL_ACTIONS = [
  /提交申请/u,
  /确认投递/u,
  /预览.*提交/u,
  /发送申请/u,
  /立即申请/u,
  /完成申请/u,
  /^完成$/u,
  /submit\s*(application|resume)?/u,
  /apply\s*now/u,
  /confirm\s*(application|submission)/u
];
const SAVE_ACTIONS = [/保存草稿/u, /暂存/u, /save\s*draft/u];
const NEXT_ACTIONS = [/下一步/u, /继续填写/u, /^继续$/u, /^next$/u, /continue/u];
const SECTION_ADD_ACTIONS = [/^添加$/u, /^新增$/u];

export function classifyAction(input: ActionContext): ActionClass {
  const primary = normalizeText(`${input.text} ${input.ariaLabel ?? ""}`);
  const context = normalizeText(`${primary} ${input.nearbyText ?? ""}`);
  if (TERMINAL_ACTIONS.some((pattern) => pattern.test(context))) return "terminal_submit";
  if (SAVE_ACTIONS.some((pattern) => pattern.test(primary))) return "intermediate_save";
  if (input.stage !== "review" && NEXT_ACTIONS.some((pattern) => pattern.test(primary))) {
    return "intermediate_navigation";
  }
  if (input.stage !== "review"
    && SECTION_ADD_ACTIONS.some((pattern) => pattern.test(primary))
    && /教育|实习|工作|项目/u.test(context)) {
    return "intermediate_navigation";
  }
  return "unknown_side_effect";
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("zh-CN");
}
