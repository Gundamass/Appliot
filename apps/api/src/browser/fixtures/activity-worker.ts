process.on("message", (message: unknown) => {
  if (!process.send || typeof message !== "object" || message === null || !("requestId" in message) || !("request" in message)) {
    return;
  }

  const { requestId, request } = message as {
    requestId: string;
    request: {
      type?: string;
    };
  };
  if (request.type === "handshake") {
    process.send({ requestId, response: { type: "ready" } });
    return;
  }
  if (request.type === "capture_snapshot") {
    process.send({
      requestId,
      response: {
        type: "activity",
        activity: { type: "page_changed", taskId: "task-1" }
      }
    });
    process.send({
      response: {
        type: "activity",
        activity: { type: "user_activity", taskId: "task-1", fieldId: "field-1", activity: "input", value: "secret" }
      }
    });
    process.send({
      response: {
        type: "activity",
        activity: { type: "page_stable", taskId: "task-1", fingerprint: "page_fixture" }
      }
    });
    process.send({
      requestId,
      response: {
        type: "snapshot",
        snapshot: {
          id: "snapshot-1",
          taskId: "task-1",
          url: "https://jobs.example.test/apply",
          title: "Fixture",
          stage: "application_form",
          frameRef: { documentId: "document-fixture-00000001", kind: "main" },
          mutationEpoch: 7,
          fields: [],
          actions: [],
          errors: []
        }
      }
    });
    return;
  }
  const jobSnapshot = (current: number, filterState: unknown[] = []) => ({
    id: `job-snapshot-${current}`,
    ownerId: "jm-1",
    url: `https://jobs.example.test/list?page=${current}`,
    title: "Jobs",
    capturedAt: "2026-08-16T00:00:00.000Z",
    entryHint: "job_list",
    visibleText: ["Jobs"],
    jobCards: [],
    filterState,
    pagination: { kind: "page", current, hasNext: current === 1 },
    boundaries: []
  });
  if (request.type === "capture_job_snapshot") {
    process.send({ requestId, response: { type: "job_snapshot", snapshot: jobSnapshot(1) } });
    return;
  }
  if (request.type === "apply_job_filters") {
    const snapshot = jobSnapshot(1, [{ key: "location", values: ["深圳"] }]);
    process.send({
      requestId,
      response: { type: "job_filter_result", ownerId: "jm-1", filterState: snapshot.filterState, snapshot }
    });
    return;
  }
  if (request.type === "advance_job_page") {
    process.send({
      requestId,
      response: { type: "job_page_advanced", ownerId: "jm-1", snapshot: jobSnapshot(2) }
    });
    return;
  }
  if (request.type === "shutdown") {
    process.send({ requestId, response: { type: "stopped" } }, () => process.disconnect());
  }
});
