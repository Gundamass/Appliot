import { createHash } from "node:crypto";
import {
  BrowserObservationSchema,
  BrowserNodeRefSchema,
  type BrowserNodeRef,
  type BrowserObservation
} from "../agents/specialist-agent.js";

export interface BrowserObserverPort {
  observe(taskId: string, executionEpoch: number): Promise<BrowserObservation>;
}

export interface BrowserObservationBinding {
  readonly snapshotId: string;
  readonly executionEpoch: number;
  readonly targetFingerprint: string;
  readonly nodeRef: BrowserNodeRef;
}

export type BrowserObservationValidation =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason:
        | "stale_observation"
        | "stale_execution_epoch"
        | "target_fingerprint_mismatch"
        | "stale_node_ref";
    };

export interface BrowserObserver extends BrowserObserverPort {
  validate(observation: BrowserObservation, binding: BrowserObservationBinding): BrowserObservationValidation;
  assertFresh(observation: BrowserObservation, binding: BrowserObservationBinding): void;
  observationRef(observation: BrowserObservation, taskId: string): {
    readonly id: string;
    readonly kind: "browser";
    readonly sourceRef: string;
    readonly contentHash: string;
    readonly snapshotId: string;
    readonly executionEpoch: number;
    readonly createdAt: string;
  };
}

export function createBrowserObserver(
  port: BrowserObserverPort,
  options: { readonly now?: () => string } = {}
): BrowserObserver {
  const now = options.now ?? (() => new Date().toISOString());
  return {
    async observe(taskId, executionEpoch) {
      const observed = BrowserObservationSchema.parse(await port.observe(taskId, executionEpoch));
      if (observed.executionEpoch !== executionEpoch) throw new Error("stale_execution_epoch");
      return observed;
    },
    validate(observation, binding) {
      const parsed = BrowserObservationSchema.parse(observation);
      const nodeRef = BrowserNodeRefSchema.parse(binding.nodeRef);
      if (binding.executionEpoch !== parsed.executionEpoch) return { valid: false, reason: "stale_execution_epoch" };
      if (binding.snapshotId !== parsed.snapshotId) return { valid: false, reason: "stale_observation" };
      if (binding.targetFingerprint !== parsed.targetFingerprint) {
        return { valid: false, reason: "target_fingerprint_mismatch" };
      }
      if (!parsed.nodeRefs.some((candidate) => stableEqual(candidate, nodeRef))) {
        return { valid: false, reason: "stale_node_ref" };
      }
      return { valid: true };
    },
    assertFresh(observation, binding) {
      const result = this.validate(observation, binding);
      if (!result.valid) throw new Error(result.reason);
    },
    observationRef(observation, taskId) {
      const parsed = BrowserObservationSchema.parse(observation);
      const sourceRef = `browser:${taskId}:snapshot:${parsed.snapshotId}`;
      const contentHash = createHash("sha256").update(JSON.stringify({
        taskId,
        snapshotId: parsed.snapshotId,
        executionEpoch: parsed.executionEpoch,
        targetFingerprint: parsed.targetFingerprint
      })).digest("hex");
      return {
        id: `observation:${contentHash}`,
        kind: "browser" as const,
        sourceRef,
        contentHash,
        snapshotId: parsed.snapshotId,
        executionEpoch: parsed.executionEpoch,
        createdAt: now()
      };
    }
  };
}

function stableEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
