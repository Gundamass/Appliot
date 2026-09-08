import type { ApplicationService } from "./application-service.js";
import type { ApplicationTaskRepository } from "./application-task-repository.js";

export interface ApplicationServiceRouterDependencies {
  taskRepository: ApplicationTaskRepository;
  legacy: ApplicationService;
  graph: ApplicationService;
}

/**
 * Compatibility facade retained for callers that still import the old module.
 * Runtime is the only production service; all task operations delegate to the
 * supplied Runtime-backed service.
 */
export function createApplicationServiceRouter(
  dependencies: ApplicationServiceRouterDependencies
): ApplicationService {
  const serviceFor = (_taskId: string): ApplicationService => dependencies.graph;

  return {
    start(input) {
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
