export type InjectionSource = "external" | "user" | "system";

export interface InjectionInput {
  source: InjectionSource;
  content: string;
}

export interface InjectionDetection {
  source: InjectionSource;
  trusted: boolean;
  detected: boolean;
  score: number;
  signals: string[];
  action: "allow" | "pause" | "block";
}

export interface InjectionDetector {
  detect(input: InjectionInput | string): InjectionDetection;
  markExternalData(content: string): InjectionInput;
}

const MAX_CONTENT_LENGTH = 100_000;
const PATTERNS: readonly [string, RegExp][] = [
  ["instruction_override", /(?:ignore|disregard|forget|override)\s+(?:all\s+)?(?:previous|prior|above|system|developer)\s+instructions?|(?:忽略|无视|忘记|覆盖)(?:掉|了)?(?:之前|先前|上面|此前)?(?:的)?(?:所有)?(?:系统|开发者)?指令/iu],
  ["prompt_exfiltration", /(?:reveal|show|print|leak|expose)\s+(?:the\s+)?(?:system|developer)?\s*prompt|(?:泄露|透露|显示|打印|公开|暴露)(?:出)?(?:系统|开发者)?(?:提示词|提示|指令|prompt)/iu],
  ["tool_manipulation", /(?:call|invoke|execute|use)\s+(?:the\s+)?(?:tool|function|capability|final_submit)|(?:调用|执行|使用|运行)\s*(?:这个|该|所述)?\s*(?:工具|函数|能力|接口|final_submit)/iu],
  ["approval_bypass", /(?:bypass|skip|disable|evade)\s+(?:human|manual|safety|approval|review)|(?:跳过|绕过|规避|禁用|取消)(?:人工|手动)?(?:审批|审核|确认|安全检查)/iu],
  ["role_injection", /(?:^|\n)\s*(?:system|developer|assistant|系统|开发者|助手)\s*[:：]/imu],
  ["secret_request", /(?:password|cookie|access\s*token|api\s*key|credential)\s+(?:is|are|should|must|please)|(?:密码|cookie|访问令牌|API密钥|凭证)(?:是|为|应该|必须|请提供)/iu]
];

export function createInjectionDetector(): InjectionDetector {
  return {
    detect(input) {
      const normalized = typeof input === "string"
        ? { source: "external" as const, content: input }
        : input;
      const content = normalized.content.normalize("NFKC").slice(0, MAX_CONTENT_LENGTH);
      const signals = PATTERNS.filter(([, pattern]) => pattern.test(content)).map(([signal]) => signal);
      const detected = normalized.source === "external" && signals.length > 0;
      const score = Math.min(1, signals.length / 3);
      // Suspicious external content is data, never an instruction. Pause for
      // human security review instead of letting confidence heuristics turn
      // into an automatic permission decision.
      const action = detected ? "pause" : "allow";
      return {
        source: normalized.source,
        trusted: normalized.source !== "external",
        detected,
        score,
        signals,
        action
      };
    },
    markExternalData(content) {
      if (typeof content !== "string") throw new Error("external_content_invalid");
      if (content.length > MAX_CONTENT_LENGTH) throw new Error("external_content_too_large");
      return { source: "external", content };
    }
  };
}
