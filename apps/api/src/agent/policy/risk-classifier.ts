import type { CapabilityDescriptor, CapabilityRisk } from "@resume/contracts";
import type { InjectionDetection } from "./injection-detector.js";

export interface RiskClassification {
  risk: CapabilityRisk;
  requiresApproval: boolean;
  signals: string[];
}

export interface RiskClassifier {
  classify(input: {
    descriptor: CapabilityDescriptor;
    value: unknown;
    injection?: InjectionDetection;
  }): RiskClassification;
}

export function createRiskClassifier(): RiskClassifier {
  return {
    classify({ descriptor, value, injection }) {
      const signals: string[] = [];
      let risk = descriptor.risk;
      if (descriptor.sideEffect === "irreversible" && risk !== "irreversible") {
        risk = "irreversible";
        signals.push("irreversible_side_effect");
      } else if (descriptor.sideEffect === "external" && risk === "low") {
        risk = "high";
        signals.push("external_side_effect");
      }
      if (descriptor.name === "final_submit") {
        risk = "irreversible";
        signals.push("final_submit");
      }
      if (injection?.detected === true) {
        signals.push(...injection.signals.map((signal) => `injection:${signal}`));
        if (injection.action === "block") risk = "irreversible";
        else if (risk === "low" || risk === "medium") risk = "high";
      }
      if (isExplicitHighRisk(value)) {
        signals.push("high_risk_input");
        if (risk === "low") risk = "high";
      }
      return {
        risk,
        requiresApproval: descriptor.requiresApproval || risk === "high" || risk === "irreversible",
        signals
      };
    }
  };
}

function isExplicitHighRisk(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.risk === "high"
    || record.risk === "irreversible"
    || record.requiresApproval === true;
}
