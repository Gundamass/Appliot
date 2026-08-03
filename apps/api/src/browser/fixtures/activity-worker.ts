process.on("message", (message: unknown) => {
  if (!process.send || typeof message !== "object" || message === null || !("requestId" in message) || !("request" in message)) {
    return;
  }

  const { requestId, request } = message as { requestId: string; request: { type?: string } };
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
          fields: [],
          actions: [],
          errors: []
        }
      }
    });
    return;
  }
  if (request.type === "shutdown") {
    process.send({ requestId, response: { type: "stopped" } }, () => process.disconnect());
  }
});
