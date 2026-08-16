import { createSnapshotJobAdapter } from "./types.js";

export const djiJobAdapter = createSnapshotJobAdapter({
  source: "dji",
  version: "dji-job-v1",
  supportsUrl(url) {
    return (url.hostname === "dji.com" || url.hostname.endsWith(".dji.com"))
      && /\/careers(?:\/|$)/u.test(url.pathname);
  },
  filterKeys: {
    target_role: "keyword",
    location: "work_location",
    employment_type: "job_type"
  }
});
