import type { ApplicationService } from "./application-service.js";
import type { ApplicationTaskRepository } from "./application-task-repository.js";

export interface ApplicationServiceRouterDependencies {
  taskRepository: ApplicationTaskRepository;
  legacy: ApplicationService;
  graph: ApplicationService;
}

/**
 * A persisted ownership marker is the only routing authority during the
 * coexistence window. It prevents a process restart from accidentally moving
 * an in-flight XState task onto a graph checkpoint, or vice versa.
 */
export function createApplicationServiceRouter(
  dependencies: ApplicationServiceRouterDependencies
): ApplicationService {
  // A few internal callers predate persisted task ownership. Keep those
  // process-local starts on XState for the bounded coexistence window.
  const directLegacyTaskIds = new Set<string>();

  const serviceFor = (taskId: string): ApplicationService => {
    const task = dependencies.taskRepository.get(taskId);
    if (task === undefined || directLegacyTaskIds.has(taskId)) return dependencies.legacy;
    return task.orchestrator === "langgraph-v1" ? dependencies.graph : dependencies.legacy;
  };

  return {
    start(input) {
      if (dependencies.taskRepository.get(input.taskId) === undefined) {
        directLegacyTaskIds.add(input.taskId);
      }
      serviceFor(input.taskId).start(input);
    },
    activeBrowserTaskId() {
      return dependencies.graph.activeBrowserTaskId() ?? dependencies.legacy.activeBrowserTaskId();
    },
    state(taskId) {
      return serviceFor(taskId).state(taskId);
    },
    requiresRecovery(taskId) {
      return serviceFor(taskId).requiresRecovery(taskId);
    },
    openBrowser(taskId) {
      return serviceFor(taskId).openBrowser(taskId);
    },
    resume(taskId) {
      return serviceFor(taskId).resume(taskId);
    },
    resumeAfterChallenge(taskId) {
      return serviceFor(taskId).resumeAfterChallenge(taskId);
    },
    resumeWithProfile(taskId) {
      return serviceFor(taskId).resumeWithProfile(taskId);
    },
    async refreshFromProfile() {
      await dependencies.legacy.refreshFromProfile();
      await dependencies.graph.refreshFromProfile();
    },
    syncTaskFromProfile(taskId) {
      return serviceFor(taskId).syncTaskFromProfile(taskId);
    },
    answerQuestions(taskId, answers) {
      return serviceFor(taskId).answerQuestions(taskId, answers);
    },
    contentReview(taskId) {
      return serviceFor(taskId).contentReview(taskId);
    },
    fieldCoverage(taskId) {
      return serviceFor(taskId).fieldCoverage(taskId);
    },
    approveReview(taskId, reviewId, editedValue) {
      return serviceFor(taskId).approveReview(taskId, reviewId, editedValue);
    },
    rejectReview(taskId, reviewId) {
      return serviceFor(taskId).rejectReview(taskId, reviewId);
    },
    cancel(taskId) {
      return serviceFor(taskId).cancel(taskId);
    },
    dispose(taskId) {
      const service = serviceFor(taskId);
      const result = service.dispose(taskId);
      directLegacyTaskIds.delete(taskId);
      return result;
    },
    runUntilPause(taskId, initialSnapshot) {
      return serviceFor(taskId).runUntilPause(taskId, initialSnapshot);
    },
    requestIntermediateClick(taskId, actionId) {
      return serviceFor(taskId).requestIntermediateClick(taskId, actionId);
    },
    progress(taskId) {
      return serviceFor(taskId).progress(taskId);
    },
    recoveryCommands(taskId) {
      return serviceFor(taskId).recoveryCommands(taskId);
    },
    handleActivity(activity) {
      return serviceFor(activity.taskId).handleActivity(activity);
    },
    retryCurrent(taskId) {
      return serviceFor(taskId).retryCurrent(taskId);
    },
    manualDone(taskId) {
      return serviceFor(taskId).manualDone(taskId);
    }
  };
}
