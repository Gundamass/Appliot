import type { FormSnapshot } from "@resume/contracts";
import { sendApplicationEvent, type ApplicationActor } from "./application-machine.js";

export interface ChallengeCoordinator {
  pause(actor: ApplicationActor, snapshot: FormSnapshot): Promise<boolean>;
  resume(actor: ApplicationActor): Promise<void>;
}

interface ChallengeCoordinatorDependencies {
  invalidateExecution(taskId: string): Promise<unknown>;
  persist(actor: ApplicationActor, snapshot: FormSnapshot): void;
  observe(taskId: string): Promise<FormSnapshot>;
  continueWithSnapshot(taskId: string, snapshot: FormSnapshot): Promise<void>;
}

export function createChallengeCoordinator(
  dependencies: ChallengeCoordinatorDependencies
): ChallengeCoordinator {
  const pause = async (actor: ApplicationActor, snapshot: FormSnapshot): Promise<boolean> => {
    if (snapshot.challenge === undefined) return false;
    const taskId = actor.getSnapshot().context.taskId;
    await dependencies.invalidateExecution(taskId);
    sendApplicationEvent(actor, { type: "CHALLENGE_DETECTED", challenge: snapshot.challenge });
    dependencies.persist(actor, snapshot);
    return true;
  };

  return {
    pause,

    async resume(actor: ApplicationActor): Promise<void> {
      if (actor.getSnapshot().value !== "awaiting_challenge") {
        throw new Error("challenge_resume_not_allowed");
      }
      const taskId = actor.getSnapshot().context.taskId;
      await dependencies.invalidateExecution(taskId);
      sendApplicationEvent(actor, { type: "USER_RESUME_CHALLENGE" });
      const freshSnapshot = await dependencies.observe(taskId);
      if (await pause(actor, freshSnapshot)) return;
      await dependencies.continueWithSnapshot(taskId, freshSnapshot);
    }
  };
}
